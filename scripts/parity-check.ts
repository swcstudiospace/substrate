#!/usr/bin/env bun
/**
 * Read-only production parity check (`bun run parity:check`).
 *
 * Gathers host facts about substrate-mcp.service — unit state, the pid that
 * holds 127.0.0.1:7410, /proc identity, one GET to /healthz, and read-only git
 * reads of the operator tree — then reports the verdict. Exit 0 pass, 1 a
 * criterion failed, 2 usage or an unreadable precondition.
 *
 * It changes nothing: no state-changing systemctl verb, no /etc write, no
 * lock-taking git call (every git argv starts with --no-optional-locks), and
 * it prints pids, states and commits only — never an environment value.
 */

/** Production ports the check watches in `ss` output. */
export const WATCHED_PORTS = [7410, 7411, 6420] as const;

/** `systemctl show` key=value lines into a map, independent of property order. */
export function parseSystemctlShow(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		out.set(line.slice(0, eq), line.slice(eq + 1));
	}
	return out;
}

/**
 * `ss -ltnpH` lines into local-port → owner pids. Every `pid=N` inside the
 * `users:(…)` parens is collected, because a forked socket lists several.
 * IPv4, bracketed IPv6, wildcard and 0.0.0.0 holders all match: the port is
 * whatever follows the last colon of the local address field.
 */
export function parseSsListeners(text: string, ports: readonly number[] = WATCHED_PORTS): Map<number, number[]> {
	const wanted = new Set(ports);
	const out = new Map<number, number[]>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = trimmed.split(/\s+/);
		if (fields.length < 5) continue;
		const local = fields[3] ?? "";
		const colon = local.lastIndexOf(":");
		if (colon < 0) continue;
		const port = Number(local.slice(colon + 1));
		if (!wanted.has(port)) continue;
		const pids: number[] = [];
		for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
		out.set(port, [...(out.get(port) ?? []), ...pids]);
	}
	return out;
}

