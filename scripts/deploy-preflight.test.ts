import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as briefProfile from "../packages/mcp-server/src/brief-profile.ts";
import * as config from "../packages/mcp-server/src/config.ts";
import * as hindsightInventory from "../packages/mcp-server/src/hindsight-inventory.ts";
import * as recallSnapshot from "../packages/mcp-server/src/recall-snapshot.ts";
import {
	MAX_ENV_BYTES,
	MAX_STATE_BYTES,
	checkDisk,
	checkJsonl,
	compareUnits,
	isJsonObject,
	isOutboxEntry,
	main,
	parseArgs,
	parseEnvText,
	parseUnitEnvironment,
	readChildReport,
	withholdQuotedValues,
	run,
	stateFilePaths,
	WARNING_EXPORT,
	type ChildRunner,
	type Finding,
	type Io,
	type Options,
} from "./deploy-preflight.ts";

const repoRoot = join(import.meta.dir, "..");

/** Not a real credential: a planted value that must never reach any output. */
const SENTINEL = "sentinel-value-7c1e9d42b0aa";

/** Every scratch directory a test made, removed once the file's tests are done. */
const scratchDirs: string[] = [];
afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "deploy-preflight-"));
	scratchDirs.push(dir);
	return dir;
}

interface Captured {
	io: Io;
	stdout: string[];
	stderr: string[];
}

/** An `Io` whose floor is disabled, so the verdict never depends on this machine's disk. */
function capture(extra: Partial<Io> = {}): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { stdout, stderr, io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), env: { SUBSTRATE_DEPLOY_MIN_FREE_GB: "0" }, ...extra } };
}

interface Rig {
	dir: string;
	state: string;
	installed: string;
	units: string;
	options: (envFiles?: string[]) => Options;
}

function rig(): Rig {
	const dir = scratch();
	const state = join(dir, "state");
	const installed = join(dir, "installed");
	const units = join(dir, "units");
	for (const path of [state, installed, units]) mkdirSync(path);
	return {
		dir,
		state,
		installed,
		units,
		options: (envFiles = []) => ({ releaseDir: repoRoot, envFiles, stateDir: state, unitsDir: units, installedUnitsDir: installed, json: true }),
	};
}

function envFile(dir: string, body: string): string {
	const path = join(dir, "unit.env");
	writeFileSync(path, body);
	return path;
}

async function findings(options: Options, extra: Partial<Io> = {}): Promise<{ code: number; findings: Finding[]; out: string; err: string }> {
	const { io, stdout, stderr } = capture(extra);
	const code = await run(options, io);
	const out = stdout.join("");
	return { code, findings: (JSON.parse(out) as { findings: Finding[] }).findings, out, err: stderr.join("") };
}

function named(all: readonly Finding[], name: string): Finding {
	const hit = all.find((item) => item.name === name);
	if (hit === undefined) throw new Error(`no finding named ${name}: ${all.map((item) => item.name).join(", ")}`);
	return hit;
}

describe("environment parsing", () => {
	test("an env file is read as systemd reads it: comments, quotes, continuation, last wins, no expansion, no export", () => {
		const env = parseEnvText(
			[
				"# a comment",
				"; another",
				"PLAIN=one",
				'QUOTED="two words"',
				"SINGLE='$NOT_EXPANDED'",
				"HOME_REF=$HOME/x",
				"export EXPORTED=ignored",
				"bad name=ignored",
				"JOINED=a\\",
				"  b",
				"DUP=first",
				"DUP=second",
				"EMPTY=",
			].join("\n"),
		);
		expect(env.get("PLAIN")).toBe("one");
		expect(env.get("QUOTED")).toBe("two words");
		expect(env.get("SINGLE")).toBe("$NOT_EXPANDED");
		expect(env.get("HOME_REF")).toBe("$HOME/x");
		expect(env.has("EXPORTED")).toBe(false);
		expect(env.has("bad name")).toBe(false);
		expect(env.get("JOINED")).toBe("a b");
		expect(env.get("DUP")).toBe("second");
		expect(env.get("EMPTY")).toBe("");
	});

	test("a unit Environment= value splits on whitespace outside quotes", () => {
		expect(parseUnitEnvironment('A=1 "B=two words" C="x y" D=')).toEqual([
			["A", "1"],
			["B", "two words"],
			["C", "x y"],
			["D", ""],
		]);
	});
});

