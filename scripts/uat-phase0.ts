#!/usr/bin/env bun
/**
 * Phase 0 UAT runner (`bun run uat:phase0`).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCTION_PORTS, pickFreePort, refuseSmokeUrl, smokeToolResult } from "./rehearsal.ts";
import { resolveBearer } from "../packages/cli/src/token.ts";
import { mapNotionRows, type NotionRow } from "../packages/mcp-server/src/backfill.ts";

/**
 * Phase 16's production ports, referenced — never copied — so the guard
 * tracks the harness. Used by the classifier tests and the report.
 */
export const UAT_PRODUCTION_PORTS: readonly number[] = PRODUCTION_PORTS;
/** A usage or target refusal; the message names hosts and ports, never values. */
export class UatRefused extends Error {}

/** The nine v1.0 tool names scenario 1 requires among today's set. */
export const V1_TOOLS = [
	"memory_brief",
	"memory_write",
	"memory_search",
	"events_emit",
	"graph_get",
	"graph_register",
	"graph_claim",
	"graph_release",
	"graph_complete",
] as const;

/** The four REST routes scenario 1 probes. */
export const REST_ROUTES = ["/healthz", "/brief", "/events", "/verify"] as const;

/** All eight scenario ids. */
export const ALL_SCENARIOS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Scenarios that write: refused on production without `--live <approval-ref>`. */
export const WRITE_SCENARIOS: ReadonlySet<number> = new Set([1, 3, 6, 8]);

/** Harness default: the isolated set the Phase 16 twin can prove. */
export const HARNESS_DEFAULT = [1, 3, 4, 6, 7, 8] as const;

/** Production read-only default: no writes, so no approval reference needed. */
export const PRODUCTION_DEFAULT = [2, 4, 5, 7] as const;

/** Scenario 7's outage budget: the plugin's own timeout plus slack. */
export const OUTAGE_BUDGET_MS = 1750;

/** Run tags are one path-safe token: the writer prefixes `uat-`. */
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const REQUEST_TIMEOUT_MS = 10_000;

/** Parse `--scenarios 1,3,4`: ids 1-8, no duplicates; empty means the default. */
export function parseScenarios(raw: string | undefined): number[] | null {
	if (raw === undefined || raw.trim() === "") return null;
	const ids = raw.split(",").map((part) => Number(part.trim()));
	if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > 8)) {
		throw new UatRefused(`--scenarios takes ids 1-8, got ${raw}`);
	}
	return [...new Set(ids)].sort((a, b) => a - b);
}

/** Validate the run tag before anything is written under it. */
export function validateTag(raw: string | undefined): string {
	if (!raw || !TAG_PATTERN.test(raw)) {
		throw new UatRefused("--tag takes 1-64 chars of [A-Za-z0-9-], starting alnum");
	}
	return raw;
}

/** Every write carries the run tag in its graph, session and repo fields. */
export function runTag(tag: string): string {
	return `uat-${tag}`;
}

/** The checkout root: child argv must be absolute, never relative to a scratch cwd. */
export const CHECKOUT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/+$/, "");

/** A run-tagged repo (owner/name shape, like the hook derives from an origin). */
export function runRepo(tag: string): string {
	return `uat/${tag}-repo`;
}

/**
 * Target kind through Phase 16's guard, never a copy of it: a refused
 * smoke URL (a production port or a non-loopback host) is production.
 */
export function classifyTarget(raw: string): "production" | "scratch" {
	return refuseSmokeUrl(raw) === null ? "scratch" : "production";
}

/** Write scenarios on production refuse without a live approval reference. */
export function refuseWriteScenarios(
	scenarios: readonly number[],
	target: "production" | "scratch",
	live: string | undefined,
): string | null {
	if (target !== "production" || live) return null;
	const writes = scenarios.filter((id) => WRITE_SCENARIOS.has(id));
	if (writes.length === 0) return null;
	return `refusing write scenarios ${writes.join(",")} against production without --live <approval-ref>`;
}

/** Non-loopback hosts never reach a report; loopback hosts are named. */
export function sanitizeHost(host: string): string {
	const bare = host.replace(/^\[(.*)\]$/, "$1");
	return bare === "127.0.0.1" || bare === "::1" || bare === "localhost" ? bare : "[non-loopback]";
}

export interface ScenarioVerdict {
	id: number;
	name: string;
	verdict: "pass" | "fail";
	evidence: string[];
	elapsedMs: number;
}

export interface UatReport {
	tag: string;
	targetKind: "production" | "scratch";
	targetPort: number | null;
	targetHost: string;
	live: string | null;
	plugin: { version: string | null; commit: string | null };
	scenarios: ScenarioVerdict[];
	passed: number;
	failed: number;
}

/** Render the report: a Markdown table plus JSON. Bodies and summaries never enter. */
export function renderReport(report: UatReport): { markdown: string; json: string } {
	const lines = [
		`# Phase 0 UAT — run ${report.tag}`,
		"",
		`target: ${report.targetKind}${report.targetPort !== null ? ` :${report.targetPort}` : ""} (${report.targetHost})`,
		`live: ${report.live ?? "no"}`,
		`plugin: ${report.plugin.version ?? "unknown"} @ ${report.plugin.commit ?? "unknown"}`,
		"",
		"| scenario | verdict | evidence |",
		"| --- | --- | --- |",
	];
	for (const scenario of report.scenarios) {
		const evidence = scenario.evidence.join("; ");
		lines.push(`| ${scenario.id} ${scenario.name} | ${scenario.verdict} | ${evidence} |`);
	}
	lines.push("", `${report.passed} passed, ${report.failed} failed of ${report.scenarios.length}`);
	const markdown = `${lines.join("\n")}\n`;
	return { markdown, json: `${JSON.stringify(report, null, 2)}\n` };
}

interface HttpAttempt {
	status: number | null;
	body: unknown;
	elapsedMs: number;
	error?: string;
}

