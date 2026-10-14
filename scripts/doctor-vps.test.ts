/**
 * The VPS-hardening rows of the runtime doctor (uplift-4 S3): declared-versus-
 * effective scheduling weights and swap, whether the kernel can honour
 * IOWeight, and the report-only disk guardrails. Command output is fixture
 * text except one test that runs the real `du` on a scratch directory to pin
 * the hardlink behaviour the release accounting depends on. No test reads the
 * host's units, journal, state directory or secrets.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareUnit, declaredUnit, gatherRows, type Host, loadPolicy, type Policy, type Row } from "./doctor-runtime.ts";
import {
	classifyIoWeight,
	compareAudit,
	compareJournal,
	compareReleases,
	compareSliceWeights,
	compareState,
	DEFAULT_JOURNAL_MAX_MB,
	DEFAULT_RELEASE_MAX_GB,
	DEFAULT_STATE_MAX_GB,
	type DiskGuardrails,
	diskGuardrailsFromEnv,
	gatherDiskGuardrails,
	gatherIoEvidence,
	humanBytes,
	NESTED_SCAN_ENTRIES,
	nestedNewest,
	realScanFs,
	type ScanFs,
	type IoEvidence,
	parseAuditStat,
	parseDu,
	parseJournalUsage,
	safeName,
	stateOwner,
} from "./doctor-vps.ts";
import { parseSystemctlShow } from "./parity-check.ts";

const repoRoot = join(import.meta.dir, "..");
const infraDir = join(repoRoot, "infra", "vps");
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = 1_760_400_000;
const DAY = 86_400;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const ROOT = "/opt/agent-substrate";

function shown(props: Record<string, string>): ReadonlyMap<string, string> {
	return parseSystemctlShow(
		Object.entries(props)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n"),
	);
}

const BFQ_EVIDENCE: IoEvidence = {
	rootControllers: "cpuset cpu io memory pids",
	sliceIoWeight: "default 300",
	costQos: null,
	schedulers: "vda bfq\n",
};

describe("declared policy carries the new keys", () => {
	test("the repo slice declares CPUWeight=300, IOWeight=300 and ManagedOOMPreference=avoid; the mcp unit MemorySwapMax=0", () => {
		const policy = loadPolicy(infraDir);
		expect(policy.sliceWeights).toEqual({ cpuWeight: "300", ioWeight: "300" });
		expect(policy.units.find((u) => u.name === "substrate-mcp.service")?.memorySwapMax).toBe("0");
		expect(policy.sliceMemoryLow).toBe("2G");
	});
});

describe("MemorySwapMax: declared against effective", () => {
	const mcp = declaredUnit("substrate-mcp.service", "[Service]\nSlice=substrate.slice\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=512\n");
	const ok = { LoadState: "loaded", ActiveState: "active", Slice: "substrate.slice", MemoryMax: String(2 * GIB), MemorySwapMax: "0", TasksMax: "512", NRestarts: "0" };

	test("a host still at MemorySwapMax=infinity is drift naming both values", () => {
		const rows = compareUnit(mcp, shown({ ...ok, MemorySwapMax: "infinity" }));
		expect(rows[0]).toMatchObject({ class: "units", status: "drift", expected: "MemorySwapMax=0", actual: "MemorySwapMax=infinity" });
	});

	test("a host at 0 is ok, and a systemd that does not report the property is drift, not a silent pass", () => {
		expect(compareUnit(mcp, shown(ok))[0]).toMatchObject({ status: "ok" });
		const { MemorySwapMax: _omitted, ...without } = ok;
		expect(compareUnit(mcp, shown(without))[0]).toMatchObject({ status: "drift", actual: expect.stringContaining("MemorySwapMax=") });
	});
});

describe("CPUWeight and IOWeight: declared against effective, and the IOWeight honesty row", () => {
	const declared = { cpuWeight: "300", ioWeight: "300" };
	const loaded = { LoadState: "loaded", ActiveState: "active", CPUWeight: "300", IOWeight: "300" };
	const find = (rows: Row[], check: string): Row | undefined => rows.find((r) => r.check === check);

	test("today's host (weights [not set]) is drift on both rows", () => {
		const rows = compareSliceWeights(declared, shown({ ...loaded, CPUWeight: "[not set]", IOWeight: "[not set]" }), BFQ_EVIDENCE);
		expect(find(rows, "substrate.slice CPUWeight")).toMatchObject({ status: "drift", expected: "CPUWeight=300", actual: "CPUWeight=[not set]" });
		expect(find(rows, "substrate.slice IOWeight")).toMatchObject({ status: "drift", expected: "IOWeight=300", actual: "IOWeight=[not set]" });
	});

	test("matching weights with BFQ are ok, and the IOWeight row says it is enforceable", () => {
		const rows = compareSliceWeights(declared, shown(loaded), BFQ_EVIDENCE);
		expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
		expect(find(rows, "substrate.slice IOWeight")?.hint).toContain("BFQ");
	});

	test("matching IOWeight under mq-deadline without io.cost is a warn that says NOT enforced, never an ok", () => {
		const evidence: IoEvidence = { ...BFQ_EVIDENCE, schedulers: "vda mq-deadline\nvdb none\n", costQos: "253:0 enable=0 ctrl=auto\n" };
		const io = find(compareSliceWeights(declared, shown(loaded), evidence), "substrate.slice IOWeight");
		expect(io).toMatchObject({ status: "warn", actual: "as declared, NOT enforced" });
		expect(io?.hint).toContain("informational");
		expect(io?.hint).toContain("vda=mq-deadline");
		expect(io?.hint).toContain("io.cost is off");
	});

	test("io.cost enabled counts as enforceable without BFQ", () => {
		const verdict = classifyIoWeight({ ...BFQ_EVIDENCE, schedulers: "vda none\n", costQos: "253:0 enable=1 ctrl=user\n" });
		expect(verdict.status).toBe("ok");
		expect(verdict.detail).toContain("io.cost");
	});

	test("no io controller at the root, or none enabled for the slice, is a warn; unreadable evidence is unknown", () => {
		expect(classifyIoWeight({ ...BFQ_EVIDENCE, rootControllers: "cpu memory pids" }).status).toBe("warn");
		expect(classifyIoWeight({ ...BFQ_EVIDENCE, sliceIoWeight: null }).status).toBe("warn");
		expect(classifyIoWeight({ rootControllers: null, sliceIoWeight: null, costQos: null, schedulers: null }).status).toBe("unknown");
		expect(classifyIoWeight({ ...BFQ_EVIDENCE, schedulers: null, costQos: null }).status).toBe("unknown");
	});

	test("an uninstalled slice adds no weight rows (compareSlice already reports it)", () => {
		expect(compareSliceWeights(declared, shown({ LoadState: "not-found" }), BFQ_EVIDENCE)).toEqual([]);
		expect(compareSliceWeights(declared, null, BFQ_EVIDENCE)).toEqual([]);
	});
});

describe("du parsing and hardlink-aware release accounting", () => {
	// The lane report's false alarm: per-release `du` charged both trees the shared
	// node_modules (2.9 G each). One `du` over both, current first, charges the
	// second only what the first does not share.
	const SHARED = 2_910_000_000;
	const OWN_A = 38 * MIB;
	const OWN_B = 26 * MIB;
	const ONE_CALL = `${SHARED + OWN_A}\t${ROOT}/releases/${SHA_A}\n${OWN_B}\t${ROOT}/releases/${SHA_B}\n`;

	test("parseDu reads bytes and path per argument and drops anything else", () => {
		expect(parseDu(ONE_CALL)).toEqual([
			{ path: `${ROOT}/releases/${SHA_A}`, bytes: SHARED + OWN_A },
			{ path: `${ROOT}/releases/${SHA_B}`, bytes: OWN_B },
		]);
		expect(parseDu("du: cannot access 'x': No such file\nnot a line\n12\n\t/x\n")).toEqual([]);
	});

	test("one du over current then previous: the previous release is charged only its own 26 MB, and the total is the real footprint", () => {
		const entries = parseDu(ONE_CALL);
		const rows = compareReleases({ current: SHA_A, previous: SHA_B, entries }, 6 * GIB, `${ROOT}/releases`);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ class: "disk", status: "ok" });
		expect(rows[0]?.actual).toContain("2.8 GB over 2 release(s)");
		expect(rows[0]?.actual).toContain("aaaaaaaa current 2.7 GB");
		expect(rows[0]?.actual).toContain("bbbbbbbb previous 26 MB");
		expect(rows[0]?.actual).not.toContain("previous 2.");
	});

	test("the real du, run on scratch trees that share a hardlinked file, charges the shared bytes once", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-vps-du-"));
		try {
			const a = join(dir, "a");
			const b = join(dir, "b");
			mkdirSync(a);
			mkdirSync(b);
			writeFileSync(join(a, "shared.bin"), Buffer.alloc(2 * MIB, 1));
			linkSync(join(a, "shared.bin"), join(b, "shared.bin"));
			writeFileSync(join(a, "own.bin"), Buffer.alloc(64 * 1024, 2));
			writeFileSync(join(b, "own.bin"), Buffer.alloc(64 * 1024, 3));
			const run = (...paths: string[]) => {
				const result = spawnSync("du", ["-s", "--block-size=1", "--", ...paths], { encoding: "utf8" });
				return parseDu(result.stdout);
			};
			const alone = run(b);
			const together = run(a, b);
			expect(alone[0]?.bytes).toBeGreaterThan(2 * MIB);
			expect(together[0]?.bytes).toBeGreaterThan(2 * MIB);
			// b came second: the 2 MiB it shares with a is not charged again.
			expect(together[1]?.bytes).toBeLessThan(alone[0]?.bytes ?? 0);
			expect(together[1]?.bytes).toBeLessThan(MIB);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an extra release beyond current and previous becomes a would-reclaim row; over budget makes every row a warn", () => {
		const entries = [...parseDu(ONE_CALL), { path: `${ROOT}/releases/${SHA_C}`, bytes: 40 * MIB }];
		const under = compareReleases({ current: SHA_A, previous: SHA_B, entries }, 6 * GIB, `${ROOT}/releases`);
		expect(under.map((r) => r.status)).toEqual(["ok", "ok"]);
		expect(under[1]).toMatchObject({ check: `would-reclaim release ${SHA_C.slice(0, 12)}`, actual: "40 MB unique" });
		expect(under[1]?.hint).toContain("nothing was deleted");
		const over = compareReleases({ current: SHA_A, previous: SHA_B, entries }, 1 * GIB, `${ROOT}/releases`);
		expect(over.map((r) => r.status)).toEqual(["warn", "warn"]);
		expect(over[0]?.expected).toContain("SUBSTRATE_RETAIN_RELEASE_MAX_GB");
	});

	test("with no current or previous symlink nothing is called reclaimable", () => {
		const rows = compareReleases({ current: null, previous: null, entries: parseDu(ONE_CALL) }, 1 * GIB, `${ROOT}/releases`);
		expect(rows.map((r) => r.check.startsWith("would-reclaim"))).toEqual([false]);
	});

	test("an empty read is unknown, and a 0 budget disables the compare", () => {
		expect(compareReleases({ current: null, previous: null, entries: [] }, GIB, "x")[0]).toMatchObject({ status: "unknown" });
		const rows = compareReleases({ current: SHA_A, previous: SHA_B, entries: parseDu(ONE_CALL) }, 0, "x");
		expect(rows[0]).toMatchObject({ status: "ok", expected: "budget disabled (0)" });
	});
});

describe("state directory, journal and audit rows", () => {
	const children = [
		{ name: "agentos", type: "d", bytes: 318 * MIB, mtime: NOW - 2 * DAY },
		{ name: "mcp-audit.jsonl", type: "f", bytes: 4 * MIB, mtime: NOW - 60 },
		{ name: "phase3-baseline", type: "d", bytes: 120 * MIB, mtime: NOW - 90 * DAY },
		{ name: "worktrees", type: "d", bytes: 60 * MIB, mtime: NOW - 5 * DAY },
		{ name: "transcripts", type: "d", bytes: 30 * MIB, mtime: NOW - 45 * DAY },
		{ name: "doctor-last.json", type: "f", bytes: 1024, mtime: NOW - DAY },
	];

	test("under budget: a total row and the per-child rows with age and owner, no would-reclaim", () => {
		const rows = compareState(children, 2 * GIB, NOW, "/var/lib/substrate");
		expect(rows[0]).toMatchObject({ check: "state /var/lib/substrate", status: "ok" });
		expect(rows[0]?.actual).toBe("532 MB over 6 entries");
		const agentos = rows.find((r) => r.check === "state child agentos");
		expect(agentos).toMatchObject({ actual: "318 MB, 2.0d old" });
		expect(agentos?.hint).toContain("stop the unit");
		expect(rows.find((r) => r.check === "state child mcp-audit.jsonl")?.hint).toContain("never reclaimed");
		expect(rows.some((r) => r.check.startsWith("would-reclaim"))).toBe(false);
	});

	test("over budget: only a stale phase<N>-baseline directory is would-reclaim; live and unknown names never are", () => {
		const rows = compareState(children, 300 * MIB, NOW, "/var/lib/substrate");
		expect(rows[0]?.status).toBe("warn");
		const reclaim = rows.filter((r) => r.check.startsWith("would-reclaim"));
		// transcripts is live (the collectors write it) however old; agentos and the audit chain are owned.
		expect(reclaim.map((r) => r.check)).toEqual(["would-reclaim state phase3-baseline"]);
		expect(reclaim[0]?.status).toBe("warn");
		expect(reclaim[0]?.hint).toContain("nothing was deleted");
		const joined = JSON.stringify(reclaim);
		for (const name of ["mcp-audit", "agentos", "transcripts", "worktrees"]) expect(joined).not.toContain(name);
	});

	test("every live owner is never would-reclaim, even 400 days old and far over budget", () => {
		const live: Array<[string, string]> = [
			["skills", "d"],
			["dispatcher", "d"],
			["worktrees", "d"],
			["transcripts", "d"],
			["miner", "d"],
			["muse-plugin", "d"],
			["agentos", "d"],
			["desktop", "d"],
			["docs-canary-last.json", "f"],
			["docs-ingest.json", "f"],
			["slo-checkpoint.json", "f"],
			["slo-checkpoint.json.tmp", "f"],
			["retain-outbox.jsonl", "f"],
			["refused-emits.jsonl", "f"],
			["doctor-last.json", "f"],
			["grok-offsets.json", "f"],
			["herdr-offsets.json", "f"],
			["muse-offsets.json", "f"],
			["mcp-audit.jsonl", "f"],
			["mcp-audit.jsonl.1-900.jsonl", "f"],
			["ledger-archive", "d"],
			["index-archive", "d"],
		];
		const old = live.map(([name, type]) => ({ name, type, bytes: 100 * MIB, mtime: NOW - 400 * DAY }));
		const rows = compareState(old, 1 * MIB, NOW, "/var/lib/substrate");
		expect(rows[0]?.status).toBe("warn");
		expect(rows.filter((r) => r.check.startsWith("would-reclaim"))).toEqual([]);
		for (const [name, type] of live) expect(stateOwner(name, type).keep).toBe(true);
	});

	test("an unknown name is reported as `unknown owner` and never as would-reclaim, old or not", () => {
		const unknown = ["scratch", "phase3-baseline.bak", "phase-baseline", "skills2", "stuff.json", "Phase3-baseline"].map((name) => ({ name, type: "d", bytes: 100 * MIB, mtime: NOW - 400 * DAY }));
		const rows = compareState(unknown, 1 * MIB, NOW, "/var/lib/substrate");
		expect(rows.filter((r) => r.check.startsWith("would-reclaim"))).toEqual([]);
		const scratch = rows.find((r) => r.check === "state child scratch");
		expect(scratch?.hint).toContain("unknown owner");
		expect(stateOwner("scratch", "d")).toMatchObject({ keep: true, owner: expect.stringContaining("unknown owner") });
		// A file named like a baseline directory is not one.
		expect(stateOwner("phase3-baseline", "f").keep).toBe(true);
	});

	test("a baseline directory whose scan was cut is not reclaimable: its age is only a floor", () => {
		const cut = [{ name: "phase4-baseline", type: "d", bytes: 100 * MIB, mtime: NOW - 90 * DAY, ageCut: true }];
		const rows = compareState(cut, 1 * MIB, NOW, "/var/lib/substrate");
		expect(rows.filter((r) => r.check.startsWith("would-reclaim"))).toEqual([]);
		expect(rows.find((r) => r.check === "state child phase4-baseline")?.actual).toContain("scan cut");
	});

	describe("a directory's age is the newest mtime inside it", () => {
		interface FakeEntry {
			name: string;
			isDir: boolean;
			mtime: number;
		}
		/** A tree of directories by path; `reads` counts every entry a scan pulls out of any directory, `opens` every directory opened. */
		function fakeFs(tree: Record<string, FakeEntry[]>) {
			const counters = { reads: 0, opens: [] as string[] };
			const mtimes: Record<string, number> = {};
			for (const [dir, entries] of Object.entries(tree)) for (const e of entries) mtimes[`${dir}/${e.name}`] = e.mtime;
			const scan: ScanFs = {
				open(path) {
					counters.opens.push(path);
					const entries = tree[path];
					if (entries === undefined) return null;
					let at = 0;
					return {
						next() {
							const entry = entries[at];
							if (entry === undefined) return null;
							at += 1;
							counters.reads += 1;
							return { name: entry.name, isDir: entry.isDir };
						},
						close() {},
					};
				},
				mtime: (path) => mtimes[path] ?? null,
			};
			return { scan, counters };
		}
		const OLD = NOW - 90 * DAY;
		const file = (name: string, mtime: number): FakeEntry => ({ name, isDir: false, mtime });

		test("nestedNewest takes the freshest child over the directory's own old mtime, at depth 2 and no deeper", () => {
			const { scan, counters } = fakeFs({
				"/d": [file("a", OLD), { name: "sub", isDir: true, mtime: OLD }],
				"/d/sub": [file("b", NOW - 120), { name: "deep", isDir: true, mtime: OLD }],
				"/d/sub/deep": [file("too-deep", NOW - 1)],
			});
			expect(nestedNewest(scan, "/d", OLD)).toEqual({ mtime: NOW - 120, cut: false });
			expect(counters.opens).toEqual(["/d", "/d/sub"]);
		});

		test("a directory of 5000 entries is scanned for at most 200 entries and marked incomplete", () => {
			const big = Array.from({ length: 5000 }, (_, i) => file(`f${i}`, i < 200 ? OLD : NOW - 5));
			const { scan, counters } = fakeFs({ "/big": big });
			expect(nestedNewest(scan, "/big", OLD)).toEqual({ mtime: OLD, cut: true });
			// 200 visited plus the one extra read that proves there is more; never the other 4799.
			expect(counters.reads).toBeLessThanOrEqual(NESTED_SCAN_ENTRIES + 1);
		});

		test("the budget is shared across levels: many small subdirectories also stop at 200 visited entries", () => {
			const tree: Record<string, FakeEntry[]> = { "/m": Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, isDir: true, mtime: OLD })) };
			for (let i = 0; i < 100; i += 1) tree[`/m/s${i}`] = Array.from({ length: 50 }, (_, k) => file(`f${k}`, OLD));
			const { scan, counters } = fakeFs(tree);
			expect(nestedNewest(scan, "/m", OLD).cut).toBe(true);
			expect(counters.reads).toBeLessThanOrEqual(NESTED_SCAN_ENTRIES + 2);
			expect(counters.opens.length).toBeLessThan(100);
		});

		test("a small directory is scanned fully and not marked incomplete, including exactly 200 entries", () => {
			const small = fakeFs({ "/s": [file("a", OLD), file("b", NOW - 30)] });
			expect(nestedNewest(small.scan, "/s", OLD)).toEqual({ mtime: NOW - 30, cut: false });
			expect(small.counters.reads).toBe(2);
			const exact = fakeFs({ "/e": Array.from({ length: NESTED_SCAN_ENTRIES }, (_, i) => file(`f${i}`, OLD)) });
			expect(nestedNewest(exact.scan, "/e", OLD)).toEqual({ mtime: OLD, cut: false });
		});

		test("an unreadable directory leaves the directory's own mtime as an incomplete floor", () => {
			expect(nestedNewest(fakeFs({}).scan, "/gone", 123)).toEqual({ mtime: 123, cut: true });
		});

		test("the real filesystem scan reads a scratch directory and sees its newest file", () => {
			const dir = mkdtempSync(join(tmpdir(), "doctor-vps-scan-"));
			try {
				mkdirSync(join(dir, "sub"));
				writeFileSync(join(dir, "sub", "fresh.txt"), "x");
				const seen = nestedNewest(realScanFs, dir, 1);
				expect(seen.cut).toBe(false);
				expect(seen.mtime).toBeGreaterThan(1_000_000_000);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("end to end: an old baseline directory with a fresh file inside is not would-reclaim; with nothing fresh it is", () => {
			const host: Host = {
				run(argv) {
					if (argv[0] === "find") {
						return { code: 0, out: `/var/lib/substrate/phase6-baseline\t${OLD}.0\td\n/var/lib/substrate/other\t${OLD}.0\td\n` };
					}
					if (argv[0] === "du") return { code: 0, out: argv.slice(4).map((p) => `${100 * MIB}\t${p}\n`).join("") };
					return null;
				},
				readText: () => null,
				sleep: async () => {},
				now: () => NOW,
			};
			const inside = (fresh: boolean): ScanFs =>
				fakeFs({
					"/var/lib/substrate/phase6-baseline": [file("f", fresh ? NOW - 30 : OLD - DAY)],
					"/var/lib/substrate/other": [file("g", OLD)],
				}).scan;
			const guard = { ...GUARD, stateMaxBytes: MIB };
			const fresh = gatherDiskGuardrails(host, guard, inside(true));
			expect(fresh.filter((r) => r.check.startsWith("would-reclaim state"))).toEqual([]);
			const stale = gatherDiskGuardrails(host, guard, inside(false));
			// `other` is an unknown owner: never proposed, only the baseline directory is.
			expect(stale.filter((r) => r.check.startsWith("would-reclaim state")).map((r) => r.check)).toEqual(["would-reclaim state phase6-baseline"]);
			expect(stale.find((r) => r.check === "state child other")?.hint).toContain("unknown owner");
		});
	});

	test("the per-child list is capped and the rest summed; names are printable and bounded", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ name: `child-${i}`, type: "d", bytes: (i + 1) * MIB, mtime: NOW }));
		const rows = compareState(many, 0, NOW, "/var/lib/substrate");
		expect(rows.filter((r) => r.check.startsWith("state child child-"))).toHaveLength(8);
		expect(rows.find((r) => r.check === "state child (others)")?.actual).toContain("over 12 more entries");
		expect(safeName("a\nb\x1b[31mc")).toBe("a?b?[31mc");
		expect(safeName("x".repeat(500)).length).toBe(64);
	});

	test("stateOwner names the audit chain and every live owner, and calls anything else an unknown owner", () => {
		expect(stateOwner("mcp-audit.jsonl.1-900.jsonl", "f").keep).toBe(true);
		expect(stateOwner("mcp-audit.checkpoint", "f").keep).toBe(true);
		expect(stateOwner("agentos", "d").keep).toBe(true);
		expect(stateOwner("desktop", "d").keep).toBe(true);
		expect(stateOwner("grok-offsets.json", "f").keep).toBe(true);
		expect(stateOwner("doctor-last.json", "f").keep).toBe(true);
		// A live owner's name is protected whatever the entry's kind.
		expect(stateOwner("doctor-last.json", "d").keep).toBe(true);
		const asDir = compareState([{ name: "doctor-last.json", type: "d", bytes: 100 * MIB, mtime: NOW - 400 * DAY }], MIB, NOW, "/var/lib/substrate");
		expect(asDir.filter((r) => r.check.startsWith("would-reclaim"))).toEqual([]);
		expect(stateOwner("never-heard-of-it", "d").owner).toContain("unknown owner");
		expect(stateOwner("phase1-baseline", "d").keep).toBe(false);
	});

	test("journal: 329.6M parses, is under the 400M default, and over budget prints the vacuum it did not run", () => {
		expect(parseJournalUsage("Archived and active journals take up 329.6M in the file system.\n")).toBe(Math.round(329.6 * MIB));
		expect(parseJournalUsage("Archived and active journals take up 1.2G in the file system.")).toBe(Math.round(1.2 * GIB));
		expect(parseJournalUsage("take up 512B")).toBe(512);
		expect(parseJournalUsage("no journal")).toBeNull();
		expect(compareJournal(Math.round(329.6 * MIB), 400 * MIB)).toMatchObject([{ check: "journal size", status: "ok", actual: "330 MB" }]);
		const over = compareJournal(600 * MIB, 400 * MIB);
		expect(over.map((r) => r.status)).toEqual(["warn", "warn"]);
		expect(over[1]).toMatchObject({ check: "would-reclaim journal", actual: "200 MB to reach the budget" });
		expect(over[1]?.hint).toContain("--vacuum-size=400M");
		expect(over[1]?.hint).toContain("nothing was run");
		expect(compareJournal(null, 400 * MIB)[0]).toMatchObject({ status: "unknown" });
	});

	test("audit chain: size and average daily growth since the oldest file, ok whatever it says", () => {
		const files = parseAuditStat(`${NOW - 10 * DAY}\t${8 * MIB}\t/var/lib/substrate/mcp-audit.jsonl.1-100.jsonl\n${NOW - 2 * DAY}\t${MIB}\t/var/lib/substrate/mcp-audit.jsonl\n`);
		expect(files).toHaveLength(2);
		const rowOut = compareAudit(files, NOW);
		expect(rowOut).toMatchObject({ class: "disk", status: "ok", expected: "report only; never pruned" });
		expect(rowOut.actual).toContain("9.0 MB in 2 file(s)");
		expect(rowOut.actual).toContain("≈ 922 KB/day");
		expect(compareAudit([{ birth: 0, bytes: MIB }], NOW).actual).toContain("daily growth n/a");
		expect(compareAudit([], NOW).status).toBe("unknown");
	});

	test("humanBytes", () => {
		expect(humanBytes(26 * MIB)).toBe("26 MB");
		expect(humanBytes(Math.round(2.9 * GIB))).toBe("2.9 GB");
		expect(humanBytes(512)).toBe("512 B");
	});
});