describe("withholding values an env file supplied", () => {
	const finding = (reason: string, name = "sloConfigWarnings"): Finding => ({ check: "config", name, level: "warn", reason });

	test("a message quoting a supplied value is dropped whole and names the variables, in any position; others pass through untouched", () => {
		const values = new Map([
			["SUBSTRATE_SLO_CHECKPOINT", "hunter2hunter2"],
			["SUBSTRATE_PORT", "7410"],
			["SUBSTRATE_BRIEF_PROFILE", "enforce"],
		]);
		const quoted = finding(`quoted ${JSON.stringify("hunter2hunter2")} and path /srv/hunter2hunter2/x`);
		const clean = finding("the mode is enforce on port 7410");
		const out = withholdQuotedValues([quoted, clean], values);
		expect(JSON.stringify(out[0])).not.toContain("hunter2hunter2");
		expect(out[0]?.reason).toBe("withheld: the message quoted the value of SUBSTRATE_SLO_CHECKPOINT");
		// Level and check survive: withholding never turns a verdict into a pass.
		expect(out[0]?.level).toBe("warn");
		// A short value and a mode word are not credentials; the message stays whole.
		expect(out[1]).toEqual(clean);
	});

	test("every variable whose value a message quotes is named once, sorted, and a finding named after a value is renamed", () => {
		const values = new Map([
			["B_VAR", "shared-value-xyz"],
			["A_VAR", "shared-value-xyz"],
			["C_VAR", "other-value-123"],
		]);
		const out = withholdQuotedValues([finding("saw shared-value-xyz and other-value-123", "path-other-value-123")], values);
		expect(out[0]?.reason).toBe("withheld: the message quoted the value of A_VAR, B_VAR, C_VAR");
		expect(out[0]?.name).toBe("config");
	});

	test("a value quoted JSON-escaped, as a ConfigError for a duration does, is withheld as well as one quoted raw", () => {
		const value = 'sixty"minutes\\now';
		const escaped = finding(`SUBSTRATE_LEDGER_TTL=${JSON.stringify(value)} is not a duration`);
		const raw = finding(`SUBSTRATE_LEDGER_TTL=${value} is not a duration`);
		const out = withholdQuotedValues([escaped, raw], new Map([["SUBSTRATE_LEDGER_TTL", value]]));
		for (const hit of out) expect(hit.reason).toBe("withheld: the message quoted the value of SUBSTRATE_LEDGER_TTL");
		expect(JSON.stringify(out)).not.toContain("sixty");
	});
});

