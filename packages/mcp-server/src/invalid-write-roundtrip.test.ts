/**
 * The invalid-write round trip (uplift-7 gap 23): every client-input write surface is sent a
 * payload it must refuse, and the rows that write would have touched are counted before and
 * after. A refusal that changed a row count is a partial persistence, which is what this file
 * exists to catch.
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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { IndexStore } from "./index-store.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { createObservability, type Observability } from "./observe.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { ProposeResult, Runner, SkillProposer } from "./skills/propose.ts";
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
const OMP: McpCaller = { surface: "omp", isOperator: false };
const OPERATOR: McpCaller = { surface: "omp", isOperator: true };

/** The REST door over a socket. `send` posts a JSON value, or sends a string verbatim. */
interface HttpHarness {
	send(path: string, body: unknown, token?: string | null): Promise<Response>;
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

/** Starts the real REST door on an ephemeral port, over the given stores. */
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
		send(path, body, token = TOKEN) {
			return fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
		},
	};
}

/** Connects the MCP door in memory, over the given stores, for one caller. */
async function connectMcp(stores: Record<string, unknown>, caller: McpCaller): Promise<Client> {
	const substrate = new Substrate(loadConfig(BASE_ENV), stores as never);
	const server = createMcpServer(substrate, caller);
	const client = new Client({ name: "invalid-write-roundtrip", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/**
 * Calls a tool and reports whether it refused. 
 * - Accepts isError results.
 * - For thrown errors, only counts as refusal if the message indicates bad input (argument error).
 * - Unexpected handler errors or missing tools are re-thrown so they fail the test (row counts would be unchanged but for the wrong reason).
 */
async function refuses(client: Client, name: string, args: unknown): Promise<boolean> {
	try {
		const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
		if (result.isError === true) return true;
		return false;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/invalid|must be|required|argument|type/i.test(msg)) return true;
		throw err;
	}
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

/** A body with one key removed. */
function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
	const { [key]: _removed, ...rest } = body;
	return rest;
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
			http = await startHttp({ index: store, greptime: ledgerStub().greptime });
		});

		test("a valid control is accepted, read back, and moves the row count by one", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const response = await http.send("/memory", valid);
			const reply: unknown = await response.json();

			expect(response.status).toBe(200);
			expect(reply).toMatchObject({ outcome: "accepted", verified_persisted: true });
			expect(await store.readEntry(entryIdOf(reply))).not.toBeNull();
			expect((await rowCounts(MEMORY_TABLES)).memory_entries).toBe(before.memory_entries! + 1);
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with the policy status 403 and writes no row`, async () => {
				const before = await rowCounts(MEMORY_TABLES);
				const response = await http.send("/memory", body);

				expect(response.status).toBe(403);
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400 and writes no row`, async () => {
				const before = await rowCounts(MEMORY_TABLES);
				const response = await http.send("/memory", payload);

				expect(response.status).toBe(400);
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
			});
		}
	});

	describe("MCP memory_write", () => {
		let client: Client;
		beforeAll(async () => {
			client = await connectMcp({ index: store, greptime: ledgerStub().greptime }, OMP);
		});

		test("a valid control is accepted and moves the row count by one", async () => {
			const before = await rowCounts(MEMORY_TABLES);
			const reply = await replyOf(client, "memory_write", { ...valid, idempotency_key: `${MARKER}-mcp-ok` });

			expect(reply).toMatchObject({ outcome: "accepted", verified_persisted: true });
			expect((await rowCounts(MEMORY_TABLES)).memory_entries).toBe(before.memory_entries! + 1);
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} at the protocol and writes no row`, async () => {
				const before = await rowCounts(MEMORY_TABLES);

				expect(await refuses(client, "memory_write", body)).toBe(true);
				expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
			});
		}

		test("refuses a non-object argument list and writes no row", async () => {
			const before = await rowCounts(MEMORY_TABLES);

			expect(await refuses(client, "memory_write", [])).toBe(true);
			expect(await rowCounts(MEMORY_TABLES)).toEqual(before);
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

	describe("POST /skills/propose", () => {
		let http: HttpHarness;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime, skillRun: run }, { SUBSTRATE_SKILLS_GOVERNANCE: "report" });
		});

		test("a valid control is opened and records one registry row", async () => {
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
			const control = await startHttp({ index: store, greptime: ledgerStub().greptime, skills: proposer }, { SUBSTRATE_SKILLS_GOVERNANCE: "report" });
			const before = await rowCounts(SKILL_TABLES);
			const response = await control.send("/skills/propose", valid);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: "opened" });
			expect((await rowCounts(SKILL_TABLES)).skills_registry).toBe(before.skills_registry! + 1);
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with 400, asks git nothing, and writes no row`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);
				const response = await http.send("/skills/propose", body);

				expect(response.status).toBe(400);
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400, asks git nothing, and writes no row`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);
				const response = await http.send("/skills/propose", payload);

				expect(response.status).toBe(400);
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			});
		}
	});

	describe("MCP skills_propose", () => {
		let client: Client;
		beforeAll(async () => {
			client = await connectMcp({ index: store, greptime: ledgerStub().greptime, skillRun: run }, OMP);
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} and writes no row`, async () => {
				gitCalls = [];
				const before = await rowCounts(SKILL_TABLES);

				expect(await refuses(client, "skills_propose", body)).toBe(true);
				expect(gitCalls).toEqual([]);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			});
		}

		test("refuses a non-object argument list and writes no row", async () => {
			gitCalls = [];
			const before = await rowCounts(SKILL_TABLES);

			expect(await refuses(client, "skills_propose", [])).toBe(true);
			expect(gitCalls).toEqual([]);
			expect(await rowCounts(SKILL_TABLES)).toEqual(before);
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

	describe("POST /skills/approve", () => {
		let http: HttpHarness;
		beforeAll(async () => {
			http = await startHttp({ index: store, greptime: ledgerStub().greptime });
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} with 400 and writes no registry row`, async () => {
				const before = await rowCounts(SKILL_TABLES);
				const response = await http.send("/skills/approve", body);

				expect(response.status).toBe(400);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			});
		}

		for (const [label, payload] of NON_OBJECT_BODIES) {
			test(`refuses ${label} with 400 and writes no registry row`, async () => {
				const before = await rowCounts(SKILL_TABLES);
				const response = await http.send("/skills/approve", payload);

				expect(response.status).toBe(400);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
			});
		}
	});

	describe("MCP skills_approve", () => {
		let client: Client;
		beforeAll(async () => {
			client = await connectMcp({ index: store, greptime: ledgerStub().greptime }, OPERATOR);
		});

		for (const [label, body] of invalid) {
			test(`refuses ${label} and writes no registry row`, async () => {
				const before = await rowCounts(SKILL_TABLES);

				expect(await refuses(client, "skills_approve", body)).toBe(true);
				expect(await rowCounts(SKILL_TABLES)).toEqual(before);
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
	/** Refused batches. None may reach an upload. */
	const invalid: Array<[string, Record<string, unknown>]> = [
		["a missing required field (dataset)", without(valid, "dataset")],
		["a wrong type (pages is a string)", { ...valid, pages: "docs/data-planes.md" }],
		["a wrong type (page path is a number)", { ...valid, pages: [page({ path: 7 })] }],
		["a wrong type (page body is missing)", { ...valid, pages: [without(page(), "body")] }],
		["a page with no source URL", { ...valid, pages: [without(page(), "source_url")] }],
		["an unknown dataset", { ...valid, dataset: "no-such-dataset" }],
		[
			"a valid page followed by an invalid one (the valid page must not upload)",
			{ ...valid, pages: [page({ path: "docs/first.md" }), without(page({ path: "docs/second.md" }), "source_url")] },
		],
	];

	test("a valid control is stored and makes exactly one upload", async () => {
		const fake = new RagflowFake();
		const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
		const response = await http.send("/docs/ingest", valid);

		expect(response.status).toBe(200);
		expect(fake.uploads).toHaveLength(1);
	});

	for (const [label, body] of invalid) {
		test(`POST /docs/ingest refuses ${label} with 400 and uploads nothing`, async () => {
			const fake = new RagflowFake();
			const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
			const response = await http.send("/docs/ingest", body);

			expect(response.status).toBe(400);
			expect(fake.uploads).toEqual([]);
		});
	}

	for (const [label, payload] of NON_OBJECT_BODIES) {
		test(`POST /docs/ingest refuses ${label} with 400 and uploads nothing`, async () => {
			const fake = new RagflowFake();
			const http = await startHttp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch });
			const response = await http.send("/docs/ingest", payload);

			expect(response.status).toBe(400);
			expect(fake.uploads).toEqual([]);
		});
	}

	for (const [label, body] of invalid) {
		test(`MCP docs_ingest refuses ${label} and uploads nothing`, async () => {
			const fake = new RagflowFake();
			const client = await connectMcp({ index: null, greptime: ledgerStub().greptime, ragflowFetch: fake.fetch }, OMP);

			expect(await refuses(client, "docs_ingest", body)).toBe(true);
			expect(fake.uploads).toEqual([]);
		});
	}
});
