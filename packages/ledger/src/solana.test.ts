import { describe, expect, test } from "bun:test";
import { graphIndexAddress } from "./graph-index.ts";
import { formatMemoV3 } from "./memo.ts";
import {
	AMOUNT_ONE_LAMPORT,
	AMOUNT_ZERO,
	execFileRunner,
	keygenPath,
	parseSignature,
	pointerTransferArgv,
	type PointerTransferInput,
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

describe("pointerTransferArgv (v3 pointer to the graph index address)", () => {
	const GRAPH = "graph-a";
	const INDEX = graphIndexAddress(GRAPH);
	const POINTER = formatMemoV3({
		graphId: GRAPH,
		periodStartMs: Date.UTC(2026, 8, 26, 10),
		count: 3,
		graphHeadsRootHex: "cd".repeat(32),
		hourTxSig: SIG,
	});
	const POINTER_BASE: PointerTransferInput = {
		cli: SOLANA_CLI_DEFAULT,
		recipient: INDEX,
		memo: POINTER,
		rpcUrl: "https://api.devnet.solana.com",
		keypairPath: KEYPAIR,
	};

	test("the recipient is the index address, the memo is carried, 0 lamports by default, same flags as transferMemoArgv", () => {
		expect(pointerTransferArgv(POINTER_BASE)).toEqual([
			SOLANA_CLI_DEFAULT,
			"transfer",
			INDEX,
			"0",
			"--with-memo",
			POINTER,
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
		expect(pointerTransferArgv(POINTER_BASE)[2]).toBe(graphIndexAddress(GRAPH));
		expect(pointerTransferArgv(POINTER_BASE)[5]).toBe(POINTER);
	});

	test("lamports are sent as an exact SOL amount", () => {
		const amount = (lamports: number) => pointerTransferArgv({ ...POINTER_BASE, lamports })[3];
		expect(amount(0)).toBe("0");
		expect(amount(1)).toBe("0.000000001");
		expect(amount(890_880)).toBe("0.00089088");
		expect(amount(1_000_000_000)).toBe("1");
		expect(amount(2_500_000_000)).toBe("2.5");
	});

	test("refuses a recipient that is not the memo graph's index address, a non-v3 memo, and bad lamports, paths or cli", () => {
		const bad: Array<Partial<PointerTransferInput>> = [
			{ recipient: graphIndexAddress("graph-b") },
			{ recipient: PUBKEY },
			{ memo: MEMO },
			{ lamports: -1 },
			{ lamports: 0.5 },
			{ lamports: Number.NaN },
			{ cli: "solana" },
			{ keypairPath: "ledger-devnet.json" },
			{ rpcUrl: "devnet" },
		];
		for (const patch of bad) {
			expect(() => pointerTransferArgv({ ...POINTER_BASE, ...patch })).toThrow();
		}
	});

	test("transferMemoArgv still refuses a v3 memo: the hour transaction stays v1 or v2", () => {
		expect(() => transferMemoArgv({ ...BASE, memo: POINTER })).toThrow("transferMemoArgv");
	});
});
