/**
 * The MCP audit record, and its hash chain.
 *
 * **Why this is not an `agent_events` row.** Greptime holds the substrate's
 * *application* events — what agents did: edits, commits, claims, handoffs. This
 * chain holds what agents *asked substrate-mcp to do*, and whether it was allowed.
 * Keeping them apart is the point, not an accident of layering:
 *
 *   - An audit must survive the thing it audits. Greptime is an external service
 *     reached over the public internet and appends to it are fail-closed, so a
 *     Greptime outage is exactly when the record of what was denied matters most.
 *     An audit living in the store that is down records nothing.
 *   - `agent_events` is agent-writable through `events_emit`. An audit trail that
 *     the audited party can append to is not one.
 *   - The two answer different questions and have different retention. Mixing them
 *     would put a `tool.call` denial in every brief's "recent actions".
 *
 * Both chains use the same digest construction — sha256 over canonical JSON with
 * `prev` inside the hash — so one verifier's reasoning carries to the other. They
 * are separate chains in separate stores. `record.test.ts` pins the encoders
 * together so they cannot drift.
 */

/** Deterministic JSON: object keys sorted recursively; array order is meaningful and kept. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, inner]) => inner !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
	return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export const AUDIT_DECISIONS = ["allowed", "denied"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

/**
 * What happens when the chain cannot take a record.
 *
 * `fail-open` lets the call proceed unaudited — correct for reads and for
 * `events_emit`, which sit on the critical path of a prompt. `fail-closed` denies
 * the call — correct for anything that grants or transfers exclusive ownership of a
 * node, because an unrecorded claim is how two agents end up believing they hold it.
 */
export type AuditMode = "fail-open" | "fail-closed";

export const AUDIT_TRANSPORTS = ["mcp", "rest", "internal"] as const;
export type AuditTransport = (typeof AUDIT_TRANSPORTS)[number];

export interface AuditRecordInput {
	surface: string;
	tool: string;
	decision: AuditDecision;
	mode: AuditMode;
	transport?: AuditTransport;
	/** Why, for a denial. Redacted before it is stored. */
	reason?: string | null;
	graph_id?: string | null;
	node_id?: string | null;
	session_id?: string | null;
	actor?: string | null;
	/** The tool's arguments. Digested, never stored — see `argDigest`. */
	args?: unknown;
}

/**
 * `brokenAt` for a failure that has no locatable position in the chain.
 *
 * Negative, so it can never collide with a real `seq` (which starts at 1), and named
 * so a caller rendering a verdict can tell "broken, position unknown" from "broken at
 * record N" instead of printing a sentinel at a reader.
 */
export const NO_POSITION = -1;

/**
 * Field length caps, and why every one of them is here rather than at a call site.
 *
 * Two separate properties depend on a record having a bounded size.
 *
 * *Recovery.* `AuditLog` reads the file's tail at boot to find the chain tip. A
 * record larger than that window used to make recovery find nothing and restart the
 * chain at `seq: 1` — and `params.name` in a JSON-RPC envelope is an arbitrary
 * caller-supplied string, so the size was the caller's to choose. Recovery now scans
 * farther when it has to (see `readLastRecord`), but a record whose size no caller
 * can inflate is the half of that fix which holds without a scan.
 *
 * *A bounded file.* An audit file has no compaction. Capping what one call can add to
 * it is what keeps "the trail grows with traffic" from being "the trail grows with
 * whatever an authenticated caller pastes".
 *
 * The identifier cap matches `MAX_FIELD` on the event path, so a `graph_id` this
 * substrate will actually accept is never truncated by the audit either.
 */
export const MAX_IDENTIFIER = 512;
export const MAX_TOOL_NAME = 200;
export const MAX_ARG_KEYS = 64;
export const MAX_ARG_KEY = 128;
const MAX_REASON = 500;

/**
 * The largest record this can build, as a byte ceiling rather than an estimate.
 *
 * `AuditLog` asserts its recovery window is bigger than this, so "the last record did
 * not fit in the tail" is a state the writer cannot produce.
 */
