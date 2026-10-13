#!/usr/bin/env bun
/**
 * Grok connector contract smoke (uplift-3 N7, Build Plan A-7 #5): proves, over
 * the wire and as the `grok-bot` bearer, the four things the desk gateway and
 * grok-hermes-connector rely on at session open.
 *
 *   bun run smoke:grok            # human lines, exit 0 | 1 | 2
 *   bun run smoke:grok -- --json  # one JSON report on stdout
 *
 *   1. MCP `memory_brief` (no `surface` argument — the bearer is the identity)
 *      answers within 1,500 ms with non-empty text, an explicit `state`, and a
 *      `surface` of `grok-bot`.
 *   2. MCP `memory_brief` again with `if_none_match: <etag>` answers
 *      `not_modified: true` within 500 ms.
 *   3. REST `POST /brief`, then the same with `If-None-Match`, answers 304
 *      with an empty body.
 *   4. `GET /healthz` reports every configured plane reachable with a closed
 *      breaker; anything else is `degraded`, not `failed`.
 *
 * Each check is `ok`, `degraded` or `failed`. Exit 0 only when every check is
 * `ok`; 1 when the worst is `degraded` (a degraded or snapshot brief, an open
 * breaker — the contract held, the planes did not); 2 when any check failed,
 * the service is unreachable, the bearer is refused, or the arguments are wrong.
 *
 * Opt-in and read-only: two MCP calls, two REST briefs, one health read. No
 * event is emitted, nothing is retained, nothing is written. It talks HTTP
 * only, holds no store client, and never prints the bearer — a 401 names the
 * variable to set, not the value it held.
 *
 * The bearer is resolved for `grok-bot` only: `SUBSTRATE_TOKEN_GROK_BOT` (the
 * server's own list variable; its first entry), else the `grok-bot` file in the
 * tokens dir (`SUBSTRATE_TOKENS_DIR`, or the client default), else
 * `SUBSTRATE_TOKEN`. The order is the reverse of the CLI resolver's on
 * purpose: a shell that exports a `SUBSTRATE_TOKEN` for some other surface
 * must not quietly turn this into a smoke of that surface, and check 1 refuses
 * a bearer the server resolves to anything but `grok-bot`.
 */
import { join } from "node:path";
import { DEFAULT_TOKENS_DIR, firstLine } from "../packages/cli/src/token.ts";
import { parseBody } from "./chaos-smoke.ts";

/** The surface this smoke speaks for; the file name under the tokens dir. */
export const GROK_SURFACE = "grok-bot";
/** The brief budget the connector's session open runs under (`BRIEF_BUDGET_MS` in the chaos smoke). */
export const BRIEF_BUDGET_MS = 1500;
/** A `not_modified` costs a compose but no transfer; the bot's turn should not notice it. */
export const NOT_MODIFIED_BUDGET_MS = 500;
/** Generous per-request ceiling, so a hung service is a verdict and not a hang. */
export const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_URL = "http://127.0.0.1:7410";
/** The brief's repo: a read against a repo the substrate always knows, so `No substrate history` is still a brief. */
export const DEFAULT_REPO = "swcstudiospace/agent-substrate";

export const CHECK_IDS = ["mcp.brief", "mcp.brief.not_modified", "rest.brief.304", "healthz.planes"] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type Verdict = "ok" | "degraded" | "failed";
const BRIEF_STATES = ["complete", "degraded", "snapshot"] as const;

export interface Check {
	id: CheckId;
	verdict: Verdict;
	/** Wall time of the request(s) the check made, ms, rounded. */
	ms: number;
	/** One sentence a human reads; never a token. */
	detail: string;
}

export interface Report {
	base: string;
	verdict: Verdict;
	exit: 0 | 1 | 2;
	checks: Check[];
}

export function parseArgs(argv: readonly string[]): { json: boolean } | { error: string } {
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") json = true;
		else return { error: `unknown argument ${arg}; usage: grok-connector-smoke [--json]` };
	}
	return { json };
}

/** Where the bearer came from, for the report; never the value. */
export type BearerSource = "SUBSTRATE_TOKEN_GROK_BOT" | "SUBSTRATE_TOKENS_DIR" | "SUBSTRATE_TOKEN";

