#!/usr/bin/env bun
/**
 * LLM proxy health check: which of this host's loopback LLM proxies can answer
 * a prompt right now. Secret-free: the key it sends is a dummy
 * (`LLM_PROXY_DUMMY_KEY`), and nothing it prints can carry a credential.
 *
 *   bun scripts/llm-proxy-smoke.ts [--json] [--only <name>]...
 *
 * One minimal request per provider (`max_tokens` 8, "Reply with the single
 * word: pong"). Each provider lands in exactly one state:
 *
 * - `ok`              2xx, and non-empty text in the reply shape the wire format promises;
 * - `unauthenticated` 401 or 403: the proxy is reachable but has no usable login. The
 *                     reason carries the proxy's error TYPE and a short, scrubbed message;
 * - `unreachable`     connection refused, timeout, or any other failure to get a response;
 * - `invalid`         anything else: wrong shape, a redirect, an unexpected status, or a
 *                     body over 1 MB. A body is never printed.
 *
 * The providers (loopback on the VPS; see docs/runbooks/lightrag-storage-topology.md):
 *
 * - `shunt`           127.0.0.1:3001, Anthropic-compatible. A Claude route passes the caller's
 *                     key to Anthropic, so a dummy key answering 401 `invalid x-api-key` means
 *                     "reachable, not authenticated".
 * - `shunt-grok`      the same proxy on a Grok route, which uses a stored xAI OAuth session; a
 *                     dead session answers 401 naming `invalid_grant` (`shunt login xai`).
 * - `aio-grok-proxy`  127.0.0.1:41417, Anthropic-compatible. It ignores the client key and uses
 *                     the host SuperGrok session, so a dummy key answering 200 is the working path.
 * - `hermes`          127.0.0.1:8645, xAI OpenAI-compatible (`hermes proxy`); refuses connections
 *                     until `hermes auth add xai-oauth --type oauth` has been run.
 *
 * Exit 0 when at least one provider is `ok`, 1 when none is, 2 on a usage error.
 * Safety: an `http:` base URL whose host is not loopback is refused (exit 2) before
 * any request is made, so the dummy key never goes to a remote cleartext host;
 * redirects are never followed for the same reason.
 *
 * The pure functions below take their fetch and clock, so the tests run with
 * neither a network nor a timer.
 */

import { redact } from "../packages/mcp-server/src/redact.ts";

export const SCHEMA = 1;
export const DEFAULT_DUMMY_KEY = "dummy-not-a-real-key";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 1_000_000;
export const PROBE_PROMPT = "Reply with the single word: pong";
const REASON_MAX = 160;

export type WireFormat = "anthropic-messages" | "openai-chat";
export type KeyHeader = "x-api-key" | "authorization";
export type State = "ok" | "unauthenticated" | "unreachable" | "invalid";
export type Env = Record<string, string | undefined>;
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface Provider {
	name: string;
	/** The variable that overrides `defaultUrl`; named in refusals, never read through this field. */
	urlEnv: string;
	defaultUrl: string;
	override(env: Env): string | undefined;
	format: WireFormat;
	/** The model the one probe asks for. */
	model: string;
	/** `x-api-key: <key>` or `authorization: Bearer <key>`. */
	keyHeader: KeyHeader;
}

export const PROVIDERS: readonly Provider[] = [
	{ name: "shunt", urlEnv: "LLM_PROXY_SHUNT_URL", defaultUrl: "http://127.0.0.1:3001", override: (env) => env.LLM_PROXY_SHUNT_URL, format: "anthropic-messages", model: "claude-haiku-4-5", keyHeader: "x-api-key" },
	{ name: "shunt-grok", urlEnv: "LLM_PROXY_SHUNT_URL", defaultUrl: "http://127.0.0.1:3001", override: (env) => env.LLM_PROXY_SHUNT_URL, format: "anthropic-messages", model: "grok-4.6", keyHeader: "x-api-key" },
	{ name: "aio-grok-proxy", urlEnv: "LLM_PROXY_AIO_GROK_URL", defaultUrl: "http://127.0.0.1:41417", override: (env) => env.LLM_PROXY_AIO_GROK_URL, format: "anthropic-messages", model: "grok-4.6", keyHeader: "x-api-key" },
	{ name: "hermes", urlEnv: "LLM_PROXY_HERMES_URL", defaultUrl: "http://127.0.0.1:8645", override: (env) => env.LLM_PROXY_HERMES_URL, format: "openai-chat", model: "grok-4.6", keyHeader: "authorization" },
];

export interface ProviderResult {
	name: string;
	url: string;
	state: State;
	ms: number;
	reason: string | null;
}

export interface Report {
	schema: 1;
	providers: ProviderResult[];
	ok: boolean;
}

// ── arguments and config ────────────────────────────────────────────────────

