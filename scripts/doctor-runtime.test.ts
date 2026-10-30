import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiskPressure } from "../packages/fleet/src/index.ts";
import {
	compareWorktreeDisk,
	optionsFromEnv,
	worktreeOptionsFromEnv,
	compareCheckout,
	compareDisk,
	compareLegacyKey,
	compareRedis,
	compareSlice,
	compareSwap,
	compareTimer,
	compareUnit,
	declaredUnit,
	driftClasses,
	type EmitEvent,
	emitDrift,
	environmentNames,
	eventsToEmit,
	exitCode,
	EXPECTED_TIMERS,
	formatBytes,
	gatherRows,
	type Host,
	LEGACY_KEYS,
	loadPolicy,
	main,
	parseArgs,
	parseBytes,
	parseDfAvailableKb,
	parseMeminfoSwap,
	parseRedisConf,
	parseRedisConfigGet,
	parseVmstatSwap,
	type Policy,
	readEmitState,
	RELEASE_UNITS,
	type Row,
} from "./doctor-runtime.ts";
import { parseSystemctlShow } from "./parity-check.ts";

const repoRoot = join(import.meta.dir, "..");
const infraDir = join(repoRoot, "infra", "vps");

/** `systemctl show` text from key/value pairs, in the order systemd happens to print them. */
function shown(props: Record<string, string>): ReadonlyMap<string, string> {
	return parseSystemctlShow(
		Object.entries(props)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n"),
	);
}

const MCP = declaredUnit(
	"substrate-mcp.service",
	readFileSync(join(infraDir, "substrate-mcp.service"), "utf8"),
	[readFileSync(join(infraDir, "substrate-mcp.service.d", "10-environment.conf"), "utf8")],
);

const MCP_OK = {
	LoadState: "loaded",
	ActiveState: "active",
	Slice: "substrate.slice",
	MemoryMax: String(2 * 2 ** 30),
	MemorySwapMax: "0",
	TasksMax: "512",
	NRestarts: "0",
	Environment: "SUBSTRATE_RETAIN_OUTBOX_PATH=/var/lib/substrate/retain-outbox.jsonl SUBSTRATE_DOCS_STATE_FILE=/var/lib/substrate/docs-ingest.json",
};

describe("declared policy", () => {
	test("the repo mcp unit declares the R7 ceilings and its Environment names", () => {
		expect(MCP).toMatchObject({ slice: "substrate.slice", memoryMax: "2G", tasksMax: "512" });
		expect(MCP.environmentNames).toEqual(["SUBSTRATE_DOCS_STATE_FILE", "SUBSTRATE_RETAIN_OUTBOX_PATH"]);
	});

	test("a drop-in's Environment= adds a name, and names are names only", () => {
		const unit = declaredUnit("x.service", "[Service]\nMemoryMax=1G\n", ["[Service]\nEnvironment=SUBSTRATE_INDEX_SWEEP=dry-run\n"]);
		expect(unit.environmentNames).toEqual(["SUBSTRATE_INDEX_SWEEP"]);
		expect(JSON.stringify(unit)).not.toContain("dry-run");
	});

	test("environmentNames never yields a value, even one that contains an equals sign", () => {
		expect(environmentNames('A=1 "B=x y=z" C="q=r" NOTAVAR 9X=1')).toEqual(["A", "B", "C"]);
	});

	test("the repo redis conf is the R7 cache policy", () => {
		expect(parseRedisConf(readFileSync(join(infraDir, "redis-substrate.conf"), "utf8"))).toEqual({
			maxmemory: "256mb",
			maxmemoryPolicy: "volatile-lru",
			save: "",
			appendonly: "no",
		});
		// Several save lines accumulate; a later `save ""` clears them, as redis does.
		expect(parseRedisConf('save 3600 1\nsave 300 100\n').save).toBe("3600 1 300 100");
		expect(parseRedisConf('save 3600 1\nsave ""\n').save).toBe("");
	});

	test("loadPolicy reads every substrate unit, the slice and the redis drop-in", () => {
		const policy = loadPolicy(infraDir);
		expect(policy.units.map((u) => u.name)).toContain("substrate-doctor.service");
		expect(policy.sliceMemoryLow).toBe("2G");
		expect(policy.redisUnitMemoryMax).toBe("768M");
		for (const unit of policy.units) expect(unit.slice).toBe("substrate.slice");
	});

	test("sizes: systemd and redis spellings meet in bytes", () => {
		expect(parseBytes("2G")).toBe(2 ** 31);
		expect(parseBytes("256mb")).toBe(256 * 2 ** 20);
		expect(parseBytes("768M")).toBe(parseBytes("805306368"));
		expect(parseBytes("infinity")).toBe("infinity");
		expect(parseBytes("0")).toBe(0);
		expect(parseBytes("lots")).toBeNull();
		expect(formatBytes(2 ** 31)).toBe("2G");
		expect(formatBytes(3 * 2 ** 20 + 1)).toBe(String(3 * 2 ** 20 + 1));
	});
});