describe("budgets from the environment", () => {
	test("defaults come from the lane report numbers and bad values fall back to them", () => {
		const g = diskGuardrailsFromEnv({}, ROOT);
		expect(g).toMatchObject({ releaseRoot: ROOT, stateDir: "/var/lib/substrate" });
		expect(g.releaseMaxBytes).toBe(DEFAULT_RELEASE_MAX_GB * GIB);
		expect(g.stateMaxBytes).toBe(DEFAULT_STATE_MAX_GB * GIB);
		expect(g.journalMaxBytes).toBe(DEFAULT_JOURNAL_MAX_MB * MIB);
		expect([DEFAULT_RELEASE_MAX_GB, DEFAULT_STATE_MAX_GB, DEFAULT_JOURNAL_MAX_MB]).toEqual([6, 1, 400]);
		const bad = diskGuardrailsFromEnv({ SUBSTRATE_RETAIN_RELEASE_MAX_GB: "lots", SUBSTRATE_STATE_MAX_GB: "-3", SUBSTRATE_JOURNAL_MAX_MB: "1,2" }, ROOT);
		expect(bad.releaseMaxBytes).toBe(6 * GIB);
		expect(bad.stateMaxBytes).toBe(1 * GIB);
		expect(bad.journalMaxBytes).toBe(400 * MIB);
		const set = diskGuardrailsFromEnv({ SUBSTRATE_RETAIN_RELEASE_MAX_GB: "10", SUBSTRATE_STATE_MAX_GB: "0.5", SUBSTRATE_JOURNAL_MAX_MB: "0" }, ROOT);
		expect(set).toMatchObject({ releaseMaxBytes: 10 * GIB, stateMaxBytes: GIB / 2, journalMaxBytes: 0 });
	});
});

