/**
 * The memory governance policy: who may write what, where, how a colliding write
 * is resolved, and how long a claim is trusted before it must be re-verified.
 *
 * Everything here is a pure function of the request. That is deliberate — the
 * decisions in this file are the ones a reviewer has to be able to read off the
 * page, and they are the ones worth testing exhaustively without a database.
 *
 * The one rule the whole file exists to enforce: **memory is default-deny**. A
 * surface writes only what a grant names, at a scope class a grant names, of a
 * kind a grant names. Memory is what other agents act on, so an unanticipated
 * writer gets nothing rather than the benefit of the doubt. `events.emit` keeps
 * failing open; this does not.
 */
import { normalizeIdentifier, repoOverCap } from "./event.ts";
import { redact } from "./redact.ts";
import { TERMINAL_GRAPH_STATUSES } from "./index-sweep.ts";
import {
	MEMORY_KINDS,
	MEMORY_SCOPE_CLASSES,
	MEMORY_TTLS,
	SURFACES,
	type Actor,
	type ConflictStrategy,
	type MemoryEntry,
	type MemoryKind,
	type MemoryScope,
	type MemoryScopeClass,
	type MemoryTtl,
	type Trust,
} from "./types.ts";

// ── scopes ───────────────────────────────────────────────────────────────────

/** Subjects are part of a conflict key, so they are capped like any other identifier. */
export const MAX_SUBJECT = 200;

/**
 * Parse a scope string into the class RBAC is granted against.
 *
 * Returns null for anything unrecognised. A scope the gate cannot classify cannot
 * be checked against a grant, and a write it cannot check is one it must refuse —
 * so a typo'd `repos:foo` is a denial rather than a new, ungoverned namespace.
 *
 * The id is normalised the same way every other query key is (see
 * `normalizeIdentifier`): the scope is written *and* read by
 * `memoryForBrief`, so the two forms have to agree by construction.
 */
export function parseScope(raw: unknown): MemoryScope | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.toLowerCase() === "global") return { class: "global", id: null, canonical: "global" };

	const split = trimmed.indexOf(":");
	if (split < 1) return null;
	const family = trimmed.slice(0, split).toLowerCase();
	if (!(MEMORY_SCOPE_CLASSES as readonly string[]).includes(family)) return null;
	// `global` takes no id, so `global:anything` is malformed rather than a scope.
	if (family === "global") return null;

	const rawId = trimmed.slice(split + 1).trim();
	// An `agent:` id names a surface, and surfaces are lowercase — it is compared
	// against the writer by the `self` rule, so `agent:HERMES` written by `hermes`
	// has to be the same scope rather than a denial nobody can explain. A `repo:` id
	// is left alone: GitHub slugs can carry case, and lowercasing the write while the
	// brief reads the original spelling is the lookup-that-never-matches bug.
	const spelled = family === "agent" ? rawId.toLowerCase() : rawId;
	const id = normalizeIdentifier(spelled);
	if (!id) return null;
	return { class: family as MemoryScopeClass, id, canonical: `${family}:${id}` };
}

/**
 * The redacted id of a `repo:` scope when it is over the repo cap, else null. The memory write refuses such a scope. `parseScope` caps
 * the id to fit, which a read needs and a write must not do: a write would store a repo cut to fit. Reads never call this.
 */
export function repoScopeOverCap(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	const split = trimmed.indexOf(":");
	if (split < 1 || trimmed.slice(0, split).toLowerCase() !== "repo") return null;
	return repoOverCap(trimmed.slice(split + 1).trim());
}