describe("units", () => {
	test("MemoryMax=infinity on the host against 2G in the file is drift naming the unit", () => {
		const rows = compareUnit(MCP, shown({ ...MCP_OK, MemoryMax: "infinity" }));
		const limits = rows.find((r) => r.check === "substrate-mcp.service");
		expect(limits).toMatchObject({ class: "units", status: "drift", expected: "MemoryMax=2G", actual: "MemoryMax=infinity" });
		expect(limits?.hint).toContain("NRestarts=0");
	});

	test("a declared Environment name missing on the host is drift listing the name only", () => {
		const rows = compareUnit(MCP, shown({ ...MCP_OK, Environment: "SUBSTRATE_DOCS_STATE_FILE=/var/lib/substrate/docs-ingest.json" }));
		const env = rows.find((r) => r.check === "substrate-mcp.service Environment");
		expect(env).toMatchObject({ status: "drift", actual: "missing: SUBSTRATE_RETAIN_OUTBOX_PATH" });
		expect(JSON.stringify(rows)).not.toContain("/var/lib/substrate");
	});

	test("the host as declared is ok on both rows", () => {
		const rows = compareUnit(MCP, shown(MCP_OK));
		expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
	});

	test("a staged unit that is not installed is unknown; a release unit that is not installed is drift", () => {
		const anchor = declaredUnit("substrate-anchor.service", "[Service]\nSlice=substrate.slice\nMemoryMax=1G\n");
		expect(compareUnit(anchor, shown({ LoadState: "not-found" }))).toMatchObject([{ status: "unknown" }]);
		expect(RELEASE_UNITS).toContain("substrate-collector-grok.service");
		const grok = declaredUnit("substrate-collector-grok.service", "[Service]\nSlice=substrate.slice\nMemoryMax=512M\n");
		expect(compareUnit(grok, shown({ LoadState: "not-found" }))).toMatchObject([{ status: "drift", actual: "LoadState=not-found" }]);
	});

	test("a release unit that is installed but not active is drift; a oneshot that is inactive is not", () => {
		const grok = declaredUnit("substrate-collector-grok.service", "[Service]\nSlice=substrate.slice\nMemoryMax=512M\nTasksMax=256\n");
		const inactive = { LoadState: "loaded", ActiveState: "failed", Slice: "substrate.slice", MemoryMax: String(512 * 2 ** 20), TasksMax: "256", NRestarts: "3" };
		expect(compareUnit(grok, shown(inactive))).toMatchObject([{ status: "drift", actual: "ActiveState=failed" }]);
		const anchor = declaredUnit("substrate-anchor.service", "[Service]\nSlice=substrate.slice\nMemoryMax=1G\n");
		expect(compareUnit(anchor, shown({ ...inactive, ActiveState: "inactive", MemoryMax: String(2 ** 30) }))).toMatchObject([{ status: "ok" }]);
	});

	test("the slice must be installed, active and at the declared MemoryLow", () => {
		expect(compareSlice("2G", shown({ LoadState: "not-found" }))).toMatchObject({ class: "slice", status: "drift" });
		expect(compareSlice("2G", shown({ LoadState: "loaded", ActiveState: "active", MemoryLow: "0" }))).toMatchObject({
			status: "drift",
			actual: "MemoryLow=0",
		});
		expect(compareSlice("2G", shown({ LoadState: "loaded", ActiveState: "active", MemoryLow: String(2 ** 31) }))).toMatchObject({ status: "ok" });
	});
});