/** A host answering the disk guardrails' fixed argv, recording each one. */
function diskHost(options: { journal?: string | null; releaseBytes?: Record<string, number> } = {}) {
	const calls: string[][] = [];
	const bytesByPath: Record<string, number> = {
		[`${ROOT}/releases/${SHA_A}`]: 2_910_000_000 + 38 * MIB,
		[`${ROOT}/releases/${SHA_B}`]: 26 * MIB,
		[`${ROOT}/releases/${SHA_C}`]: 40 * MIB,
		"/var/lib/substrate/agentos": 318 * MIB,
		"/var/lib/substrate/mcp-audit.jsonl": 9 * MIB,
		"/var/lib/substrate/phase3-baseline": 120 * MIB,
		...options.releaseBytes,
	};
	const host: Host = {
		run(argv) {
			calls.push([...argv]);
			const [cmd] = argv;
			if (cmd === "readlink") return { code: 0, out: argv[2]?.endsWith("/current") ? `releases/${SHA_A}\n` : `releases/${SHA_B}\n` };
			if (cmd === "ls") return { code: 0, out: `${SHA_A}\n${SHA_B}\n${SHA_C}\nnot-a-release\n` };
			if (cmd === "du") {
				const paths = argv.slice(4);
				return { code: 0, out: paths.map((p) => `${bytesByPath[p] ?? 0}\t${p}\n`).join("") };
			}
			if (cmd === "find") {
				return {
					code: 0,
					out: `/var/lib/substrate/agentos\t${NOW - 2 * DAY}.0\td\n/var/lib/substrate/mcp-audit.jsonl\t${NOW - 60}.5\tf\n/var/lib/substrate/phase3-baseline\t${NOW - 90 * DAY}.0\td\n`,
				};
			}
			if (cmd === "journalctl") {
				return options.journal === null ? null : { code: 0, out: options.journal ?? "Archived and active journals take up 329.6M in the file system.\n" };
			}
			if (cmd === "stat") return { code: 0, out: `${NOW - 10 * DAY}\t${9 * MIB}\t/var/lib/substrate/mcp-audit.jsonl\n` };
			return null;
		},
		readText: () => null,
		sleep: async () => {},
		now: () => NOW,
	};
	return { host, calls };
}

