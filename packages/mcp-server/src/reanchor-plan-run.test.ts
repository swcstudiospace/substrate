/**
 * The re-anchor plan runner (v1.6, phase 59, unit c): argument grammar, window and cap, the plan against a fake
 * ledger and a fake devnet, the outage exit code, the URL guard, and the proof that nothing here can send.
 *
 * No ledger, no network and no clock of its own: the ledger and the chain are fakes that LOG every call, so
 * "only reads were made" is asserted from the log, not assumed. The process-boundary tests at the end spawn the
 * real entry with a scrubbed environment and reach only the argument and configuration refusals, which happen
 * before any connection.
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { formatMemo, HOUR_MS, type TransactionMemo } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import type { AnchorRow } from "./greptime.ts";
import {
	DEFAULT_MAX_HOURS,
	MAX_CONSECUTIVE_UNREACHABLE,
	MAX_HOURS_CEILING,
	openRealContext,
	parseReanchorArgs,
	REANCHOR_USAGE,
	ReanchorUsageError,
	resolveWindow,
	runReanchorPlan,
	type AnchorsReader,
	type ChainReader,
	type ReanchorReport,
	type ReanchorRunContext,
	type ReanchorRunResult,
} from "./reanchor-plan-run.ts";

const OLD_GENESIS = DEVNET_GENESIS_HASH;
const NEW_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SIGNER = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
/** 12:30 UTC; the current hour starts at 12:00. */
const NOW = Date.UTC(2026, 9, 26, 12, 30, 0);
const CUR = Date.UTC(2026, 9, 26, 12);
const hourAgo = (n: number): number => CUR - n * HOUR_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

const rootFor = (n: number): string => new Bun.CryptoHasher("sha256").update(`p59c-root:${n}`).digest("hex");
const sigFor = (n: number): string => `${(n % 9) + 1}${"b".repeat(87)}`;

/** The anchors row of the hour `n` hours before the current one. */
function row(n: number, over: Partial<AnchorRow> = {}): AnchorRow {
	const hour = hourAgo(n);
	const root = rootFor(n);
	const count = 3 + n;
	return {
		period_start: iso(hour),
		period_end: iso(hour + HOUR_MS),
		root,
		event_count: count,
		memo: formatMemo({ periodStartMs: hour, rootHex: root, count }),
		tx_sig: sigFor(n),
		signer: SIGNER,
		cluster: "devnet",
		slot: 1000 + n,
		anchored_at: iso(hour + 30 * 60_000),
		stale_hashes: null,
		...over,
	};
}

const TX: TransactionMemo = { memo: null, payer: null, payerSigned: false, err: null, fee: null, slot: 1, blockTime: null };

/** A fake ledger and a fake devnet. Plain objects with only the allowed methods: calling any other one is a TypeError. */
class World {
	rows: AnchorRow[];
	ledgerCalls: Array<[number, number]> = [];
	chainCalls: string[] = [];
	ledgerDown = false;
	genesis: string | Error = NEW_GENESIS;
	finalized = new Set<string>();
	confirmedOnly = new Set<string>();
	failLookup: (signature: string) => boolean = () => false;
	failure = new Error("fetch failed: https://rpc.example.invalid/v1/key-4411");

	constructor(rows: AnchorRow[]) {
		this.rows = rows;
	}

	readonly ledger: AnchorsReader = {
		anchorsBetween: async (since, until) => {
			this.ledgerCalls.push([since, until]);
			if (this.ledgerDown) throw new Error("greptime unreachable at http://10.0.0.9:4000");
			return this.rows.filter((r) => Date.parse(r.period_start) >= since && Date.parse(r.period_start) < until).map((r) => ({ ...r }));
		},
	};

