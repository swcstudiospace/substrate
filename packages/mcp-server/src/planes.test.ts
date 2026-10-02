import { describe, expect, test } from "bun:test";
import { encodeCommand, parseRedisUrl, parseReply, parseSolanaSignature, planesFromEnv } from "./planes.ts";

describe("planesFromEnv", () => {
	test("an empty environment configures no planes", () => {
		expect(planesFromEnv({})).toEqual({
			hindsight: null,
			ragflow: null,
			dragonflyUrl: undefined,
			solana: null,
		});
	});

	test("a key without a url is not half-configured", () => {
		expect(planesFromEnv({ HINDSIGHT_API_KEY: "secret", RAGFLOW_URL: "https://rag.example" }).hindsight).toBeNull();
		expect(planesFromEnv({ RAGFLOW_URL: "https://rag.example" }).ragflow).toBeNull();
	});

	test("solana accepts either keypair env name", () => {
		expect(planesFromEnv({ SOLANA_RPC_URL: "https://api.devnet.solana.com", SOLANA_ANCHOR_KEYPAIR: "/keys/a.json" }).solana)
			.toEqual({ rpcUrl: "https://api.devnet.solana.com", keypairPath: "/keys/a.json" });
	});
});

describe("dragonfly framing", () => {
	test("parses a redis URL without putting the password in the host", () => {
		expect(parseRedisUrl("redis://:s3cret@10.1.2.3:6379/0")).toEqual({
			host: "10.1.2.3",
			port: 6379,
			password: "s3cret",
		});
	});

	test("rejects a non-redis URL", () => {
		expect(() => parseRedisUrl("https://example.com")).toThrow(/redis URL/);
	});

	test("encodes a command so a password cannot close the frame early", () => {
		expect(encodeCommand(["AUTH", "a\r\nb"])).toBe("*2\r\n$4\r\nAUTH\r\n$4\r\na\r\nb\r\n");
	});

	test("reads a simple and a bulk reply", () => {
		expect(parseReply("+PONG\r\n")).toBe("PONG");
		expect(parseReply("-NOAUTH\r\n")).toBe("NOAUTH");
		expect(parseReply("$2\r\nok\r\n")).toBe("ok");
	});
});

describe("solana signature parsing", () => {
	test("accepts a real signature and rejects the old stub prefix", () => {
		const signature = "5".repeat(64) + "A".repeat(4);
		expect(parseSolanaSignature(`Signature: ${signature}\n`)).toBe(signature);
		expect(parseSolanaSignature("solana-devnet-memo:ut-abc:stub")).toBeNull();
	});
});