const GUARD: DiskGuardrails = diskGuardrailsFromEnv({}, ROOT);

describe("gatherDiskGuardrails", () => {
	test("releases go through ONE du, current first, then previous, then the rest newest first", () => {
		const { host, calls } = diskHost();
		const rows = gatherDiskGuardrails(host, GUARD);
		const dus = calls.filter((c) => c[0] === "du" && c[4]?.includes("/releases/"));
		expect(dus).toEqual([["du", "-s", "--block-size=1", "--", `${ROOT}/releases/${SHA_A}`, `${ROOT}/releases/${SHA_B}`, `${ROOT}/releases/${SHA_C}`]]);
		const main = rows.find((r) => r.check.startsWith("releases unique bytes"));
		expect(main?.actual).toContain("current");
		expect(main?.actual).toContain("previous 26 MB");
		expect(rows.find((r) => r.check === `would-reclaim release ${SHA_C.slice(0, 12)}`)).toMatchObject({ actual: "40 MB unique" });
	});

	test("every row is class disk, none is drift, and every command is a read-only fixed argv", () => {
		const { host, calls } = diskHost({ journal: "Archived and active journals take up 900.0M in the file system.\n" });
		const rows = gatherDiskGuardrails(host, { ...GUARD, releaseMaxBytes: 1, stateMaxBytes: 1, journalMaxBytes: MIB });
		expect(rows.length).toBeGreaterThan(8);
		expect(rows.every((r) => r.class === "disk")).toBe(true);
		expect(rows.some((r) => r.status === "drift")).toBe(false);
		expect(rows.some((r) => r.status === "warn")).toBe(true);
		expect(rows.some((r) => r.check.startsWith("would-reclaim"))).toBe(true);
		const readOnly = new Set(["readlink", "ls", "du", "find", "journalctl", "stat"]);
		for (const call of calls) expect(readOnly.has(call[0] ?? "")).toBe(true);
		// find is the only one that could delete, and only with -delete or -exec: neither is ever passed.
		for (const call of calls.filter((c) => c[0] === "find")) expect(call.some((a) => a === "-delete" || a === "-exec")).toBe(false);
		expect(calls.some((c) => c[0] === "journalctl" && c.some((a) => a.startsWith("--vacuum")))).toBe(false);
		expect(JSON.stringify(calls)).not.toContain("rm");
	});

	test("missing commands make unknown rows, never drift and never a throw", () => {
		const host: Host = { run: () => null, readText: () => null, sleep: async () => {}, now: () => NOW };
		const rows = gatherDiskGuardrails(host, GUARD);
		expect(rows.map((r) => r.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
	});
});

describe("entries past the du cap are reported, never silently dropped", () => {
	const sha = (i: number): string => i.toString(16).padStart(40, "0");
	/** 70 releases listed newest first (sha(1) newest ... sha(70) oldest); current is sha(5), previous sha(9). */
	function manyHost() {
		const calls: string[][] = [];
		const host: Host = {
			run(argv) {
				calls.push([...argv]);
				const [cmd] = argv;
				if (cmd === "readlink") return { code: 0, out: argv[2]?.endsWith("/current") ? `releases/${sha(5)}\n` : `releases/${sha(9)}\n` };
				if (cmd === "ls") return { code: 0, out: `${Array.from({ length: 70 }, (_, i) => sha(i + 1)).join("\n")}\n` };
				if (cmd === "du") return { code: 0, out: argv.slice(4).map((p) => `${MIB}\t${p}\n`).join("") };
				if (cmd === "find") {
					// Directory order: oldest first, so a cut in find order would keep the stale ones.
					return { code: 0, out: Array.from({ length: 70 }, (_, i) => `/var/lib/substrate/d${i}\t${NOW - (70 - i) * DAY}.0\td\n`).join("") };
				}
				return null;
			},
			readText: () => null,
			sleep: async () => {},
			now: () => NOW,
		};
		return { host, calls };
	}

	test("70 releases: du gets 64 paths with current, previous and the newest kept, and the row says 6 more are not measured and is not ok", () => {
		const { host, calls } = manyHost();
		const rows = gatherDiskGuardrails(host, GUARD);
		const du = calls.find((c) => c[0] === "du" && c[4]?.includes("/releases/"));
		const paths = du?.slice(4) ?? [];
		expect(paths).toHaveLength(64);
		expect(paths.slice(0, 2)).toEqual([`${ROOT}/releases/${sha(5)}`, `${ROOT}/releases/${sha(9)}`]);
		expect(paths).toContain(`${ROOT}/releases/${sha(1)}`);
		expect(paths).not.toContain(`${ROOT}/releases/${sha(70)}`);
		const main = rows.find((r) => r.check.startsWith("releases unique bytes"));
		expect(main?.actual).toContain("6 more not measured");
		expect(main?.status).toBe("unknown");
	});

	test("a cut total that is already over budget stays a warn (a proven breach), and a complete one is ok", () => {
		const entries = [{ path: `${ROOT}/releases/${SHA_A}`, bytes: 2 * GIB }];
		expect(compareReleases({ current: SHA_A, previous: null, entries, notMeasured: 3 }, GIB, "x")[0]).toMatchObject({ status: "warn" });
		expect(compareReleases({ current: SHA_A, previous: null, entries, notMeasured: 3 }, 6 * GIB, "x")[0]).toMatchObject({ status: "unknown" });
		expect(compareReleases({ current: SHA_A, previous: null, entries, notMeasured: 0 }, 6 * GIB, "x")[0]).toMatchObject({ status: "ok" });
		expect(compareReleases({ current: SHA_A, previous: null, entries }, 6 * GIB, "x")[0]).toMatchObject({ status: "ok" });
	});

	test("70 state children: the cut keeps the newest regardless of find's order, and the row says 6 more are not measured and is not ok", () => {
		const { host, calls } = manyHost();
		const rows = gatherDiskGuardrails(host, GUARD);
		const du = calls.find((c) => c[0] === "du" && c[4]?.includes("/var/lib/substrate/"));
		const paths = du?.slice(4) ?? [];
		expect(paths).toHaveLength(64);
		// d69 is the newest (1 day old); d0 the oldest (70 days old) and is cut.
		expect(paths[0]).toBe("/var/lib/substrate/d69");
		expect(paths).not.toContain("/var/lib/substrate/d0");
		const state = rows.find((r) => r.check === "state /var/lib/substrate");
		expect(state?.actual).toContain("6 more not measured");
		expect(state?.status).toBe("unknown");
	});

	test("a state child du could not read counts as not measured too", () => {
		const children = [{ name: "a", type: "d", bytes: MIB, mtime: NOW }];
		expect(compareState(children, GIB, NOW, "/var/lib/substrate", 2)[0]).toMatchObject({ status: "unknown" });
		expect(compareState(children, GIB, NOW, "/var/lib/substrate", 0)[0]).toMatchObject({ status: "ok" });
		expect(compareState(children, MIB / 2, NOW, "/var/lib/substrate", 2)[0]).toMatchObject({ status: "warn" });
	});
});

describe("through gatherRows", () => {
	const policy: Policy = loadPolicy(infraDir);

	function systemctlHost(inner: Host): Host {
		return {
			...inner,
			run(argv) {
				if (argv[0] === "systemctl") return { code: 0, out: "LoadState=not-found\n" };
				return inner.run(argv);
			},
		};
	}

	test("the disk guardrails are gathered only when the options carry them, and never raise the exit code", async () => {
		const { host } = diskHost();
		const base = { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" };
		const without = await gatherRows(policy, systemctlHost(host), base);
		expect(without.some((r) => r.check.startsWith("releases unique bytes"))).toBe(false);
		const withDisk = await gatherRows(policy, systemctlHost(host), { ...base, disk: { ...GUARD, releaseMaxBytes: 1 } });
		expect(withDisk.some((r) => r.check.startsWith("releases unique bytes"))).toBe(true);
		const guardrailRows = withDisk.filter((r) => !without.some((w) => w.check === r.check));
		expect(guardrailRows.length).toBeGreaterThan(5);
		expect(guardrailRows.some((r) => r.status === "drift")).toBe(false);
		expect(withDisk.filter((r) => r.status === "drift").length).toBe(without.filter((r) => r.status === "drift").length);
	});

	/** A ScanFs whose directories open fine and then throw ENOENT, as one removed by another process does. */
	function vanishing(where: "read" | "lstat" | "close" | "open"): ScanFs {
		const enoent = (): never => {
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
		};
		return {
			open() {
				if (where === "open") return enoent();
				let at = 0;
				return {
					next() {
						if (where === "read") return enoent();
						at += 1;
						return at === 1 ? { name: "f", isDir: false } : null;
					},
					close() {
						if (where === "close") enoent();
					},
				};
			},
			mtime() {
				return where === "lstat" ? enoent() : NOW - 5;
			},
		};
	}

	test("a state directory that vanishes mid-scan (ENOENT from open, read, lstat or close) never aborts gatherRows: every other row is still returned", async () => {
		const { host } = diskHost();
		const base = { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" };
		const reference = await gatherRows(policy, systemctlHost(host), { ...base, disk: { ...GUARD, scan: vanishing("close") } });
		for (const where of ["open", "read", "lstat", "close"] as const) {
			const rows = await gatherRows(policy, systemctlHost(host), { ...base, disk: { ...GUARD, stateMaxBytes: MIB, scan: vanishing(where) } });
			expect(rows.map((r) => r.check)).toEqual(expect.arrayContaining(["journal size", "audit chain size", "state /var/lib/substrate"]));
			expect(rows.length).toBeGreaterThanOrEqual(reference.length - 2);
			// Nothing about the unreadable directories is offered for reclaim.
			if (where !== "close") expect(rows.filter((r) => r.check.startsWith("would-reclaim state"))).toEqual([]);
		}
	});

	test("nestedNewest marks the directory incomplete when any scan call throws, and never throws itself", () => {
		for (const where of ["open", "read", "lstat"] as const) {
			expect(nestedNewest(vanishing(where), "/d", 7).cut).toBe(true);
		}
		// A close that throws loses nothing that was read.
		expect(nestedNewest(vanishing("close"), "/d", 7)).toEqual({ mtime: NOW - 5, cut: false });
		// An open that reports null (unreadable) is a floor too, not "fully scanned".
		expect(nestedNewest({ open: () => null, mtime: () => null }, "/gone", 123)).toEqual({ mtime: 123, cut: true });
	});

	test("a host whose commands throw leaves every disk section as an unknown row instead of throwing", () => {
		const exploding: Host = {
			run() {
				throw new Error("spawn exploded");
			},
			readText: () => null,
			sleep: async () => {},
			now: () => NOW,
		};
		const rows = gatherDiskGuardrails(exploding, GUARD, vanishing("read"));
		expect(rows.length).toBeGreaterThanOrEqual(4);
		expect(rows.every((r) => r.status === "unknown")).toBe(true);
		expect(gatherIoEvidence(exploding).schedulers).toBeNull();
	});
});
