/**
 * The sandbox rows of the runtime doctor (uplift-5 U5-2): `systemd-analyze security` exposure per loaded
 * unit against `SUBSTRATE_EXPOSURE_MAX`, and an installed sandbox drop-in against `systemctl show`.
 * Command output is fixture text and the host is a fake: no test runs systemctl or systemd-analyze, reads
 * /etc/systemd or touches the machine.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { declaredUnit, exitCode, gatherRows, type Host, loadPolicy, type Policy, type Row, type RunResult } from "./doctor-runtime.ts";
import {
	compareExposure,
	compareSandbox,
	diffSandbox,
	exposureMaxFromEnv,
	gatherHardeningRows,
	type HardeningOptions,
	hardeningOptionsFromEnv,
	MAX_ANALYZER_CALLS,
	parseExposure,
	parseSandboxExample,
	type SandboxSpec,
} from "./doctor-sandbox.ts";
import { parseSystemctlShow } from "./parity-check.ts";

const infraDir = join(import.meta.dir, "..", "infra", "vps");

function shown(props: Record<string, string>): ReadonlyMap<string, string> {
	return parseSystemctlShow(
		Object.entries(props)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n"),
	);
}

/** What `systemd-analyze security <unit> --no-pager` ends with. */
function analyzeOut(unit: string, score: string, level: string): string {
	return `✗ UMask=    Files created by service are world-readable by default    0.1\n\n→ Overall exposure level for ${unit}: ${score} ${level} :-(\n`;
}

const SPEC_A: SandboxSpec = parseSandboxExample(
	"30-sandbox.conf.example",
	[
		"# sandbox-class: A",
		"# exposure-ceiling: 5.0",
		"[Service]",
		"ProtectSystem=strict",
		"ProtectHome=read-only",
		"ProtectKernelModules=true",
		"RestrictNamespaces=true",
		"SystemCallArchitectures=native",
		"CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_NET_ADMIN",
		"ReadWritePaths=/mnt/index-archive",
		"",
	].join("\n"),
);

/** `systemctl show` for SPEC_A fully in force. */
const IN_FORCE = {
	ProtectSystem: "strict",
	ProtectHome: "read-only",
	ProtectKernelModules: "yes",
	RestrictNamespaces: "yes",
	SystemCallArchitectures: "native",
	CapabilityBoundingSet: "cap_chown cap_dac_override cap_kill cap_sys_chroot",
	ReadWritePaths: "/mnt/index-archive",
};

describe("parsing", () => {
	test("an example's class, ceiling and [Service] directives are read; comments and other sections are not", () => {
		expect(SPEC_A).toMatchObject({ file: "30-sandbox.conf", class: "A", ceiling: 5 });
		expect(SPEC_A.directives).toContainEqual(["ProtectHome", "read-only"]);
		expect(SPEC_A.directives).toContainEqual(["CapabilityBoundingSet", "~CAP_SYS_ADMIN CAP_NET_ADMIN"]);
		const other = parseSandboxExample("30-sandbox.conf.example", "# sandbox-class: C\n[Unit]\nProtectHome=no\n[Service]\n# ProtectSystem=full\nLockPersonality=true\n");
		expect(other.class).toBeNull();
		expect(other.ceiling).toBeNull();
		expect(other.directives).toEqual([["LockPersonality", "true"]]);
	});

	test("every repo unit has a staged example that parses with a class and a ceiling", () => {
		const policy = loadPolicy(infraDir);
		const withExample = policy.units.filter((u) => u.sandbox !== undefined);
		expect(withExample.length).toBe(policy.units.length);
		for (const unit of withExample) {
			expect({ unit: unit.name, class: unit.sandbox?.class !== null, ceiling: unit.sandbox?.ceiling !== null }).toEqual({ unit: unit.name, class: true, ceiling: true });
		}
	});

	test("the overall verdict is read from analyzer text; a unit with no verdict is null", () => {
		expect(parseExposure(analyzeOut("substrate-mcp.service", "8.1", "EXPOSED"))).toEqual({ score: 8.1, level: "EXPOSED" });
		expect(parseExposure("→ Overall exposure level for substrate-alert@i.service: 4.7 OK :-)\n")).toEqual({ score: 4.7, level: "OK" });
		expect(parseExposure("Failed to connect to bus\n")).toBeNull();
		expect(parseExposure("")).toBeNull();
	});

	test("SUBSTRATE_EXPOSURE_MAX: unset and empty are report-only; 0-10 is a ceiling; anything else is invalid and report-only", () => {
		expect(exposureMaxFromEnv({})).toEqual({ max: null, invalid: null });
		expect(exposureMaxFromEnv({ SUBSTRATE_EXPOSURE_MAX: "  " })).toEqual({ max: null, invalid: null });
		expect(exposureMaxFromEnv({ SUBSTRATE_EXPOSURE_MAX: "5.5" })).toEqual({ max: 5.5, invalid: null });
		expect(exposureMaxFromEnv({ SUBSTRATE_EXPOSURE_MAX: "0" })).toEqual({ max: 0, invalid: null });
		expect(exposureMaxFromEnv({ SUBSTRATE_EXPOSURE_MAX: "10" })).toEqual({ max: 10, invalid: null });
		for (const bad of ["11", "-1", "five", "5,5", "5.555", "NaN", "1e1"]) {
			expect(exposureMaxFromEnv({ SUBSTRATE_EXPOSURE_MAX: bad })).toEqual({ max: null, invalid: bad });
		}
	});
});