export const MAX_RECORD_BYTES =
	// Six sanitised identifier-shaped fields, the tool name, the reason, the argument
	// key list, two 64-char hex digests, and generous room for the JSON scaffolding.
	6 * MAX_IDENTIFIER + MAX_TOOL_NAME + MAX_REASON + MAX_ARG_KEYS * (MAX_ARG_KEY + 4) + 2 * 64 + 1024;

/**
 * One stored field: redacted, then capped.
 *
 * Both halves are needed and neither replaces the other. Redaction is why a
 * credential pasted into a `graph_id` does not become a permanent line in the file
 * an incident responder opens — the app-event write path has removed those since
 * SPE-4791, and a trail that kept what the ledger drops would be the more attractive
 * copy. The cap is why no single call can decide how large a record is.
 *
 * Applied to the identifiers too, not only to `reason`. A caller reaches
 * `buildRecord` before any tool validates its arguments, so `graph_id` here is
 * whatever was in the envelope — including on a call that was then refused and never
 * ran, which is exactly the call an audit is most likely to be holding.
 */
export function sanitizeField(
	value: string | null | undefined,
	limit: number,
	redact: (text: string) => string = (text) => text,
): string | null {
	if (value === null || value === undefined) return null;
	const cleaned = redact(value).slice(0, limit);
	return cleaned.length > 0 ? cleaned : null;
}

export interface AuditRecord {
	/** Position in this chain, from 1. Gaps mean records were lost, which `verify` reports. */
	seq: number;
	ts: string;
	surface: string;
	tool: string;
	transport: AuditTransport;
	decision: AuditDecision;
	mode: AuditMode;
	reason: string | null;
	graph_id: string | null;
	node_id: string | null;
	session_id: string | null;
	actor: string | null;
	/** Top-level argument names, sorted. Names are structure; values are not stored. */
	arg_keys: string[];
	/** sha256 over the canonical JSON of the arguments as submitted. */
	arg_digest: string | null;
	/** sha256 over the canonical JSON of every field above, `prev` included. */
	hash: string;
	prev: string | null;
}

/**
 * What is kept of a tool's arguments: the key names, and a digest.
 *
 * Storing the arguments would make the audit a second, permanent copy of
 * everything every agent ever sent to the substrate — memory bodies, prompts,
 * summaries — in a file that exists to be read by anyone investigating an
 * incident. The digest keeps the property that matters: an investigator holding a
 * request can prove it is the one that was allowed, byte for byte, because the
 * digest is over the canonical form of exactly those arguments.
 *
 * The **digest is over the arguments exactly as submitted** and is never affected by
 * anything below; that is the whole point of it. The *names* are sanitised and capped
 * like every other stored field, because a key name is caller-supplied too and a
 * caller with a thousand of them would otherwise choose how big this record is. When
 * there are more than `MAX_ARG_KEYS`, the first that many sorted names are kept: the
 * digest still proves which request this was, so nothing an investigator needs is lost
 * with them.
 */
export function argDigest(
	args: unknown,
	redact: (text: string) => string = (text) => text,
): { keys: string[]; digest: string | null } {
	if (args === undefined || args === null) return { keys: [], digest: null };
	const raw =
		typeof args === "object" && !Array.isArray(args) ? Object.keys(args as Record<string, unknown>) : ([] as string[]);
	const keys = [
		...new Set(raw.map((key) => sanitizeField(key, MAX_ARG_KEY, redact)).filter((key): key is string => key !== null)),
	]
		.sort()
		.slice(0, MAX_ARG_KEYS);
	return { keys, digest: sha256Hex(canonicalJson(args)) };
}

/** Hash every field but `hash` itself. `prev` is inside the digest — that is what binds the chain. */
export function recordHash(record: Omit<AuditRecord, "hash">): string {
	return sha256Hex(canonicalJson(record));
}

export function sealRecord(record: Omit<AuditRecord, "hash">): AuditRecord {
	return { ...record, hash: recordHash(record) };
}

