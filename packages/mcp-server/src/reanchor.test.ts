/**
 * The guarded re-anchor executor (v1.6, phase 59, criterion 5): the saved-plan parser, the argument grammar, the dry-run default,
 * every refusal gate, adopt-before-send and the one successful send.
 *
 * No ledger, no network, no real runner and no clock of its own: the ledger, the chain, the runner and the substrate are fakes
 * that LOG every call, so "nothing was sent" and "exactly one send" are asserted from the logs, not assumed. The fake runner
 * answers only `solana-keygen pubkey` and `solana transfer`; any other argv is a TypeError.
 */
import { describe, expect, test } from "bun:test";
import { formatMemo, HOUR_MS, hourIso, type AddressMemo, type Rpc, type RunResult, type TransactionMemo } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH, MAX_HOURS_PER_RUN, REQUIRED_BALANCE_LAMPORTS } from "./anchor.ts";
import type { AnchorRow } from "./greptime.ts";
import {
	dryRunReanchor,
	executeReanchor,
	MAINNET_BETA_GENESIS_HASH,
	parseReanchorRunArgs,
	parseSavedPlan,
	ReanchorPlanError,
	ReanchorRunUsageError,
	SEND_FEE_LAMPORTS,
	TESTNET_GENESIS_HASH,
	type ReanchorDeps,
	type ReanchorOptions,
	type ReanchorResult,
} from "./reanchor.ts";
import type { EventInput } from "./types.ts";

/** A reset devnet's new genesis hash: valid base58, none of the three public clusters'. */
const GENESIS = "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC";
const PUBKEY = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const KEYPAIR = "/etc/substrate/anchor-keypair.json";
const CLI = "/opt/solana/bin/solana";
const KEYGEN = "/opt/solana/bin/solana-keygen";
const RPC_URL = "https://api.devnet.solana.com";
const SURFACE = "omp";
const H1 = Date.UTC(2026, 9, 20, 10);
const H2 = H1 + HOUR_MS;
const NOW = H2 + 5 * HOUR_MS;

const rootFor = (n: number): string => new Bun.CryptoHasher("sha256").update(`p59-reanchor-root:${n}`).digest("hex");
const oldSig = (n: number): string => `${(n % 9) + 1}${"b".repeat(87)}`;
const newSig = (n: number): string => `${((50 + n) % 9) + 1}${"c".repeat(87)}`;
const countFor = (n: number): number => 3 + n;

interface Planned {
	hourMs: number;
	n: number;
}

function hourEntry({ hourMs, n }: Planned): Record<string, unknown> {
	const root = rootFor(n);
	return {
		period_start: hourIso(hourMs),
		period_start_ms: hourMs,
		why: "signature missing after a suspected devnet reset",
		memo: formatMemo({ periodStartMs: hourMs, rootHex: root, count: countFor(n) }),
		root,
		event_count: countFor(n),
		previous_tx_sig: oldSig(n),
		previous_signer: PUBKEY,
		target_genesis: GENESIS,
	};
}

/** The text `reanchor-plan-run.ts --json` prints, reduced to the fields the executor reads plus the ones it must ignore. */
function planText(hours: readonly Planned[], over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schema: 1,
		dry_run: true,
		generated_at: "2026-10-20T15:00:00.000Z",
		window: { since: hourIso(H1), until: hourIso(H2 + HOUR_MS), hours: 2, max_hours: 168 },
		chain: { expected_genesis: DEVNET_GENESIS_HASH, observed_genesis: GENESIS, genesis_matches: false, signature_lookups: hours.length, rows_not_looked_up: 0 },
		summary: { rows_examined: hours.length, to_reanchor: hours.length, skipped_by_code: {}, needs_attention: 0 },
		plan: { dry_run: true, generated_at_ms: NOW, hours: hours.map(hourEntry), skipped: [], notes: [] },
		...over,
	});
}

const ONE: readonly Planned[] = [{ hourMs: H1, n: 1 }];
const TWO: readonly Planned[] = [
	{ hourMs: H1, n: 1 },
	{ hourMs: H2, n: 2 },
];

function options(over: Partial<ReanchorOptions> = {}): ReanchorOptions {
	return { planPath: "plan.json", execute: true, confirmGenesis: GENESIS, maxHours: 1, surface: SURFACE, ...over };
}

const TX_TEMPLATE: TransactionMemo = { memo: null, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 7, blockTime: 1_700_000_000 };

