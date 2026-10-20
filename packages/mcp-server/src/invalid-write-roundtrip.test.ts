/**
 * The invalid-write round trip (uplift-7 gap 23): every client-input write surface is sent a
 * payload it must refuse, and the rows that write would have touched are counted before and
 * after. A refusal that changed a row count is a partial persistence, which is what this file
 * exists to catch.
 *
 * Each refusal is also checked against the audit chain: the records appended while the request
 * ran. Which of two outcomes is asserted depends on where the door refuses:
 *  - a body refused before the audit call leaves no record at all;
 *  - a body that reaches the gate leaves exactly one record, `allowed` on its transport. The
 *    audit records the decision to dispatch before the handler runs, so a handler refusal that
 *    follows does not change the record.
 * Moving a refusal across the audit call flips which outcome holds, and these assertions catch it.
 *
 * MCP calls go over `POST /mcp` (streamable HTTP) through the SDK client: the door production
 * serves. Checked 2026-10-20 against the audit path:
 *  - REST: `auditedRest` (server.ts:534) runs at `/memory` server.ts:1086, `/docs/ingest` :1297,
 *    `/skills/propose` :1414 and `/skills/approve` :1445. Each is preceded by the shape check that
 *    refuses a non-object body before any record (`/memory` :1070-1085, `/docs/ingest` :1255-1296;
 *    `/skills/*` skip the audit when the body is not an object, `fields &&` at :1414 and :1445).
 *  - MCP: `handleMcp` (server.ts:1722) calls `auditToolCalls` (server.ts:1751) before it creates the
 *    MCP server (:1759). `auditToolCalls` (observe.ts:679) appends `allowed` per `tools/call` before
 *    dispatch, so an argument the SDK then rejects still has its record.
 *  - The chain is memory-only here (`SUBSTRATE_AUDIT_PATH` unset): `AuditLog.append` commits without a
 *    file (audit/src/log.ts:434-440) and `recent` returns the retained records (log.ts:622).
 * The in-process harness this file used before built `createMcpServer` directly, so it never reached
 * `handleMcp` and produced no audit record by construction.
 *
 * Each suite first sends one valid control. A count that does not move on a valid write would
 * make every zero-delta assertion meaningless, so the control is what shows the counter works.
 *
 * The Postgres-backed suites (memory, skills) are skipped without `SUBSTRATE_TEST_PG_URL`, the
 * way the `index-store.*.test.ts` files are. The docs suite runs against the RAGFlow fake and
 * needs no database.
 *
 * Isolation: every write carries `ut-iwr-<RUN>` in its scope, skill name or explicit
 * idempotency key, and `afterAll` deletes by that marker. The counts are whole-table, which
 * assumes nothing else writes these tables during the run; bun runs one file's tests in order.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test invalid-write-roundtrip
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AuditRecord } from "@substrate/audit";
import { loadConfig } from "./config.ts";
import { IndexStore } from "./index-store.ts";
import { createObservability, type Observability } from "./observe.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { ProposeResult, Runner, SkillProposer } from "./skills/propose.ts";
import { APPROVAL_RULES } from "./skills/registry.ts";
import type { SubstrateEvent } from "./types.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
/** In every scope, skill name and idempotency key this file writes, so cleanup finds them and nothing else. */
const MARKER = `ut-iwr-${RUN}`;

const describeLive = PG_URL ? describe : describe.skip;

/** Defaults shared by every harness: one surface token, listed as an operator, budgets off. */
const BASE_ENV: Record<string, string> = {
	SUBSTRATE_TOKEN_OMP: "tok-omp",
	SUBSTRATE_OPERATOR_TOKENS: "tok-omp",
	SUBSTRATE_BUDGETS: "off",
	RAGFLOW_URL: "http://ragflow.test",
	RAGFLOW_API_KEY: "k",
};

const TOKEN = "tok-omp";
/** The MCP cases run as the omp surface without operator rights, as the in-process caller did before. */
const NON_OPERATOR = { SUBSTRATE_OPERATOR_TOKENS: "" };

/** The REST door and the MCP door over a socket, with the audit chain the door appends to. */
interface HttpHarness {
	/** POST a JSON value, or send a string verbatim. */
	send(path: string, body: unknown, token?: string | null): Promise<Response>;
	/** An MCP client over streamable HTTP: each call is a `POST /mcp`, through the same audit gate production runs. */
	mcp(): Promise<Client>;
	readonly audit: Observability["audit"];
}

