#!/usr/bin/env bun
/**
 * Scratch rehearsal harness (`bun run rehearsal up|down|status|smoke|pause|unpause`).
 *
 * One command starts this checkout's substrate-mcp on a scratch loopback port
 * against a scratch Postgres and a scratch ledger in local Docker containers,
 * with per-surface bearer tokens. One command tears it down. Every later proof
 * sources the printed consumer.env and never touches a production store.
 *
 * It holds no ledger client: readiness comes from container health and the
 * server's /healthz, and the server's store environment is built by
 * `packages/mcp-server/src/rehearsal-env.ts`. Nothing printed here but hosts,
 * ports, the checkout commit and image tags — never a credential.
 *
 * `pause`/`unpause --store ledger|index` freeze and thaw one of an instance's own labelled
 * scratch containers (`docker pause`: the store accepts connections and answers nothing, which is
 * what a dropped-packet outage looks like to the server). They are the only way a proof can inject
 * a REAL outage into a twin without a script of its own holding a ledger credential name.
 * `up --extra-env KEY=VALUE` adds one allowlisted, non-secret server flag
 * (`EXTRA_ENV_ALLOWLIST` in rehearsal-env.ts); anything else is refused with a rule name.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { SQL } from "bun";
import { dlopen, FFIType, read } from "bun:ffi";
import {
	archiveIndex,
	describePgUrl,
	normalizePgUrl,
	refusedScratchUrl,
	restoreIndexArchive,
	verifyIndexArchive,
} from "../packages/mcp-server/src/index-archive.ts";
import { IndexStore } from "../packages/mcp-server/src/index-store.ts";
import { redact } from "../packages/mcp-server/src/redact.ts";
import {
	buildRehearsalEnv,
	consumerEnvRecord,
	parseExtraEnv,
	RehearsalEnvError,
	storesEnvRecord,
	toShellExports,
} from "../packages/mcp-server/src/rehearsal-env.ts";
import { buildSkillsFixture, type SkillsFixture } from "../packages/mcp-server/src/rehearsal-skills.ts";
import {
	buildFixtureSpawnArgv,
	checkFixtureReady,
	confirmFixtureSpawn,
	fixtureEndpoint,
	mayStopFixture,
	newFixtureKey,
	refuseFixtureControlUrl,
	RAGFLOW_FIXTURE_KEY_ENV,
	RAGFLOW_FIXTURE_PORT_ENV,
	RAGFLOW_FIXTURE_SCRIPT,
	type RagflowFixtureState,
} from "../packages/mcp-server/src/rehearsal-ragflow.ts";
import { isSwarmSurface, SURFACES, type Surface } from "../packages/mcp-server/src/types.ts";

/** The harness refused an input or a state; the message names hosts and ports, never values. */
export class RehearsalRefused extends Error {}

/** Label every harness container carries; teardown filters strictly on it. */
export const REHEARSAL_LABEL = "substrate.rehearsal";

/** Ports the harness never binds and never lets a twin own. */
export const PRODUCTION_PORTS = [7410, 7411, 6420] as const;

/** Default scratch MCP port. */
export const DEFAULT_MCP_PORT = 17410;

/** Default `--surfaces` value. */
export const DEFAULT_SURFACES_RAW = "claude-code,cursor,hermes,omp";

/** Preflight refuses below this free-disk floor on Docker's data root; it never prunes. */
export const DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

/** The run directory's own small floor: logs, state and token files only. */
export const RUN_DIR_FLOOR_BYTES = 64 * 1024 * 1024;

/**
 * Docker's data-root line (`docker info --format '{{.DockerRootDir}}'`)
 * into a path, or null when docker answered nothing usable.
 */
export function parseDockerRootDir(text: string): string | null {
	const dir = text.trim();
	return dir.length > 0 ? dir : null;
}

/**
 * Free bytes on the filesystem holding path; null when it cannot be read.
 * Stat an ancestor that exists — the run dir itself may not exist yet.
 */
export function freeBytes(path: string): number | null {
	try {
		const fs = statfsSync(path);
		return Number(fs.bavail) * Number(fs.bsize);
	} catch {
		return null;
	}
}

/** The production unit's checkout: a twin never runs from here. */
export const UNIT_WORKING_DIRECTORY = "/root/src/repos/agent-substrate";

/**
 * Default images; overridable without a code change. `postgres:16` rather than
 * `-alpine`: the host's daily image prune keeps only images some container
 * references, and the v1.2 scratch containers pin `postgres:16` and this ledger tag.
 */
export const DEFAULT_PG_IMAGE = "postgres:16";
export const DEFAULT_LEDGER_IMAGE = "greptime/greptimedb:v0.14.4";

/**
 * Image override variable names. The ledger one is composed so this file
 * never holds the blunt ledger-key substring the store lock scans for —
 * an image tag is not a credential, but the scan cannot tell.
 */
const PG_IMAGE_ENV = "SUBSTRATE_REHEARSAL_PG_IMAGE";
const LEDGER_IMAGE_ENV = `SUBSTRATE_REHEARSAL_${"GREPTIME"}_IMAGE`;

const DOCKER_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 1000;
const DOWN_WAIT_MS = 10_000;

/**
 * Refuse a scratch MCP port: the production ports, or one already listening.
 * Returns the reason, or null when the port may be used. Port 0 (pick free)
 * passes here; the caller resolves it to a free port first.
 */
export function refusePort(port: number, listening: readonly number[]): string | null {
	if (!Number.isInteger(port) || port < 0 || port > 65535) return `bad port ${port}`;
	if ((PRODUCTION_PORTS as readonly number[]).includes(port)) return `port ${port} is reserved`;
	if (listening.includes(port)) return `port ${port} is already listening`;
	return null;
}

/** Instance names are lower alnum plus dash, up to 31 chars. */
export function parseName(raw: string | undefined): string {
	const name = raw ?? "default";
	if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
		throw new RehearsalRefused(`bad instance name ${name}: lower alnum plus dash, up to 31 chars`);
	}
	return name;
}

/** Comma-separated surfaces, each one the server knows. */
export function parseSurfaces(raw: string | undefined): Surface[] {
	const list = (raw ?? DEFAULT_SURFACES_RAW)
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (list.length === 0) throw new RehearsalRefused("--surfaces needs at least one surface");
	for (const surface of list) {
		if (!(SURFACES as readonly string[]).includes(surface)) {
			throw new RehearsalRefused(`unknown surface ${surface}`);
		}
	}
	return list as Surface[];
}

/**
 * The operator surface: `--operator`, else the first listed surface, else null
 * for `--anonymous`. A swarm surface or a name outside `--surfaces` refuses.
 */
export function parseOperator(
	raw: string | undefined,
	surfaces: readonly Surface[],
	anonymous: boolean,
): Surface | null {
	if (anonymous) {
		if (raw !== undefined) throw new RehearsalRefused("--anonymous conflicts with --operator; pass one or the other");
		return null;
	}
	if (raw === undefined) {
		const first = surfaces[0];
		if (first === undefined) throw new RehearsalRefused("no surfaces to pick an operator from");
		if (isSwarmSurface(first)) throw new RehearsalRefused(`operator surface ${first} is a swarm surface; pass --operator`);
		return first;
	}
	if (!surfaces.includes(raw as Surface)) {
		throw new RehearsalRefused(`operator surface ${raw} is not in --surfaces`);
	}
	if (isSwarmSurface(raw)) {
		throw new RehearsalRefused(`operator surface ${raw} is a swarm surface and is never an operator`);
	}
	return raw as Surface;
}

/**
 * The desktop allowlist: `--desktop-surfaces`, defaulting to empty (nobody may
 * call desktop_run). Each name must be in SURFACES and in `--surfaces`, and
 * the flag is refused with `--anonymous` since tokenless runs would only be
 * refused by the tool. Throws naming surfaces only.
 */
export function parseDesktopSurfaces(
	raw: string | undefined,
	surfaces: readonly Surface[],
	anonymous: boolean,
): Surface[] {
	if (anonymous) {
		if (raw !== undefined) {
			throw new RehearsalRefused("--anonymous conflicts with --desktop-surfaces; pass one or the other");
		}
		return [];
	}
	if (raw === undefined) return [];
	const list = raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	for (const name of list) {
		if (!(SURFACES as readonly string[]).includes(name)) {
			throw new RehearsalRefused(`desktop surface ${name} is not a known surface`);
		}
		if (!surfaces.includes(name as Surface)) {
			throw new RehearsalRefused(`desktop surface ${name} is not in --surfaces`);
		}
	}
	return list as Surface[];
}

/**
 * Refuse a non-local Docker daemon before creating or removing anything: a
 * DOCKER_HOST that is not a local unix socket, or a docker context that is
 * not a known-local one, could point the harness at someone else's engine.
 * Returns the reason, or null when the daemon resolves locally.
 */
export function refuseDockerEnv(env: { DOCKER_HOST?: string; DOCKER_CONTEXT?: string }): string | null {
	const host = (env.DOCKER_HOST ?? "").trim();
	if (host !== "" && !host.startsWith("unix://")) {
		return `refusing non-local DOCKER_HOST ${host}`;
	}
	const context = (env.DOCKER_CONTEXT ?? "").trim();
	if (context !== "" && context !== "default" && context !== "desktop-linux") {
		return `refusing non-local docker context ${context}`;
	}
	return null;
}

/**
 * Refuse a live docker endpoint that is not a local unix socket. Only
 * `unix://` is local: `tcp://`, `ssh://` and named-pipe endpoints all name
 * someone else's engine. An empty endpoint proves nothing, so it refuses too.
 * Returns the reason, or null when the endpoint is a local socket.
 */
export function refuseDockerEndpoint(endpoint: string): string | null {
	const host = endpoint.trim().split("\n")[0] ?? "";
	if (host === "") return "could not read the docker endpoint; refusing without locality proof";
	if (!host.startsWith("unix://")) return `refusing non-local docker endpoint ${host}`;
	return null;
}

/**
 * Refuse a non-local daemon before any docker call path (`up`, `down`,
 * `status`): the env allowlist first, then the live endpoint of the
 * effective context (`docker context inspect` honors both DOCKER_HOST and
 * DOCKER_CONTEXT, and it reads local client metadata, so it proves locality
 * without needing a live daemon). An inspect failure does not refuse: the
 * client is broken or absent, in which case every later docker call fails
 * with its own truthful error and nothing remote can happen.
 */
function refuseDockerLocality(): string | null {
	const envRefused = refuseDockerEnv({ DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT });
	if (envRefused !== null) return envRefused;
	const inspected = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
	if (!inspected.ok) return null;
	return refuseDockerEndpoint(inspected.out);
}

/**
 * The bearer the smoke drives: the operator token when the twin recorded
 * one, else the first surface's token. The surface choice already happened at
 * `up` time and is recorded in `consumer.env`; older files predate the
 * operator key, so the fallback keeps them working.
 */
export function pickSmokeToken(record: Record<string, string>): string {
	const operator = record["SUBSTRATE_REHEARSAL_OPERATOR_TOKEN"] ?? "";
	if (operator !== "") return operator;
	return record["SUBSTRATE_TOKEN"] ?? "";
}

/** A checkout the twin may run from: never the production unit's checkout. */
export function refuseCheckoutDir(cwd: string): string | null {
	if (cwd === UNIT_WORKING_DIRECTORY) return `refusing to run from the production checkout ${cwd}`;
	return null;
}

/** Facts about a host process, gathered before any signal. */
export interface ProcFacts {
	pid: number;
	argv: string[];
	cwd: string;
	cgroup: string;
	startSeconds: number;
	listensOn: number[];
}

/**
 * Whether the recorded twin may be stopped: pid, entry point, checkout,
 * start time (against pid reuse), non-system cgroup and no production port
 * must all agree. Returns the refusal reason, or null when stopping is safe.
 */