describe("exposure rows", () => {
	test("max unset: even an 8.1 EXPOSED unit is ok and says report only", () => {
		const row = compareExposure("substrate-mcp.service", { score: 8.1, level: "EXPOSED" }, null, 5);
		expect(row).toMatchObject({ class: "units", check: "substrate-mcp.service exposure", status: "ok", actual: "8.1 EXPOSED" });
		expect(row.expected).toContain("report only");
		expect(row.hint).toContain("30-sandbox.conf.example");
	});

	test("max set: above it is drift, at it is ok (boundary), below it is ok", () => {
		expect(compareExposure("u.service", { score: 8.1, level: "EXPOSED" }, 6, null)).toMatchObject({ status: "drift", expected: "≤ 6 (SUBSTRATE_EXPOSURE_MAX)", actual: "8.1 EXPOSED" });
		expect(compareExposure("u.service", { score: 6, level: "MEDIUM" }, 6, null).status).toBe("ok");
		expect(compareExposure("u.service", { score: 6.1, level: "MEDIUM" }, 6, null).status).toBe("drift");
		expect(compareExposure("u.service", { score: 4.7, level: "OK" }, 6, null).status).toBe("ok");
		expect(compareExposure("u.service", { score: 8.1, level: "EXPOSED" }, 0, null).status).toBe("drift");
	});

	test("a unit with no verdict is unknown, never drift, whatever the ceiling", () => {
		expect(compareExposure("u.service", null, 1, null).status).toBe("unknown");
		expect(compareExposure("u.service", null, null, null).status).toBe("unknown");
	});
});