/** A fake ledger, devnet, runner and substrate that record every call. */
class World {
	rows = new Map<number, AnchorRow>();
	/** What the substrate recomputes per hour; defaults to the stored row's own root and count. */
	digestOverride = new Map<number, { root: string | null; count: number; memo: string | null }>();
	genesis: string | Error = GENESIS;
	balance = 10_000_000;
	keygenOut = PUBKEY;
	/** Transactions the cluster knows, by signature. The planned old signatures are NOT here: a reset wiped them. */
	chain = new Map<string, TransactionMemo>();
	listing: AddressMemo[] = [];
	listingFails = false;
	sendCode = 0;
	readBackMemo: string | null | undefined = undefined;
	emitStored = true;

	runnerCalls: string[][] = [];
	rpcCalls: string[] = [];
	ledgerCalls: number[] = [];
	digestCalls: Array<[number, number]> = [];
	emitted: EventInput[] = [];
	private sends = 0;

	constructor(planned: readonly Planned[] = TWO) {
		for (const { hourMs, n } of planned) {
			const root = rootFor(n);
			this.rows.set(hourMs, {
				period_start: hourIso(hourMs),
				period_end: hourIso(hourMs + HOUR_MS),
				root,
				event_count: countFor(n),
				memo: formatMemo({ periodStartMs: hourMs, rootHex: root, count: countFor(n) }),
				tx_sig: oldSig(n),
				signer: PUBKEY,
				cluster: "devnet",
				slot: 1000 + n,
				anchored_at: hourIso(hourMs + 30 * 60_000),
				stale_hashes: null,
			});
		}
	}

	get sendCalls(): string[][] {
		return this.runnerCalls.filter((argv) => argv[1] === "transfer");
	}

	/** Only `anchorForPeriod` exists: the executor cannot write the `anchors` table through this object. */
	readonly ledger = {
		anchorForPeriod: async (ms: number): Promise<AnchorRow | null> => {
			this.ledgerCalls.push(ms);
			return this.rows.get(ms) ?? null;
		},
	};

	readonly rpc: Rpc = {
		transactionMemo: async (signature, commitment) => {
			this.rpcCalls.push(`tx:${signature.slice(0, 2)}:${commitment}`);
			return this.chain.get(signature) ?? null;
		},
		addressMemos: async (pubkey) => {
			this.rpcCalls.push(`list:${pubkey.slice(0, 4)}`);
			if (this.listingFails) throw new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");
			return this.listing;
		},
		getGenesisHash: async () => {
			this.rpcCalls.push("genesis");
			if (this.genesis instanceof Error) throw this.genesis;
			return this.genesis;
		},
		balance: async () => {
			this.rpcCalls.push("balance");
			return this.balance;
		},
	};

	readonly runner = async (argv: readonly string[]): Promise<RunResult> => {
		this.runnerCalls.push([...argv]);
		if (argv[1] === "pubkey") return { code: 0, stdout: `${this.keygenOut}\n`, stderr: "" };
		if (argv[1] !== "transfer") throw new TypeError(`the fake runner answers only pubkey and transfer, got ${String(argv[1])}`);
		if (this.sendCode !== 0) return { code: this.sendCode, stdout: "", stderr: "Error: RPC response error -32002 at https://rpc.example.invalid/v1/key-4411" };
		const signature = newSig(++this.sends);
		const memo = argv[5] as string;
		this.chain.set(signature, { ...TX_TEMPLATE, memo: this.readBackMemo === undefined ? memo : this.readBackMemo });
		this.listing.unshift({ signature, memo, err: null, slot: 7 });
		return { code: 0, stdout: JSON.stringify({ signature }), stderr: "" };
	};

	readonly substrate = {
		hourDigest: async (ms: number, now: number) => {
			this.digestCalls.push([ms, now]);
			const over = this.digestOverride.get(ms);
			const row = this.rows.get(ms) as AnchorRow;
			const root = over !== undefined ? over.root : row.root;
			const count = over !== undefined ? over.count : row.event_count;
			const memo = over !== undefined ? over.memo : root === null ? null : formatMemo({ periodStartMs: ms, rootHex: root, count });
			return { period_start: hourIso(ms), period_end: hourIso(ms + HOUR_MS), event_count: count, root, memo, event_ids: [] };
		},
		emit: async (input: EventInput) => {
			this.emitted.push(input);
			return this.emitStored ? { stored: true } : { stored: false, error: "greptime refused https://10.0.0.9:4000" };
		},
	};