describe("config check", () => {
	test("a valid env prints an all-clear table, exits 0, and the child saw only the supplied variables", async () => {
		const r = rig();
		const file = envFile(r.dir, `SUBSTRATE_TOKEN_CURSOR=${SENTINEL}\nSUBSTRATE_PORT=7411\n`);
		// Set in the preflight's OWN environment only: a child that inherited it would warn about it.
		const previous = process.env.SUBSTRATE_SLO_CHECKPOINT;
		process.env.SUBSTRATE_SLO_CHECKPOINT = "relative/leaks.json";
		try {
			const result = await findings(r.options([file]));
			expect(result.code).toBe(0);
			expect(named(result.findings, "loadConfig").level).toBe("ok");
			expect(result.findings.some((item) => item.level === "error")).toBe(false);
			expect(result.findings.some((item) => item.name === "sloConfigWarnings")).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.SUBSTRATE_SLO_CHECKPOINT;
			else process.env.SUBSTRATE_SLO_CHECKPOINT = previous;
		}
	});

	test("a value the release warns about is reported by variable name and the value is not printed", async () => {
		const r = rig();
		const file = envFile(r.dir, `SUBSTRATE_SLO_CHECKPOINT=relative-${SENTINEL}\n`);
		const result = await findings(r.options([file]));
		const warning = named(result.findings, "sloConfigWarnings");
		expect(warning.level).toBe("warn");
		expect(warning.reason).toContain("SUBSTRATE_SLO_CHECKPOINT");
		expect(result.out).not.toContain(SENTINEL);
		expect(result.code).toBe(0);
	});

	test("an env that makes loadConfig throw is an error, exits 1, and no value is printed anywhere", async () => {
		const r = rig();
		// The same token value under two surfaces: the boot refuses with exit 78.
		const file = envFile(r.dir, `SUBSTRATE_TOKEN_CURSOR=${SENTINEL}\nSUBSTRATE_TOKEN_OMP=${SENTINEL}\n`);
		const { io, stdout, stderr } = capture();
		const code = await run({ ...r.options([file]), json: false }, io);
		const out = `${stdout.join("")}${stderr.join("")}`;
		expect(code).toBe(1);
		expect(out).toContain("loadConfig");
		expect(out).toContain("exit 78");
		expect(out).toContain("SUBSTRATE_TOKEN_CURSOR");
		expect(out).toContain("preflight-receipt");
		expect(out).toContain("result=fail");
		expect(out).not.toContain(SENTINEL);
		// One failing check does not hide the others.
		expect(out).toContain("retain-outbox.jsonl");
		expect(out).toContain("free space");
	});

	test("an env file that is not there is a warning, one that cannot be read is an error", async () => {
		const r = rig();
		const absent = await findings(r.options([join(r.dir, "absent.env")]));
		expect(absent.code).toBe(0);
		expect(absent.findings.find((item) => item.reason.includes("env file not found"))?.level).toBe("warn");
		const directory = await findings(r.options([r.dir]));
		expect(directory.code).toBe(1);
		expect(directory.findings.find((item) => item.reason.includes("unreadable"))?.level).toBe("error");
	});

	test("a unit's Environment= lines are part of the environment the config check sees", async () => {
		const r = rig();
		// The unit sets a relative checkpoint path; the release's own warning must fire for it.
		writeFileSync(join(r.units, "substrate-mcp.service"), "[Service]\nEnvironment=SUBSTRATE_SLO_CHECKPOINT=not-absolute\n");
		const result = await findings(r.options());
		const warning = named(result.findings, "sloConfigWarnings");
		expect(warning.level).toBe("warn");
		// What a unit file declares is repo text, not a secret: it is shown, unlike an env file's values.
		expect(warning.reason).toContain("not-absolute");
	});

	test("every warning function index.ts calls is one the preflight runs", () => {
		const indexText = readFileSync(join(repoRoot, "packages/mcp-server/src/index.ts"), "utf8");
		const called = [...new Set([...indexText.matchAll(/\.\.\.(\w+Warnings)\(/g)].map((match) => match[1] ?? ""))];
		expect(called.length).toBeGreaterThan(5);
		const exported = new Set<string>();
		for (const module of [config, briefProfile, recallSnapshot, hindsightInventory]) {
			for (const [key, value] of Object.entries(module)) if (typeof value === "function") exported.add(key);
		}
		for (const name of called) {
			expect({ name, exported: exported.has(name), matched: WARNING_EXPORT.test(name) }).toEqual({ name, exported: true, matched: true });
		}
	});

	test("a child that did not report is one error naming what it skipped, and the units and disk checks still run", async () => {
		const r = rig();
		const crashed: ChildRunner = () => ({ status: 1, stdout: "", stderr: "boom", error: "spawn failed" });
		const result = await findings(r.options(), { child: crashed });
		expect(result.code).toBe(1);
		const failure = named(result.findings, "loadConfig");
		expect(failure.level).toBe("error");
		expect(failure.reason).toContain("spawn failed");
		expect(failure.reason).toContain("retain-outbox.jsonl");
		expect(result.findings.some((item) => item.check === "units")).toBe(true);
		expect(result.findings.some((item) => item.check === "disk")).toBe(true);
		expect(readChildReport({ status: 0, stdout: "{}\n", stderr: "" })[0]?.level).toBe("error");
	});

	test("a .env in the working directory never reaches the config child", () => {
		const r = rig();
		const cwd = join(r.dir, "cwd");
		mkdirSync(cwd);
		// Bun loads a `.env` from the working directory unless told not to; the unit has no such file.
		writeFileSync(join(cwd, ".env"), "SUBSTRATE_SLO_CHECKPOINT=relative-dotenv-leak\n");
		const argv = [join(repoRoot, "scripts/deploy-preflight.ts"), repoRoot, "--state-dir", r.state, "--units-dir", r.units, "--installed-units-dir", r.installed, "--json"];
		const ran = Bun.spawnSync([process.execPath, ...argv], { cwd, env: { PATH: process.env.PATH ?? "", SUBSTRATE_DEPLOY_MIN_FREE_GB: "0" } });
		const out = ran.stdout.toString();
		expect(ran.exitCode).toBe(0);
		expect(out).not.toContain("dotenv-leak");
		expect((JSON.parse(out) as { findings: Finding[] }).findings.some((item) => item.name === "sloConfigWarnings")).toBe(false);
	});

	test("the INSTALLED unit's Environment= is what the check sees when there is one; its values are withheld, the release's own are shown", async () => {
		const r = rig();
		writeFileSync(join(r.units, "substrate-mcp.service"), "[Service]\nEnvironment=SUBSTRATE_SLO_CHECKPOINT=release-relative\n");
		const before = await findings(r.options());
		expect(named(before.findings, "sloConfigWarnings").reason).toContain("release-relative");

		writeFileSync(join(r.installed, "substrate-mcp.service"), "[Service]\nEnvironment=SUBSTRATE_SLO_CHECKPOINT=installed-relative\n");
		const after = await findings(r.options());
		const warning = named(after.findings, "sloConfigWarnings");
		expect(warning.reason).toBe("withheld: the message quoted the value of SUBSTRATE_SLO_CHECKPOINT");
		expect(after.out).not.toContain("installed-relative");
		expect(after.out).not.toContain("release-relative");
	});
});

describe("state files", () => {
	test("absent files are ok", async () => {
		const r = rig();
		const result = await findings(r.options());
		for (const name of ["docs-ingest.json", "slo-checkpoint.json", "retain-outbox.jsonl", "event-spool.jsonl"]) expect(named(result.findings, name).level).toBe("ok");
	});

	test("a docs state written by a newer release, or one that is not JSON, is an error", async () => {
		const r = rig();
		writeFileSync(join(r.state, "docs-ingest.json"), JSON.stringify({ version: 3, records: {}, versions: {} }));
		const newer = await findings(r.options());
		expect(newer.code).toBe(1);
		expect(named(newer.findings, "docs-ingest.json").reason).toContain("newer release");

		writeFileSync(join(r.state, "docs-ingest.json"), "{ torn");
		const broken = await findings(r.options());
		expect(named(broken.findings, "docs-ingest.json").level).toBe("error");

		writeFileSync(join(r.state, "docs-ingest.json"), JSON.stringify({ version: 2, records: {}, versions: {} }));
		expect(named((await findings(r.options())).findings, "docs-ingest.json").level).toBe("ok");
	});

	test("an SLO checkpoint of a newer version, and one that is not a checkpoint, are errors", async () => {
		const r = rig();
		writeFileSync(join(r.state, "slo-checkpoint.json"), JSON.stringify({ v: 2 }));
		const newer = await findings(r.options());
		expect(named(newer.findings, "slo-checkpoint.json").level).toBe("error");
		expect(named(newer.findings, "slo-checkpoint.json").reason).toContain("newer release");

		writeFileSync(join(r.state, "slo-checkpoint.json"), JSON.stringify({ hello: "world" }));
		expect(named((await findings(r.options())).findings, "slo-checkpoint.json").level).toBe("error");
	});

	test("a JSONL file is an error with no usable line, a warning with a torn one among good ones, ok when clean", () => {
		const r = rig();
		const entry = { id: "rob_1", bank: "b", document_id: "d", entry_id: "e", surface: "omp", entry_hash: "h", attempts: 1, next_at: 1, last_reason: "retain-timeout", enqueued_at: 1 };
		writeFileSync(join(r.state, "retain-outbox.jsonl"), `${JSON.stringify(entry)}\n`);
		expect(checkJsonl(r.state, "retain-outbox.jsonl", "retain outbox", isOutboxEntry).level).toBe("ok");
		writeFileSync(join(r.state, "retain-outbox.jsonl"), `${JSON.stringify(entry)}\n{"id":"rob_2"`);
		expect(checkJsonl(r.state, "retain-outbox.jsonl", "retain outbox", isOutboxEntry).level).toBe("warn");
		writeFileSync(join(r.state, "retain-outbox.jsonl"), `${JSON.stringify({ ...entry, attempts: "1" })}\n`);
		expect(checkJsonl(r.state, "retain-outbox.jsonl", "retain outbox", isOutboxEntry).level).toBe("error");
		writeFileSync(join(r.state, "event-spool.jsonl"), '[1,2]\n"text"\n');
		expect(checkJsonl(r.state, "event-spool.jsonl", "event spool", isJsonObject).level).toBe("error");
		writeFileSync(join(r.state, "event-spool.jsonl"), '{"k":1}\n');
		expect(checkJsonl(r.state, "event-spool.jsonl", "event spool", isJsonObject).level).toBe("ok");
		// A directory where a file should be cannot be read.
		mkdirSync(join(r.state, "dir.jsonl"));
		expect(checkJsonl(r.state, "dir.jsonl", "x", isJsonObject).level).toBe("error");
	});
});

describe("state files that are not where the default says", () => {
	test("the paths the release's loaded config resolved are the ones checked, and a switched-off checkpoint is ok", async () => {
		const r = rig();
		const elsewhere = join(r.dir, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "custom-docs.json"), JSON.stringify({ version: 3, records: {}, versions: {} }));
		writeFileSync(join(elsewhere, "custom-outbox.jsonl"), "garbage\n");
		// The default locations hold perfectly good files: only the configured ones may be judged.
		writeFileSync(join(r.state, "docs-ingest.json"), JSON.stringify({ version: 2, records: {}, versions: {} }));
		const file = envFile(
			r.dir,
			`SUBSTRATE_DOCS_STATE_FILE=${join(elsewhere, "custom-docs.json")}\nSUBSTRATE_RETAIN_OUTBOX_PATH=${join(elsewhere, "custom-outbox.jsonl")}\nSUBSTRATE_SLO_CHECKPOINT=off\n`,
		);
		const result = await findings(r.options([file]));
		expect(result.code).toBe(1);
		expect(named(result.findings, "custom-docs.json").reason).toContain("newer release");
		expect(named(result.findings, "custom-outbox.jsonl").level).toBe("error");
		expect(result.findings.some((item) => item.name === "docs-ingest.json" || item.name === "retain-outbox.jsonl")).toBe(false);
		const checkpoint = named(result.findings, "slo-checkpoint");
		expect(checkpoint.level).toBe("ok");
		expect(checkpoint.reason).toContain("off");
	});

	test("with no environment the --state-dir defaults apply, and each configured path wins over them", () => {
		expect(stateFilePaths(null, "/s", {})).toEqual({ docs: "/s/docs-ingest.json", slo: "/s/slo-checkpoint.json", retain: "/s/retain-outbox.jsonl", spool: "/s/event-spool.jsonl" });
		const loaded = { docsStateFile: "/x/docs.json", sloCheckpointPath: "/x/slo.json", retainOutbox: { path: "/x/outbox.jsonl" } };
		expect(stateFilePaths(loaded, "/s", { SUBSTRATE_STATE_DIR: "/c" })).toEqual({ docs: "/x/docs.json", slo: "/x/slo.json", retain: "/x/outbox.jsonl", spool: "/c/event-spool.jsonl" });
		// The default checkpoint path is this HOST's /var/lib/substrate: it is read from --state-dir instead.
		expect(stateFilePaths({ sloCheckpointPath: "/var/lib/substrate/slo-checkpoint.json" }, "/s", {}).slo).toBe("/s/slo-checkpoint.json");
		// Disabled by the environment, and the config says so.
		expect(stateFilePaths({ sloCheckpointPath: null }, "/s", { SUBSTRATE_SLO_CHECKPOINT: "off" }).slo).toBeNull();
	});
});

