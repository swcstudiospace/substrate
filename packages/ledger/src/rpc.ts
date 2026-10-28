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

/** An RPC URL that may not be used: not http(s), carries credentials or a fragment, or names a non-devnet cluster. */
export class RpcUrlError extends RpcError {
	override name = "RpcUrlError";
}

/** A host naming mainnet, mainnet-beta or testnet (case-insensitive; the label may be embedded, e.g. api.mainnet-beta.solana.com). */
const NON_DEVNET_HOST_RE = /mainnet|testnet/i;
const USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/**
 * Defence in depth for the devnet-only rule (the genesis-hash gate stays the authority): refuse an
 * RPC URL that is not http(s), has userinfo or a fragment, or whose host names mainnet, mainnet-beta
 * or testnet. Only the host is judged, so a devnet host with "mainnet" in its path is not refused and
 * a mainnet host with "devnet" in its path is. The message never echoes the URL (it may hold a
 * credential): only the scheme or host, which are not secret.
 */
export function assertDevnetRpcUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new RpcUrlError("RPC URL is not a valid absolute URL; set SOLANA_RPC_URL to an http(s) devnet endpoint such as https://api.devnet.solana.com");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new RpcUrlError(`RPC URL scheme ${parsed.protocol} is not http(s); use an http(s) devnet endpoint such as https://api.devnet.solana.com`);
	}
	if (parsed.username !== "" || parsed.password !== "" || USERINFO_RE.test(url)) {
		throw new RpcUrlError("RPC URL must not carry userinfo (user:password@); put credentials in the provider's own header or path, not the URL authority");
	}
	if (parsed.hash !== "" || url.includes("#")) {
		throw new RpcUrlError("RPC URL must not carry a fragment (#...); remove it");
	}
	if (NON_DEVNET_HOST_RE.test(parsed.hostname)) {
		throw new RpcUrlError(`RPC host ${parsed.hostname} names a mainnet or testnet cluster; substrate anchors on devnet only (https://api.devnet.solana.com)`);
	}
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

export type AddressMemo = {
	signature: string;
	memo: string | null;
	err: unknown;
	slot: number | null;
	/** Seconds since the epoch the cluster reports for the transaction's block, when the listing carries it. */
	blockTime?: number | null;
};

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
	/**
	 * Signatures touching `pubkey`, newest first, memo text only as a hint (confirm with transactionMemo). `before` is the signature to
	 * continue from: the page returned starts just older than it, so a caller can walk backwards through a long history.
	 */
	addressMemos(pubkey: string, limit: number, before?: string): Promise<AddressMemo[]>;
	/** The cluster's genesis hash, for the job's devnet gate. Thin `getGenesisHash` call. */
	getGenesisHash(): Promise<string>;
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
type SignatureInfo = { signature?: unknown; memo?: unknown; err?: unknown; slot?: unknown; blockTime?: unknown };

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
	assertDevnetRpcUrl(url);
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
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				lastFailure = `non-JSON response: ${text.slice(0, ERROR_EXCERPT_CHARS)}`;
				continue;
			}
			// `null`, an array, or an object with neither result nor error is not a
			// JSON-RPC reply. Reading it as one throws (a null body) or returns
			// undefined, which callers then treat as a transaction. Retry instead.
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				lastFailure = `malformed JSON-RPC response: ${text.slice(0, ERROR_EXCERPT_CHARS)}`;
				continue;
			}
			const body = parsed as { result?: T; error?: { code?: unknown; message?: unknown } };
			const hasResult = Object.hasOwn(body, "result");
			const hasError = Object.hasOwn(body, "error") && body.error != null;
			if (!hasResult && !hasError) {
				lastFailure = `malformed JSON-RPC response: ${text.slice(0, ERROR_EXCERPT_CHARS)}`;
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

		async addressMemos(pubkey: string, limit: number, before?: string): Promise<AddressMemo[]> {
			const list = await call<SignatureInfo[]>("getSignaturesForAddress", [pubkey, before === undefined ? { limit } : { limit, before }]);
			if (!Array.isArray(list)) throw new RpcError("getSignaturesForAddress returned a non-array");
			return list
				.filter((s): s is SignatureInfo & { signature: string } => typeof s?.signature === "string")
				.map((s) => ({
					signature: s.signature,
					memo: stripListingPrefix(typeof s.memo === "string" ? s.memo : null),
					err: s.err ?? null,
					slot: numberOrNull(s.slot),
					blockTime: numberOrNull(s.blockTime),
				}));
		},

		async balance(pubkey: string): Promise<number> {
			const result = await call<{ value?: unknown }>("getBalance", [pubkey]);
			if (typeof result?.value !== "number") throw new RpcError("getBalance returned no value");
			return result.value;
		},

		async getGenesisHash(): Promise<string> {
			const hash = await call<unknown>("getGenesisHash", []);
			if (typeof hash !== "string" || hash.length === 0) throw new RpcError("getGenesisHash returned no hash");
			return hash;
		},
	};
}