	deps(over: Partial<ReanchorDeps> = {}): ReanchorDeps {
		return {
			ledger: this.ledger,
			rpc: this.rpc,
			runner: this.runner,
			substrate: this.substrate as unknown as ReanchorDeps["substrate"],
			env: { rpcUrl: RPC_URL, keypairPath: KEYPAIR, pubkey: PUBKEY, cli: CLI },
			surface: SURFACE,
			operatorSurfaces: new Set([SURFACE]),
			clock: () => NOW,
			...over,
		};
	}

	/** One whole call: the parsed plan, the options and the deps. */
	run(planned: readonly Planned[] = TWO, opts: Partial<ReanchorOptions> = {}, deps: Partial<ReanchorDeps> = {}): Promise<ReanchorResult> {
		return executeReanchor(parseSavedPlan(planText(planned)), options(opts), this.deps(deps));
	}

	/** Nothing mutating happened: no send, no note, and the ledger was never asked to write (it cannot be). */
	expectUntouched(): void {
		expect(this.sendCalls).toEqual([]);
		expect(this.emitted).toEqual([]);
	}
}

describe("the saved plan", () => {
	test("the report reanchor-plan-run prints parses: hours ascending, unknown report fields ignored", () => {
		const plan = parseSavedPlan(planText([...TWO].reverse()));
		expect(plan.observed_genesis).toBe(GENESIS);
		expect(plan.hours.map((hour) => hour.period_start)).toEqual([hourIso(H1), hourIso(H2)]);
		expect(plan.hours[0]).toMatchObject({ period_start_ms: H1, root: rootFor(1), event_count: countFor(1), previous_tx_sig: oldSig(1), target_genesis: GENESIS });
	});

	test("a plan with no hour is valid and means nothing to do", () => {
		expect(parseSavedPlan(planText([])).hours).toEqual([]);
	});

	test.each([
		["not JSON", "{nope", "not JSON"],
		["a JSON array", "[]", "not a JSON object"],
		["another schema", planText(ONE, { schema: 2 }), "not schema 1"],
		["not a dry-run plan", planText(ONE, { dry_run: false }), "dry_run is not true"],
		["no observed genesis", planText(ONE, { chain: { observed_genesis: null } }), "no observed genesis"],
		["a malformed observed genesis", planText(ONE, { chain: { observed_genesis: "not base58 0OIl" } }), "no observed genesis"],
		["no hours list", planText(ONE, { plan: { dry_run: true } }), "no plan.hours"],
	])("%s is refused", (_name, text, message) => {
		expect(() => parseSavedPlan(text)).toThrow(ReanchorPlanError);
		expect(() => parseSavedPlan(text)).toThrow(message);
	});

	test("an hour that is not self-consistent is refused, never repaired", () => {
		const good = hourEntry(ONE[0] as Planned);
		const bad = (change: Record<string, unknown>): string => planText(ONE, { plan: { dry_run: true, hours: [{ ...good, ...change }] } });
		expect(() => parseSavedPlan(bad({ memo: "substrate:v1:nope" }))).toThrow("memo is not the v1 memo");
		expect(() => parseSavedPlan(bad({ root: "A".repeat(64) }))).toThrow("root is not 64 lowercase hex");
		expect(() => parseSavedPlan(bad({ event_count: 0 }))).toThrow("event_count");
		expect(() => parseSavedPlan(bad({ period_start_ms: H1 + 1 }))).toThrow("whole UTC hour");
		expect(() => parseSavedPlan(bad({ period_start: hourIso(H2) }))).toThrow("does not name the hour");
		expect(() => parseSavedPlan(bad({ previous_tx_sig: "short" }))).toThrow("previous_tx_sig");
		expect(() => parseSavedPlan(bad({ target_genesis: DEVNET_GENESIS_HASH }))).toThrow("names one cluster");
	});

	test("the same hour twice is refused", () => {
		const entry = hourEntry(ONE[0] as Planned);
		expect(() => parseSavedPlan(planText(ONE, { plan: { dry_run: true, hours: [entry, entry] } }))).toThrow("twice");
	});
});

