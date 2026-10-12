#!/usr/bin/env bun
/**
 * Repeatable docs proof (`bun run smoke:docs -- --name <owned>`, 25-06 Task 2).
 *
 * Drives the twin named by `--name` (required, never defaulted) through the
 * actual search/ingest surface: REST (`/docs/search`, `/docs/ingest`,
 * `/events/query`), the MCP tool door (`POST /mcp` as JSON-RPC with a real
 * `initialize` handshake naming `serverInfo`, then `tools/call` for
 * `docs_search` / `docs_ingest`), and the real CLI
 * (`packages/cli/src/index.ts docs ingest|refresh`) against a fresh
 * committed scratch repository. The recording stand-in behind the twin is
 * steered only through its own loopback control namespace
 * (`/__fixture/health|counts|reset|fail-retrieval|parse|seed-chunks`); seeds
 * are synthetic retrieval-only corpus (served, never uploaded, never
 * counted) so served redaction and the pin gap are provable without ever
 * pushing a secret through the ingest gate. The plane key stays in the
 * server env and is never read here, never exported to a consumer, and
 * never printed. Retrieval is served from real uploads
 * (`serveUploadsAsChunks`) plus the seeded corpus, so every search proves
 * served bytes.
 *
 * Ownership is verified before any network, subprocess, or control effect:
 * the consumer URLs must equal the recorded twin identity, the recorded
 * checkout must be this checkout, and the recorded fixture/twin pids must
 * still be themselves (pid, start time against reuse, entry point,
 * checkout, listeners). Anything else refuses (exit 2) with zero effects.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 refused before (or
 * without) effects. Output carries names, booleans, counters and hashes
 * only: never page bodies, secrets, bearers, or full identifiers.
 *
 * Rehearsed here (a)-(g): (a) explicit-`dataset_ids` search over REST and
 * MCP with `<= 10` truthful citations, redacted snippets, untrusted framing,
 * URL-event readback and dataset scoping; (b) degraded empty-plus-reason on
 * an injected retrieval failure; (c) the six ingest refusals with exact
 * reasons and locator-only warnings (redactor, no-source-URL,
 * outside-roots, over-cap page and call, anonymous 401, VM guest via the
 * CLI preflight) plus resolve-by-name refusal of unknown and raw-id
 * datasets; (d) version-pin promotion across generations
 * (committed-bytes-only refresh, same-commit-no-second-generation,
 * superseded-gap) with last-five manifest retention proven exact on a
 * second dataset; (e) stand-in parse arms; (f) multipart retention (a
 * missing, failed, or conflicting part keeps the old pin); (g)
 * skills-sync-not-live (pinned serve with pin age plus exactly one
 * warning). Explicitly unproven here (not claimed, not asserted): live
 * G1-G4 (first probe, discovery/creation, real ingest, real served search)
 * which stay operator-gated to a human MODEL on the real plane, and
 * server-side `vm-guest` over REST — a whole-process config door limit,
 * not a request marker (the fixture twin is never a guest; the CLI
 * preflight arm proves the client side with zero effects). No `dry_run`,
 * RAG-manifest, or physical-deletion surface exists or is assumed
 * (superseded contract).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	confirmSpawnedTwin,
	mayStop,
	parseName,
	parseShellExports,
	PRODUCTION_PORTS,
	refuseCheckoutDir,
	refuseSmokeUrl,
	runDirFor,
	withNameLock,
} from "./rehearsal.ts";
import {
	confirmFixtureSpawn,
	mayStopFixture,
	parseFixtureCounts,
	RAGFLOW_FIXTURE_SCRIPT,
} from "../packages/mcp-server/src/rehearsal-ragflow.ts";

/** The smoke refused to drive this target; the message names hosts and ports, never values. */
export class SmokeRefused extends Error {}

/** A JSON-RPC envelope over the MCP door: result or error, never both trusted. */
interface RpcEnvelope {
	result?: {
		isError?: boolean;
		content?: Array<{ text?: string }>;
		protocolVersion?: unknown;
		serverInfo?: { name?: unknown; version?: unknown };
	};
	error?: unknown;
}

/** An ingest reply over REST or inside a tool payload. */
interface IngestReply {
	ok?: unknown;
	refused?: unknown;
	reason?: unknown;
	rules?: unknown;
	page?: unknown;
	dataset_id?: unknown;
	stripped_images?: unknown;
	results?: Array<{ status?: unknown; document_id?: unknown }>;
}

/** A search reply over REST or inside a tool payload. */
interface SearchReplyBody {
	chunks?: unknown;
	untrusted?: unknown;
	degraded?: unknown;
	reason?: unknown;
}

/** An event-query reply. */
interface EventsReply {
	events?: unknown;
}

/** A fixture control reply carrying counts. */
interface CountsReply {
	counts?: unknown;
}

/**
 * Boundary read over already-parsed JSON. The shape is named once here so
 * call sites never fabricate inline member-access casts; every caller still
 * validates the fields it relies on before trusting them.
 */
function shaped<T>(value: unknown): T | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const named: T = value as T;
	return named;
}

/** Consumer keys this script reads. The plane key is deliberately absent. */
const FIXTURE_URL_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_URL";
const FIXTURE_READY_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_READY";
const FIXTURE_PID_KEY = "SUBSTRATE_RAGFLOW_FIXTURE_PID";
const OPERATOR_TOKEN_KEY = "SUBSTRATE_REHEARSAL_OPERATOR_TOKEN";
const RUN_NAME_KEY = "SUBSTRATE_REHEARSAL_NAME";

/** One page may not exceed 1 MB; one call 5 MB; the route reads up to 6 MB (D25-05). */
const PAGE_MAX_BYTES = 1_000_000;
const CALL_TARGET_BYTES = 5_400_000;
const ROUTE_MAX_BYTES = 6_000_000;

const CALL_TIMEOUT_MS = 15_000;
const INGEST_TIMEOUT_MS = 150_000;
const READBACK_RETRIES = 5;
const READBACK_PAUSE_MS = 1000;
/** `ss` only reads listeners; it never signals. */
const LISTENERS_TIMEOUT_MS = 15_000;

/** Loopback hosts a proof may drive; anything else risks production. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return bare === "127.0.0.1" || bare === "::1" || bare === "localhost";
}

/** `bun run smoke:docs -- --name <owned>`; `--name` is required, unknown flags refuse (exit 2), never ignored. */
export function parseDocsSmokeArgs(argv: string[]): { name: string } {
	let nameRaw: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--name") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new SmokeRefused("--name needs a value");
			nameRaw = value;
			index += 1;
		} else {
			throw new SmokeRefused(`unknown flag ${arg}: usage smoke:docs -- --name <owned>`);
		}
	}
	if (nameRaw === undefined) throw new SmokeRefused("--name <owned> is required: the smoke never picks a twin on its own");
	try {
		return { name: parseName(nameRaw) };
	} catch (cause) {
		throw new SmokeRefused(cause instanceof Error ? cause.message : String(cause));
	}
}

export interface FixtureTarget {
	base: string;
	fixtureUrl: string;
	fixtureEnabled: boolean;
	fixtureReady: string;
	operatorToken: string;
	recordName: string;
	name: string;
}

/**
 * Refuse a smoke target before any effect: not a fixture run, not ready, an
 * anonymous twin, a production port, a non-loopback host, or a URL carrying
 * credentials or failing to parse. Null means go.
 */
export function refuseFixtureTarget(target: FixtureTarget): string | null {
	if (!target.fixtureEnabled) return `instance ${target.name} has no recording stand-in enabled; run rehearsal up with the fixture flag first`;
	if (target.fixtureReady !== "1") return `instance ${target.name} stand-in is not ready`;
	if (!target.operatorToken) return `instance ${target.name} is anonymous; docs proof needs an authenticated surface`;
	if (target.recordName && target.recordName !== target.name) {
		return `consumer record names ${target.recordName}, not ${target.name}`;
	}
	let base: URL;
	try {
		base = new URL(target.base);
	} catch {
		return `unparseable twin target for ${target.name}`;
	}
	if (base.username || base.password) return `twin target for ${target.name} carries credentials`;
	const baseRefused = refuseSmokeUrl(target.base);
	if (baseRefused !== null) return baseRefused;
	let fixture: URL;
	try {
		fixture = new URL(target.fixtureUrl);
	} catch {
		return `unparseable stand-in target for ${target.name}`;
	}
	if (fixture.protocol !== "http:") return `stand-in target for ${target.name} is not plain loopback http`;
	if (fixture.username || fixture.password) return `stand-in target for ${target.name} carries credentials`;
	if (!isLoopbackHost(fixture.hostname)) return `refusing non-loopback stand-in host ${fixture.hostname}`;
	const port = Number(fixture.port);
	if (!Number.isInteger(port) || port <= 0) return `stand-in target for ${target.name} names no port`;
	if ((PRODUCTION_PORTS as readonly number[]).includes(port)) return `refusing to drive production :${port}`;
	return null;
}

/**
 * Cross-checks the consumer record against the recorded twin identity. Pure
 * string/port/path comparison, no I/O, so the boundary tests pin it
 * exactly: a wrong origin, a foreign pid, a mismatched port, or a foreign
 * checkout all refuse.
 */
export interface BindingFacts {
	name: string;
	base: string;
	fixtureUrl: string;
	recordEndpoint: string;
	recordPid: string;
	fixturePid: number;
	mcpPort: number;
	checkout: string;
	scriptCheckout: string;
}

export function refuseOwnedBinding(facts: BindingFacts): string | null {
	const strip = (raw: string): string => raw.replace(/\/+$/, "");
	if (strip(facts.fixtureUrl) !== strip(facts.recordEndpoint)) {
		return `consumer stand-in ${facts.fixtureUrl || "(missing)"} is not the recorded endpoint for ${facts.name}`;
	}
	if (facts.recordPid !== String(facts.fixturePid)) {
		return `stand-in identity for ${facts.name} is unverifiable`;
	}
	let basePort: number;
	try {
		basePort = Number(new URL(facts.base).port);
	} catch {
		return `unparseable twin target for ${facts.name}`;
	}
	if (!Number.isInteger(basePort) || basePort !== facts.mcpPort) {
		return `twin url port ${Number.isInteger(basePort) ? basePort : "(missing)"} is not the recorded twin port for ${facts.name}`;
	}
	if (facts.checkout !== facts.scriptCheckout) {
		return `state checkout ${facts.checkout || "(missing)"} is not this checkout; refusing to drive a foreign tree`;
	}
	const checkoutRefused = refuseCheckoutDir(facts.checkout);
	if (checkoutRefused !== null) return checkoutRefused;
	return null;
}

