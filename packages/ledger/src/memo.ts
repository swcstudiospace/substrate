/**
 * The v1 anchor memo (D-10): `substrate:v1:<period_start_iso>:<root_hex>:<count>`. The ISO period
 * contains colons, so parsing is one anchored regex, never a split.
 */

import { HOUR_MS, hourIso } from "./period.ts";

export const MEMO_PREFIX = "substrate:v1:";
export const MEMO_RE = /^substrate:v1:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*)$/;

/** Memo v4 (what solana-cli 4.2.2 writes), v3 and v1; readers accept any of them. */
export const MEMO_PROGRAM_IDS: ReadonlySet<string> = new Set([
	"Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH",
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
	"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

export type Memo = { periodStartMs: number; rootHex: string; count: number };

const ROOT_RE = /^[0-9a-f]{64}$/;

export function formatMemo({ periodStartMs, rootHex, count }: Memo): string {
	if (!Number.isSafeInteger(periodStartMs) || periodStartMs % HOUR_MS !== 0) {
		throw new Error("formatMemo: period is not a whole UTC hour");
	}
	if (!ROOT_RE.test(rootHex)) throw new Error("formatMemo: root is not 64 lowercase hex characters");
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("formatMemo: count must be a positive integer");
	return `${MEMO_PREFIX}${hourIso(periodStartMs)}:${rootHex}:${count}`;
}

/** The parsed memo, or null for anything that is not exactly a v1 memo. */
export function parseMemo(text: string): Memo | null {
	const m = MEMO_RE.exec(text);
	if (!m) return null;
	const periodStartMs = Date.parse(m[1] as string);
	const count = Number(m[3]);
	if (!Number.isFinite(periodStartMs) || new Date(periodStartMs).toISOString() !== m[1]) return null;
	if (!Number.isSafeInteger(count)) return null;
	return { periodStartMs, rootHex: m[2] as string, count };
}

/** getSignaturesForAddress reports memos as `[<len>] <text>`; return the text. */
export function stripListingPrefix(memo: string | null): string | null {
	if (memo === null) return null;
	const m = /^\[\d+\] /.exec(memo);
	return m ? memo.slice(m[0].length) : memo;
}
