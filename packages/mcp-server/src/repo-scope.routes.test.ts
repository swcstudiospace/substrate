/**
 * Phase 72: the repository-keyed doors that are not git, worktree or corpus reads, over a real socket. A refused request
 * writes only its own refusal audit and reads nothing: no ledger read, no Hindsight call, no handoff packet. The granted
 * brief is the positive control, so the gate is not a blanket refusal.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { CorpusStore } from "./corpus/store.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";
import type { ReportedWorktree } from "./worktree-registry.ts";
import { MemoryWorktreeRegistry } from "./worktree-registry-fake.ts";

const running: Array<{ close(): void }> = [];
afterAll(() => {
	for (const entry of running) entry.close();
});

const TOKEN = "tok-agent-phase72";
const BEARER = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** The ledger methods the stub answers, each with the shape the service calls them with. */
interface GreptimeFake {
	ensureAppendMode(): Promise<boolean>;
	lastHash(): Promise<string | null>;
	insertEvent(event: SubstrateEvent): Promise<void>;
	queryEvents(): Promise<unknown[]>;
	readEvents(): Promise<unknown[]>;
	recentForRepo(): Promise<unknown[]>;
	commitEventsNaming(): Promise<unknown[]>;
	graphIngest(): Promise<unknown[]>;
	firstIngestMs(): Promise<number | null>;
}

interface Ledger {
	written: SubstrateEvent[];
	reads: string[];
	greptime: GreptimeFake;
}

/** A ledger stub: every append is recorded, and every other call is counted as a read. */
function ledger(): Ledger {
	const written: SubstrateEvent[] = [];
	const reads: string[] = [];
	const readMethod = (name: string) => async () => {
		reads.push(name);
		return [];
	};
	const greptime: GreptimeFake = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			written.push(event);
		},
		queryEvents: readMethod("queryEvents"),
		readEvents: readMethod("readEvents"),
		recentForRepo: readMethod("recentForRepo"),
		commitEventsNaming: readMethod("commitEventsNaming"),
		graphIngest: async () => [],
		firstIngestMs: async () => null,
	};
	return { written, reads, greptime };
}

/** Store seams a test injects in place of the index-built ones: the worktree registry the list reads, and the corpus manifest store. */
interface Seams {
	worktrees?: MemoryWorktreeRegistry;
	corpus?: { store: CorpusStore };
}

interface Harness {
	base: string;
	ledger: Ledger;
	hindsightCalls: string[];
	observability: Observability;
	substrate: Substrate;
}

async function start(env: Record<string, string | undefined>, seams: Seams = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const stub = ledger();
	const hindsightCalls: string[] = [];
	const substrate = new Substrate(
		config,
		{
			index: null,
			greptime: stub.greptime as never,
			hindsightFetch: (async (url: string) => {
				hindsightCalls.push(String(url));
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			}) as never,
			...seams,
		},
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
	return { base: `http://127.0.0.1:${port}`, ledger: stub, hindsightCalls, substrate, observability };
}

/** `owner/a` is granted to the claude-code surface; `owner/b` is registered and not granted. Their directories do not nest. */
function scopedEnv(): Record<string, string | undefined> {
	const dirA = mkdtempSync(join(tmpdir(), "repo-routes-a-"));
	const dirB = mkdtempSync(join(tmpdir(), "repo-routes-b-"));
	return {
		SUBSTRATE_TOKEN_CLAUDE_CODE: TOKEN,
		SUBSTRATE_BRIEF_SESSIONS: "on",
		SUBSTRATE_REPO_REGISTRY: JSON.stringify({
			"owner/a": { checkouts: [dirA], worktrees: [] },
			"owner/b": { checkouts: [dirB], worktrees: [] },
		}),
		SUBSTRATE_REPO_SCOPES: JSON.stringify({ "claude-code": ["owner/a"] }),
	};
}

/** The ledger writes that are not a refusal's own audit: a refused route must leave none. */
function nonAuditWrites(written: SubstrateEvent[]): SubstrateEvent[] {
	return written.filter((event) => (event.payload as { action?: string } | undefined)?.action !== "repo.scope-refused");
}

function refusalRoutes(written: SubstrateEvent[]): string[] {
	return written
		.map((event) => (event.payload as { route?: string } | undefined)?.route)
		.filter((route): route is string => typeof route === "string");
}

describe("POST /brief (repo-keyed door)", () => {
	test("boundary: a brief for an ungranted repository is refused before any read", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/brief`, { method: "POST", headers: BEARER, body: JSON.stringify({ repo: "owner/b" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(h.ledger.reads).toHaveLength(0);
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
		expect(refusalRoutes(h.ledger.written)).toEqual(["brief"]);
	});

	test("boundary: an unnamed brief, which can span repositories, is refused to a scoped caller before any read", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/brief`, { method: "POST", headers: BEARER, body: JSON.stringify({}) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "all-repos-not-granted" });
		expect(h.ledger.reads).toHaveLength(0);
	});

	test("positive control: a brief for a granted repository is not refused by the scope", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/brief`, { method: "POST", headers: BEARER, body: JSON.stringify({ repo: "owner/a" }) });
		expect(reply.status).not.toBe(403);
	});
});

describe("POST /memory/recall (repo-keyed door)", () => {
	test("boundary: recall for an ungranted repository is refused before Hindsight is called", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/memory/recall`, { method: "POST", headers: BEARER, body: JSON.stringify({ query: "lease", repo: "owner/b" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(h.hindsightCalls).toHaveLength(0);
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
	});

	test("boundary: an unnamed recall, which can return other repositories' memories, is refused before Hindsight is called", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/memory/recall`, { method: "POST", headers: BEARER, body: JSON.stringify({ query: "lease" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "all-repos-not-granted" });
		expect(h.hindsightCalls).toHaveLength(0);
	});
});

describe("GET /session/context (repo-keyed door)", () => {
	test("boundary: session context for an ungranted repository is refused, writes nothing but its audit, and names no session", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/session/context?repo_id=owner/b`, { headers: BEARER });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
		expect(refusalRoutes(h.ledger.written)).toEqual(["session_context"]);
	});
});