	readonly chain: ChainReader = {
		getGenesisHash: async () => {
			this.chainCalls.push("getGenesisHash");
			if (this.genesis instanceof Error) throw this.genesis;
			return this.genesis;
		},
		transactionMemo: async (signature, level) => {
			this.chainCalls.push(`getTransaction:${level}:${signature.slice(0, 1)}`);
			if (this.failLookup(signature)) throw this.failure;
			if (this.finalized.has(signature)) return TX;
			if (level === "confirmed" && this.confirmedOnly.has(signature)) return TX;
			return null;
		},
	};

	run(argv: readonly string[] = [], now = NOW, expectedGenesis = OLD_GENESIS): Promise<ReanchorRunResult> {
		return runReanchorPlan(argv, { now: () => now, open: async () => ({ ledger: this.ledger, rpc: this.chain, expectedGenesis }) });
	}
}

const reportOf = (result: ReanchorRunResult): ReanchorReport => JSON.parse(result.stdout) as ReanchorReport;
const READS = /^(getGenesisHash|getTransaction:(finalized|confirmed):.)$/;

function refusedOf(opened: ReanchorRunContext | { refused: string }): string {
	if (!("refused" in opened)) throw new Error("expected the context to be refused");
	return opened.refused;
}

function contextOf(opened: ReanchorRunContext | { refused: string }): ReanchorRunContext {
	if ("refused" in opened) throw new Error(`expected an open context, got: ${opened.refused}`);
	return opened;
}

describe("parseReanchorArgs", () => {
	test("no argument is the defaults; every flag is read", () => {
		expect(parseReanchorArgs([])).toEqual({ json: false, sinceMs: null, untilMs: null, maxHours: null });
		expect(parseReanchorArgs(["--since", "2026-10-19T00:00:00Z", "--until", "2026-10-20T00:00:00.000Z", "--max-hours", "48", "--json"])).toEqual({
			json: true,
			sinceMs: Date.UTC(2026, 9, 19),
			untilMs: Date.UTC(2026, 9, 20),
			maxHours: 48,
		});
		expect(parseReanchorArgs(["--since", "2026-10-19T02:00:00+02:00"]).sinceMs).toBe(Date.UTC(2026, 9, 19));
	});

	test("anything else is refused with a usage error", () => {
		const refused = (argv: string[]): string => {
			try {
				parseReanchorArgs(argv);
			} catch (cause) {
				expect(cause).toBeInstanceOf(ReanchorUsageError);
				return cause instanceof Error ? cause.message : "";
			}
			throw new Error(`accepted: ${argv.join(" ")}`);
		};
		expect(refused(["--bogus"])).toContain("unknown flag");
		expect(refused(["positional"])).toContain("unexpected argument");
		expect(refused(["--since=2026-10-19T00:00:00Z"])).toContain("unknown flag");
		expect(refused(["--json", "--json"])).toContain("twice");
		expect(refused(["--since", "2026-10-19T00:00:00Z", "--since", "2026-10-19T01:00:00Z"])).toContain("twice");
		expect(refused(["--since"])).toContain("needs a value");
		expect(refused(["--since", "--json"])).toContain("needs a value");
		expect(refused(["--since", "2026-10-19"])).toContain("ISO instant");
		expect(refused(["--since", "2026-10-19T00:00:00"])).toContain("zone");
		expect(refused(["--until", "2026-10-19T00:30:00Z"])).toContain("whole UTC hour");
		expect(refused(["--until", "2026-13-40T00:00:00Z"])).toContain("ISO instant");
		for (const bad of ["0", "-1", "1.5", "1e3", "745", "abc", "", "007", "12345"]) expect(refused(["--max-hours", bad])).toContain("--max-hours needs an integer");
	});

	test("the ceiling is accepted", () => {
		expect(parseReanchorArgs(["--max-hours", String(MAX_HOURS_CEILING)]).maxHours).toBe(MAX_HOURS_CEILING);
	});
});