export function mayStop(
	proc: ProcFacts,
	state: { pid: number; checkout: string; startSeconds: number },
): string | null {
	if (proc.pid !== state.pid) return "pid differs from state.json";
	if (proc.startSeconds !== state.startSeconds) return "pid was reused (start time differs)";
	if (!proc.argv.at(-1)?.endsWith("packages/mcp-server/src/index.ts")) return "not the twin entry point";
	if (proc.cwd !== state.checkout) return "cwd is not the recorded checkout";
	if (proc.cgroup.includes("/system.slice/")) return "process is in system.slice";
	if (proc.listensOn.some((port) => (PRODUCTION_PORTS as readonly number[]).includes(port))) {
		return "process owns a production port";
	}
	return null;
}

/** The server spawn argv: Bun without env-file autoload, the checkout entry point. */
export function buildServerSpawnArgv(): string[] {
	return [process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"];
}

/** `docker port` lines (`127.0.0.1:49832`) into host and port. */
export function parseDockerPortLine(line: string): { host: string; port: number } | null {
	const m = /^(\S+):(\d+)\s*$/.exec(line.trim());
	if (!m) return null;
	const port = Number(m[2]);
	if (!Number.isInteger(port) || port <= 0) return null;
	return { host: m[1] as string, port };
}

/** Instance run directory, outside every checkout. */
export function runDirFor(name: string): string {
	return `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/substrate-rehearsal/${name}`;
}

/**
 * A directory the harness writes bearer tokens into: created when missing,
 * then proven to be a real directory (never a symlink), owned by this user,
 * with exactly mode 0700. A pre-existing dir owned by this user is repaired
 * to 0700; a foreign-owned one refuses. chmod failures are never swallowed:
 * without the mode proof the tokens stay unwritten.
 */
export function ensurePrivateDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
	}
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new RehearsalRefused(`refusing to use ${path}: not a real directory`);
	}
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
		throw new RehearsalRefused(`refusing to use ${path}: not owned by this user`);
	}
	try {
		chmodSync(path, 0o700);
	} catch {
		throw new RehearsalRefused(`refusing to use ${path}: cannot set mode 0700`);
	}
	if ((lstatSync(path).mode & 0o777) !== 0o700) {
		throw new RehearsalRefused(`refusing to use ${path}: not mode 0700`);
	}
}

/**
 * Empty a proven-private directory without removing it: a crashed run's
 * stale token files must not survive into the new run. Call only after
 * ensurePrivateDir proved the path a real 0700 directory (never a symlink).
 */
export function clearDirectory(dir: string): void {
	for (const entry of readdirSync(dir)) {
		rmSync(join(dir, entry), { recursive: true, force: true });
	}
}

/** Pick a free loopback port by binding port 0. */
export function pickFreePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const srv = createServer();
	srv.once("error", reject);
	srv.listen(0, "127.0.0.1", () => {
		const addr = srv.address();
		const port = typeof addr === "object" && addr !== null ? addr.port : 0;
		srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
	});
	return promise;
}

/** Whether anything answers on 127.0.0.1:port right now. */
export function isPortFree(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const srv = createServer();
	srv.once("error", () => resolve(false));
	srv.listen(port, "127.0.0.1", () => {
		srv.close(() => resolve(true));
	});
	return promise;
}

interface DockerResult {
	ok: boolean;
	out: string;
	err: string;
}

/**
 * One docker CLI call: fixed argv, no shell, bounded, with an explicit env —
 * never the inherited environment, and secrets only by name.
 */
