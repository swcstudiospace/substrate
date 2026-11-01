/**
 * The anchor memo (D-10): `substrate:v1:<period_start_iso>:<root_hex>:<count>`. Memo v2 (D73-01)
 * appends the per-graph heads root: `substrate:v2:<period_start_iso>:<root_hex>:<count>:<heads_root_hex>`.
 * The ISO period contains colons, so parsing is one anchored regex, never a split.
 */

import { HOUR_MS, hourIso } from "./period.ts";

export const MEMO_PREFIX = "substrate:v1:";
export const MEMO_RE = /^substrate:v1:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*)$/;
export const MEMO_PREFIX_V2 = "substrate:v2:";
export const MEMO_V2_RE = /^substrate:v2:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*):([0-9a-f]{64})$/;

/** Memo v4 (what solana-cli 4.2.2 writes), v3 and v1; readers accept any of them. */
export const MEMO_PROGRAM_IDS: ReadonlySet<string> = new Set([
	"Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH",
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
	"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

export type Memo = { periodStartMs: number; rootHex: string; count: number };

export type MemoV2 = Memo & { headsRootHex: string };

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

/** getSignaturesForAddress reports memos as `[<len>] <text>`; return the text. */
export function stripListingPrefix(memo: string | null): string | null {
	if (memo === null) return null;
	const m = /^\[\d+\] /.exec(memo);
	return m ? memo.slice(m[0].length) : memo;
}
