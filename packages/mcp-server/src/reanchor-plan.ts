/**
 * Re-anchor planning after a devnet reset (v1.6, phase 59b).
 *
 * Devnet is wiped from time to time. Every anchor signature then disappears from the cluster although
 * the ledger's hourly roots are intact. This module decides, hour by hour, which anchors rows would
 * have to be written to the new cluster again, and what each new transaction would carry.
 *
 * It is DATA ONLY and a DRY RUN by construction: it imports no RPC, no solana CLI helper and no
 * transport, takes no dependency that could send, and its result carries `dry_run: true`. The plan is
 * the input of the operator runbook; nothing in this file (or anything it imports) sends a
 * transaction, so there is no path that could.
 *
 * The memo is never recomputed: a re-anchor carries the stored row's v1 memo byte for byte (same
 * period, same root, same count), so the commitment is the one the hourly job originally made. A row
 * whose memo is not exactly `formatMemo` of its own period, root and count is refused (skipped as
 * `invalid-row`), never "repaired".
 *
 * Which hours qualify: only `reset-suspected` evidence (the cluster's genesis hash differs from the
 * expected one) with the signature `not-found` on that cluster. A missing signature on the EXPECTED
 * cluster is history pruning or tampering, not a reset, and is never re-anchored from here. Run the
 * plan with the OLD expected genesis still configured, so the wiped cluster is seen as a different one.
 *
 * `anchor.reanchor` (kind `note`, `payload.action: "anchor.reanchor"`) is the ledger event the
 * operator records AFTER a real re-anchor; the builder and validator live here, pure like
 * `session-events.ts`.
 */
import { formatMemo, HOUR_MS, hourIso, type ChainVerdict, type SignatureStatus } from "@substrate/ledger";
import type { AnchorRow } from "./greptime.ts";

export const ANCHOR_REANCHOR_ACTION = "anchor.reanchor";

/** The chain evidence for one hour, as `classifyChainEvidence` plus the reads behind it produced it. */
export interface HourChainEvidence {
	verdict: ChainVerdict;
	/** The classifier's reason, carried into the plan verbatim. */
	reason: string;
	signatureStatus: SignatureStatus;
	/** The genesis hash the RPC reported; null when it could not be read. */
	observedGenesis: string | null;
}

export type ReanchorSkipCode =
	| "ok"
	| "no-evidence"
	| "chain-unreachable"
	| "signature-missing-without-reset"
	| "present-on-observed-cluster"
	| "invalid-row"
	| "duplicate-row";

export interface PlannedReanchor {
	/** ISO start of the hour. */
	period_start: string;
	period_start_ms: number;
	/** Why this hour needs a new anchor: signature missing after a suspected reset, with the evidence. */
	why: string;
	/** The memo v1 text the new transaction would carry: the stored row's memo, unchanged. */
	memo: string;
	root: string;
	event_count: number;
	/** The signature that no longer exists on the observed cluster. */
	previous_tx_sig: string;
	previous_signer: string;
	/** The genesis hash of the cluster the re-anchor would be written to. */
	target_genesis: string;
}

export interface SkippedHour {
	period_start: string;
	code: ReanchorSkipCode;
	detail: string;
}

export interface ReanchorPlan {
	/** Always true: this value is a plan, and nothing was or can be sent from it. */
	dry_run: true;
	generated_at_ms: number;
	hours: PlannedReanchor[];
	skipped: SkippedHour[];
	/** Fixed reminders for the operator reading the plan; no hour-specific content. */
	notes: string[];
}

const ROOT_RE = /^[0-9a-f]{64}$/;

const PLAN_NOTES: readonly string[] = [
	"dry run: no transaction was sent and this plan cannot send one",
	"each memo is the stored anchors row's v1 memo, unchanged: same period, same root, same event count",
	"the new transaction must be signed by a key in the signer set at its own block time, which will be later than the hour it anchors",
	"record each real re-anchor with an anchor.reanchor ledger event naming the previous and the new signature",
];

function parseHour(periodStart: unknown): number | null {
	if (typeof periodStart !== "string") return null;
	const ms = Date.parse(periodStart);
	if (!Number.isSafeInteger(ms) || ms % HOUR_MS !== 0) return null;
	return ms;
}