describe("POST /handoff (repo-keyed write)", () => {
	test("boundary: a handoff naming an ungranted repository writes no packet", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/handoff`, { method: "POST", headers: BEARER, body: JSON.stringify({ to: "cursor", goal: "continue", repo: "owner/b" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
	});

	test("boundary: a handoff that names no repository and a graph this server cannot resolve is refused to a scoped caller before any write", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/handoff`, { method: "POST", headers: BEARER, body: JSON.stringify({ to: "cursor", goal: "continue", graph_id: "ut-1" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "graph-repo-unresolved" });
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
	});
});

describe("live session discovery (repo-keyed read, gated in the service)", () => {
	test("boundary: the discovery gate refuses an unnamed discovery to a scoped surface, and audits it under its route", async () => {
		const h = await start(scopedEnv());
		const refused = await h.substrate.scopedRepoRefusal("live_session_discovery", "claude-code", null, true);
		expect(refused).toMatchObject({ ok: false, status: 403, body: { error: "all-repos-not-granted" } });
		expect(refusalRoutes(h.ledger.written)).toEqual(["live_session_discovery"]);
		expect(h.ledger.reads).toHaveLength(0);
	});
});

describe("POST /events and POST /events/query (repo-keyed ledger doors)", () => {
	test("boundary: an event naming an ungranted repository is refused before the ledger write", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/events`, { method: "POST", headers: BEARER, body: JSON.stringify({ kind: "note", summary: "x", repo: "owner/b" }) });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
	});

	test("boundary: a ledger query naming an ungranted repository is refused before any ledger read", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/events/query`, { method: "POST", headers: BEARER, body: JSON.stringify({ repo: "owner/b" }) });
		expect(reply.status).toBe(403);
		expect(h.ledger.reads).toHaveLength(0);
	});
});

/** Every REST path no declaration names. Each is refused to a scoped caller before any handler runs. */
const UNDECLARED_ROUTES = [
	"/corpus/anchor",
	"/corpus/gaps",
	"/corpus/neardup",
	"/corpus/reflect",
	"/corpus/root",
	"/docs/feedback",
	"/docs/ingest",
	"/docs/merge-trigger",
	"/evidence",
	"/events/stream",
	"/memory",
	"/skills",
	"/skills/approve",
	"/skills/propose",
	"/steering/acknowledge",
	"/steering/directives",
	"/steering/queue",
	"/steering/sessions",
	"/steering/sessions/close",
	"/steering/sessions/heartbeat",
	"/steering/wait",
	"/verify",
	"/worktrees/claims",
	"/worktrees/report",
];

/** Every MCP tool no declaration names. The batch is refused before any member runs. */
const UNDECLARED_TOOLS = ["memory_write", "memory_pending", "issue_get", "graph_find", "events_verify", "desktop_run", "planning_status", "skills_propose", "checkpoint_verify", "session_checkpoint", "docs_ingest", "docs_feedback", "railway_deploy"];

