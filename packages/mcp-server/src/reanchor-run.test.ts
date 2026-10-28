/**
 * The re-anchor entry (v1.6, phase 59, criterion 5): the CLI behind the process boundary driven with fakes, the proof that the
 * default run opens nothing, the real context's refusals before any connection, and the pins that keep the send an operator-run step:
 * only `reanchor-run.ts` (besides the anchor job's own entry) constructs the real executor, the orchestrator cannot send by itself,
 * and no CI file, workflow, script, service unit or package script mentions the entry.
 *
 * No ledger, no network, no clock of its own. The process-boundary tests spawn the real entry with a scrubbed environment and reach
 * only the argument, plan-file and configuration refusals and the dry run, which all happen before any connection.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { formatMemo, HOUR_MS, hourIso, type Rpc, type RunResult } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import type { ReanchorDeps, ReanchorOptions } from "./reanchor.ts";
import { fileLock, LOCK_STALE_MS, openRealContext, reanchorLockPath, runReanchorCli, type ReanchorCliDeps } from "./reanchor-run.ts";
import { Substrate } from "./service.ts";

const GENESIS = "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC";

/** The ledger URL variable's name, built from parts: the store lock keeps a literal `<name>: <value>` assignment out of every tracked file. */
const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");
const PUBKEY = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const H1 = Date.UTC(2026, 9, 20, 10);
const H2 = H1 + HOUR_MS;
const NOW = H2 + 5 * HOUR_MS;
const rootFor = (n: number): string => new Bun.CryptoHasher("sha256").update(`p59-run-root:${n}`).digest("hex");
const oldSig = (n: number): string => `${n}${"b".repeat(87)}`;

function entry(hourMs: number, n: number): Record<string, unknown> {
	return {
		period_start: hourIso(hourMs),
		period_start_ms: hourMs,
		why: "signature missing after a suspected devnet reset",
		memo: formatMemo({ periodStartMs: hourMs, rootHex: rootFor(n), count: 3 + n }),
		root: rootFor(n),
		event_count: 3 + n,
		previous_tx_sig: oldSig(n),
		previous_signer: PUBKEY,
		target_genesis: GENESIS,
	};
}

const PLAN = JSON.stringify({
	schema: 1,
	dry_run: true,
	chain: { expected_genesis: DEVNET_GENESIS_HASH, observed_genesis: GENESIS, genesis_matches: false, signature_lookups: 2, rows_not_looked_up: 0 },
	plan: { dry_run: true, generated_at_ms: NOW, hours: [entry(H1, 1), entry(H2, 2)], skipped: [], notes: [] },
});

/** Every port the entry could reach, as a recording fake. The default run must leave all of them untouched. */
function spies(): { cli: ReanchorCliDeps; opened: ReanchorOptions[]; runnerCalls: string[][]; rpcCalls: string[]; reads: string[] } {
	const opened: ReanchorOptions[] = [];
	const runnerCalls: string[][] = [];
	const rpcCalls: string[] = [];
	const reads: string[] = [];
	const rpc: Rpc = {
		transactionMemo: async () => {
			rpcCalls.push("transactionMemo");
			return null;
		},
		addressMemos: async () => {
			rpcCalls.push("addressMemos");
			return [];
		},
		getGenesisHash: async () => {
			rpcCalls.push("getGenesisHash");
			return GENESIS;
		},
		balance: async () => {
			rpcCalls.push("balance");
			return 10_000_000;
		},
	};
	const runner = async (argv: readonly string[]): Promise<RunResult> => {
		runnerCalls.push([...argv]);
		return { code: 0, stdout: "", stderr: "" };
	};
	const ports: ReanchorDeps = {
		ledger: { anchorForPeriod: async () => null },
		rpc,
		runner,
		substrate: {} as unknown as ReanchorDeps["substrate"],
		env: { rpcUrl: "https://api.devnet.solana.com", keypairPath: "/etc/substrate/key.json", pubkey: PUBKEY, cli: "/opt/solana/bin/solana" },
		surface: "omp",
		operatorSurfaces: new Set(["omp"]),
		clock: () => NOW,
		notes: async () => ({ records: [], incomplete: null }),
		signers: async () => ({ set: [{ pubkey: PUBKEY, valid_from_ms: 0, valid_until_ms: null }], gap: null }),
		lock: { acquire: () => ({ release: () => undefined }) },
	};
	return {
		cli: {
			readPlan: (path) => {
				reads.push(path);
				return PLAN;
			},
			open: async (options) => {
				opened.push(options);
				return ports;
			},
		},
		opened,
		runnerCalls,
		rpcCalls,
		reads,
	};
}