/** A ledger that accepts every append and keeps nothing, so refusal events cannot fail a request. */
function ledgerStub() {
	const written: SubstrateEvent[] = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
			queryEvents: async () => [],
			readEvents: async () => [],
			graphIngest: async () => [],
			firstIngestMs: async () => null,
			hasEvent: async () => false,
		},
	};
}

const stops: Array<() => void> = [];

/** Starts the real REST and MCP door on an ephemeral port, over the given stores. */
async function startHttp(stores: Record<string, unknown>, env: Record<string, string> = {}): Promise<HttpHarness> {
	const merged = { ...BASE_ENV, ...env };
	const config = loadConfig(merged);
	const observability: Observability = createObservability(config, merged);
	await observability.start();
	const substrate = new Substrate(config, stores as never, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the test server has no port");
	const base = `http://127.0.0.1:${address.port}`;
	stops.push(() => {
		observability.stop();
		server.close();
	});
	return {
		audit: observability.audit,
		send(path, body, token = TOKEN) {
			return fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
		},
		async mcp() {
			const client = new Client({ name: "invalid-write-roundtrip", version: "0.0.0" });
			const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
				requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
			});
			await client.connect(transport);
			stops.push(() => {
				client.close().catch(() => undefined);
			});
			return client;
		},
	};
}

/**
 * Calls a tool and reports whether it refused. Two shapes count as a refusal, and only the one this call produces:
 *  - the SDK's input validation for this tool: an `isError` reply reading `Invalid arguments for tool <name>:` (SDK 1.32
 *    prefixes it with `Input validation error:`), which a missing field, a wrong type or a value outside an enum gets;
 *  - the tool's own refusal: an `isError` reply whose text is a JSON object carrying the refusal field its handler sets (see REFUSAL_BODY).
 * A non-object argument list never reaches a tool. The protocol rejects the request, and the client gets a thrown McpError
 * with code InternalError whose message is zod's `expected record` error on `arguments`.
 * A call that succeeds is not a refusal (false). Anything else fails the test on the real fault instead of passing as a
 * refusal: a handler crash (the SDK answers it as an `isError` reply carrying the bare error message), `Tool <name> not
 * found`, or a reply that is neither shape.
 */
async function refuses(client: Client, name: string, args: unknown): Promise<boolean> {
	let result;
	try {
		result = await client.callTool({ name, arguments: args as Record<string, unknown> });
	} catch (err: unknown) {
		if (err instanceof McpError && err.code === ErrorCode.InternalError && /expected record/.test(err.message) && /"arguments"/.test(err.message)) {
			return true;
		}
		throw err;
	}
	if (result.isError !== true) return false;
	const text = textOf(result);
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`^(MCP error -?\\d+: )?(Input validation error: )?Invalid arguments for tool ${escaped}: `).test(text)) return true;
	if (isRefusalBody(name, text)) return true;
	throw new Error(`${name} failed, and not as a refusal: ${text.slice(0, 200)}`);
}

/** The text of a tool reply's first block, or "" when it has none. */
function textOf(result: unknown): string {
	const content = result !== null && typeof result === "object" && "content" in result ? result.content : undefined;
	const blocks: unknown[] = Array.isArray(content) ? content : [];
	const first = blocks[0];
	return first !== null && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}

/**
 * The refusal field each tool's handler sets on its JSON reply, tested on the parsed object. A JSON object that fails
 * its tool's test is not a refusal: a handler crash whose message happens to be JSON fails here.
 *  - `docs_ingest`: `refused: true`, the shape of every refused ingest (docs-ingest.ts:202, :343; mcp.ts:928).
 *  - `skills_approve`: `rule`, one of APPROVAL_RULES, on every value refusal (registry.ts:69, :176-179, :210-212; mcp.ts:1126).
 *  - `skills_propose`: `refused: true` on every refusal and denial (request.ts:81, :84). The failure body (request.ts:87)
 *    carries no marker, so a handler crash whose message happens to be a JSON object is not accepted.
 * `memory_write` answers no JSON refusal (mcp.ts:348 sends no `isError`), so any JSON reply from it is not one.
 */
const REFUSAL_BODY: Record<string, (body: Record<string, unknown>) => boolean> = {
	docs_ingest: (body) => body.refused === true,
	skills_approve: (body) => typeof body.rule === "string" && (APPROVAL_RULES as readonly string[]).includes(body.rule),
	skills_propose: (body) => body.refused === true,
};

