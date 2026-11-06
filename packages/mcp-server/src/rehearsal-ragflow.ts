/**
 * The owned RAGFlow HTTP fixture for the rehearsal harness (`--ragflow-fixture`).
 *
 * The harness spawns `rehearsal-ragflow-server.ts` (a loopback Bun process over
 * the recording `ragflow-fake.ts` with uploads served as chunks) next to the
 * twin, points the twin at it with a random scratch key, and stops exactly
 * that child on `down`, on interruption and on failed startup. The default
 * harness is unchanged: without the flag nothing here runs and no key is set.
 *
 * Wire contract (agreed with the docs-smoke owner):
 *
 * - `TwinState.ragflowFixture`: `{ enabled, endpoint, pid, startSeconds, cwd,
 *   script }`. `endpoint` is the loopback base URL; `cwd`/`script` stay in
 *   `state.json` only, for the stop-identity check. Absent when the flag was
 *   off or when an older `up` wrote the state (data migration, no shim).
 * - `consumer.env` names the fixture by NAME only: the endpoint URL, a
 *   readiness marker and the pid. Never the plane key.
 * - Control routes live only on the owned stand-in: `GET /__fixture/health`,
 *   `GET /__fixture/counts`, `POST /__fixture/reset`,
 *   `POST /__fixture/fail-retrieval`, `POST /__fixture/parse`. Counts are
 *   numbers only; no raw keys or request bodies are ever echoed.
 *
 * Everything exported here is pure except the two bounded fetch helpers, which
 * take an explicit timeout and return null on any transport or shape failure.
 * No function here reads a real env file or a production credential: the
 * scratch key is generated per call and handed to the child by env, never by
 * CLI arg, log line or consumer export.
 */
import { randomBytes } from "node:crypto";

/** The fixture HTTP entry point, spawned from the harness checkout. */
export const RAGFLOW_FIXTURE_SCRIPT = "packages/mcp-server/src/rehearsal-ragflow-server.ts";

/** Scratch key carriage: child env only, never a CLI arg or a log. */
export const RAGFLOW_FIXTURE_KEY_ENV = "RAGFLOW_FIXTURE_KEY";
/** Fixture listen port carriage: child env, a value the operator may see. */
export const RAGFLOW_FIXTURE_PORT_ENV = "RAGFLOW_FIXTURE_PORT";

/** Control routes, served only by the owned stand-in on loopback. */
export const FIXTURE_HEALTH_PATH = "/__fixture/health";
export const FIXTURE_COUNTS_PATH = "/__fixture/counts";
export const FIXTURE_RESET_PATH = "/__fixture/reset";
export const FIXTURE_FAIL_PATH = "/__fixture/fail-retrieval";
export const FIXTURE_PARSE_PATH = "/__fixture/parse";
/** Fixture-only proof control: seed known synthetic retrieval chunks. Never a product door. */
export const FIXTURE_SEED_PATH = "/__fixture/seed-chunks";

/** At most this many seeded chunks per call; the 64 KiB control cap bounds the bytes. */
export const FIXTURE_SEED_MAX_CHUNKS = 20;

/** The only retrieval failure statuses the control route accepts. */
export const FIXTURE_FAILURE_STATUSES = [500, 502, 503] as const;

 /** `consumer.env` names for the fixture locator: endpoint, marker, pid. */
export const FIXTURE_URL_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_URL";
export const FIXTURE_READY_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_READY";
export const FIXTURE_PID_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_PID";

/** Loopback hosts a fixture endpoint or control URL may name. */
const FIXTURE_LOOPBACK_HOSTS: Record<string, true> = {
	"127.0.0.1": true,
	"::1": true,
	localhost: true,
};

/** Facts about a host process, gathered before any signal. */
export interface FixtureProcFacts {
	pid: number;
	argv: string[];
	cwd: string;
	cgroup: string;
	startSeconds: number;
	listensOn: number[];
}

/** Side-effect counts the control route reports: numbers only, never bodies. */
interface FixtureCounts {
	requests: number;
	retrievals: number;
	uploads: number;
	documents: number;
}

/** A fresh random scratch key for one fixture: hex, so it is log-shape safe. */
export function newFixtureKey(bytes = 32): string {
	return randomBytes(bytes).toString("hex");
}