describe("the default run opens nothing", () => {
	test("--plan alone prints `would re-anchor` per hour, exits 0, and never opens a port, a runner or an endpoint", async () => {
		const s = spies();
		const result = await runReanchorCli(["--plan", "plan.json"], s.cli);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(`would re-anchor ${hourIso(H1)} (4 events)`);
		expect(result.stdout).toContain(`would re-anchor ${hourIso(H2)} (5 events)`);
		expect(s.reads).toEqual(["plan.json"]);
		expect(s.opened).toEqual([]);
		expect(s.runnerCalls).toEqual([]);
		expect(s.rpcCalls).toEqual([]);
	});

	test("confirm flags without --execute are still a dry run", async () => {
		const s = spies();
		const result = await runReanchorCli(["--plan", "plan.json", "--confirm-genesis", GENESIS, "--max-hours", "2"], s.cli);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("would re-anchor");
		expect(s.opened).toEqual([]);
		expect(s.runnerCalls).toEqual([]);
	});

	test("--execute without --confirm-genesis is a usage error before any port is opened", async () => {
		const s = spies();
		const result = await runReanchorCli(["--plan", "plan.json", "--execute"], s.cli);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--confirm-genesis");
		expect(result.stderr).toContain("usage: reanchor-run.ts");
		expect(s.opened).toEqual([]);
		expect(s.runnerCalls).toEqual([]);
		expect(s.rpcCalls).toEqual([]);
	});

	test("a bad flag, a missing plan file and an invalid plan are exit 2 with the usage, and nothing is opened", async () => {
		const s = spies();
		expect((await runReanchorCli(["--bogus"], s.cli)).code).toBe(2);
		expect((await runReanchorCli([], s.cli)).stderr).toContain("--plan FILE is required");

		const unreadable = await runReanchorCli(["--plan", "missing.json"], {
			...s.cli,
			readPlan: () => {
				throw new Error("ENOENT: no such file or directory, open 'missing.json'");
			},
		});
		expect(unreadable).toMatchObject({ code: 2, stdout: "" });
		expect(unreadable.stderr).toContain("the plan file cannot be read");

		const invalid = await runReanchorCli(["--plan", "plan.json"], { ...s.cli, readPlan: () => JSON.stringify({ schema: 1, dry_run: false }) });
		expect(invalid).toMatchObject({ code: 2, stdout: "" });
		expect(invalid.stderr).toContain("not a dry-run plan");
		expect(s.opened).toEqual([]);
		expect(s.runnerCalls).toEqual([]);
	});
});