describe("installed drop-in against systemctl show", () => {
	test("in force exactly as declared is ok; the effective boolean `yes` meets the file's `true`", () => {
		expect(compareSandbox("u.service", SPEC_A, shown(IN_FORCE))).toMatchObject({ status: "ok", check: "u.service sandbox" });
	});

	test("an operator-added ReadWritePaths entry (a muse repo root) is not drift", () => {
		expect(compareSandbox("u.service", SPEC_A, shown({ ...IN_FORCE, ReadWritePaths: "-/root/extra /mnt/index-archive" })).status).toBe("ok");
	});

	test("copied but not reloaded: the effective values are the base unit's, and that is drift naming each one", () => {
		const row = compareSandbox(
			"u.service",
			SPEC_A,
			shown({ ProtectSystem: "full", ProtectHome: "no", ProtectKernelModules: "no", RestrictNamespaces: "no", SystemCallArchitectures: "", CapabilityBoundingSet: "cap_chown cap_sys_admin cap_net_admin", ReadWritePaths: "" }),
		);
		expect(row.status).toBe("drift");
		expect(row.expected).toContain("ProtectSystem=strict");
		expect(row.actual).toContain("ProtectSystem=full");
		expect(row.actual).toContain("still allows CAP_SYS_ADMIN CAP_NET_ADMIN");
		expect(row.expected).toContain("ReadWritePaths includes /mnt/index-archive");
		expect(row.hint).toContain("daemon-reload");
	});

	test("one directive overridden by a later drop-in is drift for that directive only", () => {
		const { diffs, checked } = diffSandbox(SPEC_A, shown({ ...IN_FORCE, ProtectHome: "no" }));
		expect(diffs.map((d) => d.directive)).toEqual(["ProtectHome"]);
		expect(checked).toBe(7);
	});

	test("a negated capability set from systemctl is judged too, and an unreadable one is skipped, not drifted", () => {
		expect(diffSandbox(SPEC_A, shown({ ...IN_FORCE, CapabilityBoundingSet: "~cap_sys_admin cap_net_admin" })).diffs).toEqual([]);
		expect(diffSandbox(SPEC_A, shown({ ...IN_FORCE, CapabilityBoundingSet: "~cap_chown" })).diffs.map((d) => d.directive)).toEqual(["CapabilityBoundingSet"]);
		const hex = diffSandbox(SPEC_A, shown({ ...IN_FORCE, CapabilityBoundingSet: "0x1fffffdffff" }));
		expect(hex.diffs).toEqual([]);
		expect(hex.checked).toBe(6);
	});

	test("systemctl unreachable or an old systemd that prints none of the properties is unknown, never drift", () => {
		expect(compareSandbox("u.service", SPEC_A, null).status).toBe("unknown");
		expect(compareSandbox("u.service", SPEC_A, shown({ LoadState: "loaded" })).status).toBe("unknown");
	});

	test("a later ReadWritePaths= assignment accumulates and an empty one resets", () => {
		const spec = parseSandboxExample("30-sandbox.conf.example", "[Service]\nReadWritePaths=/a\nReadWritePaths=/b\n");
		expect(diffSandbox(spec, shown({ ReadWritePaths: "/a" })).diffs[0]?.expected).toBe("ReadWritePaths includes /b");
		const reset = parseSandboxExample("30-sandbox.conf.example", "[Service]\nReadWritePaths=/a\nReadWritePaths=\nReadWritePaths=/b\n");
		expect(diffSandbox(reset, shown({ ReadWritePaths: "/b" })).diffs).toEqual([]);
	});
});

interface FakeHost {
	host: Host;
	calls: string[][];
	reads: string[];
}

/**
 * A host with `systemd-analyze` answering per unit (`null` = binary missing, a number = exit code with no
 * output) and `installed` listing the drop-in paths that exist on disk.
 */
function fakeHost(options: {
	scores?: Record<string, string>;
	analyzer?: "missing" | { code: number };
	/** Units whose `systemd-analyze` call exits non-zero with no output (a timeout, say). */
	failing?: Record<string, number>;
	installed?: readonly string[];
}): FakeHost {
	const calls: string[][] = [];
	const reads: string[] = [];
	const host: Host = {
		run(argv): RunResult | null {
			calls.push([...argv]);
			if (argv[0] !== "systemd-analyze") return null;
			if (options.analyzer === "missing") return null;
			if (options.analyzer !== undefined) return { code: options.analyzer.code, out: "" };
			const unit = argv[2] ?? "";
			const failCode = options.failing?.[unit];
			if (failCode !== undefined) return { code: failCode, out: "" };
			const score = options.scores?.[unit];
			return score === undefined ? { code: 0, out: "no verdict here\n" } : { code: 0, out: analyzeOut(unit, score, Number(score) > 6 ? "EXPOSED" : "MEDIUM") };
		},
		readText(path) {
			reads.push(path);
			return options.installed?.includes(path) ? "[Service]\nProtectSystem=strict\n" : null;
		},
		sleep: async () => {},
		now: () => 0,
	};
	return { host, calls, reads };
}