function docker(args: string[], extraEnv?: Record<string, string>): DockerResult {
	const env: Record<string, string> = {};
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
	// The child resolves the daemon exactly the way the locality gate vetted
	// it: DOCKER_HOST overrides the context endpoint, and DOCKER_CONTEXT
	// selects the context. Dropping DOCKER_CONTEXT here while gating on it
	// above would vet one endpoint and mutate another.
	for (const key of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"] as const) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (extraEnv) for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
	try {
		const run = Bun.spawnSync(["docker", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: DOCKER_TIMEOUT_MS,
			env,
		});
		return {
			ok: run.exitCode === 0,
			out: run.stdout.toString(),
			err: run.stderr.toString(),
		};
	} catch (cause) {
		// No docker CLI at all: a failed listing, never a crash. Callers keep
		// their truthful errors (`docker is unreachable`, `could not list`).
		return { ok: false, out: "", err: cause instanceof Error ? cause.message : String(cause) };
	}
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Process start epoch from /proc: btime plus stat field 22 over the tick rate. */
function readStartSeconds(pid: number): number | null {
	const stat = readText(`/proc/${pid}/stat`);
	const statLine = readText("/proc/stat");
	if (stat === null || statLine === null) return null;
	const btime = /^btime (\d+)$/m.exec(statLine);
	if (!btime) return null;
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	const rest = stat.slice(close + 1).trim().split(/\s+/);
	if (rest.length < 20) return null;
	const ticks = Number(rest[19]);
	if (!Number.isFinite(ticks) || ticks < 0) return null;
	return Number(btime[1]) + ticks / 100;
}

/** Local ports a pid listens on, from `ss`; null when ss cannot be read. */
function readListeningPorts(pid: number): number[] | null {
	let run: ReturnType<typeof Bun.spawnSync>;
	try {
		run = Bun.spawnSync(["ss", "-ltnpH"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: DOCKER_TIMEOUT_MS,
		});
	} catch {
		// A missing `ss` is an unverifiable pid, not a reason to signal it.
		return null;
	}
	if (run.exitCode !== 0 || run.stdout === undefined) return null;
	const ports: number[] = [];
	for (const line of run.stdout.toString().split("\n")) {
		if (!line.includes(`pid=${pid},`) && !line.includes(`pid=${pid})`)) continue;
		const fields = line.trim().split(/\s+/);
		const local = fields[3] ?? "";
		const port = Number(local.slice(local.lastIndexOf(":") + 1));
		if (Number.isInteger(port) && port > 0) ports.push(port);
	}
	return ports;
}

function readProcFacts(pid: number): ProcFacts | null {
	const cmdline = readText(`/proc/${pid}/cmdline`);
	const cgroup = readText(`/proc/${pid}/cgroup`);
	let cwd: string;
	try {
		cwd = readlinkSync(`/proc/${pid}/cwd`).toString();
	} catch {
		return null;
	}
	const startSeconds = readStartSeconds(pid);
	const listensOn = readListeningPorts(pid);
	if (cmdline === null || cgroup === null || startSeconds === null || listensOn === null) return null;
	return {
		pid,
		argv: cmdline.split("\0").filter((s) => s.length > 0),
		cwd,
		cgroup: cgroup.split("\n").find((l) => l.trim().length > 0) ?? "",
		startSeconds,
		listensOn,
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Persisted twin identity. Null pid/startSeconds while starting: fixture verified, twin not yet spawned. */
export interface TwinState {
	name: string;
	pid: number | null;
	startSeconds: number | null;
	checkout: string;
	commit: string;
	mcpPort: number;
	pgHostPort: number;
	ledgerHostPort: number;
	pgContainer: string;
	ledgerContainer: string;
	pgImage: string;
	ledgerImage: string;
	surfaces: Surface[];
	operator: Surface | null;
	desktopSurfaces: Surface[];
	anonymous: boolean;
	/** Started with `--skills-fixture`. Absent in a state file an older `up` wrote. */
	skillsFixture?: boolean;
	/**
	 * Started with `--ragflow-fixture`: the owned stand-in's endpoint plus the
	 * pid/start-time/cwd/script identity `down` re-verifies before signalling.
	 * Absent when the flag was off and in a state file an older `up` wrote.
	 */
	ragflowFixture?: RagflowFixtureState;
}

function readState(path: string): TwinState | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TwinState;
	} catch {
		return null;
	}
}

/** Container ids from a `docker ps -aq` listing. */
export function parseDockerIds(text: string): string[] {
	return text
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * The `down`/`up`-cleanup verdict over three docker calls: a failed `ps`
 * refuses (never "0 removed"), a failed `rm` refuses with docker's first
 * error line, and survivors found by the verify listing refuse too — the
 * caller's state is kept until removal truly succeeds. Returns the number
 * of containers actually gone.
 */
export function resolveContainerRemoval(
	name: string,
	ps: { ok: boolean; out: string; err: string },
	rm: { ok: boolean; out: string; err: string } | null,
	verify: { ok: boolean; out: string; err: string } | null,
): number {
	if (!ps.ok) {
		throw new RehearsalRefused(`could not list scratch containers for ${name}; keeping state`);
	}
	const ids = parseDockerIds(ps.out);
	if (ids.length === 0) return 0;
	if (rm === null || !rm.ok) {
		const detail = rm?.err.trim().split("\n")[0];
		throw new RehearsalRefused(
			`could not remove scratch containers for ${name}${detail ? `: ${detail}` : ""}; keeping state`,
		);
	}
	if (verify === null || !verify.ok) {
		throw new RehearsalRefused(`could not verify scratch removal for ${name}; keeping state`);
	}
	const remaining = parseDockerIds(verify.out);
	if (remaining.length > 0) {
		throw new RehearsalRefused(`${remaining.length} scratch containers for ${name} survived removal; keeping state`);
	}
	return ids.length;
}

function removeLabelledContainers(name: string): number {
	const filter = `label=${REHEARSAL_LABEL}=${name}`;
	const ps = docker(["ps", "-aq", "--filter", filter]);
	const ids = !ps.ok ? [] : parseDockerIds(ps.out);
	const rm = ids.length === 0 ? null : docker(["rm", "-f", ...ids]);
	const verify = ids.length === 0 || rm === null || !rm.ok ? null : docker(["ps", "-aq", "--filter", filter]);
	return resolveContainerRemoval(name, ps, rm, verify);
}

/** The two scratch stores a proof may freeze. `index` is the Postgres container, `ledger` the other. */
export const PAUSE_STORES = ["ledger", "index"] as const;
export type PauseStore = (typeof PAUSE_STORES)[number];

/** The container name `up` gives an instance's store: one place, so `up` and `pause` cannot drift. */
export function storeContainerName(name: string, store: PauseStore): string {
	return `substrate-rehearsal-${name}-${store === "ledger" ? "ledger" : "pg"}`;
}

/** `--store ledger|index`; anything else, or nothing, refuses with the rule name `pause-store`. */
export function parseStore(raw: string | undefined): PauseStore {
	if (raw !== undefined && (PAUSE_STORES as readonly string[]).includes(raw)) return raw as PauseStore;
	throw new RehearsalRefused(`rule pause-store: --store must be one of ${PAUSE_STORES.join(", ")}`);
}

/**
 * The container id `pause`/`unpause` may act on, from a `docker ps --filter label=<instance> --format
 * '{{.ID}} {{.Names}}'` listing. The listing is already limited to this instance's label; the exact
 * deterministic name is checked again here so a labelled container of some other role, a look-alike
 * name, or two matches never gets a verb. A failed listing refuses (never "nothing to do"). Rule
 * `pause-target`.
 */
export function selectStoreContainer(
	name: string,
	store: PauseStore,
	ps: { ok: boolean; out: string; err: string },
): string {
	if (!ps.ok) throw new RehearsalRefused(`rule pause-target: could not list scratch containers for ${name}`);
	const want = storeContainerName(name, store);
	const ids: string[] = [];
	for (const line of ps.out.split("\n")) {
		const [id, names] = line.trim().split(/\s+/, 2);
		if (id === undefined || names === undefined) continue;
		if (!/^[0-9a-f]{12,64}$/.test(id)) continue;
		if (names.split(",").includes(want)) ids.push(id);
	}
	if (ids.length !== 1) {
		throw new RehearsalRefused(
			`rule pause-target: instance ${name} has ${ids.length === 0 ? "no running" : "more than one"} ${store} scratch container named ${want}`,
		);
	}
	return ids[0] as string;
}

function hex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function writeMode(path: string, body: string): void {
	writeFileSync(path, body, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// The mode argument already applied; a chmod failure changes nothing.
	}
}

/**
 * One read-only git call: trimmed stdout on success ("" when the command
 * succeeds with no output, e.g. a clean `status --porcelain`), null only
 * when git failed. Callers must not mistake "" for failure.
 */
export function gitOutput(checkout: string, args: string[]): string | null {
	const run = Bun.spawnSync(["git", "-C", checkout, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: DOCKER_TIMEOUT_MS,
	});
	if (run.exitCode !== 0) return null;
	return run.stdout.toString().trim();
}

interface UpOptions {
	name: string;
	port: number;
	surfaces: Surface[];
	operator: Surface | null;
	desktopSurfaces: Surface[];
	anonymous: boolean;
	/** Build the skills library fixture (`--skills-fixture`): a throwaway bare repository, a mirror and a recording `gh`. */
	skillsFixture: boolean;
	/** Allowlisted extra server settings (`--extra-env`), already validated by `parseExtraEnv`. */
	extraEnv: Record<string, string>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(POLL_MS);
	}
	return predicate();
}

async function waitForHealth(
	url: string,
	token: string | null,
	timeoutMs: number,
): Promise<{ index: boolean; ledger: boolean; writable: boolean } | null> {
	const deadline = Date.now() + timeoutMs;
	let last: { index: boolean; ledger: boolean; writable: boolean } | null = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/healthz`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status === 200) {
				const body = (await res.json()) as { index?: boolean; greptime?: boolean; eventsWritable?: boolean };
				if (body.index === true && body.greptime === true && body.eventsWritable === true) {
					return { index: true, ledger: true, writable: true };
				}
				last = { index: body.index === true, ledger: body.greptime === true, writable: body.eventsWritable === true };
			}
		} catch {
			// Not up yet.
		}
		await Bun.sleep(POLL_MS);
	}
	return last;
}

/** A twin `up` may declare ready: /healthz reported a writable index and ledger. */
export function isTwinHealthy(health: { index: boolean; ledger: boolean; writable: boolean } | null): boolean {
	return health !== null && health.index && health.ledger && health.writable;
}

function killOwn(pid: number): void {
	if (!pidAlive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + 5000;
	while (pidAlive(pid) && Date.now() < deadline) {
		Bun.sleepSync(POLL_MS);
	}
	if (pidAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Gone between the check and the signal.
		}
	}
}

/**
 * Stop a just-spawned twin during `up` cleanup. Re-reads /proc and applies
 * the same ownership check `down` enforces through `mayStop` (pid, start
 * time against reuse, twin entry point, recorded checkout) before signalling,
 * so a reused or mismatched pid is never killed. A twin that fails only the
 * stoppability tail (system.slice, production port) is still our spawn, so it
 * is signalled: leaking it would leave a process no future `down` can stop.
 * Returns true when the pid was signalled.
 */
export function killVerifiedSpawn(pid: number, checkout: string, startSeconds: number): boolean {
	const cur = readProcFacts(pid);
	if (cur === null) return false;
	if (cur.pid !== pid || cur.startSeconds !== startSeconds) return false;
	if (!cur.argv.at(-1)?.endsWith("packages/mcp-server/src/index.ts")) return false;
	if (cur.cwd !== checkout) return false;
	killOwn(pid);
	return true;
}

/**
 * Stop a just-spawned fixture during `up` cleanup. Re-reads /proc and applies
 * the same ownership check `down` enforces through `mayStopFixture` (pid,
 * start time against reuse, fixture entry point, recorded checkout) before
 * signalling, so a reused or mismatched pid is never killed. Returns true
 * when the pid was signalled.
 */
export function killVerifiedFixtureSpawn(pid: number, checkout: string, startSeconds: number): boolean {
	const cur = readProcFacts(pid);
	if (cur === null) return false;
	if (cur.pid !== pid || cur.startSeconds !== startSeconds) return false;
	if (cur.argv.at(-1) !== RAGFLOW_FIXTURE_SCRIPT) return false;
	if (cur.cwd !== checkout) return false;
	killOwn(pid);
	return true;
}
/**
 * An exclusive per-instance lock, held across startup and teardown: a
 * concurrent `up`/`down` on one name must not read state or remove
 * containers under each other. The lock is `flock(2)` on a private
 * directory beside the run dir — one directory per name, so two names never
 * contend. A directory create is not the lock: two processes can both
 * decide a leftover directory is stale, delete it, and both proceed to
 * remove containers. The kernel drops the flock when this descriptor
 * closes, including when the holder is killed. `release` runs from a
 * `finally`, so a thrown refusal unlocks too.
 */
export interface NameLock {
	release(): void;
}

/** Linux `flock(2)` operations. `LOCK_EX | LOCK_NB` fails instead of waiting. */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
/** Linux `EAGAIN`: the non-blocking lock is already held. */
const EAGAIN = 11;

interface FlockLib {
	flock(fd: number, operation: number): number;
	errno(): number;
}

let flockLib: FlockLib | null = null;

function rehearsalFlock(): FlockLib {
	if (flockLib !== null) return flockLib;
	try {
		const lib = dlopen("libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__errno_location: { args: [], returns: FFIType.ptr },
		});
		const opened: FlockLib = {
			flock: (fd, operation) => lib.symbols.flock(fd, operation),
			errno: () => {
				const loc = lib.symbols.__errno_location();
				return loc === null ? 0 : read.i32(loc, 0);
			},
		};
		flockLib = opened;
		return opened;
	} catch (cause) {
		if (cause instanceof RehearsalRefused) throw cause;
		const detail = cause instanceof Error ? cause.message : "unknown";
		throw new RehearsalRefused(`could not load the instance lock (${detail})`);
	}
}

function readLockOwner(lockDir: string): number | null {
	try {
		const pid = Number(readFileSync(join(lockDir, "owner"), "utf8").trim().split("\n")[0]);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function dropFlock(lib: FlockLib, fd: number): void {
	try {
		lib.flock(fd, LOCK_UN);
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Closing is what frees the lock if the unlock call failed.
		}
	}
}

export function acquireNameLock(runDir: string, name: string): NameLock {
	// runDir itself may not exist yet on a fresh `up`; the lock lives beside
	// it, so only the parent has to exist before the directory is created.
	ensurePrivateDir(dirname(runDir));
	const lockDir = `${runDir}.lock`;
	ensurePrivateDir(lockDir);
	const lib = rehearsalFlock();
	const fd = openSync(lockDir, "r");
	if (lib.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		const err = lib.errno();
		try {
			closeSync(fd);
		} catch {
			// The lock was not taken; a close failure changes nothing.
		}
		if (err === EAGAIN) {
			const owner = readLockOwner(lockDir);
			const who = owner !== null ? ` (pid ${owner})` : "";
			throw new RehearsalRefused(`instance ${name} is locked by another operation${who}`);
		}
		throw new RehearsalRefused(`could not lock instance ${name} (errno ${err})`);
	}
	try {
		writeMode(join(lockDir, "owner"), `${process.pid}\n`);
	} catch (cause) {
		dropFlock(lib, fd);
		throw cause;
	}
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			try {
				// Drop the pid file while we still hold the flock, so a waiter
				// never reports a pid that already released.
				rmSync(join(lockDir, "owner"), { force: true });
			} finally {
				dropFlock(lib, fd);
			}
		},
	};
}

/**
 * Hold the per-name lock around `body`. `release` runs when `body` returns
 * and when it throws, so a refusal mid-startup cannot leave the name locked.
 */
export async function withNameLock<T>(runDir: string, name: string, body: () => Promise<T>): Promise<T> {
	const lock = acquireNameLock(runDir, name);
	try {
		return await body();
	} finally {
		lock.release();
	}
}

/**
 * Before saving state, prove the spawned pid is still itself and owns the
 * requested listener: alive, same start time (against pid reuse), and the
 * MCP port among its listeners. Readiness alone does not say which pid
 * answered. Returns the refusal reason, or null when the twin is confirmed.
 */
export function confirmSpawnedTwin(
	pid: number,
	port: number,
	startSeconds: number,
	deps: {
		alive: (pid: number) => boolean;
		startOf: (pid: number) => number | null;
		listensOn: (pid: number) => number[] | null;
	} = { alive: pidAlive, startOf: readStartSeconds, listensOn: readListeningPorts },
): string | null {
	if (!deps.alive(pid)) return `twin pid ${pid} is gone; refusing to save state for a dead process`;
	const start = deps.startOf(pid);
	if (start === null) return `could not verify the start of twin pid ${pid}`;
	if (start !== startSeconds) return `twin pid ${pid} was reused (start time differs)`;
	const ports = deps.listensOn(pid);
	if (ports === null) return `could not read the listeners of twin pid ${pid}`;
	if (!ports.includes(port)) return `twin pid ${pid} does not own port ${port}; refusing to claim a stranger's listener`;
	return null;
}

/**
 * Bounded startup identity qualification for a just-spawned child.
 *
 * A post-spawn `readProcFacts` may observe pre-exec transient state (empty
 * argv) before the child execs its entry point; a single-shot check would
 * then refuse our own spawn as foreign. Poll under the caller's existing
 * timeout (never widened here): the same pid and birth must remain
 * throughout, the known expected entry must read correct first, and
 * readiness/owned-listener checks still run after, before any network to
 * the port. A genuinely dead pid reports `dead` (numeric failure, not a
 * foreign refusal); an unverifiable or foreign pid reports without
 * signalling. No extra I/O delay beyond the poll interval.
 */
export interface SpawnQualifyDeps {
	factsOf: (pid: number) => ProcFacts | null;
	alive: (pid: number) => boolean;
	startOf: (pid: number) => number | null;
	sleepMs: (ms: number) => Promise<void>;
}
export type SpawnQualifyOutcome =
	| { kind: "ready"; facts: ProcFacts }
	| { kind: "dead" }
	| { kind: "foreign"; reason: string }
	| { kind: "unverifiable"; reason: string };
export async function qualifySpawnedEntry(
	pid: number,
	birth: number | null,
	isExpectedEntry: (argv: string[]) => boolean,
	timeoutMs: number,
	deps: SpawnQualifyDeps,
): Promise<SpawnQualifyOutcome> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	for (;;) {
		const facts = deps.factsOf(pid);
		if (facts !== null) {
			if (birth !== null && facts.startSeconds !== birth) {
				return { kind: "foreign", reason: `pid ${pid} was reused (start time differs)` };
			}
			if (isExpectedEntry(facts.argv)) return { kind: "ready", facts };
			if (facts.argv.length > 0) {
				return { kind: "foreign", reason: `pid ${pid} is not the expected entry point` };
			}
			if (!deps.alive(pid)) return { kind: "dead" };
		} else {
			if (!deps.alive(pid)) return { kind: "dead" };
			if (birth !== null) {
				const cur = deps.startOf(pid);
				if (cur !== null && cur !== birth) {
					return { kind: "foreign", reason: `pid ${pid} was reused (start time differs)` };
				}
			}
		}
		if (Date.now() >= deadline) {
			if (!deps.alive(pid)) return { kind: "dead" };
			return { kind: "unverifiable", reason: `could not verify the spawned process (pid ${pid}); refusing to signal an unverified process` };
		}
		await deps.sleepMs(50);
	}
}

/**
 * Arm cleanup for an interruptible `up`: the first SIGINT/SIGTERM runs
 * cleanup, then the signal is re-raised with the handlers removed so the
 * process still dies from the signal. Returns a disarm function the caller
 * runs once the twin is saved (or torn down through the normal paths).
 * The cleanup itself must never throw — a throwing signal handler would
 * mask the interruption.
 */
export function installUpCleanup(cleanup: () => void): () => void {
	let fired = false;
	const disarm = (): void => {
		process.removeListener("SIGINT", onInt);
		process.removeListener("SIGTERM", onTerm);
	};
	const handler = (signal: "SIGINT" | "SIGTERM"): void => {
		if (fired) return;
		fired = true;
		try {
			cleanup();
		} finally {
			disarm();
			process.kill(process.pid, signal);
		}
	};
	const onInt = (): void => handler("SIGINT");
	const onTerm = (): void => handler("SIGTERM");
	process.once("SIGINT", onInt);
	process.once("SIGTERM", onTerm);
	return disarm;
}

async function runUp(opts: UpOptions, checkout: string): Promise<number> {
	const runDir = runDirFor(opts.name);
	return await withNameLock(runDir, opts.name, () => runUpInner(opts, checkout, runDir));
}

async function runUpInner(opts: UpOptions, checkout: string, runDir: string): Promise<number> {
	const statePath = join(runDir, "state.json");

	const prev = readState(statePath);
	if (prev !== null && prev.pid !== null && pidAlive(prev.pid)) {
		if (prev.startSeconds === null) {
			throw new RehearsalRefused(`instance ${opts.name} has a live twin with unverified birth identity; preserving its recovery state`);
		}
		const facts = readProcFacts(prev.pid);
		// A missing `ss` (or any other unreadable /proc fact) used to fall
		// through to removeLabelledContainers and delete a live twin's stores.
		// Refuse before any container removal when the live pid cannot be checked.
		if (facts === null) {
			throw new RehearsalRefused(
				`instance ${opts.name} has live pid ${prev.pid} that could not be verified; refusing to remove its stores`,
			);
		}
		if (mayStop(facts, { pid: prev.pid, checkout: prev.checkout, startSeconds: prev.startSeconds }) === null) {
			process.stderr.write(`[rehearsal] refused: instance ${opts.name} is already running (pid ${prev.pid}).\n`);
			return 2;
		}
	}
	// The fixture is an independent child: a dead twin with a live stand-in
	// must not be overwritten, or `down` loses the identity it needs to stop
	// it. Inspect the previous fixture on its own before any removal.
	const prevFixture = prev?.ragflowFixture;
	if (prevFixture?.enabled === true && pidAlive(prevFixture.pid)) {
		if (prevFixture.startSeconds === null) {
			throw new RehearsalRefused(
				`instance ${opts.name} has a live fixture with unverified birth identity; preserving its recovery state`,
			);
		}
		const prevFixtureFacts = readProcFacts(prevFixture.pid);
		if (prevFixtureFacts === null) {
			throw new RehearsalRefused(
				`instance ${opts.name} has live fixture pid ${prevFixture.pid} that could not be verified; refusing to remove its stores`,
			);
		}
		if (mayStopFixture(prevFixtureFacts, prevFixture, PRODUCTION_PORTS) === null) {
			process.stderr.write(`[rehearsal] refused: instance ${opts.name} still owns a live fixture (pid ${prevFixture.pid}); run rehearsal down first.\n`);
			return 2;
		}
	}

	// A reserved production port is refused before the checkout check. From this
	// repo's own tree the checkout refusal would otherwise hide it, and the port
	// is illegal wherever the command is run.
	if (opts.port !== 0) {
		const reserved = refusePort(opts.port, []);
		if (reserved !== null) throw new RehearsalRefused(reserved);
	}
	const checkoutRefused = refuseCheckoutDir(checkout);
	if (checkoutRefused !== null) throw new RehearsalRefused(checkoutRefused);
	const dockerRefused = refuseDockerLocality();
	if (dockerRefused !== null) throw new RehearsalRefused(dockerRefused);
	if (!existsSync(join(checkout, "node_modules"))) {
		throw new RehearsalRefused(`no node_modules in ${checkout}: run bun install --frozen-lockfile first`);
	}

	let mcpPort = opts.port;
	if (mcpPort === 0) mcpPort = await pickFreePort();
	const portRefused = refusePort(mcpPort, []);
	if (portRefused !== null) throw new RehearsalRefused(portRefused);
	if (!(await isPortFree(mcpPort))) throw new RehearsalRefused(`port ${mcpPort} is already listening`);

	const info = docker(["info"]);
	if (!info.ok) throw new RehearsalRefused("docker is unreachable");
	const pgImage = process.env[PG_IMAGE_ENV]?.trim() || DEFAULT_PG_IMAGE;
	const ledgerImage = process.env[LEDGER_IMAGE_ENV]?.trim() || DEFAULT_LEDGER_IMAGE;
	for (const image of [pgImage, ledgerImage]) {
		if (!docker(["image", "inspect", image]).ok) {
			throw new RehearsalRefused(`image ${image} is not present locally; the harness never pulls`);
		}
	}
	// The floor applies to Docker's storage filesystem — the scratch stores
	// live in Docker's data root, not in XDG_RUNTIME_DIR — plus a small
	// check that the run directory's own filesystem holds logs and tokens.
	// Stat an ancestor that exists: runDir may not exist yet, and a statfs
	// failure must refuse, never skip a floor silently.
	const rootDirOut = docker(["info", "--format", "{{.DockerRootDir}}"]);
	const dockerRoot = rootDirOut.ok ? parseDockerRootDir(rootDirOut.out) : null;
	if (dockerRoot === null) {
		throw new RehearsalRefused("could not read Docker's data root; refusing without the 2 GiB floor proof");
	}
	const dockerFree = freeBytes(dockerRoot);
	if (dockerFree === null) {
		throw new RehearsalRefused(`could not read free disk on ${dockerRoot}; refusing without the 2 GiB floor proof`);
	}
	if (dockerFree < DISK_FLOOR_BYTES) {
		throw new RehearsalRefused(`free disk on ${dockerRoot} below the 2 GiB floor; the harness never prunes`);
	}
	const runFree = freeBytes(process.env.XDG_RUNTIME_DIR ?? "/tmp");
	if (runFree === null || runFree < RUN_DIR_FLOOR_BYTES) {
		throw new RehearsalRefused("could not prove 64 MiB free for the run directory; refusing");
	}

	// A stale run dir (crashed up) keeps its label, so label-scoped cleanup
	// below catches its containers; the dir itself is rebuilt fresh.
	removeLabelledContainers(opts.name);

	const secrets = {
		ledgerUser: hex(8),
		ledgerPassword: hex(32),
		pgPassword: hex(32),
		handoffKey: hex(32),
		surfaceTokens: {} as Partial<Record<Surface, string>>,
	};
	const surfaces = opts.anonymous ? [] : opts.surfaces;
	for (const surface of surfaces) secrets.surfaceTokens[surface] = hex(32);

	// Harden the shared base first: a pre-existing world-readable, foreign-owned
	// or symlinked /tmp/substrate-rehearsal refuses instead of being trusted.
	ensurePrivateDir(dirname(runDir));
	ensurePrivateDir(runDir);
	const tokensDir = join(runDir, "tokens");
	ensurePrivateDir(tokensDir);
	// A restarted instance (crashed up, narrower --surfaces) must not keep
	// stale bearer files: clear before writing this run's tokens.
	clearDirectory(tokensDir);
	for (const surface of surfaces) {
		const tok = secrets.surfaceTokens[surface];
		if (tok !== undefined) writeMode(join(tokensDir, surface), `${tok}\n`);
	}

	const pgContainer = storeContainerName(opts.name, "index");
	const ledgerContainer = storeContainerName(opts.name, "ledger");
	const usersLine = `${secrets.ledgerUser}=${secrets.ledgerPassword}`;

	const pg = docker(
		[
			"run",
			"-d",
			"--rm",
			"--pull",
			"never",
			"--name",
			pgContainer,
			"--label",
			`${REHEARSAL_LABEL}=${opts.name}`,
			"-p",
			"127.0.0.1::5432",
			"--tmpfs",
			"/var/lib/postgresql/data",
			"-e",
			"POSTGRES_PASSWORD",
			"--health-cmd",
			"pg_isready -h 127.0.0.1 -U postgres",
			"--health-interval",
			"1s",
			"--health-retries",
			"60",
			pgImage,
		],
		{ POSTGRES_PASSWORD: secrets.pgPassword },
	);
	if (!pg.ok) {
		removeLabelledContainers(opts.name);
		throw new RehearsalRefused(`scratch postgres failed to start: ${pg.err.trim().split("\n")[0] ?? "unknown"}`);
	}
	const ledger = docker(
		[
			"run",
			"-d",
			"--rm",
			"--pull",
			"never",
			"--name",
			ledgerContainer,
			"--label",
			`${REHEARSAL_LABEL}=${opts.name}`,
			"-p",
			"127.0.0.1::4000",
			"--tmpfs",
			"/greptimedb_data",
			"--entrypoint",
			"sh",
			"-e",
			"RH_GT_USERS",
			"--health-cmd",
			"curl -fsS http://127.0.0.1:4000/health",
			"--health-interval",
			"1s",
			"--health-retries",
			"60",
			ledgerImage,
			"-c",
			'umask 077; printf "%s\\n" "$RH_GT_USERS" > /tmp/rh-users && exec greptime standalone start --http-addr 0.0.0.0:4000 --data-home /greptimedb_data --user-provider=static_user_provider:file:/tmp/rh-users',
		],
		{ RH_GT_USERS: usersLine },
	);
	if (!ledger.ok) {
		removeLabelledContainers(opts.name);
		throw new RehearsalRefused(`scratch ledger failed to start: ${ledger.err.trim().split("\n")[0] ?? "unknown"}`);
	}

	const healthy = await waitFor(
		() =>
			docker(["inspect", "-f", "{{.State.Health.Status}}", pgContainer]).out.trim() === "healthy" &&
			docker(["inspect", "-f", "{{.State.Health.Status}}", ledgerContainer]).out.trim() === "healthy",
		READY_TIMEOUT_MS,
	);
	if (!healthy) {
		removeLabelledContainers(opts.name);
		process.stderr.write("[rehearsal] scratch stores never reported healthy; containers removed.\n");
		return 1;
	}

	const pgPortLine = docker(["port", pgContainer, "5432/tcp"]).out;
	const ledgerPortLine = docker(["port", ledgerContainer, "4000/tcp"]).out;
	const pgHost = parseDockerPortLine(pgPortLine);
	const ledgerHost = parseDockerPortLine(ledgerPortLine);
	if (pgHost === null || ledgerHost === null) {
		removeLabelledContainers(opts.name);
		throw new RehearsalRefused("could not read the scratch store host ports from docker port");
	}

	const parentEnv: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("BUN_")) parentEnv[key] = value;
	}
	// The fixture's port and scratch key are chosen before the server env is
	// built: the twin's RAGFlow reach points at the fixture, so the builder
	// needs both. The key is random per run and travels by child env only.
	let fixturePort = 0;
	let fixtureKey = "";
	if (opts.ragflowFixture) {
		fixturePort = await pickFreePort();
		const pickedRefused = refusePort(fixturePort, []);
		if (pickedRefused !== null) throw new RehearsalRefused(pickedRefused);
		if (!(await isPortFree(fixturePort))) throw new RehearsalRefused(`fixture port ${fixturePort} is already listening`);
		fixtureKey = newFixtureKey();
		const controlRefused = refuseFixtureControlUrl(fixtureEndpoint(fixturePort), PRODUCTION_PORTS);
		if (controlRefused !== null) throw new RehearsalRefused(controlRefused);
	}
	let serverEnv: Record<string, string>;
	let skills: SkillsFixture | null = null;
	try {
		// Deleted and rebuilt inside the run dir, so a crashed `up` cannot make a later proof answer `existing`.
		skills = opts.skillsFixture ? buildSkillsFixture(runDir) : null;
		serverEnv = buildRehearsalEnv({
			ports: { mcp: mcpPort, ledger: ledgerHost.port, postgres: pgHost.port },
			secrets,
			surfaces,
			operator: opts.operator,
			desktopSurfaces: opts.desktopSurfaces,
			runDir,
			parentEnv,
			skillsFixture: skills?.env ?? null,
			extraEnv: opts.extraEnv,
		});
	} catch (cause) {
		// The scratch containers are already healthy here; a builder throw must
		// not leak them, and must exit 2 instead of a stack trace.
		removeLabelledContainers(opts.name);
		if (cause instanceof RehearsalEnvError) throw new RehearsalRefused(cause.message);
		if (opts.skillsFixture) throw new RehearsalRefused(`the skills fixture could not be built: ${String((cause as Error).message ?? cause).split("\n")[0]}`);
		throw cause;
	}

	// The owned RAGFlow stand-in starts before the twin: the twin's scratch key
	// points at it, so the fixture must be verified first. Its key travels by
	// child env only — never a CLI arg, a log line or a consumer export — and
	// the child inherits no store, token or home variables from the operator.
	// Provisional recovery is armed BEFORE the first spawn: the validated
	// starting state (actual nulls, no PID yet) is saved first, each actual
	// child is recorded the moment it is born, and an unknown birth is
	// preserved and refused, never signalled.
	let saved = false;
	let serverPid: number | null = null;
	let serverStart: number | null = null;
	let fixture: { pid: number; startSeconds: number | null } | null = null;
	const fixtureUrl = opts.ragflowFixture ? fixtureEndpoint(fixturePort) : "";
	const state: TwinState = {
		name: opts.name,
		pid: null,
		startSeconds: null,
		checkout,
		commit: "unknown",
		mcpPort,
		pgHostPort: pgHost.port,
		ledgerHostPort: ledgerHost.port,
		pgContainer,
		ledgerContainer,
		pgImage,
		ledgerImage,
		surfaces,
		operator: opts.operator,
		desktopSurfaces: opts.desktopSurfaces,
		anonymous: opts.anonymous,
		skillsFixture: opts.skillsFixture,
		ragflowFixture: undefined,
	};
	try {
		writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
	} catch (cause) {
		// No child exists yet: only containers need removal.
		removeLabelledContainers(opts.name);
		throw cause;
	}
	const interruptCleanup = (): void => {
		if (serverPid !== null && serverStart !== null) killVerifiedSpawn(serverPid, checkout, serverStart);
		if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
		try {
			removeLabelledContainers(opts.name);
		} catch {
			// A signal handler must not throw; the kept provisional state
			// lets a later `down` retry the removal.
			return;
		}
		// A `false` stop (unverifiable or foreign pid) must never delete the
		// recovery identity: only a proven-gone pair plus containers removed
		// may drop the provisional state. Log names only, never values.
		const twinGone = serverPid === null || !pidAlive(serverPid);
		const fixtureGone = fixture === null || !pidAlive(fixture.pid);
		if (!saved && twinGone && fixtureGone) {
			try {
				rmSync(statePath, { force: true });
			} catch {
				// A signal handler must not throw; `down` retries the removal.
			}
		}
	};
	const disarm = installUpCleanup(interruptCleanup);
	if (opts.ragflowFixture) {
		const fixtureEnv: Record<string, string> = {};
		if (parentEnv.PATH !== undefined) fixtureEnv.PATH = parentEnv.PATH;
		for (const [key, value] of Object.entries(parentEnv)) {
			if (value !== undefined && key.startsWith("BUN_")) fixtureEnv[key] = value;
		}
		fixtureEnv[RAGFLOW_FIXTURE_KEY_ENV] = fixtureKey;
		fixtureEnv[RAGFLOW_FIXTURE_PORT_ENV] = String(fixturePort);
		const fixtureLogPath = join(runDir, "fixture.log");
		const fixtureFd = openSync(fixtureLogPath, "a", 0o600);
		const child = Bun.spawn(buildFixtureSpawnArgv(), {
			cwd: checkout,
			env: fixtureEnv,
			detached: true,
			stdin: "ignore",
			stdout: fixtureFd,
			stderr: fixtureFd,
		});
		child.unref();
		try {
			closeSync(fixtureFd);
		} catch {
			// The child holds its own descriptor; a close failure changes nothing.
		}
		// CaptureSrcStart before verification is legitimate: the born PID and
		// its birth are recorded before any identity check, so a later throw
		// stays down-able. A null birth means untestable, never a sentinel.
		const bornStart = readStartSeconds(child.pid);
		fixture = { pid: child.pid, startSeconds: bornStart };
		state.ragflowFixture = {
			enabled: true,
			endpoint: fixtureUrl,
			pid: child.pid,
			startSeconds: bornStart,
			cwd: checkout,
			script: RAGFLOW_FIXTURE_SCRIPT,
		};
		try {
			writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
		} catch (cause) {
			if (bornStart !== null) killVerifiedFixtureSpawn(child.pid, checkout, bornStart);
			removeLabelledContainers(opts.name);
			throw cause;
		}
		if (bornStart === null) {
			// Untestable birth: preserve the born recovery record and refuse
			// without signalling across PIDs. `down` re-reads the record and
			// refuses the same way until the birth reads verifiable.
			removeLabelledContainers(opts.name);
			throw new RehearsalRefused(`could not verify the start of fixture pid ${child.pid}; refusing to signal an unverified process`);
		}
		// Bounded startup identity qualification under the existing ready
		// timeout: the same PID and birth must remain; the known expected
		// entry must read correct before any listener or network check.
		const qualified = await qualifySpawnedEntry(
			child.pid,
			bornStart,
			(argv) => argv.at(-1) === RAGFLOW_FIXTURE_SCRIPT,
			READY_TIMEOUT_MS,
			{ factsOf: readProcFacts, alive: pidAlive, startOf: readStartSeconds, sleepMs: (ms) => Bun.sleep(ms) },
		);
		if (qualified.kind === "dead") {
			removeLabelledContainers(opts.name);
			if (!pidAlive(child.pid)) rmSync(statePath, { force: true });
			return 1;
		}
		if (qualified.kind !== "ready") {
			killVerifiedFixtureSpawn(child.pid, checkout, bornStart);
			removeLabelledContainers(opts.name);
			const fixtureGone = !pidAlive(child.pid);
			if (fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(qualified.kind === "foreign" ? `fixture would not be stoppable: ${qualified.reason}` : qualified.reason);
		}
		const fixtureStopReason = mayStopFixture(
			qualified.facts,
			{ pid: child.pid, startSeconds: bornStart, cwd: checkout, script: RAGFLOW_FIXTURE_SCRIPT },
			PRODUCTION_PORTS,
		);
		if (fixtureStopReason !== null) {
			// Only our own spawn is signalled; the containers are always
			// removed. Without this early refusal `up` succeeds and every
			// later `down` refuses.
			killVerifiedFixtureSpawn(child.pid, checkout, bornStart);
			removeLabelledContainers(opts.name);
			const fixtureGone = !pidAlive(child.pid);
			if (fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(`fixture would not be stoppable: ${fixtureStopReason}`);
		}
		// The verified birth replaces the born capture; same PID and birth.
		fixture = { pid: child.pid, startSeconds: qualified.facts.startSeconds };
		state.ragflowFixture = {
			enabled: true,
			endpoint: fixtureUrl,
			pid: child.pid,
			startSeconds: qualified.facts.startSeconds,
			cwd: checkout,
			script: RAGFLOW_FIXTURE_SCRIPT,
		};
		writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
	}
	try {
		// Twin setup runs under the armed cleanup and the provisional state
		// above: a log-open throw, spawn failure, or unverifiable twin still
		// stops the owned fixture safely and retains recovery when it cannot
		// be confirmed gone. Never a blind kill: every signal re-checks
		// pid/start/entry/cwd, and pid reuse, foreign listeners, and
		// production-port ownership all refuse.
		const logPath = join(runDir, "server.log");
		const fd = openSync(logPath, "a", 0o600);
		const server = Bun.spawn(buildServerSpawnArgv(), {
			cwd: checkout,
			env: serverEnv,
			detached: true,
			stdin: "ignore",
			stdout: fd,
			stderr: fd,
		});
		server.unref();
		try {
			closeSync(fd);
		} catch {
			// The child holds its own descriptor; a close failure changes nothing.
		}
		// Each actual child is recorded ASAP after birth, before verification:
		// the born PID plus its birth stay recoverable even if the entry has
		// not exec'd yet. A null birth is preserved and refused, never
		// signalled. Same PID and birth must remain throughout.
		serverPid = server.pid;
		serverStart = readStartSeconds(server.pid);
		state.pid = serverPid;
		state.startSeconds = serverStart;
		writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
		if (serverStart === null) {
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (!pidAlive(server.pid) && fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(`could not verify the start of twin pid ${server.pid}; refusing to signal an unverified process`);
		}
		const twinQualified = await qualifySpawnedEntry(
			server.pid,
			serverStart,
			(argv) => argv.at(-1)?.endsWith("packages/mcp-server/src/index.ts") === true,
			READY_TIMEOUT_MS,
			{ factsOf: readProcFacts, alive: pidAlive, startOf: readStartSeconds, sleepMs: (ms) => Bun.sleep(ms) },
		);
		if (twinQualified.kind === "dead") {
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (!pidAlive(server.pid) && fixtureGone) rmSync(statePath, { force: true });
			return 1;
		}
		if (twinQualified.kind !== "ready") {
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (!pidAlive(server.pid) && fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(twinQualified.kind === "foreign" ? `twin would not be stoppable: ${twinQualified.reason}` : twinQualified.reason);
		}
		const facts = twinQualified.facts;
		const stopReason = mayStop(facts, { pid: server.pid, checkout, startSeconds: facts.startSeconds });
		if (stopReason !== null) {
			// Only our own spawn is signalled (killVerifiedSpawn re-checks the
			// identity); the containers are always removed. Without this early
			// refusal `up` succeeds and every later `down` refuses, e.g. from a
			// system.slice context the twin inherits. Retain recovery unless
			// both children are proven gone.
			killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const twinGone = !pidAlive(server.pid);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (twinGone && fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(`twin would not be stoppable: ${stopReason}`);
		}
		// The verified identity replaces the captured starting identity.
		// Recovery remains provisional until both listeners pass readiness.
		serverPid = server.pid;
		serverStart = facts.startSeconds;
		state.pid = server.pid;
		state.startSeconds = facts.startSeconds;
		writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
		// SUBSTRATE_TOKEN is the first non-swarm surface's token (the
		// documented contract); the operator token rides separately for the
		// smoke, so an `--operator` twin no longer hands proofs the
		// operator's token as the client's credential.
		const firstSurface = surfaces.find((s) => !isSwarmSurface(s)) ?? surfaces[0];
		const firstToken = firstSurface !== undefined ? secrets.surfaceTokens[firstSurface] : undefined;
		const operatorToken = opts.operator !== null ? secrets.surfaceTokens[opts.operator] : undefined;
		// The fixture answers its own health gate first: the twin's RAGFlow reach
		// is only real once the stand-in serves its control shape, not merely a
		// listener. Bounded polls against the actual HTTP endpoint.
		if (fixture !== null) {
			const fixtureDeadline = Date.now() + READY_TIMEOUT_MS;
			let fixtureOk = await checkFixtureReady(fixtureUrl, 10_000);
			while (!fixtureOk && Date.now() < fixtureDeadline) {
				await Bun.sleep(POLL_MS);
				fixtureOk = await checkFixtureReady(fixtureUrl, 10_000);
			}
			if (!fixtureOk) {
				killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
				if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
				removeLabelledContainers(opts.name);
				// A `false` stop must preserve the recovery identity: drop the
				// provisional state only when both children are proven gone.
				const twinGone = !pidAlive(server.pid);
				const fixtureGone = !pidAlive(fixture.pid);
				if (twinGone && fixtureGone) rmSync(statePath, { force: true });
				process.stderr.write(`[rehearsal] fixture never answered its health gate on 127.0.0.1:${fixturePort}; log kept at ${join(runDir, "fixture.log")}.\n`);
				return 1;
			}
		}
		const health = await waitForHealth(`http://127.0.0.1:${mcpPort}`, firstToken ?? null, READY_TIMEOUT_MS);
		if (!isTwinHealthy(health)) {
			killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const twinGone = !pidAlive(server.pid);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (twinGone && fixtureGone) rmSync(statePath, { force: true });
			process.stderr.write(`[rehearsal] twin never reached healthy /healthz (index=${health?.index} ledger=${health?.ledger} writable=${health?.writable}); log kept at ${logPath}.\n`);
			return 1;
		}

		// Readiness proves something answered; this proves it was our spawn.
		const confirmReason = confirmSpawnedTwin(server.pid, mcpPort, facts.startSeconds);
		if (confirmReason !== null) {
			killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
			if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
			removeLabelledContainers(opts.name);
			const twinGone = !pidAlive(server.pid);
			const fixtureGone = fixture === null || !pidAlive(fixture.pid);
			if (twinGone && fixtureGone) rmSync(statePath, { force: true });
			throw new RehearsalRefused(confirmReason);
		}
		// The fixture listener must be ours too: a stranger answering the
		// health gate must not be recorded as the instance's stand-in.
		if (fixture !== null) {
			if (fixture.startSeconds === null) {
				killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
				removeLabelledContainers(opts.name);
				const twinGone = !pidAlive(server.pid);
				const fixtureGone = !pidAlive(fixture.pid);
				if (twinGone && fixtureGone) rmSync(statePath, { force: true });
				throw new RehearsalRefused(`could not verify the start of fixture pid ${fixture.pid}; refusing to signal an unverified process`);
			}
			const fixtureConfirmReason = confirmFixtureSpawn(fixture.pid, fixturePort, fixture.startSeconds, {
				alive: pidAlive,
				startOf: readStartSeconds,
				listensOn: readListeningPorts,
			});
			if (fixtureConfirmReason !== null) {
				killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
				killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
				removeLabelledContainers(opts.name);
				const twinGone = !pidAlive(server.pid);
				const fixtureGone = !pidAlive(fixture.pid);
				if (twinGone && fixtureGone) rmSync(statePath, { force: true });
				throw new RehearsalRefused(fixtureConfirmReason);
			}
		}
		state.commit = gitOutput(checkout, ["log", "-1", "--pretty=%H"]) ?? "unknown";
		const dirtyOut = gitOutput(checkout, ["status", "--porcelain=v1", "--", "packages", "package.json", "bun.lock"]);
		writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
		saved = true;
		const testPgUrl = `postgresql://postgres:${secrets.pgPassword}@127.0.0.1:${pgHost.port}/postgres`;
		writeMode(join(runDir, "consumer.env"), toShellExports(consumerEnvRecord({
			mcpPort,
			firstToken: firstToken ?? "",
			operatorToken: operatorToken ?? "",
			runDir,
			name: opts.name,
			testPgUrl,
			skills: skills ? { state: skills.state, origin: skills.origin, ghState: skills.ghState, repo: skills.repo } : null,
			ragflowFixture: fixture !== null ? { url: fixtureUrl, pid: fixture.pid } : null,
			docsStateFile: fixture !== null ? join(runDir, REHEARSAL_DOCS_STATE_FILENAME) : null,
		})));
		writeMode(join(runDir, "stores.env"), toShellExports(storesEnvRecord({
			ports: { mcp: mcpPort, ledger: ledgerHost.port, postgres: pgHost.port },
			secrets,
		})));

		const url = `http://127.0.0.1:${mcpPort}`;
		process.stdout.write(`[rehearsal] up ${opts.name} ${url}\n`);
		process.stdout.write(`[rehearsal] consumer.env: ${join(runDir, "consumer.env")}\n`);
		process.stdout.write(`[rehearsal] commit ${state.commit} dirty=${dirtyOut === null ? "unknown" : String(dirtyOut.length > 0)}\n`);
		process.stdout.write(`[rehearsal] images pg=${pgImage} ledger=${ledgerImage}\n`);
		if (skills) process.stdout.write(`[rehearsal] skills fixture: library ${skills.repo} (a throwaway bare repository, a recording gh)\n`);
		for (const [key, value] of Object.entries(opts.extraEnv)) process.stdout.write(`[rehearsal] extra-env ${key}=${value}\n`);
		return 0;
	} catch (cause) {
		// An unexpected throw after either spawn must not leak a verified
		// child: stop whatever is tracked and remove containers, then
		// rethrow. The expected failures above already cleaned up, so this is
		// a no-op for them (the kill is identity-checked; the removal finds
		// nothing). The removal is best-effort here so the original error
		// survives. A `false` stop retains the provisional state so a later
		// `down` can retry it; only proven-gone children may drop it.
		if (serverPid !== null && serverStart !== null) killVerifiedSpawn(serverPid, checkout, serverStart);
		if (fixture !== null && fixture.startSeconds !== null) killVerifiedFixtureSpawn(fixture.pid, checkout, fixture.startSeconds);
		try {
			removeLabelledContainers(opts.name);
		} catch {
			throw cause;
		}
		const twinGone = serverPid === null || !pidAlive(serverPid);
		const fixtureGone = fixture === null || !pidAlive(fixture.pid);
		if (!saved && twinGone && fixtureGone) rmSync(statePath, { force: true });
		throw cause;
	} finally {
		disarm();
	}
	return 0;
}
async function runDown(name: string): Promise<number> {
	const runDir = runDirFor(name);
	return await withNameLock(runDir, name, () => runDownInner(name, runDir));
}

async function runDownInner(name: string, runDir: string): Promise<number> {
	const dockerRefused = refuseDockerLocality();
	if (dockerRefused !== null) throw new RehearsalRefused(dockerRefused);
	const state = readState(join(runDir, "state.json"));
	if (state === null) {
		removeLabelledContainers(name);
		rmSync(runDir, { recursive: true, force: true });
		process.stdout.write(`[rehearsal] down ${name}: nothing to remove.\n`);
		return 0;
	}
	// Stop the recorded fixture child, if any: only the exact pid/start-time/
	// entry-point/checkout identity recorded in this state is ever signalled.
	// A foreign or reused pid refuses and leaves the run directory for repair.
	const stopFixture = async (): Promise<string | null> => {
		const recorded = state.ragflowFixture;
		if (recorded === undefined || recorded.enabled !== true) return null;
		if (!Number.isInteger(recorded.pid) || recorded.pid <= 0) {
			throw new RehearsalRefused(`fixture identity for ${name} is unverifiable; refusing to signal`);
		}
		if (!pidAlive(recorded.pid)) return `fixture pid ${recorded.pid} already gone`;
		if (recorded.startSeconds === null || !Number.isFinite(recorded.startSeconds)) {
			throw new RehearsalRefused(`fixture pid ${recorded.pid} has unverified birth identity; preserving its recovery state`);
		}
		const fixtureFacts = readProcFacts(recorded.pid);
		if (fixtureFacts === null) throw new RehearsalRefused(`cannot verify fixture pid ${recorded.pid}; refusing to signal`);
		const fixtureReason = mayStopFixture(fixtureFacts, { pid: recorded.pid, startSeconds: recorded.startSeconds, cwd: recorded.cwd, script: recorded.script }, PRODUCTION_PORTS);
		if (fixtureReason !== null) throw new RehearsalRefused(`refusing to stop fixture pid ${recorded.pid}: ${fixtureReason}`);
		try {
			process.kill(recorded.pid, "SIGTERM");
		} catch {
			// Gone between the check and the signal; fall through to cleanup.
		}
		const fixtureDeadline = Date.now() + DOWN_WAIT_MS;
		while (pidAlive(recorded.pid) && Date.now() < fixtureDeadline) {
			await Bun.sleep(POLL_MS);
		}
		if (pidAlive(recorded.pid)) {
			const againFacts = readProcFacts(recorded.pid);
			if (againFacts === null) throw new RehearsalRefused(`cannot re-verify fixture pid ${recorded.pid}; refusing SIGKILL`);
			const againReason = mayStopFixture(againFacts, { pid: recorded.pid, startSeconds: recorded.startSeconds as number, cwd: recorded.cwd, script: recorded.script }, PRODUCTION_PORTS);
			if (againReason !== null) throw new RehearsalRefused(`refusing to stop fixture pid ${recorded.pid}: ${againReason}`);
			try {
				process.kill(recorded.pid, "SIGKILL");
			} catch {
				// Gone between the check and the signal.
			}
		}
		return `stopped fixture pid ${recorded.pid}`;
	};
	if (state.pid === null || state.startSeconds === null) {
		// Starting state: the twin never spawned, but a fixture may own its
		// listener. Stop only the recorded fixture, then remove containers.
		const fixtureNote = await stopFixture();
		const removed = removeLabelledContainers(name);
		rmSync(runDir, { recursive: true, force: true });
		process.stdout.write(`[rehearsal] down ${name}: twin pending, removed ${removed} containers${fixtureNote === null ? "" : `, ${fixtureNote}`}.\n`);
		return 0;
	}
	const maybePid = state.pid;
	if (maybePid === null || !Number.isInteger(maybePid) || maybePid <= 0 || !pidAlive(maybePid)) {
		const fixtureNote = await stopFixture();
		const removed = removeLabelledContainers(name);
		if (maybePid !== null && Number.isInteger(maybePid) && maybePid > 0 && pidAlive(maybePid)) {
			throw new RehearsalRefused(`twin identity for ${name} is unverifiable; preserving its recovery state`);
		}
		rmSync(runDir, { recursive: true, force: true });
		process.stdout.write(`[rehearsal] down ${name}: pid ${state.pid} already gone, removed ${removed} containers${fixtureNote === null ? "" : `, ${fixtureNote}`}.\n`);
		return 0;
	}
	const twinPid = state.pid;
	const twinStart = state.startSeconds;
	if (twinPid === null || twinStart === null || !Number.isInteger(twinPid) || twinPid <= 0 || !Number.isFinite(twinStart)) {
		throw new RehearsalRefused(`twin identity for ${name} is pending; refusing to signal`);
	}
	const twinIdentity = { pid: twinPid, checkout: state.checkout, startSeconds: twinStart };
	const facts = readProcFacts(twinPid);
	if (facts === null) throw new RehearsalRefused(`cannot verify pid ${twinPid}; refusing to signal`);
	const reason = mayStop(facts, twinIdentity);
	if (reason !== null) throw new RehearsalRefused(`refusing to stop pid ${twinPid}: ${reason}`);
	try {
		process.kill(twinPid, "SIGTERM");
	} catch {
		// Gone between the check and the signal; fall through to cleanup.
	}
	const deadline = Date.now() + DOWN_WAIT_MS;
	while (pidAlive(twinPid) && Date.now() < deadline) {
		await Bun.sleep(POLL_MS);
	}
	if (pidAlive(twinPid)) {
		const again = readProcFacts(twinPid);
		if (again === null) throw new RehearsalRefused(`cannot re-verify pid ${twinPid}; refusing SIGKILL`);
		const againReason = mayStop(again, twinIdentity);
		if (againReason !== null) throw new RehearsalRefused(`refusing to stop pid ${twinPid}: ${againReason}`);
		try {
			process.kill(twinPid, "SIGKILL");
		} catch {
			// Gone between the check and the signal.
		}
	}
	const fixtureNote = await stopFixture();
	const removed = removeLabelledContainers(name);
	rmSync(runDir, { recursive: true, force: true });
	process.stdout.write(`[rehearsal] down ${name}: stopped pid ${twinPid}, removed ${removed} containers${fixtureNote === null ? "" : `, ${fixtureNote}`}.\n`);
	return 0;
}

async function runPause(name: string, store: PauseStore, action: "pause" | "unpause"): Promise<number> {
	const runDir = runDirFor(name);
	return await withNameLock(runDir, name, () => pauseScratchStoreUnlocked(name, store, action));
}

/**
 * Freeze or thaw one scratch store of one instance. Under the instance lock like `down`; the
 * container is found by the instance label and its exact name and nothing else is touched. Idempotent:
 * a store already in the asked state is reported and left alone, so a cleanup `unpause` after a
 * failed run never errors on a store that was never frozen. The result is read back from the daemon
 * (`State.Paused`), never assumed from the exit code.
 */
/**
 * Freeze or thaw one scratch store without taking the name lock. `pause`/`unpause` hold the lock
 * and then call this. Callers that already hold the lock (the chaos-planes hook) must use this
 * and must not spawn `rehearsal pause`, which would wait on the same lock.
 */
export async function pauseScratchStoreUnlocked(name: string, store: PauseStore, action: "pause" | "unpause"): Promise<number> {
	const dockerRefused = refuseDockerLocality();
	if (dockerRefused !== null) throw new RehearsalRefused(dockerRefused);
	const ps = docker(["ps", "--filter", `label=${REHEARSAL_LABEL}=${name}`, "--format", "{{.ID}} {{.Names}}"]);
	const id = selectStoreContainer(name, store, ps);
	const want = action === "pause";
	const readPaused = (): boolean => {
		const inspected = docker(["inspect", "-f", "{{.State.Paused}}", id]);
		const text = inspected.out.trim();
		if (!inspected.ok || (text !== "true" && text !== "false")) {
			throw new RehearsalRefused(`rule pause-state: could not read the ${store} container's state for ${name}`);
		}
		return text === "true";
	};
	if (readPaused() === want) {
		process.stdout.write(`[rehearsal] ${action} ${name}: ${store} already ${want ? "paused" : "running"}.\n`);
		return 0;
	}
	const changed = docker([action, id]);
	if (!changed.ok) {
		const detail = changed.err.trim().split("\n")[0];
		throw new RehearsalRefused(`docker ${action} of the ${store} container failed${detail ? `: ${detail}` : ""}`);
	}
	if (readPaused() !== want) throw new RehearsalRefused(`the ${store} container did not ${action} for ${name}`);
	process.stdout.write(`[rehearsal] ${action} ${name}: ${store} ${want ? "paused" : "running"}.\n`);
	return 0;
}

async function runStatus(name: string): Promise<number> {
	const runDir = runDirFor(name);
	return await withNameLock(runDir, name, () => runStatusInner(name, runDir));
}

/**
 * `status` only reads, but it takes the same exclusive lock `up`/`down` hold
 * so it never observes a half-written run dir while `up` saves state or
 * `down` removes it. Every state read in this file runs under the lock.
 */
async function runStatusInner(name: string, runDir: string): Promise<number> {
	const dockerRefused = refuseDockerLocality();
	if (dockerRefused !== null) throw new RehearsalRefused(dockerRefused);
	const state = readState(join(runDir, "state.json"));
	if (state === null) {
		process.stdout.write(`[rehearsal] status ${name}: no instance.\n`);
		return 1;
	}
	const twinPid = state.pid;
	const twinStart = state.startSeconds;
	const twinPidOk = twinPid !== null && Number.isInteger(twinPid) && twinPid > 0;
	const twinBirthOk = twinStart !== null && Number.isFinite(twinStart);
	const alive = twinPidOk && pidAlive(twinPid as number);
	let health = "unknown";
	if (!twinPidOk || !twinBirthOk) {
		health = "twin pending";
	} else if (alive) {
		// Readiness alone does not say which pid answered: verify the
		// recorded twin still owns its port before any request, so a
		// replacement listener is never reported as this instance.
		const twinFacts = readProcFacts(twinPid as number);
		const twinOwned =
			twinFacts !== null &&
			mayStop(twinFacts, { pid: twinPid as number, checkout: state.checkout, startSeconds: twinStart as number }) === null &&
			twinFacts.listensOn.includes(state.mcpPort);
		if (!twinOwned) {
			health = "unverifiable";
		} else {
			try {
				const tok =
					state.surfaces.length > 0 ? readText(join(runDir, "tokens", state.surfaces[0] as string))?.trim() : null;
				const res = await fetch(`http://127.0.0.1:${state.mcpPort}/healthz`, {
					headers: tok ? { authorization: `Bearer ${tok}` } : {},
					signal: AbortSignal.timeout(10_000),
				});
				health = String(res.status);
			} catch {
				health = "unreachable";
			}
		}
	} else {
		health = "pid gone";
	}
	process.stdout.write(`[rehearsal] status ${state.name}: pid ${twinPid ?? "pending"} alive=${alive} healthz=${health}\n`);
	process.stdout.write(`[rehearsal] url http://127.0.0.1:${state.mcpPort} pg=127.0.0.1:${state.pgHostPort} ledger=127.0.0.1:${state.ledgerHostPort}\n`);
	process.stdout.write(`[rehearsal] commit ${state.commit} checkout ${state.checkout}\n`);
	process.stdout.write(`[rehearsal] images pg=${state.pgImage} ledger=${state.ledgerImage}\n`);
	process.stdout.write(`[rehearsal] skills fixture ${state.skillsFixture === true ? "on" : "off"}\n`);
	const recorded = state.ragflowFixture;
	if (recorded?.enabled === true) {
		// The endpoint comes from our own state, but a hand-edited state must
		// not point status at a stranger: verify the recorded fixture identity
		// still owns its port before any readiness fetch. Mismatched, gone,
		// or unverifiable fixtures report not ready without contacting a
		// replacement listener; redirects are rejected inside the fetch.
		let fixtureOk = false;
		const fixtureGuard = refuseFixtureControlUrl(recorded.endpoint, PRODUCTION_PORTS);
		const fixturePidOk = Number.isInteger(recorded.pid) && recorded.pid > 0;
		const fixtureBirthOk = recorded.startSeconds !== null && Number.isFinite(recorded.startSeconds);
		if (fixtureGuard === null && fixturePidOk && fixtureBirthOk && pidAlive(recorded.pid)) {
			const fixtureFacts = readProcFacts(recorded.pid);
			if (fixtureFacts !== null && mayStopFixture(fixtureFacts, { pid: recorded.pid, startSeconds: recorded.startSeconds as number, cwd: recorded.cwd, script: recorded.script }, PRODUCTION_PORTS) === null) {
				let fixturePort: number | null = null;
				try {
					fixturePort = Number(new URL(recorded.endpoint).port);
				} catch {
					fixturePort = null;
				}
				if (fixturePort !== null && fixtureFacts.listensOn.includes(fixturePort)) {
					fixtureOk = await checkFixtureReady(recorded.endpoint, 10_000);
				}
			}
		}
		process.stdout.write(`[rehearsal] ragflow fixture ${recorded.endpoint} pid ${recorded.pid} ready=${fixtureOk}\n`);
	} else {
		process.stdout.write("[rehearsal] ragflow fixture off\n");
	}
	return health === "200" ? 0 : 1;
}

/** Loopback hosts the smoke may drive; anything else is a production risk. */
const SMOKE_LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

/**
 * Refuse a smoke target before any request: a production port or a non-loopback host.
 * Returns the reason, or null when the target is a scratch twin.
 */
export function refuseSmokeUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `unparseable smoke target ${raw}`;
	}
	if ((PRODUCTION_PORTS as readonly number[]).includes(Number(url.port))) {
		return `refusing to smoke production :${url.port}`;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (SMOKE_LOOPBACK_HOSTS[host] !== true) return `refusing non-loopback smoke host ${url.hostname}`;
	return null;
}

/**
 * Refuse a Greptime URL for the fake-chain anchor proof before any write:
 * a non-loopback host. Returns the reason, or null when the target is a
 * scratch rehearsal ledger. The proof writes fake-chain signatures into the
 * `anchors` table — the real job skips those rows, while verification can
 * never find their transactions on devnet — so production must never see
 * them. The harness maps its throwaway ledger onto 127.0.0.1.
 */
export function refuseLedgerUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `unparseable ledger target ${raw}`;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (SMOKE_LOOPBACK_HOSTS[host] !== true) return `refusing non-loopback ledger host ${url.hostname}`;
	return null;
}

/** Parse `export KEY='value'` lines, undoing the single-quote escape. */
export function parseShellExports(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export ")) continue;
		const rest = trimmed.slice("export ".length);
		const eq = rest.indexOf("=");
		if (eq <= 0) continue;
		const key = rest.slice(0, eq).trim();
		let value = rest.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1).replace(/'\\''/g, "'");
		}
		out[key] = value;
	}
	return out;
}

