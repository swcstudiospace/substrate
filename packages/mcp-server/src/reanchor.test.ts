/**
 * The guarded re-anchor executor (v1.6, phase 59, criterion 5): the saved-plan parser, the argument grammar, the dry-run default,
 * every refusal gate, adopt-before-send and the one successful send.
 *
 * No ledger, no network, no real runner and no clock of its own: the ledger, the chain, the runner and the substrate are fakes
 * that LOG every call, so "nothing was sent" and "exactly one send" are asserted from the logs, not assumed. The fake runner
 * answers only `solana-keygen pubkey` and `solana transfer`; any other argv is a TypeError.
 */
import { describe, expect, test } from "bun:test";
import { type Commitment, formatMemo, formatMemoV2, formatMemoV3, graphHeadsRoot, graphIndexAddress, headsRoot, HOUR_MS, hourIso, parseMemoV3, type AddressMemo, type Rpc, type RunResult, type SignerSet, type TransactionMemo } from "@substrate/ledger";
import type { ReanchorNotes, ReanchorRecord } from "./anchor-verify-deps.ts";
import { buildGraphHeads, DEVNET_GENESIS_HASH, MAX_HOURS_PER_RUN, REQUIRED_BALANCE_LAMPORTS } from "./anchor.ts";
import type { AnchorRow } from "./greptime.ts";
import {
	DISCOVERY_MAX_PAGES,
	DISCOVERY_PAGE_SIZE,
	dryRunReanchor,
	executeReanchor,
	MAINNET_BETA_GENESIS_HASH,
	parseReanchorRunArgs,
	parseSavedPlan,
	ReanchorPlanError,
	ReanchorRunUsageError,
	repairIdempotencyKey,
	SEND_FEE_LAMPORTS,
	TESTNET_GENESIS_HASH,
	type LockAttempt,
	type ReanchorDeps,
	type ReanchorLock,
	type ReanchorOptions,
	type ReanchorResult,
} from "./reanchor.ts";
import { buildReanchorEvent, parseReanchorPayload } from "./reanchor-plan.ts";
import { runReanchorPlan } from "./reanchor-plan-run.ts";
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
	memo?: string;
}