/** Why a stored row cannot be re-anchored as-is, or null when it is sound. */
function rowProblem(row: AnchorRow, hour: number): string | null {
	if (!ROOT_RE.test(row.root)) return "the row's root is not 64 lowercase hex";
	if (!Number.isSafeInteger(row.event_count) || row.event_count < 1) return "the row's event count is not a positive integer";
	if (row.memo !== formatMemo({ periodStartMs: hour, rootHex: row.root, count: row.event_count })) {
		return "the row's memo is not the v1 memo of its own period, root and count";
	}
	if (typeof row.tx_sig !== "string" || row.tx_sig.length === 0) return "the row has no transaction signature";
	return null;
}

/**
 * Plan the re-anchoring of `anchorRows` from the per-hour chain evidence. `chainEvidenceByHour` is
 * keyed by the hour's start in epoch ms. Deterministic: hours come out ascending, whatever order the
 * rows arrived in. Throws `TypeError` for a non-finite `nowMs`; every row problem is a `skipped` entry.
 */
export function planReanchor(input: {
	anchorRows: readonly AnchorRow[];
	chainEvidenceByHour: ReadonlyMap<number, HourChainEvidence>;
	nowMs: number;
}): ReanchorPlan {
	const { anchorRows, chainEvidenceByHour, nowMs } = input;
	if (!Number.isFinite(nowMs)) throw new TypeError("planReanchor: nowMs must be a finite number");

	const hours: PlannedReanchor[] = [];
	const skipped: SkippedHour[] = [];
	const seen = new Set<number>();
	const parsed = anchorRows
		.map((row) => ({ row, hour: parseHour(row.period_start) }))
		.sort((a, b) => (a.hour ?? Number.NEGATIVE_INFINITY) - (b.hour ?? Number.NEGATIVE_INFINITY) || (a.row.tx_sig < b.row.tx_sig ? -1 : a.row.tx_sig > b.row.tx_sig ? 1 : 0));

	for (const { row, hour } of parsed) {
		if (hour === null) {
			skipped.push({ period_start: String(row.period_start), code: "invalid-row", detail: "period_start is not a whole UTC hour" });
			continue;
		}
		const period_start = hourIso(hour);
		if (seen.has(hour)) {
			skipped.push({ period_start, code: "duplicate-row", detail: "a second anchors row names this hour; resolve the duplicate before planning" });
			continue;
		}
		seen.add(hour);
		const problem = rowProblem(row, hour);
		if (problem !== null) {
			skipped.push({ period_start, code: "invalid-row", detail: problem });
			continue;
		}
		const evidence = chainEvidenceByHour.get(hour);
		if (evidence === undefined) {
			skipped.push({ period_start, code: "no-evidence", detail: "no chain evidence was collected for this hour" });
			continue;
		}
		switch (evidence.verdict) {
			case "ok":
				skipped.push({ period_start, code: "ok", detail: evidence.reason });
				break;
			case "chain-unreachable":
				skipped.push({ period_start, code: "chain-unreachable", detail: evidence.reason });
				break;
			case "signature-missing":
				skipped.push({
					period_start,
					code: "signature-missing-without-reset",
					detail: `${evidence.reason}; the cluster is the expected one, so this is history pruning or tampering, not a reset: investigate, do not re-anchor`,
				});
				break;
			case "reset-suspected": {
				if (evidence.signatureStatus === "unreachable" || evidence.observedGenesis === null) {
					skipped.push({ period_start, code: "chain-unreachable", detail: "a reset is suspected but the signature lookup did not answer, so its absence is not established" });
				} else if (evidence.signatureStatus !== "not-found") {
					skipped.push({
						period_start,
						code: "present-on-observed-cluster",
						detail: `the signature is ${evidence.signatureStatus} on the observed cluster ${evidence.observedGenesis}, so this anchor already lives there`,
					});
				} else {
					hours.push({
						period_start,
						period_start_ms: hour,
						why: `signature missing after a suspected devnet reset: ${evidence.reason}`,
						memo: row.memo,
						root: row.root,
						event_count: row.event_count,
						previous_tx_sig: row.tx_sig,
						previous_signer: row.signer,
						target_genesis: evidence.observedGenesis,
					});
				}
				break;
			}
		}
	}

	return { dry_run: true, generated_at_ms: nowMs, hours, skipped, notes: [...PLAN_NOTES] };
}

// ---------------------------------------------------------------------------
// The `anchor.reanchor` ledger event
// ---------------------------------------------------------------------------

export type ReanchorEventRule = "not_object" | "unknown_key" | "missing" | "type" | "format" | "range" | "enum";

/** A re-anchor payload that breaks a rule. `path` names the field, `rule` the rule broken. */
export class ReanchorEventError extends Error {
	override name = "ReanchorEventError";
	readonly rule: ReanchorEventRule;
	readonly path: string;
	constructor(rule: ReanchorEventRule, path: string, message: string) {
		super(`${path}: ${message}`);
		this.rule = rule;
		this.path = path;
	}
}