export function isMemoryKind(value: unknown): value is MemoryKind {
	return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryTtl(value: unknown): value is MemoryTtl {
	return typeof value === "string" && (MEMORY_TTLS as readonly string[]).includes(value);
}

function isKnownSurface(value: string): boolean {
	return (SURFACES as readonly string[]).includes(value);
}

/** Redact, then cap and lowercase-fold, a subject into the identity a conflict resolves on. */
export function normalizeSubject(subject: unknown): string | null {
	if (typeof subject !== "string") return null;
	// Redact before capping, for the reason `normalizeIdentifier` does: a cap first can cut a
	// token so its own pattern no longer matches, and the fragment is what would be stored.
	const cleaned = redact(subject.trim()).slice(0, MAX_SUBJECT);
	return cleaned ? cleaned.toLowerCase() : null;
}

/**
 * The identity two writes collide on: scope, kind and subject.
 *
 * Deliberately *not* the text. Two statements of the same todo with different
 * wording are the same todo, and a key over the text would make every reword a
 * new entry — which is the ungoverned append behaviour this replaces.
 */
export function conflictKey(scope: MemoryScope, kind: MemoryKind, subject: string | null): string | null {
	return subject ? `${scope.canonical}|${kind}|${subject}` : null;
}

// ── RBAC ─────────────────────────────────────────────────────────────────────

export interface MemoryGrant {
	/** Quoted back in the decision, so an audit says which rule fired. */
	name: string;
	/** `"*"` means every *known* surface — never an unrecognised writer. */
	surfaces: readonly string[];
	scopes: readonly MemoryScopeClass[];
	kinds: readonly MemoryKind[];
	/** Restricts an `agent:` scope to the writer's own surface. */
	self?: boolean;
}

/**
 * The Phase 0.5 default grants.
 *
 * Read the gaps, not the rows — the gaps are the policy:
 *
 *   - `person:` appears nowhere. A note about a human is not an agent's to write,
 *     so it needs an explicit grant from an operator.
 *   - `repo:handoff` appears nowhere. A handoff is to a session or an agent; a
 *     repo-wide one addresses nobody and would sit in every brief forever.
 *   - `global` carries no `todo` and no `handoff`. A global todo is nobody's todo.
 *   - `agent:` is `self`-only. An agent does not write into another agent's
 *     scope; that is what a `handoff` at graph scope is for.
 *
 * `global` is granted here but still lands in review — see `conflictPlan`.
 * Passing RBAC is permission to *propose* a global memory, not to install one.
 */
export const DEFAULT_GRANTS: readonly MemoryGrant[] = [
	{ name: "graph-any", surfaces: ["*"], scopes: ["graph"], kinds: [...MEMORY_KINDS] },
	{ name: "repo-working", surfaces: ["*"], scopes: ["repo"], kinds: ["decision", "fact", "warning", "todo"] },
	{
		name: "agent-self",
		surfaces: ["*"],
		scopes: ["agent"],
		kinds: ["fact", "warning", "todo", "handoff"],
		self: true,
	},
	{ name: "global-standing", surfaces: ["*"], scopes: ["global"], kinds: ["decision", "fact", "warning"] },
];

/**
 * The grant that permits this write, or null — which is a denial.
 *
 * A writer that is not a known surface matches `"*"` in nothing: an
 * unauthenticated MCP caller arrives as `unknown`, and default-deny has to mean
 * that it writes nothing at all rather than everything a wildcard covers.
 */
export function grantFor(
	writer: string,
	scope: MemoryScope,
	kind: MemoryKind,
	grants: readonly MemoryGrant[] = DEFAULT_GRANTS,
): MemoryGrant | null {
	for (const grant of grants) {
		if (!grant.scopes.includes(scope.class)) continue;
		if (!grant.kinds.includes(kind)) continue;
		const named = grant.surfaces.includes(writer);
		const wildcard = grant.surfaces.includes("*") && isKnownSurface(writer);
		if (!named && !wildcard) continue;
		if (grant.self && scope.id !== writer) continue;
		return grant;
	}
	return null;
}

/** What a writer *could* have written, so a denial names a way forward. */
export function allowedForWriter(
	writer: string,
	grants: readonly MemoryGrant[] = DEFAULT_GRANTS,
): Array<{ scope: MemoryScopeClass; kinds: readonly MemoryKind[] }> {
	const out = new Map<MemoryScopeClass, Set<MemoryKind>>();
	for (const grant of grants) {
		const named = grant.surfaces.includes(writer);
		const wildcard = grant.surfaces.includes("*") && isKnownSurface(writer);
		if (!named && !wildcard) continue;
		for (const scope of grant.scopes) {
			const kinds = out.get(scope) ?? new Set<MemoryKind>();
			for (const kind of grant.kinds) kinds.add(kind);
			out.set(scope, kinds);
		}
	}
	return [...out].map(([scope, kinds]) => ({ scope, kinds: [...kinds] }));
}

/**
 * Grants an operator adds on top of the defaults, from JSON.
 *
 * Anything malformed is dropped rather than throwing: the defaults are the
 * *stricter* policy, so falling back to them is the fail-closed direction, and a
 * typo in one grant must not stop `substrate-mcp` booting.
 */
export function parseGrants(raw: string | undefined, warn: (message: string) => void): readonly MemoryGrant[] {
	if (!raw?.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warn("SUBSTRATE_MEMORY_GRANTS is not valid JSON; using the default grants only");
		return [];
	}
	if (!Array.isArray(parsed)) {
		warn("SUBSTRATE_MEMORY_GRANTS is not a JSON array; using the default grants only");
		return [];
	}
	const out: MemoryGrant[] = [];
	for (const [position, candidate] of parsed.entries()) {
		const grant = candidate as Partial<MemoryGrant> | null;
		const surfaces = Array.isArray(grant?.surfaces) ? grant.surfaces.filter((s) => typeof s === "string") : [];
		const scopes = Array.isArray(grant?.scopes)
			? grant.scopes.filter((s): s is MemoryScopeClass => (MEMORY_SCOPE_CLASSES as readonly string[]).includes(s))
			: [];
		const kinds = Array.isArray(grant?.kinds) ? grant.kinds.filter(isMemoryKind) : [];
		if (surfaces.length === 0 || scopes.length === 0 || kinds.length === 0) {
			warn(`SUBSTRATE_MEMORY_GRANTS[${position}] names no surface, scope or kind; dropping it`);
			continue;
		}
		out.push({
			name: typeof grant?.name === "string" && grant.name ? grant.name : `operator-${position}`,
			surfaces,
			scopes,
			kinds,
			...(grant?.self === true ? { self: true as const } : {}),
		});
	}
	return out;
}

// ── conflict strategy ────────────────────────────────────────────────────────

interface ConflictPlan {
	/** How a collision is resolved once the write is allowed to land. */
	resolve: Exclude<ConflictStrategy, "require-review">;
	/** True where the write is a proposal until a reviewer releases it. */
	requiresReview: boolean;
}

/**
 * Pick the strategy for a target.
 *
 *   - **global → require-review.** The blast radius of a global memory is every
 *     agent in every repo, and no agent gets to install one unreviewed.
 *   - **decision → versioned.** A decision in force is replaced deliberately or
 *     not at all: the writer must name the version it is superseding, and a stale
 *     expectation is a `conflict`. The history stays readable, because "why did
 *     this change" is the question a decision log is for.
 *   - **todo → last-write-wins.** A todo has one current state and no interesting
 *     history; making agents version their todo list would only teach them to
 *     stop writing todos.
 *
 * Review and resolution are orthogonal, which is why both come back: a global
 * decision is reviewed *and*, once released, versioned.
 */
export function conflictPlan(scope: MemoryScope, kind: MemoryKind, hasSubject: boolean): ConflictPlan {
	const requiresReview = scope.class === "global";
	if (!hasSubject) return { resolve: "append", requiresReview };
	if (kind === "decision") return { resolve: "versioned", requiresReview };
	if (kind === "todo") return { resolve: "lww", requiresReview };
	return { resolve: "append", requiresReview };
}

// ── provenance and trust decay ───────────────────────────────────────────────

/**
 * How long a claim is trusted before it must be re-verified.
 *
 * This is confidence, not retention — `ttl` decides when an entry is *forgotten*,
 * this decides when it stops being something another agent may act on without
 * checking. An expired entry is still briefed; it is briefed as needing
 * re-verification.
 *
 * `verified-by-test` sits below `human-confirmed` on purpose. A test verifies a
 * claim against one commit, and the code moves; a human decision holds until
 * somebody revisits it.
 */
export const TRUST_SHELF_LIFE_DAYS: Record<Trust, number> = {
	"agent-claimed": 14,
	"verified-by-test": 30,
	"human-confirmed": 180,
};

const DAY_MS = 86_400_000;

export function reverifyAfter(trust: Trust, created: Date): Date {
	return new Date(created.getTime() + TRUST_SHELF_LIFE_DAYS[trust] * DAY_MS);
}

/** Derived on read, so an entry decays where it sits without a sweeper job. */
export function needsReverification(deadline: string | Date | null | undefined, now = Date.now()): boolean {
	if (!deadline) return false;
	const at = deadline instanceof Date ? deadline.getTime() : new Date(deadline).getTime();
	return Number.isFinite(at) && at <= now;
}

/**
 * The trust the gate will actually record, which is not always the one asked for.
 *
 * An agent may not vouch for itself. `human-confirmed` says a person checked
 * this, so it takes a reviewer's token — otherwise the highest-trust level in the
 * system would be a string any caller could type. `verified-by-test` is a claim
 * an agent *can* honestly make, but only against a `source_event` that has been
 * **looked up in the ledger**: provenance is the difference between a verified
 * claim and an asserted one, and an event id nobody checked is just a string.
 *
 * `sourceEventVerified` is that lookup's answer, taken rather than performed —
 * this stays a pure function of the request, and the caller (`governMemoryWrite`)
 * decides when the ledger is worth consulting.
 */
export function resolveTrust(request: {
	requested?: Trust;
	reviewed: boolean;
	sourceEventVerified: boolean;
}): { trust: Trust; downgradedFrom?: Trust } {
	const requested = request.requested ?? "agent-claimed";
	if (request.reviewed) return { trust: requested };
	if (requested === "agent-claimed") return { trust: "agent-claimed" };
	if (requested === "verified-by-test" && request.sourceEventVerified) return { trust: "verified-by-test" };
	return { trust: "agent-claimed", downgradedFrom: requested };
}

/** An `actor: "human"` claim is provenance, so it needs a reviewer's token too. */
export function resolveActor(requested: Actor | undefined, reviewed: boolean): Actor {
	return reviewed && requested === "human" ? "human" : "agent";
}

// ── lifetime ─────────────────────────────────────────────────────────────────

/** The `30d` class, fixed by its name: `created` plus thirty days, the same span the sweeper's cutoff uses. */
export const MEMORY_TTL_30D_MS = 30 * DAY_MS;

/** Why an entry is past its lifetime; null while it is not. */
type MemoryExpiryReason = "30d" | "graph-terminal" | "graph-unindexed";

export interface MemoryExpiry {
	expired: boolean;
	/** The instant a `30d` entry expires, ISO. Null for `graph` — its end is an event, not a time — and `permanent`. */
	expires_at: string | null;
	reason: MemoryExpiryReason | null;
}

/** What `graph_index` holds for a graph: its status, which a row registered without one carries as null. */
export interface GraphLifetime {
	status: string | null;
}

const NOT_EXPIRED: MemoryExpiry = { expired: false, expires_at: null, reason: null };
const GRAPH_SCOPE_PREFIX = "graph:";

/** Exactly the sweeper's list, so a graph the sweep would retire is one whose entries have expired. */
export function isTerminalGraphStatus(status: string | null | undefined): boolean {
	return typeof status === "string" && (TERMINAL_GRAPH_STATUSES as readonly string[]).includes(status);
}

/**
 * The graph a `ttl: graph` entry lives as long as: its `graph_id`, or the id of
 * a `graph:` scope when the write named none. Both are stored normalised, so the
 * scope's tail is the same spelling `graph_index` keys on. An entry with neither
 * is tied to no graph at all, and `memoryExpiry` treats it as one whose graph is
 * not indexed — the sweeper's `entries-ttl-graph` class already counts it so.
 */
export function memoryGraphId(entry: Pick<MemoryEntry, "scope" | "graph_id">): string | null {
	if (entry.graph_id) return entry.graph_id;
	if (!entry.scope.startsWith(GRAPH_SCOPE_PREFIX)) return null;
	const id = entry.scope.slice(GRAPH_SCOPE_PREFIX.length);
	return id.length > 0 ? id : null;
}

/**
 * Whether an entry is past the lifetime its `ttl` promised (uplift-3 N4, BP-5.3).
 *
 * This is retention, not trust: `needsReverification` says an entry must be
 * checked before it is acted on; this says it should no longer be served at all.
 * One predicate, pure, so the brief, `memory_search`, the retain forward and the
 * sweeper cannot disagree about which entries are dead — which is what kept the
 * two `entries-ttl-*` sweep classes report-only.
 *
 *   - `30d` expires at `created + 30 days`, inclusive, and says when.
 *   - `graph` expires the moment its graph is finished (a status in
 *     `TERMINAL_GRAPH_STATUSES`) or is no longer in `graph_index` at all — the
 *     sweeper may have retired it, or it was never registered. `graph` is what
 *     the caller looked up for `memoryGraphId(entry)`: null means no row. An
 *     indexed graph with a null status is open, as `openGraphs` reads it.
 *   - `permanent` never expires. Neither does a `ttl` nobody defined, nor an
 *     entry whose `created` cannot be parsed: a row we cannot date or classify is
 *     not one to hide on the strength of the gap.
 *
 * The mode — serve-and-tag or hide — is the caller's (`SUBSTRATE_MEMORY_EXPIRY`);
 * this only answers the question.
 */
export function memoryExpiry(
	entry: Pick<MemoryEntry, "ttl" | "created">,
	graph: GraphLifetime | null,
	now = Date.now(),
): MemoryExpiry {
	if (entry.ttl === "30d") {
		const created = Date.parse(entry.created);
		if (!Number.isFinite(created)) return NOT_EXPIRED;
		const at = created + MEMORY_TTL_30D_MS;
		const expired = at <= now;
		return { expired, expires_at: new Date(at).toISOString(), reason: expired ? "30d" : null };
	}
	if (entry.ttl === "graph") {
		if (graph === null) return { expired: true, expires_at: null, reason: "graph-unindexed" };
		if (isTerminalGraphStatus(graph.status)) return { expired: true, expires_at: null, reason: "graph-terminal" };
		return NOT_EXPIRED;
	}
	return NOT_EXPIRED;
}

/** Who a memory read is for: its surface, and the repo it works in (null when it names none). */
export interface MemoryCaller {
	surface: string;
	repo: string | null;
	/** Under repository scope, whether the caller is granted a repository. Absent while scoping is off, which grants every row. */
	granted?: ((repo: string) => boolean) | undefined;
}

/**
 * Whether a row kept at `scope` and retained for `repo` names only repositories the caller is granted. A row's `repo`, and the
 * `repo:` in its scope, must both be granted. A `graph:` row with no repository is not granted: its repository cannot be read from
 * the row. Absent `granted` (scoping off) grants every row.
 */
export function grantedToCaller(scope: string | undefined, repo: string | null | undefined, granted: ((repo: string) => boolean) | undefined): boolean {
	if (granted === undefined) return true;
	const rowRepo = normalizeIdentifier(repo);
	if (rowRepo !== null && !granted(rowRepo)) return false;
	const normalized = scope?.trim().toLowerCase();
	if (normalized?.startsWith("repo:") && !granted(normalized.slice("repo:".length))) return false;
	return !(normalized?.startsWith("graph:") && rowRepo === null);
}

/**
 * Whether `caller` may see a row kept at `scope` and retained for `repo`.
 *
 * Only an `agent:` scope is restricted, and it is restricted twice: to its own surface, and to the repo it was
 * written for. A caller that names no repo sees no agent row, and a row with no repo (legacy, or a write that
 * named none) is seen by no caller. Every other scope is shared, and so is a missing scope, as it always was.
 * The index query and the derived-hit merge both apply this rule, so they cannot disagree.
 */
export function visibleToCaller(scope: string | undefined, repo: string | null | undefined, caller: MemoryCaller): boolean {
	if (!grantedToCaller(scope, repo, caller.granted)) return false;
	if (scope === undefined) return true;
	const normalized = scope.trim().toLowerCase();
	if (!normalized.startsWith("agent:")) return true;
	if (normalized !== `agent:${caller.surface.trim().toLowerCase()}`) return false;
	const callerRepo = normalizeIdentifier(caller.repo);
	return callerRepo !== null && normalizeIdentifier(repo) === callerRepo;
}