/** Whether a reply's text is the refusal body of `name`: a JSON object carrying that tool's refusal field. */
function isRefusalBody(name: string, text: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const refusalBody = Object.hasOwn(REFUSAL_BODY, name) ? REFUSAL_BODY[name] : undefined;
	return refusalBody !== undefined && refusalBody(parsed as Record<string, unknown>);
}

/** The first text block of a tool reply, parsed. A non-JSON reply parses to `undefined`. */
async function replyOf(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
	const result = await client.callTool({ name, arguments: args });
	const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
	const first = blocks[0];
	const text = first !== null && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "{}";
	const parsed: unknown = JSON.parse(text);
	return parsed;
}

/** The `entry.id` of an accepted memory reply, or a throw naming what was missing. */
function entryIdOf(reply: unknown): string {
	if (reply !== null && typeof reply === "object" && "entry" in reply) {
		const entry = reply.entry;
		if (entry !== null && typeof entry === "object" && "id" in entry && typeof entry.id === "string") return entry.id;
	}
	throw new Error("the reply carried no entry id");
}

/** The ways a JSON body is not an object, sent verbatim. The last is not JSON at all. */
const NON_OBJECT_BODIES: Array<[string, string]> = [
	["null", "null"],
	["an array", "[]"],
	["a string", '"graph:ut-iwr"'],
	["a number", "42"],
	["malformed JSON", '{"scope":'],
];

/**
 * The 400 reason for a body that is not a JSON object. Malformed JSON is answered by the JSON parse, which every route
 * shares; a parseable value that is not an object is answered by the route's own check, named by `notAnObject`.
 */
function refusalReason(payload: string, notAnObject: string): string {
	try {
		JSON.parse(payload);
	} catch {
		return "request body is not valid JSON";
	}
	return notAnObject;
}

/** A body with one key removed. */
function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
	const { [key]: _removed, ...rest } = body;
	return rest;
}

/**
 * The audit records appended after position `mark`, oldest first. The chain is memory-only in this file, so its retained
 * buffer holds every record a request wrote.
 */
function auditAfter(audit: Observability["audit"], mark: number): AuditRecord[] {
	return audit.recent(1_000).filter((record) => record.seq > mark);
}

/** The fields of audit records that say what happened: the tool, the door and the decision. */
function auditedFields(records: AuditRecord[]): Array<{ tool: string; transport: string; decision: string }> {
	return records.map(({ tool, transport, decision }) => ({ tool, transport, decision }));
}

/** What a request that reached the gate leaves in the chain: one `allowed` record on its door, written before dispatch. */
function reachedGate(tool: string, transport: "rest" | "mcp"): Array<{ tool: string; transport: string; decision: string }> {
	return [{ tool, transport, decision: "allowed" }];
}

// ── Postgres-backed state, shared by the three live suites ──────────────────────────────────────

let raw: SQL;
let store: IndexStore;
const MEMORY_TABLES = ["memory_entries", "memory_writes", "memory_quarantine", "memory_reviews"] as const;
const SKILL_TABLES = ["skills_registry"] as const;

async function countRows(table: string): Promise<number> {
	// `table` is always one of the constants above, never caller input.
	const found: unknown = await raw.unsafe(`select count(*)::int as n from ${table}`);
	const first: unknown = Array.isArray(found) ? found[0] : undefined;
	if (first !== null && typeof first === "object" && "n" in first && typeof first.n === "number") return first.n;
	throw new Error(`could not count ${table}`);
}

async function rowCounts(tables: readonly string[]): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of tables) counts[table] = await countRows(table);
	return counts;
}

/** The registry rows of one skill name, with the columns a decision changes: state and who decided when. */
async function registryState(name: string): Promise<unknown> {
	return raw`select pr_number, state, decided_by, decided_at from skills_registry where name = ${name} order by pr_number`;
}

async function cleanup(): Promise<void> {
	const like = `${MARKER}%`;
	await raw`delete from memory_entries where scope like ${`graph:${like}`}`.catch(() => undefined);
	await raw`delete from memory_quarantine where scope like ${`graph:${like}`}`.catch(() => undefined);
	await raw`delete from memory_reviews where body like ${`%${MARKER}%`}`.catch(() => undefined);
	await raw`delete from memory_writes where idempotency_key like ${like}`.catch(() => undefined);
	await raw`delete from skills_registry where name like ${like}`.catch(() => undefined);
}