describe("argument grammar", () => {
	test("--plan alone is the dry run; --execute is never implied by the other flags", () => {
		expect(parseReanchorRunArgs(["--plan", "p.json"])).toEqual({ planPath: "p.json", execute: false, confirmGenesis: null, maxHours: 1, surface: null });
		expect(parseReanchorRunArgs(["--plan", "p.json", "--confirm-genesis", GENESIS, "--max-hours", "3"]).execute).toBe(false);
		expect(parseReanchorRunArgs(["--plan", "p.json", "--execute", "--confirm-genesis", GENESIS, "--max-hours", "3", "--surface", "omp"])).toEqual({
			planPath: "p.json",
			execute: true,
			confirmGenesis: GENESIS,
			maxHours: 3,
			surface: "omp",
		});
	});

	test("--max-hours is 1 to the anchor job's own cap, never above", () => {
		expect(parseReanchorRunArgs(["--plan", "p", "--max-hours", String(MAX_HOURS_PER_RUN)]).maxHours).toBe(MAX_HOURS_PER_RUN);
		for (const bad of ["0", String(MAX_HOURS_PER_RUN + 1), "-1", "1.5", "x", "01", "100"]) {
			expect(() => parseReanchorRunArgs(["--plan", "p", "--max-hours", bad])).toThrow(ReanchorRunUsageError);
		}
	});

	test("strict: --plan is required, each flag once, a value flag takes the next argument, nothing positional", () => {
		const refused: string[][] = [
			[],
			["--execute"],
			["--plan"],
			["--plan", "--execute"],
			["--plan", "a", "--plan", "b"],
			["--plan", "a", "--execute", "--execute"],
			["--plan=a"],
			["--plan", "a", "stray"],
			["--plan", "a", "--bogus"],
			["--plan", "a", "--confirm-genesis", "not base58 0OIl"],
			["--plan", "a", "--confirm-genesis", "short"],
			["--plan", "a", "--surface", "Bad Surface"],
		];
		for (const argv of refused) expect(() => parseReanchorRunArgs(argv)).toThrow(ReanchorRunUsageError);
	});
});

describe("the default is a dry run that calls nothing", () => {
	test("dryRunReanchor prints `would re-anchor <hour>` per hour, takes no port, and sends nothing", () => {
		const plan = parseSavedPlan(planText(TWO));
		const result = dryRunReanchor(plan, options({ execute: false }));
		expect(result).toMatchObject({ code: 0, stderr: "", sent: 0, adopted: 0, refused: null });
		expect(result.stdout).toContain(`would re-anchor ${hourIso(H1)} (${countFor(1)} events)`);
		expect(result.stdout).toContain(`would re-anchor ${hourIso(H2)} (${countFor(2)} events)`);
		expect(result.stdout).toContain("nothing was read, signed or sent");
		expect(result.stdout).toContain("--execute --confirm-genesis");
	});

	test("a plan longer than --max-hours says how many an execute would send per run", () => {
		const result = dryRunReanchor(parseSavedPlan(planText(TWO)), options({ execute: false, maxHours: 1 }));
		expect(result.stdout).toContain("at most 1 transaction(s) per run");
	});

	test("executeReanchor without execute:true is the dry run too: a world records zero runner, rpc, ledger and emit calls", async () => {
		const w = new World();
		const result = await w.run(TWO, { execute: false, confirmGenesis: GENESIS });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("would re-anchor");
		expect(w.runnerCalls).toEqual([]);
		expect(w.rpcCalls).toEqual([]);
		expect(w.ledgerCalls).toEqual([]);
		expect(w.digestCalls).toEqual([]);
		expect(w.emitted).toEqual([]);
	});
});

