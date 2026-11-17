import { expect, mock, spyOn } from "bun:test";
import { AuditUnavailableError, type AuditRecord } from "@substrate/audit";
import { z } from "zod";
import { createReadThroughCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { GreptimeClient, type EventQuery } from "./greptime.ts";
import { auditToolCalls, createObservability, type McpToolCall } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { createTestLiveSessionAuthority } from "./planning/live-session.test-support.ts";
import type { LiveSessionAuditPort } from "./planning/steering-tools.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./planning/steering.ts";
import type { SubstrateEvent } from "./types.ts";

export const OWNER = { surface: "cursor", isOperator: false } as const;
export const FOREIGN = { surface: "hermes", isOperator: false } as const;
export const OPERATOR = { surface: "omp", isOperator: true } as const;
export const AUTH_OWNER = { authorization: "Bearer tok-live-cursor" };
export const AUTH_FOREIGN = { authorization: "Bearer tok-live-hermes" };
export const AUTH_OPERATOR = { authorization: "Bearer test-live-omp" };
export const UNKNOWN = `ls_${"f".repeat(64)}`;
export const NOT_FOUND = { status: "refused", error: { code: "not-found" } } as const;
export const UNAVAILABLE = { status: "refused", error: { code: "session-unavailable" } } as const;
export const AUDIT_UNAVAILABLE = { status: "refused", error: { code: "audit-unavailable" } } as const;
export const issued = (value: unknown) => z.object({ status: z.literal("issued"), session_id: z.string(), session_binding: z.string(), expires_at: z.string() }).parse(value);

/** Actual producer/query orchestration uses this deterministic transport-boundary ledger. */
export class RecordingLedger extends GreptimeClient {
	readonly events: SubstrateEvent[] = [];
	reads = 0;
	readBarrier: Promise<void> | null = null;
	sqlReads = 0;
	sqlBarrier: Promise<void> | null = null;
	constructor() { super({ url: "http://127.0.0.1:1", user: undefined, password: undefined, db: "public" }); }
	override async ensureAppendMode(): Promise<boolean> { return true; }
	override async lastHash(sessionId: string): Promise<string | null> { return this.events.findLast((event) => event.session_id === sessionId)?.hash ?? null; }
	override async sql(): Promise<Array<Record<string, unknown>>> {
		this.sqlReads++;
		if (this.sqlBarrier !== null) await this.sqlBarrier;
		return [];
	}
	override async insertEvent(event: SubstrateEvent): Promise<void> { this.events.push(structuredClone(event)); }
	override async queryEvents(query: EventQuery = {}): Promise<Array<Record<string, unknown>>> {
		const rows = this.events.filter((event) => Object.entries(query.match ?? {}).every(([key, value]) => value == null || event[key as keyof SubstrateEvent] === value));
		if (query.order !== "asc") rows.reverse();
		return rows.slice(0, query.limit ?? 100).map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) }));
	}
	override async readEvents(column: "session_id" | "graph_id", value: string): Promise<Array<Record<string, unknown>>> {
		this.reads++;
		if (this.readBarrier !== null) await this.readBarrier;
		return this.events.filter((event) => event[column] === value).map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) }));
	}
}
export class History implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> { this.entries.push(entry); }
}
export async function settle(condition: () => boolean): Promise<void> {
	for (let turn = 0; turn < 2000 && !condition(); turn++) {
		const next = Promise.withResolvers<void>(); setImmediate(next.resolve); await next.promise;
	}
	expect(condition()).toBe(true);
}
const stops: Array<() => Promise<void>> = [];
export async function cleanupLiveHarness(): Promise<void> { for (const stop of stops.splice(0)) await stop(); mock.restore(); }