/** cgroup v2 identity: the single line of /proc/<pid>/cgroup, trimmed. */
export function parseCgroup(text: string): string {
	return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Process start epoch: btime (from /proc/stat) plus stat field 22 — the
 * starttime ticks after the last close paren, because comm may hold spaces
 * and parens — divided by the clock tick rate.
 */
export function procStartSeconds(btime: number, stat: string, clkTck = 100): number | null {
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	const rest = stat.slice(close + 1).trim().split(/\s+/);
	// After comm: state is field 3, so starttime (field 22) sits at index 19.
	if (rest.length < 20) return null;
	const ticks = Number(rest[19]);
	if (!Number.isFinite(ticks) || ticks < 0) return null;
	return btime + ticks / clkTck;
}

/**
 * Last HEAD move epoch from `git log -g` output: the unix time inside
 * `HEAD@{…}`. Commit time (%ct) is not the move time, so it is not used.
 */
export function parseReflogTime(line: string): number | null {
	const m = /HEAD@\{(\d+)\}/.exec(line);
	return m ? Number(m[1]) : null;
}

export interface ParityFacts {
	mainPid: number | null;
	activeState: string | null;
	subState: string | null;
	nRestarts: number | null;
	startEpoch: number | null;
	/** Every pid `ss` reports as holding 127.0.0.1:7410. */
	ssOwnerPids: number[];
	/** Raw /proc/<pid>/cgroup line. */
	cgroup: string | null;
	/** readlink /proc/<pid>/cwd. */
	procCwd: string | null;
	workingDirectory: string | null;
	/** Last HEAD move epoch of the operator tree. */
	headMoveEpoch: number | null;
	/** Server-path dirt from `status --porcelain`. Empty is clean. */
	dirtyPaths: string[];
	/** Server-path commits between HEAD and origin/main. Empty is none. */
	originDiffPaths: string[];
	/** origin/main sha present in the local object store. Null when unasked. */
	originShaKnown: boolean | null;
	/** GET /healthz status. Null when not answering. */
	healthzStatus: number | null;
	/** Unit-file diff and sibling-unit inventory: notes, never failures. */
	warnings: string[];
}

export interface VerdictOptions {
	expectRestarts?: number;
	expectStart?: number;
}

export interface ParityVerdictResult {
	pass: boolean;
	failures: string[];
	warnings: string[];
}

/**
 * The SC-3 verdict over gathered facts. Pass needs every criterion at once;
 * warnings ride along as notes and never flip the result.
 */
export function parityVerdict(facts: ParityFacts, opts: VerdictOptions = {}): ParityVerdictResult {
	const failures: string[] = [];
	if (facts.activeState !== "active" || facts.subState !== "running") {
		failures.push(`unit is ${facts.activeState ?? "(unknown)"}/${facts.subState ?? "(unknown)"}, want active/running`);
	}
	if (facts.mainPid === null || facts.ssOwnerPids.length !== 1 || facts.ssOwnerPids[0] !== facts.mainPid) {
		failures.push(`port 7410 owners [${facts.ssOwnerPids.join(", ")}] are not exactly MainPID ${facts.mainPid ?? "(unknown)"}`);
	}
	const slice = facts.cgroup?.split(":").pop() ?? null;
	if (slice !== "/system.slice/substrate-mcp.service") {
		failures.push(`cgroup is ${facts.cgroup ?? "(unknown)"}, want system.slice/substrate-mcp.service`);
	}
	if (facts.healthzStatus === null) {
		failures.push("healthz is not answering on 127.0.0.1:7410");
	} else if (facts.healthzStatus === 401) {
		failures.push("healthz answered 401 (auth is configured — set SUBSTRATE_TOKEN)");
	} else if (facts.healthzStatus !== 200) {
		failures.push(`healthz answered ${facts.healthzStatus}, want 200`);
	}
	if (facts.procCwd === null || facts.workingDirectory === null || facts.procCwd !== facts.workingDirectory) {
		failures.push(
			`process cwd ${facts.procCwd ?? "(unknown)"} is not the unit WorkingDirectory ${facts.workingDirectory ?? "(unknown)"}`,
		);
	}
	if (facts.startEpoch === null || facts.headMoveEpoch === null || !(facts.startEpoch > facts.headMoveEpoch)) {
		failures.push(
			`process start ${facts.startEpoch ?? "(unknown)"} is not after the last HEAD move ${facts.headMoveEpoch ?? "(unknown)"}`,
		);
	}
	if (facts.dirtyPaths.length > 0) {
		failures.push(`server paths modified under the operator tree: ${facts.dirtyPaths.join(", ")}`);
	}
	if (facts.originDiffPaths.length > 0) {
		failures.push(`server-path commits between HEAD and origin/main: ${facts.originDiffPaths.join(", ")}`);
	}
	if (facts.originShaKnown !== true) {
		failures.push(
			facts.originShaKnown === false
				? "origin/main is not in the local object store; updating it is an operator action"
				: "could not ask whether origin/main is local",
		);
	}
	if (opts.expectRestarts !== undefined && facts.nRestarts !== opts.expectRestarts) {
		failures.push(`NRestarts is ${facts.nRestarts ?? "(unknown)"}, want ${opts.expectRestarts}`);
	}
	if (opts.expectStart !== undefined && facts.startEpoch !== opts.expectStart) {
		failures.push(`start epoch is ${facts.startEpoch ?? "(unknown)"}, want ${opts.expectStart}`);
	}
	return { pass: failures.length === 0, failures, warnings: [...facts.warnings] };
}

function usage(): never {
	process.stderr.write(
		"[parity:check] read-only production parity check\nusage: parity-check.ts [--json] [--expect-restarts N] [--expect-start EPOCH]\n",
	);
	process.exit(2);
}

/** Fact gathering lands here (task 2); the parsers and verdict above are final. */
export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write("usage: parity-check.ts [--json] [--expect-restarts N] [--expect-start EPOCH]\n");
		return 0;
	}
	usage();
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