const UNITS = [
	{ name: "substrate-mcp.service", sandbox: SPEC_A },
	{ name: "substrate-anchor.service", sandbox: SPEC_A },
	{ name: "substrate-alert@.service", sandbox: SPEC_A },
];
const REPORT_ONLY: HardeningOptions = { exposureMax: null, invalidMax: null, installedDir: "/etc/systemd/system" };
const noShow = () => null;

describe("gathering", () => {
	test("max unset: every loaded unit gets an ok exposure row and none can change the doctor's exit code", () => {
		const { host } = fakeHost({ scores: { "substrate-mcp.service": "8.1", "substrate-anchor.service": "8.1" } });
		const rows = gatherHardeningRows(host, UNITS, noShow, REPORT_ONLY);
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-mcp.service exposure:ok", "substrate-anchor.service exposure:ok"]);
		expect(exitCode(rows)).toBe(0);
	});

	test("max set: only the unit above it is drift and the exit code becomes 2", () => {
		const { host } = fakeHost({ scores: { "substrate-mcp.service": "4.7", "substrate-anchor.service": "8.1" } });
		const rows = gatherHardeningRows(host, UNITS, noShow, { ...REPORT_ONLY, exposureMax: 5.5 });
		expect(rows.filter((r) => r.status === "drift").map((r) => r.check)).toEqual(["substrate-anchor.service exposure"]);
		expect(exitCode(rows)).toBe(2);
	});

	test("the analyzer is asked with a fixed argv per instantiated unit, and a template is never analysed", () => {
		const { host, calls } = fakeHost({ scores: { "substrate-mcp.service": "4.7", "substrate-anchor.service": "4.7" } });
		gatherHardeningRows(host, UNITS, noShow, REPORT_ONLY);
		expect(calls).toEqual([
			["systemd-analyze", "security", "substrate-mcp.service", "--no-pager"],
			["systemd-analyze", "security", "substrate-anchor.service", "--no-pager"],
		]);
	});

	test("systemd-analyze missing is ONE unknown row, not one per unit, and nothing else is run after it", () => {
		const { host, calls } = fakeHost({ analyzer: "missing" });
		const rows = gatherHardeningRows(host, UNITS, noShow, { ...REPORT_ONLY, exposureMax: 5 });
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["systemd-analyze security:unknown"]);
		expect(calls).toHaveLength(1);
		expect(exitCode(rows)).toBe(0);
	});

	test("an analyzer with no `security` verb (non-zero exit on the first units, never a verdict) is ONE row and stops", () => {
		const { host, calls } = fakeHost({ analyzer: { code: 1 } });
		const rows = gatherHardeningRows(host, UNITS, noShow, REPORT_ONLY);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "unknown", check: "systemd-analyze security" });
		expect(rows[0]?.hint).toContain("never printed a verdict");
		expect(calls).toHaveLength(2);
	});

	test("one failed call after a verdict does not silence later units: unit 1 ok, unit 2 exit 1, unit 3 above the ceiling is drift", () => {
		const three = ["substrate-a.service", "substrate-b.service", "substrate-c.service"].map((name) => ({ name }));
		const { host, calls } = fakeHost({ scores: { "substrate-a.service": "4.7", "substrate-c.service": "8.1" }, failing: { "substrate-b.service": 1 } });
		const rows = gatherHardeningRows(host, three, noShow, { ...REPORT_ONLY, exposureMax: 6 });
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-a.service exposure:ok", "substrate-b.service exposure:unknown", "substrate-c.service exposure:drift"]);
		expect(calls).toHaveLength(3);
		expect(exitCode(rows)).toBe(2);
	});

	test("a failure on the FIRST unit alone does not condemn the analyzer: the next unit's verdict restores its row and still counts", () => {
		const three = ["substrate-a.service", "substrate-b.service", "substrate-c.service"].map((name) => ({ name }));
		const { host } = fakeHost({ scores: { "substrate-b.service": "8.1", "substrate-c.service": "4.7" }, failing: { "substrate-a.service": 124 } });
		const rows = gatherHardeningRows(host, three, noShow, { ...REPORT_ONLY, exposureMax: 6 });
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-a.service exposure:unknown", "substrate-b.service exposure:drift", "substrate-c.service exposure:ok"]);
	});

	test("the analyzer is never spawned more than MAX_ANALYZER_CALLS times, and the cut is said once", () => {
		const many = Array.from({ length: MAX_ANALYZER_CALLS + 5 }, (_, i) => ({ name: `substrate-u${i}.service` }));
		const scores = Object.fromEntries(many.map((u) => [u.name, "4.7"]));
		const { host, calls } = fakeHost({ scores });
		const rows = gatherHardeningRows(host, many, noShow, REPORT_ONLY);
		expect(calls).toHaveLength(MAX_ANALYZER_CALLS);
		expect(rows.filter((r) => r.check === "systemd-analyze security")).toHaveLength(1);
		expect(rows).toHaveLength(MAX_ANALYZER_CALLS + 1);
	});

	test("a template gets its sandbox row when its drop-in is installed, and still no exposure row or analyzer call", () => {
		const target = "/etc/systemd/system/substrate-alert@.service.d/30-sandbox.conf";
		const { host, calls } = fakeHost({ installed: [target] });
		const rows = gatherHardeningRows(host, [{ name: "substrate-alert@.service", sandbox: SPEC_A }], () => shown(IN_FORCE), REPORT_ONLY);
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-alert@.service sandbox:ok"]);
		expect(calls).toEqual([]);
	});

	test("a unit whose output has no verdict is unknown but does not stop the others", () => {
		const { host } = fakeHost({ scores: { "substrate-anchor.service": "6.0" } });
		const rows = gatherHardeningRows(host, UNITS, noShow, { ...REPORT_ONLY, exposureMax: 6 });
		expect(rows.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-mcp.service exposure:unknown", "substrate-anchor.service exposure:ok"]);
	});

	test("an unusable SUBSTRATE_EXPOSURE_MAX is one warn row and the exposure rows stay report-only", () => {
		const options = hardeningOptionsFromEnv({ SUBSTRATE_EXPOSURE_MAX: "lots" });
		expect(options).toMatchObject({ exposureMax: null, invalidMax: "lots" });
		const { host } = fakeHost({ scores: { "substrate-mcp.service": "8.1", "substrate-anchor.service": "8.1" } });
		const rows = gatherHardeningRows(host, UNITS, noShow, options);
		expect(rows[0]).toMatchObject({ check: "SUBSTRATE_EXPOSURE_MAX", status: "warn" });
		expect(rows.slice(1).every((r) => r.status === "ok")).toBe(true);
		expect(exitCode(rows)).toBe(0);
	});

	test("a drop-in is compared only when its file exists under the installed-units directory", () => {
		const target = "/tmp/units/substrate-mcp.service.d/30-sandbox.conf";
		const asked: string[] = [];
		const show = (unit: string, props: string) => {
			asked.push(`${unit} ${props}`);
			return shown(IN_FORCE);
		};
		const absent = fakeHost({ scores: { "substrate-mcp.service": "4.7", "substrate-anchor.service": "4.7" } });
		expect(gatherHardeningRows(absent.host, UNITS, show, { ...REPORT_ONLY, installedDir: "/tmp/units" }).some((r) => r.check.endsWith("sandbox"))).toBe(false);
		expect(asked).toEqual([]);
		expect(absent.reads).toContain(target);
		const present = fakeHost({ scores: { "substrate-mcp.service": "4.7", "substrate-anchor.service": "4.7" }, installed: [target] });
		const rows = gatherHardeningRows(present.host, UNITS, show, { ...REPORT_ONLY, installedDir: "/tmp/units" });
		expect(rows.filter((r) => r.check.endsWith("sandbox")).map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-mcp.service sandbox:ok"]);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("substrate-mcp.service ProtectSystem");
	});

	test("an installed drop-in that is not in force is drift even when no exposure ceiling is set", () => {
		const target = "/etc/systemd/system/substrate-mcp.service.d/30-sandbox.conf";
		const { host } = fakeHost({ scores: { "substrate-mcp.service": "8.1", "substrate-anchor.service": "8.1" }, installed: [target] });
		const rows = gatherHardeningRows(host, UNITS, () => shown({ ...IN_FORCE, ProtectSystem: "full" }), REPORT_ONLY);
		expect(rows.filter((r) => r.status === "drift").map((r) => r.check)).toEqual(["substrate-mcp.service sandbox"]);
		expect(exitCode(rows)).toBe(2);
	});
});