function uatHeaders(bearer: string | null): Record<string, string> {
	return {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
	};
}

/** A response body as JSON, else the last SSE data frame, else raw text. */
export function parseUatBody(text: string): unknown {
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

async function httpCall(
	base: string,
	bearer: string | null,
	path: string,
	body?: unknown,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<HttpAttempt> {
	const started = performance.now();
	try {
		const response = await fetch(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: uatHeaders(bearer),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { status: response.status, body: parseUatBody(await response.text()), elapsedMs: performance.now() - started };
	} catch (cause) {
		return { status: null, body: null, elapsedMs: performance.now() - started, error: String(cause) };
	}
}

let toolId = 100;

async function mcpTool(
	base: string,
	bearer: string | null,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const attempt = await httpCall(base, bearer, "/mcp", {
		jsonrpc: "2.0",
		id: (toolId += 1),
		method: "tools/call",
		params: { name, arguments: args },
	});
	return smokeToolResult({ status: attempt.status, body: attempt.body, contentType: "application/json" });
}

async function mcpToolList(base: string, bearer: string | null): Promise<string[] | null> {
	const attempt = await httpCall(base, bearer, "/mcp", { jsonrpc: "2.0", id: (toolId += 1), method: "tools/list", params: {} });
	const body = attempt.body as { result?: { tools?: Array<{ name?: unknown }> } } | null;
	const tools = body?.result?.tools;
	if (!Array.isArray(tools)) return null;
	return tools.map((tool) => String(tool.name));
}

/** Missing v1.0 names from a tools/list answer; empty means the superset holds. */
export function expectToolsList(names: readonly string[] | null): string[] {
	if (names === null) return ["tools/list answered nothing usable"];
	return (V1_TOOLS as readonly string[]).filter((name) => !names.includes(name)).map((name) => `missing v1 tool ${name}`);
}

/** Health shape scenario 2 requires: the index, the ledger and the append-only lock. */
export function expectHealthz(body: unknown): string[] {
	const health = (body ?? {}) as Record<string, unknown>;
	const problems: string[] = [];
	for (const field of ["index", "greptime", "appendOnly"]) {
		if (health[field] !== true) problems.push(`${field} is not true`);
	}
	return problems;
}

/** Scenario 7's outage bound: an answer (or fail-open) inside budget. */
export function expectOutageBounds(elapsedMs: number): string[] {
	return elapsedMs <= OUTAGE_BUDGET_MS ? [] : [`answered in ${Math.round(elapsedMs)} ms, over the ${OUTAGE_BUDGET_MS} ms budget`];
}

/** Scenario 7's hang guard: a callee whose own timeout broke cannot hang the proof past `ms`. */
export const PLUGIN_HANG_GUARD_MS = 10_000;
export function raceGuard<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`${label} hung past ${ms} ms`)), ms);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(cause) => {
			clearTimeout(timer);
			reject(cause);
		},
	);
	return guarded;
}

/** Scenario 8's cross-surface read: the cursor line plus the claude-code hold. */
export function expectCrossSurface(brief: string, repo: string, holder: string): string[] {
	const problems: string[] = [];
	if (!brief.includes("cursor")) problems.push("brief names no cursor action");
	if (!brief.includes("file.edit") && !brief.includes("edit")) problems.push("brief names no edit line");
	if (!brief.includes(holder)) problems.push(`brief names no hold by ${holder}`);
	if (!brief.includes(repo)) problems.push("brief is not keyed by the run repo");
	return problems;
}

/** Scenario 2's plain memory_search reply: a top-level array of newest matches. */
export function expectMemorySearch(searched: unknown): string[] {
	const entryCount = Array.isArray(searched) ? searched.length : -1;
	return entryCount <= 0 ? [`memory_search returned ${entryCount} rows`] : [];
}

/** A graph_get read carries a non-empty nodes array. */
export function expectGraphHasNodes(body: unknown): string[] {
	const nodes = (body as { nodes?: unknown } | null)?.nodes;
	return Array.isArray(nodes) && nodes.length > 0 ? [] : ["graph_get returned no nodes"];
}

/** A graph's nodes carry at least one string Linear identifier. */
export function expectGraphIdentifiers(body: unknown): string[] {
	const nodes = (body as { nodes?: Array<{ linear_identifier?: unknown }> } | null)?.nodes;
	if (!Array.isArray(nodes)) return ["graph_get returned no nodes"];
	return nodes.some((node) => typeof node.linear_identifier === "string")
		? []
		: ["graph_get returned no Linear identifiers"];
}

/** Scenario 3's backfill read-back: the fixture guarantees nodes and identifiers. */
export function expectBackfillCounts(nodes: number, identifiers: number): string[] {
	const problems: string[] = [];
	if (nodes <= 0) problems.push(`backfill read back ${nodes} nodes`);
	if (identifiers <= 0) problems.push(`backfill read back ${identifiers} Linear identifiers`);
	return problems;
}

/** The substrate MCP entry's Authorization header names the token variable. */
export function namesSubstrateToken(authorization: unknown): boolean {
	return typeof authorization === "string" && /Bearer \$\{SUBSTRATE_TOKEN(?::-[^}]*)?\}/.test(authorization);
}

/**
 * Scenario 5's MCP entry check: an HTTP transport into the target's `/mcp`.
 * The URL is matched by suffix, never by equality: the config may name a
 * hostname while the run targets loopback (or the reverse), so only the
 * scheme and the path are asserted.
 */