describe("every gate refuses before the first send", () => {
	test("--execute without --confirm-genesis is refused before any read", async () => {
		const w = new World();
		const result = await w.run(TWO, { confirmGenesis: null });
		expect(result).toMatchObject({ code: 1, refused: "genesis-unconfirmed", sent: 0 });
		expect(result.stderr).toContain("[reanchor] REFUSED genesis-unconfirmed");
		expect(w.runnerCalls).toEqual([]);
		expect(w.rpcCalls).toEqual([]);
		w.expectUntouched();
	});

	test("a refused endpoint URL is refused before any request, without quoting the URL", async () => {
		const w = new World();
		const result = await w.run(TWO, {}, { env: { rpcUrl: "https://api.mainnet-beta.solana.com", keypairPath: KEYPAIR, pubkey: PUBKEY, cli: CLI } });
		expect(result).toMatchObject({ code: 1, refused: "rpc-url-refused" });
		expect(result.stderr).not.toContain("mainnet-beta.solana.com");
		expect(w.rpcCalls).toEqual([]);
		expect(w.runnerCalls).toEqual([]);
	});

	test("the live genesis differing from --confirm-genesis is refused, and no runner is called", async () => {
		const w = new World();
		const result = await w.run(TWO, { confirmGenesis: DEVNET_GENESIS_HASH });
		expect(result).toMatchObject({ code: 1, refused: "genesis-mismatch" });
		expect(result.stderr).toContain(GENESIS);
		expect(w.rpcCalls).toEqual(["genesis"]);
		expect(w.runnerCalls).toEqual([]);
		w.expectUntouched();
	});

	test("a confirmed live genesis that is not the one the plan observed is refused: re-run the plan", async () => {
		const w = new World();
		w.genesis = DEVNET_GENESIS_HASH;
		const result = await w.run(TWO, { confirmGenesis: DEVNET_GENESIS_HASH });
		expect(result).toMatchObject({ code: 1, refused: "genesis-mismatch" });
		expect(result.stderr).toContain("re-run the plan");
		expect(w.runnerCalls).toEqual([]);
	});

	test.each([
		["mainnet-beta", MAINNET_BETA_GENESIS_HASH],
		["testnet", TESTNET_GENESIS_HASH],
	])("the %s genesis is refused even when the operator confirms it and the plan says so", async (name, hash) => {
		const w = new World();
		w.genesis = hash;
		const plan = parseSavedPlan(planText(ONE, { chain: { observed_genesis: hash } }).replaceAll(GENESIS, hash));
		const result = await executeReanchor(plan, options({ confirmGenesis: hash }), w.deps());
		expect(result).toMatchObject({ code: 1, refused: "wrong-cluster", sent: 0 });
		expect(result.stderr).toContain(name);
		expect(w.runnerCalls).toEqual([]);
		w.expectUntouched();
	});

	test("the three public genesis constants are the ones the Anza documentation names, and devnet's is the repo's", () => {
		expect(MAINNET_BETA_GENESIS_HASH).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
		expect(TESTNET_GENESIS_HASH).toBe("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY");
		expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
		expect(new Set([MAINNET_BETA_GENESIS_HASH, TESTNET_GENESIS_HASH, DEVNET_GENESIS_HASH, GENESIS]).size).toBe(4);
	});

	test("an unreadable genesis is refused as rpc-unreadable with the URL removed from the reason", async () => {
		const w = new World();
		w.genesis = new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");
		const result = await w.run();
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable" });
		expect(w.runnerCalls).toEqual([]);
	});

	test("a signer that is not the configured anchor key is refused before the balance is read, and nothing is sent", async () => {
		const w = new World();
		w.keygenOut = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
		const result = await w.run();
		expect(result).toMatchObject({ code: 1, refused: "signer-mismatch" });
		expect(w.rpcCalls).toEqual(["genesis"]);
		expect(w.runnerCalls).toEqual([[KEYGEN, "pubkey", KEYPAIR]]);
		w.expectUntouched();
	});

	test("a keypair path that is not absolute is refused without running the CLI", async () => {
		const w = new World();
		const result = await w.run(TWO, {}, { env: { rpcUrl: RPC_URL, keypairPath: "relative/key.json", pubkey: PUBKEY, cli: CLI } });
		expect(result).toMatchObject({ code: 1, refused: "signer-mismatch" });
		expect(w.runnerCalls).toEqual([]);
	});

	test("an unfunded key is refused: only the pubkey check ran, no transfer", async () => {
		const w = new World();
		w.balance = REQUIRED_BALANCE_LAMPORTS - 1;
		const result = await w.run();
		expect(result).toMatchObject({ code: 1, refused: "unfunded", sent: 0 });
		expect(w.runnerCalls).toEqual([[KEYGEN, "pubkey", KEYPAIR]]);
		expect(w.ledgerCalls).toEqual([]);
		w.expectUntouched();
	});

	test("the balance must cover the fees of every send the run may make, not only the first", async () => {
		const w = new World();
		w.balance = REQUIRED_BALANCE_LAMPORTS;
		expect(await w.run(TWO, { maxHours: 2 })).toMatchObject({ code: 1, refused: "unfunded" });
		w.balance = REQUIRED_BALANCE_LAMPORTS + SEND_FEE_LAMPORTS;
		expect((await w.run(TWO, { maxHours: 2 })).refused).toBeNull();
	});

	test("no operator surface to record the note as is refused before the send, whatever else holds", async () => {
		for (const [surface, operators] of [
			[null, new Set(["omp"])],
			["omp", new Set<string>()],
			["claude-code", new Set(["omp"])],
		] as const) {
			const w = new World();
			const result = await w.run(TWO, {}, { surface, operatorSurfaces: operators });
			expect(result).toMatchObject({ code: 1, refused: "no-operator-surface", sent: 0 });
			expect(result.stderr).toContain("--surface");
			w.expectUntouched();
		}
	});

	test("a stored row that disagrees with the plan is refused as root-mismatch: nothing is sent", async () => {
		for (const change of [{ root: rootFor(9) }, { event_count: 99 }, { tx_sig: oldSig(9) }, { memo: formatMemo({ periodStartMs: H1, rootHex: rootFor(9), count: 5 }) }]) {
			const w = new World();
			w.rows.set(H1, { ...(w.rows.get(H1) as AnchorRow), ...change });
			const result = await w.run();
			expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0 });
			expect(result.stderr).toContain("differs from the saved plan");
			w.expectUntouched();
		}
	});

	test("a recomputed digest that differs is refused as root-mismatch, even for the second hour, before the first is sent", async () => {
		const w = new World();
		w.digestOverride.set(H2, { root: rootFor(9), count: countFor(2), memo: formatMemo({ periodStartMs: H2, rootHex: rootFor(9), count: countFor(2) }) });
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0 });
		expect(result.stderr).toContain(hourIso(H2));
		w.expectUntouched();
	});

	test("a recomputed count, an empty hour and a memo that is not byte for byte the stored one are each root-mismatch", async () => {
		const memoOther = formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) });
		const cases = [
			{ root: rootFor(1), count: countFor(1) + 1, memo: formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) + 1 }) },
			{ root: null, count: 0, memo: null },
			{ root: rootFor(1), count: countFor(1), memo: `${memoOther} ` },
		];
		for (const over of cases) {
			const w = new World(ONE);
			w.digestOverride.set(H1, over);
			const result = await w.run(ONE);
			expect(result).toMatchObject({ code: 1, refused: "root-mismatch" });
			w.expectUntouched();
		}
	});

	test("a missing stored row, an unreadable store and an unrecomputable hour are refused by their own names", async () => {
		const missing = new World();
		missing.rows.delete(H1);
		expect(await missing.run(ONE)).toMatchObject({ code: 1, refused: "row-missing" });

		const down = new World();
		down.ledger.anchorForPeriod = async () => {
			throw new Error("greptime unreachable at http://10.0.0.9:4000");
		};
		const downResult = await down.run(ONE);
		expect(downResult).toMatchObject({ code: 1, refused: "store-failed" });
		expect(downResult.stderr).not.toContain("10.0.0.9");

		const broken = new World();
		broken.substrate.hourDigest = async () => {
			throw new Error("hour member evt_x has no row");
		};
		expect(await broken.run(ONE)).toMatchObject({ code: 1, refused: "digest-failed" });
		for (const w of [missing, down, broken]) w.expectUntouched();
	});

	test("a stored signature that still exists on the cluster is not a reset for that hour: refused, nothing sent", async () => {
		const w = new World();
		w.chain.set(oldSig(1), { ...TX_TEMPLATE, memo: formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) }) });
		const result = await w.run();
		expect(result).toMatchObject({ code: 1, refused: "present-on-cluster", sent: 0 });
		w.expectUntouched();
	});

	test("an unreadable listing of the signer's signatures stops the run: an earlier send cannot be ruled out", async () => {
		const w = new World();
		w.listingFails = true;
		const result = await w.run();
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable" });
		expect(result.stderr).not.toContain("rpc.example.invalid");
		w.expectUntouched();
	});
});