export async function serveLive(extra: Record<string, string | undefined> = {}, options: { missingAudit?: boolean; nowMs?: () => number } = {}) {
	const env = {
		SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", SUBSTRATE_BRIEF_SESSIONS: "on",
		SUBSTRATE_TOKEN_CURSOR: "tok-live-cursor", SUBSTRATE_TOKEN_HERMES: "tok-live-hermes", SUBSTRATE_TOKEN_OMP: "test-live-omp", SUBSTRATE_OPERATOR_TOKENS: "test-live-omp",
		SUBSTRATE_BUDGETS: "off", LIGHTRAG_URL: "http://127.0.0.1:1", ...extra,
	};
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const authority = createTestLiveSessionAuthority({ nowMs: options.nowMs?.() ?? Date.now() });
	const ledger = new RecordingLedger();
	const history = new History();
	const cache = createReadThroughCache(config);
	const cacheReads = spyOn(cache, "getOrLoad");
	const auditRecords: AuditRecord[] = [];
	const batches: McpToolCall[][] = [];
	const retrieval: { barrier: Promise<void> | null; reads: number; inputs: string[] } = { barrier: null, reads: 0, inputs: [] };
	let failAudit = false;
	const append = observability.audit.append.bind(observability.audit);
	spyOn(observability.audit, "append").mockImplementation(async (input) => {
		if (failAudit && input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, "test audit unavailable");
		const written = await append(input); auditRecords.push(written.record); return written;
	});
	const port: LiveSessionAuditPort = { auditCalls: async (caller, calls, transport) => { batches.push(calls); return auditToolCalls(observability, caller.surface, calls, transport); } };
	const substrate = new Substrate(config, {
		index: null, greptime: ledger, cache,
		lightragFetch: async (_input, init) => {
			retrieval.reads++; retrieval.inputs.push(JSON.stringify(init?.body ?? null));
			if (retrieval.barrier !== null) await retrieval.barrier;
			return new Response("unavailable", { status: 503 });
		},
		hindsightFetch: async () => new Response("unavailable", { status: 503 }),
		steering: { history, liveSessions: authority, nowMs: options.nowMs ?? Date.now, report: () => undefined },
	}, observability.observer, options.missingAudit ? undefined : port);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing loopback listener");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: unknown, headers: Record<string, string> = AUTH_OWNER) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	const get = (path: string, headers: Record<string, string> = AUTH_OWNER, signal?: AbortSignal) => fetch(`${base}${path}`, { headers, ...(signal === undefined ? {} : { signal }) });
	const rpcEnvelopes: Array<{ status: number; headers: Record<string, string> }> = [];
	const rpc = async (body: unknown, headers: Record<string, string> = AUTH_OWNER): Promise<unknown> => {
		const response = await post("/mcp", body, { accept: "application/json, text/event-stream", ...headers });
		rpcEnvelopes.push({ status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => !["date", "connection", "keep-alive", "x-request-id", "traceparent"].includes(key))) });
		const raw = await response.text();
		if (response.headers.get("content-type")?.includes("text/event-stream")) {
			const messages: unknown[] = raw.split(/\r?\n\r?\n/).flatMap((frame) => {
				const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
				return data.length === 0 ? [] : [JSON.parse(data)];
			});
			const responses = messages.filter((message) => message !== null && typeof message === "object" && "id" in message && ("result" in message || "error" in message));
			if (Array.isArray(body)) {
				const expectedIds = body.flatMap((request: unknown) => request !== null && typeof request === "object" && "id" in request ? [request.id] : []);
				const actualIds = responses.map((message) => {
					if (message === null || typeof message !== "object" || !("id" in message)) throw new Error("invalid MCP response frame");
					return message.id;
				});
				if (actualIds.length !== expectedIds.length || expectedIds.some((id) => actualIds.filter((actual) => actual === id).length !== 1)) throw new Error("MCP batch response identities do not match the request");
				return responses;
			}
			if (responses.length > 1) throw new Error("multiple MCP responses for a single request");
			return responses[0] ?? null;
		}
		return raw.length === 0 ? null : JSON.parse(raw);
	};
	stops.push(async () => {
		substrate.steeringWaiters.closeAll();
		const closing = Promise.withResolvers<void>(); server.close(() => closing.resolve()); await closing.promise;
		observability.stop();
	});
	return { base, config, observability, authority, ledger, substrate, history, cache, cacheReads, retrieval, auditRecords, batches, post, get, rpc, rpcEnvelopes, setAuditFailure: (value: boolean) => { failAudit = value; } };
}
export const call = (id: number, tool: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
export function toolValue(value: unknown): unknown {
	const reply = z.object({ result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional() }) }).parse(value);
	const text = reply.result.content.find((item) => item.type === "text")?.text;
	if (text === undefined) throw new Error("missing tool text");
	return JSON.parse(text);
}
/** Compare all application headers; only connection/date and tracing identifiers are transport-generated. */
export async function responseFingerprint(response: Response) {
	const headers = Object.fromEntries([...response.headers].filter(([key]) => !["date", "connection", "keep-alive", "x-request-id", "traceparent"].includes(key)));
	return { status: response.status, headers, body: await response.text() };
}