/**
 * The `grok-bot` bearer, in this smoke's order. `read` is injectable so tests
 * prove the order without a filesystem. An empty or whitespace value is absent.
 */
export function resolveGrokBearer(
	env: Record<string, string | undefined> = process.env,
	read: (path: string) => string | null = firstLine,
): { token: string; source: BearerSource } | null {
	// The server's variable may list several entries; any one of them authenticates.
	const listed = env.SUBSTRATE_TOKEN_GROK_BOT?.split(/[\s,]+/).find((entry) => entry.length > 0);
	if (listed) return { token: listed, source: "SUBSTRATE_TOKEN_GROK_BOT" };
	const dir = env.SUBSTRATE_TOKENS_DIR?.trim() || DEFAULT_TOKENS_DIR;
	const viaFile = read(join(dir, GROK_SURFACE));
	if (viaFile) return { token: viaFile, source: "SUBSTRATE_TOKENS_DIR" };
	const direct = env.SUBSTRATE_TOKEN?.trim();
	if (direct) return { token: direct, source: "SUBSTRATE_TOKEN" };
	return null;
}

/** The sentence a missing or refused bearer gets: names, never values. */
export const BEARER_HINT =
	`set SUBSTRATE_TOKEN_GROK_BOT, or put the ${GROK_SURFACE} token in the tokens dir named by SUBSTRATE_TOKENS_DIR, ` +
	"or export SUBSTRATE_TOKEN for a grok-bot bearer";

/** The worst verdict wins: one failure fails the run, one degraded check degrades it. */
export function worst(verdicts: readonly Verdict[]): Verdict {
	if (verdicts.includes("failed")) return "failed";
	if (verdicts.includes("degraded")) return "degraded";
	return "ok";
}

export function exitFor(verdict: Verdict): 0 | 1 | 2 {
	return verdict === "ok" ? 0 : verdict === "degraded" ? 1 : 2;
}

/** The `structuredContent` of a `memory_brief` reply, narrowed field by field, or null when the reply is not one. */
export function briefStructured(body: unknown): {
	etag: string | null;
	state: string | null;
	surface: string | null;
	notModified: boolean;
	text: string;
	isError: boolean;
} | null {
	if (body === null || typeof body !== "object" || Array.isArray(body) || !("result" in body)) return null;
	const result: unknown = body.result;
	if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
	let text = "";
	if ("content" in result && Array.isArray(result.content)) {
		const first: unknown = result.content[0];
		if (first !== null && typeof first === "object" && "text" in first && typeof first.text === "string") text = first.text;
	}
	const isError = "isError" in result && result.isError === true;
	let etag: string | null = null;
	let state: string | null = null;
	let surface: string | null = null;
	let notModified = false;
	if ("structuredContent" in result && result.structuredContent !== null && typeof result.structuredContent === "object") {
		const structured: object = result.structuredContent;
		if ("etag" in structured && typeof structured.etag === "string") etag = structured.etag;
		if ("state" in structured && typeof structured.state === "string") state = structured.state;
		if ("surface" in structured && typeof structured.surface === "string") surface = structured.surface;
		if ("not_modified" in structured && structured.not_modified === true) notModified = true;
	}
	return { etag, state, surface, notModified, text, isError };
}

/**
 * The planes of a `/healthz` body that are not fully up: `ok: false`, or a
 * breaker that is not `closed`. An unconfigured plane (`ok: null`) is not
 * down, and a body without `planes` has none to report — an older server
 * proves nothing either way.
 */
export function planesNotUp(body: unknown): string[] {
	if (body === null || typeof body !== "object" || !("planes" in body) || body.planes === null || typeof body.planes !== "object") return [];
	const down: string[] = [];
	for (const [name, plane] of Object.entries(body.planes)) {
		if (plane === null || typeof plane !== "object") continue;
		if ("ok" in plane && plane.ok === false) {
			down.push(`${name} unreachable`);
			continue;
		}
		if ("breaker" in plane && plane.breaker !== null && typeof plane.breaker === "object" && "state" in plane.breaker && plane.breaker.state !== "closed") {
			down.push(`${name} breaker ${String(plane.breaker.state)}`);
		}
	}
	return down;
}