async function postMcpCall(base: string, tool: string): Promise<Response> {
	return fetch(`${base}/mcp`, { method: "POST", headers: BEARER, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }) });
}

describe("default deny: a route or tool no declaration names is refused to a scoped caller", () => {
	for (const path of UNDECLARED_ROUTES) {
		test(`boundary: ${path} is refused before its handler runs, and nothing outside the grant is read or written`, async () => {
			const h = await start(scopedEnv());
			const reply = await fetch(`${h.base}${path}`, { method: "POST", headers: BEARER, body: "{}" });
			expect(reply.status).toBe(403);
			expect(await reply.json()).toMatchObject({ error: "not-declared-for-scope" });
			expect(h.ledger.reads).toHaveLength(0);
			expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
		});
	}

	for (const tool of UNDECLARED_TOOLS) {
		test(`boundary: MCP tool ${tool} is refused before the batch runs, and nothing outside the grant is read or written`, async () => {
			const h = await start(scopedEnv());
			const reply = await postMcpCall(h.base, tool);
			expect(reply.status).toBe(403);
			expect(await reply.json()).toMatchObject({ error: "not-declared-for-scope" });
			expect(h.ledger.reads).toHaveLength(0);
			expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
		});
	}

	test("positive control: a declared global route is not refused by the default deny", async () => {
		const h = await start(scopedEnv());
		const reply = await fetch(`${h.base}/healthz`, { headers: BEARER });
		expect(reply.status).not.toBe(403);
	});
});

/** The review findings the default deny closes: each names the route or tool it refuses, and the test asserts that refusal. */
const FINDING_REFUSALS: Array<{ id: string; route: string } | { id: string; tool: string }> = [
	{ id: "RS-01", route: "/evidence" },
	{ id: "RS-02", tool: "issue_get" },
	{ id: "RS-03", tool: "graph_find" },
	{ id: "RS-03", route: "/worktrees/claims" },
	{ id: "RS-08", route: "/worktrees/report" },
	{ id: "RS-09", route: "/docs/ingest" },
	{ id: "RS-09", tool: "docs_ingest" },
	{ id: "RS-10", route: "/memory" },
	{ id: "RS-10", tool: "memory_write" },
	{ id: "RS-11", route: "/corpus/root" },
	{ id: "RS-12", tool: "memory_pending" },
	{ id: "RS-13", route: "/steering/queue" },
];

describe("review findings closed by the default deny", () => {
	for (const finding of FINDING_REFUSALS) {
		const target = "route" in finding ? finding.route : finding.tool;
		test(`${finding.id}: ${target} is refused to a scoped caller, and nothing outside the grant is read or written`, async () => {
			const h = await start(scopedEnv());
			const reply = "route" in finding ? await fetch(`${h.base}${finding.route}`, { method: "POST", headers: BEARER, body: "{}" }) : await postMcpCall(h.base, finding.tool);
			expect(reply.status).toBe(403);
			expect(h.ledger.reads).toHaveLength(0);
			expect(nonAuditWrites(h.ledger.written)).toHaveLength(0);
		});
	}
});