function hourEntry({ hourMs, n, memo }: Planned): Record<string, unknown> {
	const root = rootFor(n);
	return {
		period_start: hourIso(hourMs),
		period_start_ms: hourMs,
		why: "signature missing after a suspected devnet reset",
		memo: memo ?? formatMemo({ periodStartMs: hourMs, rootHex: root, count: countFor(n) }),
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
	digestOverride = new Map<number, { root: string | null; count: number; memo: string | null; eventIds?: string[] }>();
	genesis: string | Error = GENESIS;
	balance = 10_000_000;
	keygenOut = PUBKEY;
	/** Transactions the cluster knows, by signature. The planned old signatures are NOT here: a reset wiped them. */
	chain = new Map<string, TransactionMemo>();
	listing: AddressMemo[] = [];
	/** The listing of one address, when a test gives an address its own history; every other address answers `listing`. */
	listingBy = new Map<string, AddressMemo[]>();
	/** Every address a discovery call asked for, in order. */
	listAddresses: string[] = [];
	/** The signer set `deps.signers` answers (the configured key alone, valid for all time), its gap, whether it fails, and how often it was read. */
	signerSet: SignerSet = [{ pubkey: PUBKEY, valid_from_ms: 0, valid_until_ms: null }];
	signerGap: string | null = null;
	signersFail = false;
	signerCalls = 0;
	listingFails = false;
	sendCode = 0;
	/** The send is killed at the runner's timeout: no exit code, no output, and the transaction may still land. */
	sendTimesOut = false;
	readBackMemo: string | null | undefined = undefined;
	/** The exit code of a pointer send (a v3 memo); 0 unless a test makes the pointer send fail. */
	pointerSendCode = 0;
	emitStored = true;
	/** The recorded notes the ledger would answer, per hour; `emit` adds the notes the executor writes. */
	noteRecords = new Map<number, ReanchorRecord[]>();
	notesCalls: string[] = [];
	notesFail = false;
	/** The `incomplete` reason `readReanchorNotes` would report, per hour; absent means a complete read. */
	notesIncomplete = new Map<number, string>();
	/** The `before` cursor of each listing call, and a listing of filler signatures that never reaches the horizon. */
	listBefore: Array<string | undefined> = [];
	endlessListing = false;
	/** The commitment of each listing call, and a cluster whose sends are confirmed but not yet finalized (a finalized listing misses them). */
	listCommitments: Array<Commitment | undefined> = [];
	unfinalizedSends = false;
	/** When set, the send waits on it, so a run stays in flight while a second one starts. */
	sendGate: Promise<void> | null = null;
	/** Resolved when a send reaches the gate: the signal that the run is in flight, so a test never waits on a clock. */
	readonly sendReached = Promise.withResolvers<void>();
	lockHeldBy: string | null = null;
	lockReleases = 0;

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

	/** The member rows `eventsByIds` answers with; empty by default, so an hour with no member rows gives no heads. */
	eventRows: (ids: readonly string[]) => Array<Record<string, unknown>> = () => [];
	/** Each graph's index address and the pointer listing it answers with, newest first (`addressSignaturePage`). */
	pointerListings = new Map<string, AddressMemo[]>();
	/** The index addresses listed, in call order. */
	pointerListAddresses: string[] = [];
	/** Only the two reads exist: the executor cannot write the `anchors` table through this object. */
	readonly ledger = {
		anchorForPeriod: async (ms: number): Promise<AnchorRow | null> => {
			this.ledgerCalls.push(ms);
			return this.rows.get(ms) ?? null;
		},
		eventsByIds: async (ids: ReadonlyArray<string | { id: string }>) => this.eventRows(ids.map((id) => (typeof id === "string" ? id : id.id))),
	};

	readonly rpc: Rpc = {
		transactionMemo: async (signature, commitment) => {
			this.rpcCalls.push(`tx:${signature.slice(0, 2)}:${commitment}`);
			return this.chain.get(signature) ?? null;
		},
		addressMemos: async (pubkey, limit, before, commitment) => {
			this.rpcCalls.push(`list:${pubkey.slice(0, 4)}`);
			this.listAddresses.push(pubkey);
			this.listBefore.push(before);
			this.listCommitments.push(commitment);
			if (this.unfinalizedSends && commitment !== "confirmed") return [];
			if (this.listingFails) throw new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");
			if (this.endlessListing) {
				const page = this.listBefore.length;
				return Array.from({ length: limit }, (_, i) => ({ signature: `filler-${page}-${i}`, memo: null, err: null, slot: 1 }));
			}
			const source = this.listingBy.get(pubkey) ?? this.listing;
			const start = before === undefined ? 0 : source.findIndex((hint) => hint.signature === before) + 1;
			return source.slice(start, start + limit);
		},
		addressSignaturePage: async (address, { limit, before }) => {
			this.rpcCalls.push(`pointers:${address.slice(0, 4)}`);
			this.pointerListAddresses.push(address);
			const source = this.pointerListings.get(address) ?? [];
			const start = before === undefined ? 0 : source.findIndex((hint) => hint.signature === before) + 1;
			return source.slice(start, start + limit);
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
		if (this.sendTimesOut) return { code: null, stdout: "", stderr: "" };
		if (this.sendCode !== 0) return { code: this.sendCode, stdout: "", stderr: "Error: RPC response error -32002 at https://rpc.example.invalid/v1/key-4411" };
		if (this.pointerSendCode !== 0 && parseMemoV3(argv[5] as string) !== null) return { code: this.pointerSendCode, stdout: "", stderr: "Error: pointer refused" };
		if (this.sendGate !== null) {
			this.sendReached.resolve();
			await this.sendGate;
		}
		const signature = newSig(++this.sends);
		const memo = argv[5] as string;
		this.chain.set(signature, { ...TX_TEMPLATE, blockTime: NOW / 1000, memo: this.readBackMemo === undefined || parseMemoV3(memo) !== null ? memo : this.readBackMemo });
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
		return { period_start: hourIso(ms), period_end: hourIso(ms + HOUR_MS), event_count: count, root, memo, event_ids: over?.eventIds ?? [] };
		},
		emit: async (input: EventInput) => {
			this.emitted.push(input);
			if (!this.emitStored) return { stored: false, error: "greptime refused https://10.0.0.9:4000" };
			// The ledger now holds the note: a later run reads it back.
			const payload = parseReanchorPayload(input.payload);
			const hourMs = Date.parse(payload.period_start);
			const record: ReanchorRecord = { event_id: `evt_note_${this.emitted.length}`, ts: hourIso(NOW), surface: SURFACE, payload };
			this.noteRecords.set(hourMs, [record, ...(this.noteRecords.get(hourMs) ?? [])]);
			return { stored: true };
		},
	};

	/** One run at a time: a second acquire while held is refused, as `fileLock` does. */
	readonly lock: ReanchorLock = {
		acquire: (): LockAttempt => {
			if (this.lockHeldBy !== null) return { held: this.lockHeldBy };
			this.lockHeldBy = "pid 1";
			return {
				release: () => {
					this.lockReleases += 1;
					this.lockHeldBy = null;
				},
			};
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
			notes: async (hour): Promise<ReanchorNotes> => {
				this.notesCalls.push(hour.period_start);
				if (this.notesFail) throw new Error("ledger down");
				return { records: this.noteRecords.get(hour.period_start_ms) ?? [], incomplete: this.notesIncomplete.get(hour.period_start_ms) ?? null };
			},
			signers: async () => {
				this.signerCalls += 1;
				if (this.signersFail) throw new Error("ledger down at https://10.0.0.9:4000");
				return { set: this.signerSet, gap: this.signerGap };
			},
			lock: this.lock,
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

	test("a plan with no hour and no observed genesis (the planner reads no chain for an empty window) is valid", () => {
		expect(parseSavedPlan(planText([], { chain: { observed_genesis: null } }))).toEqual({ observed_genesis: null, hours: [] });
	});

	test("the report the real planner prints for a window with no anchors row round-trips, and executing it reads and sends nothing", async () => {
		const planned = await runReanchorPlan(["--json"], {
			now: () => NOW,
			open: async () => ({
				ledger: { anchorsBetween: async () => [], hourChainLeaves: async () => [] },
				rpc: {
					addressSignaturePage: async () => [],
					getGenesisHash: async () => {
						throw new Error("an empty window reads no chain");
					},
					transactionMemo: async () => {
						throw new Error("an empty window reads no chain");
					},
				},
				expectedGenesis: DEVNET_GENESIS_HASH,
			}),
		});
		expect(planned.code).toBe(0);
		expect(JSON.parse(planned.stdout).chain.observed_genesis).toBeNull();

		const plan = parseSavedPlan(planned.stdout);
		expect(plan).toEqual({ observed_genesis: null, hours: [] });
		const w = new World([]);
		const result = await executeReanchor(plan, options(), w.deps());
		expect(result).toMatchObject({ code: 0, refused: null, sent: 0 });
		expect(result.stdout).toContain("the plan has no hour to re-anchor");
		expect(w.rpcCalls).toEqual([]);
		expect(w.runnerCalls).toEqual([]);
		expect(w.lockHeldBy).toBeNull();
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
		expect(() => parseSavedPlan(bad({ memo: "substrate:v1:nope" }))).toThrow("memo is not a v1 or v2 memo");
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

	test("a plan whose hour carries a v2 memo parses, and keeps the memo", () => {
		const entry = hourEntry(ONE[0] as Planned);
		const memo = formatMemoV2({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1), headsRootHex: rootFor(5) });
		const plan = parseSavedPlan(planText(ONE, { plan: { dry_run: true, hours: [{ ...entry, memo }] } }));
		expect(plan.hours.map((hour) => hour.memo)).toEqual([memo]);
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

	test("an adopted hour whose note is already stored is done by that note: nothing is listed, sent or recorded twice", async () => {
		const w = new World(ONE);
		const adopted = newSig(7);
		w.chain.set(adopted, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.noteRecords.set(H1, [noteRecord(1, H1, adopted)]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(w.notesCalls).toEqual([hourIso(H1)]);
		expect(result.stdout).toContain("already recorded");
		expect(w.listBefore).toEqual([]);
		w.expectUntouched();
	});

	test("a notes read that fails refuses notes-incomplete before any listing, send or note: the pointer the verifier follows is unknown", async () => {
		const w = new World(ONE);
		const adopted = newSig(7);
		w.listing = [{ signature: adopted, memo: memoOf(H1, 1), err: null, slot: 5 }];
		w.chain.set(adopted, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.notesFail = true;
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "notes-incomplete", sent: 0, adopted: 0 });
		expect(result.stderr).toContain("could not be read");
		expect(result.stderr).toContain("pointer the verifier follows is unknown");
		expect(w.listBefore).toEqual([]);
		w.expectUntouched();
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

		const second = await w.run(TWO, { maxHours: 1 });
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

	test("a send killed at its timeout (no exit code) is send-failed and says the transaction may still land and to wait; a re-run after it landed adopts it and sends nothing", async () => {
		const w = new World(ONE);
		w.sendTimesOut = true;
		const first = await w.run(ONE);
		expect(first).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(first.stderr).toContain("MAY STILL LAND");
		expect(first.stderr).toContain("wait at least 2 minutes");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toEqual([]);

		// The broadcast transaction lands afterwards and is listed at `confirmed`: the next run adopts it instead of sending the hour twice.
		const landed = newSig(7);
		w.chain.set(landed, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.listing = [{ signature: landed, memo: memoOf(H1, 1), err: null, slot: 7 }];
		w.sendTimesOut = false;
		const second = await w.run(ONE);
		expect(second).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toHaveLength(1);
	});

	test("a send whose read-back does not carry the memo is send-failed and the run stops before the next hour", async () => {
		const w = new World(TWO);
		w.readBackMemo = formatMemo({ periodStartMs: H1, rootHex: rootFor(9), count: countFor(1) });
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(result.stderr).toContain("re-run to adopt");
		expect(result.stderr).toContain(newSig(1));
		expect(result.stderr).toContain("MAY STILL LAND");
		expect(result.stderr).toContain("wait at least 2 minutes");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toEqual([]);
	});

	test("a read-back with no memo at all is send-failed and says to wait before re-running", async () => {
		const w = new World(ONE);
		w.readBackMemo = null;
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "send-failed" });
		expect(result.stderr).toContain("wait at least 2 minutes");
	});

	test("a read-back that finds no transaction yet (RPC lag at confirmed) is send-failed, names the signature and says to wait before re-running", async () => {
		const w = new World(ONE);
		const read = w.rpc.transactionMemo.bind(w.rpc);
		w.rpc.transactionMemo = async (signature, commitment) => (signature === newSig(1) ? null : read(signature, commitment));
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(result.stderr).toContain(newSig(1));
		expect(result.stderr).toContain("re-run to adopt it if it landed");
		expect(result.stderr).toContain("MAY STILL LAND");
		expect(result.stderr).toContain("wait at least 2 minutes");
		expect(w.emitted).toEqual([]);
	});

	test("a read-back that throws is send-failed, names the signature and says to wait before re-running", async () => {
		const w = new World(ONE);
		const read = w.rpc.transactionMemo.bind(w.rpc);
		w.rpc.transactionMemo = async (signature, commitment) => {
			if (signature === newSig(1)) throw new Error("rpc timeout");
			return read(signature, commitment);
		};
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(result.stderr).toContain(newSig(1));
		expect(result.stderr).toContain("its read-back failed");
		expect(result.stderr).toContain("MAY STILL LAND");
		expect(result.stderr).toContain("wait at least 2 minutes");
		expect(w.emitted).toEqual([]);
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

	test("a send that is confirmed but not yet finalized is found by the very next run: discovery lists at confirmed, so it is adopted, never sent twice", async () => {
		const w = new World(ONE);
		w.unfinalizedSends = true;
		w.emitStored = false;
		const first = await w.run(ONE);
		expect(first).toMatchObject({ code: 1, refused: "store-failed", sent: 1 });
		expect(w.sendCalls).toHaveLength(1);

		w.emitStored = true;
		const again = await w.run(ONE);
		expect(again).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(again.stdout).toContain(`${hourIso(H1)} adopted ${newSig(1)}`);
		// One transfer across both runs; the note was written by the second.
		expect(w.sendCalls).toHaveLength(1);
		expect(w.runnerCalls.filter((argv) => argv[1] === "transfer")).toHaveLength(1);
		expect(w.emitted).toHaveLength(2);
		expect(w.emitted[1]?.payload).toMatchObject({ action: "anchor.reanchor", new_tx_sig: newSig(1), previous_tx_sig: oldSig(1) });
		// Every discovery listing asked at confirmed.
		expect(w.listCommitments.length).toBeGreaterThan(0);
		expect(w.listCommitments.every((commitment) => commitment === "confirmed")).toBe(true);
	});

	test("the ledger fake has no write method: the anchors table is never touched by the executor", async () => {
		const w = new World(ONE);
		await w.run(ONE);
		expect(Object.keys(w.ledger).sort()).toEqual(["anchorForPeriod", "eventsByIds"]);
		expect(w.ledgerCalls.every((ms) => ms === H1)).toBe(true);
	});
});

describe("a v2 hour's memo is checked against the heads its members give", () => {
	type Member = { id: string; hash: string; prev: string | null; graph_id: string; session_id: string };
	const IDS = ["evt_1", "evt_2", "evt_3", "evt_4"];
	const hashOf = (id: string): string => new Bun.CryptoHasher("sha256").update(id).digest("hex");

	/** The four events of hour H1 in chain order, one graph and one session; `edited` names one whose content hash differs. */
	function members(edited: string | null = null): Member[] {
		return IDS.map((id, i) => ({
			id,
			hash: id === edited ? hashOf(`${id}:edited`) : hashOf(id),
			prev: i === 0 ? null : hashOf(IDS[i - 1] ?? ""),
			graph_id: "ut-1",
			session_id: "s1",
		}));
	}

	/** The v2 memo the anchor job writes for hour H1 over these members. */
	function v2Over(events: Member[]): string {
		return formatMemoV2({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1), headsRootHex: headsRoot(buildGraphHeads(events, H1).records) });
	}

	test("a stored v2 memo whose heads match the ones its members give passes the check", async () => {
		const memo = v2Over(members());
		const w = new World();
		w.rows.set(H1, { ...(w.rows.get(H1) as AnchorRow), memo });
		w.digestOverride.set(H1, { root: rootFor(1), count: countFor(1), memo, eventIds: IDS });
		w.eventRows = () => members();
		expect(await w.run([{ hourMs: H1, n: 1, memo }])).toMatchObject({ code: 0, refused: null, sent: 1 });
	});

	test("a stored v2 memo whose heads root differs from its members' is refused as root-mismatch, and nothing is sent", async () => {
		const memo = v2Over(members());
		const w = new World();
		w.rows.set(H1, { ...(w.rows.get(H1) as AnchorRow), memo });
		w.digestOverride.set(H1, { root: rootFor(1), count: countFor(1), memo, eventIds: IDS });
		w.eventRows = () => members("evt_2");
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0 });
		expect(result.stderr).toContain("do not reproduce the stored memo");
		w.expectUntouched();
	});

	test("a v1 hour still passes byte for byte, even when its members would give heads", async () => {
		const memo = formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) });
		const w = new World();
		w.digestOverride.set(H1, { root: rootFor(1), count: countFor(1), memo, eventIds: IDS });
		w.eventRows = () => members();
		expect(await w.run(ONE)).toMatchObject({ code: 0, refused: null, sent: 1 });
	});

	/** The v2 hour H1 as a saved plan: its stored row and digest carry `memo`, and its members give it. */
	function savedV2(memo: string): World {
		const w = new World();
		w.rows.set(H1, { ...(w.rows.get(H1) as AnchorRow), memo });
		w.digestOverride.set(H1, { root: rootFor(1), count: countFor(1), memo, eventIds: IDS });
		w.eventRows = () => members();
		return w;
	}

	/** One memo by the signer on chain for H1, listed as an earlier send would be. Returns its signature. */
	function listOnChain(w: World, memo: string): string {
		const signature = newSig(7);
		w.listing = [{ signature, memo, err: null, slot: 5 }];
		w.chain.set(signature, { ...TX_TEMPLATE, memo });
		return signature;
	}

	test("a v2 memo on chain with the saved period, root, count and heads root is adopted: no hour transfer, its pointer sent, one note", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		const adopted = listOnChain(w, memo);
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${adopted}`);
		// The hour is not sent again; its graph has no pointer yet, so that pointer is the only send.
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([pointerFor(members(), adopted)]);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ new_tx_sig: adopted, previous_tx_sig: oldSig(1) });
	});

	test("a v2 memo on chain with the same period, root and count but another heads root is refused, never adopted", async () => {
		const memo = v2Over(members());
		const rival = formatMemoV2({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1), headsRootHex: rootFor(9) });
		const w = savedV2(memo);
		listOnChain(w, rival);
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0, adopted: 0 });
		expect(result.stderr).toContain(`heads root ${rootFor(9)}`);
		w.expectUntouched();
	});

	test("a v1 memo on chain for the same period, root and count is refused for a v2 hour, never adopted", async () => {
		const memo = v2Over(members());
		const v1 = formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) });
		const w = savedV2(memo);
		listOnChain(w, v1);
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0, adopted: 0 });
		expect(result.stderr).toContain("no heads root (a v1 memo)");
		w.expectUntouched();
	});

	test("a rerun after a refused heads-root conflict refuses again and records no success", async () => {
		const memo = v2Over(members());
		const rival = formatMemoV2({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1), headsRootHex: rootFor(9) });
		const w = savedV2(memo);
		listOnChain(w, rival);
		const planned: Planned[] = [{ hourMs: H1, n: 1, memo }];
		expect(await w.run(planned)).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0, adopted: 0 });
		const rerun = await w.run(planned);
		expect(rerun).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0, adopted: 0 });
		expect(rerun.stdout).not.toContain("adopted");
		w.expectUntouched();
	});

	test("a read-back with the same period, root and count but another heads root is refused as send-failed", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		w.readBackMemo = formatMemoV2({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1), headsRootHex: rootFor(9) });
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toEqual([]);
	});

	test("a read-back of a v1 memo for a v2 hour is refused as send-failed", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		w.readBackMemo = formatMemo({ periodStartMs: H1, rootHex: rootFor(1), count: countFor(1) });
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "send-failed", sent: 0 });
		expect(w.emitted).toEqual([]);
	});

	test("a read-back that is the exact stored memo is accepted: the send is recorded", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		w.readBackMemo = memo;
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 1 });
		expect(w.emitted).toHaveLength(1);
	});

	/** The pointer the executor owes `graphId` for hour H1 over `events`, naming the hour transaction `hourTxSig` (design 3.2). */
	function pointerFor(events: Member[], hourTxSig: string, graphId = "ut-1"): string {
		const records = buildGraphHeads(events, H1).records;
		return formatMemoV3({ graphId, periodStartMs: H1, count: events.filter((event) => event.graph_id === graphId).length, graphHeadsRootHex: graphHeadsRoot(records, graphId), hourTxSig });
	}

	test("the hour is sent, then its pointer names the new hour transaction byte for byte, and the hour is then recorded", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 1 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([memo, pointerFor(members(), newSig(1))]);
		expect(w.pointerListAddresses).toEqual([graphIndexAddress("ut-1")]);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ new_tx_sig: newSig(1), previous_tx_sig: oldSig(1) });
	});

	test("a pointer the index listing already holds for the new hour is not sent again", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		const held = pointerFor(members(), newSig(1));
		w.pointerListings.set(graphIndexAddress("ut-1"), [{ signature: newSig(8), memo: held, err: null, slot: 3 }]);
		w.chain.set(newSig(8), { ...TX_TEMPLATE, memo: held });
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 1 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([memo]);
	});

	test("another pointer of the same graph and hour, paid by the job key, is a fork: the hour is sent, the run refuses, and no note is written", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		const fork = pointerFor(members(), newSig(5));
		w.pointerListings.set(graphIndexAddress("ut-1"), [{ signature: newSig(8), memo: fork, err: null, slot: 3 }]);
		w.chain.set(newSig(8), { ...TX_TEMPLATE, memo: fork });
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 1 });
		expect(result.stderr).toContain("names other content for the same graph");
		expect(w.emitted).toEqual([]);
	});

	test("a pointer send that fails is send-failed and records nothing; a re-run adopts the hour and completes its pointer without sending the hour again", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		w.pointerSendCode = 1;
		const first = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(first).toMatchObject({ code: 1, refused: "send-failed", sent: 1 });
		expect(w.emitted).toEqual([]);
		w.pointerSendCode = 0;
		const second = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(second).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([memo, pointerFor(members(), newSig(1)), pointerFor(members(), newSig(1))]);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ new_tx_sig: newSig(1) });
	});

	test("a recorded hour whose pointer is missing gets it: the note stands, nothing is recorded again, and only the pointer is sent", async () => {
		const memo = v2Over(members());
		const w = savedV2(memo);
		const done = newSig(7);
		w.chain.set(done, { ...TX_TEMPLATE, memo });
		w.noteRecords.set(H1, [noteRecord(1, H1, done)]);
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([pointerFor(members(), done)]);
		expect(w.emitted).toEqual([]);
	});

	test("one pointer goes out for each graph with events in the hour, in graph-id order", async () => {
		const two = members().map((event, i) => ({ ...event, graph_id: i < 2 ? "ut-1" : "ut-2" }));
		const memo = v2Over(two);
		const w = savedV2(memo);
		w.eventRows = () => two;
		const result = await w.run([{ hourMs: H1, n: 1, memo }]);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 1 });
		expect(w.sendCalls.map((argv) => argv[5])).toEqual([memo, pointerFor(two, newSig(1), "ut-1"), pointerFor(two, newSig(1), "ut-2")]);
	});
});

function noteRecord(n: number, hourMs: number, signature: string, over: { previous?: string; id?: string } = {}): ReanchorRecord {
	const draft = buildReanchorEvent({
		period_start: hourIso(hourMs),
		root: rootFor(n),
		event_count: countFor(n),
		previous_tx_sig: over.previous ?? oldSig(n),
		new_tx_sig: signature,
		genesis: GENESIS,
	});
	return { event_id: over.id ?? `evt_note_${n}`, ts: hourIso(hourMs + 3 * HOUR_MS), surface: SURFACE, payload: draft.payload };
}

const memoOf = (hourMs: number, n: number): string => formatMemo({ periodStartMs: hourMs, rootHex: rootFor(n), count: countFor(n) });

describe("recorded notes are read before discovery", () => {
	test("a bound note whose transaction verifies finishes the hour: no listing, no send, no second note", async () => {
		const w = new World(ONE);
		const done = newSig(7);
		w.chain.set(done, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.noteRecords.set(H1, [noteRecord(1, H1, done)]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${done} (already recorded)`);
		expect(w.rpcCalls.some((call) => call.startsWith("list:"))).toBe(false);
		w.expectUntouched();
	});

	test("an incomplete notes read is refused before any send even when another surface holds a valid newest bound note; the same note read completely is recorded", async () => {
		const done = newSig(7);
		const incomplete = new World(ONE);
		incomplete.chain.set(done, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		incomplete.noteRecords.set(H1, [noteRecord(1, H1, done)]);
		incomplete.notesIncomplete.set(H1, "the notes of omp in anchor:x hit the 20-page limit before the newest re-anchor note was found");
		const refused = await incomplete.run(ONE);
		expect(refused).toMatchObject({ code: 1, refused: "notes-incomplete", sent: 0, adopted: 0 });
		expect(refused.stderr).toContain("REFUSED notes-incomplete");
		expect(refused.stderr).toContain(`${hourIso(H1)}: the anchor.reanchor notes could not be read completely (the notes of omp in anchor:x hit the 20-page limit`);
		expect(refused.stderr).toContain("nothing was sent");
		// No listing either: the refusal comes before discovery.
		expect(incomplete.listBefore).toEqual([]);
		incomplete.expectUntouched();

		const complete = new World(ONE);
		complete.chain.set(done, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		complete.noteRecords.set(H1, [noteRecord(1, H1, done)]);
		const recorded = await complete.run(ONE);
		expect(recorded).toMatchObject({ code: 0, refused: null, sent: 0, adopted: 1 });
		expect(recorded.stdout).toContain(`${hourIso(H1)} adopted ${done} (already recorded)`);
		complete.expectUntouched();
	});

	test("an incomplete notes read of a LATER hour refuses the whole run before the first send, though the earlier hour is clean", async () => {
		const w = new World(TWO);
		w.notesIncomplete.set(H2, "the notes of omp in anchor:y could not be read past one instant");
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "notes-incomplete", sent: 0 });
		expect(result.stderr).toContain(`${hourIso(H2)}: the anchor.reanchor notes could not be read completely`);
		expect(w.notesCalls).toEqual([hourIso(H1), hourIso(H2)]);
		w.expectUntouched();
	});

	test("only the newest bound note is examined: one that is not proof (a signature the cluster does not know, a memo that is not the hour's, a failed transaction) sends the hour to discovery; a note bound to another row is not a pointer at all", async () => {
		const pointer = newSig(7);
		const cases: Array<[string, (w: World) => void]> = [
			["unknown", () => undefined],
			["wrong memo", (w) => w.chain.set(pointer, { ...TX_TEMPLATE, memo: memoOf(H1, 2) })],
			["failed", (w) => w.chain.set(pointer, { ...TX_TEMPLATE, memo: memoOf(H1, 1), err: { InstructionError: [0, "Custom"] } })],
		];
		for (const [label, setup] of cases) {
			const w = new World(ONE);
			setup(w);
			w.noteRecords.set(H1, [noteRecord(1, H1, pointer, { id: "evt_note_stale" })]);
			const result = await w.run(ONE);
			expect([label, result.code, result.sent, result.adopted]).toEqual([label, 0, 1, 0]);
			expect(w.listBefore).toEqual([undefined]);
			expect(w.sendCalls).toHaveLength(1);
		}
		const w = new World(ONE);
		w.noteRecords.set(H1, [noteRecord(1, H1, newSig(8), { previous: oldSig(5) })]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		// Not bound, so not a stale pointer either: the note keeps the plain key.
		expect(w.emitted[0]?.idempotency_key).toBe(`reanchor:${hourIso(H1)}:${newSig(1)}`);
	});

	test("the notes of every hour are read before the first send", async () => {
		const w = new World(TWO);
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 0, sent: 2 });
		expect(w.notesCalls).toEqual([hourIso(H1), hourIso(H2)]);
	});
});

