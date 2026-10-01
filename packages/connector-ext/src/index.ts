#!/usr/bin/env bun
/**
 * @substrate/connector-ext — grok-hermes-connector v0.4 forwarder.
 *
 * Forwards to substrate:
 *   - memory_brief (REST /brief, returns text or error)
 *   - memory_write (MCP, returns {status: 'accepted'|'conflict'|... , ...})
 *   - events_emit (REST /events)
 *   - graph_get (MCP)
 *
 * Supports handoff event via dedicated helper (records `kind: "handoff"` with Graph ID).
 *
 * Choice of transport:
 *   - default: direct POST/fetch (like packages/collectors/src/grok.ts)
 *   - CONNECTOR_USE_CLI=1 : use `substrate` CLI (or bun path) for brief/emit (like cli)
 *
 * Redaction applied to outbound payloads (reuses the canonical rules ported from redactor.py).
 * Fail-open everywhere: never throws to caller, returns error shape or "" .
 *
 * Runnable:
 *   bun packages/connector-ext/src/index.ts memory_brief --graph ut-... --surface grok-bot
 *   bun packages/connector-ext/src/index.ts events_emit --kind handoff --summary "..." --graph ...
 *
 * Grounded in Phase 1: additive, matches existing /brief /events /mcp wire, substrate.yaml grok-bot surface.
 */

import { spawnSync } from "node:child_process";
import { redact, redactValue } from "../../mcp-server/src/redact.ts";

const DEFAULT_URL = "http://127.0.0.1:7410";
const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const SUBSTRATE_TOKEN = process.env.SUBSTRATE_TOKEN;
const USE_CLI = (process.env.CONNECTOR_USE_CLI || "").trim() === "1";
const CLI = process.env.SUBSTRATE_CLI ?? "packages/cli/src/index.ts";
const TIMEOUT_MS = 1500;

function authHeaders(): Record<string, string> {
	return SUBSTRATE_TOKEN ? { authorization: `Bearer ${SUBSTRATE_TOKEN}` } : {};
}

async function directPost(path: string, body: unknown): Promise<Response | null> {
	try {
		const redacted = redactValue(body);
		const res = await fetch(`${SUBSTRATE_URL}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...authHeaders(),
			},
			body: JSON.stringify(redacted),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return res;
	} catch {
		return null;
	}
}

async function mcpCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
	const redactedArgs = redactValue(args);
	const body = {
		jsonrpc: "2.0",
		id: (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)),
		method: "tools/call",
		params: { name: tool, arguments: redactedArgs },
	};
	try {
		const res = await fetch(`${SUBSTRATE_URL}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...authHeaders(),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			return { error: `http_${res.status}`, detail: (await res.text()).slice(0, 500) };
		}
		const text = await res.text();
		const dataLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
		let envelope: unknown;
		try {
			envelope = JSON.parse(dataLine);
		} catch {
			return { status: res.status, body: text.slice(0, 2000) };
		}
		if (envelope && typeof envelope === "object" && "error" in envelope) {
			const envRec = envelope as Record<string, unknown>;
			return { error: "mcp_error", detail: envRec.error };
		}
		const envObj: Record<string, unknown> = (envelope && typeof envelope === "object") ? (envelope as Record<string, unknown>) : {};
		const result: Record<string, unknown> = (envObj.result && typeof envObj.result === "object") ? (envObj.result as Record<string, unknown>) : {};
		if (result.isError) {
			const contentVal = result.content;
			const c0 = Array.isArray(contentVal) ? contentVal[0] : undefined;
			const txt = (c0 && typeof c0 === "object" && "text" in c0) ? (c0 as Record<string, unknown>).text : undefined;
			return { error: "tool_error", detail: typeof txt === "string" ? txt.slice(0, 1000) : txt };
		}
		const contentArr = Array.isArray(result.content) ? result.content : [];
		const first = contentArr[0];
		let contentText = "";
		if (first && typeof first === "object" && "text" in first) {
			const t = (first as Record<string, unknown>).text;
			contentText = typeof t === "string" ? t : "";
		}
		try {
			return JSON.parse(contentText);
		} catch {
			return contentText || result;
		}
	} catch (e) {
		return { error: "upstream_unreachable", message: String(e) };
	}
}