describe("RS-17: anonymous refusals are audited", () => {
	test("boundary: an anonymous refusal writes exactly one audit row, and the row carries a keyed digest, never the request", async () => {
		const h = await start({ ...scopedEnv(), SUBSTRATE_ALLOW_ANONYMOUS: "1" });
		const before = h.observability.audit.recent().length;
		const reply = await fetch(`${h.base}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph_id: "ut-secret-graph" }) });
		expect(reply.status).toBe(403);
		const rows = h.observability.audit.recent();
		expect(rows).toHaveLength(before + 1);
		const written = JSON.stringify(rows.slice(before));
		expect(written).toContain("route_sha256");
		expect(written).not.toContain("ut-secret-graph");
		expect(written).not.toContain("/evidence");
		expect(h.ledger.reads).toHaveLength(0);
	});
});

/** A worktree row as a host reports it: only the repository and path vary by case. */
function reportedRow(repo: string, path: string): ReportedWorktree {
	return { path, repo, branch: "feature/x", head: "a".repeat(40), base: "b".repeat(40), dirty: false, ahead: 0, behind: 0, last_commit_at: null, size_bytes: null, locked: false, primary: false, pr_state: "none" };
}

/** A registry holding one granted worktree (`owner/a`) and one ungranted (`owner/b`), reported just now. */
async function seededWorktrees(): Promise<MemoryWorktreeRegistry> {
	const store = new MemoryWorktreeRegistry();
	const seenAt = new Date();
	await store.report({ host: "host-1", reportedAt: seenAt, seenAt, ttlS: 30 * 86_400, worktrees: [reportedRow("owner/a", "/w/a-1"), reportedRow("owner/b", "/w/b-1")] });
	return store;
}

describe("POST /drift (repo-keyed door)", () => {
	test("boundary: a drift scan of an ungranted repository is refused before the scan and before any git call", async () => {
		const h = await start(scopedEnv());
		const scan = spyOn(h.substrate, "driftScan");
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const reply = await fetch(`${h.base}/drift`, { method: "POST", headers: BEARER, body: JSON.stringify({ repo: "owner/b" }) });
			expect(reply.status).toBe(403);
			expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
			expect(scan).not.toHaveBeenCalled();
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git")).toHaveLength(0);
			expect(h.ledger.reads).toHaveLength(0);
			expect(refusalRoutes(h.ledger.written)).toEqual(["drift"]);
		} finally {
			spawn.mockRestore();
			scan.mockRestore();
		}
	});
});

/**
 * A `tools/call` over the MCP door. The reply is one JSON body, or one event-stream frame whose data is that body; the status
 * is the transport's own (a refusal is a 403 before any member runs, a declared tool's refusal is a 200 with `isError`).
 */
async function callMcpTool(base: string, tool: string, args: unknown): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: { ...BEARER, accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
	});
	const raw = await response.text();
	if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return { status: response.status, body: JSON.parse(raw) };
	const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
	return { status: response.status, body: JSON.parse(data) };
}

describe("MCP coord_drift_scan (repo-keyed read through the MCP door)", () => {
	test("boundary: coord_drift_scan of an ungranted repository is refused before the scan and before any git call", async () => {
		const h = await start(scopedEnv());
		const scan = spyOn(h.substrate, "driftScan");
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const reply = await callMcpTool(h.base, "coord_drift_scan", { repo: "owner/b", path: join(tmpdir(), "not-granted-checkout") });
			expect(JSON.stringify(reply.body)).toContain("repo-not-granted");
			expect(scan).not.toHaveBeenCalled();
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git")).toHaveLength(0);
			expect(h.ledger.reads).toHaveLength(0);
			expect(refusalRoutes(h.ledger.written)).toEqual(["drift"]);
		} finally {
			spawn.mockRestore();
			scan.mockRestore();
		}
	});
});

describe("GET /worktrees (repo-keyed read)", () => {
	test("boundary: an unnamed read by a scoped caller returns only the granted repository's rows, and the store is asked for that grant alone", async () => {
		const store = await seededWorktrees();
		const list = spyOn(store, "list");
		const h = await start({ ...scopedEnv(), SUBSTRATE_WORKTREE_REGISTRY: "on" }, { worktrees: store });
		const reply = await fetch(`${h.base}/worktrees`, { headers: BEARER });
		expect(reply.status).toBe(200);
		const body = (await reply.json()) as { worktrees: Array<{ repo: string }> };
		expect(body.worktrees.map((row) => row.repo)).toEqual(["owner/a"]);
		expect(list.mock.calls[0]?.[0]).toMatchObject({ repos: ["owner/a"] });
		list.mockRestore();
	});

	test("boundary: a read naming an ungranted repository is refused before the store is read", async () => {
		const store = await seededWorktrees();
		const list = spyOn(store, "list");
		const h = await start({ ...scopedEnv(), SUBSTRATE_WORKTREE_REGISTRY: "on" }, { worktrees: store });
		const reply = await fetch(`${h.base}/worktrees?repo=owner/b`, { headers: BEARER });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "repo-not-granted" });
		expect(list).not.toHaveBeenCalled();
		list.mockRestore();
	});
});

describe("GET /corpus/proof (repo-keyed read)", () => {
	test("boundary: a proof for an ungranted repository is refused before the corpus manifest is read", async () => {
		const reads: string[] = [];
		const store = new Proxy({}, {
			get(_target, property) {
				reads.push(String(property));
				return undefined;
			},
		});
		const h = await start({ ...scopedEnv(), SUBSTRATE_CORPUS: "on" }, { corpus: { store: store as never } });
		const reply = await fetch(`${h.base}/corpus/proof?repo=owner/b&path=README.md`, { headers: BEARER });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ reason: "repo-not-granted" });
		expect(reads).toEqual([]);
		expect(h.ledger.reads).toHaveLength(0);
	});
});