describe("the newest bound note is the only pointer that counts", () => {
	const stale = "evt_note_stale";

	test("an older valid note does not short-circuit a newer note naming a missing transaction: discovery adopts, no send, and a NEW note is written under its own key", async () => {
		const w = new World(ONE);
		const older = newSig(7);
		const missing = newSig(8);
		w.chain.set(older, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.listing = [{ signature: older, memo: memoOf(H1, 1), err: null, slot: 5 }];
		w.noteRecords.set(H1, [noteRecord(1, H1, missing, { id: stale }), noteRecord(1, H1, older, { id: "evt_note_old" })]);

		const result = await w.run(ONE);

		expect(result).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${older}`);
		expect(result.stdout).not.toContain("already recorded");
		expect(w.listBefore).toEqual([undefined]);
		expect(w.sendCalls).toEqual([]);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ action: "anchor.reanchor", new_tx_sig: older, previous_tx_sig: oldSig(1) });

		// The older note names the same signature under the plain key, so the repair must carry a different one.
		const plain = `reanchor:${hourIso(H1)}:${older}`;
		const key = w.emitted[0]?.idempotency_key as string;
		expect(key).not.toBe(plain);
		expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
		expect(key).toBe(repairIdempotencyKey(hourIso(H1), older, stale));

		// The new note is now the newest bound note and verifies: a re-run is done by it and writes nothing.
		const again = await w.run(ONE);
		expect(again).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(again.stdout).toContain("already recorded");
		expect(w.emitted).toHaveLength(1);
		expect(w.sendCalls).toEqual([]);
	});

	test("a repair key depends on the note it replaces, so two different stale notes never collide, and the plain key is unchanged without one", () => {
		const plain = buildReanchorEvent({ period_start: hourIso(H1), root: rootFor(1), event_count: countFor(1), previous_tx_sig: oldSig(1), new_tx_sig: newSig(7), genesis: GENESIS }).idempotency_key;
		const a = repairIdempotencyKey(hourIso(H1), newSig(7), "evt_a");
		const b = repairIdempotencyKey(hourIso(H1), newSig(7), "evt_b");
		expect(plain).toBe(`reanchor:${hourIso(H1)}:${newSig(7)}`);
		expect(new Set([plain, a, b]).size).toBe(3);
		expect(repairIdempotencyKey(hourIso(H1), newSig(7), "evt_a")).toBe(a);
		for (const key of [plain, a, b]) expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
	});

	test("a newest note that verifies finishes the hour even when an older bound note names a missing transaction: nothing is listed, sent or written", async () => {
		const w = new World(ONE);
		const newest = newSig(7);
		w.chain.set(newest, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.noteRecords.set(H1, [noteRecord(1, H1, newest, { id: "evt_note_new" }), noteRecord(1, H1, newSig(8), { id: "evt_note_old" })]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${newest} (already recorded)`);
		expect(w.rpcCalls.some((call) => call.startsWith("list:"))).toBe(false);
		w.expectUntouched();
	});

	test("a newest note that does not verify and a discovery that finds nothing: exactly one send and one new note naming it", async () => {
		const w = new World(ONE);
		w.noteRecords.set(H1, [noteRecord(1, H1, newSig(7), { id: stale })]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ new_tx_sig: newSig(1), previous_tx_sig: oldSig(1) });
		expect(w.emitted[0]?.idempotency_key).toMatch(/^reanchor:.+:r:[0-9a-f]{40}$/);

		// The note it wrote is the newest bound one and its transaction is on the fake chain: a re-run sends nothing more.
		const again = await w.run(ONE);
		expect(again).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toHaveLength(1);
	});

	test("a newest note whose transaction cannot be read refuses as rpc-unreadable, and an older valid note does not rescue it", async () => {
		const w = new World(ONE);
		const older = newSig(7);
		w.chain.set(older, { ...TX_TEMPLATE, memo: memoOf(H1, 1) });
		w.noteRecords.set(H1, [noteRecord(1, H1, newSig(8), { id: stale }), noteRecord(1, H1, older, { id: "evt_note_old" })]);
		const read = w.rpc.transactionMemo.bind(w.rpc);
		w.rpc.transactionMemo = async (signature, commitment) => {
			if (signature === newSig(8)) throw new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");
			return read(signature, commitment);
		};
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable", sent: 0 });
		expect(w.sendCalls).toEqual([]);
		expect(w.emitted).toEqual([]);
	});
});