export function parseArgs(argv: readonly string[]): { json: boolean; only: string[] } | { error: string } {
	let json = false;
	const only: string[] = [];
	const names = PROVIDERS.map((p) => p.name);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--json") json = true;
		else if (arg === "--only" || arg.startsWith("--only=")) {
			const value = arg === "--only" ? argv[++i] : arg.slice("--only=".length);
			if (value === undefined || value === "") return { error: "--only needs a provider name" };
			if (!names.includes(value)) return { error: `unknown provider ${JSON.stringify(scrubSecrets(value, [], 40))} (known: ${names.join(", ")})` };
			if (!only.includes(value)) only.push(value);
		} else return { error: `unknown argument ${JSON.stringify(scrubSecrets(arg, [], 40))}` };
	}
	return { json, only };
}

/** Loopback host of a parsed URL: `localhost`, `127.0.0.0/8`, or `::1`. */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host === "::1") return true;
	const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The base URL a provider is probed at, or the reason it is refused. A refusal
 * never repeats the URL: it may carry userinfo.
 */
export function resolveBase(provider: Provider, env: Env): { base: string } | { error: string } {
	const raw = provider.override(env)?.trim() || provider.defaultUrl;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { error: `${provider.urlEnv} is not a URL` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `${provider.urlEnv} must be an http or https URL` };
	if (url.username !== "" || url.password !== "") return { error: `${provider.urlEnv} must not carry credentials` };
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return { error: `${provider.urlEnv} is cleartext http to a non-loopback host; refusing to send a key there` };
	return { base: url.origin + url.pathname.replace(/\/+$/, "") };
}

export function resolveTimeout(env: Env): number | { error: string } {
	const raw = env.LLM_PROXY_TIMEOUT_MS?.trim();
	if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 600_000) return { error: "LLM_PROXY_TIMEOUT_MS must be a whole number of milliseconds, 1..600000" };
	return n;
}

// ── scrubbing ───────────────────────────────────────────────────────────────

const KEYLIKE: readonly RegExp[] = [
	/\bBearer\s+\S+/gi,
	/\b(?:x-api-key|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)\b["']?\s*[:=]\s*["']?[^\s"',;]+/gi,
	/[A-Za-z0-9_+/=-]{32,}/g,
];

/**
 * One line, bounded, with anything bearer- or key-like replaced by `[scrubbed]`: the literal `secrets` (the
 * dummy key, the only credential this script sends), then the repo's shared redactor (which owns credential
 * shapes: JWTs, vendor keys, bearer values; redact-lock rule 4), then `key: value` pairs and long opaque tokens.
 */