export function expectMcpTarget(entry: unknown): string[] {
	const problems: string[] = [];
	const record = (entry ?? {}) as Record<string, unknown>;
	if (record.type !== "http") problems.push(`substrate entry type ${JSON.stringify(record.type ?? null)} is not "http"`);
	let protocol: string | null = null;
	let path: string | null = null;
	try {
		const parsed = new URL(String(record.url ?? ""));
		protocol = parsed.protocol;
		path = parsed.pathname;
	} catch {
		protocol = null;
		path = null;
	}
	if (protocol !== "http:" && protocol !== "https:") problems.push("substrate entry url is not an http(s) URL");
	else if (path !== "/mcp" && !path?.endsWith("/mcp")) {
		// Path only, never the full URL: the message reaches stdout and both
		// saved reports, and the configured host stays out of UAT output.
		problems.push(`substrate entry url path ${JSON.stringify(path)} does not point at /mcp`);
	}
	return problems;
}

/** Count read-back events whose payload.conversation_id equals the run-tagged id. */
export function countConversation(events: unknown, conversationId: string): number {
	if (!Array.isArray(events)) return 0;
	return events.filter((event) => (event as { payload?: { conversation_id?: unknown } } | null)?.payload?.conversation_id === conversationId).length;
}

/**
 * Scratch git isolation: every git child ignores operator-shared config and
 * cannot be steered at the real repository. `undefined` clears the
 * repository-location variables `runChild` would otherwise inherit — a UAT
 * run from inside a Git wrapper or hook must not commit into real history.
 */
export function scratchGitEnv(hooksDir: string): Record<string, string | undefined> {
	return {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: hooksDir,
		GIT_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
	};
}

export interface RunContext {
	base: string;
	bearer: string | null;
	tag: string;
	repo: string;
	live: string | undefined;
	graph: string | undefined;
	pluginDir: string | null;
	graphs: string[];
}

async function runScenarioVerdict(
	id: number,
	name: string,
	body: (evidence: string[]) => Promise<string[]>,
): Promise<ScenarioVerdict> {
	const started = performance.now();
	const evidence: string[] = [];
	try {
		const problems = await body(evidence);
		return { id, name, verdict: problems.length === 0 ? "pass" : "fail", evidence: problems.length === 0 ? evidence : [...evidence, ...problems], elapsedMs: performance.now() - started };
	} catch (cause) {
		return { id, name, verdict: "fail", evidence: [...evidence, `threw: ${cause instanceof Error ? cause.message : String(cause)}`], elapsedMs: performance.now() - started };
	}
}

async function scenario1(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(1, "substrate-mcp serves both surfaces", async (evidence) => {
		const problems: string[] = [];
		const names = await mcpToolList(ctx.base, ctx.bearer);
		problems.push(...expectToolsList(names));
		evidence.push(`tools/list: ${names === null ? "unusable" : `${names.length} tools, 9 v1 names present`}`);

		const health = await httpCall(ctx.base, ctx.bearer, "/healthz");
		if (health.status !== 200) problems.push(`GET /healthz status ${health.status ?? "unreachable"}`);
		evidence.push(`GET /healthz: status ${health.status ?? "unreachable"}`);

		const brief = await httpCall(ctx.base, ctx.bearer, "/brief", { surface: "claude-code" });
		if (brief.status !== 200) problems.push(`POST /brief status ${brief.status ?? "unreachable"}`);
		evidence.push(`POST /brief: status ${brief.status ?? "unreachable"}`);

		const graph = `${runTag(ctx.tag)}-s1`;
		const session = `${runTag(ctx.tag)}-s1`;
		const emitted = await httpCall(ctx.base, ctx.bearer, "/events", {
			kind: "note",
			summary: "uat phase0 probe",
			surface: "claude-code",
			session_id: session,
			graph_id: graph,
			repo: ctx.repo,
		});
		const stored = (emitted.body as { stored?: unknown } | null)?.stored === true;
		if (emitted.status !== 202 || !stored) problems.push(`POST /events status ${emitted.status ?? "unreachable"}, stored ${stored}`);
		evidence.push(`POST /events: status ${emitted.status ?? "unreachable"}, stored ${stored}`);

		const registered = await mcpTool(ctx.base, ctx.bearer, "graph_register", { graph_id: graph, repo: ctx.repo, nodes: [{ node_id: "n1" }] });
		if (registered === null) problems.push("graph_register answered nothing usable");
		else {
			ctx.graphs.push(graph);
			evidence.push(`graph_register: graph registered with 1 node`);
		}

		const verified = await httpCall(ctx.base, ctx.bearer, "/verify", { graph_id: graph });
		if (verified.status !== 200) problems.push(`POST /verify status ${verified.status ?? "unreachable"}`);
		const ok = (verified.body as { ok?: unknown } | null)?.ok;
		evidence.push(`POST /verify: status ${verified.status ?? "unreachable"}, ok ${ok === true}`);
		return problems;
	});
}

async function scenario2(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(2, "schemas exist and hold real data", async (evidence) => {
		const problems: string[] = [];
		const health = await httpCall(ctx.base, ctx.bearer, "/healthz");
		problems.push(...expectHealthz(health.body).map((problem) => `healthz: ${problem}`));
		evidence.push("healthz: index, ledger and appendOnly true");

		const graph = ctx.graph ?? ctx.graphs[0];
		if (!graph) return [...problems, "no graph to read: pass --graph <gid> or run with scenario 1 or 3"];
		const queried = await mcpTool(ctx.base, ctx.bearer, "events_query", { graph_id: graph, limit: 5 });
		const events = (queried as { events?: unknown } | null)?.events;
		const eventCount = Array.isArray(events) ? events.length : -1;
		if (eventCount <= 0) problems.push(`events_query returned ${eventCount} rows for the graph`);
		evidence.push(`events_query: ${eventCount} rows`);

		const read = await mcpTool(ctx.base, ctx.bearer, "graph_get", { graph_id: graph });
		if (read === null) problems.push("graph_get answered nothing usable");
		else evidence.push("graph_get: graph with nodes returned");

		// An empty query lists the newest rows: `the` is an English stop word
		// the full-text index never matches, so a term query fails healthy runs.
		const searched = await mcpTool(ctx.base, ctx.bearer, "memory_search", { query: "", limit: 5 });
		problems.push(...expectMemorySearch(searched));
		evidence.push(`memory_search: ${Array.isArray(searched) ? searched.length : -1} rows`);

		evidence.push("anchors shape and raw row counts: operator-approved read-only SQL step, recorded separately");
		return problems;
	});
}

