import { describe, expect, test } from "bun:test";
import { devnetExplorerTxUrl } from "./explorer.ts";

describe("devnetExplorerTxUrl", () => {
	test("names the devnet cluster and the transaction page for the signature", () => {
		const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

		expect(devnetExplorerTxUrl(sig)).toBe(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
	});

	test("a signature cannot leave the transaction path", () => {
		expect(devnetExplorerTxUrl("abc/def?x=1")).toBe("https://explorer.solana.com/tx/abc%2Fdef%3Fx%3D1?cluster=devnet");
	});
});