describe("inside the whole doctor run", () => {
	const base = loadPolicy(infraDir);
	const unit = base.units.find((u) => u.name === "substrate-doctor.service");
	// One non-release unit, so "not installed" is `unknown`, not the release-unit drift.
	const policy: Policy = { ...base, units: unit === undefined ? [] : [unit] };
	const loaded = "LoadState=loaded\nActiveState=active\nSlice=substrate.slice\nMemoryMax=268435456\nMemorySwapMax=infinity\nTasksMax=64\nNRestarts=0\nEnvironment=SUBSTRATE_DOCTOR_STATE=/x\n";

	function host(score: string): Host {
		return {
			run(argv) {
				if (argv[0] === "systemctl") return { code: 0, out: argv[2] === "substrate-doctor.service" ? loaded : "LoadState=not-found\n" };
				if (argv[0] === "systemd-analyze") return { code: 0, out: analyzeOut("substrate-doctor.service", score, "EXPOSED") };
				return null;
			},
			readText: () => null,
			sleep: async () => {},
			now: () => 1_760_400_000,
		};
	}
	const options = { minFreeGb: 5, maxSwapPagesPerSecond: 0, envFile: "/etc/substrate/substrate.env" };

	test("flag unset adds only ok rows: the rest of the run and its exit code are exactly what they were without it", async () => {
		const without = await gatherRows(policy, host("8.1"), options);
		const report = await gatherRows(policy, host("8.1"), { ...options, hardening: hardeningOptionsFromEnv({}) });
		const extra = report.filter((r) => !without.some((w) => w.check === r.check));
		expect(extra.map((r) => `${r.check}:${r.status}`)).toEqual(["substrate-doctor.service exposure:ok"]);
		expect(report.filter((r) => !extra.includes(r))).toEqual(without);
		expect(exitCode(report)).toBe(exitCode(without));
	});

	test("flag set turns a unit above it into drift in the `units` class, and a unit under it into nothing", async () => {
		const over = await gatherRows(policy, host("8.1"), { ...options, hardening: hardeningOptionsFromEnv({ SUBSTRATE_EXPOSURE_MAX: "6" }) });
		const row = over.find((r: Row) => r.check === "substrate-doctor.service exposure");
		expect(row).toMatchObject({ class: "units", status: "drift" });
		const under = await gatherRows(policy, host("4.7"), { ...options, hardening: hardeningOptionsFromEnv({ SUBSTRATE_EXPOSURE_MAX: "6" }) });
		expect(under.find((r) => r.check === "substrate-doctor.service exposure")?.status).toBe("ok");
	});

	test("a staged unit systemd does not know gets no exposure row, so no analyzer call is spent on it", async () => {
		const calls: string[][] = [];
		const inner = host("8.1");
		const h: Host = {
			...inner,
			run: (argv) => {
				calls.push([...argv]);
				return inner.run(argv);
			},
		};
		const notInstalled: Policy = { ...base, units: [declaredUnit("substrate-anchor.service", "[Service]\n")] };
		const rows = await gatherRows(notInstalled, h, { ...options, hardening: hardeningOptionsFromEnv({}) });
		expect(rows.some((r) => r.check.endsWith("exposure"))).toBe(false);
		expect(calls.some((c) => c[0] === "systemd-analyze")).toBe(false);
	});
});