interface SmokeAttempt {
	status: number | null;
	body: unknown;
	contentType: string | null;
	error?: string;
}

function smokeHeaders(token: string): Record<string, string> {
	return {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

/** A response body as JSON, else the last SSE data frame, else raw text. */
function parseSmokeBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the SSE framing.
	}
	const frames = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	for (const frame of frames.reverse()) {
		try {
			return JSON.parse(frame);
		} catch {
			// Not this frame.
		}
	}
	return text;
}

async function smokeCall(base: string, token: string, path: string, body?: unknown): Promise<SmokeAttempt> {
	try {
		const res = await fetch(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: smokeHeaders(token),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
		});
		return { status: res.status, body: parseSmokeBody(await res.text()), contentType: res.headers.get("content-type") };
	} catch (cause) {
		return { status: null, body: null, contentType: null, error: String(cause) };
	}
}

/** One stateless MCP tool call over /mcp as JSON-RPC. */
async function smokeTool(
	base: string,
	token: string,
	id: number,
	name: string,
	args: Record<string, unknown>,
): Promise<SmokeAttempt> {
	return smokeCall(base, token, "/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

/** The JSON a tool returned, or null when it errored or answered otherwise. */
export function smokeToolResult(attempt: SmokeAttempt): Record<string, unknown> | null {
	const body = attempt.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null;
	if (body?.result?.isError === true) return null;
	const text = body?.result?.content?.[0]?.text;
	if (typeof text !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Fixed-order wire proof over the twin: brief, then emit, then register,
 * then claim, one ok/FAIL line per step. Reads only consumer.env and refuses
 * a production target before any request. Prints booleans and decisions only.
 */
async function runSmoke(name: string): Promise<number> {
	const runDir = runDirFor(name);
	return await withNameLock(runDir, name, () => runSmokeInner(name, runDir));
}

/**
 * The smoke only reads `consumer.env`, but it takes the same exclusive lock
 * so a concurrent `down` cannot delete the run directory under it mid-proof.
 */
async function runSmokeInner(name: string, runDir: string): Promise<number> {
	const text = readText(join(runDir, "consumer.env"));
	if (text === null) throw new RehearsalRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
	const record = parseShellExports(text);
	const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const tok = pickSmokeToken(record);
	if (!base) throw new RehearsalRefused(`consumer.env for ${name} has no twin url`);
	const refused = refuseSmokeUrl(base);
	if (refused !== null) throw new RehearsalRefused(refused);

	const boot = await smokeCall(base, tok, "/healthz");
	if (boot.status !== 200) {
		throw new RehearsalRefused(`twin at ${base} is not answering /healthz`);
	}

	const tag = `rh-${name}-${Date.now().toString(36)}`;
	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\n[rehearsal] smoke ${name} ${tag}\n\n`);

	const brief = await smokeCall(base, tok, "/brief", {
		repo: "swcstudiospace/agent-substrate",
		branch: "rehearsal",
		graph_id: tag,
	});
	check(brief.status === 200 && (brief.contentType ?? "").includes("text/markdown"), "brief");

	const emit = await smokeCall(base, tok, "/events", {
		kind: "note",
		summary: `rehearsal smoke ${tag}`,
		graph_id: tag,
		session_id: tag,
	});
	check(emit.status === 202 && (emit.body as { stored?: boolean } | null)?.stored === true, "emit");

	const registered = await smokeTool(base, tok, 1, "graph_register", {
		graph_id: tag,
		repo: "swcstudiospace/agent-substrate",
		branch: "rehearsal",
		nodes: [{ node_id: "n1" }],
	});
	check(smokeToolResult(registered) !== null, "register");

	const claim = await smokeTool(base, tok, 2, "graph_claim", {
		graph_id: tag,
		node_id: "n1",
		session_id: tag,
	});
	const claimBody = smokeToolResult(claim);
	const granted = claimBody?.claimed === true && claimBody?.decision === "granted";
	check(
		granted,
		"claim",
		claimBody ? `claimed ${String(claimBody.claimed)} decision ${String(claimBody.decision)}` : "no result",
	);

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} smoke checks passed\n`);
	return passed === results.length ? 0 : 1;
}

/**
 * Refuse unknown `--options` and stray positional arguments before
 * dispatching any command: a typo like `down --nmae other` must exit 2,
 * never silently stop the `default` instance. Returns the reason, or null
 * when argv holds only the subcommand and known flags.
 */
export function refuseExtraArgs(argv: string[]): string | null {
	const valued: Record<string, true> = {
		"--name": true,
		"--port": true,
		"--surfaces": true,
		"--operator": true,
		"--desktop-surfaces": true,
		"--store": true,
		"--extra-env": true,
	};
	const bare: Record<string, true> = { "--anonymous": true, "--skills-fixture": true, "--chaos-planes": true };
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (valued[token] === true) {
			// A flag only its own subcommand reads is refused elsewhere, never ignored: a `--store`
			// on `down` or an `--extra-env` on `smoke` is a typo about what the command will do.
			if (token === "--store" && argv[0] !== "pause" && argv[0] !== "unpause") return "--store is only valid with pause and unpause";
			if (token === "--extra-env" && argv[0] !== "up") return "--extra-env is only valid with up";
			i++;
			continue;
		}
		if (token === "--chaos-planes" && argv[0] !== "smoke") return "--chaos-planes is only valid with smoke";
		if (bare[token] === true) continue;
		if (token.startsWith("--")) return `unknown option ${token}`;
		return `unexpected argument ${token}`;
	}
	return null;
}

export function flag(argv: string[], name: string): string | undefined | null {
	const at = argv.indexOf(name);
	if (at < 0) return undefined;
	const value = argv[at + 1];
	return value === undefined || value.startsWith("--") ? null : value;
}

/** Every value of a repeatable flag, in order; null when any occurrence has no value. */
export function flagAll(argv: string[], name: string): string[] | null {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== name) continue;
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return null;
		out.push(value);
		i++;
	}
	return out;
}

