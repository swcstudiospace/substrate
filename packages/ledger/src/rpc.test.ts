import { describe, expect, test } from "bun:test";
import { bs58decode, createRpc, RpcError } from "./rpc.ts";

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
					{ signature: "3".repeat(88), slot: 6, err: { InstructionError: [0, "x"] }, memo: null, blockTime: 1 },
				],
			},
		]);
		expect(await rpc.addressMemos(PAYER, 100)).toEqual([
			{ signature: SIG, memo: MEMO, err: null, slot: 7 },
			{ signature: "3".repeat(88), memo: null, err: { InstructionError: [0, "x"] }, slot: 6 },
		]);
		expect(requests[0]).toMatchObject({ method: "getSignaturesForAddress", params: [PAYER, { limit: 100 }] });
	});

	test("balance returns result.value", async () => {
		const { rpc, requests } = fakeRpc([{ result: { context: { slot: 1 }, value: 1_000_000_000 } }]);
		expect(await rpc.balance(PAYER)).toBe(1_000_000_000);
		expect(requests[0]).toMatchObject({ method: "getBalance", params: [PAYER] });
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