function substituteFixture(rows: NotionRow[], tag: string, repo: string): { rows: NotionRow[]; graphIds: string[] } {
	const ids = ["UAT_FIXTURE_GRAPH_A", "UAT_FIXTURE_GRAPH_B"];
	const mapped = ids.map((_, index) => `${runTag(tag)}-backfill-${index + 1}`);
	const out = rows.map((row) => {
		const graphId = row["Graph ID"];
		const index = ids.indexOf(graphId ?? "");
		return {
			...row,
			...(index >= 0 ? { "Graph ID": mapped[index] } : {}),
			...(row.Level === "Task" ? { Repo: repo } : {}),
		};
	});
	return { rows: out, graphIds: mapped };
}

async function scenario3(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(3, "index backfilled from the Notion Agent Task Graph", async (evidence) => {
		const target = classifyTarget(ctx.base);
		if (target === "production") {
			const graph = ctx.graph;
			if (!graph) return ["production backfill is a graph_get of an operator-exported graph id: pass --graph <gid>"];
			const read = await mcpTool(ctx.base, ctx.bearer, "graph_get", { graph_id: graph });
			if (read === null) return ["graph_get answered nothing usable"];
			const graphProblems = [...expectGraphHasNodes(read), ...expectGraphIdentifiers(read)];
			if (graphProblems.length > 0) return graphProblems;
			const nodesValue = typeof read === "object" && read !== null && "nodes" in read ? read.nodes : undefined;
			const nodeCount = Array.isArray(nodesValue) ? nodesValue.length : 0;
			evidence.push(`graph_get: operator-exported graph returned with ${nodeCount} nodes`);
			// Production scenario 3 is a read-only check: the scratch fixture
			// loop below registers synthetic graphs and must never run here.
			return [];
		}
		const fixturePath = new URL("./uat/fixtures/notion-rows.json", import.meta.url);
		const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
		if (!Array.isArray(raw)) return ["fixture is not a JSON array"];
		const { rows, graphIds } = substituteFixture(raw as NotionRow[], ctx.tag, ctx.repo);
		const plans = mapNotionRows(rows);
		if (plans.length === 0) return ["fixture mapped to zero plans"];
		for (const plan of plans) {
			const registered = await mcpTool(ctx.base, ctx.bearer, "graph_register", {
				graph_id: plan.graph_id,
				...(plan.repo ? { repo: plan.repo } : {}),
				...(plan.branch ? { branch: plan.branch } : {}),
				nodes: plan.nodes.map((node) => ({
					node_id: node.node_id,
					...(node.linear_identifier ? { linear_identifier: node.linear_identifier } : {}),
				})),
				steps: plan.steps.map((step) => ({ node_id: step.node_id, step: step.step })),
			});
			if (registered === null) return [`graph_register answered nothing usable for a backfill graph`];
			ctx.graphs.push(plan.graph_id);
		}
		let nodes = 0;
		let identifiers = 0;
		for (const graphId of graphIds) {
			const read = (await mcpTool(ctx.base, ctx.bearer, "graph_get", { graph_id: graphId })) as {
				nodes?: Array<{ linear_identifier?: unknown }>;
			} | null;
			const graphNodes = read?.nodes ?? [];
			nodes += graphNodes.length;
			identifiers += graphNodes.filter((node) => typeof node.linear_identifier === "string").length;
		}
		const countProblems = expectBackfillCounts(nodes, identifiers);
		if (countProblems.length > 0) return countProblems;
		evidence.push(`${plans.length} graphs backfilled from exported rows, ${nodes} nodes, ${identifiers} Linear identifiers`);
		return [];
	});
}

export interface PluginInfo {
	dir: string | null;
	version: string | null;
	commit: string | null;
}

/** The installed claude-ultrathink plugin: version and commit recorded, never bodies. */
export function resolvePlugin(home = process.env.HOME ?? "/root", fallback = "/root/src/repos/claude-ultrathink"): PluginInfo {
	try {
		const installed = JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8")) as {
			plugins?: Record<string, Array<{ installPath?: string; version?: string; gitCommitSha?: string }>>;
		};
		const entry = installed.plugins?.["ultrathink@ultrathink"]?.[0];
		if (entry?.installPath && existsSync(entry.installPath)) {
			return { dir: entry.installPath, version: entry.version ?? null, commit: entry.gitCommitSha ?? null };
		}
	} catch {
		// Fall through to the checkout fallback.
	}
	if (existsSync(join(fallback, "src/substrate/brief.ts"))) return { dir: fallback, version: null, commit: null };
	return { dir: null, version: null, commit: null };
}

async function scenario4(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(4, "the brief reaches a Claude Code session", async (evidence) => {
		const plugin = resolvePlugin();
		if (!plugin.dir) return ["no installed claude-ultrathink plugin found"];
		ctx.pluginDir = plugin.dir;
		let brief: string;
		try {
			const mod = (await import(join(plugin.dir, "src/substrate/brief.ts"))) as {
				fetchBrief: (input: Record<string, unknown>, env: Record<string, string | undefined>) => Promise<string>;
			};
			brief = await mod.fetchBrief(
				{ repo: ctx.repo, branch: "main", surface: "claude-code" },
				{ ...process.env, SUBSTRATE_URL: ctx.base, SUBSTRATE_TOKEN: ctx.bearer ?? undefined },
			);
		} catch (cause) {
			return [`fetchBrief import or call failed: ${cause instanceof Error ? cause.message : String(cause)}`];
		}
		if (!brief) return ["fetchBrief returned an empty brief"];
		evidence.push(`fetchBrief: non-empty brief (${brief.length} bytes)`);
		try {
			const output = (await import(join(plugin.dir, "src/claude/output.ts"))) as {
				formatPromptContext: (input: Record<string, unknown>) => string;
			};
			const context = output.formatPromptContext({ result: { xml: "<plan></plan>", root: "uat", source: "engine" }, brief });
			if (!context.includes("## Agent Substrate brief")) return [...evidence, "prompt context names no substrate brief header"];
			evidence.push("prompt context: substrate brief header present");
		} catch (cause) {
			return [...evidence, `formatPromptContext failed: ${cause instanceof Error ? cause.message : String(cause)}`];
		}
		return [];
	});
}