/**
 * Build the unhashed record.
 *
 * `redact` is injected because the redactor lives in `packages/mcp-server`, which
 * depends on this package; importing it back would be a cycle. A denial reason
 * routinely quotes an error, and an error routinely quotes a connection URL.
 *
 * **Every caller-supplied field is redacted, not just `reason`.** `surface`, `tool`,
 * `graph_id`, `node_id`, `session_id` and the argument names all arrive from the
 * request envelope, and this runs *before* the tool validates any of them — so a
 * credential in `graph_id` on a call that was then refused reached the file verbatim,
 * in the one file that exists to be read during an incident, while the app-event path
 * would have stripped the same string. The digest over the arguments is untouched:
 * redacting the thing whose job is to prove which request this was would defeat it.
 */
export function buildRecord(
	input: AuditRecordInput,
	chain: { seq: number; prev: string | null },
	now: Date,
	redact: (text: string) => string = (text) => text,
): AuditRecord {
	const { keys, digest } = argDigest(input.args, redact);
	return sealRecord({
		seq: chain.seq,
		ts: now.toISOString(),
		// A surface comes from a configured token rather than from the body, but it is
		// stored, so it is capped with the rest: one field exempt from the bound is one
		// field that has to be re-checked every time a new caller starts setting it.
		surface: sanitizeField(input.surface, MAX_IDENTIFIER, redact) ?? "unknown",
		tool: sanitizeField(input.tool, MAX_TOOL_NAME, redact) ?? "unnamed",
		transport: input.transport ?? "mcp",
		decision: input.decision,
		mode: input.mode,
		reason: sanitizeField(input.reason, MAX_REASON, redact),
		graph_id: sanitizeField(input.graph_id, MAX_IDENTIFIER, redact),
		node_id: sanitizeField(input.node_id, MAX_IDENTIFIER, redact),
		session_id: sanitizeField(input.session_id, MAX_IDENTIFIER, redact),
		actor: sanitizeField(input.actor, MAX_IDENTIFIER, redact),
		arg_keys: keys,
		arg_digest: digest,
		prev: chain.prev,
	});
}

/**
 * Whether a parsed JSON value is shaped like a record this can verify.
 *
 * A line holding `null`, `[]` or `{"a":1}` is *syntactically* valid JSONL, so
 * `JSON.parse` accepted it and verification then read `record.hash` off it and threw —
 * which reached `/evidence` as an HTTP 500 rather than as the broken-chain verdict the
 * operator needed. A record that is not a record cannot be verified, and "cannot be
 * verified" is a verdict, not a crash.
 *
 * Only the fields verification and selection actually read are required. The check is
 * deliberately not a full schema: a record from a future writer with one extra field
 * still verifies, because its hash is over whatever fields it has.
 */
export function isAuditRecord(value: unknown): value is AuditRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<AuditRecord>;
	return (
		typeof record.hash === "string" &&
		typeof record.seq === "number" &&
		Number.isInteger(record.seq) &&
		(record.prev === null || typeof record.prev === "string") &&
		(record.graph_id === null || record.graph_id === undefined || typeof record.graph_id === "string")
	);
}

export type ChainVerdict =
	| { ok: true; records: number }
	| { ok: false; records: number; brokenAt: number; reason: string };

export interface VerifyChainOptions {
	/**
	 * Require the chain to open at `seq: 1` with `prev: null`. On by default.
	 *
	 * Off only for a deliberate window over a chain whose start is not present — see
	 * `verifyAuditChain`. It is not a way to quiet the check on a file.
	 */
	genesis?: boolean;
}