describe("resolveWindow", () => {
	test("the default window is the last seven days, ending at the start of the current hour", () => {
		expect(resolveWindow(parseReanchorArgs([]), NOW)).toEqual({ sinceMs: CUR - DEFAULT_MAX_HOURS * HOUR_MS, untilMs: CUR, hours: 168, maxHours: 168 });
	});

	test("--max-hours alone narrows the default window", () => {
		expect(resolveWindow(parseReanchorArgs(["--max-hours", "24"]), NOW)).toMatchObject({ sinceMs: CUR - 24 * HOUR_MS, untilMs: CUR, hours: 24 });
	});

	test("a window wider than the cap, an empty one and a future end are refused", () => {
		const refuse = (argv: string[]): string => {
			try {
				resolveWindow(parseReanchorArgs(argv), NOW);
			} catch (cause) {
				expect(cause).toBeInstanceOf(ReanchorUsageError);
				return cause instanceof Error ? cause.message : "";
			}
			throw new Error("accepted");
		};
		expect(refuse(["--since", iso(CUR - 25 * HOUR_MS), "--max-hours", "24"])).toContain("more than --max-hours 24");
		expect(refuse(["--since", iso(CUR - 169 * HOUR_MS)])).toContain("more than --max-hours 168");
		expect(refuse(["--since", iso(CUR), "--until", iso(CUR)])).toContain("earlier than --until");
		expect(refuse(["--until", iso(CUR + HOUR_MS)])).toContain("current hour");
		expect(resolveWindow(parseReanchorArgs(["--since", iso(CUR - 24 * HOUR_MS), "--max-hours", "24"]), NOW).hours).toBe(24);
	});
});