/** One report line: the name, the verdict, and public detail only. */
export function formatCheck(name: string, ok: boolean, detail?: string): string {
	return `${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}\n`;
}

/** `key=value` lines the CLI prints, keeping repeats in order. */
export function parseKeyValues(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (!key) continue;
		(out[key] ??= []).push(value);
	}
	return out;
}

/** A response body as JSON, else the last SSE data frame, else null. */
export function lastJsonFrame(text: string): unknown {
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
	return null;
}

/** A citation commit naming a pinned 40-hex generation. */
export function isPinCommit(value: unknown): boolean {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** A citation commit honestly naming the pin gap instead of a false current. */
export function isPinGap(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("dataset-pin:");
}

interface Attempt {
	status: number | null;
	body: unknown;
	raw: string;
}

async function call(base: string, token: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<Attempt> {
	try {
		const res = await fetch(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
			// A proof never follows a redirect: a moved twin is a wrong twin.
			redirect: "error",
		});
		const raw = await res.text();
		return { status: res.status, body: lastJsonFrame(raw), raw };
	} catch (cause) {
		return { status: null, body: null, raw: String(cause) };
	}
}

export interface ToolVerdict {
	/** True for an expected tool refusal AND for transport/protocol failures — see protocolError. */
	isError: boolean;
	/** The parsed tool payload even when it refuses, so callers assert the reason, not the flag. */
	value: Record<string, unknown> | null;
	/** Non-null when this is NOT an expected refusal: transport, JSON-RPC error, or malformed result. */
	protocolError: string | null;
}

/** A JSON-RPC error shape, down to a locator-only string. */
export function describeRpcError(error: unknown): string {
	if (error !== null && typeof error === "object") {
		const message = "message" in error && typeof error.message === "string" ? error.message : "unknown";
		const code = "code" in error ? String(error.code ?? "?") : "?";
		return `code=${code} ${message}`.slice(0, 160);
	}
	return "unknown error shape";
}

/**
 * A tool verdict that keeps the refusal payload: a caller asserting only
 * `isError` passes transport failures as refusals. Callers must require
 * `protocolError === null` plus the expected `value.reason`.
 */
export function toolVerdict(attempt: Attempt): ToolVerdict {
	if (attempt.status === null) {
		return { isError: true, value: null, protocolError: `transport: ${attempt.raw.slice(0, 120)}` };
	}
	const body = shaped<RpcEnvelope>(attempt.body);
	if (!body || typeof body !== "object") {
		return { isError: true, value: null, protocolError: `status=${String(attempt.status)} unparseable-mcp-envelope` };
	}
	if (body.error !== undefined) {
		// A protocol refusal (unknown tool, bad envelope, audit-level denial):
		// never an expected tool refusal.
		return { isError: true, value: null, protocolError: `json-rpc-error: ${describeRpcError(body.error)}` };
	}
	const text = body.result?.content?.[0]?.text;
	if (typeof text !== "string") return { isError: true, value: null, protocolError: "malformed-tool-result" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { isError: true, value: null, protocolError: "malformed-tool-payload" };
	}
	const value = shaped<Record<string, unknown>>(parsed);
	return { isError: body.result?.isError === true, value, protocolError: null };
}

/** A real MCP handshake: `initialize` first, naming the server. Raw `tools/call` without it is not proof. */
async function mcpInitialize(base: string, token: string, id: number): Promise<{ server: string | null; protocolError: string | null }> {
	const attempt = await call(base, token, "/mcp", {
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "docs-smoke", version: "1" } },
	});
	const body = shaped<RpcEnvelope>(attempt.body);
	if (attempt.status === null || !body || typeof body !== "object" || body.error !== undefined) {
		return { server: null, protocolError: "initialize failed" };
	}
	const info = body?.result?.serverInfo;
	const name = info !== undefined && info !== null && typeof info === "object" && "name" in info && typeof info.name === "string" ? info.name : "";
	if (!name) return { server: null, protocolError: "initialize answered without serverInfo" };
	return { server: name, protocolError: null };
}