beforeAll(async () => {
	if (!PG_URL) return;
	raw = new SQL(PG_URL);
	store = new IndexStore(PG_URL);
	await store.migrate();
	await cleanup();
});

afterAll(async () => {
	for (const stop of stops) stop();
	if (!PG_URL) return;
	await cleanup();
	await raw.end().catch(() => undefined);
	await store.close().catch(() => undefined);
});

// ── POST /memory and MCP memory_write ───────────────────────────────────────────────────────────

describeLive("memory writes: POST /memory and MCP memory_write", () => {
	const ledger = ledgerStub();
	const valid = {
		scope: `graph:${MARKER}-memory`,
		kind: "fact",
		text: `${MARKER} the cache TTL is thirty seconds`,
		idempotency_key: `${MARKER}-memory-ok`,
	};
	/** Invalid payloads. Each has its own key, so a claim that slipped through would be found and cleaned. */
	const invalid: Array<[string, Record<string, unknown>]> = [
		["a missing required field (text)", { ...without(valid, "text"), idempotency_key: `${MARKER}-memory-inv-text-missing` }],
		["a missing required field (scope)", { ...without(valid, "scope"), idempotency_key: `${MARKER}-memory-inv-scope-missing` }],
		["a wrong type (kind is a number)", { ...valid, kind: 7, idempotency_key: `${MARKER}-memory-inv-kind` }],
		["a wrong type (text is a number)", { ...valid, text: 42, idempotency_key: `${MARKER}-memory-inv-text` }],
	];

	describe("POST /memory", () => {
		let http: HttpHarness;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledger.greptime });
		});

		test("a valid control is accepted, read back, moves the row count by one, and is audited once", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const mark = http.audit.seq;
			const response = await http.send("/memory", valid);
			const reply: unknown = await response.json();

			expect(response.status).toBe(200);
			expect(reply).toMatchObject({ outcome: "accepted", verified_persisted: true });
			expect(await store.readEntry(entryIdOf(reply))).not.toBeNull();
			expect((await rowCounts(MEMORY_TABLES)).memory_entries).toBe(before.memory_entries! + 1);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "rest"));
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with the policy status 403, records the refusal, writes no row, and is audited once`, async () => {
				const before = await rowCounts(MEMORY_TABLES);
				const denialsBefore = ledger.written.filter((event) => event.kind === "warning" && event.payload.outcome === "denied").length;
				const mark = http.audit.seq;
				const response = await http.send("/memory", body);

				expect(response.status).toBe(403);
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
				const denials = ledger.written.filter((event) => event.kind === "warning" && event.payload.outcome === "denied");
				expect(denials.length).toBe(denialsBefore + 1);
				expect(denials.at(-1)?.summary).toMatch(/^memory\.write denied: /);
				// An object reaches the gate (server.ts:1086) before the handler refuses it.
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "rest"));
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400, writes no row, and leaves no audit record`, async () => {
				const before = await rowCounts(MEMORY_TABLES);
				const mark = http.audit.seq;
				const response = await http.send("/memory", payload);

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error: refusalReason(payload, "request body must be a JSON object") });
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
				// Refused before the audit call (server.ts:1074-1085): a body that is not an object is never recorded.
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual([]);
			});
		}
	});

	describe("MCP memory_write", () => {
		let http: HttpHarness;
		let client: Client;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledger.greptime }, NON_OPERATOR);
			client = await http.mcp();
		});

		test("a valid control is accepted, moves the row count by one, and is audited once", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const mark = http.audit.seq;
			const reply = await replyOf(client, "memory_write", { ...valid, idempotency_key: `${MARKER}-mcp-ok` });

			expect(reply).toMatchObject({ outcome: "accepted", verified_persisted: true });
			expect((await rowCounts(MEMORY_TABLES)).memory_entries).toBe(before.memory_entries! + 1);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "mcp"));
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} at the protocol, writes no row, and is audited before dispatch`, async () => {
				const before = await rowCounts(MEMORY_TABLES);
				const mark = http.audit.seq;

				expect(await refuses(client, "memory_write", body)).toBe(true);
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "mcp"));
			});
		}

		test("refuses a non-object argument list at the protocol, writes no row, and is audited before dispatch", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const mark = http.audit.seq;

			expect(await refuses(client, "memory_write", [])).toBe(true);
			expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "mcp"));
		});

		// This write is valid against the schema and refused by policy. It is audited as a dispatch, then the gate
		// refuses it, and the gate records the denial in the ledger.
		test("a write the gate refuses is recorded as a denial, writes no row, and is audited once", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const denialsBefore = ledger.written.filter((event) => event.kind === "warning" && event.payload.outcome === "denied").length;
			const mark = http.audit.seq;
			const reply = await replyOf(client, "memory_write", {
				scope: `person:${MARKER}`,
				kind: "fact",
				text: `${MARKER} the owner is out`,
				idempotency_key: `${MARKER}-mcp-denied`,
			});

			expect(reply).toMatchObject({ outcome: "denied", reason: "rbac.no-grant" });
			expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
			const denials = ledger.written.filter((event) => event.kind === "warning" && event.payload.outcome === "denied");
			expect(denials.length).toBe(denialsBefore + 1);
			expect(denials.at(-1)?.summary).toMatch(/^memory\.write denied: rbac\.no-grant \(fact at person:/);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("memory_write", "mcp"));
		});
	});
});

// ── POST /skills/propose and MCP skills_propose ─────────────────────────────────────────────────

describeLive("skill proposals: POST /skills/propose and MCP skills_propose", () => {
	/** Every git argv the real engine was asked to run. A refused proposal must ask git nothing. */
	let gitCalls: string[] = [];
	const run: Runner = async (argv) => {
		gitCalls.push(argv.join(" "));
		return { code: 1, stdout: "", stderr: "spy: no git in this test" };
	};
	const name = `${MARKER}-skill`;
	const valid = {
		name,
		files: { "SKILL.md": `---\nname: ${name}\ndescription: a demo\n---\nbody\n` },
		rationale: `${MARKER} worth keeping`,
	};
	/** Invalid payloads that the route or the engine must refuse before any git call. */
	const invalid: Array<[string, Record<string, unknown>]> = [
		["a missing required field (name)", without(valid, "name")],
		["a wrong type (files is an array)", { ...valid, files: ["SKILL.md"] }],
		["a wrong type (rationale is a number)", { ...valid, rationale: 7 }],
		["a skill name that breaks the rule", { ...valid, name: "Not A Valid Name" }],
		["a missing SKILL.md (engine refusal)", { ...valid, files: { "README.md": "hello" } }],
	];
	const governed = { SUBSTRATE_SKILLS_GOVERNANCE: "report" };

	describe("POST /skills/propose", () => {
		let http: HttpHarness;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime, skillRun: run }, governed);
		});

		test("a valid control is opened, records one registry row, and is audited once", async () => {
			const proposer: SkillProposer = {
				propose: async (): Promise<ProposeResult> => ({
					status: "opened",
					pr_url: "https://github.com/swcstudiospace/agent-skills/pull/4242",
					pr_number: 4242,
					branch: `skill/omp/${name}-1-abcd`,
					content_sha256: "ab".repeat(32),
					redactions: [],
				}),
			};
			const control = await startHttp({ index: store, greptime: ledgerStub().greptime, skills: proposer }, governed);
			const before = await rowCounts(SKILL_TABLES);
			const mark = control.audit.seq;
			const response = await control.send("/skills/propose", valid);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: "opened" });
			expect((await rowCounts(SKILL_TABLES)).skills_registry).toBe(before.skills_registry! + 1);
			expect(auditedFields(auditAfter(control.audit, mark))).toEqual(reachedGate("skills_propose", "rest"));
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with 400, asks git nothing, writes no row, and is audited once`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);
				const rowsBefore = await registryState(name);
				const mark = http.audit.seq;
				const response = await http.send("/skills/propose", body);

				expect(response.status).toBe(400);
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(name)).toEqual(rowsBefore);
				// An object reaches the audit (server.ts:1414) before the field check.
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("skills_propose", "rest"));
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400, asks git nothing, writes no row, and leaves no audit record`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);
				const rowsBefore = await registryState(name);
				const mark = http.audit.seq;
				const response = await http.send("/skills/propose", payload);

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error: refusalReason(payload, "body must be a JSON object") });
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(name)).toEqual(rowsBefore);
				// A body that is not an object skips the audit (server.ts:1414, `fields &&`).
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual([]);
			});
		}
	});

	describe("MCP skills_propose", () => {
		// Governance is `report`, as on the REST door: the registry is written only under report or enforce, so with it
		// off the registry assertions could never see a row.
		let http: HttpHarness;
		let client: Client;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime, skillRun: run }, { ...governed, ...NON_OPERATOR });
			client = await http.mcp();
		});

		test("a valid control is opened, records one registry row, and is audited once", async () => {
			const proposer: SkillProposer = {
				propose: async (): Promise<ProposeResult> => ({
					status: "opened",
					pr_url: "https://github.com/swcstudiospace/agent-skills/pull/4343",
					pr_number: 4343,
					branch: `skill/omp/${name}-1-efgh`,
					content_sha256: "ef".repeat(32),
					redactions: [],
				}),
			};
			const control = await startHttp({ index: store, greptime: ledgerStub().greptime, skills: proposer }, { ...governed, ...NON_OPERATOR });
			const controlClient = await control.mcp();
			const before = await rowCounts(SKILL_TABLES);
			const mark = control.audit.seq;
			const reply = await replyOf(controlClient, "skills_propose", valid);

			expect(reply).toMatchObject({ status: "opened" });
			expect((await rowCounts(SKILL_TABLES)).skills_registry).toBe(before.skills_registry! + 1);
			expect(await registryState(name)).toContainEqual({ pr_number: 4343, state: "proposed", decided_by: null, decided_at: null });
			expect(auditedFields(auditAfter(control.audit, mark))).toEqual(reachedGate("skills_propose", "mcp"));
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label}, writes no row, and is audited before dispatch`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);
				// Counts alone cannot see an UPDATE: the row of `name`, written by the control above, is compared as well.
				const rowsBefore = await registryState(name);
				const mark = http.audit.seq;

				expect(await refuses(client, "skills_propose", body)).toBe(true);
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(name)).toEqual(rowsBefore);
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("skills_propose", "mcp"));
			});
		}

		test("refuses a non-object argument list, writes no row, and is audited before dispatch", async () => {
			gitCalls = [];
			const before = await rowCounts(SKILL_TABLES);
			const rowsBefore = await registryState(name);
			const mark = http.audit.seq;

			expect(await refuses(client, "skills_propose", [])).toBe(true);
			expect(gitCalls).toEqual([]);
			expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			expect(await registryState(name)).toEqual(rowsBefore);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("skills_propose", "mcp"));
		});
	});
});