describe("runReanchorPlan: the plan", () => {
	test("no stale rows: every signature is on the expected cluster, nothing to re-anchor, exit 0", async () => {
		const world = new World([row(3), row(4), row(5)]);
		world.genesis = OLD_GENESIS;
		for (const r of world.rows) world.finalized.add(r.tx_sig);
		const result = await world.run(["--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const report = reportOf(result);
		expect(report).toMatchObject({
			schema: 1,
			dry_run: true,
			chain: { expected_genesis: OLD_GENESIS, observed_genesis: OLD_GENESIS, genesis_matches: true, signature_lookups: 3, rows_not_looked_up: 0 },
			summary: { rows_examined: 3, to_reanchor: 0, skipped_by_code: { ok: 3 }, needs_attention: 0 },
		});
		expect(report.plan.hours).toEqual([]);
		// Oldest hour first: that is the order the lookups are made in.
		expect(world.chainCalls).toEqual(["getGenesisHash", "getTransaction:finalized:6", "getTransaction:finalized:5", "getTransaction:finalized:4"]);
	});

	test("a signature that is only confirmed counts: finalized is asked first, then confirmed", async () => {
		const world = new World([row(3)]);
		world.genesis = OLD_GENESIS;
		world.confirmedOnly.add(sigFor(3));
		const result = await world.run(["--json"]);
		expect(result.code).toBe(0);
		expect(world.chainCalls).toEqual(["getGenesisHash", "getTransaction:finalized:4", "getTransaction:confirmed:4"]);
		expect(reportOf(result).summary.skipped_by_code).toEqual({ ok: 1 });
	});

	test("a plain text summary says nothing was sent and what to do", async () => {
		const world = new World([row(3)]);
		world.genesis = OLD_GENESIS;
		world.finalized.add(sigFor(3));
		const result = await world.run();
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("DRY RUN: nothing was sent");
		expect(result.stdout).toContain("nothing to re-anchor");
		expect(result.stdout).toContain("same cluster");
	});

	test("a reset: the genesis differs and no signature is known, so every hour is planned with its stored memo, exit 1", async () => {
		const rows = [row(5), row(3), row(4)];
		const world = new World(rows);
		const result = await world.run(["--json"]);
		expect(result.code).toBe(1);
		const report = reportOf(result);
		expect(report.chain).toMatchObject({ observed_genesis: NEW_GENESIS, genesis_matches: false, signature_lookups: 3 });
		expect(report.plan.dry_run).toBe(true);
		expect(report.plan.notes.join(" ")).toContain("no transaction was sent");
		// Ascending by hour, whatever order the ledger answered in; the memo is the stored row's, byte for byte.
		expect(report.plan.hours.map((h) => h.period_start)).toEqual([iso(hourAgo(5)), iso(hourAgo(4)), iso(hourAgo(3))]);
		for (const planned of report.plan.hours) {
			const stored = rows.find((r) => r.period_start === planned.period_start) as AnchorRow;
			expect(planned).toMatchObject({ memo: stored.memo, root: stored.root, event_count: stored.event_count, previous_tx_sig: stored.tx_sig, previous_signer: SIGNER, target_genesis: NEW_GENESIS });
		}
		expect(report.summary).toMatchObject({ to_reanchor: 3, needs_attention: 0, skipped_by_code: {} });
		// Each hour was asked at both levels; every call was a read.
		expect(world.chainCalls).toHaveLength(1 + 3 * 2);
		for (const call of world.chainCalls) expect(call).toMatch(READS);
	});

	test("a reset in text: names the new genesis, lists the hours and points at the runbook", async () => {
		const world = new World([row(3), row(4)]);
		const result = await world.run();
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("2 hours to re-anchor");
		expect(result.stdout).toContain(`observed ${NEW_GENESIS}`);
		expect(result.stdout).toContain("DIFFERENT");
		expect(result.stdout).toContain(rootFor(3));
		expect(result.stdout).toContain("docs/runbooks/devnet-reset-and-reanchor.md");
	});

	test("an hour whose signature already exists on the observed cluster is not planned again", async () => {
		const world = new World([row(3), row(4)]);
		world.finalized.add(sigFor(4));
		const report = reportOf(await world.run(["--json"]));
		// Row 4's signature exists on the new cluster, so only row 3 is planned.
		expect(report.plan.hours.map((h) => h.period_start)).toEqual([iso(hourAgo(3))]);
		expect(report.summary.skipped_by_code).toEqual({ "present-on-observed-cluster": 1 });
	});

	test("the expected cluster with a signature missing is not a reset: not planned, flagged for a human, exit 0", async () => {
		const world = new World([row(3), row(4)]);
		world.genesis = OLD_GENESIS;
		world.finalized.add(sigFor(3));
		const result = await world.run(["--json"]);
		expect(result.code).toBe(0);
		const report = reportOf(result);
		expect(report.plan.hours).toEqual([]);
		expect(report.summary).toMatchObject({ to_reanchor: 0, skipped_by_code: { ok: 1, "signature-missing-without-reset": 1 }, needs_attention: 1 });
		expect((await world.run()).stdout).toContain("ATTENTION");
	});

	test("an anchor inside the grace window is not a missing signature", async () => {
		const world = new World([row(1, { anchored_at: iso(NOW - 30_000) })]);
		world.genesis = OLD_GENESIS;
		const report = reportOf(await world.run(["--json"]));
		expect(report.summary).toMatchObject({ to_reanchor: 0, skipped_by_code: { "chain-unreachable": 1 }, needs_attention: 0 });
	});

	test("a damaged row is not looked up and is flagged; a bad memo is refused by the plan", async () => {
		const world = new World([row(3, { tx_sig: "short" }), row(4, { memo: "substrate:v1:nonsense" }), row(5)]);
		const result = await world.run(["--json"]);
		expect(result.code).toBe(1);
		const report = reportOf(result);
		expect(report.chain).toMatchObject({ signature_lookups: 2, rows_not_looked_up: 1 });
		expect(report.plan.hours.map((h) => h.period_start)).toEqual([iso(hourAgo(5))]);
		expect(report.summary.skipped_by_code).toEqual({ "invalid-row": 1, "no-evidence": 1 });
		expect(report.summary.needs_attention).toBe(2);
		expect(world.chainCalls.filter((c) => c.startsWith("getTransaction")).every((c) => !c.endsWith(":s"))).toBe(true);
	});

	test("an empty window reads the ledger and nothing else: no chain request, exit 0", async () => {
		const world = new World([]);
		const result = await world.run(["--json"]);
		expect(result.code).toBe(0);
		expect(world.chainCalls).toEqual([]);
		expect(world.ledgerCalls).toHaveLength(1);
		expect(reportOf(result).chain).toMatchObject({ observed_genesis: null, genesis_matches: null, signature_lookups: 0 });
		expect((await world.run()).stdout).toContain("not read");
	});

	test("the plan is deterministic: the same inputs give the same bytes whatever order the rows arrive in, and inputs are not changed", async () => {
		const rows = [row(3), row(4), row(5), row(6)];
		const snapshot = JSON.stringify(rows);
		const a = await new World([...rows]).run(["--json"]);
		const b = await new World([...rows].reverse()).run(["--json"]);
		const c = await new World([rows[2] as AnchorRow, rows[0] as AnchorRow, rows[3] as AnchorRow, rows[1] as AnchorRow]).run(["--json"]);
		expect(a.stdout).toBe(b.stdout);
		expect(a.stdout).toBe(c.stdout);
		expect(JSON.stringify(rows)).toBe(snapshot);
		expect((await new World([...rows]).run()).stdout).toBe((await new World([...rows].reverse()).run()).stdout);
		expect(reportOf(a).generated_at).toBe(iso(NOW));
	});
});

describe("runReanchorPlan: window and cap", () => {
	test("the ledger is asked for exactly the window", async () => {
		const world = new World([row(3)]);
		world.genesis = OLD_GENESIS;
		await world.run([]);
		expect(world.ledgerCalls).toEqual([[CUR - 168 * HOUR_MS, CUR]]);
		world.ledgerCalls.length = 0;
		await world.run(["--since", iso(hourAgo(10)), "--until", iso(hourAgo(2))]);
		expect(world.ledgerCalls).toEqual([[hourAgo(10), hourAgo(2)]]);
		world.ledgerCalls.length = 0;
		await world.run(["--max-hours", "6"]);
		expect(world.ledgerCalls).toEqual([[hourAgo(6), CUR]]);
	});

	test("rows outside the window are not planned", async () => {
		const world = new World([row(3), row(30)]);
		const report = reportOf(await world.run(["--json", "--max-hours", "6"]));
		expect(report.plan.hours.map((h) => h.period_start)).toEqual([iso(hourAgo(3))]);
	});

	test("a window wider than --max-hours exits 2 before the ledger or the chain is touched", async () => {
		const world = new World([row(3)]);
		const result = await world.run(["--since", iso(hourAgo(30)), "--max-hours", "24"]);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--max-hours 24");
		expect(result.stderr).toContain(REANCHOR_USAGE);
		expect(world.ledgerCalls).toEqual([]);
		expect(world.chainCalls).toEqual([]);
	});

	test("a bad flag exits 2 before open() is called", async () => {
		let opened = 0;
		const result = await runReanchorPlan(["--nope"], {
			now: () => NOW,
			open: async () => {
				opened += 1;
				return { refused: "x" };
			},
		});
		expect(result).toMatchObject({ code: 2, stdout: "" });
		expect(result.stderr).toContain("usage: reanchor-plan-run.ts");
		expect(opened).toBe(0);
	});

	test("more rows than hours in the window is a broken ledger answer: exit 3, no chain request", async () => {
		const world = new World([]);
		world.ledger.anchorsBetween = async () => [row(3), row(4), row(5)];
		const result = await world.run(["--max-hours", "2"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("3 anchors rows for a window of 2 hours");
		expect(world.chainCalls).toEqual([]);
	});

	test("a non-finite clock is a programming error, not a plan", async () => {
		const world = new World([]);
		await expect(world.run([], Number.NaN)).rejects.toThrow(TypeError);
	});
});

describe("runReanchorPlan: outages are exit 3 and never a plan", () => {
	test("the genesis hash cannot be read: exit 3, nothing on stdout, no signature lookup, no URL in the message", async () => {
		const world = new World([row(3), row(4)]);
		world.genesis = new Error("fetch failed https://rpc.example.invalid/v1/key-4411");
		const result = await world.run(["--json"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("genesis hash could not be read");
		expect(result.stderr).toContain("no plan can be claimed");
		expect(result.stderr).not.toContain("rpc.example.invalid");
		expect(result.stderr).not.toContain("key-4411");
		expect(world.chainCalls).toEqual(["getGenesisHash"]);
	});

	test("a cluster that answers with no genesis hash is an outage too", async () => {
		const world = new World([row(3)]);
		world.chain.getGenesisHash = async () => "";
		expect((await world.run()).code).toBe(3);
	});

	test("every signature lookup fails: the run stops after three and exits 3", async () => {
		const world = new World(Array.from({ length: 10 }, (_, i) => row(3 + i)));
		world.failLookup = () => true;
		const result = await world.run(["--json"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`did not answer ${MAX_CONSECUTIVE_UNREACHABLE} of ${MAX_CONSECUTIVE_UNREACHABLE}`);
		expect(result.stderr).not.toContain("rpc.example.invalid");
		expect(world.chainCalls).toHaveLength(1 + MAX_CONSECUTIVE_UNREACHABLE);
	});

	test("one lookup that fails among answered ones still means no plan can be claimed", async () => {
		const world = new World([row(3), row(4), row(5), row(6)]);
		world.failLookup = (signature) => signature === sigFor(4);
		const result = await world.run(["--json"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("did not answer 1 of 4");
		expect(result.stdout).toBe("");
	});

	test("an unreachable endpoint is never read as a wiped cluster: no hour is planned from a failed lookup", async () => {
		const world = new World([row(3)]);
		world.failLookup = () => true;
		const result = await world.run(["--json"]);
		expect(result.code).toBe(3);
		expect(result.stdout).not.toContain("previous_tx_sig");
	});

	test("the ledger cannot be read: exit 3 before any chain request, no URL in the message", async () => {
		const world = new World([row(3)]);
		world.ledgerDown = true;
		const result = await world.run(["--json"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("the ledger could not be read");
		expect(result.stderr).not.toContain("10.0.0.9");
		expect(world.chainCalls).toEqual([]);
	});
});

// Built at runtime so the repo-wide secret scan (store-lock.test.ts) does not read a fixture as a committed Greptime endpoint:
// the same device config.test.ts uses for this variable.
const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");
describe("openRealContext: the devnet guard and the read-only requests", () => {
	const GREPTIME = "http://greptime.invalid:4000";

	function spies() {
		const requests: Array<{ url: string; method: string }> = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
			requests.push({ url: String(url), method: body.method });
			const result = body.method === "getGenesisHash" ? NEW_GENESIS : null;
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
		}) as typeof fetch;
		return { requests, fetchImpl };
	}

	test("a mainnet, testnet, userinfo, fragment or non-http URL is refused before a ledger client or any request exists", async () => {
		for (const url of [
			"https://api.mainnet-beta.solana.com",
			"https://api.testnet.solana.com",
			"https://user:hunter2@api.devnet.solana.com",
			"https://api.devnet.solana.com/#frag",
			"ftp://api.devnet.solana.com",
			"not a url",
		]) {
			const { requests, fetchImpl } = spies();
			let ledgers = 0;
			const opened = await openRealContext({
				env: { [GREPTIME_URL_KEY]: GREPTIME, SOLANA_RPC_URL: url },
				fetchImpl,
				sleep: async () => {},
				ledgerFor: () => {
					ledgers += 1;
					return { anchorsBetween: async () => [] };
				},
			});
			expect(opened).toHaveProperty("refused");
			const refusal = refusedOf(opened);
			expect(refusal).toContain("SOLANA_RPC_URL refused");
			expect(refusal).not.toContain("hunter2");
			expect(requests).toEqual([]);
			expect(ledgers).toBe(0);
			// And the run says so with exit 2 and prints nothing to stdout.
			const run = await runReanchorPlan(["--json"], { now: () => NOW, open: async () => opened });
			expect(run).toMatchObject({ code: 2, stdout: "" });
			expect(run.stderr).not.toContain("hunter2");
		}
	});

	test("an unset GREPTIME_URL is refused first", async () => {
		const { requests, fetchImpl } = spies();
		expect(await openRealContext({ env: {}, fetchImpl })).toEqual({ refused: "GREPTIME_URL is not set" });
		expect(requests).toEqual([]);
	});

	test("the default endpoint is devnet's and the expected genesis is the job's constant; opening makes no request", async () => {
		const { requests, fetchImpl } = spies();
		const opened = await openRealContext({ env: { [GREPTIME_URL_KEY]: GREPTIME }, fetchImpl, sleep: async () => {}, ledgerFor: () => ({ anchorsBetween: async () => [] }) });
		expect("refused" in opened).toBe(false);
		expect(contextOf(opened).expectedGenesis).toBe(DEVNET_GENESIS_HASH);
		expect(requests).toEqual([]);
	});

	test("a whole run over the real RPC client sends only getGenesisHash and getTransaction", async () => {
		const { requests, fetchImpl } = spies();
		const rows = [row(3), row(4)];
		const opened = await openRealContext({
			env: { [GREPTIME_URL_KEY]: GREPTIME, SOLANA_RPC_URL: "https://rpc.devnet.example.invalid/path" },
			fetchImpl,
			sleep: async () => {},
			ledgerFor: () => ({ anchorsBetween: async () => rows }),
		});
		const result = await runReanchorPlan(["--json"], { now: () => NOW, open: async () => opened });
		expect(result.code).toBe(1);
		expect(reportOf(result).plan.hours).toHaveLength(2);
		expect(requests.every((r) => r.url === "https://rpc.devnet.example.invalid/path")).toBe(true);
		expect(new Set(requests.map((r) => r.method))).toEqual(new Set(["getGenesisHash", "getTransaction"]));
		expect(requests).toHaveLength(1 + 2 * 2);
		const forbidden = /sendTransaction|simulateTransaction|requestAirdrop|getBalance|getSignaturesForAddress|signTransaction/;
		expect(requests.some((r) => forbidden.test(r.method))).toBe(false);
	});

	test("a dead endpoint retries with the injected sleep (no real delay) and ends as exit 3", async () => {
		const sleeps: number[] = [];
		let attempts = 0;
		const opened = await openRealContext({
			env: { [GREPTIME_URL_KEY]: GREPTIME },
			fetchImpl: (async () => {
				attempts += 1;
				throw new Error("connect ECONNREFUSED 203.0.113.7:443");
			}) as unknown as typeof fetch,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			ledgerFor: () => ({ anchorsBetween: async () => [row(3)] }),
		});
		const result = await runReanchorPlan([], { now: () => NOW, open: async () => opened });
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("genesis hash could not be read");
		expect(result.stderr).not.toContain("203.0.113.7");
		expect(attempts).toBeGreaterThan(1);
		expect(sleeps).toHaveLength(attempts - 1);
	});
});

describe("the module cannot send", () => {
	const FORBIDDEN =
		/transferMemoArgv|execFileRunner|keygenPath|pubkeyArgv|parseSignature|\bRunner\b|runAnchorJob|insertAnchor|keypair|SOLANA_ANCHOR|SOLANA_CLI|child_process|node:(net|http|https|child_process|fs|dgram|tls)|Bun\.spawn|Bun\.\$|\bexec(File)?\b|\bfetch\s*\(|WebSocket|sendTransaction|requestAirdrop/i;

	function code(path: string): string {
		return readFileSync(new URL(path, import.meta.url), "utf8")
			.split("\n")
			.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
			.join("\n");
	}

	function imports(source: string): Array<{ from: string; names: string[] }> {
		return [...source.matchAll(/^import\s+(?:type\s+)?(\{[^}]*\}|[\w*\s]+?)\s+from\s+"([^"]+)";/gm)].map((match) => ({
			from: match[2] as string,
			names: (match[1] as string)
				.replace(/[{}]/g, "")
				.split(",")
				.map((name) => name.replace(/^\s*type\s+/, "").trim())
				.filter((name) => name.length > 0),
		}));
	}

	test("it imports a fixed set of modules, and from the anchor job only the genesis constant", () => {
		const source = code("./reanchor-plan-run.ts");
		expect(source).not.toMatch(/^import\s+"/m);
		expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
		const found = imports(source);
		expect(found.map((entry) => entry.from).sort()).toEqual(["./anchor.ts", "./config.ts", "./greptime.ts", "./reanchor-plan.ts", "./redact.ts", "@substrate/ledger"]);
		expect(found.find((entry) => entry.from === "./anchor.ts")?.names).toEqual(["DEVNET_GENESIS_HASH"]);
		const fromLedger = found.find((entry) => entry.from === "@substrate/ledger")?.names ?? [];
		expect(fromLedger.join(" ")).not.toMatch(FORBIDDEN);
		expect(fromLedger).not.toContain("AMOUNT_ZERO");
		expect(fromLedger).not.toContain("SOLANA_CLI_DEFAULT");
	});

	test("nothing in the module's own code can sign, spawn, open a socket or call fetch directly", () => {
		expect(code("./reanchor-plan-run.ts")).not.toMatch(FORBIDDEN);
	});

	test("the dependency it wrote against, the plan module, has no send path either", () => {
		const source = code("./reanchor-plan.ts");
		expect(source).not.toMatch(FORBIDDEN);
		expect(imports(source).map((entry) => entry.from).sort()).toEqual(["./greptime.ts", "@substrate/ledger"]);
	});

	test("the only chain and ledger calls in the code are the read calls", () => {
		const source = code("./reanchor-plan-run.ts");
		const rpcCalls = new Set([...source.matchAll(/\brpc\.(\w+)/g)].map((match) => match[1]));
		expect(rpcCalls).toEqual(new Set(["getGenesisHash", "transactionMemo"]));
		const ledgerCalls = new Set([...source.matchAll(/\bledger\.(\w+)\s*\(/g)].map((match) => match[1]));
		expect(ledgerCalls).toEqual(new Set(["anchorsBetween"]));
	});
});

describe("the entry process", () => {
	const RUNNER = new URL("./reanchor-plan-run.ts", import.meta.url).pathname;

	async function spawn(args: string[], env: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
		const home = mkdtempSync(join(tmpdir(), "p59c-reanchor-run-"));
		mkdirSync(join(home, ".config"));
		const proc = Bun.spawn(["env", "-i", "PATH=/usr/bin:/bin", `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, ".config")}`, ...env, process.execPath, RUNNER, ...args], {
			cwd: home,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	test("a bad flag exits 2 with the usage and prints nothing to stdout", async () => {
		const result = await spawn(["--bogus"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("unknown flag");
		expect(result.stderr).toContain("usage: reanchor-plan-run.ts");
		expect(result.stdout).toBe("");
	});

	test("an empty environment exits 2 naming the unset variable, before any connection", async () => {
		const result = await spawn(["--json"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("GREPTIME_URL is not set");
		expect(result.stdout).toBe("");
	});

	test("a mainnet endpoint exits 2 before the ledger or the cluster is contacted", async () => {
		const result = await spawn([], [`${GREPTIME_URL_KEY}=http://127.0.0.1:9`, "SOLANA_RPC_URL=https://api.mainnet-beta.solana.com"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("SOLANA_RPC_URL refused");
		expect(result.stdout).toBe("");
	});
});