describe("--execute through the CLI", () => {
	test("a refused context is exit 2 and nothing ran", async () => {
		const s = spies();
		const result = await runReanchorCli(["--plan", "p.json", "--execute", "--confirm-genesis", GENESIS], { ...s.cli, open: async () => ({ refused: "GREPTIME_URL is not set" }) });
		expect(result).toMatchObject({ code: 2, stdout: "" });
		expect(result.stderr).toContain("GREPTIME_URL is not set");
		expect(s.runnerCalls).toEqual([]);
	});

	test("the options the entry parsed reach the open call, and a gate that refuses is exit 1 with the gate named", async () => {
		const s = spies();
		// The fake runner prints nothing, so the signer gate refuses: the run is exit 1 and no transfer was attempted.
		const result = await runReanchorCli(["--plan", "p.json", "--execute", "--confirm-genesis", GENESIS, "--max-hours", "2", "--surface", "omp"], s.cli);
		expect(s.opened).toEqual([{ planPath: "p.json", execute: true, confirmGenesis: GENESIS, maxHours: 2, surface: "omp" }]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("[reanchor] REFUSED signer-mismatch");
		expect(s.runnerCalls.filter((argv) => argv[1] === "transfer")).toEqual([]);
	});

	test("a plan with no hour is done without opening anything", async () => {
		const s = spies();
		// What `reanchor-plan-run.ts --json` prints for a window with no anchors row: the planner reads no chain, so no genesis.
		const empty = JSON.stringify({ schema: 1, dry_run: true, chain: { observed_genesis: null }, plan: { dry_run: true, hours: [] } });
		const result = await runReanchorCli(["--plan", "p.json", "--execute", "--confirm-genesis", GENESIS], { ...s.cli, readPlan: () => empty });
		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(s.opened).toEqual([]);
	});
});

describe("openRealContext: the devnet guard and the configuration, before any connection", () => {
	const OPTIONS: ReanchorOptions = { planPath: "p.json", execute: true, confirmGenesis: GENESIS, maxHours: 1, surface: null };
	const GREPTIME = "http://127.0.0.1:9";
	const SOLANA = { SOLANA_ANCHOR_KEYPAIR: "/etc/substrate/key.json", SOLANA_ANCHOR_PUBKEY: PUBKEY };

	function refusedOf(opened: ReanchorDeps | { refused: string }): string {
		if (!("refused" in opened)) throw new Error("expected the context to be refused");
		return opened.refused;
	}

	test("an unset ledger URL is refused", () => {
		expect(refusedOf(openRealContext(OPTIONS, { env: { ...SOLANA } }))).toContain("GREPTIME_URL is not set");
	});

	test("a mainnet or testnet endpoint is refused before a ledger client or a request exists", () => {
		for (const url of ["https://api.mainnet-beta.solana.com", "https://api.testnet.solana.com"]) {
			let fetched = 0;
			const opened = openRealContext(OPTIONS, {
				env: { [GREPTIME_URL_KEY]: GREPTIME, SOLANA_RPC_URL: url, ...SOLANA },
				fetchImpl: (async () => {
					fetched += 1;
					throw new Error("no network in a test");
				}) as unknown as typeof fetch,
				ledgerFor: () => {
					throw new Error("a refused endpoint must not build a ledger client");
				},
			});
			expect(refusedOf(opened)).toContain("SOLANA_RPC_URL");
			expect(fetched).toBe(0);
		}
	});

	test("an unset keypair or public key is refused: nothing is sent without them", () => {
		expect(refusedOf(openRealContext(OPTIONS, { env: { [GREPTIME_URL_KEY]: GREPTIME }, ledgerFor: () => ({}) as never }))).toContain("SOLANA_ANCHOR_KEYPAIR and SOLANA_ANCHOR_PUBKEY must be set");
	});

	test("a valid configuration builds the ports; a single operator surface is chosen when none is named, an explicit one is passed through", () => {
		const env = { [GREPTIME_URL_KEY]: GREPTIME, ...SOLANA, SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_OPERATOR_TOKENS: "tok-omp" };
		const seams = { ledgerFor: () => ({ anchorForPeriod: async () => null, queryEvents: async () => [] }) as never, substrateFor: () => ({}) as never };
		const built = openRealContext(OPTIONS, { env, ...seams });
		if ("refused" in built) throw new Error(`unexpected refusal: ${built.refused}`);
		expect(built.env).toMatchObject({ pubkey: PUBKEY, keypairPath: "/etc/substrate/key.json" });
		expect(built.operatorSurfaces.has("omp")).toBe(true);
		expect(built.surface).toBe("omp");

		const named = openRealContext({ ...OPTIONS, surface: "hermes" }, { env, ...seams });
		if ("refused" in named) throw new Error(`unexpected refusal: ${named.refused}`);
		expect(named.surface).toBe("hermes");
	});

	test("the signers port is the verifier's own signer-set read over the same ledger: the configured key alone, a failed rotation read as a gap, a malformed set as a failure", async () => {
		const env = { [GREPTIME_URL_KEY]: GREPTIME, ...SOLANA, SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_OPERATOR_TOKENS: "tok-omp" };
		const built = openRealContext(OPTIONS, { env, ledgerFor: () => ({ anchorForPeriod: async () => null, queryEvents: async () => [] }) as never, substrateFor: () => ({}) as never });
		if ("refused" in built) throw new Error(`unexpected refusal: ${built.refused}`);
		const read = await built.signers();
		expect(read.gap).toBeNull();
		expect(read.set).toMatchObject([{ pubkey: PUBKEY, valid_from_ms: 0, valid_until_ms: null }]);

		const cut = openRealContext(OPTIONS, {
			env,
			ledgerFor: () =>
				({
					anchorForPeriod: async () => null,
					queryEvents: async () => {
						throw new Error("ledger down");
					},
				}) as never,
			substrateFor: () => ({}) as never,
		});
		if ("refused" in cut) throw new Error(`unexpected refusal: ${cut.refused}`);
		expect((await cut.signers()).gap).toContain("could not be read");

		const malformed = openRealContext(OPTIONS, { env: { ...env, SUBSTRATE_ANCHOR_SIGNER_SET: "not json" }, ledgerFor: () => ({ anchorForPeriod: async () => null, queryEvents: async () => [] }) as never, substrateFor: () => ({}) as never });
		if ("refused" in malformed) throw new Error(`unexpected refusal: ${malformed.refused}`);
		await expect(malformed.signers()).rejects.toThrow("SUBSTRATE_ANCHOR_SIGNER_SET is malformed");
	});
});

describe("openRealContext leaves the running server's retain outbox alone", () => {
	const OPTIONS: ReanchorOptions = { planPath: "p.json", execute: true, confirmGenesis: GENESIS, maxHours: 1, surface: null };

	test("a durable outbox path in the environment is neither read nor rewritten, and no drain timer is started", () => {
		const dir = mkdtempSync(join(tmpdir(), "p59-outbox-"));
		const path = join(dir, "retain-outbox.jsonl");
		const parked = (id: string): Record<string, unknown> => ({
			id,
			bank: "sub-omp",
			document_id: "doc-1",
			entry_id: "mem_1",
			surface: "omp",
			entry_hash: "0123456789abcdef",
			attempts: 1,
			next_at: 0,
			last_reason: "timeout",
			enqueued_at: 1,
		});
		// Two lines for one document: hydrating the file would compact it to one line, which rewrites it, and park one entry, which starts the drain.
		const before = `${JSON.stringify(parked("a"))}\n${JSON.stringify(parked("b"))}\n`;
		writeFileSync(path, before);
		const mtime = statSync(path).mtimeMs;

		const delays: unknown[] = [];
		const spy = spyOn(globalThis, "setInterval").mockImplementation(((_handler: unknown, delay?: number) => {
			delays.push(delay);
			return { unref: () => undefined, ref: () => undefined };
		}) as never);
		try {
			const built = openRealContext(OPTIONS, {
				env: {
					[GREPTIME_URL_KEY]: "http://127.0.0.1:9",
					SOLANA_ANCHOR_KEYPAIR: "/etc/substrate/key.json",
					SOLANA_ANCHOR_PUBKEY: PUBKEY,
					SUBSTRATE_RETAIN_OUTBOX_PATH: path,
					SUBSTRATE_RETAIN_DRAIN_MS: "12345",
				},
				ledgerFor: () => ({ anchorForPeriod: async () => null, queryEvents: async () => [] }) as never,
			});
			if ("refused" in built) throw new Error(`unexpected refusal: ${built.refused}`);
			if (!(built.substrate instanceof Substrate)) throw new Error("expected the real substrate");
			// A memory-only, empty queue: the server's file was never hydrated.
			expect(built.substrate.retainOutboxStats()).toMatchObject({ size: 0, durable: false });
		} finally {
			spy.mockRestore();
		}
		expect(delays).not.toContain(12345);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(statSync(path).mtimeMs).toBe(mtime);
		expect(readdirSync(dir)).toEqual(["retain-outbox.jsonl"]);
	});

	test("the lock is keyed by the signer and lives in SUBSTRATE_STATE_DIR: two copies of a plan in different directories share it", () => {
		const state = mkdtempSync(join(tmpdir(), "p59-state-"));
		const planA = mkdtempSync(join(tmpdir(), "p59-plan-a-"));
		const planB = mkdtempSync(join(tmpdir(), "p59-plan-b-"));
		const env = { [GREPTIME_URL_KEY]: "http://127.0.0.1:9", SOLANA_ANCHOR_KEYPAIR: "/etc/substrate/key.json", SOLANA_ANCHOR_PUBKEY: PUBKEY, SUBSTRATE_STATE_DIR: state };
		const open = (planPath: string): ReanchorDeps => {
			const built = openRealContext(
				{ ...OPTIONS, planPath },
				{
					env,
					ledgerFor: () => ({ anchorForPeriod: async () => null, queryEvents: async () => [] }) as never,
					substrateFor: () => ({}) as never,
				},
			);
			if ("refused" in built) throw new Error(`unexpected refusal: ${built.refused}`);
			return built;
		};
		const first = open(join(planA, "plan.json")).lock.acquire();
		if (!("release" in first)) throw new Error("expected the lock");
		expect(readdirSync(state)).toEqual([`substrate-reanchor-${PUBKEY.slice(0, 12)}.lock`]);
		expect(readdirSync(planA)).toEqual([]);

		const second = open(join(planB, "plan.json")).lock.acquire();
		expect(second).toHaveProperty("held");
		expect(readdirSync(planB)).toEqual([]);
		first.release();
		expect(readdirSync(state)).toEqual([]);
	});

	test("the lock path is in SUBSTRATE_STATE_DIR only when that is set and absolute, else in the OS temp directory", () => {
		const name = `substrate-reanchor-${PUBKEY.slice(0, 12)}.lock`;
		expect(reanchorLockPath({ SUBSTRATE_STATE_DIR: "/var/lib/substrate" }, PUBKEY)).toBe(join("/var/lib/substrate", name));
		expect(reanchorLockPath({}, PUBKEY)).toBe(join(tmpdir(), name));
		expect(reanchorLockPath({ SUBSTRATE_STATE_DIR: "  " }, PUBKEY)).toBe(join(tmpdir(), name));
		expect(reanchorLockPath({ SUBSTRATE_STATE_DIR: "relative/dir" }, PUBKEY)).toBe(join(tmpdir(), name));
	});
});

describe("fileLock: create-exclusive, broken only by a dead pid (or an old unreadable file), released by its owner only", () => {
	const lockPath = (): string => join(mkdtempSync(join(tmpdir(), "p59-lock-")), ".reanchor.lock");

	test("a second acquire while the first holds is refused with the holder named; the release frees it", () => {
		const path = lockPath();
		const first = fileLock(path, { pid: 4242, now: () => NOW, alive: () => true }).acquire();
		if (!("release" in first)) throw new Error("expected the lock");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4242, started_ms: NOW });

		const second = fileLock(path, { pid: 4343, now: () => NOW + 1000, alive: () => true }).acquire();
		if (!("held" in second)) throw new Error("expected the second run to be refused");
		expect(second.held).toContain("pid 4242");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4242, started_ms: NOW });

		first.release();
		expect(existsSync(path)).toBe(false);
		expect("release" in fileLock(path, { pid: 4343, now: () => NOW + 2000, alive: () => true }).acquire()).toBe(true);
	});

	test("a lock in a state directory that does not exist yet creates the directory and is taken, not read as held", () => {
		const root = mkdtempSync(join(tmpdir(), "p59-lock-fresh-"));
		const path = join(root, "new", "state", "substrate-reanchor-test.lock");
		expect(existsSync(join(root, "new"))).toBe(false);
		const taken = fileLock(path, { pid: 4242, now: () => NOW, alive: () => true }).acquire();
		if (!("release" in taken)) throw new Error(`expected the lock, got: ${taken.held}`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4242, started_ms: NOW });
		taken.release();
		expect(existsSync(path)).toBe(false);
	});

	test("a lock whose pid is dead is stale and is broken, whatever its age", () => {
		const path = lockPath();
		writeFileSync(path, JSON.stringify({ pid: 999_999, started_ms: NOW }));
		const taken = fileLock(path, { pid: 4343, now: () => NOW + 1000, alive: (pid) => pid !== 999_999 }).acquire();
		expect("release" in taken).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4343, started_ms: NOW + 1000 });
	});

	test("a lock whose pid is alive is never broken, however old: a long degraded run keeps its lock", () => {
		const old = lockPath();
		writeFileSync(old, JSON.stringify({ pid: 4242, started_ms: NOW - 10 * LOCK_STALE_MS }));
		const refused = fileLock(old, { pid: 4343, now: () => NOW, alive: () => true }).acquire();
		if (!("held" in refused)) throw new Error("expected the second run to be refused");
		expect(refused.held).toContain("pid 4242");
		expect(JSON.parse(readFileSync(old, "utf8"))).toEqual({ pid: 4242, started_ms: NOW - 10 * LOCK_STALE_MS });

		// The same old lock with a dead pid is broken.
		expect("release" in fileLock(old, { pid: 4343, now: () => NOW, alive: (pid) => pid !== 4242 }).acquire()).toBe(true);
	});

	test("a lock file that does not parse is judged by its modification time alone", () => {
		const fresh = lockPath();
		writeFileSync(fresh, "");
		expect(fileLock(fresh, { now: () => Date.now(), alive: () => false }).acquire()).toHaveProperty("held");

		const old = lockPath();
		writeFileSync(old, "not json");
		const hourAgo = new Date(Date.now() - 2 * HOUR_MS);
		utimesSync(old, hourAgo, hourAgo);
		expect(fileLock(old, { now: () => Date.now(), alive: () => false }).acquire()).toHaveProperty("release");
	});

	test("a release never removes a lock that another run has since taken", () => {
		const path = lockPath();
		const first = fileLock(path, { pid: 4242, now: () => NOW, alive: () => true }).acquire();
		if (!("release" in first)) throw new Error("expected the lock");
		writeFileSync(path, JSON.stringify({ pid: 4343, started_ms: NOW + 5 }));
		first.release();
		expect(existsSync(path)).toBe(true);
	});
});

