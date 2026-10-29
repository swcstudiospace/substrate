#!/usr/bin/env bun
/**
 * Read-only production parity check (`bun run parity:check`).
 *
 * Gathers host facts about substrate-mcp.service — unit state, the pid that
 * holds 127.0.0.1:7410, /proc identity, one GET to /healthz, and read-only git
 * reads of the operator tree — then reports the verdict. Exit 0 pass, 1 a
 * criterion failed, 2 usage or an unreadable precondition. With `--json`
 * stdout is only the JSON object and the human lines go to stderr.
 *
 * It changes nothing: no state-changing systemctl verb, no /etc write, no
 * lock-taking git call (every git argv starts with --no-optional-locks), and
 * it prints pids, states and commits only — never an environment value.
 */
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolveBearer } from "../packages/cli/src/token.ts";
import { procStartSeconds } from "../packages/worktree-snapshot/src/proc-stat.ts";

/** The production port the check reads owners for in `ss` output. */
export const WATCHED_PORTS = [7410] as const;

/** The symlink production units use as WorkingDirectory. */
export const RELEASE_CURRENT = "/opt/agent-substrate/current";

const RELEASE_DIR = /^\/opt\/agent-substrate\/releases\/([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;

/** True when the unit runs from the pinned release rather than a git checkout. */
export function isPinnedWorkingDirectory(workingDirectory: string | null): boolean {
	if (workingDirectory === null) return false;
	const dir = workingDirectory.replace(/\/+$/, "");
	return dir === RELEASE_CURRENT || RELEASE_DIR.test(dir);
}

/**
 * A `current` symlink target. Relative `releases/<sha>` and the absolute
 * release path are accepted. A target that leaves `/opt/agent-substrate/releases` is not.
 */
export function releaseDirFromLink(target: string): { dir: string; sha: string } | null {
	const trimmed = target.trim();
	if (trimmed === "" || trimmed.includes("..") || trimmed.includes("\0")) return null;
	const absolute = trimmed.startsWith("/")
		? trimmed.replace(/\/+$/, "")
		: `/opt/agent-substrate/${trimmed.replace(/^\.\//, "").replace(/\/+$/, "")}`;
	const match = RELEASE_DIR.exec(absolute);
	const sha = match?.[1];
	if (!sha) return null;
	return { dir: absolute, sha };
}

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
		out.set(port, [...new Set([...(out.get(port) ?? []), ...pids])]);
	}
	return out;
}

/** cgroup v2 identity: the single line of /proc/<pid>/cgroup, trimmed. */
export function parseCgroup(text: string): string {
	return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
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
	/** True when WorkingDirectory is the pinned release, not the operator checkout. */
	pinned: boolean;
	/** Commit recorded by the release directory name. */
	releaseSha: string | null;
	/** Resolved `/opt/agent-substrate/releases/<sha>` the process must be in. */
	releaseDir: string | null;
	/** The release commit is an ancestor of origin/main. Null when not asked. */
	releaseOnMain: boolean | null;
	/** Last HEAD move epoch of the operator tree. Ignored for a pinned release. */
	headMoveEpoch: number | null;
	/** Server-path dirt from `status --porcelain`. Empty is clean. */
	dirtyPaths: string[];
	/** Server-path commits between HEAD and origin/main. Empty is none. */
	originDiffPaths: string[];
	/** origin/main sha present in the local object store. Null when unasked. */
	originShaKnown: boolean | null;
	/** `git ls-remote` could not read origin/main (no answer, no credentials, or no main branch). */
	originReadFailed: boolean;
	/** GET /healthz status. Null when not answering. */
	healthzStatus: number | null;
	/** Unit-file diff and sibling-unit inventory: notes, never failures. */
	warnings: string[];
}