export interface ReanchorPayload {
	action: typeof ANCHOR_REANCHOR_ACTION;
	/** ISO start of the hour that was re-anchored. */
	period_start: string;
	/** The root and count the new memo carries; identical to the stored row's. */
	root: string;
	event_count: number;
	previous_tx_sig: string;
	new_tx_sig: string;
	/** The genesis hash of the cluster the new transaction was written to. */
	genesis: string;
}

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const GENESIS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAYLOAD_KEYS = ["action", "period_start", "root", "event_count", "previous_tx_sig", "new_tx_sig", "genesis"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function stringField(value: unknown, path: string, pattern: RegExp, what: string): string {
	if (typeof value !== "string") throw new ReanchorEventError("type", path, "must be a string");
	if (!pattern.test(value)) throw new ReanchorEventError("format", path, `must be ${what}`);
	return value;
}

/**
 * Validate a `anchor.reanchor` payload. Throws `ReanchorEventError`; returns a fresh object in
 * declared key order. A payload read back from the ledger may carry the reserved `_ik`; pass
 * `stored: true` to drop it.
 */
export function parseReanchorPayload(input: unknown, options: { stored?: boolean } = {}): ReanchorPayload {
	let value = input;
	if (options.stored && isPlainObject(value) && Object.hasOwn(value, "_ik")) {
		const { _ik: _dropped, ...rest } = value;
		value = rest;
	}
	if (!isPlainObject(value)) throw new ReanchorEventError("not_object", "payload", "must be a JSON object");
	for (const key of Object.keys(value)) {
		if (!(PAYLOAD_KEYS as readonly string[]).includes(key)) throw new ReanchorEventError("unknown_key", key, "is not an allowed key");
	}
	for (const key of PAYLOAD_KEYS) {
		if (value[key] === undefined) throw new ReanchorEventError("missing", key, "is required");
	}
	if (value["action"] !== ANCHOR_REANCHOR_ACTION) throw new ReanchorEventError("enum", "action", `must be "${ANCHOR_REANCHOR_ACTION}"`);
	const period_start = stringField(value["period_start"], "period_start", /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/, "a whole UTC hour such as 2026-10-20T10:00:00.000Z");
	const hour = parseHour(period_start);
	if (hour === null || hourIso(hour) !== period_start) throw new ReanchorEventError("format", "period_start", "must be a real whole UTC hour");
	const event_count = value["event_count"];
	if (typeof event_count !== "number" || !Number.isSafeInteger(event_count)) throw new ReanchorEventError("type", "event_count", "must be an integer");
	if (event_count < 1) throw new ReanchorEventError("range", "event_count", "must be at least 1");
	const previous_tx_sig = stringField(value["previous_tx_sig"], "previous_tx_sig", SIGNATURE_RE, "a base58 transaction signature");
	const new_tx_sig = stringField(value["new_tx_sig"], "new_tx_sig", SIGNATURE_RE, "a base58 transaction signature");
	if (previous_tx_sig === new_tx_sig) throw new ReanchorEventError("format", "new_tx_sig", "must differ from previous_tx_sig");
	return {
		action: ANCHOR_REANCHOR_ACTION,
		period_start,
		root: stringField(value["root"], "root", ROOT_RE, "64 lowercase hex characters"),
		event_count,
		previous_tx_sig,
		new_tx_sig,
		genesis: stringField(value["genesis"], "genesis", GENESIS_RE, "a base58 genesis hash"),
	};
}

/** The part of an `EventInput` this contract owns; `surface`, `session_id` and `ts` stay the caller's. */
export interface ReanchorEventDraft {
	kind: "note";
	summary: string;
	payload: ReanchorPayload;
	/** Stable per (hour, new signature): a replay of the same re-anchor is the same fact. */
	idempotency_key: string;
}

/** Build the `anchor.reanchor` event draft from a validated payload. Throws `ReanchorEventError`. */
export function buildReanchorEvent(fields: Omit<ReanchorPayload, "action">): ReanchorEventDraft {
	const payload = parseReanchorPayload({ ...fields, action: ANCHOR_REANCHOR_ACTION });
	return {
		kind: "note",
		summary: `re-anchored ${payload.period_start} after a devnet reset: ${payload.event_count} events, root ${payload.root.slice(0, 12)}`,
		payload,
		idempotency_key: `reanchor:${payload.period_start}:${payload.new_tx_sig}`,
	};
}