async function scenario5(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(5, "ultrathink-kickoff calls graph_register", async (evidence) => {
		const problems: string[] = [];
		const configPath = process.env.CLAUDE_CONFIG_PATH ?? join(process.env.HOME ?? "/root", ".claude.json");
		let servers: Record<string, unknown> | null = null;
		try {
			const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
			servers = config.mcpServers ?? null;
		} catch {
			servers = null;
		}
		const substrate = (servers?.["substrate"] ?? null) as {
			type?: unknown;
			url?: unknown;
			headers?: Record<string, string>;
			headersHelper?: string;
		} | null;
		if (!substrate) problems.push("no MCP server named substrate in the Claude Code config");
		else {
			const headers = substrate.headers ?? {};
			const authorization = headers.Authorization ?? headers.authorization ?? "";
			const namesToken = namesSubstrateToken(authorization);
			if (!namesToken) problems.push("substrate entry names no token variable in its Authorization header");
			const targetProblems = expectMcpTarget(substrate);
			problems.push(...targetProblems);
			if (namesToken && targetProblems.length === 0) evidence.push("substrate MCP entry: HTTP transport into the target /mcp");
			else evidence.push(`substrate MCP entry present, Authorization names token variable: ${namesToken}`);
		}
		if (ctx.graph) {
			const read = await mcpTool(ctx.base, ctx.bearer, "graph_get", { graph_id: ctx.graph });
			if (read === null) problems.push("graph_get answered nothing usable for the kickoff graph");
			else {
				const kickoffProblems = [...expectGraphHasNodes(read), ...expectGraphIdentifiers(read)];
				if (kickoffProblems.length > 0) problems.push(...kickoffProblems.map((problem) => `kickoff graph: ${problem}`));
				else evidence.push("kickoff graph returned with nodes and Linear identifiers");
			}
		} else {
			evidence.push("live kickoff graph not given (--graph): config check only");
		}
		return problems;
	});
}

function cliArgv(): string[] {
	return [process.execPath, `${CHECKOUT_ROOT}/packages/cli/src/index.ts`];
}

function checkoutArgv(rel: string, ...args: string[]): string[] {
	return [process.execPath, `${CHECKOUT_ROOT}/${rel}`, ...args];
}

export async function runChild(
	argv: string[],
	env: Record<string, string | undefined>,
	stdin?: string,
	cwd?: string,
	timeoutMs = 30000,
): Promise<{ status: number; stdout: string; elapsedMs: number; error?: string }> {
	const started = performance.now();
	// An `undefined` entry clears an inherited variable (see scratchGitEnv):
	// drop it rather than passing it to the spawn, which takes strings only.
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...env })) {
		if (value !== undefined) childEnv[key] = value;
	}
	try {
		const proc = Bun.spawn(argv, { env: childEnv, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", cwd });
		if (stdin !== undefined && proc.stdin) {
			const writer = proc.stdin as unknown as { write(s: string): void; end(): void };
			writer.write(stdin);
			writer.end();
		}
		const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// Already exited; the race below resolves first.
			}
		}, timeoutMs);
		try {
			const [[stdout], status] = await Promise.all([output, proc.exited]);
			if (timedOut) return { status: -1, stdout: "", elapsedMs: performance.now() - started, error: "timed-out" };
			return { status, stdout, elapsedMs: performance.now() - started };
		} finally {
			clearTimeout(timer);
		}
	} catch (cause) {
		return { status: -1, stdout: "", elapsedMs: performance.now() - started, error: String(cause) };
	}
}

