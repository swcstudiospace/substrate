import { describe, expect, test } from "bun:test";
import {
	parityVerdict,
	parseCgroup,
	parseReflogTime,
	parseSsListeners,
	parseSystemctlShow,
	procStartSeconds,
	type ParityFacts,
} from "./parity-check.ts";

/** The discuss-time host reading (RESEARCH section 8): every field defaults to the passing value. */
function facts(over: Partial<ParityFacts> = {}): ParityFacts {
	return {
		mainPid: 1525582,
		activeState: "active",
		subState: "running",
		nRestarts: 0,
		startEpoch: 1791479652,
		ssOwnerPids: [1525582],
		cgroup: "0::/system.slice/substrate-mcp.service",
		procCwd: "/root/src/repos/agent-substrate",
		workingDirectory: "/root/src/repos/agent-substrate",
		headMoveEpoch: 1791469658,
		dirtyPaths: [],
		originDiffPaths: [],
		originShaKnown: true,
		healthzStatus: 200,
		warnings: [],
		...over,
	};
}

/** Verbatim `systemctl show` block shape from the discuss-time reading. */
const SYSTEMCTL_READING = [
	"MainPID=1525582",
	"Result=success",
	"NRestarts=0",
	"ExecMainStartTimestamp=@1791479652",
	"ExecStart={ path=/root/.local/share/reflex/bun/bin/bun ; argv[]=bun packages/mcp-server/src/index.ts ; pid=1525582 }",
	"WorkingDirectory=/root/src/repos/agent-substrate",
	"ActiveState=active",
	"SubState=running",
	"FragmentPath=/etc/systemd/system/substrate-mcp.service",
	"ConditionResult=yes",
].join("\n");

/** Verbatim `ss -ltnpH` holder line from the discuss-time reading. */
const SS_READING = "LISTEN 0 512 127.0.0.1:7410 0.0.0.0:* users:((\"bun\",pid=1525582,fd=21))";