describe("size caps", () => {
	/** A file of `size` zero bytes that takes no disk. */
	const sparse = (path: string, size: number): void => {
		writeFileSync(path, "");
		truncateSync(path, size);
	};

	test("a state file, a JSONL file and an env file over their caps are errors that name the size, and are never read", async () => {
		const r = rig();
		sparse(join(r.state, "docs-ingest.json"), MAX_STATE_BYTES + 1);
		sparse(join(r.state, "retain-outbox.jsonl"), MAX_STATE_BYTES + 1);
		const big = join(r.dir, "big.env");
		sparse(big, MAX_ENV_BYTES + 1);
		const result = await findings(r.options([big]));
		expect(result.code).toBe(1);
		for (const [name, size] of [
			["docs-ingest.json", MAX_STATE_BYTES + 1],
			["retain-outbox.jsonl", MAX_STATE_BYTES + 1],
			[big, MAX_ENV_BYTES + 1],
		] as const) {
			const hit = named(result.findings, name);
			expect(hit.level).toBe("error");
			expect(hit.reason).toContain(`${size} bytes`);
			expect(hit.reason).toContain("not read");
		}
		// At the cap exactly it is read: the boundary is "over", not "at".
		sparse(join(r.state, "event-spool.jsonl"), MAX_STATE_BYTES);
		expect(named((await findings(r.options())).findings, "event-spool.jsonl").reason).not.toContain("not read");
	});
});