describe("discovery pages back through the signer's history", () => {
	const HOURS = 200;
	const planned: Planned[] = Array.from({ length: HOURS }, (_, k) => ({ hourMs: H1 + k * HOUR_MS, n: k + 1 }));
	const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	const uniqueSig = (k: number): string => `${BASE58.charAt(Math.floor(k / 58))}${BASE58.charAt(k % 58)}${"c".repeat(86)}`;

	/** The world after several runs: one confirmed memo per planned hour, newest first, so the earliest hours lie far past the first page. */
	function sentWorld(): World {
		const w = new World(planned);
		w.listing = planned.map(({ hourMs, n }, k) => ({ signature: uniqueSig(k), memo: memoOf(hourMs, n), err: null, slot: 5 + k })).reverse();
		for (const [k, { hourMs, n }] of planned.entries()) w.chain.set(uniqueSig(k), { ...TX_TEMPLATE, memo: memoOf(hourMs, n) });
		return w;
	}

	test("a 200-hour plan whose earliest receipts fall outside the first 100 signatures is found by paging: every hour is adopted, none resent", async () => {
		const w = sentWorld();
		const result = await w.run(planned);
		expect(result).toMatchObject({ code: 0, refused: null, sent: 0, adopted: HOURS });
		expect(w.sendCalls).toEqual([]);
		expect(w.emitted).toHaveLength(HOURS);
		// Three calls: the newest page, the next one older (before the oldest signature of the first), and the empty end of the history.
		expect(w.listBefore).toEqual([undefined, uniqueSig(HOURS - DISCOVERY_PAGE_SIZE), uniqueSig(0)]);
	});

	test("the same world with the notes already recorded lists nothing at all", async () => {
		const w = sentWorld();
		for (const [k, { hourMs, n }] of planned.entries()) w.noteRecords.set(hourMs, [noteRecord(n, hourMs, uniqueSig(k))]);
		const result = await w.run(planned);
		expect(result).toMatchObject({ code: 0, sent: 0, adopted: HOURS });
		expect(w.listBefore).toEqual([]);
		w.expectUntouched();
	});

	test("paging stops at the first page that ends before the plan's earliest hour", async () => {
		const w = new World(ONE);
		const before = (H1 - HOUR_MS) / 1000;
		w.listing = Array.from({ length: DISCOVERY_PAGE_SIZE + 50 }, (_, i) => ({ signature: `old-${i}`, memo: null, err: null, slot: 1, blockTime: before }));
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1 });
		expect(w.listBefore).toEqual([undefined]);
	});

	test("a page that ends at or after the earliest hour is followed by the next one", async () => {
		const w = new World(ONE);
		const after = (H1 + HOUR_MS) / 1000;
		w.listing = Array.from({ length: DISCOVERY_PAGE_SIZE + 50 }, (_, i) => ({ signature: `new-${i}`, memo: null, err: null, slot: 1, blockTime: after }));
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1 });
		expect(w.listBefore).toEqual([undefined, `new-${DISCOVERY_PAGE_SIZE - 1}`]);
	});

	test("a listing that never reaches the horizon refuses at the page cap instead of concluding nothing was sent, and sends nothing", async () => {
		const w = new World(ONE);
		w.endlessListing = true;
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "discovery-incomplete", sent: 0 });
		expect(result.stderr).toContain("an earlier send cannot be ruled out");
		expect(w.listBefore).toHaveLength(DISCOVERY_MAX_PAGES);
		w.expectUntouched();
	});

	test("a page that cannot be read refuses as rpc-unreadable, however far the paging had got", async () => {
		const w = new World(ONE);
		w.endlessListing = true;
		const list = w.rpc.addressMemos.bind(w.rpc);
		w.rpc.addressMemos = async (pubkey, limit, before, commitment) => {
			if (w.listBefore.length === 2) throw new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");
			return list(pubkey, limit, before, commitment);
		};
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable", sent: 0 });
		expect(result.stderr).not.toContain("rpc.example.invalid");
		w.expectUntouched();
	});
});