// ── POST /skills/approve and MCP skills_approve ─────────────────────────────────────────────────

describeLive("skill approvals: POST /skills/approve and MCP skills_approve", () => {
	const valid = { name: `${MARKER}-approve`, pr_number: 4242, decision: "approve" };
	/** Invalid decisions. Each is refused before the registry or `gh` is touched. */
	const invalid: Array<[string, Record<string, unknown>]> = [
		["a missing required field (pr_number)", without(valid, "pr_number")],
		["a wrong type (pr_number is a string)", { ...valid, pr_number: "4242" }],
		["a wrong type (decision is a number)", { ...valid, decision: 1 }],
		["a decision outside the set", { ...valid, decision: "merge" }],
		["a name that breaks the rule", { ...valid, name: "Not_A_Name" }],
	];

	/** The seeded proposal, undecided: the row every refused decision must leave exactly as it is. */
	const PENDING = [{ pr_number: valid.pr_number, state: "proposed", decided_by: null, decided_at: null }];

	beforeAll(async () => {
		await store.upsertProposedSkill({
			repo: loadConfig(BASE_ENV).skills.repo,
			name: valid.name,
			pr_number: valid.pr_number,
			pr_url: `https://github.com/swcstudiospace/agent-skills/pull/${valid.pr_number}`,
			branch: null,
			content_sha256: "cd".repeat(32),
			proposed_by: "omp",
		});
	});

	test("the seeded proposal is pending and undecided", async () => {
		expect(await registryState(valid.name)).toEqual(PENDING);
	});

	describe("POST /skills/approve", () => {
		let http: HttpHarness;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime });
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with 400, writes no registry row, and is audited once`, async () => {
				const before = await rowCounts(SKILL_TABLES);
				const mark = http.audit.seq;
				const response = await http.send("/skills/approve", body);

				expect(response.status).toBe(400);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(valid.name)).toEqual(PENDING);
				// An object reaches the audit (server.ts:1445) before the field check.
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("skills_approve", "rest"));
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400, writes no registry row, and leaves no audit record`, async () => {
				const before = await rowCounts(SKILL_TABLES);
				const mark = http.audit.seq;
				const response = await http.send("/skills/approve", payload);

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error: refusalReason(payload, "body must be a JSON object") });
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(valid.name)).toEqual(PENDING);
				// A body that is not an object skips the audit (server.ts:1445, `fields &&`).
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual([]);
			});
		}
	});

	describe("MCP skills_approve", () => {
		let http: HttpHarness;
		let client: Client;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime });
			client = await http.mcp();
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label}, writes no registry row, and is audited before dispatch`, async () => {
				const before = await rowCounts(SKILL_TABLES);
				const mark = http.audit.seq;

				expect(await refuses(client, "skills_approve", body)).toBe(true);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
				expect(await registryState(valid.name)).toEqual(PENDING);
				expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("skills_approve", "mcp"));
			});
		}
	});
});

// ── POST /docs/ingest and MCP docs_ingest ───────────────────────────────────────────────────────
// No database: the rows that matter are the uploads the RAGFlow fake takes.

describe("docs ingest: POST /docs/ingest and MCP docs_ingest", () => {
	const page = (over: Record<string, unknown> = {}) => ({
		path: "docs/data-planes.md",
		source_url: `https://example.com/${MARKER}/planes`,
		body: `${MARKER} the substrate is the only door.`,
		...over,
	});
	const valid = { dataset: "agent-substrate", pages: [page()] };
	/**
	 * Refused batches. None may reach an upload. The third field says where the door refuses: `false` is the shape check
	 * before the audit call (server.ts:1262-1296), so no record is written; `true` is a batch the shape check passes, which
	 * reaches `auditedRest` (server.ts:1297) and is refused by the service after it.
	 */
	const invalid: Array<[string, Record<string, unknown>, boolean]> = [
		["a missing required field (dataset)", without(valid, "dataset"), false],
		["a wrong type (pages is a string)", { ...valid, pages: "docs/data-planes.md" }, false],
		["a wrong type (page path is a number)", { ...valid, pages: [page({ path: 7 })] }, false],
		["a wrong type (page body is missing)", { ...valid, pages: [without(page(), "body")] }, false],
		["a page with no source URL", { ...valid, pages: [without(page(), "source_url")] }, true],
		["an unknown dataset", { ...valid, dataset: "no-such-dataset" }, true],
		[
			"a valid page followed by an invalid one (the valid page must not upload)",
			{ ...valid, pages: [page({ path: "docs/first.md" }), without(page({ path: "docs/second.md" }), "source_url")] },
			true,
		],
	];

	test("a valid control is stored, makes exactly one upload, and is audited once", async () => {
		const fake = new RagflowFake();
		const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
		const mark = http.audit.seq;
		const response = await http.send("/docs/ingest", valid);

		expect(response.status).toBe(200);
		expect(fake.uploads).toHaveLength(1);
		expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("docs_ingest", "rest"));
	});

	for (const [label, body, reachesGate] of invalid) {
		const audit = reachesGate ? "is audited once" : "leaves no audit record";
		test(`POST /docs/ingest refuses ${label} with 400, uploads nothing, and ${audit}`, async () => {
			const fake = new RagflowFake();
			const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
			const mark = http.audit.seq;
			const response = await http.send("/docs/ingest", body);

			expect(response.status).toBe(400);
			expect(fake.uploads).toEqual([]);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachesGate ? reachedGate("docs_ingest", "rest") : []);
		});
	}

	for (const [label, payload] of NON_OBJECT_BODIES) {
		test(`POST /docs/ingest refuses ${label} with 400, uploads nothing, and leaves no audit record`, async () => {
			const fake = new RagflowFake();
			const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
			const mark = http.audit.seq;
			const response = await http.send("/docs/ingest", payload);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: refusalReason(payload, "request body must be a JSON object") });
			expect(fake.uploads).toEqual([]);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual([]);
		});
	}

	for (const [label, body] of invalid) {
		test(`MCP docs_ingest refuses ${label}, uploads nothing, and is audited before dispatch`, async () => {
			const fake = new RagflowFake();
			const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch }, NON_OPERATOR);
			const client = await http.mcp();
			const mark = http.audit.seq;

			expect(await refuses(client, "docs_ingest", body)).toBe(true);
			expect(fake.uploads).toEqual([]);
			expect(auditedFields(auditAfter(http.audit, mark))).toEqual(reachedGate("docs_ingest", "mcp"));
		});
	}
});
