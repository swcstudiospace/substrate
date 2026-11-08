import { describe, expect, test } from "bun:test";
import { graphIndexAddress } from "./graph-index.ts";
import { formatMemoV3 } from "./memo.ts";
import { assertDevnetRpcUrl, bs58decode, bs58encode, createRpc, RpcError, RpcUrlError } from "./rpc.ts";

const URL_ = "https://rpc.test.invalid";
const PAYER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const SIG = "5".repeat(87) + "k";
const MEMO = `substrate:v1:2026-09-26T10:00:00.000Z:${"ab".repeat(32)}:79`;
const IDS = [
	"Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH",
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
	"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
];
const SYSTEM = "11111111111111111111111111111111";

type Reply = { result: unknown } | { error: { code: number; message: string } } | Error | string;

/** A fake fetch answering from `replies` in order and recording every JSON-RPC request body. */
function fakeRpc(replies: Reply[], attempts = 3) {
	const requests: Array<{ method: string; params: unknown[] }> = [];
	const sleeps: number[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)));
		const reply = replies.shift();
		if (!reply) throw new Error("no reply scripted");
		if (reply instanceof Error) throw reply;
		if (typeof reply === "string") return new Response(reply, { status: 200 });
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }));
	}) as unknown as typeof fetch;
	const rpc = createRpc({
		url: URL_,
		timeoutMs: 1000,
		attempts,
		backoffMs: 2000,
		fetchImpl,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { rpc, requests, sleeps };
}

function tx(instructions: unknown[]) {
	return {
		slot: 42,
		blockTime: 1_790_000_000,
		meta: { err: null, fee: 5000 },
		transaction: {
			message: {
				accountKeys: [{ pubkey: PAYER, signer: true, writable: true }],
				instructions: [{ programId: SYSTEM, program: "system", parsed: { type: "transfer" } }, ...instructions],
			},
		},
	};
}

describe("transactionMemo", () => {
	test("sends getTransaction jsonParsed and returns the verify fields, under each memo program id", async () => {
		for (const programId of IDS) {
			const { rpc, requests } = fakeRpc([{ result: tx([{ program: "spl-memo", programId, parsed: MEMO }]) }]);
			expect(await rpc.transactionMemo(SIG, "confirmed")).toEqual({
				memo: MEMO,
				payer: PAYER,
				payerSigned: true,
				err: null,
				fee: 5000,
				slot: 42,
				blockTime: 1_790_000_000,
			});
			expect(requests[0]).toMatchObject({
				method: "getTransaction",
				params: [SIG, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
			});
		}
	});

	test("base58-decodes data when parsed is absent", async () => {
		const { rpc } = fakeRpc([{ result: tx([{ programId: IDS[0], data: "2NEpo7TZRRrLZSi2U", accounts: [] }]) }]);
		expect((await rpc.transactionMemo(SIG, "finalized"))?.memo).toBe("Hello World!");
	});

	test("no memo instruction gives memo null; a string from another program is ignored", async () => {
		const { rpc } = fakeRpc([{ result: tx([{ programId: "Fake1111111111111111111111111111111", parsed: MEMO }]) }]);
		expect((await rpc.transactionMemo(SIG, "confirmed"))?.memo).toBeNull();
	});

	test("an unknown signature returns null", async () => {
		const { rpc } = fakeRpc([{ result: null }]);
		expect(await rpc.transactionMemo(SIG, "confirmed")).toBeNull();
	});
});

describe("addressMemos and balance", () => {
	test("getSignaturesForAddress with the limit, listing prefix stripped", async () => {
		const { rpc, requests } = fakeRpc([
			{
				result: [
					{ signature: SIG, slot: 7, err: null, memo: `[105] ${MEMO}`, blockTime: 1 },
					{ signature: "3".repeat(88), slot: 6, err: { InstructionError: [0, "x"] }, memo: null, blockTime: null },
				],
			},
		]);
		expect(await rpc.addressMemos(PAYER, 100)).toEqual([
			{ signature: SIG, memo: MEMO, err: null, slot: 7, blockTime: 1 },
			{ signature: "3".repeat(88), memo: null, err: { InstructionError: [0, "x"] }, slot: 6, blockTime: null },
		]);
		expect(requests[0]).toMatchObject({ method: "getSignaturesForAddress", params: [PAYER, { limit: 100 }] });
	});

	test("a before cursor is passed through so a caller can page backwards", async () => {
		const { rpc, requests } = fakeRpc([{ result: [] }]);
		expect(await rpc.addressMemos(PAYER, 50, SIG)).toEqual([]);
		expect(requests[0]).toMatchObject({ method: "getSignaturesForAddress", params: [PAYER, { limit: 50, before: SIG }] });
	});

	test("commitment is sent only when passed", async () => {
		const { rpc, requests } = fakeRpc([{ result: [] }, { result: [] }, { result: [] }]);
		await rpc.addressMemos(PAYER, 10);
		await rpc.addressMemos(PAYER, 10, SIG, "confirmed");
		await rpc.addressMemos(PAYER, 10, undefined, "finalized");
		expect(requests[0]?.params).toEqual([PAYER, { limit: 10 }]);
		expect(requests[1]?.params).toEqual([PAYER, { limit: 10, before: SIG, commitment: "confirmed" }]);
		expect(requests[2]?.params).toEqual([PAYER, { limit: 10, commitment: "finalized" }]);
	});

	test("balance returns result.value", async () => {
		const { rpc, requests } = fakeRpc([{ result: { context: { slot: 1 }, value: 1_000_000_000 } }]);
		expect(await rpc.balance(PAYER)).toBe(1_000_000_000);
		expect(requests[0]).toMatchObject({ method: "getBalance", params: [PAYER] });
	});
});

describe("getGenesisHash", () => {
	test("calls getGenesisHash with no params and returns the hash", async () => {
		const { rpc, requests } = fakeRpc([{ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }]);
		expect(await rpc.getGenesisHash()).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
		expect(requests[0]).toMatchObject({ method: "getGenesisHash", params: [] });
	});

	test("refuses a non-string hash", async () => {
		const { rpc } = fakeRpc([{ result: null }]);
		await expect(rpc.getGenesisHash()).rejects.toThrow("getGenesisHash returned no hash");
	});
});

describe("retries and errors", () => {
	test("one rejection then an answer succeeds after exactly one backoff sleep", async () => {
		const { rpc, sleeps } = fakeRpc([new Error("timeout"), { result: { value: 5 } }]);
		expect(await rpc.balance(PAYER)).toBe(5);
		expect(sleeps).toEqual([2000]);
	});

	test("`attempts` rejections throw RpcError", async () => {
		const { rpc, requests } = fakeRpc([new Error("a"), new Error("b"), new Error("c"), { result: { value: 5 } }]);
		await expect(rpc.balance(PAYER)).rejects.toBeInstanceOf(RpcError);
		expect(requests.length).toBe(3);
	});

	test("null, a non-object, and an object with neither result nor error are retried", async () => {
		const { rpc, requests } = fakeRpc(["null", "[]", '{"jsonrpc":"2.0","id":1}', { result: { value: 5 } }], 4);
		expect(await rpc.balance(PAYER)).toBe(5);
		expect(requests).toHaveLength(4);
	});

	test("malformed replies that exhaust the attempts throw RpcError", async () => {
		const { rpc } = fakeRpc(["null", "{}", "null"]);
		await expect(rpc.transactionMemo(SIG, "confirmed")).rejects.toBeInstanceOf(RpcError);
	});

	test("a JSON-RPC error is not retried", async () => {
		const { rpc, requests } = fakeRpc([{ error: { code: 1, message: "no" } }, { result: { value: 5 } }]);
		await expect(rpc.balance(PAYER)).rejects.toBeInstanceOf(RpcError);
		expect(requests).toHaveLength(1);
	});

	test("a JSON-RPC error names the code and carries at most 200 characters of message", async () => {
		const { rpc } = fakeRpc([{ error: { code: -32005, message: "m".repeat(500) } }]);
		let error: unknown;
		try {
			await rpc.balance(PAYER);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(RpcError);
		expect((error as Error).message).toContain("-32005");
		expect((error as Error).message).not.toContain("m".repeat(201));
	});
});

describe("bs58decode", () => {
	test("decodes the reference vector and maps each leading 1 to a zero byte", () => {
		expect(new TextDecoder().decode(bs58decode("2NEpo7TZRRrLZSi2U"))).toBe("Hello World!");
		const plain = bs58decode("2NEpo7TZRRrLZSi2U");
		const padded = bs58decode("112NEpo7TZRRrLZSi2U");
		expect(padded.length).toBe(plain.length + 2);
		expect([...padded.slice(0, 2)]).toEqual([0, 0]);
		expect([...padded.slice(2)]).toEqual([...plain]);
		expect(() => bs58decode("0OIl")).toThrow();
	});
});

describe("assertDevnetRpcUrl (defence in depth beside the genesis-hash gate)", () => {
	const ACCEPTED = [
		"https://api.devnet.solana.com",
		"https://API.DEVNET.SOLANA.COM/",
		"http://127.0.0.1:8899",
		"http://localhost:8899",
		"https://rpc.test.invalid",
		"https://devnet.helius-rpc.com/?api-key=abc",
		// Only the host is judged: a devnet host whose path mentions mainnet is a path, not a cluster.
		"https://rpc.example.invalid/mainnet-proxy/devnet",
	];
	const REFUSED: Array<[string, RegExp]> = [
		["https://api.mainnet-beta.solana.com", /mainnet or testnet/],
		["https://api.testnet.solana.com", /mainnet or testnet/],
		["https://API.MAINNET-BETA.SOLANA.COM", /mainnet or testnet/],
		["https://Api.TestNet.Solana.Com/", /mainnet or testnet/],
		["https://mainnet.helius-rpc.com/?api-key=abc", /mainnet or testnet/],
		["https://solana-mainnet.g.alchemy.com/v2/key", /mainnet or testnet/],
		// A mainnet host that merely contains devnet in the path is still mainnet.
		["https://api.mainnet-beta.solana.com/devnet", /mainnet or testnet/],
		["https://rpc.example.invalid@api.mainnet-beta.solana.com/devnet", /userinfo/],
		["https://user:pass@api.devnet.solana.com", /userinfo/],
		["https://token@api.devnet.solana.com", /userinfo/],
		["https://@api.devnet.solana.com", /userinfo/],
		["https://api.devnet.solana.com/#frag", /fragment/],
		["https://api.devnet.solana.com/#", /fragment/],
		["ftp://api.devnet.solana.com", /not http\(s\)/],
		["wss://api.devnet.solana.com", /not http\(s\)/],
		["file:///tmp/validator.sock", /not http\(s\)/],
		["api.devnet.solana.com", /not a valid absolute URL/],
		["", /not a valid absolute URL/],
	];

	for (const url of ACCEPTED) {
		test(`accepts ${url}`, () => {
			expect(() => assertDevnetRpcUrl(url)).not.toThrow();
		});
	}

	for (const [url, message] of REFUSED) {
		test(`refuses ${JSON.stringify(url)} with a typed, actionable error`, () => {
			let error: unknown;
			try {
				assertDevnetRpcUrl(url);
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(RpcUrlError);
			expect(error).toBeInstanceOf(RpcError);
			expect((error as Error).message).toMatch(message);
		});
	}

	test("the refusal never echoes credentials from the URL", () => {
		for (const url of ["https://user:s3cret@api.devnet.solana.com", "https://s3cret@api.mainnet-beta.solana.com/?k=s3cret#s3cret"]) {
			try {
				assertDevnetRpcUrl(url);
			} catch (cause) {
				expect((cause as Error).message).not.toContain("s3cret");
			}
		}
	});

	test("createRpc refuses to build an RPC object for a refused URL and sends nothing", () => {
		let requests = 0;
		const fetchImpl = (async () => {
			requests += 1;
			return new Response("{}");
		}) as unknown as typeof fetch;
		for (const [url] of REFUSED) {
			expect(() => createRpc({ url, timeoutMs: 1000, attempts: 1, backoffMs: 0, fetchImpl })).toThrow(RpcUrlError);
		}
		expect(requests).toBe(0);
	});

	test("createRpc still builds for the default devnet and a local test-validator URL", () => {
		for (const url of ["https://api.devnet.solana.com", "http://localhost:8899"]) {
			expect(() => createRpc({ url, timeoutMs: 1000, attempts: 1, backoffMs: 0 })).not.toThrow();
		}
	});
});

describe("bs58encode", () => {
	test("encodes the reference vector and maps each leading zero byte to a 1", () => {
		expect(bs58encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
		expect(bs58encode(Uint8Array.of(0, 0, 1))).toBe("112");
		expect(bs58encode(Uint8Array.of(0))).toBe("1");
		expect(bs58encode(new Uint8Array(0))).toBe("");
	});

	test("is the inverse of bs58decode, including leading zero bytes", () => {
		for (const bytes of [Uint8Array.of(0, 0, 255, 0, 1), Uint8Array.of(1), new Uint8Array(32).fill(0xab), Uint8Array.of(0, 7)]) {
			expect([...bs58decode(bs58encode(bytes))]).toEqual([...bytes]);
		}
	});
});

describe("addressSignaturePage (paged listing of an index address)", () => {
	const INDEX = graphIndexAddress("graph-a");
	const OLDER = `4${"5".repeat(86)}k`;
	const POINTER = formatMemoV3({
		graphId: "graph-a",
		periodStartMs: Date.UTC(2026, 8, 26, 10),
		count: 3,
		graphHeadsRootHex: "cd".repeat(32),
		hourTxSig: SIG,
	});

	test("sends getSignaturesForAddress with the address, the limit, the before cursor and the commitment", async () => {
		const { rpc, requests } = fakeRpc([{ result: [] }]);
		expect(await rpc.addressSignaturePage(INDEX, { limit: 100, before: SIG, commitment: "confirmed" })).toEqual([]);
		expect(requests[0]).toMatchObject({ method: "getSignaturesForAddress" });
		expect(requests[0]?.params).toEqual([INDEX, { limit: 100, before: SIG, commitment: "confirmed" }]);
	});

	test("omits the before cursor when there is none", async () => {
		const { rpc, requests } = fakeRpc([{ result: [] }]);
		await rpc.addressSignaturePage(INDEX, { limit: 10, commitment: "finalized" });
		expect(requests[0]?.params).toEqual([INDEX, { limit: 10, commitment: "finalized" }]);
	});

	test("caps the limit at 1000 and sends a limit of 1000 unchanged", async () => {
		const { rpc, requests } = fakeRpc([{ result: [] }, { result: [] }]);
		await rpc.addressSignaturePage(INDEX, { limit: 5000, commitment: "confirmed" });
		await rpc.addressSignaturePage(INDEX, { limit: 1000, commitment: "confirmed" });
		expect(requests[0]?.params).toEqual([INDEX, { limit: 1000, commitment: "confirmed" }]);
		expect(requests[1]?.params).toEqual([INDEX, { limit: 1000, commitment: "confirmed" }]);
	});

	test("refuses a limit that is not a positive integer, sending nothing", async () => {
		const { rpc, requests } = fakeRpc([]);
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			await expect(rpc.addressSignaturePage(INDEX, { limit, commitment: "confirmed" })).rejects.toThrow("addressSignaturePage:");
		}
		expect(requests).toEqual([]);
	});

	test("returns the memo as a hint with its listing prefix stripped; the caller confirms it with transactionMemo", async () => {
		const { rpc } = fakeRpc([
			{ result: [{ signature: SIG, slot: 9, err: null, memo: `[${POINTER.length}] ${POINTER}`, blockTime: 1_790_000_000 }] },
		]);
		expect(await rpc.addressSignaturePage(INDEX, { limit: 1, commitment: "confirmed" })).toEqual([
			{ signature: SIG, memo: POINTER, err: null, slot: 9, blockTime: 1_790_000_000 },
		]);
	});

	test("pages backwards: the next page is requested before the last signature of the previous one", async () => {
		const { rpc, requests } = fakeRpc([
			{ result: [{ signature: SIG, slot: 9, err: null, memo: null, blockTime: null }] },
			{ result: [{ signature: OLDER, slot: 8, err: null, memo: null, blockTime: null }] },
		]);
		const first = await rpc.addressSignaturePage(INDEX, { limit: 1, commitment: "confirmed" });
		const cursor = first[0]?.signature;
		if (cursor === undefined) throw new Error("the first page is empty");
		const second = await rpc.addressSignaturePage(INDEX, { limit: 1, before: cursor, commitment: "confirmed" });
		expect(requests[1]?.params).toEqual([INDEX, { limit: 1, before: SIG, commitment: "confirmed" }]);
		expect(second.map((s) => s.signature)).toEqual([OLDER]);
	});

	test("a non-array reply throws RpcError", async () => {
		const { rpc } = fakeRpc([{ result: {} }]);
		await expect(rpc.addressSignaturePage(INDEX, { limit: 1, commitment: "confirmed" })).rejects.toBeInstanceOf(RpcError);
	});
});