describe("adopt before send", () => {
	const memoOf = (hourMs: number, n: number): string => formatMemo({ periodStartMs: hourMs, rootHex: rootFor(n), count: countFor(n) });

	test("a memo for the hour already on the new cluster is adopted: no transfer, one note naming the adopted signature", async () => {
		const w = new World(ONE);
		const adopted = newSig(7);
		w.listing = [{ signature: adopted, memo: memoOf(H1, 1), err: null, slot: 5 }];
		w.chain.set(adopted, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${adopted}`);
		expect(w.sendCalls).toEqual([]);
		expect(w.runnerCalls).toEqual([[KEYGEN, "pubkey", KEYPAIR]]);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ action: "anchor.reanchor", new_tx_sig: adopted, previous_tx_sig: oldSig(1) });
		expect(w.emitted[0]?.idempotency_key).toBe(`reanchor:${hourIso(H1)}:${adopted}`);
	});

	test("an adopted hour whose note is already stored is not recorded twice", async () => {
		const w = new World(ONE);
		const adopted = newSig(7);
		w.listing = [{ signature: adopted, memo: memoOf(H1, 1), err: null, slot: 5 }];
		w.chain.set(adopted, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		const asked: Array<[string, string]> = [];
		const result = await w.run(ONE, {}, {
			recorded: async (period, signature) => {
				asked.push([period, signature]);
				return true;
			},
		});
		expect(result).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(asked).toEqual([[hourIso(H1), adopted]]);
		expect(result.stdout).toContain("already recorded");
		w.expectUntouched();
	});

	test("a failing `recorded` lookup records anyway: a duplicate note is harmless, a missing one is not", async () => {
		const w = new World(ONE);
		const adopted = newSig(7);
		w.listing = [{ signature: adopted, memo: memoOf(H1, 1), err: null, slot: 5 }];
		w.chain.set(adopted, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		const result = await w.run(ONE, {}, {
			recorded: async () => {
				throw new Error("ledger down");
			},
		});
		expect(result.code).toBe(0);
		expect(w.emitted).toHaveLength(1);
	});

	test("a memo for the hour with another root on the new cluster is refused, never adopted and never overwritten", async () => {
		const w = new World(ONE);
		const other = newSig(8);
		const memo = formatMemo({ periodStartMs: H1, rootHex: rootFor(9), count: countFor(1) });
		w.listing = [{ signature: other, memo, err: null, slot: 5 }];
		w.chain.set(other, { ...TX_TEMPLATE, memo });
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0, adopted: 0 });
		w.expectUntouched();
	});

	test("a listed memo for the hour whose transaction cannot be read stops the run instead of sending a second one", async () => {
		const w = new World(ONE);
		w.listing = [{ signature: newSig(7), memo: memoOf(H1, 1), err: null, slot: 5 }];
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable" });
		w.expectUntouched();
	});

	test("a listed memo that another key signed, or that failed, or that is for another hour, is not adopted: the hour is sent", async () => {
		const w = new World(ONE);
		const foreign = newSig(7);
		const failed = newSig(8);
		w.listing = [
			{ signature: foreign, memo: memoOf(H1, 1), err: null, slot: 5 },
			{ signature: failed, memo: memoOf(H1, 1), err: null, slot: 5 },
			{ signature: newSig(9), memo: memoOf(H2, 2), err: null, slot: 5 },
			{ signature: newSig(10), memo: null, err: null, slot: 5 },
		];
		w.chain.set(foreign, { ...TX_TEMPLATE, memo: memoOf(H1, 1), payer: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" });
		w.chain.set(failed, { ...TX_TEMPLATE, memo: memoOf(H1, 1), err: { InstructionError: [0, "Custom"] } });
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		expect(w.sendCalls).toHaveLength(1);
	});
});

describe("the one send", () => {
	test("success: exactly one transfer argv of the D-06 shape carrying the stored memo, then one anchor.reanchor note with its idempotency key", async () => {
		const w = new World(ONE);
		const result = await w.run(ONE);
		const memo = formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) });
		const signature = newSig(1);

		expect(result).toMatchObject({ code: 0, refused: null, sent: 1, adopted: 0, stderr: "" });
		expect(result.stdout).toContain(`${hourIso(H1)} re-anchored ${signature}`);
		expect(result.stdout).toContain("done: 1 sent, 0 adopted, 0 left in the plan");
		// The only runner calls: the key check, then the single send.
		expect(w.runnerCalls).toHaveLength(2);
		expect(w.runnerCalls[0]).toEqual([KEYGEN, "pubkey", KEYPAIR]);
		expect(w.sendCalls).toEqual([
			[CLI, "transfer", PUBKEY, "0", "--with-memo", memo, "--url", RPC_URL, "--keypair", KEYPAIR, "--fee-payer", KEYPAIR, "--commitment", "confirmed", "--allow-unfunded-recipient", "--output", "json"],
		]);
		expect(w.emitted).toEqual([
			{
				surface: SURFACE,
				kind: "note",
				summary: expect.stringContaining(`re-anchored ${hourIso(H1)}`),
				session_id: "anchor:2026-10-20T10",
				payload: {
					action: "anchor.reanchor",
					period_start: hourIso(H1),
					root: rootFor(1),
					event_count: countFor(1),
					previous_tx_sig: oldSig(1),
					new_tx_sig: signature,
					genesis: GENESIS,
				},
				idempotency_key: `reanchor:${hourIso(H1)}:${signature}`,
			},
		]);
		// The clock the run was given is the one the digest was recomputed with.
		expect(w.digestCalls).toEqual([[H1, NOW]]);
	});

	test("the note is written as the chosen operator surface and never as the substrate", async () => {
		const w = new World(ONE);
		await w.run(ONE, {}, { surface: "hermes", operatorSurfaces: new Set(["hermes", "omp"]) });
		expect(w.emitted.map((event) => event.surface)).toEqual(["hermes"]);
	});

	test("--max-hours caps the transactions per run: one sent, the rest left in the plan, and a second run adopts the first and sends the next", async () => {
		const w = new World(TWO);
		const first = await w.run(TWO, { maxHours: 1 });
		expect(first).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		expect(first.stdout).toContain("1 left in the plan (run again)");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toHaveLength(1);

		const second = await w.run(TWO, { maxHours: 1 }, { recorded: async (period, signature) => period === hourIso(H1) && signature === newSig(1) });
		expect(second).toMatchObject({ code: 0, sent: 1, adopted: 1 });
		expect(w.sendCalls).toHaveLength(2);
		expect(w.sendCalls[1]?.[5]).toBe(formatMemo({ periodStartMs: H2, rootHex: rootFor(2), count: countFor(2) }));
		// The first hour's note was not repeated; the second hour's was written.
		expect(w.emitted.map((event) => event.payload?.["period_start"])).toEqual([hourIso(H1), hourIso(H2)]);
	});

	test("a plan with two hours and room for both sends both, in ascending order, one transfer each", async () => {
		const w = new World(TWO);
		const result = await w.run([...TWO].reverse(), { maxHours: 2 });
		expect(result).toMatchObject({ code: 0, sent: 2 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([
			formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) }),
			formatMemo({ periodStartMs: H2, rootHex: rootFor(2), count: countFor(2) }),
		]);
	});

	test("a genesis other than the constant is allowed here and the result says verification waits for the constant to move", async () => {
		const w = new World(ONE);
		const result = await w.run(ONE);
		expect(GENESIS).not.toBe(DEVNET_GENESIS_HASH);
		expect(result.stdout).toContain("until DEVNET_GENESIS_HASH moves to it");
	});

	test("an empty plan is done: no read, no runner", async () => {
		const w = new World([]);
		const result = await w.run([]);
		expect(result).toMatchObject({ code: 0, sent: 0 });
		expect(w.rpcCalls).toEqual([]);
		expect(w.runnerCalls).toEqual([]);
	});

	test("a send that exits non-zero is send-failed, redacted, and writes no note", async () => {
		const w = new World(ONE);
		w.sendCode = 1;
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(result.stderr).not.toContain("rpc.example.invalid");
		expect(w.emitted).toEqual([]);
	});

	test("a send whose read-back does not carry the memo is send-failed and the run stops before the next hour", async () => {
		const w = new World(TWO);
		w.readBackMemo = formatMemo({ periodStartMs: H1, rootHex: rootFor(9), count: countFor(1) });
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(result.stderr).toContain("re-run to adopt");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toEqual([]);
	});

	test("a read-back with no memo at all is send-failed", async () => {
		const w = new World(ONE);
		w.readBackMemo = null;
		expect(await w.run(ONE)).toMatchObject({ code: 1, refused: "send-failed" });
	});

	test("a note the ledger did not store is reported with the full payload and is never resent: a re-run adopts the transaction", async () => {
		const w = new World(ONE);
		w.emitStored = false;
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "store-failed", sent: 1 });
		expect(result.stderr).toContain(newSig(1));
		expect(result.stderr).toContain('"action":"anchor.reanchor"');
		expect(result.stderr).toContain("never resent");
		expect(result.stderr).not.toContain("10.0.0.9");

		w.emitStored = true;
		const again = await w.run(ONE);
		expect(again).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(w.sendCalls).toHaveLength(1);
	});

	test("the ledger fake has no write method: the anchors table is never touched by the executor", async () => {
		const w = new World(ONE);
		await w.run(ONE);
		expect(Object.keys(w.ledger)).toEqual(["anchorForPeriod"]);
		expect(w.ledgerCalls.every((ms) => ms === H1)).toBe(true);
	});
});
