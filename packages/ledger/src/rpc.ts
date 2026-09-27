/**
 * Devnet read-back over plain fetch JSON-RPC: per-call timeout, bounded attempts with a fixed
 * backoff. The endpoint is public, flaky and untrusted, so every response is parsed defensively and
 * memo text is taken only from an instruction whose programId is one of the memo programs.
 */

import { MEMO_PROGRAM_IDS, stripListingPrefix } from "./memo.ts";

const BS58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ERROR_EXCERPT_CHARS = 200;

export class RpcError extends Error {
	override name = "RpcError";
}

/** Base58 (Bitcoin alphabet) → bytes; each leading "1" is one leading zero byte. */
export function bs58decode(text: string): Uint8Array {
	const bytes: number[] = [];
	for (const ch of text) {
		let carry = BS58_ALPHABET.indexOf(ch);
		if (carry < 0) throw new Error("bs58decode: invalid base58 character");
		for (let i = 0; i < bytes.length; i++) {
			carry += (bytes[i] as number) * 58;
			bytes[i] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	let zeros = 0;
	while (text[zeros] === "1") zeros++;
	const out = new Uint8Array(zeros + bytes.length);
	out.set(bytes.reverse(), zeros);
	return out;
}

export type Commitment = "processed" | "confirmed" | "finalized";

export type TransactionMemo = {
	memo: string | null;
	payer: string | null;
	payerSigned: boolean;
	err: unknown;
	fee: number | null;
	slot: number | null;
	blockTime: number | null;
};

export type AddressMemo = { signature: string; memo: string | null; err: unknown; slot: number | null };

export type RpcOptions = {
	url: string;
	timeoutMs: number;
	attempts: number;
	backoffMs: number;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

export interface Rpc {
	/** The memo transaction's fields verify needs, or null when the node does not know the signature. */
	transactionMemo(signature: string, commitment: Commitment): Promise<TransactionMemo | null>;
	/** Recent signatures touching `pubkey`, memo text only as a hint (confirm with transactionMemo). */
	addressMemos(pubkey: string, limit: number): Promise<AddressMemo[]>;
	/** Lamports held by `pubkey`. */
	balance(pubkey: string): Promise<number>;
}

type ParsedInstruction = { programId?: unknown; parsed?: unknown; data?: unknown };
type ParsedAccountKey = { pubkey?: unknown; signer?: unknown } | string;
type ParsedTransaction = {
	slot?: unknown;
	blockTime?: unknown;
	meta?: { err?: unknown; fee?: unknown } | null;
	transaction?: { message?: { accountKeys?: ParsedAccountKey[]; instructions?: ParsedInstruction[] } };
};
type SignatureInfo = { signature?: unknown; memo?: unknown; err?: unknown; slot?: unknown };

const numberOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

function instructionMemo(ix: ParsedInstruction): string | null {
	if (typeof ix.parsed === "string") return ix.parsed;
	if (typeof ix.data !== "string") return null;
	try {
		return new TextDecoder().decode(bs58decode(ix.data));
	} catch {
		return null;
	}
}

export function createRpc({ url, timeoutMs, attempts, backoffMs, fetchImpl = fetch, sleep = Bun.sleep }: RpcOptions): Rpc {
	let nextId = 1;

	/** One JSON-RPC call. Transport, HTTP and non-JSON failures retry; a JSON-RPC error object does not. */
	async function call<T>(method: string, params: unknown[]): Promise<T> {
		let lastFailure = "no attempt made";
		for (let attempt = 1; attempt <= attempts; attempt++) {
			if (attempt > 1) await sleep(backoffMs);
			let text: string;
			try {
				const response = await fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
					signal: AbortSignal.timeout(timeoutMs),
				});
				text = await response.text();
				if (!response.ok) {
					lastFailure = `HTTP ${response.status}: ${text.slice(0, ERROR_EXCERPT_CHARS)}`;
					continue;
				}
			} catch (cause) {
				lastFailure = (cause instanceof Error ? cause.message : String(cause)).slice(0, ERROR_EXCERPT_CHARS);
				continue;
			}
			let body: { result?: T; error?: { code?: unknown; message?: unknown } };
			try {
				body = JSON.parse(text);
			} catch {
				lastFailure = `non-JSON response: ${text.slice(0, ERROR_EXCERPT_CHARS)}`;
				continue;
			}
			if (body.error) {
				const message = String(body.error.message ?? "unknown error").slice(0, ERROR_EXCERPT_CHARS);
				throw new RpcError(`${method} rpc error ${String(body.error.code)}: ${message}`);
			}
			return body.result as T;
		}
		throw new RpcError(`${method} failed after ${attempts} attempts: ${lastFailure}`);
	}

	return {
		async transactionMemo(signature: string, commitment: Commitment): Promise<TransactionMemo | null> {
			const tx = await call<ParsedTransaction | null>("getTransaction", [
				signature,
				{ encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment },
			]);
			if (tx === null) return null;
			const message = tx.transaction?.message;
			if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) {
				throw new RpcError("getTransaction returned a malformed transaction");
			}
			const first = message.accountKeys[0];
			const payer = typeof first === "string" ? first : typeof first?.pubkey === "string" ? first.pubkey : null;
			const payerSigned = typeof first === "object" && first?.signer === true;
			const ix = message.instructions.find(
				(i) => typeof i?.programId === "string" && MEMO_PROGRAM_IDS.has(i.programId),
			);
			return {
				memo: ix ? instructionMemo(ix) : null,
				payer,
				payerSigned,
				err: tx.meta ? (tx.meta.err ?? null) : null,
				fee: numberOrNull(tx.meta?.fee),
				slot: numberOrNull(tx.slot),
				blockTime: numberOrNull(tx.blockTime),
			};
		},

		async addressMemos(pubkey: string, limit: number): Promise<AddressMemo[]> {
			const list = await call<SignatureInfo[]>("getSignaturesForAddress", [pubkey, { limit }]);
			if (!Array.isArray(list)) throw new RpcError("getSignaturesForAddress returned a non-array");
			return list
				.filter((s): s is SignatureInfo & { signature: string } => typeof s?.signature === "string")
				.map((s) => ({
					signature: s.signature,
					memo: stripListingPrefix(typeof s.memo === "string" ? s.memo : null),
					err: s.err ?? null,
					slot: numberOrNull(s.slot),
				}));
		},

		async balance(pubkey: string): Promise<number> {
			const result = await call<{ value?: unknown }>("getBalance", [pubkey]);
			if (typeof result?.value !== "number") throw new RpcError("getBalance returned no value");
			return result.value;
		},
	};
}
