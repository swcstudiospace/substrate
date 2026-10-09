import { describe, expect, test } from "bun:test";
import {
	AMOUNT_ONE_LAMPORT,
	AMOUNT_ZERO,
	execFileRunner,
	keygenPath,
	parseSignature,
	pubkeyArgv,
	SOLANA_CLI_DEFAULT,
	transferMemoArgv,
	type TransferMemoInput,
} from "./solana.ts";

const PUBKEY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const MEMO = `substrate:v1:2026-09-26T10:00:00.000Z:${"ab".repeat(32)}:79`;
const KEYPAIR = "/nonexistent/ledger-devnet-test.json";
const BASE: TransferMemoInput = {
	cli: SOLANA_CLI_DEFAULT,
	pubkey: PUBKEY,
	memo: MEMO,
	rpcUrl: "https://api.devnet.solana.com",
	keypairPath: KEYPAIR,
	amountSol: AMOUNT_ZERO,
};
const SIG = "5".repeat(87) + "k";

describe("transferMemoArgv (D-06)", () => {
	test("builds the self-transfer memo argv with every flag explicit", () => {
		expect(transferMemoArgv(BASE)).toEqual([
			SOLANA_CLI_DEFAULT,
			"transfer",
			PUBKEY,
			"0",
			"--with-memo",
			MEMO,
			"--url",
			"https://api.devnet.solana.com",
			"--keypair",
			KEYPAIR,
			"--fee-payer",
			KEYPAIR,
			"--commitment",
			"confirmed",
			"--allow-unfunded-recipient",
			"--output",
			"json",
		]);
	});

	test("the one-lamport fallback changes only the amount", () => {
		const zero = transferMemoArgv(BASE);
		const lamport = transferMemoArgv({ ...BASE, amountSol: AMOUNT_ONE_LAMPORT });
		expect(lamport[3]).toBe("0.000000001");
		expect(lamport.filter((_, i) => i !== 3)).toEqual(zero.filter((_, i) => i !== 3));
	});

	test("refuses any other amount, memo, pubkey, keypair path or url", () => {
		const bad: Array<Partial<Record<keyof TransferMemoInput, string>>> = [
			{ amountSol: "1" },
			{ amountSol: "0.0" },
			{ memo: "hello" },
			{ memo: MEMO.replace(":79", ":0") },
			{ pubkey: "0OIl".repeat(10) },
			{ pubkey: "abc" },
			{ keypairPath: "ledger-devnet.json" },
			{ rpcUrl: "devnet" },
			{ rpcUrl: "file:///etc/passwd" },
		];
		for (const patch of bad) {
			expect(() => transferMemoArgv({ ...BASE, ...patch } as TransferMemoInput)).toThrow();
		}
	});

	test("a keypair path that does not exist is accepted (the builder never opens it)", () => {
		expect(transferMemoArgv(BASE)).toContain(KEYPAIR);
	});
});

describe("keygen argv", () => {
	test("pubkeyArgv and keygenPath", () => {
		expect(pubkeyArgv({ keygen: "/opt/bin/solana-keygen", keypairPath: KEYPAIR })).toEqual([
			"/opt/bin/solana-keygen",
			"pubkey",
			KEYPAIR,
		]);
		expect(keygenPath(SOLANA_CLI_DEFAULT)).toBe("/root/.local/share/solana/install/active_release/bin/solana-keygen");
	});
});

describe("parseSignature", () => {
	test("returns the signature from --output json", () => {
		expect(parseSignature(`{"signature":"${SIG}"}\n`)).toBe(SIG);
	});

	test("throws on missing key, non-base58 value and non-JSON, quoting at most 200 characters", () => {
		for (const out of ['{"sig":"x"}', '{"signature":"0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"}', `Error: ${"x".repeat(500)}`]) {
			let message = "";
			try {
				parseSignature(out);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).not.toBe("");
			expect(message).not.toContain("x".repeat(201));
		}
	});
});

describe("execFileRunner", () => {
	test("runs an argv without a shell", async () => {
		expect(await execFileRunner(["/bin/echo", "ok"])).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
		// A shell would expand this; execFile passes it through verbatim.
		expect((await execFileRunner(["/bin/echo", "$HOME;id"])).stdout).toBe("$HOME;id\n");
	});
});