/**
 * Recompute a chain and report the first record that does not verify.
 *
 * Four ways it breaks, all reported by position rather than by hash, because a
 * tampered record's hash is not a useful name for it:
 *
 *   1. contents that do not match the hash;
 *   2. a `prev` that does not point at the preceding record;
 *   3. a `seq` that skipped — how a deleted line shows up when the chain was
 *      rewritten well enough to still link;
 *   4. **a chain that does not open at `seq: 1` with `prev: null`.**
 *
 * The fourth is not redundant, and leaving it out was a hole: delete the *first*
 * line and the untouched second record becomes the new head. Its own hash verifies,
 * every later `prev` and `seq` still follows it, and the shortened chain reports
 * intact — so an evidence bundle would omit the removed action and say nothing was
 * wrong. Only the head can be removed this way, which is exactly why the head has
 * to be checked rather than assumed.
 *
 * The consequence is deliberate: a chain that has been rotated without restarting
 * the writer does not open at `seq: 1`, and is reported broken rather than verified
 * in isolation. That is the truth about such a file — the chain it holds is only
 * verifiable together with the one it continues. See `docs/mcp-audit.md`.
 *
 * `options.genesis: false` is for the one caller holding a window it never claimed
 * was a whole chain: a memory-only `AuditLog` keeps a bounded tail, so past its
 * retention it legitimately opens past `seq: 1`. Everything else leaves it on, and a
 * *file* chain always does — it holds every record ever appended.
 */
export function verifyAuditChain(records: AuditRecord[], options: VerifyChainOptions = {}): ChainVerdict {
	const walker = new ChainWalker(options);
	for (const record of records) walker.push(record);
	return walker.verdict();
}

/**
 * `verifyAuditChain` as a fold, so a chain can be checked while it is being read.
 *
 * The same rules, in the same order, reached from two directions: `verifyAuditChain`
 * over an array in memory, and `AuditLog.scan` over a file it is streaming a line at a
 * time. The streaming caller is why this exists — verifying and then selecting a
 * graph's records used to be two full reads and two full parses of a file with no
 * compaction, so every `/evidence` request cost twice the trail. One implementation of
 * the rules rather than two is the condition for having both callers at all.
 *
 * The first break is kept and later ones are not: a chain is broken at its earliest
 * inconsistency, and everything after that follows from it. Pushing continues past a
 * break so the reported record count is the whole file's, which is what a reader
 * comparing it against `auditRecords` on `/healthz` expects.
 */
export class ChainWalker {
	private readonly requireGenesis: boolean;
	private expectedPrev: string | null = null;
	private expectedSeq: number | null = null;
	private count = 0;
	private broken: { brokenAt: number; reason: string } | null = null;

	constructor(options: VerifyChainOptions = {}) {
		this.requireGenesis = options.genesis ?? true;
	}

	get records(): number {
		return this.count;
	}

	/** Whether the chain is still sound. Lets a caller stop early if it wants to. */
	get ok(): boolean {
		return this.broken === null;
	}

	push(value: unknown): void {
		this.count++;
		// Shape first: every check below reads fields off the record, and a line holding
		// `null` or a bare array would throw rather than produce a verdict.
		if (!isAuditRecord(value)) {
			this.fail(NO_POSITION, "a line is valid JSON but is not an audit record, so it cannot be verified");
			return;
		}
		const record = value;
		const { hash, ...rest } = record;
		if (recordHash(rest) !== hash) {
			this.fail(record.seq, "hash does not match contents");
			return;
		}
		if (this.expectedSeq === null && this.requireGenesis && (record.seq !== 1 || record.prev !== null)) {
			this.fail(
				record.seq,
				`the chain does not open at seq 1 with no predecessor: its first record is seq ${record.seq} ` +
					`with prev ${record.prev === null ? "null" : "set"}, so records before it are missing`,
			);
		} else if (this.expectedPrev !== null && record.prev !== this.expectedPrev) {
			this.fail(record.seq, "prev does not match the preceding record");
		} else if (this.expectedSeq !== null && record.seq !== this.expectedSeq) {
			this.fail(record.seq, `seq jumped: expected ${this.expectedSeq}`);
		}
		this.expectedPrev = hash;
		this.expectedSeq = record.seq + 1;
	}

	verdict(): ChainVerdict {
		if (this.broken) return { ok: false, records: this.count, ...this.broken };
		return { ok: true, records: this.count };
	}

	private fail(brokenAt: number, reason: string): void {
		this.broken ??= { brokenAt, reason };
	}
}