function cliCall(command: string, args: Record<string, string | true | undefined>): string {
	// Map to substrate CLI argv; best-effort, fail-open
	const argv: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		if (v === true || v === undefined) continue;
		argv.push(`--${k}`, String(v));
	}
	const full = [CLI, command, ...argv];
	try {
		const r = spawnSync("bun", full, {
			encoding: "utf8",
			timeout: TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (r.error) return "";
		return (r.stdout || "").trim() || (r.stderr || "").trim();
	} catch {
		return "";
	}
}

export async function memory_brief(opts: {
	repo?: string;
	branch?: string;
	graph_id?: string;
	surface?: string;
} = {}): Promise<string | { error: string; [k: string]: unknown }> {
	if (USE_CLI) {
		const out = cliCall("brief", {
			repo: opts.repo,
			branch: opts.branch,
			graph: opts.graph_id,
			surface: opts.surface ?? "grok-bot",
		});
		return out || { error: "cli_no_output" };
	}
	const res = await directPost("/brief", {
		repo: opts.repo,
		branch: opts.branch,
		graph_id: opts.graph_id,
		surface: opts.surface ?? "grok-bot",
	});
	if (!res || !res.ok) {
		return { error: "unreachable_or_error", status: res?.status };
	}
	return (await res.text()).trim();
}

export async function memory_write(entry: {
	scope: string;
	kind: string;
	text: string;
	trust?: string;
	ttl?: string;
	source_event?: string;
	surface?: string;
}): Promise<{ status: string; [k: string]: unknown }> {
	// memory_write is MCP-only; always use jsonrpc path; caller handles status
	const result = await mcpCall("memory_write", {
		...entry,
		surface: entry.surface ?? "grok-bot",
	});
	if (result && typeof result === "object" && "status" in result) {
		const r = result as Record<string, unknown>;
		return { status: String(r.status ?? "accepted"), ...r };
	}
	// normalize
	return { status: "error", detail: result };
}

export async function events_emit(ev: {
	kind: string;
	summary: string;
	surface?: string;
	session_id?: string;
	graph_id?: string;
	node_id?: string;
	repo?: string;
	branch?: string;
	actor?: string;
	payload?: Record<string, unknown>;
}): Promise<unknown> {
	if (USE_CLI) {
		const out = cliCall("emit", {
			kind: ev.kind,
			summary: ev.summary,
			surface: ev.surface ?? "grok-bot",
			session: ev.session_id,
			graph: ev.graph_id,
			node: ev.node_id,
			repo: ev.repo,
			branch: ev.branch,
			actor: ev.actor,
			...(ev.payload ? { payload: JSON.stringify(ev.payload) } : {}),
		});
		try {
			return JSON.parse(out);
		} catch {
			return { status: 202, body: out };
		}
	}
	const res = await directPost("/events", {
		...ev,
		surface: ev.surface ?? "grok-bot",
	});
	if (!res) return { error: "unreachable" };
	if (res.ok) {
		try {
			return await res.json();
		} catch {
			return { status: res.status, stored: true };
		}
	}
	return { error: "emit_failed", status: res.status };
}

export async function graph_get(graph_id: string): Promise<unknown> {
	return mcpCall("graph_get", { graph_id });
}

/** Support handoff event as specified for v0.4: `handoff_to_hermes` records a `handoff` event with its Graph ID. */
export async function handoffEvent(params: {
	graph_id?: string;
	summary?: string;
	session_id?: string;
	node_id?: string;
	repo?: string;
	branch?: string;
	title?: string;
} = {}): Promise<unknown> {
	const titlePart = params.title ? ": " + params.title : "";
	const summary = params.summary || ("handoff_to_hermes" + titlePart);
	return events_emit({
		kind: "handoff",
		summary: redact(summary),
		surface: "grok-bot",
		graph_id: params.graph_id,
		session_id: params.session_id,
		node_id: params.node_id,
		repo: params.repo,
		branch: params.branch,
		actor: "agent",
		payload: params.graph_id ? { graph_id: params.graph_id } : undefined,
	});
}

// --- runnable entrypoint for smoke / direct use ---
async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	// inline parse to avoid tiny wrapper (per rules)
	const args: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		const tok = rest[i];
		if (tok && tok.startsWith("--")) {
			const k = tok.slice(2);
			let v = "true";
			if (i + 1 < rest.length) {
				const next = rest[i + 1];
				if (next && !next.startsWith("--")) {
					v = next;
					i++;
				}
			}
			args[k] = v;
		}
	}
	if (!cmd) {
		console.log(
			"connector-ext v0.4\n" +
				"  memory_brief [--repo R] [--branch B] [--graph G] [--surface S]\n" +
				"  memory_write --scope S --kind K --text T [--surface S]\n" +
				"  events_emit --kind K --summary S [--graph G] [--surface S]\n" +
				"  graph_get --graph G\n" +
				"  handoff --graph G [--summary S]\n" +
				"Env: SUBSTRATE_URL, SUBSTRATE_TOKEN, CONNECTOR_USE_CLI=1",
		);
		process.exit(0);
	}
	let out: unknown;
	switch (cmd) {
		case "memory_brief":
		case "brief":
			out = await memory_brief(args as unknown as { repo?: string; branch?: string; graph_id?: string; surface?: string });
			break;
		case "memory_write":
		case "write":
			if (!args.scope || !args.kind || !args.text) {
				console.error("memory_write requires --scope --kind --text");
				process.exit(2);
			}
			out = await memory_write({
				scope: args.scope,
				kind: args.kind,
				text: args.text,
				surface: args.surface,
			});
			break;
		case "events_emit":
		case "emit":
			if (!args.kind || !args.summary) {
				console.error("events_emit requires --kind --summary");
				process.exit(2);
			}
			out = await events_emit({
				kind: args.kind,
				summary: args.summary,
				graph_id: args.graph,
				surface: args.surface,
			});
			break;
		case "graph_get":
		case "graph":
			if (!args.graph) {
				console.error("graph_get requires --graph");
				process.exit(2);
			}
			out = await graph_get(args.graph);
			break;
		case "handoff":
			out = await handoffEvent({ graph_id: args.graph, summary: args.summary });
			break;
		default:
			console.error("unknown cmd", cmd);
			process.exit(2);
	}
	if (typeof out === "string") {
		process.stdout.write(out + "\n");
	} else {
		process.stdout.write(JSON.stringify(out, null, 2) + "\n");
	}
}

if (import.meta.main) {
	main().catch((e) => {
		console.error("[connector-ext] fatal (fail-open surface):", String(e));
		process.exit(0); // still 0 so caller not blocked
	});
}

export const version = "0.4.0";