interface Attempt {
	status: number | null;
	body: unknown;
	headers: Headers | null;
	rawLength: number;
	ms: number;
	error?: string;
}

export interface SmokeOptions {
	base: string;
	bearer: string;
	repo?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Run the four checks against `base` as `bearer`. Pure apart from the
 * requests it makes: it prints nothing and returns the report; `main` decides
 * how to show it. A refused bearer or an unreachable service short-circuits
 * to a `failed` report with the hint, because none of the four can be judged.
 */
export async function runSmoke(options: SmokeOptions): Promise<Report> {
	const base = options.base.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const repo = options.repo ?? DEFAULT_REPO;

	const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Attempt> => {
		const started = performance.now();
		try {
			const response = await fetchImpl(`${base}${path}`, {
				method: init.body === undefined ? "GET" : "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${options.bearer}`,
					...init.headers,
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await response.text();
			return { status: response.status, body: parseBody(text), headers: response.headers, rawLength: text.length, ms: performance.now() - started };
		} catch (cause) {
			return { status: null, body: null, headers: null, rawLength: 0, ms: performance.now() - started, error: String(cause) };
		}
	};
	const tool = (id: number, args: Record<string, unknown>) =>
		call("/mcp", { body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "memory_brief", arguments: args } } });

	const checks: Check[] = [];
	const check = (id: CheckId, verdict: Verdict, ms: number, detail: string): void => {
		checks.push({ id, verdict, ms: Math.round(ms), detail });
	};
	const report = (): Report => {
		const verdict = worst(checks.map((entry) => entry.verdict));
		return { base, verdict, exit: exitFor(verdict), checks };
	};
	/** A reply that cannot be judged: say which layer stopped it. */
	const blocked = (attempt: Attempt): string | null => {
		if (attempt.status === null) return `unreachable: ${attempt.error ?? "no response"}`;
		if (attempt.status === 401) return `the bearer was refused (401); ${BEARER_HINT}`;
		if (attempt.status !== 200) return `HTTP ${attempt.status}`;
		return null;
	};

	// ── 1. MCP memory_brief, the bearer as identity ─────────────────────────────
	const first = await tool(1, { repo });
	const firstBlock = blocked(first);
	if (firstBlock !== null) {
		check("mcp.brief", "failed", first.ms, firstBlock);
		return report();
	}
	const brief = briefStructured(first.body);
	let etag: string | null = null;
	if (brief === null || brief.isError) {
		check("mcp.brief", "failed", first.ms, brief?.isError ? `the tool reported an error: ${brief.text.slice(0, 160)}` : "the reply was not a tool result");
	} else if (brief.text.length === 0) {
		check("mcp.brief", "failed", first.ms, "the brief text was empty");
	} else if (brief.state === null || !(BRIEF_STATES as readonly string[]).includes(brief.state) || brief.etag === null) {
		check("mcp.brief", "failed", first.ms, "no explicit state or etag in structuredContent — an older server, or the metadata contract is broken");
	} else if (brief.surface !== null && brief.surface !== GROK_SURFACE) {
		check("mcp.brief", "failed", first.ms, `the bearer resolved to surface ${brief.surface}, not ${GROK_SURFACE}; ${BEARER_HINT}`);
	} else if (first.ms > BRIEF_BUDGET_MS) {
		check("mcp.brief", "failed", first.ms, `state ${brief.state}, but over the ${BRIEF_BUDGET_MS} ms budget`);
	} else {
		etag = brief.etag;
		check("mcp.brief", brief.state === "complete" ? "ok" : "degraded", first.ms, `state ${brief.state}, ${brief.text.length} chars, etag ${brief.etag}`);
	}

	// ── 2. MCP memory_brief with if_none_match ──────────────────────────────────
	if (etag === null) {
		check("mcp.brief.not_modified", "failed", 0, "not run: check 1 produced no etag");
	} else {
		const second = await tool(2, { repo, if_none_match: etag });
		const secondBlock = blocked(second);
		const again = briefStructured(second.body);
		if (secondBlock !== null) check("mcp.brief.not_modified", "failed", second.ms, secondBlock);
		else if (again === null || again.isError) check("mcp.brief.not_modified", "failed", second.ms, "the reply was not a tool result");
		else if (!again.notModified) check("mcp.brief.not_modified", "failed", second.ms, `the brief was sent again (etag ${again.etag ?? "none"}) instead of not_modified`);
		else if (again.text.length > 80) check("mcp.brief.not_modified", "failed", second.ms, "not_modified, but the text was not the one-line notice");
		else if (second.ms > NOT_MODIFIED_BUDGET_MS) check("mcp.brief.not_modified", "failed", second.ms, `not_modified, but over the ${NOT_MODIFIED_BUDGET_MS} ms budget`);
		else check("mcp.brief.not_modified", "ok", second.ms, `not_modified, etag ${again.etag ?? etag}`);
	}

	// ── 3. REST /brief then the conditional /brief ──────────────────────────────
	const rest = await call("/brief", { body: { repo } });
	const restBlock = blocked(rest);
	if (restBlock !== null) {
		check("rest.brief.304", "failed", rest.ms, restBlock);
	} else {
		const restEtag = rest.headers?.get("etag") ?? null;
		const restState = rest.headers?.get("x-substrate-brief") ?? null;
		if (restEtag === null || restState === null) {
			check("rest.brief.304", "failed", rest.ms, "POST /brief answered without ETag or X-Substrate-Brief");
		} else {
			const conditional = await call("/brief", { body: { repo }, headers: { "if-none-match": restEtag } });
			const ms = rest.ms + conditional.ms;
			if (conditional.status === null) check("rest.brief.304", "failed", ms, `conditional POST /brief unreachable: ${conditional.error ?? "no response"}`);
			else if (conditional.status !== 304) check("rest.brief.304", "failed", ms, `conditional POST /brief answered ${conditional.status}, not 304`);
			else if (conditional.rawLength !== 0) check("rest.brief.304", "failed", ms, `304 with a ${conditional.rawLength}-byte body`);
			// The REST and MCP tags are not compared: an event landing between the two
			// calls legitimately moves the brief, and equality for one request is the
			// contract test's job (`mcp.brief.test.ts`), not a live smoke's.
			else check("rest.brief.304", restState === "complete" ? "ok" : "degraded", ms, `200 then 304, state ${restState}, etag ${restEtag}`);
		}
	}

	// ── 4. /healthz planes ──────────────────────────────────────────────────────
	const health = await call("/healthz");
	if (health.status === null) check("healthz.planes", "failed", health.ms, `unreachable: ${health.error ?? "no response"}`);
	else if (health.status === 401) check("healthz.planes", "failed", health.ms, `the bearer was refused (401); ${BEARER_HINT}`);
	else {
		const down = planesNotUp(health.body);
		if (down.length === 0) check("healthz.planes", health.status === 200 ? "ok" : "degraded", health.ms, health.status === 200 ? "every configured plane reachable, breakers closed" : `HTTP ${health.status}, planes up`);
		else check("healthz.planes", "degraded", health.ms, down.join("; "));
	}
	return report();
}

/** The human report: one line per check, then the verdict. */
export function formatReport(report: Report): string {
	const lines = report.checks.map((check) => `${check.verdict.padEnd(8)} ${check.id.padEnd(24)} ${String(check.ms).padStart(5)} ms  ${check.detail}`);
	lines.push("", `verdict: ${report.verdict} (exit ${report.exit})`);
	return `${lines.join("\n")}\n`;
}

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	const base = (env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
	const bearer = resolveGrokBearer(env);
	if (bearer === null) {
		process.stderr.write(`no ${GROK_SURFACE} bearer: ${BEARER_HINT}\n`);
		return 2;
	}
	const report = await runSmoke({ base, bearer: bearer.token, repo: env.SUBSTRATE_SMOKE_REPO?.trim() || DEFAULT_REPO });
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify({ ...report, bearer: bearer.source })}\n`);
	} else {
		process.stdout.write(`Grok connector smoke — ${new URL(base).host}, bearer from ${bearer.source}\n\n${formatReport(report)}`);
	}
	return report.exit;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