describe("parityVerdict", () => {
	test("passes on the RESEARCH section 8 reading", () => {
		// The baseline: everything the check asserts about the live unit today.
		expect(parityVerdict(facts()).pass).toBe(true);
	});

	test("fails when the unit is not active/running", () => {
		// A stopped unit cannot be serving production, whatever else matches.
		const verdict = parityVerdict(facts({ activeState: "inactive", subState: "dead" }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("active/running");
	});

	test("fails when another pid holds the port", () => {
		// A stray holder means the unit does not own :7410, even while active.
		const verdict = parityVerdict(facts({ ssOwnerPids: [3149064] }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("1525582");
	});

	test("fails when nobody holds the port", () => {
		// An empty owner set is not the MainPID singleton either.
		expect(parityVerdict(facts({ ssOwnerPids: [] })).pass).toBe(false);
	});

	test("fails on a user-slice cgroup", () => {
		// A harness twin runs in user.slice; only system.slice counts as production.
		const verdict = parityVerdict(facts({ cgroup: "0::/user.slice/user-0.slice/session-457.scope" }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("cgroup");
	});

	test("fails when healthz is not 200", () => {
		// 503 is an answer, but not a healthy one.
		const verdict = parityVerdict(facts({ healthzStatus: 503 }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("503");
	});

	test("reports 401 as auth-configured, not as silence", () => {
		// After tokens exist the probe needs a bearer; 401 names the fix.
		const verdict = parityVerdict(facts({ healthzStatus: 401 }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("SUBSTRATE_TOKEN");
	});

	test("fails when the process predates the last HEAD move", () => {
		// A start older than the last move cannot be serving the current tree.
		expect(parityVerdict(facts({ startEpoch: 1791469658 })).pass).toBe(false);
	});

	test("fails on modified server paths", () => {
		// Local dirt means the running tree is not the committed one.
		const verdict = parityVerdict(facts({ dirtyPaths: ["packages/mcp-server/src/server.ts"] }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("server.ts");
	});

	test("fails on server-path commits past HEAD", () => {
		// Commits between HEAD and origin/main on server paths break "from main".
		const verdict = parityVerdict(facts({ originDiffPaths: ["packages/mcp-server/src/index.ts"] }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("origin/main");
	});
	test("fails when origin/main is not local", () => {
		// Fail closed: an absent sha is a missing proof, and updating it is the operator's job.
		const verdict = parityVerdict(facts({ originShaKnown: false }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("operator action");
	});

	test("fails when NRestarts moved past the recorded baseline", () => {
		// The runbook records each reading; a grown counter means a restart happened.
		const verdict = parityVerdict(facts({ nRestarts: 3 }), { expectRestarts: 0 });
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("NRestarts");
	});

	test("fails when the start epoch moved", () => {
		// A different start instant means the unit restarted since the baseline.
		const verdict = parityVerdict(facts(), { expectStart: 1791479600 });
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("start epoch");
	});

	test("warnings never fail a passing reading", () => {
		// Unit-file drift and sibling-unit inventory are notes, per criterion 5.
		const verdict = parityVerdict(
			facts({ warnings: ["installed unit differs from the repo unit", "substrate-dispatcher is running"] }),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.warnings).toHaveLength(2);
	});
});

describe("parseSystemctlShow", () => {
	test("reads keys independent of property order", () => {
		// systemd prints in its own order, not the -p order, so position means nothing.
		const lines = SYSTEMCTL_READING.split("\n").reverse().join("\n");
		const map = parseSystemctlShow(lines);
		expect(map.get("MainPID")).toBe("1525582");
		expect(map.get("ActiveState")).toBe("active");
		expect(map.get("WorkingDirectory")).toBe("/root/src/repos/agent-substrate");
	});

	test("keeps the @unix timestamp form intact", () => {
		// --timestamp=unix prefixes the epoch with @; the caller strips it.
		expect(parseSystemctlShow(SYSTEMCTL_READING).get("ExecMainStartTimestamp")).toBe("@1791479652");
	});
});

describe("parseSsListeners", () => {
	test("maps the verbatim holder line to its pid", () => {
		expect(parseSsListeners(SS_READING).get(7410)).toEqual([1525582]);
	});

	test("collects every pid and matches bracketed IPv6", () => {
		// A forked socket lists several pids; IPv6 locals are bracketed.
		const text = [
			"LISTEN 0 512 [::1]:7410 [::]:* users:((\"bun\",pid=99,fd=3),(\"bun\",pid=100,fd=4))",
			"LISTEN 0 512 0.0.0.0:7410 0.0.0.0:* users:((\"docker-proxy\",pid=7,fd=5))",
		].join("\n");
		expect(parseSsListeners(text).get(7410)).toEqual([99, 100, 7]);
	});

	test("ignores ports outside the watch set", () => {
		expect(parseSsListeners("LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:((\"postgres\",pid=11,fd=6))").size).toBe(0);
	});
});

describe("parseCgroup", () => {
	test("trims the v2 single line", () => {
		// /proc/<pid>/cgroup is one line; surrounding whitespace is incidental.
		expect(parseCgroup("0::/system.slice/substrate-mcp.service\n")).toBe("0::/system.slice/substrate-mcp.service");
	});
});

describe("procStartSeconds", () => {
	const btime = 1790699914;
	const stat = "1525582 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77973817 19 20 21";

	test("adds btime to field 22 after the last paren", () => {
		// The discuss-time numbers must reproduce the unit's start instant.
		expect(procStartSeconds(btime, stat)).toBe(btime + 77973817 / 100);
	});

	test("survives spaces in comm", () => {
		// comm can hold spaces and parens; only the last ) starts the fields.
		const spaced = "1525582 (my bun (worker)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77973817 19 20 21";
		expect(procStartSeconds(btime, spaced)).toBe(btime + 77973817 / 100);
	});
});

describe("parseReflogTime", () => {
	test("reads the HEAD@{…} move time", () => {
		// %ct is commit time; the move time lives inside HEAD@{…}.
		const line = "ab62c918ff7790a64fb4119e54c54d60a2e0d947 HEAD@{1791469658} pull origin main: Fast-forward";
		expect(parseReflogTime(line)).toBe(1791469658);
	});
});
