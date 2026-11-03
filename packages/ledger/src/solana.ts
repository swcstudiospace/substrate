/**
 * The transactions the ledger may sign (D-06): a 0 SOL (or 1 lamport) transfer carrying an anchor memo, the hour's v1/v2
 * self-transfer or a v3 pointer to a graph's index address, through the absolute solana CLI path. Builders are pure argv; the Runner is
 * execFile with an argv (never a shell). Only the keypair *path* is passed; nothing here opens it.
 */

import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { graphIndexAddress } from "./graph-index.ts";
import { parseMemo, parseMemoV3 } from "./memo.ts";

export const SOLANA_CLI_DEFAULT = "/root/.local/share/solana/install/active_release/bin/solana";
export const AMOUNT_ZERO = "0";
export const AMOUNT_ONE_LAMPORT = "0.000000001";
const LAMPORTS_PER_SOL = 1_000_000_000;

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_EXCERPT_CHARS = 200;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** solana-keygen installed beside the solana binary. */
export function keygenPath(cli: string): string {
	return join(dirname(cli), "solana-keygen");
}

export type TransferMemoInput = {
	cli: string;
	pubkey: string;
	memo: string;
	rpcUrl: string;
	keypairPath: string;
	amountSol: typeof AMOUNT_ZERO | typeof AMOUNT_ONE_LAMPORT;
};

/** argv for the anchor memo transfer to self. Throws on anything outside the D-06 shape. */
export function transferMemoArgv({ cli, pubkey, memo, rpcUrl, keypairPath, amountSol }: TransferMemoInput): string[] {
	if (amountSol !== AMOUNT_ZERO && amountSol !== AMOUNT_ONE_LAMPORT) {
		throw new Error(`transferMemoArgv: amount must be ${AMOUNT_ZERO} or ${AMOUNT_ONE_LAMPORT}`);
	}
	if (parseMemo(memo) === null) throw new Error("transferMemoArgv: memo is not a v1 or v2 anchor memo");
	return transferArgv("transferMemoArgv", { cli, recipient: pubkey, memo, rpcUrl, keypairPath, amount: amountSol });
}

export type PointerTransferInput = Omit<TransferMemoInput, "pubkey" | "amountSol"> & {
	/** The graph's index address; must equal graphIndexAddress of the graph id the memo carries. */
	recipient: string;
	/** Lamports to send. 0 by default; the devnet probe (design Q3) sends 0 to an unfunded index address. */
	lamports?: number;
};

/**
 * argv for one graph's v3 pointer: `lamports` to the graph's index address, memo the v3 pointer. Same flags as
 * transferMemoArgv, including --allow-unfunded-recipient.
 */
export function pointerTransferArgv({ cli, recipient, memo, rpcUrl, keypairPath, lamports = 0 }: PointerTransferInput): string[] {
	const pointer = parseMemoV3(memo);
	if (pointer === null) throw new Error("pointerTransferArgv: memo is not a v3 pointer memo");
	if (recipient !== graphIndexAddress(pointer.graphId)) {
		throw new Error("pointerTransferArgv: recipient is not the graph's index address");
	}
	if (!Number.isSafeInteger(lamports) || lamports < 0) {
		throw new Error("pointerTransferArgv: lamports must be a non-negative safe integer");
	}
	return transferArgv("pointerTransferArgv", { cli, recipient, memo, rpcUrl, keypairPath, amount: lamportsToSol(lamports) });
}

/** Lamports as the positional SOL amount the CLI takes: exact, at most 9 decimals, "0" for none. */
function lamportsToSol(lamports: number): string {
	if (lamports === 0) return AMOUNT_ZERO;
	const whole = Math.floor(lamports / LAMPORTS_PER_SOL);
	const fraction = String(lamports % LAMPORTS_PER_SOL)
		.padStart(9, "0")
		.replace(/0+$/, "");
	return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

type TransferArgvInput = {
	cli: string;
	recipient: string;
	memo: string;
	rpcUrl: string;
	keypairPath: string;
	amount: string;
};

/** The D-06 transfer argv, every flag explicit. `fn` names the public caller in each error. The memo is checked by the caller. */
function transferArgv(fn: string, { cli, recipient, memo, rpcUrl, keypairPath, amount }: TransferArgvInput): string[] {
	if (!isAbsolute(cli)) throw new Error(`${fn}: solana CLI path must be absolute`);
	if (!PUBKEY_RE.test(recipient)) throw new Error(`${fn}: recipient is not 32-44 base58 characters`);
	if (!isAbsolute(keypairPath)) throw new Error(`${fn}: keypair path must be absolute`);
	if (!/^https?:\/\//.test(rpcUrl)) throw new Error(`${fn}: rpc url must be http(s)`);
	return [
		cli,
		"transfer",
		recipient,
		amount,
		"--with-memo",
		memo,
		"--url",
		rpcUrl,
		"--keypair",
		keypairPath,
		"--fee-payer",
		keypairPath,
		"--commitment",
		"confirmed",
		"--allow-unfunded-recipient",
		"--output",
		"json",
	];
}

export function pubkeyArgv({ keygen, keypairPath }: { keygen: string; keypairPath: string }): string[] {
	return [keygen, "pubkey", keypairPath];
}

/** The signature from `--output json` stdout; errors quote at most 200 characters of the output. */
export function parseSignature(stdout: string): string {
	const excerpt = stdout.trim().slice(0, OUTPUT_EXCERPT_CHARS);
	let body: unknown;
	try {
		body = JSON.parse(stdout);
	} catch {
		throw new Error(`solana output is not JSON: ${excerpt}`);
	}
	const signature = (body as { signature?: unknown } | null)?.signature;
	if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
		throw new Error(`solana output has no base58 signature: ${excerpt}`);
	}
	return signature;
}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/** The production runner: execFile with an argv (never a shell), 120 s, 4 MiB, HOME=/root. */
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(
		argv[0] as string,
		argv.slice(1),
		{ timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: { ...process.env, HOME: "/root" } },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		},
	);
	return promise;
}
