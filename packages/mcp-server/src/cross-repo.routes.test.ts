/**
 * Phase 74: the refusal order of the cross-repository routes, over a real socket. The order the routes have is: 401 for no
 * surface and 403 for a non-operator compensation, both before the body is read or audited; then the body read and parsed
 * (400); then the audit, fail-closed for the fan-out and the compensation (503 with the audit's reason); then the index store,
 * absent (503 `cross-repo.disabled`); then the engine, where a repository the surface is not granted is 403. The fan-out's
 * 503 for a missing store comes before its grant gate, so an ungranted fan-out on a run with no index answers 503, not 403.
 * The store is the in-memory adapter the store contract proves equal to the SQL.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { MemoryCrossRepoStore } from "./cross-repo-fake.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const CLAUDE_CODE_TOKEN = "tok-agent-phase74";
const OPERATOR_TOKEN = "tok-operator-phase74";
const JSON_HEADERS = { "content-type": "application/json" };

/** The refusal the bearer check answers an anonymous caller with, before any route runs. */
const BEARER_REFUSAL = "unknown or missing bearer token";
/** The operator refusal text the docs' Compensation table names, pinned exactly. */
const COMPENSATE_NEEDS_OPERATOR = "cross_repo_compensate needs an operator token; nothing was changed";

const FANOUT_GRANTED = JSON.stringify({ key: "op-1", branch: "feature/x", repos: [{ repo: "owner/a", base: "main" }] });
const FANOUT_UNGRANTED = JSON.stringify({
	key: "op-1",
	branch: "feature/x",
	repos: [
		{ repo: "owner/a", base: "main" },
		{ repo: "owner/b", base: "main" },
	],
});
const COMPENSATE = JSON.stringify({ key: "op-1" });

const running: Array<{ close(): void }> = [];
afterAll(() => {
	for (const entry of running) entry.close();
});

interface Harness {
	base: string;
	observability: Observability;
	store: MemoryCrossRepoStore | null;
}

