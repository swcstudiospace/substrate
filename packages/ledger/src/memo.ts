/**
 * The anchor memo (D-10): `substrate:v1:<period_start_iso>:<root_hex>:<count>`. Memo v2 (D73-01)
 * appends the per-graph heads root: `substrate:v2:<period_start_iso>:<root_hex>:<count>:<heads_root_hex>`.
 * The ISO period contains colons, so parsing is one anchored regex, never a split.
 */

import { HOUR_MS, hourIso } from "./period.ts";

const MEMO_PREFIX = "substrate:v1:";
const MEMO_RE = /^substrate:v1:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*)$/;
const MEMO_PREFIX_V2 = "substrate:v2:";
const MEMO_V2_RE = /^substrate:v2:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*):([0-9a-f]{64})$/;

/** Memo v4 (what solana-cli 4.2.2 writes), v3 and v1; readers accept any of them. */
export const MEMO_PROGRAM_IDS: ReadonlySet<string> = new Set([
	"Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH",
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
	"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

type Memo = { periodStartMs: number; rootHex: string; count: number };

type MemoV2 = Memo & { headsRootHex: string };

const ROOT_RE = /^[0-9a-f]{64}$/;

/** Shared field checks for both versions; `fn` names the public caller in the error, as the other helpers do. */
function checkMemoFields(fn: string, { periodStartMs, rootHex, count }: Memo): void {
	if (!Number.isSafeInteger(periodStartMs) || periodStartMs % HOUR_MS !== 0) {
		throw new Error(`${fn}: period is not a whole UTC hour`);
	}
	if (!ROOT_RE.test(rootHex)) throw new Error(`${fn}: root is not 64 lowercase hex characters`);
	if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${fn}: count must be a positive integer`);
}

export function formatMemo({ periodStartMs, rootHex, count }: Memo): string {
	checkMemoFields("formatMemo", { periodStartMs, rootHex, count });
	return `${MEMO_PREFIX}${hourIso(periodStartMs)}:${rootHex}:${count}`;
}

/** The v2 memo: the v1 fields plus the 64-hex root over the per-graph head records (heads.ts). */
export function formatMemoV2({ periodStartMs, rootHex, count, headsRootHex }: MemoV2): string {
	checkMemoFields("formatMemoV2", { periodStartMs, rootHex, count });
	if (!ROOT_RE.test(headsRootHex)) throw new Error("formatMemoV2: heads root is not 64 lowercase hex characters");
	return `${MEMO_PREFIX_V2}${hourIso(periodStartMs)}:${rootHex}:${count}:${headsRootHex}`;
}

/** Period and count of a memo body, or null when the ISO period does not round-trip or the count is unsafe. */
function parseFields(iso: string, rootHex: string, count: string): Memo | null {
	const periodStartMs = Date.parse(iso);
	const n = Number(count);
	if (!Number.isFinite(periodStartMs) || new Date(periodStartMs).toISOString() !== iso) return null;
	if (!Number.isSafeInteger(n)) return null;
	return { periodStartMs, rootHex, count: n };
}

/**
 * The parsed memo, or null for anything that is not exactly a v1 or v2 memo (v3 included). A v1 memo
 * yields { periodStartMs, rootHex, count }; a v2 memo also yields headsRootHex.
 */
export function parseMemo(text: string): (Memo & { headsRootHex?: string }) | null {
	const v1 = MEMO_RE.exec(text);
	if (v1) return parseFields(v1[1] as string, v1[2] as string, v1[3] as string);
	const v2 = MEMO_V2_RE.exec(text);
	if (!v2) return null;
	const memo = parseFields(v2[1] as string, v2[2] as string, v2[3] as string);
	return memo === null ? null : { ...memo, headsRootHex: v2[4] as string };
}

/** Memo v3 (design section 3.2): one pointer per (graph, hour), naming the graph in the clear. */
export const MEMO_PREFIX_V3 = "substrate:v3:";
/**
 * Tail-anchored. The graph id is free text and may hold ':', so the graph id is the greedy rest of the body and the
 * fields after the period (count, root, signature) hold no colon, which fixes where the period sits.
 */
const MEMO_V3_RE =
	/^substrate:v3:([\s\S]+):(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([1-9]\d*):([0-9a-f]{64}):([1-9A-HJ-NP-Za-km-z]{64,88})$/;
/**
 * The longest graph id a v3 memo carries, in UTF-8 bytes: the cap the event write path enforces (mcp-server event.ts
 * normalizeGraphId), so every stored graph id fits a pointer. Bytes, not UTF-16 units: one character is one to four bytes.
 */
export const MEMO_GRAPH_ID_MAX = 512;
const HOUR_TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

type MemoV3 = {
	graphId: string;
	periodStartMs: number;
	count: number;
	/** Merkle root over this graph's head records in the hour (heads.ts graphHeadsRoot). */
	graphHeadsRootHex: string;
	/** Base58 signature of the hour's v1/v2 transaction, sent before this pointer. */
	hourTxSig: string;
};

/** A high or low UTF-16 surrogate without its pair. argv encodes one as U+FFFD, so a pointer naming it would name another graph. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The v3 pointer memo: `substrate:v3:<graph_id>:<period ISO>:<count>:<graph_heads_root>:<hour_tx_sig>`. Throws on a bad field. */
export function formatMemoV3({ graphId, periodStartMs, count, graphHeadsRootHex, hourTxSig }: MemoV3): string {
	if (typeof graphId !== "string" || graphId.length === 0 || new TextEncoder().encode(graphId).byteLength > MEMO_GRAPH_ID_MAX) {
		throw new Error(`formatMemoV3: graph id must be 1 to ${MEMO_GRAPH_ID_MAX} UTF-8 bytes`);
	}
	const lone = LONE_SURROGATE_RE.exec(graphId);
	if (lone) {
		throw new Error(
			`formatMemoV3: graph id has a lone UTF-16 surrogate (U+${lone[0].charCodeAt(0).toString(16).toUpperCase()}); a graph id must be well-formed Unicode`,
		);
	}
	checkMemoFields("formatMemoV3", { periodStartMs, rootHex: graphHeadsRootHex, count });
	if (!HOUR_TX_SIG_RE.test(hourTxSig)) throw new Error("formatMemoV3: hour transaction signature is not 64-88 base58 characters");
	return `${MEMO_PREFIX_V3}${graphId}:${hourIso(periodStartMs)}:${count}:${graphHeadsRootHex}:${hourTxSig}`;
}

/** The parsed v3 pointer, or null for anything that is not exactly a v3 memo. parseMemo never reads v3. */
export function parseMemoV3(text: string): MemoV3 | null {
	const m = MEMO_V3_RE.exec(text);
	if (!m) return null;
	if (new TextEncoder().encode(m[1] as string).byteLength > MEMO_GRAPH_ID_MAX) return null;
	const iso = m[2] as string;
	const periodStartMs = Date.parse(iso);
	const count = Number(m[3]);
	if (!Number.isFinite(periodStartMs) || new Date(periodStartMs).toISOString() !== iso) return null;
	if (!Number.isSafeInteger(count)) return null;
	return {
		graphId: m[1] as string,
		periodStartMs,
		count,
		graphHeadsRootHex: m[4] as string,
		hourTxSig: m[5] as string,
	};
}

/** getSignaturesForAddress reports memos as `[<len>] <text>`; return the text. */
export function stripListingPrefix(memo: string | null): string | null {
	if (memo === null) return null;
	const m = /^\[\d+\] /.exec(memo);
	return m ? memo.slice(m[0].length) : memo;
}
