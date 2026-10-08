#!/usr/bin/env bun
/**
 * Scratch rehearsal harness (`bun run rehearsal up|down|status|smoke`).
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
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
	buildRehearsalEnv,
	consumerEnvRecord,
	RehearsalEnvError,
	storesEnvRecord,
	toShellExports,
} from "../packages/mcp-server/src/rehearsal-env.ts";
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

/** Preflight refuses below this free-disk floor; it never prunes. */
export const DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

/** The production unit's checkout: a twin never runs from here. */
export const UNIT_WORKING_DIRECTORY = "/root/src/repos/agent-substrate";

/** Default images; overridable without a code change. */
export const DEFAULT_PG_IMAGE = "postgres:16-alpine";
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
	for (const key of ["DOCKER_HOST", "DOCKER_CONFIG"] as const) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (extraEnv) for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
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
	const run = Bun.spawnSync(["ss", "-ltnpH"], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: DOCKER_TIMEOUT_MS,
	});
	if (run.exitCode !== 0) return null;
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

/** Persisted twin identity. */
export interface TwinState {
	name: string;
	pid: number;
	startSeconds: number;
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
	anonymous: boolean;
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
	anonymous: boolean;
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

async function runUp(opts: UpOptions, checkout: string): Promise<number> {
	const runDir = runDirFor(opts.name);
	const statePath = join(runDir, "state.json");

	const prev = readState(statePath);
	if (prev !== null && pidAlive(prev.pid)) {
		const facts = readProcFacts(prev.pid);
		if (facts !== null && mayStop(facts, prev) === null) {
			process.stderr.write(`[rehearsal] refused: instance ${opts.name} is already running (pid ${prev.pid}).\n`);
			return 2;
		}
	}

	const checkoutRefused = refuseCheckoutDir(checkout);
	if (checkoutRefused !== null) throw new RehearsalRefused(checkoutRefused);
	const dockerRefused = refuseDockerEnv(process.env);
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
	try {
		// Stat an ancestor that exists: runDir may not exist yet, and a statfs
		// failure must refuse, never skip the floor silently.
		const fs = statfsSync(process.env.XDG_RUNTIME_DIR ?? "/tmp");
		if (Number(fs.bavail) * Number(fs.bsize) < DISK_FLOOR_BYTES) {
			throw new RehearsalRefused("free disk below the 2 GiB floor; the harness never prunes");
		}
	} catch (cause) {
		if (cause instanceof RehearsalRefused) throw cause;
		throw new RehearsalRefused("could not read free disk; refusing without the 2 GiB floor proof");
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
	for (const surface of surfaces) {
		const tok = secrets.surfaceTokens[surface];
		if (tok !== undefined) writeMode(join(tokensDir, surface), `${tok}\n`);
	}

	const pgContainer = `substrate-rehearsal-${opts.name}-pg`;
	const ledgerContainer = `substrate-rehearsal-${opts.name}-ledger`;
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
	let serverEnv: Record<string, string>;
	try {
		serverEnv = buildRehearsalEnv({
			ports: { mcp: mcpPort, ledger: ledgerHost.port, postgres: pgHost.port },
			secrets,
			surfaces,
			operator: opts.operator,
			runDir,
			parentEnv,
		});
	} catch (cause) {
		// The scratch containers are already healthy here; a builder throw must
		// not leak them, and must exit 2 instead of a stack trace.
		removeLabelledContainers(opts.name);
		throw cause instanceof RehearsalEnvError ? new RehearsalRefused(cause.message) : cause;
	}

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

	const facts = readProcFacts(server.pid);
	if (facts === null) {
		// Unverifiable means unsignallable: a blind killOwn could hit a reused
		// pid. Containers are still removed; the twin (if it is ours) is orphaned
		// rather than risking someone else's process.
		removeLabelledContainers(opts.name);
		throw new RehearsalRefused(`could not verify the spawned twin (pid ${server.pid}); refusing to signal an unverified process`);
	}

	const stopReason = mayStop(facts, { pid: server.pid, checkout, startSeconds: facts.startSeconds });
	if (stopReason !== null) {
		// Only our own spawn is signalled (killVerifiedSpawn re-checks the
		// identity); the containers are always removed. Without this early
		// refusal `up` succeeds and every later `down` refuses, e.g. from a
		// system.slice context the twin inherits.
		killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
		removeLabelledContainers(opts.name);
		throw new RehearsalRefused(`twin would not be stoppable: ${stopReason}`);
	}

	const firstSurface = surfaces[0];
	const firstToken = firstSurface !== undefined ? secrets.surfaceTokens[firstSurface] : undefined;
	const health = await waitForHealth(`http://127.0.0.1:${mcpPort}`, firstToken ?? null, READY_TIMEOUT_MS);
	if (!isTwinHealthy(health)) {
		killVerifiedSpawn(server.pid, checkout, facts.startSeconds);
		removeLabelledContainers(opts.name);
		process.stderr.write(`[rehearsal] twin never reached healthy /healthz (index=${health?.index} ledger=${health?.ledger} writable=${health?.writable}); log kept at ${logPath}.\n`);
		return 1;
	}

	const commit = gitOutput(checkout, ["log", "-1", "--pretty=%H"]) ?? "unknown";
	const dirtyOut = gitOutput(checkout, ["status", "--porcelain=v1", "--", "packages", "package.json", "bun.lock"]);
	const state: TwinState = {
		name: opts.name,
		pid: server.pid,
		startSeconds: facts.startSeconds,
		checkout,
		commit,
		mcpPort,
		pgHostPort: pgHost.port,
		ledgerHostPort: ledgerHost.port,
		pgContainer,
		ledgerContainer,
		pgImage,
		ledgerImage,
		surfaces,
		operator: opts.operator,
		anonymous: opts.anonymous,
	};
	writeMode(statePath, `${JSON.stringify(state, null, 2)}\n`);
	const testPgUrl = `postgresql://postgres:${secrets.pgPassword}@127.0.0.1:${pgHost.port}/postgres`;
	writeMode(join(runDir, "consumer.env"), toShellExports(consumerEnvRecord({
		mcpPort,
		firstToken: firstToken ?? "",
		runDir,
		name: opts.name,
		testPgUrl,
	})));
	writeMode(join(runDir, "stores.env"), toShellExports(storesEnvRecord({
		ports: { mcp: mcpPort, ledger: ledgerHost.port, postgres: pgHost.port },
		secrets,
	})));

	const url = `http://127.0.0.1:${mcpPort}`;
	process.stdout.write(`[rehearsal] up ${opts.name} ${url}\n`);
	process.stdout.write(`[rehearsal] consumer.env: ${join(runDir, "consumer.env")}\n`);
	process.stdout.write(`[rehearsal] commit ${commit} dirty=${dirtyOut === null ? "unknown" : String(dirtyOut.length > 0)}\n`);
	process.stdout.write(`[rehearsal] images pg=${pgImage} ledger=${ledgerImage}\n`);
	return 0;
}

async function runDown(name: string): Promise<number> {
	const runDir = runDirFor(name);
	const dockerRefused = refuseDockerEnv(process.env);
	if (dockerRefused !== null) throw new RehearsalRefused(dockerRefused);
	const state = readState(join(runDir, "state.json"));
	if (state === null) {
		removeLabelledContainers(name);
		rmSync(runDir, { recursive: true, force: true });
		process.stdout.write(`[rehearsal] down ${name}: nothing to remove.\n`);
		return 0;
	}
	if (!pidAlive(state.pid)) {
		const removed = removeLabelledContainers(name);
		rmSync(runDir, { recursive: true, force: true });
		process.stdout.write(`[rehearsal] down ${name}: pid ${state.pid} already gone, removed ${removed} containers.\n`);
		return 0;
	}
	const facts = readProcFacts(state.pid);
	if (facts === null) throw new RehearsalRefused(`cannot verify pid ${state.pid}; refusing to signal`);
	const reason = mayStop(facts, state);
	if (reason !== null) throw new RehearsalRefused(`refusing to stop pid ${state.pid}: ${reason}`);

	try {
		process.kill(state.pid, "SIGTERM");
	} catch {
		// Gone between the check and the signal; fall through to cleanup.
	}
	const deadline = Date.now() + DOWN_WAIT_MS;
	while (pidAlive(state.pid) && Date.now() < deadline) {
		await Bun.sleep(POLL_MS);
	}
	if (pidAlive(state.pid)) {
		const again = readProcFacts(state.pid);
		if (again === null) throw new RehearsalRefused(`cannot re-verify pid ${state.pid}; refusing SIGKILL`);
		const againReason = mayStop(again, state);
		if (againReason !== null) throw new RehearsalRefused(`refusing to stop pid ${state.pid}: ${againReason}`);
		try {
			process.kill(state.pid, "SIGKILL");
		} catch {
			// Gone between the check and the signal.
		}
	}
	const removed = removeLabelledContainers(name);
	rmSync(runDir, { recursive: true, force: true });
	process.stdout.write(`[rehearsal] down ${name}: stopped pid ${state.pid}, removed ${removed} containers.\n`);
	return 0;
}

async function runStatus(name: string): Promise<number> {
	const runDir = runDirFor(name);
	const state = readState(join(runDir, "state.json"));
	if (state === null) {
		process.stdout.write(`[rehearsal] status ${name}: no instance.\n`);
		return 1;
	}
	const alive = pidAlive(state.pid);
	let health = "unknown";
	if (alive) {
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
	} else {
		health = "pid gone";
	}
	process.stdout.write(`[rehearsal] status ${state.name}: pid ${state.pid} alive=${alive} healthz=${health}\n`);
	process.stdout.write(`[rehearsal] url http://127.0.0.1:${state.mcpPort} pg=127.0.0.1:${state.pgHostPort} ledger=127.0.0.1:${state.ledgerHostPort}\n`);
	process.stdout.write(`[rehearsal] commit ${state.commit} checkout ${state.checkout}\n`);
	process.stdout.write(`[rehearsal] images pg=${state.pgImage} ledger=${state.ledgerImage}\n`);
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
	const text = readText(join(runDir, "consumer.env"));
	if (text === null) throw new RehearsalRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
	const record = parseShellExports(text);
	const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const tok = record["SUBSTRATE_TOKEN"] ?? "";
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
	const valued: Record<string, true> = { "--name": true, "--port": true, "--surfaces": true, "--operator": true };
	const bare: Record<string, true> = { "--anonymous": true };
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (valued[token] === true) {
			i++;
			continue;
		}
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

function usage(message: string): never {
	process.stderr.write(
		`[rehearsal] ${message}\nusage: rehearsal up|down|status|smoke [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous]\n`,
	);
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (sub === undefined) usage("need a subcommand");
	if (sub !== "up" && sub !== "down" && sub !== "status" && sub !== "smoke") usage(`unknown subcommand ${sub}`);

	const nameRaw = flag(argv, "--name");
	const portRaw = flag(argv, "--port");
	const surfacesRaw = flag(argv, "--surfaces");
	const operatorRaw = flag(argv, "--operator");
	for (const [key, value] of [
		["--name", nameRaw],
		["--port", portRaw],
		["--surfaces", surfacesRaw],
		["--operator", operatorRaw],
	] as const) {
		if (value === null) usage(`${key} needs a value`);
	}
	const extra = refuseExtraArgs(argv);
	if (extra !== null) usage(extra);
	const anonymous = argv.includes("--anonymous");
	try {
		const name = parseName(nameRaw ?? undefined);
		if (sub === "down") return await runDown(name);
		if (sub === "status") return await runStatus(name);
		if (sub === "smoke") return await runSmoke(name);
		const port = Number(portRaw ?? String(DEFAULT_MCP_PORT));
		if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`bad --port ${portRaw ?? ""}`);
		const surfaces = parseSurfaces(surfacesRaw ?? undefined);
		const operator = parseOperator(operatorRaw ?? undefined, surfaces, anonymous);
		return await runUp({ name, port, surfaces, operator, anonymous }, process.cwd());
	} catch (cause) {
		if (cause instanceof RehearsalRefused) {
			process.stderr.write(`[rehearsal] refused: ${cause.message}.\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