async function toolCall(
	base: string,
	token: string,
	id: number,
	name: string,
	args: Record<string, unknown>,
	timeoutMs = CALL_TIMEOUT_MS,
): Promise<ToolVerdict> {
	// A real client says hello first; the stateless door drops the
	// notification and the outcome is ignored either way.
	await call(base, token, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
	const attempt = await call(
		base,
		token,
		"/mcp",
		{ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
		timeoutMs,
	);
	return toolVerdict(attempt);
}

interface GitOut {

	code: number | null;
	stdout: string;
	stderr: string;
}

/** Read-only git with a minimal allowlist env: no user configs, hooks, network, or auth leak in. */
function git(dir: string, args: string[], env: Record<string, string>): GitOut {
	const child = Bun.spawnSync(["git", ...args], { cwd: dir, env, timeout: LISTENERS_TIMEOUT_MS });
	return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

interface CliOut {
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
}

/** Every CLI spawn is bounded: a hung CLI fails the check, never the harness. */
async function runCli(checkout: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs = INGEST_TIMEOUT_MS): Promise<CliOut> {
	const child = Bun.spawn([process.execPath, join(checkout, "packages/cli/src/index.ts"), ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const killer = setTimeout(() => {
		timedOut = true;
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}, timeoutMs);
	try {
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { code, out, err, timedOut };
	} finally {
		clearTimeout(killer);
	}
}

interface SmokeContext {
	name: string;
	base: string;
	token: string;
	checkout: string;
	fixtureUrl: string;
	tag: string;
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The twin identity the harness persists; the stand-in block is absent without the flag. */
interface TwinIdentity {
	name?: unknown;
	pid?: unknown;
	startSeconds?: unknown;
	checkout?: unknown;
	mcpPort?: unknown;
	ragflowFixture?: { enabled?: unknown; endpoint?: unknown; pid?: unknown; startSeconds?: unknown; cwd?: unknown; script?: unknown };
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
	try {
		const run = Bun.spawnSync(["ss", "-ltnpH"], { stdout: "pipe", stderr: "pipe", timeout: LISTENERS_TIMEOUT_MS });
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
	} catch {
		// A missing `ss` is an unverifiable pid, not a reason to proceed.
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface LocalProc {
	argv: string[];
	cwd: string;
	cgroup: string;
	startSeconds: number;
	listensOn: number[];
}

function readLocalProc(pid: number): LocalProc | null {
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
		argv: cmdline.split("\0").filter((s) => s.length > 0),
		cwd,
		cgroup: cgroup.split("\n").find((l) => l.trim().length > 0) ?? "",
		startSeconds,
		listensOn,
	};
}

/**
 * Named own run directory files only; never the inherited environment, never
 * the server env. Verifies ownership before any network, subprocess effect,
 * or control call: URLs bound to the recorded ports and endpoint, the
 * recorded checkout bound to this checkout, and both pids re-verified
 * against reuse, entry point, checkout, and listeners. Anything unverifiable
 * refuses (exit 2) with zero effects.
 */
function loadContext(name: string, runDir: string, scriptCheckout: string): SmokeContext {
	const stateRaw = readText(join(runDir, "state.json"));
	if (stateRaw === null) throw new SmokeRefused(`no state.json for instance ${name}: run rehearsal up first`);
	let state: TwinIdentity | null = null;
	try {
		state = JSON.parse(stateRaw) as TwinIdentity;
	} catch {
		throw new SmokeRefused(`state.json for ${name} is unverifiable`);
	}
	if (!state || typeof state !== "object") throw new SmokeRefused(`state.json for ${name} is unverifiable`);
	const envRaw = readText(join(runDir, "consumer.env"));
	if (envRaw === null) throw new SmokeRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
	const record = parseShellExports(envRaw);
	const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const token = record[OPERATOR_TOKEN_KEY] ?? "";
	const fixtureUrl = (record[FIXTURE_URL_KEY] ?? "").replace(/\/+$/, "");
	const fixtureReady = record[FIXTURE_READY_KEY] ?? "";
	const recordName = record[RUN_NAME_KEY] ?? "";
	const fixture = state.ragflowFixture;
	const enabled = fixture?.enabled === true && typeof fixture.endpoint === "string" && fixture.endpoint.replace(/\/+$/, "") === fixtureUrl;
	const refused = refuseFixtureTarget({ base, fixtureUrl, fixtureEnabled: enabled, fixtureReady, operatorToken: token, recordName, name });
	if (refused !== null) throw new SmokeRefused(refused);
	if (!base) throw new SmokeRefused(`consumer.env for ${name} has no twin url`);
	if (typeof state.checkout !== "string" || !state.checkout) throw new SmokeRefused(`state.json for ${name} names no checkout`);
	if (typeof state.mcpPort !== "number" || !Number.isInteger(state.mcpPort) || state.mcpPort <= 0) {
		throw new SmokeRefused(`state.json for ${name} names no twin port`);
	}
	if (
		typeof fixture?.pid !== "number" ||
		typeof fixture?.startSeconds !== "number" ||
		typeof fixture?.cwd !== "string" ||
		typeof fixture?.script !== "string" ||
		typeof fixture?.endpoint !== "string"
	) {
		throw new SmokeRefused(`state.json for ${name} names no verifiable stand-in identity`);
	}
	if (typeof state.pid !== "number" || typeof state.startSeconds !== "number") {
		throw new SmokeRefused(`state.json for ${name} names no verifiable twin identity`);
	}
	const bindingRefused = refuseOwnedBinding({
		name,
		base,
		fixtureUrl,
		recordEndpoint: fixture.endpoint,
		recordPid: record[FIXTURE_PID_KEY] ?? "",
		fixturePid: fixture.pid,
		mcpPort: state.mcpPort,
		checkout: state.checkout,
		scriptCheckout,
	});
	if (bindingRefused !== null) throw new SmokeRefused(bindingRefused);
	// Re-verify both pids against reuse and foreign listeners before any effect.
	const deps = { alive: pidAlive, startOf: readStartSeconds, listensOn: readListeningPorts };
	if (!pidAlive(fixture.pid)) throw new SmokeRefused(`stand-in pid ${fixture.pid} is gone; refusing a stranger's listener`);
	const fixtureFacts = readLocalProc(fixture.pid);
	if (fixtureFacts === null) throw new SmokeRefused(`cannot verify stand-in pid ${fixture.pid}; refusing to drive it`);
	let fixturePort: number;
	try {
		fixturePort = Number(new URL(fixture.endpoint).port);
	} catch {
		throw new SmokeRefused(`recorded stand-in endpoint for ${name} is unverifiable`);
	}
	if (!Number.isInteger(fixturePort) || fixturePort <= 0) throw new SmokeRefused(`recorded stand-in endpoint for ${name} names no port`);
	const fixtureStopReason = mayStopFixture(
		{ pid: fixture.pid, argv: fixtureFacts.argv, cwd: fixtureFacts.cwd, cgroup: fixtureFacts.cgroup, startSeconds: fixtureFacts.startSeconds, listensOn: fixtureFacts.listensOn },
		{ pid: fixture.pid, startSeconds: fixture.startSeconds, cwd: fixture.cwd, script: fixture.script },
		PRODUCTION_PORTS,
	);
	if (fixtureStopReason !== null) throw new SmokeRefused(`refusing foreign stand-in pid ${fixture.pid}: ${fixtureStopReason}`);
	if (fixtureFacts.argv.at(-1) !== RAGFLOW_FIXTURE_SCRIPT) {
		throw new SmokeRefused(`refusing foreign stand-in pid ${fixture.pid}: not the fixture entry point`);
	}
	const fixtureConfirm = confirmFixtureSpawn(fixture.pid, fixturePort, fixture.startSeconds, deps);
	if (fixtureConfirm !== null) throw new SmokeRefused(fixtureConfirm);
	if (!pidAlive(state.pid)) throw new SmokeRefused(`twin pid ${state.pid} is gone; refusing a stranger's listener`);
	const twinFacts = readLocalProc(state.pid);
	if (twinFacts === null) throw new SmokeRefused(`cannot verify twin pid ${state.pid}; refusing to drive it`);
	const twinStopReason = mayStop(
		{ pid: state.pid, argv: twinFacts.argv, cwd: twinFacts.cwd, cgroup: twinFacts.cgroup, startSeconds: twinFacts.startSeconds, listensOn: twinFacts.listensOn },
		{ pid: state.pid, checkout: state.checkout, startSeconds: state.startSeconds },
	);
	if (twinStopReason !== null) throw new SmokeRefused(`refusing foreign twin pid ${state.pid}: ${twinStopReason}`);
	const twinConfirm = confirmSpawnedTwin(state.pid, state.mcpPort, state.startSeconds, deps);
	if (twinConfirm !== null) throw new SmokeRefused(twinConfirm);
	return { name, base, token, checkout: state.checkout, fixtureUrl, tag: `docs-smoke-${name}-${Date.now().toString(36)}` };
}

async function fixtureCall(fixtureUrl: string, path: string, body?: unknown): Promise<Attempt> {
	return call(fixtureUrl, "", path, body);
}

interface Citation {
	title: unknown;
	source_url: unknown;
	heading_path: unknown;
	commit: unknown;
	snippet: unknown;
	score: unknown;
	document_id: unknown;
	chunk_id: unknown;
}

export function citationsOf(value: unknown): Citation[] | null {
	const reply = shaped<SearchReplyBody>(value);
	if (reply === null || !Array.isArray(reply.chunks)) return null;
	const chunks: Citation[] = reply.chunks as Citation[];
	return chunks;
}

export function citationShapeOk(chunk: Citation): boolean {
	return (
		typeof chunk.title === "string" &&
		typeof chunk.source_url === "string" &&
		chunk.source_url.length > 0 &&
		typeof chunk.heading_path === "string" &&
		(isPinCommit(chunk.commit) || isPinGap(chunk.commit)) &&
		typeof chunk.snippet === "string" &&
		chunk.snippet.length <= 1200 &&
		typeof chunk.document_id === "string" &&
		typeof chunk.chunk_id === "string"
	);
}

/** One retained version row from the bound own-state file: locators only, never keys. */
export interface StateVersionRow {
	dataset: string;
	dataset_id: string;
	version: string;
	commit: string;
	content_sha256: string;
	ingested_at: string;
	documents: Array<{ source_url: string; document_id: string; content_sha256: string }>;
}

/**
 * Bound own-state read over the locator's docs-state.json, shaped against
 * the real IngestStateFile (`version: 1` plus records, versions, sync and
 * refreshes tables). Null on any shape failure: the caller fails the check,
 * never trusts a partial row. Manifest documents stay optional per row —
 * older rows may lack them — and default to empty.
 */
export function stateVersionsOf(value: unknown): Record<string, StateVersionRow[]> | null {
	const root = shaped<{ versions?: unknown }>(value);
	if (root === null || root.versions === null || typeof root.versions !== "object" || Array.isArray(root.versions)) return null;
	const out: Record<string, StateVersionRow[]> = {};
	for (const [dataset, list] of Object.entries(root.versions as Record<string, unknown>)) {
		if (!Array.isArray(list)) return null;
		const rows: StateVersionRow[] = [];
		for (const entry of list) {
			const row = shaped<Record<string, unknown>>(entry);
			if (row === null) return null;
			const keys = ["dataset", "dataset_id", "version", "commit", "content_sha256", "ingested_at"] as const;
			if (!keys.every((key) => typeof row[key] === "string")) return null;
			if (!Number.isFinite(Date.parse(String(row["ingested_at"])))) return null;
			const rawDocs = row["documents"] ?? [];
			if (!Array.isArray(rawDocs)) return null;
			const documents: StateVersionRow["documents"] = [];
			for (const doc of rawDocs) {
				const d = shaped<Record<string, unknown>>(doc);
				if (d === null || typeof d["source_url"] !== "string" || typeof d["document_id"] !== "string" || typeof d["content_sha256"] !== "string") return null;
				documents.push({ source_url: d["source_url"], document_id: d["document_id"], content_sha256: d["content_sha256"] });
			}
			rows.push({
				dataset: String(row["dataset"]),
				dataset_id: String(row["dataset_id"]),
				version: String(row["version"]),
				commit: String(row["commit"]),
				content_sha256: String(row["content_sha256"]),
				ingested_at: String(row["ingested_at"]),
				documents,
			});
		}
		out[dataset] = rows;
	}
	return out;
}

interface LedgerEvent {
	kind?: unknown;
	payload?: Record<string, unknown>;
	session_id?: unknown;
}

async function querySessionEvents(ctx: SmokeContext, session: string): Promise<LedgerEvent[]> {
	for (let attempt = 0; attempt < READBACK_RETRIES; attempt += 1) {
		const queried = await call(ctx.base, ctx.token, "/events/query", {
			session_id: session,
			include_payload: true,
			limit: 100,
			order: "asc",
		});
		const events = shaped<EventsReply>(queried.body)?.events;
		if (Array.isArray(events) && events.length > 0) {
			const ledger: LedgerEvent[] = events as LedgerEvent[];
			return ledger;
		}
		await Bun.sleep(READBACK_PAUSE_MS);
	}
	return [];
}

function payloadHasNo(responseRaw: string, secrets: string[]): boolean {
	return secrets.every((secret) => secret.length === 0 || !responseRaw.includes(secret));
}

async function runSmokeInner(name: string, runDir: string, scriptCheckout: string): Promise<number> {
	const ctx = loadContext(name, runDir, scriptCheckout);
	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(formatCheck(what, ok, detail));
	};
	process.stdout.write(`\n[docs-smoke] ${name} ${ctx.tag}\n\n`);

	try {
		// Read-only readiness: the twin answers, the stand-in answers. No writes yet.
		const boot = await call(ctx.base, ctx.token, "/healthz");
		if (boot.status !== 200) throw new SmokeRefused(`twin at ${ctx.base} is not answering /healthz`);
		const lamp = await fixtureCall(ctx.fixtureUrl, "/__fixture/health");
		check(lamp.status === 200, "stand-in-control", `status=${String(lamp.status)}`);
		const reset = await fixtureCall(ctx.fixtureUrl, "/__fixture/reset", {});
		const zeroed = parseFixtureCounts(shaped<CountsReply>(reset.body)?.counts ?? reset.body);
		check(
			reset.status === 200 &&
				zeroed !== null &&
				zeroed.requests === 0 &&
				zeroed.retrievals === 0 &&
				zeroed.uploads === 0 &&
				zeroed.documents === 0,
			"stand-in-reset",
			`status=${String(reset.status)}`,
		);

		// Runtime-planted synthetics: built here, never committed, never printed.
		// Both are rule-backed (openai-proj, anthropic): an unknown shape would
		// prove nothing about the redactor.
		const secretLong = `sk${"-proj-"}${randomBytes(10).toString("hex")}`;
		const secretAlt = `sk${"-ant-"}${randomBytes(16).toString("hex")}`;
		const planted = [secretLong, secretAlt];
		const marker = `smoke-marker-${ctx.tag}`;
		// Controlled untrusted corpus: 20 synthetic chunks seeded straight
		// into the stand-in's retrieval (never through the ingest gate, which
		// must refuse secrets). Counts stay untouched: seeds are served, not
		// uploaded. Retrieval serves uploads first, then seeds in call order.
		const secretMarker = `smoke-secret-${ctx.tag}`;
		const otherMarker = `smoke-other-${ctx.tag}`;
		const seedChunks = [
			{
				content: `${secretMarker} synthetic redaction probe ${secretLong} mid ${secretAlt} tail ${"p".repeat(1400)}`,
				document_id: `seed-${ctx.tag}-secret`,
				source_url: `https://example.com/seed/${ctx.tag}/secret`,
				heading_path: "Seed",
				score: 0.5,
			},
			...Array.from({ length: 18 }, (_, n) => ({
				content: `${marker} seed ${n + 1} ${"q".repeat(200)}`,
				document_id: `seed-${ctx.tag}-${n + 1}`,
				source_url: `https://example.com/seed/${ctx.tag}/${n + 1}`,
				heading_path: "Seed",
				score: 0.5,
			})),
			{
				content: `${otherMarker} other dataset seed ${"r".repeat(200)}`,
				document_id: `seed-${ctx.tag}-other`,
				source_url: `https://example.com/seed/${ctx.tag}/other`,
				heading_path: "Seed",
				dataset: "programming-desk",
				score: 0.5,
			},
		];
		const seedPayload = { dataset: "agent-substrate", chunks: seedChunks };
		const seedBytes = Buffer.byteLength(JSON.stringify(seedPayload), "utf8");
		const seeded = await fixtureCall(ctx.fixtureUrl, "/__fixture/seed-chunks", seedPayload);
		const seededBody = shaped<{ ok?: unknown; seeded?: unknown }>(seeded.body);
		check(
			seedBytes <= 64 * 1024 && seeded.status === 200 && seededBody?.ok === true && seededBody?.seeded === 20,
			"stand-in-seed",
			`seeded=${String(seededBody?.seeded ?? -1)} bytes=${String(seedBytes)}`,
		);

		// (c) Clean ingest plus hash idempotency, over the real route — BEFORE
		// the first search, because the stand-in serves uploads as chunks and
		// a reset fixture serves nothing until something is uploaded.
		const ingestSession = `${ctx.tag}-ingest`;
		const pagePath = `docs/smoke-${ctx.tag}.md`;
		const pageUrl = `https://example.com/smoke/${ctx.tag}`;
		const pageBody = `# Smoke ${ctx.tag}\n\nAgents reach the docs only through the substrate. ${marker} clean.\n`;
		const first = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }], session_id: ingestSession },
			INGEST_TIMEOUT_MS,
		);
		const firstBody = shaped<IngestReply>(first.body);
		const firstStatus = firstBody?.results?.[0]?.status;
		const firstDocId = firstBody?.results?.[0]?.document_id;
		const cleanDocId = typeof firstDocId === "string" ? firstDocId : "";
		check(
			first.status === 200 && firstBody?.ok === true && typeof firstBody?.dataset_id === "string" && firstStatus === "ingested" && cleanDocId !== "",
			"ingest-stored",
			`status=${String(first.status)}`,
		);
		const second = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }], session_id: ingestSession },
			INGEST_TIMEOUT_MS,
		);
		const secondStatus = shaped<IngestReply>(second.body)?.results?.[0]?.status;
		check(second.status === 200 && secondStatus === "unchanged", "ingest-idempotent", `status=${String(second.status)}`);

		// (a) Explicit search: one named dataset, at most 10 truthful citations,
		// over the upload just stored. No pin exists yet, so every served
		// chunk must honestly name the gap — a false current fails here.
		const searchSession = `${ctx.tag}-search`;
		const searched = await call(ctx.base, ctx.token, "/docs/search", {
			question: "how do agents search the docs through the substrate?",
			datasets: ["agent-substrate"],
			session_id: searchSession,
		});
		const chunks = citationsOf(searched.body);
		// Pool: 1 upload plus 19 served seeds, so exactly 10 served means the
		// cap engaged — never an empty corpus pretending to be capped.
		const shapeOk = searched.status === 200 && chunks !== null && chunks.length === 10;
		check(shapeOk, "search-shape", `status=${String(searched.status)} count=${String(chunks?.length ?? -1)} pool=20`);
		const reply = shaped<SearchReplyBody>(searched.body);
		check(typeof reply?.untrusted === "string" && reply.untrusted.includes("untrusted"), "search-untrusted", "framed");
		const citesOk = chunks !== null && chunks.every(citationShapeOk);
		check(citesOk === true, "search-citations", `capped=${String(chunks?.every((chunk) => typeof chunk.snippet === "string" && chunk.snippet.length <= 1200) ?? false)}`);
		check(
			chunks !== null && chunks.length > 0 && chunks.every((chunk) => isPinGap(chunk.commit)),
			"search-all-gap",
			`count=${String(chunks?.length ?? -1)}`,
		);
		const servedRaw = JSON.stringify(chunks);
		// Nonvacuous served redaction on the snippet path: the secret-bearing
		// seed demonstrably traversed (its marker is served) while both
		// rule-backed synthetics are gone.
		check(
			chunks !== null && servedRaw.includes(secretMarker) && payloadHasNo(servedRaw, planted),
			"search-redacted",
			`checked=${String(chunks?.length ?? 0)}`,
		);
		check(chunks !== null && servedRaw.includes(marker), "search-traversal", `checked=${String(chunks?.length ?? 0)}`);
		// The other-dataset seed must never leak into this dataset's search.
		check(chunks !== null && !servedRaw.includes(otherMarker), "search-scoped", "other-dataset-absent");
		const searchEvents = await querySessionEvents(ctx, searchSession);
		const urlNote = searchEvents.find((event) => event.kind === "note" && event.payload?.["action"] === "docs.search");
		const returnedUrls = (chunks ?? []).map((chunk) => String(chunk.source_url)).sort();
		const notedRaw = urlNote?.payload?.["urls"];
		const notedUrls = Array.isArray(notedRaw) ? notedRaw.map(String).sort() : [];
		check(
			urlNote !== undefined && JSON.stringify(notedUrls) === JSON.stringify(returnedUrls),
			"search-event-readback",
			`events=${String(searchEvents.length)} urls=${String(returnedUrls.length)}`,
		);

		// (a) MCP search over the same twin, behind a real handshake.
		const handshake = await mcpInitialize(ctx.base, ctx.token, 10);
		check(handshake.protocolError === null, "mcp-initialize", `server=${handshake.server ?? "?"}`);
		const mcpSearch = await toolCall(ctx.base, ctx.token, 11, "docs_search", {
			question: "how do agents search the docs through the substrate?",
			datasets: ["agent-substrate"],
			session_id: `${ctx.tag}-mcp-search`,
		});
		const mcpChunks = mcpSearch.value !== null ? citationsOf(mcpSearch.value) : null;
		const mcpSearchBody = shaped<SearchReplyBody>(mcpSearch.value);
		check(
			mcpSearch.protocolError === null &&
				!mcpSearch.isError &&
				mcpChunks !== null &&
				mcpChunks.length > 0 &&
				mcpChunks.length <= 10 &&
				mcpChunks.every(citationShapeOk) &&
				typeof mcpSearchBody?.untrusted === "string" &&
				payloadHasNo(JSON.stringify(mcpChunks), planted),
			"mcp-search",
			`count=${String(mcpChunks?.length ?? -1)}`,
		);
		// A wrong tool is a protocol error, never a refusal: the checks above
		// must be able to tell the two apart.
		const mcpBogus = await toolCall(ctx.base, ctx.token, 14, "docs_no_such_tool", { question: "x" });
		check(mcpBogus.isError && mcpBogus.protocolError !== null, "mcp-protocol", "bogus-tool-is-protocol-error");

		// (b) Injected retrieval failure: empty plus reason, warning, then recovery.
		const failSession = `${ctx.tag}-degraded`;
		await fixtureCall(ctx.fixtureUrl, "/__fixture/fail-retrieval", { status: 503 });
		const failed = await call(ctx.base, ctx.token, "/docs/search", { question: "anything", datasets: ["agent-substrate"], session_id: failSession });
		const failedBody = shaped<SearchReplyBody>(failed.body);
		check(
			failed.status === 200 && Array.isArray(failedBody?.chunks) && failedBody?.chunks.length === 0 && failedBody?.degraded === true && typeof failedBody?.reason === "string",
			"search-degraded",
			`reason=${String(typeof failedBody?.reason === "string" && failedBody.reason.length > 0)}`,
		);
		const failEvents = await querySessionEvents(ctx, failSession);
		const failWarning = failEvents.find((event) => event.kind === "warning" && typeof event.payload?.["reason"] === "string");
		check(failWarning !== undefined, "search-degraded-warning", `events=${String(failEvents.length)}`);
		await fixtureCall(ctx.fixtureUrl, "/__fixture/fail-retrieval", { status: null });
		const recovered = await call(ctx.base, ctx.token, "/docs/search", { question: "anything", datasets: ["agent-substrate"], session_id: `${ctx.tag}-recovered` });
		const recoveredChunks = citationsOf(recovered.body);
		check(recovered.status === 200 && recoveredChunks !== null && recoveredChunks.length > 0, "search-recovered", `status=${String(recovered.status)}`);

		// (c) The six refusals, each fail-closed with locator-only warnings.
		// Canonical six: redactor, no-source-URL, outside-roots, over-cap
		// page, anonymous, VM guest. The guest gate is proved through the
		// CLI preflight below (the fixture twin is never a guest, so the
		// server gate stays a door limit, not an operator gate); unknown-dataset
		// and raw-id ride as extra resolve-by-name arms (raw ids never match a
		// configured name, so both refuse without creating). Baseline is
		// snapshotted AFTER the legit ingests above: the clean upload already
		// moved the counters.
		const baseline = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		check(baseline !== null, "refusals-baseline", `uploads=${String(baseline?.uploads ?? -1)}`);
		const refusalSession = `${ctx.tag}-refused`;
		const refusedReasons: string[] = [];
		const refuse = async (label: string, expectedReason: string, pages: unknown, extra?: Record<string, unknown>): Promise<boolean> => {
			const attempt = await call(ctx.base, ctx.token, "/docs/ingest", { dataset: "agent-substrate", pages, session_id: `${refusalSession}-${label}`, ...(extra ?? {}) });
			const body = shaped<IngestReply>(attempt.body);
			const ok = attempt.status === 400 && body?.ok === false && body?.refused === true && body?.reason === expectedReason;
			if (ok) refusedReasons.push(String(body?.reason));
			return ok;
		};
		const secretPage = [{ path: pagePath, source_url: pageUrl, body: `${pageBody}\noperator note ${secretLong} ${secretAlt}\n` }];
		const secretAttempt = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: secretPage, session_id: `${refusalSession}-secret` },
			INGEST_TIMEOUT_MS,
		);
		const secretBody = shaped<IngestReply>(secretAttempt.body);
		const secretRules = Array.isArray(secretBody?.rules) ? secretBody.rules.map(String) : [];
		const secretOk =
			secretAttempt.status === 400 &&
			secretBody?.ok === false &&
			secretBody?.refused === true &&
			secretBody?.reason === "secret-findings" &&
			secretRules.includes("openai-proj") &&
			secretRules.includes("anthropic") &&
			payloadHasNo(secretAttempt.raw, planted);
		if (secretOk) refusedReasons.push("secret-findings");
		check(secretOk, "refuse-secret", `rules=${String(secretRules.length)}`);
		const secretEvents = await querySessionEvents(ctx, `${refusalSession}-secret`);
		check(
			secretEvents.some((event) => event.kind === "warning") && payloadHasNo(JSON.stringify(secretEvents), planted),
			"refuse-secret-warning",
			`events=${String(secretEvents.length)}`,
		);
		check(await refuse("no-url", "no-source-url", [{ path: pagePath, body: pageBody }]), "refuse-no-source-url", `reasons=${String(refusedReasons.length)}`);
		check(await refuse("roots", "outside-roots", [{ path: `docs/../escape-${ctx.tag}.md`, source_url: pageUrl, body: pageBody }]), "refuse-outside-roots", `reasons=${String(refusedReasons.length)}`);
		check(await refuse("page-cap", "page-too-large", [{ path: pagePath, source_url: pageUrl, body: `x${"y".repeat(PAGE_MAX_BYTES)}` }]), "refuse-page-cap", `bytes=${String(PAGE_MAX_BYTES + 1)}`);
		const widePages = [1, 2, 3, 4, 5, 6].map((n) => ({ path: `docs/wide-${ctx.tag}-${n}.md`, source_url: `${pageUrl}-wide-${n}`, body: `z${"y".repeat(900_000)}` }));
		check(await refuse("call-cap", "call-too-large", widePages), "refuse-call-cap", `bytes~=${String(CALL_TARGET_BYTES)}`);
		const anonymous = await call(ctx.base, "", "/docs/ingest", { dataset: "agent-substrate", pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }] });
		check(anonymous.status === 401, "refuse-anonymous", `status=${String(anonymous.status)}`);
		check(await refuse("unknown-dataset", "unknown-dataset", [{ path: pagePath, source_url: pageUrl, body: pageBody }], { dataset: `no-such-dataset-${ctx.tag}` }), "refuse-unknown-dataset", `reasons=${String(refusedReasons.length)}`);
		check(await refuse("raw-id", "unknown-dataset", [{ path: pagePath, source_url: pageUrl, body: pageBody }], { dataset: "ds-berlin-agent-substrate" }), "refuse-raw-id-dataset", `reasons=${String(refusedReasons.length)}`);
		const countsAfterRefusals = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		check(
			baseline !== null &&
				countsAfterRefusals !== null &&
				countsAfterRefusals.uploads === baseline.uploads &&
				countsAfterRefusals.documents === baseline.documents,
			"refusals-upload-nothing",
			`uploads=${String(countsAfterRefusals?.uploads ?? -1)}`,
		);

		// (c) Route and caller payload limits: 1 byte over answers 413; MCP
		// refusals carry the expected reason and post nothing.
		const mcpBaseline = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		const over = await call(ctx.base, ctx.token, "/docs/ingest", {
			dataset: "agent-substrate",
			pages: [{ path: pagePath, source_url: pageUrl, body: `x${"y".repeat(ROUTE_MAX_BYTES)}` }],
			session_id: `${ctx.tag}-route-cap`,
		});
		check(over.status === 413, "refuse-route-cap", `status=${String(over.status)} bytes=${String(ROUTE_MAX_BYTES + 1)}`);
		const mcpBig = await toolCall(
			ctx.base,
			ctx.token,
			12,
			"docs_ingest",
			{ dataset: "agent-substrate", pages: [{ path: pagePath, source_url: pageUrl, body: `x${"y".repeat(PAGE_MAX_BYTES)}` }], session_id: `${ctx.tag}-mcp-cap` },
			INGEST_TIMEOUT_MS,
		);
		const mcpBigReason = mcpBig.value !== null && typeof mcpBig.value["reason"] === "string" ? String(mcpBig.value["reason"]) : "";
		check(mcpBig.protocolError === null && mcpBig.isError && mcpBigReason === "page-too-large", "mcp-refuse-page-cap", `reason=${mcpBigReason || "?"}`);
		// Anonymous over MCP is refused at the transport (401), never as a
		// tool payload: the whole door gates before any tool runs, so there
		// is no `value.reason` to assert — only the exact status plus zero
		// upstream counts. (The authenticated over-cap arm above stays a tool
		// refusal with reason `page-too-large`.)
		const mcpAnonBefore = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		const mcpAnonymous = await call(ctx.base, "", "/mcp", {
			jsonrpc: "2.0",
			id: 13,
			method: "tools/call",
			params: { name: "docs_ingest", arguments: { dataset: "agent-substrate", pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }], session_id: `${ctx.tag}-mcp-anon` } },
		});
		const mcpAnonAfter = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		check(mcpAnonymous.status === 401, "mcp-refuse-anonymous", `status=${String(mcpAnonymous.status)}`);
		check(
			mcpAnonBefore !== null && mcpAnonAfter !== null && mcpAnonAfter.uploads === mcpAnonBefore.uploads && mcpAnonAfter.documents === mcpAnonBefore.documents,
			"mcp-anon-posts-nothing",
			`uploads=${String(mcpAnonAfter?.uploads ?? -1)}`,
		);
		const mcpAfter = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body);
		check(
			mcpBaseline !== null && mcpAfter !== null && mcpAfter.uploads === mcpBaseline.uploads && mcpAfter.documents === mcpBaseline.documents,
			"mcp-refusals-post-nothing",
			`uploads=${String(mcpAfter?.uploads ?? -1)}`,
		);

		// (c) Remote images strip and count; malformed refresh refuses before anything stages.
		const imageBody = `${pageBody}\n<img src="https://example.com/i.png">\n\n![alt](https://example.com/j.png)\n`;
		const images = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: [{ path: `docs/images-${ctx.tag}.md`, source_url: `${pageUrl}-images`, body: imageBody }], session_id: `${ctx.tag}-images` },
			INGEST_TIMEOUT_MS,
		);
		const imagesBody = shaped<IngestReply>(images.body);
		check(images.status === 200 && imagesBody?.ok === true && typeof imagesBody?.stripped_images === "number" && imagesBody.stripped_images >= 2, "ingest-strip-images", `stripped=${String(imagesBody?.stripped_images ?? -1)}`);
		const badRefresh = await call(ctx.base, ctx.token, "/docs/ingest", {
			dataset: "agent-substrate",
			commit: "0".repeat(40),
			pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }],
			refresh: { id: "", part: 0, parts: 99, trigger: "bogus" },
			session_id: `${ctx.tag}-bad-refresh`,
		});
		const badRefreshBody = shaped<IngestReply>(badRefresh.body);
		check(badRefresh.status === 400 && badRefreshBody?.ok === false && badRefreshBody?.refused === true && badRefreshBody?.reason === "bad-refresh", "refuse-bad-refresh", `status=${String(badRefresh.status)}`);
		const needsCommit = await call(ctx.base, ctx.token, "/docs/ingest", {
			dataset: "agent-substrate",
			pages: [{ path: pagePath, source_url: pageUrl, body: pageBody }],
			refresh: { id: `smoke-${ctx.tag}`, part: 1, parts: 1, trigger: "repo-merge" },
			session_id: `${ctx.tag}-needs-commit`,
		});
		const needsCommitBody = shaped<IngestReply>(needsCommit.body);
		check(
			needsCommit.status === 400 && needsCommitBody?.ok === false && needsCommitBody?.refused === true && needsCommitBody?.reason === "refresh-needs-commit",
			"refuse-refresh-no-commit",
			`status=${String(needsCommit.status)}`,
		);

		// (d) Real CLI against a fresh committed scratch repo. The child gets
		// an owned private HOME, an explicitly empty tokens dir (so a missing
		// token can never fall back to /etc or the operator's files), and no
		// VM-guest flag unless the arm says so; git runs with a minimal
		// allowlist env. Flags match the CLI USAGE exactly
		// (ingest --dataset/--path/--source-url/--commit/--heading/--session;
		// refresh --dataset/--commit/--dir/--session).
		const runRoot = mkdtempSync(join(tmpdir(), "docs-smoke-"));
		chmodSync(runRoot, 0o700);
		const scratch = join(runRoot, "repo");
		const envHome = join(runRoot, "home");
		const tokensDir = join(runRoot, "tokens");
		mkdirSync(scratch, { recursive: true });
		mkdirSync(envHome, { recursive: true, mode: 0o700 });
		mkdirSync(tokensDir, { recursive: true, mode: 0o700 });
		try {
			const repoFile = `docs/smoke-${ctx.tag}.md`;
			const untrackedFile = `docs/untracked-${ctx.tag}.md`;
			const untrackedMarker = `smoke-untracked-${ctx.tag}`;
			const dirtyMarker = `smoke-dirty-${ctx.tag}`;
			const committedProse = `# Smoke ${ctx.tag}\n\nCommitted prose for the CLI arms. ${marker} cli.\n`;
			mkdirSync(join(scratch, "docs"), { recursive: true });
			writeFileSync(join(scratch, repoFile), committedProse);
			writeFileSync(join(scratch, "README.md"), `# Smoke repo ${ctx.tag}\n`);
			const baseCliEnv: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: envHome,
				SUBSTRATE_URL: ctx.base,
				SUBSTRATE_TOKEN: ctx.token,
				SUBSTRATE_TOKEN_FILE: "",
				SUBSTRATE_TOKENS_DIR: tokensDir,
				SUBSTRATE_VM_GUEST: "0",
				SUBSTRATE_DOCS_TIMEOUT_MS: String(INGEST_TIMEOUT_MS),
			};
			const gitEnv: Record<string, string> = {
				PATH: baseCliEnv["PATH"] ?? "/usr/bin:/bin",
				HOME: envHome,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			};
			check(git(scratch, ["init"], gitEnv).code === 0, "scratch-git-init", "repo");
			git(scratch, ["config", "user.email", "smoke@example.com"], gitEnv);
			git(scratch, ["config", "user.name", "docs smoke"], gitEnv);
			git(scratch, ["config", "commit.gpgsign", "false"], gitEnv);
			check(git(scratch, ["add", "."], gitEnv).code === 0, "scratch-git-add", "staged");
			const committed = git(scratch, ["-c", "user.email=smoke@example.com", "-c", "user.name=docs smoke", "-c", "commit.gpgsign=false", "commit", "-m", `smoke ${ctx.tag}`], gitEnv);
			check(committed.code === 0, "scratch-git-commit", "committed");
			const sha = git(scratch, ["rev-parse", "HEAD"], gitEnv).stdout.trim();
			check(/^[0-9a-f]{40}$/.test(sha), "scratch-commit-sha", `sha=${sha.slice(0, 12)}`);
			const cliSession = `${ctx.tag}-cli`;
			const cliOnce = await runCli(
				ctx.checkout,
				["docs", "ingest", "--dataset", "agent-substrate", "--path", repoFile, "--source-url", `https://example.com/cli/${ctx.tag}`, "--commit", sha, "--heading", "Smoke", "--session", cliSession],
				baseCliEnv,
				scratch,
			);
			const cliFields = parseKeyValues(cliOnce.out);
			const cliStatus = cliFields["status"]?.[0];
			const cliDocId = cliFields["document_id"]?.[0] ?? "";
			check(!cliOnce.timedOut && cliOnce.code === 0 && cliStatus === "ingested" && cliDocId !== "", "cli-ingest", `exit=${String(cliOnce.code)} status=${cliStatus ?? "?"}`);
			const cliTwice = await runCli(
				ctx.checkout,
				["docs", "ingest", "--dataset", "agent-substrate", "--path", repoFile, "--source-url", `https://example.com/cli/${ctx.tag}`, "--commit", sha, "--heading", "Smoke", "--session", cliSession],
				baseCliEnv,
				scratch,
			);
			check(!cliTwice.timedOut && parseKeyValues(cliTwice.out)["status"]?.[0] === "unchanged", "cli-ingest-idempotent", `exit=${String(cliTwice.code)}`);
			// The committed ingest promotes exactly one generation carrying this call.
			const versionEvents = await querySessionEvents(ctx, cliSession);
			const versionNote = versionEvents.find((event) => event.kind === "note" && typeof event.payload?.["version"] === "string" && event.payload?.["commit"] === sha);
			const cliVersion = typeof versionNote?.payload?.["version"] === "string" ? String(versionNote.payload["version"]) : "";
			check(versionNote !== undefined && /^v\d+$/.test(cliVersion) && typeof versionNote?.payload?.["dataset_id"] === "string", "ingest-version-pin", `events=${String(versionEvents.length)}`);

			// The pin cites the promoted commit for the promoted document and
			// names the gap for everything else — a false pin or a false gap
			// both fail here.
			const pinSearch = await call(ctx.base, ctx.token, "/docs/search", { question: "smoke", datasets: ["agent-substrate"], session_id: `${ctx.tag}-pin` });
			const pinChunks = citationsOf(pinSearch.body);
			const cliChunk = (pinChunks ?? []).find((chunk) => chunk.document_id === cliDocId);
			const cleanChunk = cleanDocId !== "" ? (pinChunks ?? []).find((chunk) => chunk.document_id === cleanDocId) : undefined;
			check(pinSearch.status === 200 && cliChunk !== undefined && cliChunk.commit === sha, "pin-cites-promoted", `commit=${String(cliChunk?.commit ?? "?").slice(0, 12)}`);
			check(cleanChunk !== undefined && isPinGap(cleanChunk.commit), "stale-cites-gap", `commit=${String(cleanChunk?.commit ?? "?").slice(0, 24)}`);

			// CLI refusals post nothing: no token (the empty tokens dir proves
			// no fallback bearer exists), a VM guest (the canonical sixth
			// refusal), and an over-cap file under docs/ so only the size
			// gate can fire.
			const cliUploadsBefore = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body)?.uploads ?? -1;
			const noToken = await runCli(
				ctx.checkout,
				["docs", "ingest", "--dataset", "agent-substrate", "--path", repoFile, "--source-url", `https://example.com/cli/${ctx.tag}`, "--session", cliSession],
				{ ...baseCliEnv, SUBSTRATE_TOKEN: "" },
				scratch,
			);
			check(
				!noToken.timedOut && noToken.code !== 0 && parseKeyValues(noToken.out)["status"]?.[0] === "refused" && noToken.err.includes("no bearer is configured"),
				"cli-refuse-no-token",
				`exit=${String(noToken.code)}`,
			);
			const guest = await runCli(
				ctx.checkout,
				["docs", "ingest", "--dataset", "agent-substrate", "--path", repoFile, "--source-url", `https://example.com/cli/${ctx.tag}`, "--session", cliSession],
				{ ...baseCliEnv, SUBSTRATE_VM_GUEST: "1" },
				scratch,
			);
			check(
				!guest.timedOut && guest.code !== 0 && parseKeyValues(guest.out)["status"]?.[0] === "refused" && guest.err.includes("VM guest"),
				"cli-refuse-vm-guest",
				`exit=${String(guest.code)}`,
			);
			writeFileSync(join(scratch, "docs", `big-${ctx.tag}.md`), `x${"y".repeat(PAGE_MAX_BYTES)}`);
			const bigCli = await runCli(
				ctx.checkout,
				["docs", "ingest", "--dataset", "agent-substrate", "--path", `docs/big-${ctx.tag}.md`, "--source-url", `https://example.com/cli/${ctx.tag}-big`, "--session", cliSession],
				baseCliEnv,
				scratch,
			);
			check(
				!bigCli.timedOut && bigCli.code !== 0 && parseKeyValues(bigCli.out)["status"]?.[0] === "refused" && bigCli.err.includes("over the limit"),
				"cli-refuse-page-cap",
				`exit=${String(bigCli.code)} bytes=${String(PAGE_MAX_BYTES + 1)}`,
			);
			rmSync(join(scratch, "docs", `big-${ctx.tag}.md`), { force: true });
			const cliUploadsAfter = parseFixtureCounts((await fixtureCall(ctx.fixtureUrl, "/__fixture/counts")).body)?.uploads ?? -2;
			check(cliUploadsAfter === cliUploadsBefore, "cli-refusals-post-nothing", `uploads=${String(cliUploadsAfter)}`);

			// (d) The actual multipart producer: refresh posts committed bytes
			// only. Dirty working-tree bytes and untracked files stay home:
			// with both present the refresh still stores exactly the two
			// committed pages, and neither marker is served afterwards.
			writeFileSync(join(scratch, untrackedFile), `# Untracked ${ctx.tag}\n\n${untrackedMarker} must never be posted.\n`);
			writeFileSync(join(scratch, repoFile), `${committedProse}\n${dirtyMarker} must never be posted.\n`);
			const refreshSession = `${ctx.tag}-refresh`;
			const refreshedDirty = await runCli(
				ctx.checkout,
				["docs", "refresh", "--dataset", "agent-substrate", "--commit", sha, "--dir", ".", "--session", refreshSession],
				baseCliEnv,
				scratch,
			);
			const dirtyFields = parseKeyValues(refreshedDirty.out);
			check(
				!refreshedDirty.timedOut && refreshedDirty.code === 0 && dirtyFields["status"]?.[0] === "stored" && dirtyFields["pages"]?.[0] === "2" && dirtyFields["calls"]?.[0] === "1",
				"cli-refresh-committed-only",
				`exit=${String(refreshedDirty.code)} pages=${dirtyFields["pages"]?.[0] ?? "?"}`,
			);
			const dirtySearch = await call(ctx.base, ctx.token, "/docs/search", { question: "smoke", datasets: ["agent-substrate"], session_id: `${ctx.tag}-dirty` });
			const dirtyRaw = JSON.stringify(citationsOf(dirtySearch.body) ?? []);
			check(!dirtyRaw.includes(untrackedMarker) && !dirtyRaw.includes(dirtyMarker), "refresh-ignores-untracked", "markers-absent");

			// A second commit promotes a second generation; the pin then cites
			// the new commit for the refreshed corpus while the superseded
			// CLI document honestly names the gap. The new generation carries
			// its own controlled marker, so the pin arm selects the new corpus
			// by identity (source URL plus new prose) and only then asserts the
			// promoted commit — never a find-where-commit-matches tautology.
			// The previously-dirty and untracked bytes commit here too, so
			// serving them afterwards proves the pipe serves committed bytes
			// (making the earlier absence meaningful, not a top-10 artifact).
			const secondMarker = `smoke-second-${ctx.tag}`;
			writeFileSync(join(scratch, repoFile), `${committedProse}\n${dirtyMarker} now committed.\n${secondMarker} new corpus.\n`);
			git(scratch, ["add", "."], gitEnv);
			const committed2 = git(scratch, ["-c", "user.email=smoke@example.com", "-c", "user.name=docs smoke", "-c", "commit.gpgsign=false", "commit", "-m", `smoke ${ctx.tag} second`], gitEnv);
			check(committed2.code === 0, "scratch-git-commit-second", "committed");
			const sha2 = git(scratch, ["rev-parse", "HEAD"], gitEnv).stdout.trim();
			check(/^[0-9a-f]{40}$/.test(sha2) && sha2 !== sha, "scratch-commit-sha-second", `sha=${sha2.slice(0, 12)}`);
			const refreshSession2 = `${ctx.tag}-refresh-second`;
			const refreshed = await runCli(
				ctx.checkout,
				["docs", "refresh", "--dataset", "agent-substrate", "--commit", sha2, "--dir", ".", "--session", refreshSession2],
				baseCliEnv,
				scratch,
			);
			const refreshFields = parseKeyValues(refreshed.out);
			check(
				!refreshed.timedOut &&
					refreshed.code === 0 &&
					refreshFields["status"]?.[0] === "stored" &&
					Number(refreshFields["pages"]?.[0] ?? "0") >= 1 &&
					Number(refreshFields["calls"]?.[0] ?? "0") >= 1,
				"cli-refresh",
				`exit=${String(refreshed.code)} pages=${refreshFields["pages"]?.[0] ?? "?"} calls=${refreshFields["calls"]?.[0] ?? "?"}`,
			);
			const refreshEvents = await querySessionEvents(ctx, refreshSession2);
			const refreshNote = refreshEvents.find((event) => event.kind === "note" && typeof event.payload?.["version"] === "string" && event.payload?.["commit"] === sha2);
			const refreshVersion = typeof refreshNote?.payload?.["version"] === "string" ? String(refreshNote.payload["version"]) : "";
			check(
				refreshNote !== undefined && /^v\d+$/.test(refreshVersion) && refreshVersion !== cliVersion && typeof refreshNote?.payload?.["dataset_id"] === "string",
				"refresh-version-pin",
				`events=${String(refreshEvents.length)}`,
			);
			const pinSearch2 = await call(ctx.base, ctx.token, "/docs/search", { question: "smoke", datasets: ["agent-substrate"], session_id: `${ctx.tag}-pin-second` });
			const pinChunks2 = citationsOf(pinSearch2.body);
			const pinRaw2 = JSON.stringify(pinChunks2 ?? []);
			// Identity first (source URL plus the second generation's own
			// prose), commit second: the older upload shares the source URL,
			// so a bare source-URL find selects the superseded chunk.
			const refreshedChunk = (pinChunks2 ?? []).find(
				(chunk) => String(chunk.source_url) === `agent-substrate://${repoFile}` && JSON.stringify(chunk).includes(secondMarker),
			);
			const oldCliChunk = cliDocId !== "" ? (pinChunks2 ?? []).find((chunk) => chunk.document_id === cliDocId) : undefined;
			check(
				pinSearch2.status === 200 &&
					refreshedChunk !== undefined &&
					refreshedChunk.commit === sha2 &&
					String(refreshedChunk.document_id) !== cliDocId,
				"refresh-cites-promoted",
				`commit=${String(refreshedChunk?.commit ?? "?").slice(0, 12)}`,
			);
			check(oldCliChunk !== undefined && isPinGap(oldCliChunk.commit), "superseded-cites-gap", `commit=${String(oldCliChunk?.commit ?? "?").slice(0, 24)}`);
			// The newly committed bytes are served now (second marker, the
			// ex-dirty line, the ex-untracked file): the pipe serves
			// committed bytes, which is what makes the earlier absence proof.
			check(pinRaw2.includes(secondMarker) && pinRaw2.includes(dirtyMarker) && pinRaw2.includes(untrackedMarker), "refresh-serves-committed", "new-corpus-served");
			// Seeds are never ingested, so no pin manifest can ever name them:
			// every served seed must still name the gap after promotion.
			const lateSeeds = (pinChunks2 ?? []).filter((chunk) => typeof chunk.document_id === "string" && chunk.document_id.startsWith("seed-"));
			check(lateSeeds.length > 0 && lateSeeds.every((chunk) => isPinGap(chunk.commit)), "seeds-cite-gap", `count=${String(lateSeeds.length)}`);
			// The same commit never mints a second generation: re-running the
			// refresh posts identical bytes (idempotent, nothing new staged),
			// so the version set for sha2 is unchanged afterwards.
			const refreshAgain = await runCli(
				ctx.checkout,
				["docs", "refresh", "--dataset", "agent-substrate", "--commit", sha2, "--dir", ".", "--session", refreshSession2],
				baseCliEnv,
				scratch,
			);
			const versionsOf = (events: LedgerEvent[]): string[] => {
				const versions: string[] = [];
				for (const event of events) {
					if (event.kind === "note" && event.payload?.["commit"] === sha2 && typeof event.payload?.["version"] === "string") {
						const version = String(event.payload["version"]);
						if (!versions.includes(version)) versions.push(version);
					}
				}
				return versions.sort();
			};
			const versionsBefore = versionsOf(refreshEvents);
			const versionsAfter = versionsOf(await querySessionEvents(ctx, refreshSession2));
			check(
				!refreshAgain.timedOut && refreshAgain.code === 0 && versionsAfter.length === versionsBefore.length && versionsAfter.every((version) => versionsBefore.includes(version)),
				"refresh-same-commit-no-second-generation",
				`exit=${String(refreshAgain.code)} versions=${String(versionsAfter.length)}`,
			);
			// (f) Multipart retention on the live refresh door: a third real
			// commit labels the parts while only part 1 of 2 is staged, so
			// the old pin (sha2, same document) must stay exact; a failed
			// part (secret body) and a conflicting re-post (same part, new
			// bytes) each refuse and likewise keep the old pin.
			const partFile = `docs/part-${ctx.tag}.md`;
			const partMarker = `smoke-part-${ctx.tag}`;
			const partBody = `# Part ${ctx.tag}\n\n${partMarker} staged corpus.\n`;
			const partUrl = `agent-substrate://${partFile}`;
			writeFileSync(join(scratch, partFile), partBody);
			git(scratch, ["add", partFile], gitEnv);
			const committed3 = git(scratch, ["-c", "user.email=smoke@example.com", "-c", "user.name=docs smoke", "-c", "commit.gpgsign=false", "commit", "-m", `smoke ${ctx.tag} part`], gitEnv);
			const sha3 = git(scratch, ["rev-parse", "HEAD"], gitEnv).stdout.trim();
			check(committed3.code === 0 && /^[0-9a-f]{40}$/.test(sha3) && sha3 !== sha2, "multipart-git-commit", `sha=${sha3.slice(0, 12)}`);
			const mpId = `smoke-multipart-${ctx.tag}`;
			const mpSession = `${ctx.tag}-multipart`;
			const mpMeta = { id: mpId, part: 1, parts: 2, trigger: "repo-merge" };
			const mpPart = [{ path: partFile, source_url: partUrl, body: partBody }];
			const fpSearch = async (session: string): Promise<{ commit: string; docId: string }> => {
				const found = await call(ctx.base, ctx.token, "/docs/search", { question: "smoke", datasets: ["agent-substrate"], session_id: session });
				const pin = (citationsOf(found.body) ?? []).find(
					(entry) => String(entry.source_url) === `agent-substrate://${repoFile}` && JSON.stringify(entry).includes(secondMarker),
				);
				return { commit: String(pin?.commit ?? ""), docId: String(pin?.document_id ?? "") };
			};
			const staged1 = await call(ctx.base, ctx.token, "/docs/ingest", { dataset: "agent-substrate", commit: sha3, pages: mpPart, refresh: mpMeta, session_id: mpSession }, INGEST_TIMEOUT_MS);
			const staged1Body = shaped<IngestReply>(staged1.body);
			const staged1Doc = typeof staged1Body?.results?.[0]?.document_id === "string" ? String(staged1Body?.results?.[0]?.document_id) : "";
			const mpEvents = await querySessionEvents(ctx, mpSession);
			const mpVersions = mpEvents.filter((event) => event.kind === "note" && event.payload?.["commit"] === sha3 && typeof event.payload?.["version"] === "string");
			const fp1 = await fpSearch(`${ctx.tag}-multipart-fp-1`);
			const promotedDocId = fp1.docId;
			check(
				staged1.status === 200 && staged1Body?.ok === true && staged1Doc !== "" && mpVersions.length === 0 && fp1.commit === sha2 && promotedDocId !== "" && promotedDocId !== cliDocId,
				"multipart-part1-staged-keeps-pin",
				`versions=${String(mpVersions.length)} commit=${fp1.commit.slice(0, 12)}`,
			);
			const secretMp = await call(
				ctx.base,
				ctx.token,
				"/docs/ingest",
				{ dataset: "agent-substrate", commit: sha3, pages: [{ path: partFile, source_url: partUrl, body: `${partBody}\noperator note ${secretLong} ${secretAlt}\n` }], refresh: { ...mpMeta, part: 2 }, session_id: mpSession },
				INGEST_TIMEOUT_MS,
			);
			const secretMpBody = shaped<IngestReply>(secretMp.body);
			const fp2 = await fpSearch(`${ctx.tag}-multipart-fp-2`);
			check(
				secretMp.status === 400 && secretMpBody?.ok === false && secretMpBody?.refused === true && secretMpBody?.reason === "secret-findings" && payloadHasNo(secretMp.raw, planted) && fp2.commit === sha2 && fp2.docId === promotedDocId,
				"multipart-failed-part-keeps-pin",
				`commit=${fp2.commit.slice(0, 12)}`,
			);
			const conflictMp = await call(
				ctx.base,
				ctx.token,
				"/docs/ingest",
				{ dataset: "agent-substrate", commit: sha3, pages: [{ path: partFile, source_url: partUrl, body: `${partBody}\nconflicting bytes\n` }], refresh: mpMeta, session_id: mpSession },
				INGEST_TIMEOUT_MS,
			);
			const conflictMpBody = shaped<IngestReply>(conflictMp.body);
			const fp3 = await fpSearch(`${ctx.tag}-multipart-fp-3`);
			check(
				conflictMp.status === 400 && conflictMpBody?.ok === false && conflictMpBody?.refused === true && conflictMpBody?.reason === "refresh-part-changed" && fp3.commit === sha2 && fp3.docId === promotedDocId,
				"multipart-conflicting-part-refused",
				`commit=${fp3.commit.slice(0, 12)}`,
			);
			// (d) Last-five retention on a second dataset: six real commits,
			// each with a single-file committed refresh, promote v1..v6 on
			// programming-desk (whose small pool keeps the latest served)
			// while agent-substrate's capped top-10 stays untouched. The
			// bound own-state file must then hold exactly the last five.
			const seqFile = `docs/seq-${ctx.tag}.md`;
			const seqUrl = `programming-desk://${seqFile}`;
			const seqShas: string[] = [];
			for (let seq = 1; seq <= 6; seq += 1) {
				writeFileSync(join(scratch, seqFile), `# Series ${seq} ${ctx.tag}\n\nsmoke-seq-${seq}-${ctx.tag} series corpus.\n`);
				git(scratch, ["add", seqFile], gitEnv);
				const seqCommitted = git(scratch, ["-c", "user.email=smoke@example.com", "-c", "user.name=docs smoke", "-c", "commit.gpgsign=false", "commit", "-m", `smoke ${ctx.tag} seq ${seq}`], gitEnv);
				const seqSha = git(scratch, ["rev-parse", "HEAD"], gitEnv).stdout.trim();
				seqShas.push(seqSha);
				const seqRefreshed = await runCli(
					ctx.checkout,
					["docs", "refresh", "--dataset", "programming-desk", "--commit", seqSha, "--dir", ".", "--roots", seqFile, "--session", `${ctx.tag}-seq-${seq}`],
					baseCliEnv,
					scratch,
				);
				const seqFields = parseKeyValues(seqRefreshed.out);
				check(
					!seqRefreshed.timedOut && seqCommitted.code === 0 && seqRefreshed.code === 0 && seqFields["status"]?.[0] === "stored" && seqFields["pages"]?.[0] === "1" && seqFields["calls"]?.[0] === "1",
					`seq-refresh-${seq}`,
					`exit=${String(seqRefreshed.code)} commit=${seqSha.slice(0, 12)}`,
				);
			}
			// (g) Skills-sync-not-live on its own dataset: an ordinary pinned
			// ingest (never a skills-sync trigger, which alone flips the unit
			// live) promotes a pin that keeps serving degraded — citations
			// carry the pin commit plus a pin age, with exactly one warning
			// across a repeated search.
			const skillMarker = `smoke-skill-${ctx.tag}`;
			const skillCommit = seqShas[seqShas.length - 1] ?? sha3;
			const skillSession = `${ctx.tag}-skill`;
			const skilled = await call(
				ctx.base,
				ctx.token,
				"/docs/ingest",
				{ dataset: "agent-skills", commit: skillCommit, pages: [{ path: `docs/skill-${ctx.tag}.md`, source_url: `https://example.com/skill/${ctx.tag}`, body: `# Skill ${ctx.tag}\n\n${skillMarker} corpus.\n` }], session_id: skillSession },
				INGEST_TIMEOUT_MS,
			);
			const skilledBody = shaped<IngestReply>(skilled.body);
			const skillDocRaw = skilledBody?.results?.[0]?.document_id;
			const skillDocId = typeof skillDocRaw === "string" ? skillDocRaw : "";
			check(skilled.status === 200 && skilledBody?.ok === true && skillDocId !== "", "skills-ingest-pinned", `status=${String(skilled.status)}`);
			const skillCited = (chunks: Citation[] | null): boolean =>
				chunks !== null &&
				chunks.length >= 1 &&
				chunks.every((chunk) => {
					const age = shaped<{ pin_age_ms?: unknown }>(chunk)?.pin_age_ms;
					return chunk.commit === skillCommit && citationShapeOk(chunk) && typeof age === "number" && age >= 0;
				});
			const skillSearch1 = await call(ctx.base, ctx.token, "/docs/search", { question: "how do skills sync", datasets: ["agent-skills"], session_id: `${ctx.tag}-skill-search-1` });
			const skillChunks1 = citationsOf(skillSearch1.body);
			const skillHit1 = (skillChunks1 ?? []).some((chunk) => chunk.document_id === skillDocId);
			check(skillSearch1.status === 200 && skillCited(skillChunks1) && skillHit1, "skills-serve-degraded", `count=${String(skillChunks1?.length ?? -1)}`);
			const skillSearch2 = await call(ctx.base, ctx.token, "/docs/search", { question: "how do skills sync", datasets: ["agent-skills"], session_id: `${ctx.tag}-skill-search-2` });
			const skillChunks2 = citationsOf(skillSearch2.body);
			const skillEvents1 = await querySessionEvents(ctx, `${ctx.tag}-skill-search-1`);
			const skillEvents2 = await querySessionEvents(ctx, `${ctx.tag}-skill-search-2`);
			const skillWarnings = [...skillEvents1, ...skillEvents2].filter((event) => event.kind === "warning" && shaped<Record<string, unknown>>(event.payload)?.["reason"] === "skills-sync-not-live");
			check(skillSearch2.status === 200 && skillCited(skillChunks2) && skillWarnings.length === 1, "skills-warn-once", `warnings=${String(skillWarnings.length)}`);
			// Bound own-state evidence over the backend locator
			// (fixture-only, hashes and ids, never keys): the twin persists
			// hashes and pins to runDir/docs-state.json. A missing or
			// misshapen file fails here, never silently.
			const locatorRecord = parseShellExports(readText(join(runDir, "consumer.env")) ?? "");
			const docsStateLocator = locatorRecord["SUBSTRATE_REHEARSAL_DOCS_STATE_FILE"] ?? "";
			const insideRun = docsStateLocator.startsWith(`${runDir}/`) && !docsStateLocator.includes("..");
			const docsStateRaw = insideRun ? readText(docsStateLocator) : null;
			let docsStateJson: unknown = null;
			try {
				docsStateJson = docsStateRaw === null ? null : JSON.parse(docsStateRaw);
			} catch {
				docsStateJson = null;
			}
			const docsStateVersions = docsStateJson === null ? null : stateVersionsOf(docsStateJson);
			const seqRows = docsStateVersions?.["programming-desk"] ?? null;
			const expectedPairs = seqShas.map((sha, index) => `v${index + 1}:${sha}`);
			const actualPairs = (seqRows ?? []).map((row) => `${row.version}:${row.commit}`);
			const syncRec = shaped<Record<string, unknown>>(shaped<{ sync?: unknown }>(docsStateJson)?.sync ?? null);
			const latestSeqRow = seqRows === null || seqRows.length === 0 ? null : (seqRows[seqRows.length - 1] ?? null);
			check(
				insideRun && docsStateVersions !== null && seqRows !== null && seqRows.length === 5 && JSON.stringify(actualPairs) === JSON.stringify(expectedPairs.slice(-5)) && syncRec?.["fastForwardObserved"] === false && syncRec?.["notLiveWarned"] === true,
				"last-five-manifest-exact",
				`rows=${String(seqRows?.length ?? -1)} latest=${String(latestSeqRow?.version ?? "?")}`,
			);
			const seqLast = seqShas[seqShas.length - 1] ?? "";
			const seqLastMarker = `smoke-seq-6-${ctx.tag}`;
			const pinSeq = await call(ctx.base, ctx.token, "/docs/search", { question: "series corpus", datasets: ["programming-desk"], session_id: `${ctx.tag}-pin-seq` });
			const pinSeqChunks = citationsOf(pinSeq.body);
			const seqChunk = (pinSeqChunks ?? []).find((entry) => String(entry.source_url) === seqUrl && JSON.stringify(entry).includes(seqLastMarker));
			check(pinSeq.status === 200 && seqChunk !== undefined && seqChunk.commit === seqLast, "last-five-current-pin", `commit=${String(seqChunk?.commit ?? "?").slice(0, 12)}`);
			const servedDocId = String(seqChunk?.document_id ?? "");
			const manifestHit = latestSeqRow?.documents.some((doc) => doc.source_url === seqUrl && doc.document_id === servedDocId && servedDocId !== "") === true;
			check(seqChunk !== undefined && manifestHit, "last-five-manifest-docids", "state-matches-served");
		} finally {
			// The owned temp root (repo, private home, empty tokens dir) goes
			// away without touching results: cleanup never fails the proof,
			// and never suppresses it either.
			try {
				rmSync(runRoot, { recursive: true, force: true });
			} catch {
				// Best effort; the check below reports it.
			}
			let gone = false;
			try {
				readFileSync(join(scratch, "README.md"), "utf8");
			} catch {
				gone = true;
			}
			check(gone, "scratch-cleanup", "removed");
		}

		// (e) Parse arm: a stand-in that never finishes parsing refuses loudly, then recovers.
		await fixtureCall(ctx.fixtureUrl, "/__fixture/parse", { behavior: "never" });
		const stuck = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: [{ path: `docs/stuck-${ctx.tag}.md`, source_url: `${pageUrl}-stuck`, body: pageBody }], session_id: `${ctx.tag}-stuck` },
			INGEST_TIMEOUT_MS,
		);
		const stuckBody = shaped<IngestReply>(stuck.body);
		check(stuck.status === 400 && stuckBody?.ok === false && stuckBody?.refused === true && stuckBody?.reason === "parse-timeout", "ingest-parse-timeout", `status=${String(stuck.status)}`);
		await fixtureCall(ctx.fixtureUrl, "/__fixture/parse", { behavior: "done" });
		const unblocked = await call(
			ctx.base,
			ctx.token,
			"/docs/ingest",
			{ dataset: "agent-substrate", pages: [{ path: `docs/stuck-${ctx.tag}.md`, source_url: `${pageUrl}-stuck`, body: pageBody }], session_id: `${ctx.tag}-unblocked` },
			INGEST_TIMEOUT_MS,
		);
		check(unblocked.status === 200 && shaped<IngestReply>(unblocked.body)?.ok === true, "ingest-parse-recovered", `status=${String(unblocked.status)}`);

		// Every citation seen still cites a pin or names the gap — never a false current.
		// Pool stays over ten (8 uploads plus 20 seeds), so ten served keeps proving the cap.
		const after = await call(ctx.base, ctx.token, "/docs/search", { question: "smoke", datasets: ["agent-substrate"], session_id: `${ctx.tag}-after` });
		const afterChunks = citationsOf(after.body);
		check(
			after.status === 200 && afterChunks !== null && afterChunks.length === 10 && afterChunks.every(citationShapeOk),
			"pin-truthful-after",
			`count=${String(afterChunks?.length ?? -1)}`,
		);

		const passed = results.filter(Boolean).length;
		process.stdout.write(`\n${passed}/${results.length} docs smoke checks passed\n`);
		process.stdout.write("[docs-smoke] scope: stand-in proof only; live G1-G4 stay operator-gated to a human MODEL on the real plane, and server-side vm-guest over REST stays a whole-process config door limit (client side proved via the CLI preflight).\n");
		return passed === results.length ? 0 : 1;
	} finally {
		// Injected fixture controls never leak to the next run: clear them on
		// every path without resetting (which would wipe upload accounting).
		// Cleanup reports nothing and changes no verdict.
		try {
			await fixtureCall(ctx.fixtureUrl, "/__fixture/fail-retrieval", { status: null });
		} catch {
			// Best effort on a teardown path.
		}
		try {
			await fixtureCall(ctx.fixtureUrl, "/__fixture/parse", { behavior: "done" });
		} catch {
			// Best effort on a teardown path.
		}
	}
}

async function main(argv: string[]): Promise<number> {
	const { name } = parseDocsSmokeArgs(argv);
	const runDir = runDirFor(name);
	// This checkout, not the recorded one: the binding refuses when they differ.
	const scriptCheckout = realpathSync(join(import.meta.dir, ".."));
	return await withNameLock(runDir, name, () => runSmokeInner(name, runDir, scriptCheckout));
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((cause) => {
			if (cause instanceof SmokeRefused) {
				process.stderr.write(`[docs-smoke] refused: ${cause.message}.\n`);
				process.exit(2);
			}
			const name = cause instanceof Error ? cause.constructor.name : typeof cause;
			process.stderr.write(`[docs-smoke] failed: ${name}.\n`);
			process.exit(1);
		});
}