/** A path whose parent is a regular file: the audit chain cannot be written, whoever is running. */
function unwritableAudit(): string {
	const directory = mkdtempSync(join(tmpdir(), "cross-repo-routes-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

/**
 * Two registered repositories. `owner/a` is granted to the claude-code surface; `owner/b` is registered and not granted. The
 * operator token belongs to the cursor surface, which is listed as an operator.
 */
function envFor(over: Record<string, string | undefined>): Record<string, string | undefined> {
	const checkout = (name: string) => mkdtempSync(join(tmpdir(), `cross-repo-routes-${name}-`));
	return {
		SUBSTRATE_TOKEN_CLAUDE_CODE: CLAUDE_CODE_TOKEN,
		SUBSTRATE_TOKEN_CURSOR: OPERATOR_TOKEN,
		SUBSTRATE_OPERATOR_TOKENS: OPERATOR_TOKEN,
		SUBSTRATE_REPO_REGISTRY: JSON.stringify({
			"owner/a": { checkouts: [checkout("a")], worktrees: [] },
			"owner/b": { checkouts: [checkout("b")], worktrees: [] },
		}),
		SUBSTRATE_REPO_SCOPES: JSON.stringify({ "claude-code": ["owner/a"] }),
		SUBSTRATE_AUDIT_PATH: join(mkdtempSync(join(tmpdir(), "cross-repo-routes-audit-")), "mcp-audit.jsonl"),
		...over,
	};
}

/** A run with the index store present (`store`) or absent (`null`). Audit and index are the only things a test varies. */
async function start(over: Record<string, string | undefined>, store: MemoryCrossRepoStore | null): Promise<Harness> {
	const env = envFor(over);
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async () => undefined,
		queryEvents: async () => [],
		readEvents: async () => [],
		graphIngest: async () => [],
		firstIngestMs: async () => null,
	};
	const substrate = new Substrate(
		config,
		// The steering seam is the least the constructor needs without a real index: it reads no live-session authority from the stub.
		{ index: store === null ? null : ({ crossRepoStore: () => store } as never), greptime: greptime as never, steering: { history: null, liveSessions: null } },
		observability.observer,
	);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	running.push({
		close() {
			observability.stop();
			server.close();
		},
	});
	return { base: `http://127.0.0.1:${port}`, observability, store };
}

function bearer(token: string | null): Record<string, string> {
	return { ...JSON_HEADERS, ...(token === null ? {} : { authorization: `Bearer ${token}` }) };
}

async function post(h: Harness, path: string, body: string, token: string | null) {
	const response = await fetch(`${h.base}${path}`, { method: "POST", headers: bearer(token), body });
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function statusOf(h: Harness, key: string, token: string | null) {
	const response = await fetch(`${h.base}/cross-repo/status?key=${key}`, { headers: bearer(token) });
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("cross-repo routes: an anonymous caller is 401 before anything else", () => {
	test("with the store absent and the audit refusing, every route still answers 401, with no audit attempt", async () => {
		const h = await start({ SUBSTRATE_AUDIT_PATH: unwritableAudit() }, null);
		// The bearer check answers 401 before the route runs, so the route's own text never appears. The fan-out body is not JSON
		// on purpose: a route that read it first would answer 400.
		expect(await post(h, "/cross-repo/fanout", "not json", null)).toEqual({ status: 401, json: { error: BEARER_REFUSAL } });
		expect(await post(h, "/cross-repo/compensate", "not json", null)).toEqual({ status: 401, json: { error: BEARER_REFUSAL } });
		expect(await statusOf(h, "op-1", null)).toEqual({ status: 401, json: { error: BEARER_REFUSAL } });
		// A 503 from the audit would mean the audit ran first; the 401 proves it did not.
		expect(h.observability.audit.recent()).toEqual([]);
	});

	test("with the store present, an anonymous fan-out is 401 and writes nothing", async () => {
		const store = new MemoryCrossRepoStore();
		const h = await start({}, store);
		expect(await post(h, "/cross-repo/fanout", FANOUT_GRANTED, null)).toMatchObject({ status: 401 });
		expect(store.writes).toBe(0);
	});
});

describe("cross-repo routes: a non-operator compensation is 403 before the body, the audit, or the store", () => {
	test("with the store absent and the audit refusing, a non-operator is 403, not 400 or 503", async () => {
		const h = await start({ SUBSTRATE_AUDIT_PATH: unwritableAudit() }, null);
		expect(await post(h, "/cross-repo/compensate", "not json", CLAUDE_CODE_TOKEN)).toEqual({ status: 403, json: { error: COMPENSATE_NEEDS_OPERATOR } });
	});

	test("with the store present, a non-operator is 403 and the store is never written", async () => {
		const store = new MemoryCrossRepoStore();
		const h = await start({}, store);
		expect(await post(h, "/cross-repo/compensate", COMPENSATE, CLAUDE_CODE_TOKEN)).toEqual({ status: 403, json: { error: COMPENSATE_NEEDS_OPERATOR } });
		expect(store.writes).toBe(0);
		expect(h.observability.audit.recent()).toEqual([]);
	});
});

describe("cross-repo routes: a permitted request on an unavailable store is 503", () => {
	test("the operator's compensation with the store absent: the audit runs first, so a refusing audit answers 503 error", async () => {
		const h = await start({ SUBSTRATE_AUDIT_PATH: unwritableAudit() }, null);
		const reply = await post(h, "/cross-repo/compensate", COMPENSATE, OPERATOR_TOKEN);
		expect(reply.status).toBe(503);
		expect(reply.json).toEqual({ error: expect.any(String) });
		expect(reply.json).not.toHaveProperty("reason");
	});

	test("the operator's compensation with the store absent and a non-JSON body: 400 comes before the audit", async () => {
		const h = await start({ SUBSTRATE_AUDIT_PATH: unwritableAudit() }, null);
		expect(await post(h, "/cross-repo/compensate", "not json", OPERATOR_TOKEN)).toEqual({
			status: 400,
			json: { ok: false, reason: "request-invalid", problem: "the body is not valid JSON" },
		});
	});

	test("the operator's compensation with the store absent and a working audit: 503 cross-repo.disabled, after its audit row", async () => {
		const h = await start({}, null);
		const reply = await post(h, "/cross-repo/compensate", COMPENSATE, OPERATOR_TOKEN);
		expect(reply.status).toBe(503);
		expect(reply.json).toMatchObject({ ok: false, reason: "cross-repo.disabled" });
		// The docs' Compensation table: the audit record was already written.
		expect(h.observability.audit.recent()[0]).toMatchObject({ tool: "cross_repo_compensate", transport: "rest", decision: "allowed" });
	});

	test("a granted fan-out with the store absent: 503 cross-repo.disabled, after its audit row", async () => {
		const h = await start({}, null);
		const reply = await post(h, "/cross-repo/fanout", FANOUT_GRANTED, CLAUDE_CODE_TOKEN);
		expect(reply.status).toBe(503);
		expect(reply.json).toMatchObject({ ok: false, reason: "cross-repo.disabled" });
		expect(h.observability.audit.recent()[0]).toMatchObject({ tool: "cross_repo_fanout", transport: "rest", decision: "allowed" });
	});

	test("an ungranted fan-out with the store absent answers 503, not 403: the store check comes before the grant gate", async () => {
		const h = await start({}, null);
		const reply = await post(h, "/cross-repo/fanout", FANOUT_UNGRANTED, CLAUDE_CODE_TOKEN);
		expect(reply.status).toBe(503);
		expect(reply.json).toMatchObject({ ok: false, reason: "cross-repo.disabled" });
	});

	test("a status read with the store absent is 503 for an authenticated caller", async () => {
		const h = await start({}, null);
		expect((await statusOf(h, "op-1", CLAUDE_CODE_TOKEN)).json).toMatchObject({ ok: false, reason: "cross-repo.disabled" });
	});
});

describe("cross-repo routes: a request that is authenticated but not granted is 403 before any write", () => {
	test("an ungranted fan-out with the store present is 403 repo-not-granted, after its audit row and before any write", async () => {
		const store = new MemoryCrossRepoStore();
		const h = await start({}, store);
		const reply = await post(h, "/cross-repo/fanout", FANOUT_UNGRANTED, CLAUDE_CODE_TOKEN);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ ok: false, reason: "repo-not-granted" });
		expect(store.writes).toBe(0);
		expect(h.observability.audit.recent()[0]).toMatchObject({ tool: "cross_repo_fanout" });
	});
});

describe("cross-repo routes: a malformed body is 400 before the store check", () => {
	test("an authenticated fan-out with a non-JSON body and the store absent is 400, not 503", async () => {
		const h = await start({}, null);
		expect(await post(h, "/cross-repo/fanout", "not json", CLAUDE_CODE_TOKEN)).toEqual({
			status: 400,
			json: { ok: false, reason: "request-invalid", problem: "the body is not valid JSON" },
		});
	});
});