describe("every read-only check of every hour finishes before the first send", () => {
	test("a later hour whose stored signature exists on the cluster is refused before the first hour is sent", async () => {
		const w = new World(TWO);
		w.chain.set(oldSig(2), { ...TX_TEMPLATE, memo: memoOf(H2, 2) });
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "present-on-cluster", sent: 0 });
		expect(result.stderr).toContain(hourIso(H2));
		w.expectUntouched();
	});

	test("a later hour with a conflicting earlier memo is refused before the first hour is sent", async () => {
		const w = new World(TWO);
		const conflicting = newSig(8);
		const memo = formatMemo({ periodStartMs: H2, rootHex: rootFor(9), count: countFor(2) });
		w.listing = [{ signature: conflicting, memo, err: null, slot: 5 }];
		w.chain.set(conflicting, { ...TX_TEMPLATE, memo });
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "root-mismatch", sent: 0 });
		w.expectUntouched();
	});

	test("a later hour whose earlier transaction cannot be read is refused before the first hour is sent", async () => {
		const w = new World(TWO);
		w.listing = [{ signature: newSig(8), memo: memoOf(H2, 2), err: null, slot: 5 }];
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "rpc-unreadable", sent: 0 });
		w.expectUntouched();
	});
});

describe("overlapping runs", () => {
	test("a second run while the first is in flight is refused as reanchor-locked, before it lists or sends anything; the first completes and releases the lock", async () => {
		const w = new World(ONE);
		const gate = Promise.withResolvers<void>();
		w.sendGate = gate.promise;
		const first = w.run(ONE);
		await w.sendReached.promise;
		expect(w.lockHeldBy).toBe("pid 1");
		const listedByFirst = w.listBefore.length;

		const second = await w.run(ONE);
		expect(second).toMatchObject({ code: 1, refused: "reanchor-locked", sent: 0, adopted: 0 });
		expect(second.stderr).toContain("pid 1");
		expect(second.stderr).toContain("the re-anchor lock is not available (pid 1)");
		expect(second.stderr).toContain("if another run holds it, wait for it to finish; otherwise fix the cause named");
		expect(second.stderr).not.toContain("another re-anchor run is in progress");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.listBefore).toHaveLength(listedByFirst);
		expect(w.emitted).toEqual([]);

		gate.resolve();
		expect(await first).toMatchObject({ code: 0, sent: 1 });
		expect(w.lockHeldBy).toBeNull();
		expect(w.lockReleases).toBe(1);

		// With the lock free again the next run adopts the recorded hour and sends nothing.
		expect(await w.run(ONE)).toMatchObject({ code: 0, sent: 0, adopted: 1 });
		expect(w.sendCalls).toHaveLength(1);
	});

	test("the lock is released on every way out: a refusal after it, a failed send and a failed note", async () => {
		const refused = new World(ONE);
		refused.listingFails = true;
		expect(await refused.run(ONE)).toMatchObject({ refused: "rpc-unreadable" });
		expect(refused.lockHeldBy).toBeNull();
		expect(refused.lockReleases).toBe(1);

		const failedSend = new World(ONE);
		failedSend.sendCode = 1;
		expect(await failedSend.run(ONE)).toMatchObject({ refused: "send-failed" });
		expect(failedSend.lockHeldBy).toBeNull();

		const failedNote = new World(ONE);
		failedNote.emitStored = false;
		expect(await failedNote.run(ONE)).toMatchObject({ refused: "store-failed" });
		expect(failedNote.lockHeldBy).toBeNull();
	});

	test("a gate that refuses before the lock never takes it", async () => {
		const w = new World(ONE);
		w.balance = 0;
		expect(await w.run(ONE)).toMatchObject({ refused: "unfunded" });
		expect(w.lockReleases).toBe(0);
		expect(w.lockHeldBy).toBeNull();
	});
});