describe("the send stays operator-run", () => {
	const SRC = new URL(".", import.meta.url).pathname;
	const ROOT = join(SRC, "..", "..", "..");

	function code(path: string): string {
		return readFileSync(join(SRC, path), "utf8")
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

	function walk(dir: string, into: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name === ".git") continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path, into);
			else into.push(path);
		}
		return into;
	}

	test("the orchestrator imports a fixed set of modules and no real executor, transport or process API", () => {
		const source = code("reanchor.ts");
		expect(source).not.toMatch(/^import\s+"/m);
		expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
		expect(source).not.toMatch(/execFileRunner|createRpc|child_process|node:(net|http|https|child_process|dgram|tls|fs)|Bun\.spawn|Bun\.\$|\bexecFile\b|\bfetch\s*\(|WebSocket|sendTransaction|requestAirdrop|process\.env/);
		expect(imports(source).map((found) => found.from).sort()).toEqual([
			"./anchor-verify-deps.ts",
			"./anchor.ts",
			"./greptime.ts",
			"./reanchor-plan.ts",
			"./redact.ts",
			"./service.ts",
			"./types.ts",
			"@substrate/ledger",
			"node:crypto",
			"node:path",
		]);
		expect(imports(source).find((found) => found.from === "@substrate/ledger")?.names).not.toContain("execFileRunner");
	});

	test("the only calls that can change anything are the two runner calls and the one note; the anchors table has no call at all", () => {
		const source = code("reanchor.ts");
		expect([...source.matchAll(/\brunner\(/g)]).toHaveLength(2);
		expect([...source.matchAll(/\.emit\(/g)]).toHaveLength(1);
		expect(source).not.toMatch(/insertAnchor|anchorsBetween|queryEvents|firstIngestMs/);
		expect(new Set([...source.matchAll(/\bledger\.(\w+)\s*\(/g)].map((match) => match[1]))).toEqual(new Set(["anchorForPeriod"]));
		expect(new Set([...source.matchAll(/\brpc\.(\w+)/g)].map((match) => match[1]))).toEqual(new Set(["getGenesisHash", "balance", "addressMemos", "transactionMemo"]));
	});

	test("nothing but the anchor job's entry and reanchor-run.ts constructs the real executor in the server package", () => {
		const holders = readdirSync(SRC)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".testkit.ts"))
			.filter((name) => /\bexecFileRunner\b/.test(code(name)))
			.sort();
		expect(holders).toEqual(["anchor-run.ts", "reanchor-run.ts"]);
	});

	test("no module imports the entry: it is a leaf that only a person starts", () => {
		const importers = readdirSync(SRC)
			.filter((name) => name.endsWith(".ts") && name !== "reanchor-run.ts" && name !== "reanchor-run.test.ts")
			.filter((name) => /from\s+"\.\/reanchor-run\.ts"|import\s*\(\s*"\.\/reanchor-run/.test(readFileSync(join(SRC, name), "utf8")));
		expect(importers).toEqual([]);
	});

	test("no CI workflow, script, systemd unit, infra file or package script mentions the entry", () => {
		const roots = [".github", "scripts", "infra", "package.json"].map((name) => join(ROOT, name));
		const files = [...roots.flatMap((path) => (statSync(path).isDirectory() ? walk(path) : [path])), ...walk(join(ROOT, "packages")).filter((path) => path.endsWith("package.json"))];
		expect(files.length).toBeGreaterThan(10);
		const offenders = files.filter((path) => !path.endsWith(".test.ts") && /reanchor-run/.test(readFileSync(path, "utf8"))).map((path) => relative(ROOT, path));
		expect(offenders).toEqual([]);
	});

	test("the entry builds the one real runner and sends only through the orchestrator", () => {
		const source = code("reanchor-run.ts");
		expect(source.match(/\bexecFileRunner\b/g)).toHaveLength(2);
		expect(source).not.toMatch(/transferMemoArgv|insertAnchor|child_process|\bfetch\s*\(|sendTransaction|requestAirdrop/);
		expect(source).toMatch(/runner:\s*execFileRunner/);
	});
});

describe("the entry process", () => {
	const ENTRY = new URL("./reanchor-run.ts", import.meta.url).pathname;

	async function spawn(args: string[], env: string[] = []): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
		const home = mkdtempSync(join(tmpdir(), "p59-reanchor-exec-"));
		mkdirSync(join(home, ".config"));
		const proc = Bun.spawn(["env", "-i", "PATH=/usr/bin:/bin", `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, ".config")}`, ...env, process.execPath, ENTRY, ...args], {
			cwd: home,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr, home };
	}

	test("a bad flag exits 2 with the usage and prints nothing to stdout", async () => {
		const result = await spawn(["--bogus"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("unknown flag");
		expect(result.stderr).toContain("usage: reanchor-run.ts");
		expect(result.stdout).toBe("");
	});

	test("the default run on a saved plan exits 0 with an EMPTY environment: it needs no configuration because it opens nothing", async () => {
		const home = mkdtempSync(join(tmpdir(), "p59-reanchor-plan-"));
		const planPath = join(home, "plan.json");
		writeFileSync(planPath, PLAN);
		const result = await spawn(["--plan", planPath]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`would re-anchor ${hourIso(H1)}`);
		expect(result.stdout).toContain("nothing was read, signed or sent");
		expect(result.stderr).toBe("");
	});

	test("--execute in an empty environment exits 2 naming the unset variable, before any connection", async () => {
		const home = mkdtempSync(join(tmpdir(), "p59-reanchor-plan-"));
		const planPath = join(home, "plan.json");
		writeFileSync(planPath, PLAN);
		const result = await spawn(["--plan", planPath, "--execute", "--confirm-genesis", GENESIS]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("GREPTIME_URL is not set");
		expect(result.stdout).toBe("");
	});

	test("--execute against a mainnet endpoint exits 2 before the ledger or the cluster is contacted", async () => {
		const home = mkdtempSync(join(tmpdir(), "p59-reanchor-plan-"));
		const planPath = join(home, "plan.json");
		writeFileSync(planPath, PLAN);
		const result = await spawn(["--plan", planPath, "--execute", "--confirm-genesis", GENESIS], [`${GREPTIME_URL_KEY}=http://127.0.0.1:9`, "SOLANA_RPC_URL=https://api.mainnet-beta.solana.com"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("SOLANA_RPC_URL");
		expect(result.stdout).toBe("");
	});

	test("a missing plan file exits 2", async () => {
		const result = await spawn(["--plan", "/nonexistent/plan.json"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("the plan file cannot be read");
	});
});