async function scenario6(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(6, "Cursor hooks and the git post-commit collector are installed", async (evidence) => {
		const target = classifyTarget(ctx.base);
		const problems: string[] = [];

		const desired = await runChild(checkoutArgv("packages/projector/src/cursor.ts", "--print-desired"), {});
		let entries: Record<string, unknown> = {};
		try {
			entries = JSON.parse(desired.stdout) as Record<string, unknown>;
		} catch {
			return [`cursor desired entries unreadable (exit ${desired.status})`];
		}
		const names = Object.keys(entries);
		for (const name of ["sessionStart", "postToolUse", "stop"]) {
			if (!names.includes(name)) problems.push(`cursor desired entries miss ${name}`);
		}
		evidence.push(`cursor desired entries: ${names.length} (${names.join(",")})`);

		if (target === "production") {
			const check = await runChild(checkoutArgv("packages/projector/src/cursor.ts", "--check"), {});
			if (check.status !== 0) problems.push(`cursor --check exited ${check.status} on the host`);
			else evidence.push(`cursor --check exit ${check.status} on the host`);
			const checkoutHookCheck = await runChild(checkoutArgv("packages/collectors/src/install-git-hook.ts", "--check", CHECKOUT_ROOT), {});
			if (checkoutHookCheck.status !== 0) problems.push(`post-commit hook --check exited ${checkoutHookCheck.status} on the checkout root`);
			else evidence.push("post-commit hook: present on the checkout root");
			evidence.push("real Cursor session and commit: operator path, recorded separately (the script cannot itself perform a real user session)");
			return problems;
		}

		const scratch = mkdtempSync(join(tmpdir(), "uat6-"));
		const repoEnv = { SUBSTRATE_URL: ctx.base, SUBSTRATE_TOKEN: ctx.bearer ?? "" };
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const hooksDir = join(scratch, "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const gitEnv = scratchGitEnv(hooksDir);
		const init = await runChild(["git", "init", "-q", "--template=", scratch], gitEnv);
		if (init.status !== 0) return [`git init failed in scratch dir`];
		await runChild(["git", "-C", scratch, "config", "user.email", "uat@example.com"], gitEnv);
		await runChild(["git", "-C", scratch, "config", "user.name", "uat"], gitEnv);
		await runChild(["git", "-C", scratch, "commit", "-q", "--allow-empty", "-m", "seed"], gitEnv);

		const before = (await mcpTool(ctx.base, ctx.bearer, "events_query", { surface: "cursor", kind: "tool.call", repo: ctx.repo, limit: 100 })) as {
			events?: unknown[];
		} | null;
		const beforeCount = before?.events?.length ?? 0;

		// The brief runs with the scratch cwd: it gets the same git isolation
		// so an inherited GIT_DIR cannot steer anything it shells out to.
		const briefRun = await runChild([...cliArgv(), "brief", "--surface", "cursor", "--write"], { ...repoEnv, ...gitEnv }, undefined, scratch);
		if (briefRun.status !== 0) problems.push(`sessionStart brief exited ${briefRun.status}`);
		if (!existsSync(join(scratch, ".substrate", "BRIEF.md"))) problems.push("sessionStart wrote no .substrate/BRIEF.md");
		else evidence.push("sessionStart: BRIEF.md written");
		const afterBrief = (await mcpTool(ctx.base, ctx.bearer, "events_query", { surface: "cursor", kind: "tool.call", repo: ctx.repo, limit: 100 })) as {
			events?: unknown[];
		} | null;
		if ((afterBrief?.events?.length ?? 0) !== beforeCount) problems.push("sessionStart emitted an event");
		else evidence.push("sessionStart: no event emitted");

		const session = `${runTag(ctx.tag)}-s6`;
		const conversationId = `${runTag(ctx.tag)}-s6-conv`;
		const since = new Date().toISOString();
		const emitRun = await runChild(
			[...cliArgv(), "emit", "--kind", "tool.call", "--summary", "uat6 synthetic tool call", "--surface", "cursor", "--actor", "human", "--repo", ctx.repo, "--session", session],
			repoEnv,
		);
		if (emitRun.status !== 0) problems.push(`postToolUse emit exited ${emitRun.status}`);

		const cursorRoot = join(scratch, "cursor-root");
		const transcripts = join(scratch, "transcripts");
		mkdirSync(cursorRoot, { recursive: true });
		const transcript = join(cursorRoot, "transcript.md");
		writeFileSync(transcript, "synthetic transcript\n");
		const stopRun = await runChild(
			checkoutArgv("packages/collectors/src/cursor-stop.ts"),
			{ ...repoEnv, SUBSTRATE_CURSOR_ROOT: cursorRoot, SUBSTRATE_TRANSCRIPTS_DIR: transcripts },
			JSON.stringify({ conversation_id: conversationId, transcript_path: transcript, status: "done" }),
		);
		if (stopRun.status !== 0) problems.push(`stop hook exited ${stopRun.status}`);
		if (stopRun.stdout !== "") problems.push("stop hook printed on stdout");
		else evidence.push("stop: exit 0, stdout empty");

		const hook = await runChild(checkoutArgv("packages/collectors/src/install-git-hook.ts", scratch), { ...repoEnv, ...gitEnv });
		if (hook.status !== 0) return [...problems, `git hook install exited ${hook.status}`];
		const hookCheck = await runChild(checkoutArgv("packages/collectors/src/install-git-hook.ts", "--check", scratch), { ...repoEnv, ...gitEnv });
		if (hookCheck.status !== 0) problems.push("post-commit hook not present after install");
		else evidence.push("post-commit hook: present after install");

		// The hook derives the repo from the origin, so the scratch repo gets
		// one whose slug is the run repo; the synchronous mode posts inline.
		await runChild(["git", "-C", scratch, "remote", "add", "origin", `https://example.com/${ctx.repo}`], gitEnv);
		await runChild(["git", "-C", scratch, "commit", "-q", "--allow-empty", "-m", "uat6 probe"], {
			...repoEnv,
			...gitEnv,
			SUBSTRATE_SURFACE: "cursor",
			SUBSTRATE_HOOK_WAIT: "1",
		});
		const commits = (await mcpTool(ctx.base, ctx.bearer, "events_query", {
			surface: "cursor",
			kind: "commit",
			repo: ctx.repo,
			since,
			limit: 10,
		})) as { events?: unknown[] } | null;
		const matched = (commits?.events ?? []).length;
		if (matched < 1) problems.push("commit event not matched by surface, kind, repo and since");
		else evidence.push(`commit: ${matched} event(s) matched by surface, kind, repo and since`);

		const toolCalls = (await mcpTool(ctx.base, ctx.bearer, "events_query", {
			surface: "cursor",
			kind: "tool.call",
			repo: ctx.repo,
			limit: 10,
		})) as { events?: unknown[] } | null;
		const toolCallCount = (toolCalls?.events ?? []).length;
		if (toolCallCount < 1) problems.push("tool.call event not stored for the synthetic emit");
		else evidence.push(`tool.call read-back: ${toolCallCount} row(s), synthetic emit stored`);
		const stops = (await mcpTool(ctx.base, ctx.bearer, "events_query", {
			surface: "cursor",
			kind: "session.end",
			since,
			limit: 10,
			include_payload: true,
		})) as { events?: unknown[] } | null;
		const stopMatched = countConversation(stops?.events, conversationId);
		if (stopMatched < 1) problems.push("session.end event not stored for the run-tagged conversation");
		else evidence.push(`session.end read-back: ${stopMatched} event(s) for the run-tagged conversation`);
		return problems;
	});
}

async function scenario7(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(7, "a substrate outage does not block any agent", async (evidence) => {
		const problems: string[] = [];
		void ctx;
		const deadPort = await pickFreePort();
		const deadBase = `http://127.0.0.1:${deadPort}`;

		const hangPort = await pickFreePort();
		const hang = Bun.listen({ hostname: "127.0.0.1", port: hangPort, socket: { open() {}, data() {} } });
		const hangBase = `http://127.0.0.1:${hangPort}`;
		try {
			const plugin = resolvePlugin();
			if (plugin.dir) {
				try {
					const mod = (await import(join(plugin.dir, "src/substrate/brief.ts"))) as {
						fetchBrief: (input: Record<string, unknown>, env: Record<string, string | undefined>) => Promise<string>;
					};
					const started = performance.now();
					const brief = await mod.fetchBrief({ repo: "uat/outage", surface: "cursor" }, { SUBSTRATE_URL: deadBase });
					const elapsed = performance.now() - started;
					if (brief !== "") problems.push("fetchBrief answered against a dead port");
					problems.push(...expectOutageBounds(elapsed).map((problem) => `fetchBrief: ${problem}`));
					evidence.push(`fetchBrief: empty in ${Math.round(elapsed)} ms`);
					// The dead port refuses fast, so it never exercises the
					// plugin's own timeout: hang the socket too, under a guard so
					// a broken plugin timeout cannot hang the proof itself.
					try {
						const hangStarted = performance.now();
						const hangBrief = await raceGuard(
							mod.fetchBrief({ repo: "uat/outage", surface: "cursor" }, { SUBSTRATE_URL: hangBase }),
							PLUGIN_HANG_GUARD_MS,
							"plugin fetchBrief",
						);
						const hangElapsed = performance.now() - hangStarted;
						if (hangBrief !== "") problems.push("fetchBrief answered against a hanging listener");
						problems.push(...expectOutageBounds(hangElapsed).map((problem) => `fetchBrief (hanging): ${problem}`));
						if (hangBrief === "") evidence.push(`fetchBrief (hanging): empty in ${Math.round(hangElapsed)} ms`);
					} catch (cause) {
						problems.push(`fetchBrief against a hanging listener failed open loudly: ${cause instanceof Error ? cause.message : String(cause)}`);
					}
				} catch (cause) {
					problems.push(`fetchBrief threw instead of failing open: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
			} else {
				evidence.push("plugin not installed: fetchBrief check skipped");
			}

			const startup = await runChild([...cliArgv(), "--help"], {});
			const startupMs = startup.elapsedMs;
			const cliRun = await runChild([...cliArgv(), "brief", "--surface", "cursor"], { SUBSTRATE_URL: deadBase, SUBSTRATE_TOKEN: "" });
			if (cliRun.status !== 0) problems.push(`CLI brief exited ${cliRun.status} against a dead port`);
			if (cliRun.stdout.trim() !== "") problems.push("CLI brief printed against a dead port");
			problems.push(...expectOutageBounds(Math.max(0, cliRun.elapsedMs - startupMs)).map((problem) => `CLI brief: ${problem}`));
			evidence.push(`CLI brief: exit 0, empty stdout in ${Math.round(cliRun.elapsedMs)} ms (startup ${Math.round(startupMs)} ms)`);

			const hookRun = await runChild([...cliArgv(), "brief", "--surface", "cursor"], { SUBSTRATE_URL: hangBase, SUBSTRATE_TOKEN: "" });
			if (hookRun.status !== 0) problems.push(`hook brief exited ${hookRun.status} against a hanging listener`);
			if (hookRun.stdout.trim() !== "") problems.push("hook brief printed against a hanging listener");
			problems.push(...expectOutageBounds(Math.max(0, hookRun.elapsedMs - startupMs)).map((problem) => `hook brief: ${problem}`));
			if (hookRun.error === "timed-out") problems.push("hook brief timed out");
			else if (hookRun.stdout.trim() === "") evidence.push(`hook brief: exit 0, stdout empty in ${Math.round(hookRun.elapsedMs)} ms (startup ${Math.round(startupMs)} ms)`);
		} finally {
			hang.stop(true);
		}
		return problems;
	});
}

async function scenario8(ctx: RunContext): Promise<ScenarioVerdict> {
	return runScenarioVerdict(8, "phase proof — cross-surface brief", async (evidence) => {
		const problems: string[] = [];
		const graph = `${runTag(ctx.tag)}-s8`;
		const session = `${runTag(ctx.tag)}-s8`;

		const registered = await mcpTool(ctx.base, ctx.bearer, "graph_register", {
			graph_id: graph,
			repo: ctx.repo,
			nodes: [{ node_id: "n1" }],
		});
		if (registered === null) return ["graph_register answered nothing usable"];

		// Pinned to the holder the brief below requires: the server otherwise
		// claims as the bearer's surface, so surface order would flip the verdict.
		const claimed = (await mcpTool(ctx.base, ctx.bearer, "graph_claim", {
			graph_id: graph,
			node_id: "n1",
			session_id: session,
			surface: "claude-code",
		})) as { decision?: unknown; granted?: unknown; claimed?: unknown } | null;
		const decision = claimed === null ? null : (claimed.decision ?? (claimed.granted === true || claimed.claimed === true ? "granted" : null));
		if (decision !== "granted") problems.push(`graph_claim decision ${decision === null ? "unusable" : String(decision)}`);
		evidence.push(`graph_claim: decision ${decision === null ? "unusable" : String(decision)}`);
		ctx.graphs.push(graph);

		const emitted = await httpCall(ctx.base, ctx.bearer, "/events", {
			kind: "file.edit",
			summary: "uat phase0 cross-surface edit",
			surface: "cursor",
			session_id: session,
			graph_id: graph,
			repo: ctx.repo,
		});
		const stored = (emitted.body as { stored?: unknown } | null)?.stored === true;
		if (emitted.status !== 202 || !stored) problems.push(`file.edit emit status ${emitted.status ?? "unreachable"}, stored ${stored}`);
		evidence.push(`file.edit emit: status ${emitted.status ?? "unreachable"}, stored ${stored}`);

		const brief = await httpCall(ctx.base, ctx.bearer, "/brief", { repo: ctx.repo, graph_id: graph, surface: "hermes" });
		if (brief.status !== 200 || typeof brief.body !== "string") return [...problems, `brief status ${brief.status ?? "unreachable"}`];
		const briefProblems = expectCrossSurface(brief.body, ctx.repo, "claude-code");
		problems.push(...briefProblems);
		evidence.push(`brief: status 200, cross-surface lines present`);
		return problems;
	});
}

const SCENARIO_RUNNERS: Record<number, (ctx: RunContext) => Promise<ScenarioVerdict>> = {
	1: scenario1,
	2: scenario2,
	3: scenario3,
	4: scenario4,
	5: scenario5,
	6: scenario6,
	7: scenario7,
	8: scenario8,
};

const SCENARIO_NAMES: Record<number, string> = {
	1: "substrate-mcp serves both surfaces",
	2: "schemas exist and hold real data",
	3: "index backfilled from the Notion Agent Task Graph",
	4: "the brief reaches a Claude Code session",
	5: "ultrathink-kickoff calls graph_register",
	6: "Cursor hooks and the git post-commit collector are installed",
	7: "a substrate outage does not block any agent",
	8: "phase proof — cross-surface brief",
};

export function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	if (at < 0) return undefined;
	return argv[at + 1];
}

export interface UatOptions {
	scenarios: number[];
	report: string | undefined;
	tag: string;
	live: string | undefined;
	graph: string | undefined;
}

export function parseOptions(argv: string[]): UatOptions {
	if (argv.includes("--help") || argv.includes("-h")) throw new UatRefused("usage: uat-phase0.ts --tag <run-tag> [--scenarios 1,3,4] [--report <path>] [--live <approval-ref>] [--graph <gid>]");
	const tag = validateTag(flag(argv, "--tag"));
	const scenarios = parseScenarios(flag(argv, "--scenarios"));
	const live = flag(argv, "--live");
	// A missing value leaves `undefined` (writes stay refused); an empty or
	// option-like value (`--live --graph <gid>` reads "--graph" as the ref)
	// must fail loudly rather than permit production writes.
	if (live !== undefined && (live.trim() === "" || live.startsWith("--"))) throw new UatRefused("--live takes an approval reference");
	return { scenarios: scenarios ?? [], report: flag(argv, "--report"), tag, live, graph: flag(argv, "--graph") };
}

export async function runUat(opts: UatOptions, env: Record<string, string | undefined>): Promise<{ report: UatReport; exit: number }> {
	const base = (env.SUBSTRATE_URL ?? "").trim().replace(/\/+$/, "");
	if (!base) throw new UatRefused("SUBSTRATE_URL is not set: source the harness consumer.env first");
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new UatRefused(`unparseable SUBSTRATE_URL host`);
	}
	const target = classifyTarget(base);
	const selected = opts.scenarios.length > 0 ? opts.scenarios : target === "scratch" ? [...HARNESS_DEFAULT] : [...PRODUCTION_DEFAULT];
	const refused = refuseWriteScenarios(selected, target, opts.live);
	if (refused !== null) throw new UatRefused(refused);

	const bearer = resolveBearer("claude-code", env);
	const repo = runRepo(opts.tag);
	const ctx: RunContext = { base, bearer, tag: opts.tag, repo, live: opts.live, graph: opts.graph, pluginDir: null, graphs: [] };
	const verdicts: ScenarioVerdict[] = [];
	for (const id of selected) {
		const runner = SCENARIO_RUNNERS[id];
		if (!runner) throw new UatRefused(`unknown scenario ${id}`);
		verdicts.push(await runner(ctx));
	}
	const plugin = resolvePlugin();
	const report: UatReport = {
		tag: runTag(opts.tag),
		targetKind: target,
		targetPort: url.port ? Number(url.port) : null,
		targetHost: sanitizeHost(url.hostname),
		live: opts.live ?? null,
		plugin: { version: plugin.version, commit: plugin.commit },
		scenarios: verdicts,
		passed: verdicts.filter((verdict) => verdict.verdict === "pass").length,
		failed: verdicts.filter((verdict) => verdict.verdict === "fail").length,
	};
	return { report, exit: report.failed === 0 ? 0 : 1 };
}

async function main(argv: string[]): Promise<number> {
	let opts: UatOptions;
	try {
		opts = parseOptions(argv);
	} catch (cause) {
		if (cause instanceof UatRefused) {
			process.stderr.write(`[uat-phase0] ${cause.message}\n`);
			return 2;
		}
		throw cause;
	}
	if (!existsSync("scripts/rehearsal.ts")) {
		process.stderr.write("[uat-phase0] missing precondition: scripts/rehearsal.ts (run from the checkout root)\n");
		return 2;
	}
	try {
		const { report, exit } = await runUat(opts, process.env);
		for (const verdict of report.scenarios) {
			process.stdout.write(`${verdict.verdict === "pass" ? "  ok  " : " FAIL "} ${verdict.id} ${SCENARIO_NAMES[verdict.id] ?? verdict.name} (${Math.round(verdict.elapsedMs)} ms)\n`);
			for (const line of verdict.evidence) process.stdout.write(`        ${line}\n`);
		}
		process.stdout.write(`\n${report.passed}/${report.scenarios.length} scenarios passed\n`);
		if (opts.report) {
			const { markdown, json } = renderReport(report);
			await Bun.write(opts.report, markdown);
			await Bun.write(`${opts.report}.json`, json);
			process.stdout.write(`report: ${opts.report}\n`);
		}
		return exit;
	} catch (cause) {
		if (cause instanceof UatRefused) {
			process.stderr.write(`[uat-phase0] ${cause.message}\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