describe("unit drift", () => {
	const RELEASE_UNIT = "[Service]\nType=simple\nMemoryHigh=1G\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=512\nCPUQuota=200%\nSlice=substrate.slice\n";

	test("a difference is a warning that names both values, and nothing here is ever an error", () => {
		const r = rig();
		writeFileSync(join(r.units, "substrate-mcp.service"), RELEASE_UNIT);
		writeFileSync(join(r.installed, "substrate-mcp.service"), RELEASE_UNIT.replace("MemorySwapMax=0\n", "").replace("MemoryMax=2G", "MemoryMax=4G"));
		const all = compareUnits(r.units, r.installed);
		const swap = named(all, "substrate-mcp.service MemorySwapMax");
		expect(swap.level).toBe("warn");
		expect(swap.reason).toContain("release declares 0, installed has unset");
		expect(named(all, "substrate-mcp.service MemoryMax").reason).toContain("release declares 2G, installed has 4G");
		expect(all.some((item) => item.level === "error")).toBe(false);
	});

	test("matching units are ok, a drop-in .conf counts and a staged .example does not", () => {
		const r = rig();
		writeFileSync(join(r.units, "substrate-mcp.service"), RELEASE_UNIT);
		writeFileSync(join(r.installed, "substrate-mcp.service"), RELEASE_UNIT);
		expect(named(compareUnits(r.units, r.installed), "substrate-mcp.service").level).toBe("ok");

		// The installed watchdog drop-in sets Type=notify; the release carries it only as a staged example.
		mkdirSync(join(r.installed, "substrate-mcp.service.d"));
		writeFileSync(join(r.installed, "substrate-mcp.service.d", "20-watchdog.conf"), "[Service]\nType=notify\nWatchdogSec=30\n");
		mkdirSync(join(r.units, "substrate-mcp.service.d"));
		writeFileSync(join(r.units, "substrate-mcp.service.d", "20-watchdog.conf.example"), "[Service]\nType=notify\nWatchdogSec=30\n");
		const all = compareUnits(r.units, r.installed);
		expect(named(all, "substrate-mcp.service Type").reason).toContain("release declares simple, installed has notify");
		expect(named(all, "substrate-mcp.service WatchdogSec").level).toBe("warn");
	});

	test("a unit that is not installed, and a slice that differs, are warnings", () => {
		const r = rig();
		writeFileSync(join(r.units, "substrate-mcp.service"), RELEASE_UNIT);
		writeFileSync(join(r.units, "substrate.slice"), "[Slice]\nMemoryLow=2G\nCPUWeight=300\nIOWeight=300\n");
		writeFileSync(join(r.installed, "substrate.slice"), "[Slice]\nMemoryLow=2G\nCPUWeight=100\n");
		const all = compareUnits(r.units, r.installed);
		expect(named(all, "substrate-mcp.service").level).toBe("warn");
		expect(named(all, "substrate-mcp.service").reason).toContain("not installed");
		expect(named(all, "substrate.slice CPUWeight").reason).toContain("release declares 300, installed has 100");
		expect(named(all, "substrate.slice IOWeight").reason).toContain("installed has unset");
	});

	test("an empty assignment in a drop-in resets the value, as in systemd", () => {
		const r = rig();
		writeFileSync(join(r.units, "substrate-mcp.service"), RELEASE_UNIT);
		writeFileSync(join(r.installed, "substrate-mcp.service"), RELEASE_UNIT);
		mkdirSync(join(r.installed, "substrate-mcp.service.d"));
		writeFileSync(join(r.installed, "substrate-mcp.service.d", "10-reset.conf"), "[Service]\nCPUQuota=\n");
		expect(named(compareUnits(r.units, r.installed), "substrate-mcp.service CPUQuota").reason).toContain("installed has unset");
	});
});