describe("the signer set decides which transactions count", () => {
	/** The earlier job key, retired at ROTATED_AT; the configured key (PUBKEY) is valid from then on. */
	const KEY_A = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
	const ROTATED_AT = H1 + 3 * HOUR_MS;
	const A_SIGNED_S = (H1 + 2 * HOUR_MS) / 1000;
	const AFTER_ROTATION_S = (ROTATED_AT + HOUR_MS) / 1000;
	const rotated: SignerSet = [
		{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: ROTATED_AT },
		{ pubkey: PUBKEY, valid_from_ms: ROTATED_AT, valid_until_ms: null },
	];
	const sigA = newSig(7);
	const byA = (memo: string, blockTime: number | null = A_SIGNED_S): TransactionMemo => ({ ...TX_TEMPLATE, payer: KEY_A, memo, blockTime });
	const hintA = { signature: sigA, memo: memoOf(H1, 1), err: null, slot: 5 };
	const noReach = (w: World): string[] => w.rpcCalls.filter((call) => call.startsWith("list:") || call.startsWith("tx:"));

	function rotatedWorld(planned: readonly Planned[] = TWO): World {
		const w = new World(planned);
		w.signerSet = rotated;
		return w;
	}

	test("an hour key A re-anchored before the rotation is adopted from its recorded note: only the unfinished hour is sent, by the configured key, and every signer of the set is listed", async () => {
		const w = rotatedWorld();
		w.chain.set(sigA, byA(memoOf(H1, 1)));
		w.noteRecords.set(H1, [noteRecord(1, H1, sigA)]);
		const result = await w.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 0, refused: null, sent: 1, adopted: 1 });
		expect(result.stdout).toContain(`${hourIso(H1)} adopted ${sigA} (already recorded)`);
		expect(w.sendCalls).toHaveLength(1);
		expect(w.sendCalls[0]?.[5]).toBe(memoOf(H2, 2));
		expect(w.emitted.map((event) => event.payload?.["period_start"])).toEqual([hourIso(H2)]);
		// Hour 2 had no note, so discovery ran: it listed the retired key's address as well as the configured one's.
		expect(w.listAddresses).toEqual([KEY_A, PUBKEY]);
		// One read of the signer set for the whole run.
		expect(w.signerCalls).toBe(1);
	});

	test("the same hour found by discovery (no note) is adopted from key A's own listing; a re-run adopts both hours and sends nothing", async () => {
		const w = rotatedWorld();
		w.chain.set(sigA, byA(memoOf(H1, 1)));
		w.listingBy.set(KEY_A, [hintA]);
		w.listingBy.set(PUBKEY, []);
		const first = await w.run(TWO, { maxHours: 2 });
		expect(first).toMatchObject({ code: 0, refused: null, sent: 1, adopted: 1 });
		expect(first.stdout).toContain(`${hourIso(H1)} adopted ${sigA}`);
		expect(first.stdout).not.toContain("already recorded");
		expect(w.sendCalls).toHaveLength(1);
		expect(w.sendCalls[0]?.[5]).toBe(memoOf(H2, 2));
		expect(w.listAddresses).toEqual([KEY_A, PUBKEY]);
		expect(w.emitted).toHaveLength(2);
		expect(w.emitted[0]?.payload).toMatchObject({ period_start: hourIso(H1), new_tx_sig: sigA });

		const again = await w.run(TWO, { maxHours: 2 });
		expect(again).toMatchObject({ code: 0, sent: 0, adopted: 2 });
		expect(again.stdout).toContain(`${hourIso(H1)} adopted ${sigA} (already recorded)`);
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted).toHaveLength(2);
		// Both hours were recorded: the second run listed nothing.
		expect(w.listAddresses).toEqual([KEY_A, PUBKEY]);
	});

	test("a configured key outside its window is refused before the chain is read or anything is sent, with the reason the verifier would give", async () => {
		const retired = new World(TWO);
		retired.signerSet = [
			{ pubkey: PUBKEY, valid_from_ms: 0, valid_until_ms: NOW - HOUR_MS },
			{ pubkey: KEY_A, valid_from_ms: NOW - HOUR_MS, valid_until_ms: null },
		];
		const result = await retired.run(TWO, { maxHours: 2 });
		expect(result).toMatchObject({ code: 1, refused: "signer-not-current", sent: 0, adopted: 0 });
		expect(result.stderr).toContain("REFUSED signer-not-current");
		expect(result.stderr).toContain("outside its valid window");
		expect(noReach(retired)).toEqual([]);
		expect(retired.notesCalls).toEqual([]);
		expect(retired.runnerCalls).toEqual([[KEYGEN, "pubkey", KEYPAIR]]);
		expect(retired.lockReleases).toBe(0);
		retired.expectUntouched();

		const absent = new World(TWO);
		absent.signerSet = [{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: null }];
		const missing = await absent.run(TWO, { maxHours: 2 });
		expect(missing).toMatchObject({ code: 1, refused: "signer-not-current", sent: 0 });
		expect(missing.stderr).toContain("is not in the signer set");
		absent.expectUntouched();
	});

	test("a rotation read that may be incomplete, or a signer set that cannot be read, refuses before any send", async () => {
		const gap = new World(TWO);
		gap.signerGap = "the signer rotation read of omp hit its 50-page limit (25000 notes), so an older rotation may be missing";
		const incomplete = await gap.run(TWO, { maxHours: 2 });
		expect(incomplete).toMatchObject({ code: 1, refused: "signer-set-incomplete", sent: 0, adopted: 0 });
		expect(incomplete.stderr).toContain("REFUSED signer-set-incomplete");
		expect(incomplete.stderr).toContain("50-page limit");
		expect(incomplete.stderr).toContain("nothing was sent");
		expect(noReach(gap)).toEqual([]);
		gap.expectUntouched();

		const down = new World(TWO);
		down.signersFail = true;
		const unreadable = await down.run(TWO, { maxHours: 2 });
		expect(unreadable).toMatchObject({ code: 1, refused: "signer-set-incomplete", sent: 0 });
		expect(unreadable.stderr).toContain("could not be read");
		expect(unreadable.stderr).not.toContain("10.0.0.9");
		expect(noReach(down)).toEqual([]);
		down.expectUntouched();
	});

	test("a transaction whose signer was not allowed at ITS block time is no proof: a recorded pointer to it is stale, discovery ignores it, and the hour is sent once", async () => {
		const w = rotatedWorld(ONE);
		w.chain.set(sigA, byA(memoOf(H1, 1), AFTER_ROTATION_S));
		w.noteRecords.set(H1, [noteRecord(1, H1, sigA, { id: "evt_note_stale" })]);
		w.listingBy.set(KEY_A, [hintA]);
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		expect(w.sendCalls).toHaveLength(1);
		expect(w.emitted[0]?.payload).toMatchObject({ new_tx_sig: newSig(1) });
		expect(w.emitted[0]?.idempotency_key).toBe(repairIdempotencyKey(hourIso(H1), newSig(1), "evt_note_stale"));
	});

	test("the configured key's own transaction from before its window counts for nothing either, and a hint listed under two addresses is read once", async () => {
		const w = rotatedWorld(ONE);
		const sigB = newSig(8);
		w.chain.set(sigB, { ...TX_TEMPLATE, memo: memoOf(H1, 1), blockTime: A_SIGNED_S });
		w.listing = [{ signature: sigB, memo: memoOf(H1, 1), err: null, slot: 5 }];
		const result = await w.run(ONE);
		expect(result).toMatchObject({ code: 0, sent: 1, adopted: 0 });
		expect(w.listAddresses).toEqual([KEY_A, PUBKEY]);
		expect(w.rpcCalls.filter((call) => call.startsWith(`tx:${sigB.slice(0, 2)}`))).toHaveLength(1);
	});

	test("a signer of the set whose transaction has no block time cannot be judged against a window: the run refuses as rpc-unreadable instead of sending the hour again", async () => {
		const recorded = rotatedWorld(ONE);
		recorded.chain.set(sigA, byA(memoOf(H1, 1), null));
		recorded.noteRecords.set(H1, [noteRecord(1, H1, sigA)]);
		const fromNote = await recorded.run(ONE);
		expect(fromNote).toMatchObject({ code: 1, refused: "rpc-unreadable", sent: 0, adopted: 0 });
		expect(fromNote.stderr).toContain("has no block time");
		recorded.expectUntouched();

		const listed = rotatedWorld(ONE);
		listed.chain.set(sigA, byA(memoOf(H1, 1), null));
		listed.listingBy.set(KEY_A, [hintA]);
		const fromListing = await listed.run(ONE);
		expect(fromListing).toMatchObject({ code: 1, refused: "rpc-unreadable", sent: 0, adopted: 0 });
		expect(fromListing.stderr).toContain("has no block time");
		listed.expectUntouched();

		// A payer outside the set is not a signer at all: its missing block time changes nothing.
		const foreign = new World(ONE);
		foreign.chain.set(sigA, byA(memoOf(H1, 1), null));
		foreign.listing = [hintA];
		expect(await foreign.run(ONE)).toMatchObject({ code: 0, sent: 1, adopted: 0 });
	});
});