/**
 * Distinct keys a tally's breakdown keeps before collapsing into `TALLY_OVERFLOW`.
 *
 * Generous against every real deployment — this substrate serves under twenty tools and
 * eleven surfaces — and a hard bound against a caller inventing names.
 *
 * A breakdown therefore holds at most `MAX_TALLY_KEYS + 1` entries: the overflow bucket is
 * admitted beyond the cap rather than counted against it, the same way `MetricRegistry`
 * admits its collapsed series, because refusing it would drop the counts it carries and the
 * breakdown would stop summing to the total.
 */
export const MAX_TALLY_KEYS = 200;

/** The bucket a tally's breakdown collapses into once it is full. Named like `OVERFLOW`. */
export const TALLY_OVERFLOW = "_overflow";

export interface AuditStats {
	total: number;
	allowed: number;
	denied: number;
	byTool: Array<{ tool: string; allowed: number; denied: number }>;
	bySurface: Array<{ surface: string; allowed: number; denied: number }>;
}

/**
 * `auditStats` as a fold, so a tally can be complete over records nobody kept.
 *
 * The evidence bundle lists a bounded window of a graph's records — a trail has no
 * compaction, so listing all of them is not an option — but its allowed/denied tally
 * must still describe *every* decision for that graph. Computing the tally from the
 * listed window meant a graph past the window reported counts that silently omitted
 * whatever fell outside it, including the claim withdrawals and batch corrections that
 * are the entire reason a reader looks at the tally. A note saying "truncated" does not
 * make a wrong number right.
 *
 * So the counting is separated from the keeping: `AuditLog.scan` pushes every matching
 * record through this and retains only a window of them.
 */
export class StatsAccumulator {
	private totalCount = 0;
	private allowedCount = 0;
	private deniedCount = 0;
	private readonly byTool = new Map<string, { allowed: number; denied: number }>();
	private readonly bySurface = new Map<string, { allowed: number; denied: number }>();

	constructor(private readonly maxKeys: number = MAX_TALLY_KEYS) {}

	push(record: AuditRecord): void {
		this.totalCount++;
		const allowed = record.decision === "allowed";
		if (allowed) this.allowedCount++;
		else this.deniedCount++;
		for (const [counts, key] of [
			[this.byTool, record.tool],
			[this.bySurface, record.surface],
		] as Array<[Map<string, { allowed: number; denied: number }>, string]>) {
			const bucket = counts.get(key) ?? this.admit(counts, key);
			if (allowed) bucket.allowed++;
			else bucket.denied++;
		}
	}

	/**
	 * The bucket a new key goes in, or the overflow bucket once the tally is full.
	 *
	 * The breakdown has to be bounded for the same reason the record listing is. `tool`
	 * comes from a JSON-RPC `params.name` and is audited *before* the dispatcher validates
	 * it — deliberately, so a tool added without an audit decision is caught the first time
	 * it is called — so the set of distinct names in a file is the caller's to choose. Once
	 * the tally was computed over every record rather than over the listed window, that set
	 * became what `/evidence` builds and serialises, on the process serving every prompt on
	 * the host. The totals stay exact; only the *breakdown* collapses, the same trade the
	 * metric registry makes with `_overflow`.
	 */
	private admit(
		counts: Map<string, { allowed: number; denied: number }>,
		key: string,
	): { allowed: number; denied: number } {
		if (counts.size >= this.maxKeys) {
			const overflow = counts.get(TALLY_OVERFLOW) ?? { allowed: 0, denied: 0 };
			counts.set(TALLY_OVERFLOW, overflow);
			return overflow;
		}
		const created = { allowed: 0, denied: 0 };
		counts.set(key, created);
		return created;
	}

	stats(): AuditStats {
		const sorted = (counts: Map<string, { allowed: number; denied: number }>) =>
			[...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			total: this.totalCount,
			allowed: this.allowedCount,
			denied: this.deniedCount,
			byTool: sorted(this.byTool).map(([tool, counts]) => ({ tool, ...counts })),
			bySurface: sorted(this.bySurface).map(([surface, counts]) => ({ surface, ...counts })),
		};
	}
}

export function auditStats(records: AuditRecord[]): AuditStats {
	const accumulator = new StatsAccumulator();
	for (const record of records) accumulator.push(record);
	return accumulator.stats();
}