describe("disk", () => {
	const df = (availableKb: number) => () => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/stub 419430400 1 ${availableKb} 50% /\n`;

	test("below the floor is an error, at or above it is ok, 0 disables it, and a bad floor is an error", () => {
		const gb = 1024 * 1024;
		expect(checkDisk("/x", undefined, df(4 * gb)).level).toBe("error");
		expect(checkDisk("/x", undefined, df(4 * gb)).reason).toContain("SUBSTRATE_DEPLOY_MIN_FREE_GB=5");
		expect(checkDisk("/x", undefined, df(5 * gb)).level).toBe("ok");
		expect(checkDisk("/x", "3", df(4 * gb)).level).toBe("ok");
		let ran = false;
		expect(
			checkDisk("/x", "0", () => {
				ran = true;
				return null;
			}).level,
		).toBe("ok");
		expect(ran).toBe(false);
		expect(checkDisk("/x", "lots", df(9 * gb)).level).toBe("error");
		expect(checkDisk("/x", undefined, () => null).level).toBe("error");
	});
});

describe("command line", () => {
	test("usage errors exit 2 and print no findings", async () => {
		for (const argv of [[], ["--bogus", "x"], ["a", "b"], ["--env-file"], [join(tmpdir(), "u5-1a-no-such-release-dir")]]) {
			const { io, stdout, stderr } = capture();
			expect(await main(argv, io)).toBe(2);
			expect(stdout.join("")).toBe("");
			expect(stderr.join("")).toContain("usage:");
		}
	});

	test("arguments land where they belong", () => {
		const parsed = parseArgs(["/rel", "--env-file", "/a", "--env-file", "/b", "--state-dir", "/s", "--installed-units-dir", "/i", "--json"]);
		expect(parsed).toEqual({
			ok: true,
			options: { releaseDir: "/rel", envFiles: ["/a", "/b"], stateDir: "/s", unitsDir: "/rel/infra/vps", installedUnitsDir: "/i", json: true },
		});
	});

	test("as a process it prints the table and the receipt line last, never the planted value, and its exit code is the verdict", () => {
		const r = rig();
		const file = envFile(r.dir, `SUBSTRATE_TOKEN_CURSOR=${SENTINEL}\n`);
		const argv = ["scripts/deploy-preflight.ts", repoRoot, "--env-file", file, "--state-dir", r.state, "--units-dir", r.units, "--installed-units-dir", r.installed];
		const env = { PATH: process.env.PATH ?? "", SUBSTRATE_DEPLOY_MIN_FREE_GB: "0" };
		const ok = Bun.spawnSync([process.execPath, ...argv], { cwd: repoRoot, env });
		const text = `${ok.stdout.toString()}${ok.stderr.toString()}`;
		expect(ok.exitCode).toBe(0);
		expect(text).not.toContain(SENTINEL);
		expect(ok.stdout.toString().trimEnd().split("\n").at(-1)).toMatch(/^preflight-receipt release=\S+ result=pass ok=\d+ warn=\d+ error=0$/);

		writeFileSync(join(r.state, "retain-outbox.jsonl"), "garbage\n");
		const bad = Bun.spawnSync([process.execPath, ...argv], { cwd: repoRoot, env });
		expect(bad.exitCode).toBe(1);
		expect(bad.stdout.toString().trimEnd().split("\n").at(-1)).toContain("result=fail");
		expect(`${bad.stdout.toString()}${bad.stderr.toString()}`).not.toContain(SENTINEL);
	});
});
