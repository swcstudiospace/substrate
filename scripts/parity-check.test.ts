import { describe, expect, test } from "bun:test";
import {
	diffStability,
	parityVerdict,
	parseCgroup,
	releaseDirFromLink,
	parseReflogTime,
	parseSsListeners,
	parseSystemctlShow,
	parseUnitVitals,
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
		pinned: false,
		releaseSha: null,
		releaseDir: null,
		releaseOnMain: null,
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

	test("fails when the process cwd is not the unit WorkingDirectory", () => {
		// A process serving :7410 from another checkout is not the unit's tree.
		const verdict = parityVerdict(facts({ procCwd: "/root/src/worktrees/agent-substrate-v13-phase" }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("WorkingDirectory");
	});

	test("fails closed when either cwd side is unreadable", () => {
		// An unknown cwd is a missing proof, never an implicit match.
		expect(parityVerdict(facts({ procCwd: null })).pass).toBe(false);
		expect(parityVerdict(facts({ workingDirectory: null })).pass).toBe(false);
	});

	test("fails when healthz does not answer at all", () => {
		// A silent port is a failed check (exit 1), reported as not answering.
		const verdict = parityVerdict(facts({ healthzStatus: null }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("not answering");
	});

	test("fails closed with its own reason when origin/main could not be asked", () => {
		// Tri-state: "could not ask" is distinct from "sha absent", and both fail.
		const verdict = parityVerdict(facts({ originShaKnown: null }));
		expect(verdict.pass).toBe(false);
		const text = verdict.failures.join("\n");
		expect(text).toContain("could not ask");
		expect(text).not.toContain("operator action");
	});

	test("fails when MainPID shares the port with another holder", () => {
		// The owner set must be exactly the MainPID singleton, not merely include it.
		expect(parityVerdict(facts({ ssOwnerPids: [1525582, 3149064] })).pass).toBe(false);
	});

	test("fails when MainPID is unknown", () => {
		// No MainPID means no owner to compare against, even with one holder present.
		expect(parityVerdict(facts({ mainPid: null })).pass).toBe(false);
	});

	test("fails closed when the start or HEAD-move epoch is unknown", () => {
		// An unreadable timestamp cannot prove the process postdates the tree.
		expect(parityVerdict(facts({ startEpoch: null })).pass).toBe(false);
		expect(parityVerdict(facts({ headMoveEpoch: null })).pass).toBe(false);
	});

	test("expect options pass when the reading matches the baseline", () => {
		// The runbook baseline comparison only fails on a real move.
		expect(parityVerdict(facts(), { expectRestarts: 0, expectStart: 1791479652 }).pass).toBe(true);
	});

	test("a pinned release serves main even when the operator checkout is dirty", () => {
		const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const verdict = parityVerdict(
			facts({
				pinned: true,
				workingDirectory: "/opt/agent-substrate/current",
				procCwd: `/opt/agent-substrate/releases/${sha}`,
				releaseDir: `/opt/agent-substrate/releases/${sha}`,
				releaseSha: sha,
				releaseOnMain: true,
				headMoveEpoch: null,
				dirtyPaths: ["packages/mcp-server/src/server.ts"],
				originDiffPaths: ["packages/mcp-server/src/index.ts"],
			}),
		);
		expect(verdict.pass).toBe(true);
	});

	test("a pinned release fails when the process is still in the checkout", () => {
		const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const verdict = parityVerdict(
			facts({
				pinned: true,
				workingDirectory: "/opt/agent-substrate/current",
				procCwd: "/root/src/repos/agent-substrate",
				releaseDir: `/opt/agent-substrate/releases/${sha}`,
				releaseSha: sha,
				releaseOnMain: true,
			}),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("pinned release");
	});

	test("a pinned release fails when its commit is not on origin/main", () => {
		const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const verdict = parityVerdict(
			facts({
				pinned: true,
				workingDirectory: "/opt/agent-substrate/current",
				procCwd: `/opt/agent-substrate/releases/${sha}`,
				releaseDir: `/opt/agent-substrate/releases/${sha}`,
				releaseSha: sha,
				releaseOnMain: false,
			}),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("not on origin/main");
	});

	test("collects every failing criterion at once", () => {
		// The verdict reports the full list, not just the first failure.
		const verdict = parityVerdict(facts({ activeState: "failed", healthzStatus: 503, dirtyPaths: ["bun.lock"] }));
		expect(verdict.failures).toHaveLength(3);
	});
});

describe("releaseDirFromLink", () => {
	test("accepts a relative releases target and refuses one that escapes", () => {
		const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		expect(releaseDirFromLink(`releases/${sha}`)).toEqual({ dir: `/opt/agent-substrate/releases/${sha}`, sha });
		expect(releaseDirFromLink("../etc")).toBeNull();
		expect(releaseDirFromLink("/root/src/repos/agent-substrate")).toBeNull();
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

	test("deduplicates one owner seen on two fds and two addresses", () => {
		// One owner on two fds (or IPv4 plus IPv6 loopback) is still exactly MainPID.
		const text = [
			'LISTEN 0 512 127.0.0.1:7410 0.0.0.0:* users:(("bun",pid=1525582,fd=21),("bun",pid=1525582,fd=22))',
			'LISTEN 0 512 [::1]:7410 [::]:* users:(("bun",pid=1525582,fd=23))',
		].join("\n");
		const owners = parseSsListeners(text).get(7410) ?? [];
		expect(owners).toEqual([1525582]);
		expect(parityVerdict(facts({ ssOwnerPids: owners })).pass).toBe(true);
	});

	test("ignores ports outside the watch set", () => {
		expect(parseSsListeners("LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:((\"postgres\",pid=11,fd=6))").size).toBe(0);
	});

	test("matches the bare-star wildcard local and skips blank or short lines", () => {
		// `ss` prints `*:PORT` for an all-address bind; noise lines never produce owners.
		const text = ["", "garbage", "LISTEN 0 4096 *:6420 *:* users:((\"node\",pid=55,fd=9))"].join("\n");
		const owners = parseSsListeners(text);
		expect(owners.get(6420)).toEqual([55]);
		expect(owners.size).toBe(1);
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

describe("parseUnitVitals", () => {
	test("reads MainPID, start and restarts from show props", () => {
		const vitals = parseUnitVitals(parseSystemctlShow(SYSTEMCTL_READING));
		expect(vitals).toEqual({ mainPid: 1525582, startEpoch: 1791479652, nRestarts: 0 });
	});
});

describe("diffStability", () => {
	const reading = { mainPid: 1525582, startEpoch: 1791479652, nRestarts: 0, ownerPids: [1525582] };

	test("identical readings are stable", () => {
		expect(diffStability(reading, { ...reading })).toEqual([]);
	});

	test("any movement during the check fails", () => {
		expect(diffStability(reading, { ...reading, mainPid: 1525583 })[0]).toContain("MainPID moved");
		expect(diffStability(reading, { ...reading, startEpoch: 1791479700 })[0]).toContain("process start moved");
		expect(diffStability(reading, { ...reading, nRestarts: 1 })[0]).toContain("NRestarts moved");
		expect(diffStability(reading, { ...reading, ownerPids: [1525582, 99] })[0]).toContain(":7410 owners moved");
	});
});