export function scrubSecrets(text: string, secrets: readonly string[], max = REASON_MAX): string {
	let out = text;
	for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("[scrubbed]");
	out = redact(out);
	for (const pattern of KEYLIKE) out = out.replace(pattern, "[scrubbed]");
	out = out.replace(/\s+/g, " ").trim();
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ── one probe ───────────────────────────────────────────────────────────────

export interface ProbeContext {
	fetch: FetchFn;
	now(): number;
	dummyKey: string;
	timeoutMs: number;
}

export function buildRequest(provider: Provider, base: string, dummyKey: string, timeoutMs: number): { url: string; init: RequestInit } {
	const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
	if (provider.keyHeader === "authorization") headers.authorization = `Bearer ${dummyKey}`;
	else headers["x-api-key"] = dummyKey;
	if (provider.format === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	const url = provider.format === "anthropic-messages" ? `${base}/v1/messages` : `${base}/v1/chat/completions`;
	const body = JSON.stringify({ model: provider.model, max_tokens: 8, messages: [{ role: "user", content: PROBE_PROMPT }] });
	// `manual`: a redirect must never carry the key to another host.
	return { url, init: { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } };
}

/** One property of a value that may not be an object: `undefined` when it is not one. Narrows without asserting a shape. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** The reply text in the shape the wire format promises, or null. */
export function replyText(format: WireFormat, body: unknown): string | null {
	if (format === "anthropic-messages") {
		const content = field(body, "content");
		if (!Array.isArray(content)) return null;
		for (const block of content) {
			const text = field(block, "text");
			if (field(block, "type") === "text" && typeof text === "string" && text.trim() !== "") return text;
		}
		return null;
	}
	const choices = field(body, "choices");
	if (!Array.isArray(choices)) return null;
	const content = field(field(choices[0], "message"), "content");
	return typeof content === "string" && content.trim() !== "" ? content : null;
}

/** The proxy's error type and message from either wire format's error body; both optional. */
export function errorParts(body: unknown): { type: string | null; message: string | null } {
	const err = field(body, "error");
	if (typeof err === "string") return { type: null, message: err };
	const type = field(err, "type") ?? field(err, "code");
	const message = field(err, "message");
	return { type: typeof type === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(type) ? type : null, message: typeof message === "string" ? message : null };
}

/** Body text, or null when it is over `max` bytes (declared or streamed). The rest of an oversized body is never read. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await res.body?.cancel().catch(() => undefined);
		return null;
	}
	if (res.body === null) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function failureReason(err: unknown, timeoutMs: number): string {
	const name = field(err, "name");
	if (name === "TimeoutError" || name === "AbortError") return `timeout after ${timeoutMs} ms`;
	const code = field(err, "code");
	const message = field(err, "message");
	const text = `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
	if (/ECONNREFUSED|ConnectionRefused|Unable to connect|refused/i.test(text)) return "connection refused";
	if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return "host not found";
	return "network error";
}

export async function probeProvider(provider: Provider, base: string, ctx: ProbeContext): Promise<ProviderResult> {
	const start = ctx.now();
	const done = (state: State, reason: string | null): ProviderResult => ({ name: provider.name, url: base, state, ms: Math.max(0, Math.round(ctx.now() - start)), reason });
	const scrub = (text: string): string => scrubSecrets(text, [ctx.dummyKey]);
	const { url, init } = buildRequest(provider, base, ctx.dummyKey, ctx.timeoutMs);

	let res: Response;
	try {
		res = await ctx.fetch(url, init);
	} catch (err) {
		return done("unreachable", failureReason(err, ctx.timeoutMs));
	}
	if (res.status >= 300 && res.status < 400) {
		await res.body?.cancel().catch(() => undefined);
		return done("invalid", `redirect refused (HTTP ${res.status})`);
	}
	let text: string | null;
	try {
		text = await readCapped(res, MAX_BODY_BYTES);
	} catch (err) {
		const reason = failureReason(err, ctx.timeoutMs);
		return reason.startsWith("timeout") ? done("unreachable", reason) : done("invalid", "response body could not be read");
	}
	if (text === null) return done("invalid", "response body over 1 MB");

	let body: unknown = null;
	let json = true;
	try {
		body = JSON.parse(text);
	} catch {
		json = false;
	}

	if (res.status >= 200 && res.status < 300) {
		if (!json) return done("invalid", `HTTP ${res.status} body is not JSON`);
		return replyText(provider.format, body) === null ? done("invalid", `HTTP ${res.status} without text in the ${provider.format} shape`) : done("ok", null);
	}
	if (res.status === 401 || res.status === 403) {
		const { type, message } = errorParts(body);
		const head = `HTTP ${res.status}${type === null ? "" : ` ${type}`}`;
		const detail = message === null ? "" : scrub(message);
		return done("unauthenticated", detail === "" ? head : `${head}: ${detail}`);
	}
	return done("invalid", `unexpected HTTP ${res.status}`);
}

// ── the run and its output ──────────────────────────────────────────────────

export async function runSmoke(providers: readonly Provider[], env: Env, ctx: ProbeContext): Promise<Report | { error: string }> {
	const targets: { provider: Provider; base: string }[] = [];
	for (const provider of providers) {
		const resolved = resolveBase(provider, env);
		if ("error" in resolved) return { error: resolved.error };
		targets.push({ provider, base: resolved.base });
	}
	const results = await Promise.all(targets.map((t) => probeProvider(t.provider, t.base, ctx)));
	return { schema: SCHEMA, providers: results, ok: exitFor(results) === 0 };
}

export function exitFor(results: readonly Pick<ProviderResult, "state">[]): 0 | 1 {
	return results.some((r) => r.state === "ok") ? 0 : 1;
}

export function formatTable(report: Report): string {
	const rows = [["PROVIDER", "STATE", "MS", "URL", "REASON"], ...report.providers.map((p) => [p.name, p.state, String(p.ms), p.url, p.reason ?? "-"])];
	const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => (row[col] as string).length)));
	const lines = rows.map((row) => row.map((cell, col) => (col < 4 ? cell.padEnd(widths[col] as number) : cell)).join("  ").trimEnd());
	const okNames = report.providers.filter((p) => p.state === "ok").map((p) => p.name);
	lines.push("", report.ok ? `ok: ${okNames.join(", ")}` : "no provider answered a prompt");
	return `${lines.join("\n")}\n`;
}

export interface MainDeps {
	env: Env;
	fetch: FetchFn;
	now(): number;
	stdout(text: string): void;
	stderr(text: string): void;
}

export async function main(argv: readonly string[], deps: Partial<MainDeps> = {}): Promise<number> {
	const env = deps.env ?? process.env;
	const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
	const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
	const usage = (message: string): number => {
		stderr(`llm-proxy-smoke: ${message}\nusage: bun scripts/llm-proxy-smoke.ts [--json] [--only <name>]...\n`);
		return 2;
	};
	const args = parseArgs(argv);
	if ("error" in args) return usage(args.error);
	const timeoutMs = resolveTimeout(env);
	if (typeof timeoutMs !== "number") return usage(timeoutMs.error);
	const selected = args.only.length === 0 ? PROVIDERS : PROVIDERS.filter((p) => args.only.includes(p.name));
	const dummyKey = env.LLM_PROXY_DUMMY_KEY?.trim() || DEFAULT_DUMMY_KEY;
	const report = await runSmoke(selected, env, {
		fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
		now: deps.now ?? (() => performance.now()),
		dummyKey,
		timeoutMs,
	});
	if ("error" in report) return usage(report.error);
	stdout(args.json ? `${JSON.stringify(report)}\n` : formatTable(report));
	return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