describe("redis", () => {
	const declared = parseRedisConf(readFileSync(join(infraDir, "redis-substrate.conf"), "utf8"));
	const unitOk = shown({ LoadState: "loaded", MemoryMax: String(768 * 2 ** 20) });

	test("today's host (maxmemory 0, noeviction, RDB snapshots on) is three drift rows", () => {
		const config = new Map([
			["maxmemory", "0"],
			["maxmemory-policy", "noeviction"],
			["save", "3600 1 300 100 60 10000"],
			["appendonly", "no"],
		]);
		const rows = compareRedis(declared, "768M", { config, usedMemoryHuman: "1.02M" }, unitOk);
		const byCheck = Object.fromEntries(rows.map((r) => [r.check, r.status]));
		expect(byCheck).toEqual({
			"redis maxmemory": "drift",
			"redis maxmemory-policy": "drift",
			"redis save": "drift",
			"redis appendonly": "ok",
			"redis-server.service MemoryMax": "ok",
		});
		expect(rows.find((r) => r.check === "redis maxmemory")).toMatchObject({ expected: "256M", actual: "0" });
		expect(rows.find((r) => r.check === "redis save")?.expected).toContain("no RDB snapshots");
		expect(exitCode(rows)).toBe(2);
	});

	test("an unreachable redis is unknown on every conf row and does not fail the run", () => {
		const rows = compareRedis(declared, "768M", { config: null, usedMemoryHuman: null }, shown({ LoadState: "loaded", MemoryMax: "infinity" }));
		expect(rows.filter((r) => r.check.startsWith("redis ")).map((r) => r.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
		expect(rows.find((r) => r.check === "redis maxmemory")?.hint).toContain("unreachable");
		// The unit ceiling is a systemd fact and is still compared: infinity against the drop-in's 768M.
		expect(rows.find((r) => r.check === "redis-server.service MemoryMax")).toMatchObject({ status: "drift", actual: "MemoryMax=infinity" });
		expect(exitCode(rows.filter((r) => r.check.startsWith("redis ")))).toBe(0);
	});

	test("redis-cli config get prints key then value; an empty save is an empty line, a refused connection has no key", () => {
		expect(parseRedisConfigGet("save", "save\n\n")).toBe("");
		expect(parseRedisConfigGet("maxmemory", "maxmemory\n268435456\n")).toBe("268435456");
		expect(parseRedisConfigGet("maxmemory", "Could not connect to Redis at 127.0.0.1:6379: Connection refused\n")).toBeNull();
	});
});

describe("timers", () => {
	const now = 1_760_400_000;
	const anchor = EXPECTED_TIMERS.find((t) => t.name === "substrate-anchor.timer");
	const sweep = EXPECTED_TIMERS.find((t) => t.name === "substrate-index-sweep.timer");
	if (!anchor || !sweep) throw new Error("expected timers missing");

	test("the anchor timer not found is drift (BP-7); the sweep timer not found is unknown and says it is opt-in", () => {
		expect(compareTimer(anchor, shown({ LoadState: "not-found" }), now)).toMatchObject({ class: "timers", status: "drift" });
		const sweepRow = compareTimer(sweep, shown({ LoadState: "not-found" }), now);
		expect(sweepRow.status).toBe("unknown");
		expect(sweepRow.hint).toContain("opt-in");
	});

	test("installed, enabled, active and recently fired is ok; disabled, inactive or stale is drift", () => {
		const live = { LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", LastTriggerUSec: `@${now - 1800}` };
		expect(compareTimer(anchor, shown(live), now)).toMatchObject({ status: "ok" });
		expect(compareTimer(anchor, shown(live), now).actual).toContain("30m ago");
		expect(compareTimer(anchor, shown({ ...live, UnitFileState: "disabled" }), now)).toMatchObject({ status: "drift" });
		expect(compareTimer(anchor, shown({ ...live, ActiveState: "inactive" }), now)).toMatchObject({ status: "drift" });
		expect(compareTimer(anchor, shown({ ...live, LastTriggerUSec: `@${now - 3 * 3600}` }), now)).toMatchObject({ status: "drift" });
		// A day-old tick is inside the sweep's two periods.
		expect(compareTimer(sweep, shown({ ...live, LastTriggerUSec: `@${now - 86_400}` }), now)).toMatchObject({ status: "ok" });
		expect(compareTimer(anchor, shown({ ...live, LastTriggerUSec: "" }), now)).toMatchObject({ status: "ok" });
	});
});

describe("disk", () => {
	const gb = (n: number) => n * 1024 * 1024;
	test("df -Pk's fourth column of the second line is the available kilobytes", () => {
		expect(parseDfAvailableKb("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 500000000 470000000 28311552 95% /\n")).toBe(28_311_552);
		expect(parseDfAvailableKb("df: /opt/agent-substrate: No such file or directory\n")).toBeNull();
	});

	test("27 GB free with a 5 GB floor is ok, 4 GB is drift, 9 GB is warn and warn does not fail the run", () => {
		expect(compareDisk(gb(27), 5)).toMatchObject({ class: "disk", status: "ok", actual: "27.0 GB free" });
		expect(compareDisk(gb(4), 5)).toMatchObject({ status: "drift" });
		const warn = compareDisk(gb(9), 5);
		expect(warn.status).toBe("warn");
		expect(warn.hint).toContain("10 GB");
		expect(exitCode([warn])).toBe(0);
		expect(compareDisk(gb(1), 0)).toMatchObject({ status: "ok" });
		expect(compareDisk(null, 5)).toMatchObject({ status: "unknown" });
	});
});

describe("swap", () => {
	const meminfo = "MemTotal:       32000000 kB\nSwapTotal:      15728640 kB\nSwapFree:        3145728 kB\n";
	test("12 GiB occupied with nothing paging is ok, with the occupancy in the hint", () => {
		const sample = { pswpin: 1000, pswpout: 2000 };
		const r = compareSwap(sample, sample, 1000, parseMeminfoSwap(meminfo), 0);
		expect(r).toMatchObject({ class: "swap", status: "ok", actual: "0.0 pages/s over 1.0s" });
		expect(r.hint).toContain("swap 12.0 GiB of 15.0 GiB in use");
	});

	test("pages moving between the two reads is drift", () => {
		const r = compareSwap({ pswpin: 1000, pswpout: 2000 }, { pswpin: 1004, pswpout: 2000 }, 1000, parseMeminfoSwap(meminfo), 0);
		expect(r).toMatchObject({ status: "drift", actual: "4.0 pages/s over 1.0s" });
		expect(parseVmstatSwap("nr_free_pages 1\npswpin 7\npswpout 9\n")).toEqual({ pswpin: 7, pswpout: 9 });
		expect(parseVmstatSwap("nr_free_pages 1\n")).toBeNull();
		expect(compareSwap(null, null, 1000, null, 0)).toMatchObject({ status: "unknown" });
	});
});

// The legacy key is spelled only inside packages/mcp-server/src (store-lock.test.ts); tests take it from the table.
// A function, not a narrowed const: the narrowing would not reach the closures below.
function firstLegacyKey(): (typeof LEGACY_KEYS)[number] {
	const key = LEGACY_KEYS[0];
	if (!key) throw new Error("no legacy keys");
	return key;
}
const LEGACY = firstLegacyKey();

describe("legacy env keys", () => {
	test("a present legacy key is drift with the config.ts hint, by name only", () => {
		const r = compareLegacyKey(LEGACY, true, "/etc/substrate/substrate.env");
		expect(r).toMatchObject({ class: "env", status: "drift", actual: `${LEGACY.name} set` });
		expect(r.hint).toContain(LEGACY.replacement);
		expect(compareLegacyKey(LEGACY, false, "/etc/substrate/substrate.env")).toMatchObject({ status: "ok" });
		expect(compareLegacyKey(LEGACY, null, "/etc/substrate/substrate.env")).toMatchObject({ status: "unknown" });
	});
});

// ── Whole runs against a fixture host ────────────────────────────────────────

const SENTINEL = "SENTINEL-VALUE-cafef00d";
const BEARER = "bearer-value-deadbeef";

interface FixtureHost {
	host: Host;
	calls: string[][];
}

/**
 * A host answering every argv the doctor issues. `showByUnit` wins per unit;
 * anything else systemd is asked about is not-found. The env file is a
 * string the fake grep searches, so its values exist only here.
 */
function fixtureHost(input: {
	policy: Policy;
	showByUnit?: Record<string, string>;
	redis?: Record<string, string> | null;
	dfAvailableKb?: number;
	envFile?: string;
	vmstat?: [string, string];
	git?: { branch: string; originBranch: string | null; originSha: string | null; behind: number | null; upstream?: string | null };
}): FixtureHost {
	const calls: string[][] = [];
	const vmstat = input.vmstat ?? ["pswpin 10\npswpout 20\n", "pswpin 10\npswpout 20\n"];
	let vmstatReads = 0;
	const host: Host = {
		run(argv) {
			calls.push([...argv]);
			const [cmd, sub] = argv;
			if (cmd === "systemctl" && sub === "show") {
				const unit = argv[2] ?? "";
				const text = input.showByUnit?.[unit];
				return { code: 0, out: text ?? "LoadState=not-found\nActiveState=inactive\n" };
			}
			if (cmd === "redis-cli") {
				if (input.redis === null || input.redis === undefined) return { code: 1, out: "Could not connect to Redis at 127.0.0.1:6379: Connection refused\n" };
				if (argv[3] === "config") {
					const key = argv[5] ?? "";
					return { code: 0, out: `${key}\n${input.redis[key] ?? ""}\n` };
				}
				return { code: 0, out: "# Memory\nused_memory:1000\nused_memory_human:1000B\n" };
			}
			if (cmd === "df") {
				const kb = input.dfAvailableKb ?? 27 * 1024 * 1024;
				return { code: 0, out: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1 1 ${kb} 50% /\n` };
			}
			if (cmd === "grep") {
				const pattern = argv[3] ?? "";
				const name = pattern.slice(1, pattern.indexOf("="));
				if (input.envFile === undefined) return { code: 2, out: "" };
				const set = input.envFile.split("\n").some((line) => line.startsWith(`${name}=`) && line.length > name.length + 1);
				return { code: set ? 0 : 1, out: "" };
			}
			if (cmd === "lsblk") return { code: 0, out: "vda bfq\n" };
			if (cmd === "git" && input.git !== undefined) {
				const git = input.git;
				const verb = argv[3];
				if (verb === "rev-parse") {
					if (argv[5] !== "@{u}") return { code: 0, out: `${git.branch}\n` };
					return git.upstream ? { code: 0, out: `${git.upstream}\n` } : { code: 128, out: "fatal: no upstream configured\n" };
				}
				if (verb === "ls-remote") {
					if (git.originSha === null) return { code: 128, out: "fatal: unable to access 'origin'\n" };
					const ref = git.originBranch === null ? "" : `ref: refs/heads/${git.originBranch}\tHEAD\n`;
					return { code: 0, out: `${ref}${git.originSha}\tHEAD\n` };
				}
				if (verb === "rev-list") return git.behind === null ? { code: 128, out: "fatal: bad revision\n" } : { code: 0, out: `${git.behind}\n` };
			}
			return null;
		},
		readText(path) {
			if (path === "/proc/vmstat") return vmstat[Math.min(vmstatReads++, 1)] ?? null;
			if (path === "/proc/meminfo") return "SwapTotal:      15728640 kB\nSwapFree:       15728640 kB\n";
			if (path === "/sys/fs/cgroup/cgroup.controllers") return "cpuset cpu io memory pids\n";
			if (path === "/sys/fs/cgroup/substrate.slice/io.weight") return "default 300\n";
			return null;
		},
		sleep: async () => {},
		now: () => 1_760_400_000,
	};
	return { host, calls };
}

/** `systemctl show` text for a unit exactly as declared, so the fixture host can be fully green. */
function asDeclared(policy: Policy): Record<string, string> {
	const out: Record<string, string> = {};
	for (const unit of policy.units) {
		const bytes = parseBytes(unit.memoryMax);
		out[unit.name] = [
			"LoadState=loaded",
			"ActiveState=active",
			`Slice=${unit.slice ?? ""}`,
			`MemoryMax=${bytes === "infinity" || bytes === null ? "infinity" : bytes}`,
			`MemorySwapMax=${unit.memorySwapMax ?? "infinity"}`,
			`TasksMax=${unit.tasksMax ?? "4915"}`,
			"NRestarts=0",
			`Environment=${unit.environmentNames.map((n) => `${n}=${SENTINEL}`).join(" ")}`,
		].join("\n");
	}
	out["substrate.slice"] = [
		"LoadState=loaded",
		"ActiveState=active",
		`MemoryLow=${parseBytes(policy.sliceMemoryLow)}`,
		`CPUWeight=${policy.sliceWeights.cpuWeight ?? "[not set]"}`,
		`IOWeight=${policy.sliceWeights.ioWeight ?? "[not set]"}`,
	].join("\n");
	out["redis-server.service"] = `LoadState=loaded\nMemoryMax=${parseBytes(policy.redisUnitMemoryMax)}`;
	for (const timer of EXPECTED_TIMERS) {
		out[timer.name] = `LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nLastTriggerUSec=@${1_760_400_000 - 600}`;
	}
	return out;
}

const GREEN_REDIS = { maxmemory: "268435456", "maxmemory-policy": "volatile-lru", save: "", appendonly: "no" };

describe("a whole run", () => {
	const policy = loadPolicy(infraDir);

	test("a host exactly as declared is all ok and exits 0; every command is a fixed argv, never a shell", async () => {
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n" });
		const rows = await gatherRows(policy, fx.host, { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" });
		expect(rows.filter((r) => r.status !== "ok").map((r) => `${r.check}: ${r.status}`)).toEqual([]);
		expect(exitCode(rows)).toBe(0);
		expect(driftClasses(rows)).toEqual([]);
		for (const call of fx.calls) expect(call[0]).toMatch(/^(systemctl|redis-cli|df|grep|lsblk)$/);
		expect(fx.calls.some((c) => c.join(" ").includes("sh -c"))).toBe(false);
		expect(fx.calls).toContainEqual(["grep", "-q", "--", `^${LEGACY.name}=.`, "/etc/substrate/substrate.env"]);
		expect(JSON.stringify(rows)).not.toContain(SENTINEL);
	});

	test("today's VPS: redis at defaults, anchor and sweep timers not found, legacy key set → drift in redis, timers, env", async () => {
		const showByUnit = asDeclared(policy);
		delete showByUnit["substrate-anchor.timer"];
		delete showByUnit["substrate-index-sweep.timer"];
		showByUnit["redis-server.service"] = "LoadState=loaded\nMemoryMax=infinity";
		const fx = fixtureHost({
			policy,
			showByUnit,
			redis: { maxmemory: "0", "maxmemory-policy": "noeviction", save: "3600 1 300 100 60 10000", appendonly: "no" },
			envFile: `${LEGACY.name}=${SENTINEL}\n`,
		});
		const rows = await gatherRows(policy, fx.host, { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" });
		expect(driftClasses(rows)).toEqual(["redis", "timers", "env"]);
		expect(rows.find((r) => r.check === "substrate-index-sweep.timer")?.status).toBe("unknown");
		expect(exitCode(rows)).toBe(2);
		expect(JSON.stringify(rows)).not.toContain(SENTINEL);
	});

	test("main prints the table or --json and returns the exit code", async () => {
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, dfAvailableKb: 4 * 1024 * 1024, envFile: "" });
		const out: string[] = [];
		const err: string[] = [];
		const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), post: async () => true };
		const code = await main(["--infra", infraDir], fx.host, {}, io);
		expect(code).toBe(2);
		expect(out.join("")).toContain("disk /opt/agent-substrate");
		expect(out.join("")).toMatch(/runtime doctor: 1 drift/);
		out.length = 0;
		expect(await main(["--infra", infraDir, "--json"], fx.host, {}, io)).toBe(2);
		const parsed = JSON.parse(out.join("")) as { rows: Row[]; drift: string[] };
		expect(parsed.drift).toEqual(["disk"]);
		expect(parsed.rows.find((r) => r.class === "disk")).toMatchObject({ status: "drift", actual: "4.0 GB free" });
		expect(await main(["--bogus"], fx.host, {}, io)).toBe(1);
		expect(err.join("")).toContain("unknown argument --bogus");
	});
});

describe("emit", () => {
	function drifted(): Row[] {
		return [
			{ class: "redis", check: "redis maxmemory", status: "drift", expected: "256M", actual: "0", hint: "" },
			{ class: "redis", check: "redis save", status: "drift", expected: '""', actual: "3600 1", hint: "" },
			{ class: "env", check: `/etc/substrate/substrate.env ${LEGACY.name}`, status: "drift", expected: "unset", actual: `${LEGACY.name} set`, hint: "" },
			{ class: "disk", check: "disk /opt/agent-substrate", status: "warn", expected: "≥ 5 GB", actual: "9.0 GB free", hint: "" },
		];
	}

	/** An in-memory state file, POST log and stderr for `emitDrift`; `ok` is what every POST answers. */
	function fake(initialState: string | null = null, ok = true) {
		const posts: Array<{ url: string; body: EmitEvent; bearer: string }> = [];
		const stderr: string[] = [];
		const file = { state: initialState };
		return {
			posts,
			stderr,
			file,
			io: {
				readState: () => file.state,
				writeState: (text: string) => {
					file.state = text;
				},
				post: async (url: string, body: EmitEvent, bearer: string) => {
					posts.push({ url, body, bearer });
					return ok;
				},
				stderr: (t: string) => {
					stderr.push(t);
				},
			},
		};
	}

	const ENV = { SUBSTRATE_DOCTOR_EMIT: "1", SUBSTRATE_TOKEN: BEARER, SUBSTRATE_URL: "http://127.0.0.1:7410/" };

	test("one warning per drift class, to SUBSTRATE_URL/events, as the substrate surface with payload.runtime doctor", async () => {
		const fx = fake();
		expect(await emitDrift(drifted(), ENV, fx.io, "2026-10-13T12:00:00Z")).toEqual(["redis", "env"]);
		expect(fx.posts.map((p) => p.url)).toEqual(["http://127.0.0.1:7410/events", "http://127.0.0.1:7410/events"]);
		const redis = fx.posts[0]?.body;
		expect(redis).toMatchObject({ surface: "substrate", kind: "warning", payload: { action: "doctor", runtime: "doctor", class: "redis" } });
		expect(redis?.payload.checks).toEqual([
			{ check: "redis maxmemory", expected: "256M", actual: "0" },
			{ check: "redis save", expected: '""', actual: "3600 1" },
		]);
		expect(redis?.summary.length).toBeLessThanOrEqual(200);
		expect(redis?.summary).toContain("redis maxmemory");
		expect(fx.posts.every((p) => p.bearer === BEARER)).toBe(true);
		// The bearer rides in the Authorization header only: never in a body or on stderr.
		expect(JSON.stringify(fx.posts.map((p) => p.body))).not.toContain(BEARER);
		expect(fx.stderr.join("")).not.toContain(BEARER);
	});

	test("an unchanged drift set is not re-emitted; a changed set is; a cleared class is forgotten", async () => {
		const fx = fake();
		await emitDrift(drifted(), ENV, fx.io);
		expect(fx.posts).toHaveLength(2);
		await emitDrift(drifted(), ENV, fx.io);
		expect(fx.posts).toHaveLength(2);
		// The actual value moving (a different save line) is the same drift set: still no re-emit.
		const moved = drifted().map((r) => (r.check === "redis save" ? { ...r, actual: "60 10000" } : r));
		await emitDrift(moved, ENV, fx.io);
		expect(fx.posts).toHaveLength(2);
		// One more redis check drifting is a changed set for that class only.
		const grown = [...drifted(), { class: "redis" as const, check: "redis appendonly", status: "drift" as const, expected: "no", actual: "yes", hint: "" }];
		expect(await emitDrift(grown, ENV, fx.io)).toEqual(["redis"]);
		expect(fx.posts).toHaveLength(3);
		// Env cleared, then drifts again: emitted again, because the state forgot it.
		const envCleared = grown.filter((r) => r.class !== "env");
		expect(await emitDrift(envCleared, ENV, fx.io)).toEqual([]);
		expect(readEmitState(fx.file.state).emitted).toEqual({ redis: ["redis appendonly", "redis maxmemory", "redis save"] });
		expect(await emitDrift(grown, ENV, fx.io)).toEqual(["env"]);
	});

	test("--emit without SUBSTRATE_DOCTOR_EMIT=1 posts nothing and says why; without a bearer likewise", async () => {
		const off = fake();
		expect(await emitDrift(drifted(), { SUBSTRATE_TOKEN: BEARER }, off.io)).toEqual([]);
		expect(off.posts).toHaveLength(0);
		expect(off.stderr.join("")).toContain("SUBSTRATE_DOCTOR_EMIT");
		expect(off.file.state).toBeNull();
		// The tokens dir is pointed away from the host's, so a real /etc/substrate/tokens/substrate cannot leak into the test.
		const noToken = fake();
		expect(await emitDrift(drifted(), { SUBSTRATE_DOCTOR_EMIT: "1", SUBSTRATE_TOKENS_DIR: join(import.meta.dir, "no-such-tokens") }, noToken.io)).toEqual([]);
		expect(noToken.posts).toHaveLength(0);
		expect(noToken.stderr.join("")).toContain("no bearer");
	});

	test("the shared env's SUBSTRATE_TOKEN_SUBSTRATE is the host-job bearer when SUBSTRATE_TOKEN is unset", async () => {
		const fx = fake();
		await emitDrift(drifted(), { SUBSTRATE_DOCTOR_EMIT: "1", SUBSTRATE_TOKEN_SUBSTRATE: BEARER }, fx.io);
		expect(fx.posts.map((p) => p.bearer)).toEqual([BEARER, BEARER]);
	});

	test("a rotated SUBSTRATE_TOKEN_SUBSTRATE list sends only its first entry as the bearer", async () => {
		// During a rotation the server's variable lists `old,new`; the whole
		// list as one bearer is a 401 and the drift warnings would fall silent.
		const OLD = "bearer-old-0123456789ab";
		const NEW = "bearer-new-ba9876543210";
		const comma = fake();
		await emitDrift(drifted(), { SUBSTRATE_DOCTOR_EMIT: "1", SUBSTRATE_TOKEN_SUBSTRATE: `${OLD},${NEW}` }, comma.io);
		expect(comma.posts.map((p) => p.bearer)).toEqual([OLD, OLD]);
		for (const p of comma.posts) {
			expect(p.bearer).not.toContain(",");
			expect(p.bearer).not.toContain(NEW);
		}
		// Whitespace separators and a leading separator behave the same: first non-empty entry.
		const spaced = fake();
		await emitDrift(drifted(), { SUBSTRATE_DOCTOR_EMIT: "1", SUBSTRATE_TOKEN_SUBSTRATE: ` \n${OLD} ${NEW}` }, spaced.io);
		expect(spaced.posts.map((p) => p.bearer)).toEqual([OLD, OLD]);
		// Nothing on stderr names a value.
		expect(`${comma.stderr.join("")}${spaced.stderr.join("")}`).not.toMatch(/bearer-(?:old|new)/);
	});

	test("a POST that is not stored keeps the previous record so the next run retries", async () => {
		const failing = fake(null, false);
		expect(await emitDrift(drifted(), ENV, failing.io)).toEqual([]);
		expect(readEmitState(failing.file.state).emitted).toEqual({});
		expect(failing.stderr.join("")).toContain("will retry");
		const corrupt = readEmitState("{not json");
		expect(corrupt.emitted).toEqual({});
	});

	test("the JSON body never carries a value from the env file, only the key name", async () => {
		const policy = loadPolicy(infraDir);
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: `${LEGACY.name}=${SENTINEL}\nSUBSTRATE_TOKEN_SUBSTRATE=${BEARER}\n` });
		const rows = await gatherRows(policy, fx.host, { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" });
		expect(driftClasses(rows)).toEqual(["env"]);
		const events = eventsToEmit(rows, { emitted: {} }, "2026-10-13T12:00:00Z");
		expect(events).toHaveLength(1);
		const body = JSON.stringify(events[0]?.event);
		expect(body).toContain(LEGACY.name);
		expect(body).not.toContain(SENTINEL);
		expect(body).not.toContain(BEARER);
	});
});

describe("worktree disk row", () => {
	const GIB = 1024 ** 3;
	const policy = loadPolicy(infraDir);
	const pressure = (freeGb: number, floorGb: number): DiskPressure => ({
		freeBytes: freeGb * GIB,
		minFreeBytes: floorGb * GIB,
		ok: freeGb >= floorGb,
		worktrees: [
			{ path: "/wts/huge", bytes: 9 * GIB },
			{ path: "/wts/big", bytes: 4 * GIB },
			{ path: "/wts/mid", bytes: 2 * GIB },
			{ path: "/wts/unmeasured", bytes: null },
			{ path: "/wts/small", bytes: 1 },
		],
	});

	test("below the floor it warns, naming free space, the floor and the three largest worktrees, and never fails the run", async () => {
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n" });
		const rows = await gatherRows(policy, fx.host, {
			minFreeGb: 5,
			maxSwapPagesPerSecond: 0,
			envFile: "/etc/substrate/substrate.env",
			worktrees: { roots: ["/wts"], minFreeGb: 5, measure: async () => pressure(2, 5) },
		});
		const row = rows.find((candidate) => candidate.check === "worktree disk");
		expect(row).toMatchObject({ class: "disk", status: "warn" });
		expect(row?.actual).toContain("2.0 GB free");
		expect(row?.actual).toContain("5.0 GB floor");
		expect(row?.actual).toContain("/wts/huge 9.0 GB; /wts/big 4.0 GB; /wts/mid 2.0 GB");
		expect(row?.actual).not.toContain("/wts/small");
		expect(exitCode(rows)).toBe(0);
	});

	test("at or above the floor it is ok, and a failed scan is unknown, not drift", async () => {
		expect(compareWorktreeDisk(pressure(50, 5))).toMatchObject({ status: "ok", actual: "50.0 GB free" });
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n" });
		const rows = await gatherRows(policy, fx.host, {
			minFreeGb: 5,
			maxSwapPagesPerSecond: 0,
			envFile: "/etc/substrate/substrate.env",
			worktrees: {
				roots: ["/wts"],
				minFreeGb: 5,
				measure: async () => {
					throw new Error("git is missing");
				},
			},
		});
		expect(rows.find((candidate) => candidate.check === "worktree disk")).toMatchObject({ status: "unknown" });
		expect(exitCode(rows)).toBe(0);
	});

	test("the row exists only when SUBSTRATE_WORKTREE_ROOTS is set, and takes its floor from SUBSTRATE_WORKTREE_MIN_FREE_GB", () => {
		expect(optionsFromEnv({}).worktrees).toBeUndefined();
		expect(optionsFromEnv({ SUBSTRATE_WORKTREE_ROOTS: "" }).worktrees).toBeUndefined();
		expect(optionsFromEnv({ SUBSTRATE_WORKTREE_ROOTS: "/a:/b" }).worktrees).toMatchObject({ roots: ["/a", "/b"], minFreeGb: 5 });
		expect(worktreeOptionsFromEnv({ SUBSTRATE_WORKTREE_ROOTS: "/a", SUBSTRATE_WORKTREE_MIN_FREE_GB: "12" }).worktrees?.minFreeGb).toBe(12);
	});
});

describe("checkout", () => {
	const policy = loadPolicy(infraDir);
	const DIR = "/srv/agent-substrate";
	const SHA = "a".repeat(40);
	type GitFixture = NonNullable<Parameters<typeof fixtureHost>[0]["git"]>;
	const runWith = async (git: GitFixture, checkouts: readonly string[] = [DIR]) => {
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n", git });
		const rows = await gatherRows(policy, fx.host, { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env", checkouts });
		return { rows, calls: fx.calls, checkout: rows.filter((r) => r.class === "checkout") };
	};

	test("on the default branch and up to date, both rows are ok and the run is green", async () => {
		const run = await runWith({ branch: "main", originBranch: "main", originSha: SHA, behind: 0 });
		expect(run.checkout.map((r) => [r.check, r.status])).toEqual([
			[`checkout ${DIR} branch`, "ok"],
			[`checkout ${DIR} behind`, "ok"],
		]);
		expect(run.checkout[1]?.actual).toBe("0 commits behind origin/main");
		expect(exitCode(run.rows)).toBe(0);
	});

	test("behind origin's head warns with the actual count, and counts from the head the remote named", async () => {
		const run = await runWith({ branch: "main", originBranch: "main", originSha: SHA, behind: 3 });
		expect(run.checkout[0]).toMatchObject({ status: "ok" });
		expect(run.checkout[1]).toMatchObject({ status: "warn", actual: "3 commits behind origin/main" });
		expect(run.calls).toContainEqual(["git", "-C", DIR, "rev-list", "--count", `HEAD..${SHA}`]);
		expect(exitCode(run.rows)).toBe(0);
	});

	test("on another branch it warns and names that branch, and never drifts", async () => {
		const run = await runWith({ branch: "feature/r15", originBranch: "main", originSha: SHA, behind: 0 });
		expect(run.checkout[0]).toMatchObject({ status: "warn", expected: "on main", actual: "on feature/r15" });
		expect(run.checkout.some((r) => r.status === "drift")).toBe(false);
		expect(exitCode(run.rows)).toBe(0);
	});

	test("a head not in local history leaves behind unknown, and the branch row still reads", async () => {
		const run = await runWith({ branch: "main", originBranch: "main", originSha: SHA, behind: null });
		expect(run.checkout[0]).toMatchObject({ status: "ok" });
		expect(run.checkout[1]).toMatchObject({ status: "unknown" });
		expect(run.checkout[1]?.hint).toContain("never fetches");
	});

	test("an origin with no HEAD line leaves behind unknown, not drift, and the branch row still reads", () => {
		const fx = fixtureHost({ policy, git: { branch: "main", originBranch: "main", originSha: null, behind: 0 } });
		const rows = compareCheckout(DIR, fx.host, { defaultBranch: "main", sha: null });
		expect(rows[0]).toMatchObject({ status: "ok" });
		expect(rows[1]).toMatchObject({ status: "unknown" });
		expect(rows.some((r) => r.status === "drift")).toBe(false);
	});

	test("an origin default branch that cannot be read is one unknown row", async () => {
		const run = await runWith({ branch: "main", originBranch: null, originSha: SHA, behind: 0 });
		expect(run.checkout).toEqual([expect.objectContaining({ check: `checkout ${DIR}`, status: "unknown" })]);
	});

	test("a detached HEAD warns, and every git call is fixed argv on that directory", () => {
		const fx = fixtureHost({ policy, git: { branch: "HEAD", originBranch: "main", originSha: SHA, behind: 0 } });
		const rows = compareCheckout(DIR, fx.host, { defaultBranch: "main", sha: SHA });
		expect(rows[0]).toMatchObject({ status: "warn", actual: "detached HEAD" });
		expect(fx.calls.length).toBeGreaterThan(0);
		expect(fx.calls.every((c) => c[0] === "git" && c[1] === "-C" && c[2] === DIR)).toBe(true);
	});

	test("with no checkouts option there are no checkout rows and no git call", async () => {
		const fx = fixtureHost({ policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n", git: { branch: "main", originBranch: "main", originSha: SHA, behind: 0 } });
		const rows = await gatherRows(policy, fx.host, { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" });
		expect(rows.some((r) => r.class === "checkout")).toBe(false);
		expect(fx.calls.some((c) => c[0] === "git")).toBe(false);
	});

	test("the checkout rows are the only change: every other row matches a run without the option", async () => {
		const git = { branch: "feature/r15", originBranch: "main", originSha: SHA, behind: 2 };
		const without = await runWith(git, []);
		const withRows = await runWith(git);
		expect(withRows.rows.filter((r) => r.class !== "checkout")).toEqual(without.rows);
		expect(withRows.checkout.length).toBe(2);
	});

	test("one checkout reads origin once: one ls-remote per checkout, not one for the name and one for the commit", async () => {
		const git = { branch: "main", originBranch: "main", originSha: SHA, behind: 0 };
		const one = await runWith(git, [DIR]);
		expect(one.calls.filter((c) => c[3] === "ls-remote")).toHaveLength(1);
		const two = await runWith(git, [DIR, "/srv/other"]);
		expect(two.calls.filter((c) => c[3] === "ls-remote")).toHaveLength(2);
	});

	test("a detached checkout's pull advice says it is detached and names the branch to select first", () => {
		const fx = fixtureHost({ policy, git: { branch: "HEAD", originBranch: "main", originSha: SHA, behind: 2 } });
		const rows = compareCheckout(DIR, fx.host, { defaultBranch: "main", sha: SHA });
		expect(rows[1]).toMatchObject({ status: "warn", actual: "2 commits behind origin/main" });
		expect(rows[1]?.hint).toContain("the checkout is detached");
		expect(rows[1]?.hint).toContain("select main first (git switch main)");
	});

	test("a feature branch not tracking origin's default is told to select it first; one tracking it gets the pull", () => {
		const feature = fixtureHost({ policy, git: { branch: "feature/r15", originBranch: "main", originSha: SHA, behind: 2, upstream: "origin/feature/r15" } });
		const featureRows = compareCheckout(DIR, feature.host, { defaultBranch: "main", sha: SHA });
		expect(featureRows[1]?.hint).toContain("the checkout is on feature/r15, which does not track origin/main");
		expect(featureRows[1]?.hint).toContain("select main first (git switch main)");
		expect(featureRows[1]?.hint).not.toContain("the checkout is detached");
		const tracking = fixtureHost({ policy, git: { branch: "dev", originBranch: "main", originSha: SHA, behind: 2, upstream: "origin/main" } });
		const trackingRows = compareCheckout(DIR, tracking.host, { defaultBranch: "main", sha: SHA });
		expect(trackingRows[1]?.hint).toBe("fast-forward it with git pull --ff-only; the doctor never fetches or pulls");
	});
});

describe("cli --checkout", () => {
	const policy = loadPolicy(infraDir);
	const DIR = "/srv/agent-substrate";
	const git = { branch: "main", originBranch: "main", originSha: "a".repeat(40), behind: 2 };

	test("repeats, needs a directory, and defaults to none", () => {
		expect(parseArgs([])).toMatchObject({ checkouts: [] });
		expect(parseArgs(["--checkout", "/a", "--checkout", "/b"])).toMatchObject({ checkouts: ["/a", "/b"] });
		expect(parseArgs(["--checkout"])).toEqual({ usage: "--checkout needs a directory" });
		expect(parseArgs(["--checkout", "--json"])).toEqual({ usage: "--checkout needs a directory" });
	});

	test("with --checkout main reports the branch and behind rows; without it there are none and no git call", async () => {
		const out: string[] = [];
		const io = { stdout: (t: string) => out.push(t), stderr: () => {}, post: async () => true };
		const base = { policy, showByUnit: asDeclared(policy), redis: GREEN_REDIS, envFile: "SUBSTRATE_PG_URL=x\n", git };
		const withFlag = fixtureHost(base);
		await main(["--infra", infraDir, "--json", "--checkout", DIR], withFlag.host, {}, io);
		const withRows = JSON.parse(out.join("")) as { rows: Row[] };
		const rows = withRows.rows.filter((r) => r.class === "checkout");
		expect(rows.map((r) => [r.check, r.status])).toEqual([
			[`checkout ${DIR} branch`, "ok"],
			[`checkout ${DIR} behind`, "warn"],
		]);
		expect(rows[1]?.actual).toBe("2 commits behind origin/main");
		out.length = 0;
		const bare = fixtureHost(base);
		await main(["--infra", infraDir, "--json"], bare.host, {}, io);
		const bareRows = JSON.parse(out.join("")) as { rows: Row[] };
		expect(bareRows.rows.some((r) => r.class === "checkout")).toBe(false);
		expect(bare.calls.some((c) => c[0] === "git")).toBe(false);
	});
});