export interface VerdictOptions {
	expectRestarts?: number | undefined;
	expectStart?: number | undefined;
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
	// The unit's own cgroup, under the slice the unit files name: `substrate.slice`
	// since uplift-2 R7, `system.slice` for a unit file without a `Slice=` line.
	// Anything else (a user session scope, a rehearsal twin) is not production.
	const slice = facts.cgroup?.split(":").pop() ?? null;
	if (slice !== "/substrate.slice/substrate-mcp.service" && slice !== "/system.slice/substrate-mcp.service") {
		failures.push(`cgroup is ${facts.cgroup ?? "(unknown)"}, want substrate.slice/substrate-mcp.service (or system.slice/ before the slice)`);
	}
	if (facts.healthzStatus === null) {
		failures.push("healthz is not answering on 127.0.0.1:7410");
	} else if (facts.healthzStatus === 401) {
		failures.push(
			"healthz answered 401 (auth on, token missing — set SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE or SUBSTRATE_TOKENS_DIR)",
		);
	} else if (facts.healthzStatus !== 200) {
		failures.push(`healthz answered ${facts.healthzStatus}, want 200`);
	}
	if (facts.pinned) {
		// /proc cwd is the resolved release directory. WorkingDirectory stays the symlink.
		if (facts.procCwd === null || facts.releaseDir === null || facts.procCwd !== facts.releaseDir) {
			failures.push(
				`process cwd ${facts.procCwd ?? "(unknown)"} is not the pinned release ${facts.releaseDir ?? "(unknown)"}`,
			);
		}
		if (!facts.releaseSha || !facts.releaseDir?.endsWith(`/${facts.releaseSha}`)) {
			failures.push(`pinned release has no commit sha (${facts.releaseSha ?? "unknown"})`);
		}
		if (facts.releaseOnMain !== true) {
			failures.push(
				facts.releaseOnMain === false
					? `release ${facts.releaseSha ?? "?"} is not on origin/main`
					: "could not ask whether the release commit is on origin/main",
			);
		}
	} else {
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
	}
	if (facts.originShaKnown !== true) {
		failures.push(
			facts.originReadFailed
				? "could not read origin/main (git ls-remote failed or origin has no main branch)"
				: facts.originShaKnown === false
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

/** MainPID, start epoch and restart count from parsed `systemctl show` props. */
export function parseUnitVitals(props: Map<string, string>): {
	mainPid: number | null;
	startEpoch: number | null;
	nRestarts: number | null;
} {
	const mainPidRaw = Number(props.get("MainPID") ?? "");
	const mainPid = Number.isInteger(mainPidRaw) && mainPidRaw > 0 ? mainPidRaw : null;
	const startEpoch = systemdTimestampToEpoch(props.get("ExecMainStartTimestamp"));
	const nRestartsRaw = Number(props.get("NRestarts") ?? "");
	const nRestarts = Number.isInteger(nRestartsRaw) && nRestartsRaw >= 0 ? nRestartsRaw : null;
	return { mainPid, startEpoch, nRestarts };
}

/**
 * The unit vitals plus the :7410 owners at one instant; the check reads
 * them before the probes and again after, and fails on any movement.
 */
export interface StabilityReading {
	mainPid: number | null;
	startEpoch: number | null;
	nRestarts: number | null;
	ownerPids: readonly number[];
}

/**
 * Failures when the unit moved during the check: a restart between the
 * first and final readings would mix two lifetimes into one verdict, so
 * any movement fails and `--expect-*` compares the final readings.
 */
export function diffStability(before: StabilityReading, after: StabilityReading): string[] {
	const failures: string[] = [];
	if (before.mainPid !== after.mainPid) {
		failures.push(`MainPID moved during the check (${before.mainPid ?? "(none)"} -> ${after.mainPid ?? "(none)"}); refusing a mixed reading`);
	}
	if (before.startEpoch !== after.startEpoch) {
		failures.push(`process start moved during the check (${before.startEpoch ?? "?"} -> ${after.startEpoch ?? "?"}); refusing a mixed reading`);
	}
	if (before.nRestarts !== after.nRestarts) {
		failures.push(`NRestarts moved during the check (${before.nRestarts ?? "?"} -> ${after.nRestarts ?? "?"}); refusing a mixed reading`);
	}
	if (before.ownerPids.join(",") !== after.ownerPids.join(",")) {
		failures.push(`:7410 owners moved during the check ([${before.ownerPids.join(", ")}] -> [${after.ownerPids.join(", ")}]); refusing a mixed reading`);
	}
	return failures;
}

// ── CLI main (read-only fact gathering) ──────────────────────────────────────

/** Server paths that decide "from main". */
const SERVER_PATHS = ["packages", "package.json", "bun.lock"];

const SYSTEMCTL_PROPS = "MainPID,ActiveState,SubState,NRestarts,ExecMainStartTimestamp,WorkingDirectory,FragmentPath";

const HEALTHZ_URL = "http://127.0.0.1:7410/healthz";
const SPAWN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INSTALLED_UNIT_FALLBACK = "/etc/systemd/system/substrate-mcp.service";

interface SpawnResult {
	code: number;
	out: string;
}

/**
 * The environment of every git child: a missing credential fails at once instead of waiting on a
 * terminal prompt nobody answers (the only other bound is the spawn timeout). GCM_INTERACTIVE covers
 * Git Credential Manager, which has its own prompt switch.
 */
export function gitSpawnEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
	return { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

/** Fixed argv, no shell, bounded: every systemctl, ss and git call goes here. `env` replaces the child's environment when given. */
function spawn(argv: string[], env?: Record<string, string | undefined>): SpawnResult | null {
	try {
		const run = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: SPAWN_TIMEOUT_MS, ...(env ? { env } : {}) });
		return { code: run.exitCode ?? -1, out: run.stdout.toString() };
	} catch {
		return null;
	}
}

/** The git repo used to ask whether a release sha is on origin/main. Not the process cwd. */
function operatorRepo(): string {
	const requested = process.env.SUBSTRATE_REPO;
	if (requested?.startsWith("/") && !requested.includes("\0") && !requested.includes("\n")) return requested;
	return "/root/src/repos/agent-substrate";
}

/** Every git argv leads with --no-optional-locks: the operator .git is shared with every worktree. */
function gitWork(dir: string, args: string[]): SpawnResult | null {
	return spawn(["git", "--no-optional-locks", "-C", dir, ...args], gitSpawnEnv(process.env));
}

export interface RemoteMainAncestry {
	originSha: string | null;
	originShaKnown: boolean | null;
	releaseOnMain: boolean | null;
	/** `git ls-remote` gave no usable commit: the remote read failed, not the local object-store question. */
	originReadFailed: boolean;
}

/**
 * Whether `releaseSha` is an ancestor of origin's `main`, asked with
 * read-only `git ls-remote`. The cached `origin/main` ref is not the target:
 * a stale tracking ref would fail a release that the remote already has.
 * Does not fetch. The ls-remote commit must already be in the local object store.
 */
export function releaseAncestryOnRemoteMain(repo: string, releaseSha: string): RemoteMainAncestry {
	const remote = gitWork(repo, ["ls-remote", "origin", "refs/heads/main"]);
	let originSha: string | null = null;
	if (remote !== null && remote.code === 0) {
		const sha = remote.out.trim().split(/\s+/)[0] ?? "";
		if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) originSha = sha;
	}
	if (originSha === null) {
		return { originSha: null, originShaKnown: null, releaseOnMain: null, originReadFailed: true };
	}
	const known = gitWork(repo, ["cat-file", "-e", `${originSha}^{commit}`]);
	const originShaKnown = known === null ? null : known.code === 0;
	if (originShaKnown !== true) {
		return { originSha, originShaKnown, releaseOnMain: null, originReadFailed: false };
	}
	const ancestor = gitWork(repo, ["merge-base", "--is-ancestor", releaseSha, originSha]);
	return {
		originSha,
		originShaKnown,
		releaseOnMain: ancestor === null ? null : ancestor.code === 0,
		originReadFailed: false,
	};
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function readBtime(): number | null {
	const stat = readText("/proc/stat");
	if (!stat) return null;
	const m = /^btime (\d+)$/m.exec(stat);
	return m?.[1] ? Number(m[1]) : null;
}

/** A `systemctl show` timestamp in --timestamp=unix form (@epoch); human form as fallback. Shared with the runtime doctor. */
export function systemdTimestampToEpoch(value: string | undefined): number | null {
	if (!value) return null;
	const at = /^@(\d+)$/.exec(value.trim());
	if (at?.[1]) return Number(at[1]);
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** One GET to /healthz with the resolver bearer for claude-code (D20-08); the token is never printed. */
async function probeHealthz(): Promise<number | null> {
	const token = resolveBearer("claude-code");
	try {
		const res = await fetch(HEALTHZ_URL, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		await res.text();
		return res.status;
	} catch {
		return null;
	}
}

function dead(message: string): 2 {
	process.stderr.write(`[parity:check] ${message}\n`);
	return 2;
}

function usage(message?: string): never {
	if (message) process.stderr.write(`[parity:check] ${message}\n`);
	process.stderr.write("usage: parity-check.ts [--json] [--expect-restarts N] [--expect-start EPOCH]\n");
	process.exit(2);
}

/**
 * Split a finished report between the two streams. Under `--json` stdout carries only the JSON object,
 * so `parity:check --json | jq` parses; every human line goes to stderr. Without it everything stays
 * on stdout, as before.
 */
export function routeParityOutput(json: boolean, human: string, jsonText: string | null): { stdout: string; stderr: string } {
	if (json) return { stdout: jsonText ?? "", stderr: human };
	return { stdout: human, stderr: "" };
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write("usage: parity-check.ts [--json] [--expect-restarts N] [--expect-start EPOCH]\n");
		return 0;
	}
	let json = false;
	let expectRestarts: number | undefined;
	let expectStart: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--json") {
			json = true;
		} else if (arg === "--expect-restarts" || arg === "--expect-start") {
			const raw = argv[i + 1];
			const value = raw === undefined ? NaN : Number(raw);
			if (!Number.isInteger(value) || value < 0) usage(`${arg} needs a non-negative integer`);
			i++;
			if (arg === "--expect-restarts") expectRestarts = value;
			else expectStart = value;
		} else {
			usage(`unknown argument: ${arg}`);
		}
	}

	const show = spawn(["systemctl", "show", "substrate-mcp", "-p", SYSTEMCTL_PROPS, "--timestamp=unix"]);
	if (show === null || show.code !== 0) return dead("could not read substrate-mcp via systemctl show.");
	const props = parseSystemctlShow(show.out);
	const { mainPid, startEpoch, nRestarts } = parseUnitVitals(props);
	const workdir = props.get("WorkingDirectory") ?? null;
	const activeState = props.get("ActiveState") ?? null;
	const subState = props.get("SubState") ?? null;

	const ss = spawn(["ss", "-ltnpH"]);
	if (ss === null || ss.code !== 0) return dead("could not read listeners via ss.");
	const owners = parseSsListeners(ss.out).get(7410) ?? [];

	let cgroup: string | null = null;
	let procCwd: string | null = null;
	let procStart: number | null = null;
	let entryPoint = "(unknown)";
	if (mainPid !== null) {
		const cgroupRaw = readText(`/proc/${mainPid}/cgroup`);
		const statRaw = readText(`/proc/${mainPid}/stat`);
		const cmdRaw = readText(`/proc/${mainPid}/cmdline`);
		let cwd: string | null = null;
		try {
			cwd = readlinkSync(`/proc/${mainPid}/cwd`);
		} catch {
			cwd = null;
		}
		if (cgroupRaw === null || statRaw === null || cwd === null) {
			return dead(`pid ${mainPid} vanished while reading /proc.`);
		}
		cgroup = parseCgroup(cgroupRaw);
		procCwd = cwd;
		const btime = readBtime();
		procStart = btime === null ? null : procStartSeconds(btime, statRaw);
		const tail = cmdRaw?.split("\0").filter(Boolean).at(-1) ?? null;
		if (tail) entryPoint = tail;
	}

	const healthzStatus = await probeHealthz();

	let headMoveEpoch: number | null = null;
	let dirtyPaths: string[] = [];
	let originDiffPaths: string[] = [];
	let originShaKnown: boolean | null = null;
	let originReadFailed = false;
	let headSha: string | null = null;
	let originSha: string | null = null;
	let pinned = false;
	let releaseSha: string | null = null;
	let releaseDir: string | null = null;
	let releaseOnMain: boolean | null = null;
	if (workdir !== null && isPinnedWorkingDirectory(workdir)) {
		// The release tree is a git archive: it has no reflog and no dirt to read.
		// "On main" is asked in the operator repo, which is not the process cwd.
		pinned = true;
		const dir = workdir.replace(/\/+$/, "");
		let linked = dir;
		if (dir === RELEASE_CURRENT) {
			let target: string;
			try {
				target = readlinkSync(dir);
			} catch {
				return dead("could not read /opt/agent-substrate/current.");
			}
			const parsed = releaseDirFromLink(target);
			if (parsed === null) return dead("current is not a releases/<sha> symlink.");
			linked = parsed.dir;
			releaseSha = parsed.sha;
		} else {
			const parsed = releaseDirFromLink(dir);
			if (parsed === null) return dead("refusing release path.");
			linked = parsed.dir;
			releaseSha = parsed.sha;
		}
		let resolved: string;
		try {
			resolved = realpathSync(linked);
		} catch {
			return dead(`release directory is missing: ${linked}.`);
		}
		if (resolved !== linked) return dead("release directory resolves outside releases/<sha>.");
		releaseDir = resolved;
		headSha = releaseSha;
		if (releaseSha !== null) {
			const ancestry = releaseAncestryOnRemoteMain(operatorRepo(), releaseSha);
			originSha = ancestry.originSha;
			originShaKnown = ancestry.originShaKnown;
			originReadFailed = ancestry.originReadFailed;
			releaseOnMain = ancestry.releaseOnMain;
		}
	} else if (workdir !== null) {
		const log = gitWork(workdir, ["log", "-g", "-n", "1", "--format=%H %gd %gs", "--date=unix", "HEAD"]);
		if (log === null || log.code !== 0) return dead(`could not read the reflog of ${workdir}.`);
		const line = log.out.trim();
		const first = line.split(/\s+/)[0];
		headSha = first ? first : null;
		headMoveEpoch = parseReflogTime(line);
		const status = gitWork(workdir, ["status", "--porcelain=v1", "--", ...SERVER_PATHS]);
		if (status === null || status.code !== 0) return dead(`could not read the status of ${workdir}.`);
		dirtyPaths = status.out
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const path = l.slice(3);
				const arrow = path.indexOf(" -> ");
				return arrow >= 0 ? path.slice(arrow + 4) : path;
			});
		const remote = gitWork(workdir, ["ls-remote", "origin", "refs/heads/main"]);
		if (remote !== null && remote.code === 0) {
			const sha = remote.out.trim().split(/\s+/)[0];
			originSha = sha ? sha : null;
		}
		originReadFailed = originSha === null;
		if (originSha) {
			const known = gitWork(workdir, ["cat-file", "-e", `${originSha}^{commit}`]);
			originShaKnown = known === null ? null : known.code === 0;
			if (originShaKnown === true) {
				const diff = gitWork(workdir, ["diff", "--name-only", "HEAD", originSha, "--", ...SERVER_PATHS]);
				if (diff === null || diff.code !== 0) return dead(`could not diff HEAD against origin/main in ${workdir}.`);
				originDiffPaths = diff.out.split("\n").map((l) => l.trim()).filter(Boolean);
			}
		}
	}

	const warnings: string[] = [];
	if (startEpoch !== null && procStart !== null && Math.abs(startEpoch - procStart) > 2) {
		warnings.push(`systemd start ${startEpoch} disagrees with /proc start ${Math.floor(procStart)}`);
	}
	const fragment = props.get("FragmentPath") ?? INSTALLED_UNIT_FALLBACK;
	const installed = readText(fragment);
	const unitRoot = releaseDir ?? workdir;
	const repoUnit = unitRoot === null ? null : readText(`${unitRoot}/infra/vps/substrate-mcp.service`);
	if (installed === null) warnings.push(`installed unit is unreadable at ${fragment}`);
	else if (repoUnit === null) warnings.push("repo unit is unreadable; unit-file diff skipped");
	else if (installed !== repoUnit) warnings.push("installed unit differs from the repo unit");
	const siblings = spawn(["systemctl", "list-units", "substrate-*", "--all", "--no-legend", "--plain"]);
	if (siblings === null || siblings.code !== 0) {
		warnings.push("could not list sibling substrate units");
	} else {
		for (const line of siblings.out.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) warnings.push(`unit: ${trimmed}`);
		}
	}

	// The probes above take seconds; re-read the vitals and the listener so
	// the verdict never mixes two unit lifetimes. `--expect-*` compares
	// these final readings, and any movement during the check fails.
	const show2 = spawn(["systemctl", "show", "substrate-mcp", "-p", SYSTEMCTL_PROPS, "--timestamp=unix"]);
	if (show2 === null || show2.code !== 0) return dead("could not re-read substrate-mcp after the probes.");
	const vitals = parseUnitVitals(parseSystemctlShow(show2.out));
	const ss2 = spawn(["ss", "-ltnpH"]);
	if (ss2 === null || ss2.code !== 0) return dead("could not re-read listeners after the probes.");
	const owners2 = parseSsListeners(ss2.out).get(7410) ?? [];
	const stability = diffStability(
		{ mainPid, startEpoch, nRestarts, ownerPids: owners },
		{ mainPid: vitals.mainPid, startEpoch: vitals.startEpoch, nRestarts: vitals.nRestarts, ownerPids: owners2 },
	);
	const finalPid = vitals.mainPid;
	const finalStart = vitals.startEpoch;
	const finalRestarts = vitals.nRestarts;

	const verdict = parityVerdict(
		{
			mainPid: finalPid,
			activeState,
			subState,
			nRestarts: finalRestarts,
			startEpoch: finalStart,
			ssOwnerPids: owners2,
			cgroup,
			procCwd,
			workingDirectory: workdir,
			pinned,
			releaseSha,
			releaseDir,
			releaseOnMain,
			headMoveEpoch,
			dirtyPaths,
			originDiffPaths,
			originShaKnown,
			originReadFailed,
			healthzStatus,
			warnings,
		},
		{ expectRestarts, expectStart },
	);
	const failures = [...verdict.failures, ...stability];
	const pass = failures.length === 0;

	const human =
		`[parity:check] MainPID=${finalPid ?? "(none)"} ${activeState ?? "?"}/${subState ?? "?"} NRestarts=${finalRestarts ?? "?"} start=${finalStart ?? "?"}\n` +
		`[parity:check] :7410 owners=[${owners2.join(", ")}] cgroup=${cgroup ?? "(unknown)"} entry=${entryPoint}\n` +
		`[parity:check] tree=${workdir ?? "(unknown)"} HEAD=${headSha ?? "?"} origin=${originSha ?? "?"} healthz=${healthzStatus ?? "(unreachable)"}\n` +
		failures.map((failure) => ` FAIL  ${failure}\n`).join("") +
		verdict.warnings.map((warning) => `  --   ${warning}\n`).join("") +
		(pass ? "[parity:check] PASS\n" : `[parity:check] FAIL — ${failures.length} criterion(s) failed\n`);
	const jsonText = json
		? `${JSON.stringify({ pass, failures, warnings: verdict.warnings, mainPid: finalPid, nRestarts: finalRestarts, startEpoch: finalStart, headSha, originSha, releaseSha, healthzStatus }, null, 2)}\n`
		: null;
	const routed = routeParityOutput(json, human, jsonText);
	if (routed.stdout) process.stdout.write(routed.stdout);
	if (routed.stderr) process.stderr.write(routed.stderr);
	return pass ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