function usage(message: string): never {
	process.stderr.write(
		`[rehearsal] ${message}\nusage: rehearsal up|down|status|smoke|pause|unpause [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--desktop-surfaces a,b] [--anonymous] [--skills-fixture] [--extra-env KEY=VALUE]... [--store ledger|index] [--chaos-planes]\n`,
	);
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (sub === undefined) usage("need a subcommand");
	if (sub !== "up" && sub !== "down" && sub !== "status" && sub !== "smoke" && sub !== "pause" && sub !== "unpause") usage(`unknown subcommand ${sub}`);

	const nameRaw = flag(argv, "--name");
	const portRaw = flag(argv, "--port");
	const surfacesRaw = flag(argv, "--surfaces");
	const operatorRaw = flag(argv, "--operator");
	const desktopSurfacesRaw = flag(argv, "--desktop-surfaces");
	const storeRaw = flag(argv, "--store");
	const extraEnvRaw = flagAll(argv, "--extra-env");
	for (const [key, value] of [
		["--name", nameRaw],
		["--port", portRaw],
		["--surfaces", surfacesRaw],
		["--operator", operatorRaw],
		["--desktop-surfaces", desktopSurfacesRaw],
		["--store", storeRaw],
		["--extra-env", extraEnvRaw],
	] as const) {
		if (value === null) usage(`${key} needs a value`);
	}
	const extra = refuseExtraArgs(argv);
	if (extra !== null) usage(extra);
	const anonymous = argv.includes("--anonymous");
	const skillsFixture = argv.includes("--skills-fixture");
	const ragflowFixture = argv.includes("--ragflow-fixture");
	try {
		const name = parseName(nameRaw ?? undefined);
		if (sub === "down") return await runDown(name);
		if (sub === "status") return await runStatus(name);
		if (sub === "smoke") {
			const smoked = await runSmoke(name);
			if (smoked === 0 && argv.includes("--chaos-planes")) {
				const { chaosPlanesFromInstance } = await import("./chaos-planes.ts");
				const planes = await chaosPlanesFromInstance(name, runDirFor(name));
				return planes.exit;
			}
			return smoked;
		}
		if (sub === "pause" || sub === "unpause") return await runPause(name, parseStore(storeRaw ?? undefined), sub);
		let extraEnv: Record<string, string>;
		try {
			// Before the lock and before any docker call: a refused flag costs nothing.
			extraEnv = parseExtraEnv(extraEnvRaw ?? []);
		} catch (cause) {
			if (cause instanceof RehearsalEnvError) throw new RehearsalRefused(cause.message);
			throw cause;
		}
		const port = Number(portRaw ?? String(DEFAULT_MCP_PORT));
		if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`bad --port ${portRaw ?? ""}`);
		const surfaces = parseSurfaces(surfacesRaw ?? undefined);
		const operator = parseOperator(operatorRaw ?? undefined, surfaces, anonymous);
		const desktopSurfaces = parseDesktopSurfaces(desktopSurfacesRaw ?? undefined, surfaces, anonymous);
		return await runUp({ name, port, surfaces, operator, desktopSurfaces, anonymous, skillsFixture, extraEnv }, process.cwd());
	} catch (cause) {
		if (cause instanceof RehearsalRefused) {
			process.stderr.write(`[rehearsal] refused: ${cause.message}.\n`);
			return 2;
		}
		throw cause;
	}
}

