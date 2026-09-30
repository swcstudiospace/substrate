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
 */
export function argDigest(args: unknown): { keys: string[]; digest: string | null } {
	if (args === undefined || args === null) return { keys: [], digest: null };
	const keys =
		typeof args === "object" && !Array.isArray(args) ? Object.keys(args as Record<string, unknown>).sort() : [];
	return { keys, digest: sha256Hex(canonicalJson(args)) };
}

/** Hash every field but `hash` itself. `prev` is inside the digest — that is what binds the chain. */
export function recordHash(record: Omit<AuditRecord, "hash">): string {
	return sha256Hex(canonicalJson(record));
}

export function sealRecord(record: Omit<AuditRecord, "hash">): AuditRecord {
	return { ...record, hash: recordHash(record) };
}

const MAX_REASON = 500;

/**
 * Build the unhashed record.
 *
 * `redact` is injected because the redactor lives in `packages/mcp-server`, which
 * depends on this package; importing it back would be a cycle. A denial reason
 * routinely quotes an error, and an error routinely quotes a connection URL.
 */
export function buildRecord(
	input: AuditRecordInput,
	chain: { seq: number; prev: string | null },
	now: Date,
	redact: (text: string) => string = (text) => text,
): AuditRecord {
	const { keys, digest } = argDigest(input.args);
	const reason = input.reason ? redact(input.reason).slice(0, MAX_REASON) : null;
	return sealRecord({
		seq: chain.seq,
		ts: now.toISOString(),
		surface: input.surface,
		tool: input.tool,
		transport: input.transport ?? "mcp",
		decision: input.decision,
		mode: input.mode,
		reason: reason && reason.length > 0 ? reason : null,
		graph_id: input.graph_id ?? null,
		node_id: input.node_id ?? null,
		session_id: input.session_id ?? null,
		actor: input.actor ?? null,
		arg_keys: keys,
		arg_digest: digest,
		prev: chain.prev,
	});
}

export type ChainVerdict =
	| { ok: true; records: number }
	| { ok: false; records: number; brokenAt: number; reason: string };

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
 */
export function verifyAuditChain(records: AuditRecord[]): ChainVerdict {
	let expectedPrev: string | null = null;
	let expectedSeq: number | null = null;
	for (const record of records) {
		const { hash, ...rest } = record;
		if (recordHash(rest) !== hash) {
			return { ok: false, records: records.length, brokenAt: record.seq, reason: "hash does not match contents" };
		}
		if (expectedSeq === null && (record.seq !== 1 || record.prev !== null)) {
			return {
				ok: false,
				records: records.length,
				brokenAt: record.seq,
				reason:
					`the chain does not open at seq 1 with no predecessor: its first record is seq ${record.seq} ` +
					`with prev ${record.prev === null ? "null" : "set"}, so records before it are missing`,
			};
		}
		if (expectedPrev !== null && record.prev !== expectedPrev) {
			return {
				ok: false,
				records: records.length,
				brokenAt: record.seq,
				reason: "prev does not match the preceding record",
			};
		}
		if (expectedSeq !== null && record.seq !== expectedSeq) {
			return {
				ok: false,
				records: records.length,
				brokenAt: record.seq,
				reason: `seq jumped: expected ${expectedSeq}`,
			};
		}
		expectedPrev = hash;
		expectedSeq = record.seq + 1;
	}
	return { ok: true, records: records.length };
}

export interface AuditStats {
	total: number;
	allowed: number;
	denied: number;
	byTool: Array<{ tool: string; allowed: number; denied: number }>;
	bySurface: Array<{ surface: string; allowed: number; denied: number }>;
}

export function auditStats(records: AuditRecord[]): AuditStats {
	const tally = (key: (record: AuditRecord) => string) => {
		const counts = new Map<string, { allowed: number; denied: number }>();
		for (const record of records) {
			const bucket = counts.get(key(record)) ?? { allowed: 0, denied: 0 };
			if (record.decision === "allowed") bucket.allowed++;
			else bucket.denied++;
			counts.set(key(record), bucket);
		}
		return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
	};
	return {
		total: records.length,
		allowed: records.filter((record) => record.decision === "allowed").length,
		denied: records.filter((record) => record.decision === "denied").length,
		byTool: tally((record) => record.tool).map(([tool, counts]) => ({ tool, ...counts })),
		bySurface: tally((record) => record.surface).map(([surface, counts]) => ({ surface, ...counts })),
	};
}