/**
 * Refuse a fixture endpoint or control URL before any request or signal: it
 * must parse, name plain http loopback with an explicit scratch port, and
 * carry no credentials, query, fragment, or unexpected path. Returns
 * the reason, or null when the URL is an owned-fixture shape. The production
 * ports are passed in so this module never duplicates the harness list.
 */
export function refuseFixtureControlUrl(raw: string, productionPorts: readonly number[]): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `unparseable fixture control target ${raw}`;
	}
	if (productionPorts.includes(Number(url.port))) {
		return `refusing fixture control on production :${url.port}`;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (FIXTURE_LOOPBACK_HOSTS[host] !== true) return `refusing non-loopback fixture control host ${url.hostname}`;
	if (url.protocol !== "http:") return `refusing non-http fixture control target on ${url.hostname}:${url.port}`;
	if (url.username !== "" || url.password !== "") return `refusing fixture control target with credentials on ${url.hostname}:${url.port}`;
	if (url.port === "") return `fixture control target on ${url.hostname} names no port`;
	const port = Number(url.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return `fixture control target on ${url.hostname} names no port`;
	if (url.search !== "" || url.hash !== "") return `refusing fixture control target with query or fragment on ${url.hostname}:${url.port}`;
	if (url.pathname !== "/" && !url.pathname.startsWith("/__fixture/")) return `refusing fixture control target with unexpected path ${url.pathname}`;
	return null;
}

/**
 * Whether the recorded fixture child may be stopped: pid, entry point,
 * checkout, start time (against pid reuse), non-system cgroup and no
 * production port must all agree. Returns the refusal reason, or null when
 * stopping is safe. Mirrors the twin `mayStop` ownership model.
 */
export function mayStopFixture(
	proc: FixtureProcFacts,
	state: { pid: number; startSeconds: number | null; cwd: string; script: string },
	productionPorts: readonly number[],
): string | null {
	if (proc.pid !== state.pid) return "fixture pid differs from state.json";
	if (state.startSeconds === null) return "fixture birth identity is unverified";
	if (proc.startSeconds !== state.startSeconds) return "fixture pid was reused (start time differs)";
	if (proc.argv.at(-1) !== state.script) return "not the fixture entry point";
	if (proc.cwd !== state.cwd) return "fixture cwd is not the recorded checkout";
	if (proc.cgroup.includes("/system.slice/")) return "fixture process is in system.slice";
	if (proc.listensOn.some((port) => productionPorts.includes(port))) {
		return "fixture process owns a production port";
	}
	return null;
}

/**
 * Before saving state, prove the spawned fixture pid is still itself and owns
 * the requested listener: alive, same start time (against pid reuse), and the
 * fixture port among its listeners. Readiness alone does not say which pid
 * answered. Returns the refusal reason, or null when confirmed.
 */
export function confirmFixtureSpawn(
	pid: number,
	port: number,
	startSeconds: number,
	deps: {
		alive: (pid: number) => boolean;
		startOf: (pid: number) => number | null;
		listensOn: (pid: number) => number[] | null;
	},
): string | null {
	if (!deps.alive(pid)) return `fixture pid ${pid} is gone; refusing to save state for a dead process`;
	const start = deps.startOf(pid);
	if (start === null) return `could not verify the start of fixture pid ${pid}`;
	if (start !== startSeconds) return `fixture pid ${pid} was reused (start time differs)`;
	const ports = deps.listensOn(pid);
	if (ports === null) return `could not read the listeners of fixture pid ${pid}`;
	if (!ports.includes(port)) return `fixture pid ${pid} does not own port ${port}; refusing to claim a stranger's listener`;
	return null;
}

/**
 * Parse a `GET counts` body into counts, or null when it is not the shape.
 * Every field must be a non-negative integer; anything else is not proof.
 */
export function parseFixtureCounts(body: unknown): FixtureCounts | null {
	if (body === null || typeof body !== "object") return null;
	const record = body as Record<string, unknown>;
	const fields = ["requests", "retrievals", "uploads", "documents"] as const;
	const out: Record<string, number> = {};
	for (const field of fields) {
		const value = record[field];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
		out[field] = value;
	}
	return {
		requests: out["requests"] ?? 0,
		retrievals: out["retrievals"] ?? 0,
		uploads: out["uploads"] ?? 0,
		documents: out["documents"] ?? 0,
	};
}

/**
 * Parse a `POST fail-retrieval` body: `{ status: 500 | 502 | 503 | null }`.
 * Null clears the injected failure. Anything else is a 400 at the server;
 * here it is a null parse so the caller refuses before any request.
 */
export function parseFailRetrievalBody(body: unknown): { status: number | null } | null {
	if (body === null || typeof body !== "object") return null;
	const status = (body as Record<string, unknown>)["status"];
	if (status === null) return { status: null };
	if (typeof status !== "number" || !(FIXTURE_FAILURE_STATUSES as readonly number[]).includes(status)) return null;
	return { status };
}

/**
 * Parse a `POST parse` body: `{ behavior: "done" | "never" }`, else null.
 */
export function parseParseBehaviourBody(body: unknown): { behavior: "done" | "never" } | null {
	if (body === null || typeof body !== "object") return null;
	const behavior = (body as Record<string, unknown>)["behavior"];
	if (behavior !== "done" && behavior !== "never") return null;
	return { behavior };
}

/** One normalized seeded chunk: dataset resolved, score defaulted, bounds checked. */
interface SeedChunk {
	dataset: string;
	content: string;
	document_id: string;
	source_url: string;
	heading_path: string;
	score: number;
}

/**
 * Parse a `POST seed-chunks` body: `{ dataset, chunks: [{ content,
 * document_id, source_url?, heading_path?, score?, dataset? }] }` with at
 * most FIXTURE_SEED_MAX_CHUNKS entries. Each per-chunk dataset defaults to
 * the top-level one. Synthetic proof content only: bounded strings, score in
 * [0,1] defaulting to 0.5 (below uploads at 0.9). Anything else is a 400 at
 * the server; here it is a null parse. Never echoes content in errors.
 */
export function parseSeedChunksBody(body: unknown): { dataset: string; seeds: SeedChunk[] } | null {
	if (body === null || typeof body !== "object") return null;
	const record = body as Record<string, unknown>;
	const dataset = record["dataset"];
	if (typeof dataset !== "string" || dataset.length < 1 || dataset.length > 128) return null;
	const chunks = record["chunks"];
	if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > FIXTURE_SEED_MAX_CHUNKS) return null;
	const seeds: SeedChunk[] = [];
	for (const entry of chunks) {
		if (entry === null || typeof entry !== "object") return null;
		const chunk = entry as Record<string, unknown>;
		const content = chunk["content"];
		const documentId = chunk["document_id"];
		if (typeof content !== "string" || content.length < 1 || content.length > 20000) return null;
		if (typeof documentId !== "string" || documentId.length < 1 || documentId.length > 128) return null;
		const chunkDataset = chunk["dataset"];
		const resolved = chunkDataset === undefined ? dataset : chunkDataset;
		if (typeof resolved !== "string" || resolved.length < 1 || resolved.length > 128) return null;
		const sourceUrl = chunk["source_url"];
		const headingPath = chunk["heading_path"];
		const score = chunk["score"];
		if (sourceUrl !== undefined && (typeof sourceUrl !== "string" || sourceUrl.length > 2048)) return null;
		if (headingPath !== undefined && (typeof headingPath !== "string" || headingPath.length > 1024)) return null;
		if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) return null;
		seeds.push({
			dataset: resolved,
			content,
			document_id: documentId,
			source_url: typeof sourceUrl === "string" ? sourceUrl : "",
			heading_path: typeof headingPath === "string" ? headingPath : "",
			score: typeof score === "number" ? score : 0.5,
		});
	}
	return { dataset, seeds };
}

/**
 * Bounded fixture readiness: `GET <endpoint>/health` must answer 200 with
 * `{ ok: true }`. Redirects are rejected before any follow, so a replacement
 * listener cannot steer the check off loopback. Any transport error, status
 * or shape is not ready — never a throw, so the harness wait loop can keep
 * polling.
 */
export async function checkFixtureReady(endpoint: string, timeoutMs: number): Promise<boolean> {
	try {
		const res = await fetch(`${endpoint}${FIXTURE_HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
		if (res.status !== 200) return false;
		const body = (await res.json()) as unknown;
		return body !== null && typeof body === "object" && (body as Record<string, unknown>)["ok"] === true;
	} catch {
		// Any error, a transport failure included, is not ready: the doc above says so and the harness polls again.
		return false;
	}
}