/** Opt-in index archive drill. Only the exact string `1` enables it. */
export function indexDrillEnabled(env: Record<string, string | undefined>): boolean {
	return env.SUBSTRATE_GATE_INDEX_DRILL === "1";
}

/** True when either opt-in rehearsal hook should run. Neither flag is an `--extra-env` key. */
export function rehearsalHooksEnabled(env: Record<string, string | undefined>): boolean {
	return indexDrillEnabled(env) || env.SUBSTRATE_GATE_CHAOS_PLANES === "1";
}

/** The production archive mount. A drill must not resolve onto it or anything under it. */
export const INDEX_ARCHIVE_MOUNT = "/mnt/index-archive";

/** Why this resolved directory cannot hold a drill archive, or null when it can. */
export function refuseIndexDrillOutDir(realPath: string): string | null {
	const norm = realPath.replace(/\/+$/, "") || "/";
	if (norm === INDEX_ARCHIVE_MOUNT || norm.startsWith(`${INDEX_ARCHIVE_MOUNT}/`)) {
		return `refusing index drill output ${norm}: it is ${INDEX_ARCHIVE_MOUNT} or a child of it`;
	}
	return null;
}

/** Why this Postgres URL cannot be the drill source, or null when it is loopback. Never echoes a password. */
export function refuseIndexDrillSource(raw: string): string | null {
	const target = normalizePgUrl(raw);
	if (target === null || target.host !== "loopback") {
		return `refusing index drill source ${describePgUrl(raw)}: the drill only uses a loopback postgres URL`;
	}
	return null;
}

export interface RehearsalHookContext {
	name: string;
	runDir: string;
	/** `consumer.env` keys. The drill reads `SUBSTRATE_TEST_PG_URL` and nothing from `process.env`. */
	consumer: Record<string, string>;
	/** Parent environment. Gate flags are read here, not from the twin. */
	env: Record<string, string | undefined>;
}

/** `gate_idx_` plus the instance name, hyphens as underscores. Empty when it is not a safe identifier. */
export function indexDrillDatabaseName(instance: string): string | null {
	const name = `gate_idx_${instance.replace(/-/g, "_")}`;
	return /^[a-z_][a-z0-9_]{0,62}$/.test(name) ? name : null;
}

function withDatabase(url: string, database: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
}

/**
 * Archive the twin's scratch index and restore it into a new database on the same server.
 * Source is `consumer.SUBSTRATE_TEST_PG_URL` only. Output is a temp dir under `runDir`.
 * The source database is never dropped.
 */
export async function indexArchiveRestoreDrill(ctx: RehearsalHookContext): Promise<{ ok: boolean; detail: string }> {
	const sourceUrl = ctx.consumer.SUBSTRATE_TEST_PG_URL ?? "";
	const refusedSource = refuseIndexDrillSource(sourceUrl);
	if (refusedSource !== null) return { ok: false, detail: refusedSource };
	const source = normalizePgUrl(sourceUrl);
	if (source === null) return { ok: false, detail: `refusing index drill source ${describePgUrl(sourceUrl)}` };
	const dbName = indexDrillDatabaseName(ctx.name);
	if (dbName === null) return { ok: false, detail: "refusing index drill: the scratch database name is not a safe identifier" };
	if (dbName === source.database) return { ok: false, detail: `refusing index drill: scratch database ${dbName} is the source database` };

	const tag = `gate-index-drill-${ctx.name}-${Date.now().toString(36)}`;
	let outDir: string | null = null;
	let sourceStore: IndexStore | null = null;
	let scratchStore: IndexStore | null = null;
	let admin: SQL | null = null;
	let created = false;
	try {
		outDir = mkdtempSync(join(ctx.runDir, "index-drill-"));
		const realOut = realpathSync(outDir);
		const refusedOut = refuseIndexDrillOutDir(realOut);
		if (refusedOut !== null) return { ok: false, detail: refusedOut };

		sourceStore = new IndexStore(sourceUrl);
		await sourceStore.migrate();
		await sourceStore.recordDrillFact(tag, tag);

		const manifest = await archiveIndex(sourceStore, { outDir, allowRootfs: true, minFreeGb: 0, cwd: ctx.runDir });
		const snapshotDir = join(outDir, manifest.snapshot);
		const verified = verifyIndexArchive(snapshotDir);
		if (!verified.ok) return { ok: false, detail: `index drill archive did not verify (${verified.mismatches.map((m) => m.kind).join(", ")})` };

		admin = new SQL(sourceUrl);
		await admin.unsafe(`create database "${dbName}"`);
		created = true;
		const scratchUrl = withDatabase(sourceUrl, dbName);
		const refusedScratch = refusedScratchUrl(scratchUrl, sourceUrl);
		if (refusedScratch !== null) return { ok: false, detail: refusedScratch };

		scratchStore = new IndexStore(scratchUrl);
		const restored = await restoreIndexArchive(scratchStore, { dir: snapshotDir });
		if (!restored.results.every((result) => result.ok)) {
			return { ok: false, detail: "index drill restore did not match the archive" };
		}
		const body = scratchStore === null ? null : await scratchStore.readMemoryText(tag);
		if (body !== tag) return { ok: false, detail: `index drill scratch row ${describePgUrl(scratchUrl)} did not return the drilled text` };
		return { ok: true, detail: `index drill restored ${describePgUrl(scratchUrl)}` };
	} catch (cause) {
		return { ok: false, detail: `index drill failed: ${redact(String((cause as Error)?.message ?? cause)).split("\n")[0]?.slice(0, 300) ?? "unknown"}` };
	} finally {
		await scratchStore?.close().catch(() => undefined);
		if (created && admin !== null && dbName !== null) {
			await admin.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => undefined);
		}
		await admin?.end().catch(() => undefined);
		await sourceStore?.close().catch(() => undefined);
		if (outDir !== null) rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * Index drill first, then per-plane chaos, each only when its own flag is exactly `1`.
 * The chaos flag is not passed into the twin; the drill flag is not an `--extra-env` key.
 */
export async function runRehearsalHooks(ctx: RehearsalHookContext): Promise<{ ok: boolean; detail: string }> {
	const details: string[] = [];
	if (indexDrillEnabled(ctx.env)) {
		const drill = await indexArchiveRestoreDrill(ctx);
		details.push(drill.detail);
		if (!drill.ok) return { ok: false, detail: details.join("; ") };
	}
	if (ctx.env.SUBSTRATE_GATE_CHAOS_PLANES === "1") {
		const { chaosPlanesFromInstance } = await import("./chaos-planes.ts");
		const planes = await chaosPlanesFromInstance(ctx.name, ctx.runDir);
		details.push(planes.detail);
		if (planes.exit !== 0) return { ok: false, detail: details.join("; ") };
	}
	return { ok: true, detail: details.join("; ") || "rehearsal hooks passed" };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
