/**
 * The HTTP surface, driven over a real socket.
 *
 * `server.test.ts` covers `healthStatus` in isolation; this covers the routes SPE-4793
 * adds, the MCP audit gate in front of the dispatcher, and `substrate evidence` as an
 * actual subprocess — the CLI is a script with top-level side effects, so spawning it
 * is the only honest way to prove the command works rather than the function it calls.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createDesktopDriver } from "./desktop/driver.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer, type HttpServerOptions, refusalShape } from "./server.ts";
import { Substrate } from "./service.ts";
import {
	ProposeFailed,
	ProposeRefused,
	type ProposeOptions,
	type ProposeResult,
	type SkillProposer,
} from "./skills/propose.ts";
import { REDACTED } from "./redact.ts";
import type { SubstrateEvent } from "./types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");

interface Harness {
	base: string;
	observability: Observability;
	close(): void;
}

const running: Harness[] = [];

async function start(
	env: Record<string, string | undefined> = {},
	stores: Partial<{ index: unknown; greptime: unknown; skills: SkillProposer; desktop: unknown }> = {},
	options?: HttpServerOptions,
): Promise<Harness> {
	const config: SubstrateConfig = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(
		config,
		// Duck-typed stores. A test that needs `verifyGraph` to fail wants a ledger whose
		// read throws, and standing up a real client to get that would prove nothing extra.
		{ index: null, greptime: null, ...stores } as ConstructorParameters<typeof Substrate>[1],
		observability.observer,
	);
	const server = createHttpServer(substrate, config, observability, options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		close() {
			if (closed) return;
			closed = true;
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

afterAll(() => {
	for (const harness of running) harness.close();
});

function auditDirectory(): string {
	return join(mkdtempSync(join(tmpdir(), "substrate-http-")), "mcp-audit.jsonl");
}

/** A path whose parent is a regular file: impossible to create, whoever is running. */
function unwritablePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-http-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

describe("GET /healthz", () => {
	test("reports whether the audit chain is durable", async () => {
		// A deployment whose audit is in memory is one restart from having no trail.
		const memory = await start();
		const memoryBody = (await (await fetch(`${memory.base}/healthz`)).json()) as { auditDurable: boolean };
		expect(memoryBody.auditDurable).toBe(false);

		const durable = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const durableBody = (await (await fetch(`${durable.base}/healthz`)).json()) as { auditDurable: boolean };
		expect(durableBody.auditDurable).toBe(true);
	});

	test("the audit's state is reported but does not change the status code", async () => {
		// The status stays what the stores say — here 503, because this harness has none.
		// A non-durable audit is a fact about the deployment, not a reason to refuse
		// traffic, so it belongs in the body and nowhere else.
		const harness = await start();
		const response = await fetch(`${harness.base}/healthz`);
		const body = (await response.json()) as { index: boolean; greptime: boolean; auditDurable: boolean };

		expect(body).toMatchObject({ index: false, greptime: false, auditDurable: false });
		expect(response.status).toBe(503);
	});

	test("carries one row per plane and the index capacity, report-only (uplift-2 R2)", async () => {
		const capacity = { databaseBytes: 11_000_000, tables: [{ name: "graph_nodes", totalBytes: 65_536, liveRows: 45, deadRows: 50 }] };
		const harness = await start({}, { index: { ping: async () => true, capacity: async () => capacity } });
		const response = await fetch(`${harness.base}/healthz`);
		const body = (await response.json()) as {
			index: boolean;
			planes: Record<string, { ok: boolean | null; breaker: Record<string, unknown> | null; lastErrorAt: number | null }>;
			capacity: { index: unknown; ledger: unknown };
		};
		expect(response.status).toBe(200);
		expect(body.index).toBe(true);
		expect(Object.keys(body.planes).sort()).toEqual(["cache", "greptime", "hindsight", "index", "ragflow"]);
		expect(body.planes.index).toEqual({ ok: true, breaker: { plane: "index", state: "closed", failures: 0, openedAt: null, lastErrorAt: null, lastError: null }, lastErrorAt: null });
		// Unconfigured planes are `null`, not failures — the status code is 200 above.
		expect(body.planes.greptime?.ok).toBeNull();
		expect(body.planes.hindsight?.ok).toBeNull();
		expect(body.planes.ragflow?.ok).toBeNull();
		expect(body.capacity).toEqual({ index: capacity, ledger: null });

		const off = await start({ SUBSTRATE_BREAKER: "0" }, { index: { ping: async () => true, capacity: () => Promise.withResolvers<never>().promise } });
		const offBody = (await (await fetch(`${off.base}/healthz`)).json()) as { planes: Record<string, { breaker: unknown }>; capacity: { index: unknown; ledger: unknown } };
		expect(offBody.planes.index?.breaker).toBeNull();
		expect(offBody.capacity).toEqual({ index: null, ledger: null });
	});

	test("carries jobs.ledger from one memoised coverage read, not one per poll (uplift-3 N6)", async () => {
		let reads = 0;
		const greptime = {
			ping: async () => true,
			ensureAppendMode: async () => true,
			probeDialect: async () => true,
			quotingDialectKnown: true,
			anchorCoverage: async () => {
				reads++;
				return {
					newestAnchoredHour: "2026-10-13T10:00:00.000Z",
					lagHours: 1,
					uncoveredHours: [],
					more: false,
					lastArchiveWindow: { day: "2026-10-12", writtenAt: "2026-10-13T03:30:00.000Z", eventId: "evt_note" },
				};
			},
		};
		// The route's own body memo is off, so each call reaches the service and the 60 s memo is what is measured.
		const harness = await start({ SUBSTRATE_HEALTHZ_CACHE_MS: "0", SUBSTRATE_LEDGER_WRITE_PROBE_S: "0" }, { greptime });
		const first = (await (await fetch(`${harness.base}/healthz`)).json()) as { jobs: { ledger: Record<string, unknown> | null; ledgerReason: string | null } };
		const second = (await (await fetch(`${harness.base}/healthz`)).json()) as typeof first;
		expect(first.jobs.ledger).toMatchObject({ anchorLagHours: 1, uncoveredHours: 0, more: false, lastArchiveDay: "2026-10-12" });
		expect(first.jobs.ledgerReason).toBeNull();
		expect(second.jobs).toEqual(first.jobs);
		expect(reads).toBe(1);
	});
});

describe("GET /slo lists the per-plane objectives", () => {
	test("one per plane, unconfigured for the planes this deployment lacks, beside the catalogue (uplift-2 R2)", async () => {
		const harness = await start({}, { index: { ping: async () => true } });
		const body = (await (await fetch(`${harness.base}/slo`)).json()) as {
			results: Array<{ id: string }>;
			breached: string[];
			planes: Array<{ id: string; plane: string; status: string; target: number }>;
			docs: Array<{ id: string; status: string; statement: string }>;
			surfaces: Array<{ id: string; surface: string; status: string; samples: number }>;
		};
		expect(body.planes.map((entry) => entry.id)).toEqual([
			"plane.greptime.availability",
			"plane.index.availability",
			"plane.cache.availability",
			"plane.hindsight.availability",
			"plane.ragflow.availability",
		]);
		expect(body.planes.find((entry) => entry.plane === "index")?.status).toBe("insufficient-data");
		expect(body.planes.find((entry) => entry.plane === "greptime")?.status).toBe("unconfigured");
		expect(body.planes.every((entry) => entry.target === 0.99)).toBe(true);
		// The catalogue is still exactly SPE-4793's four. `breached` folds in plane and
		// burn breaches since uplift-3 N2 (slo-history.test.ts), and here nothing is breached.
		expect(body.results.map((entry) => entry.id)).toEqual(["brief.p95", "emit.success", "lease.steal_rate", "quarantine.rate"]);
		expect(body.breached).toEqual([]);
		// The docs-search objective (uplift-3 N5) rides beside them the same way: one
		// row, insufficient-data until twenty searches, never folded into `breached`.
		expect(body.docs.map((entry) => entry.id)).toEqual(["docs.search.p95"]);
		expect(body.docs[0]?.status).toBe("insufficient-data");
		expect(body.docs[0]?.statement).toContain("<= 2000 ms");
		const docsTuned = await start({ SUBSTRATE_SLO_DOCS_SEARCH_P95_MS: "1000" });
		const docsTunedBody = (await (await fetch(`${docsTuned.base}/slo`)).json()) as { docs: Array<{ statement: string }> };
		expect(docsTunedBody.docs[0]?.statement).toContain("<= 1000 ms");
		// The per-surface brief rows (uplift-3 N7) ride beside them too: none until a
		// surface has twenty briefs, then one `brief.p95` row naming it, never in `breached`.
		expect(body.surfaces).toEqual([]);
		for (let i = 0; i < 19; i++) harness.observability.observer.briefed?.({ surface: "grok-bot", graph_id: null, ok: true, durationMs: 50 });
		expect(((await (await fetch(`${harness.base}/slo`)).json()) as typeof body).surfaces).toEqual([]);
		harness.observability.observer.briefed?.({ surface: "grok-bot", graph_id: null, ok: true, durationMs: 50 });
		const judged = (await (await fetch(`${harness.base}/slo`)).json()) as typeof body;
		expect(judged.surfaces.map((entry) => [entry.id, entry.surface, entry.status, entry.samples])).toEqual([["brief.p95", "grok-bot", "ok", 20]]);
		expect(judged.breached).toEqual([]);

		const tuned = await start({ SUBSTRATE_SLO_PLANE_AVAILABILITY: "0.95" });
		const tunedBody = (await (await fetch(`${tuned.base}/slo`)).json()) as { planes: Array<{ target: number }> };
		expect(tunedBody.planes.every((entry) => entry.target === 0.95)).toBe(true);
	});
});

describe("GET /metrics", () => {
	test("serves the snapshot the SLOs are computed from, with no collector configured", async () => {
		const harness = await start();
		await fetch(`${harness.base}/brief`, { method: "POST", body: "{}" });

		const body = (await (await fetch(`${harness.base}/metrics`)).json()) as {
			startedAt: string;
			metrics: Array<{ name: string; points: unknown[] }>;
		};

		expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
		const brief = body.metrics.find((metric) => metric.name === "substrate.brief.duration");
		expect(brief?.points.length).toBeGreaterThan(0);
	});

	test("every request lands in the request histogram, under a bounded route", async () => {
		const harness = await start();
		await fetch(`${harness.base}/wp-login.php`);

		const body = (await (await fetch(`${harness.base}/metrics`)).json()) as {
			metrics: Array<{ name: string; points: Array<{ attributes: Record<string, unknown> }> }>;
		};
		const routes = body.metrics
			.find((metric) => metric.name === "substrate.request.total")
			?.points.map((point) => point.attributes.route);

		expect(routes).toContain("other");
		expect(routes).not.toContain("/wp-login.php");
	});
});

describe("GET /slo", () => {
	test("answers 200 with the verdicts, because a breach is information and not an outage", async () => {
		// A monitor that read this as an outage would page on a slow hour.
		const harness = await start();
		const response = await fetch(`${harness.base}/slo`);
		const body = (await response.json()) as { results: Array<{ id: string; status: string }>; breached: string[] };

		expect(response.status).toBe(200);
		expect(body.results.map((result) => result.id)).toEqual([
			"brief.p95",
			"emit.success",
			"lease.steal_rate",
			"quarantine.rate",
		]);
		expect(body.results.every((result) => result.status === "insufficient-data")).toBe(true);
		expect(body.breached).toEqual([]);
	});

	test("an operator's threshold reaches the served statement", async () => {
		const harness = await start({ SUBSTRATE_SLO_BRIEF_P95_MS: "400" });
		const body = (await (await fetch(`${harness.base}/slo`)).json()) as { results: Array<{ statement: string }> };

		expect(body.results[0]?.statement).toContain("400 ms");
	});
});

describe("POST /evidence", () => {
	test("returns the bundle as JSON", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const response = await fetch(`${harness.base}/evidence`, {
			method: "POST",
			body: JSON.stringify({ graph_id: "ut-abc123-deadbeef" }),
		});
		const bundle = (await response.json()) as { schema: string; stub: boolean; graph_id: string; audit: { total: number } };

		expect(response.status).toBe(200);
		expect(bundle).toMatchObject({ schema: "substrate.evidence/v0", stub: true, graph_id: "ut-abc123-deadbeef" });
		// The request audited itself, and it named the graph.
		expect(bundle.audit.total).toBe(1);
	});

	test("returns HTML when asked, self-contained", async () => {
		const harness = await start();
		const response = await fetch(`${harness.base}/evidence`, {
			method: "POST",
			body: JSON.stringify({ graph_id: "ut-1", format: "html" }),
		});
		const html = await response.text();

		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).not.toMatch(/<script/i);
	});

	test("requires a graph id", async () => {
		const harness = await start();
		const response = await fetch(`${harness.base}/evidence`, { method: "POST", body: JSON.stringify({}) });

		expect(response.status).toBe(400);
	});
});

describe("the MCP audit gate", () => {
	function toolCall(name: string, args: unknown = {}) {
		return JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
	}

	test("records an allowed tool call before the dispatcher sees it", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		// `graph_get` with no index returns a plain answer; what matters here is the
		// record, which the gate wrote before the tool ran.
		await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: toolCall("graph_get", { graph_id: "ut-1" }),
		});

		const [record] = harness.observability.audit.recent();
		expect(record).toMatchObject({ tool: "graph_get", decision: "allowed", graph_id: "ut-1", transport: "mcp" });
	});

	test("refuses a fail-closed tool the chain could not record, with a JSON-RPC error", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });
		const response = await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: toolCall("graph_claim", { graph_id: "ut-1", node_id: "n4", session_id: "s" }),
		});
		const body = (await response.json()) as { id: unknown; error: { code: number; message: string } };

		// 200 with a JSON-RPC error: the request was well-formed, and the refusal is the
		// answer to it — which is what an MCP client knows how to read.
		expect(response.status).toBe(200);
		expect(body.id).toBe(9);
		expect(body.error.code).toBe(-32000);
		expect(body.error.message).toContain("graph_claim");
	});

	test("a fail-open tool still runs when the chain could not record it", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });
		const response = await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: toolCall("memory_search", { query: "anything" }),
		});
		const body = (await response.text()) as string;

		expect(response.status).toBe(200);
		expect(body).not.toContain("-32000");
	});
});

describe("REST is audited on the same chain as MCP", () => {
	test("so a hook cannot reach an action by a door the trail does not cover", async () => {
		// A hook cannot call an MCP tool, so REST is the door it uses. If only the MCP
		// transport were audited, that door would be unaudited by design.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ surface: "omp", kind: "shell", summary: "ran cargo test", graph_id: "ut-7" }),
		});

		const [record] = harness.observability.audit.recent();
		expect(record).toMatchObject({ tool: "events", transport: "rest", decision: "allowed", graph_id: "ut-7" });
		// The summary was digested, not stored.
		expect(JSON.stringify(record)).not.toContain("cargo test");
	});

	test("monitoring traffic is not audited — a trail full of scrapes is one nobody reads", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/healthz`);
		await fetch(`${harness.base}/metrics`);
		await fetch(`${harness.base}/slo`);

		expect(harness.observability.audit.recent()).toEqual([]);
	});

	test("/memory is audited as memory_write, the same name MCP audits it under", async () => {
		// It was not audited at all. `memory_write` over MCP is fail-closed and refused
		// when the chain will not take the record; the same write through this route went
		// through unrecorded, so the policy had an unlocked door beside it.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/memory`, {
			method: "POST",
			body: JSON.stringify({ scope: "graph:ut-7", kind: "fact", subject: "s", body: "b", graph_id: "ut-7" }),
		});

		const [record] = harness.observability.audit.recent();
		expect(record).toMatchObject({ tool: "memory_write", transport: "rest", graph_id: "ut-7" });
	});

	test("/handoff is audited as coord_handoff", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/handoff`, {
			method: "POST",
			body: JSON.stringify({ surface: "omp", to: "muse", goal: "finish the migration", graph_id: "ut-7" }),
		});

		const [record] = harness.observability.audit.recent();
		expect(record).toMatchObject({ tool: "coord_handoff", transport: "rest", graph_id: "ut-7" });
	});

	test("/events/query and /drift leave a record too", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/events/query`, { method: "POST", body: JSON.stringify({ graph_id: "ut-7" }) });
		await fetch(`${harness.base}/drift`, { method: "POST", body: JSON.stringify({ repo: "agent-substrate" }) });

		expect(harness.observability.audit.recent().map((record) => record.tool)).toEqual(["events_query", "drift"]);
	});

	test("a fail-closed REST write the chain cannot record is refused, not served", async () => {
		// The denial used to be discarded, which made every REST route effectively
		// fail-open whatever its tool's audit mode said.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });
		const response = await fetch(`${harness.base}/memory`, {
			method: "POST",
			body: JSON.stringify({ scope: "graph:ut-7", kind: "fact", subject: "s", body: "b" }),
		});
		const body = (await response.json()) as { error: string };

		// 503, not 403: an audit sink that cannot take the record is an outage of this
		// substrate, not a permission decision about the caller.
		expect(response.status).toBe(503);
		expect(body.error).toContain("memory_write");
	});

	test("so is a handoff", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });
		const response = await fetch(`${harness.base}/handoff`, {
			method: "POST",
			body: JSON.stringify({ surface: "omp", to: "muse", goal: "finish the migration" }),
		});

		expect(response.status).toBe(503);
		expect(((await response.json()) as { error: string }).error).toContain("coord_handoff");
	});

	test("a fail-open REST read is still served when the chain will not take the record", async () => {
		// The other half. These sit inside a prompt's hook budget, and an unwritable audit
		// file is not a reason to fail an agent's turn.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });

		for (const [route, body] of [
			["/brief", {}],
			["/events/query", { graph_id: "ut-7" }],
			["/drift", { repo: "agent-substrate" }],
		] as Array<[string, unknown]>) {
			const response = await fetch(`${harness.base}${route}`, { method: "POST", body: JSON.stringify(body) });
			// The route ran. `/events/query` answers 503 of its own when the ledger does not
			// reply, which this harness has none of — so what is asserted is that the *audit*
			// did not refuse it, which is what the body would say.
			expect(await response.text()).not.toContain("MCP audit chain");
		}
	});
});

describe("substrate evidence", () => {
	/**
	 * Spawned asynchronously, not with `spawnSync`.
	 *
	 * The server under test is listening in *this* process, and `spawnSync` blocks this
	 * event loop — so the CLI's request would never be served and the command would
	 * report the substrate unreachable. That failure looks exactly like a broken CLI,
	 * which is why it is worth a note rather than a quiet `await`.
	 */
	async function run(args: string[], env: Record<string, string> = {}) {
		const child = Bun.spawn(["bun", CLI, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	test("writes the HTML bundle to disk and exits 0", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const out = join(mkdtempSync(join(tmpdir(), "substrate-cli-")), "evidence.html");

		const result = await run(["evidence", "--graph", "ut-abc123-deadbeef", "--out", out], {
			SUBSTRATE_URL: harness.base,
		});

		expect(result.exitCode).toBe(0);
		const html = await Bun.file(out).text();
		expect(html).toContain("Substrate evidence");
		expect(html).toContain("ut-abc123-deadbeef");
	});

	test("infers HTML from the output name, so --format is optional", async () => {
		const harness = await start();
		const out = join(mkdtempSync(join(tmpdir(), "substrate-cli-")), "bundle.html");
		await run(["evidence", "--graph", "ut-1", "--out", out], { SUBSTRATE_URL: harness.base });

		expect((await Bun.file(out).text()).startsWith("<!doctype html>")).toBe(true);
	});

	test("prints the JSON bundle to stdout when given no --out", async () => {
		const harness = await start();
		const result = await run(["evidence", "--graph", "ut-1"], { SUBSTRATE_URL: harness.base });

		expect(result.exitCode).toBe(0);
		expect((JSON.parse(result.stdout) as { schema: string }).schema).toBe("substrate.evidence/v0");
	});

	test("refuses without --graph", async () => {
		const result = await run(["evidence"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--graph");
	});

	test("refuses a format it cannot produce", async () => {
		const result = await run(["evidence", "--graph", "ut-1", "--format", "pdf"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("pdf");
	});

	test("fails loudly when substrate-mcp is not running, rather than emitting an empty document", async () => {
		// `brief` and `emit` exit 0 whatever happens because they sit in hooks. Evidence
		// does not: a document nobody can tell from a missing one is not evidence.
		const result = await run(["evidence", "--graph", "ut-1"], {
			SUBSTRATE_URL: "http://127.0.0.1:1",
			SUBSTRATE_TIMEOUT_MS: "300",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unreachable");
	});

	test("exits non-zero when a chain could not be verified, not only when it came back broken", async () => {
		// The contract is non-zero on an unreachable substrate, a chain that does not
		// verify, or a breached objective. It checked `ok === false` alone, so a ledger
		// outage produced a bundle whose app chain was `unknown` and an exit status of 0 as
		// long as no objective happened to be breached — a caller that trusted the status
		// shipped an unverified document as a verified one.
		const harness = await start(
			{},
			{ greptime: { readEvents: () => Promise.reject(new Error("greptime unreachable: connect ETIMEDOUT")) } },
		);

		const result = await run(["evidence", "--graph", "ut-1"], { SUBSTRATE_URL: harness.base });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("could not be verified");
		expect(result.stderr).toContain("does not attest");
	});

	test("the HTML form exits non-zero on an unverifiable chain too, and still writes it", async () => {
		const harness = await start(
			{},
			{ greptime: { readEvents: () => Promise.reject(new Error("greptime unreachable")) } },
		);
		const out = join(mkdtempSync(join(tmpdir(), "substrate-cli-")), "evidence.html");

		const result = await run(["evidence", "--graph", "ut-1", "--out", out], { SUBSTRATE_URL: harness.base });
		expect(result.exitCode).toBe(1);
		// The document is still written: an operator investigating an outage needs it, and
		// it says on its face that the chain is unverified.
		expect(await Bun.file(out).text()).toContain("unverified");
	});

	test("a deployment with no ledger is not a failure — there is no app chain to verify", async () => {
		// The state `ok: null` used to be indistinguishable from the one above.
		const harness = await start();
		const result = await run(["evidence", "--graph", "ut-1"], { SUBSTRATE_URL: harness.base });

		expect(result.exitCode).toBe(0);
		const bundle = JSON.parse(result.stdout) as { chains: { app_events: { state: string } } };
		expect(bundle.chains.app_events.state).toBe("not-configured");
	});

	test("exits non-zero when the evidence itself reports a breach, so it composes in a script", async () => {
		// 60 refused appends with no ledger configured, which is a real emit-success
		// breach: the bundle is served, and the command says it is not clean.
		const harness = await start();
		for (let i = 0; i < 60; i++) {
			await fetch(`${harness.base}/events`, {
				method: "POST",
				body: JSON.stringify({ surface: "omp", kind: "shell", summary: `run ${i}`, graph_id: "ut-1" }),
			});
		}

		const result = await run(["evidence", "--graph", "ut-1"], { SUBSTRATE_URL: harness.base });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("SLO(s) breached");
	});

	test("the HTML form reports a breach too, and still writes the document", async () => {
		// The bug: asking the server for HTML gave the command a document it could not
		// read, so `--format html` skipped the chain and SLO checks and exited 0 over a
		// breached objective. The bundle is now always fetched as JSON and rendered here,
		// so the exit status describes exactly the document that was written.
		const harness = await start();
		for (let i = 0; i < 60; i++) {
			await fetch(`${harness.base}/events`, {
				method: "POST",
				body: JSON.stringify({ surface: "omp", kind: "shell", summary: `run ${i}`, graph_id: "ut-2" }),
			});
		}
		const out = join(mkdtempSync(join(tmpdir(), "substrate-cli-")), "evidence.html");

		const result = await run(["evidence", "--graph", "ut-2", "--out", out], { SUBSTRATE_URL: harness.base });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("SLO(s) breached");
		// The document is still produced: the non-zero status is a verdict on its contents,
		// not a refusal to write it.
		const html = await Bun.file(out).text();
		expect(html).toContain("Emit success");
		expect(html).toContain("pill--breached");
	});
});

describe("GET /healthz reports a lost audit trail", () => {
	test("so a monitor learns of it without anyone asking /evidence first", async () => {
		const path = auditDirectory();
		const first = await start({ SUBSTRATE_AUDIT_PATH: path });
		await fetch(`${first.base}/events`, {
			method: "POST",
			body: JSON.stringify({ surface: "omp", kind: "shell", summary: "ran it", graph_id: "ut-1" }),
		});
		first.close();
		rmSync(path);

		const second = await start({ SUBSTRATE_AUDIT_PATH: path });
		const body = (await (await fetch(`${second.base}/healthz`)).json()) as {
			auditMissingHistory?: { kind: string; checkpointSeq: number; foundSeq: number };
		};

		expect(body.auditMissingHistory).toEqual({ kind: "missing", checkpointSeq: 1, foundSeq: 0 });
	});

	test("and says nothing about it on a healthy chain", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const body = (await (await fetch(`${harness.base}/healthz`)).json()) as Record<string, unknown>;

		expect(body.auditMissingHistory).toBeUndefined();
		expect(body.auditDurable).toBe(true);
	});
});

describe("an unexpected fault in the audit path respects the tool's mode", () => {
	/**
	 * A body that parses inside the size limit and overflows the argument encoder.
	 *
	 * `canonicalJson` is recursive, so deep enough nesting throws a RangeError rather than
	 * producing a digest — reachable by a caller, within `MAX_BODY_BYTES`.
	 */
	function deeplyNested(): string {
		let body = '{"ignored":';
		const depth = 20_000;
		body += "[".repeat(depth) + "1" + "]".repeat(depth);
		return `${body}}`;
	}

	test("a fail-open route is still served, because the audit must not fail a turn", async () => {
		// Denying unconditionally made a fault in the audit path able to refuse `/brief`,
		// which is fail-open precisely so the substrate cannot fail an agent's turn.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const response = await fetch(`${harness.base}/brief`, { method: "POST", body: deeplyNested() });

		expect(response.status).toBe(200);
		expect(await response.text()).not.toContain("audit chain");
		// And the fault really happened rather than the audit quietly succeeding: nothing
		// was appended, because the encoder threw before a record existed. Without this the
		// test would keep passing if the body stopped overflowing the encoder.
		expect(harness.observability.audit.recent()).toEqual([]);
	});

	test("a fail-closed route is refused, because there the unrecorded write is worse", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const response = await fetch(`${harness.base}/memory`, { method: "POST", body: deeplyNested() });

		expect(response.status).toBe(503);
		expect(((await response.json()) as { error: string }).error).toContain("memory_write");
	});

	test("and the refusal is counted as a denial, not as an allowed record that was lost", async () => {
		// The decision recorded has to be the decision taken: counting a refused write as
		// `allowed` made this metric disagree with what the caller was answered, which is the
		// one thing it exists to show.
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/memory`, { method: "POST", body: deeplyNested() });

		const appends = findCounter(harness.observability.snapshot(), METRIC.auditAppends)!;
		expect(sumCounter(appends, { decision: "denied", outcome: "lost" })).toBe(1);
		expect(sumCounter(appends, { decision: "allowed", outcome: "lost" })).toBe(0);
	});

	test("a fail-open route's fault is counted as an allowed record that was lost", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		await fetch(`${harness.base}/brief`, { method: "POST", body: deeplyNested() });

		const appends = findCounter(harness.observability.snapshot(), METRIC.auditAppends)!;
		expect(sumCounter(appends, { decision: "allowed", outcome: "lost" })).toBe(1);
		expect(sumCounter(appends, { decision: "denied", outcome: "lost" })).toBe(0);
	});
});

describe("substrate evidence and an ambiguous graph identifier", () => {
	test("exits non-zero rather than presenting another graph's decisions as this one's", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		const graphId = `ut-sk-ant-${"a".repeat(30)}`;
		const child = Bun.spawn(["bun", CLI, "evidence", "--graph", graphId], {
			cwd: ROOT,
			env: { ...process.env, SUBSTRATE_URL: harness.base },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("cannot be attributed to it alone");
		// The bundle is still written — an investigator needs it — and it neither claims the
		// decisions are this graph's nor echoes the credential in the identifier.
		const bundle = JSON.parse(stdout) as { graph_id: string; audit: { attribution: string } };
		expect(bundle.audit.attribution).toBe("ambiguous");
		expect(bundle.graph_id).toBe("ut-[REDACTED]");
		expect(stdout).not.toContain("sk-ant-");
	});
});

describe("POST /evidence tallies every record for the graph", () => {
	test("the counts cover records the listing does not", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory() });
		for (let i = 0; i < 3; i++) {
			await fetch(`${harness.base}/events`, {
				method: "POST",
				body: JSON.stringify({ surface: "omp", kind: "shell", summary: `run ${i}`, graph_id: "ut-9" }),
			});
		}

		const response = await fetch(`${harness.base}/evidence`, { method: "POST", body: JSON.stringify({ graph_id: "ut-9" }) });
		const bundle = (await response.json()) as { audit: { total: number; records: unknown[] } };
		// Three `/events` plus this request's own `evidence` record, all naming ut-9.
		expect(bundle.audit.total).toBe(4);
		expect(bundle.audit.records).toHaveLength(4);
	});
});

const BRIDGE = { SUBSTRATE_ALLOW_ANONYMOUS: "1", SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" };

function ledger() {
	const written: Array<{ surface: string; kind: string }> = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: { surface: string; kind: string }) => {
				written.push(event);
			},
		},
	};
}

describe("the anonymous bridge", () => {
	test("a bearer is attributed to grok-bot and an untokened caller still succeeds", async () => {
		// Fails on 6417c92. With a token configured, allowAnonymous is false no matter
		// what SUBSTRATE_ALLOW_ANONYMOUS says, so the untokened post is 401.
		const { written, greptime } = ledger();
		const harness = await start(BRIDGE, { greptime });

		const tokened = await fetch(`${harness.base}/events`, {
			method: "POST",
			headers: { authorization: "Bearer tok-grok" },
			body: JSON.stringify({ kind: "note", summary: "from the gateway" }),
		});
		const untokened = await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "from a collector", surface: "hermes" }),
		});

		expect(tokened.status).toBe(202);
		expect(written[0]?.surface).toBe("grok-bot");
		expect(untokened.status).toBe(202);
		expect(written[1]?.surface).toBe("hermes");
	});

	test("unset plus a token keeps today's 401", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" });
		const response = await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "no token" }),
		});

		expect(response.status).toBe(401);
	});

	test("a recognised token's memory write is grok-bot even when the body names another writer", async () => {
		const harness = await start(BRIDGE);
		const response = await fetch(`${harness.base}/memory`, {
			method: "POST",
			headers: { authorization: "Bearer tok-grok" },
			body: JSON.stringify({
				scope: "agent:grok-bot",
				kind: "fact",
				subject: "bridge",
				body: "the gateway wrote this",
				writer: "hermes",
			}),
		});
		const body = (await response.json()) as { writer: string };

		expect(response.status).not.toBe(401);
		expect(body.writer).toBe("grok-bot");
	});

	async function callMemory(harness: Harness, token: string | null, surface: string) {
		const response = await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "memory_write",
					arguments: { scope: "agent:grok-bot", kind: "fact", subject: "bridge", text: "from mcp", surface },
				},
			}),
		});
		const raw = await response.text();
		const data = raw
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		const envelope = JSON.parse(data ?? raw) as { result?: { content?: Array<{ text?: string }> } };
		return JSON.parse(envelope.result?.content?.[0]?.text ?? "null") as { writer?: string };
	}

	test("MCP memory_write attributes the bearer to grok-bot and ignores the argument", async () => {
		const harness = await start(BRIDGE);
		const result = await callMemory(harness, "tok-grok", "hermes");
		expect(result.writer).toBe("grok-bot");
	});

	test("an untokened MCP memory_write cannot name grok-bot", async () => {
		const harness = await start(BRIDGE);
		const result = await callMemory(harness, null, "grok-bot");
		expect(result.writer).toBe("unknown");
	});

	test("an untokened memory write stays unknown and cannot claim grok-bot", async () => {
		const harness = await start(BRIDGE);
		const response = await fetch(`${harness.base}/memory`, {
			method: "POST",
			body: JSON.stringify({
				scope: "agent:grok-bot",
				kind: "fact",
				subject: "bridge",
				body: "pretending",
				writer: "grok-bot",
			}),
		});
		const body = (await response.json()) as { writer: string };

		expect(response.status).not.toBe(401);
		expect(body.writer).toBe("unknown");
	});

	test("an untokened handoff does not default to claude-code", async () => {
		const harness = await start({ ...BRIDGE, SUBSTRATE_HANDOFF_KEY: "k" });
		const response = await fetch(`${harness.base}/handoff`, {
			method: "POST",
			body: JSON.stringify({ to: "muse", goal: "finish the migration" }),
		});
		const body = (await response.json()) as { error?: string; packet?: { from: { surface: string } } };

		expect(response.status).toBe(403);
		expect(body.packet?.from.surface).not.toBe("claude-code");
		expect(body.error ?? "").not.toContain("claude-code signed");
		expect(JSON.stringify(body)).not.toContain('"surface":"claude-code"');
	});

	test("an untokened handoff cannot name a surface that has a token", async () => {
		const harness = await start({ ...BRIDGE, SUBSTRATE_HANDOFF_KEY: "k" });
		const response = await fetch(`${harness.base}/handoff`, {
			method: "POST",
			body: JSON.stringify({ to: "muse", goal: "finish the migration", surface: "grok-bot" }),
		});
		const body = (await response.json()) as { error?: string; packet?: { from: { surface: string } } };

		expect(response.status).toBe(403);
		expect(body.packet).toBeUndefined();
		expect(body.error ?? "").toContain("token");
	});

	test("an untokened event cannot name a surface that has a token", async () => {
		const { written, greptime } = ledger();
		const harness = await start(BRIDGE, { greptime });
		const response = await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "impersonating", surface: "grok-bot" }),
		});

		expect(response.status).toBe(403);
		expect(written).toEqual([]);
	});

	test("anonymous callers are counted by route and claimed surface, and logged once an hour", async () => {
		const lines: string[] = [];
		let now = 1_000;
		const harness = await start(BRIDGE, {}, {
			now: () => now,
			anonymousLog: (line) => {
				lines.push(line);
			},
			anonymousIntervalMs: 60 * 60 * 1000,
		});

		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "payload-secret-marker", surface: "hermes" }),
		});
		expect(lines).toEqual([]);

		const body = (await (await fetch(`${harness.base}/metrics`)).json()) as {
			metrics: Array<{ name: string; points: Array<{ attributes: Record<string, string>; value: number }> }>;
		};
		const point = body.metrics
			.find((metric) => metric.name === "substrate.anonymous.requests")
			?.points.find((entry) => entry.attributes.claimed_surface === "hermes");
		expect(point?.attributes.route).toBe("/events");
		expect(point?.value).toBe(1);

		now += 60 * 60 * 1000;
		await fetch(`${harness.base}/healthz`);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("/events");
		expect(lines[0]).toContain("claimed=hermes");
		expect(lines[0]).not.toContain("payload-secret-marker");
	});

	test("refused events are logged hourly by reason, caller, surface and kind, without payload", async () => {
		const lines: string[] = [];
		let now = 1_000;
		const harness = await start(BRIDGE, {}, {
			now: () => now,
			anonymousLog: () => {},
			refusalLog: (line) => {
				lines.push(line);
			},
			anonymousIntervalMs: 60 * 60 * 1000,
		});

		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "brief.delivered", summary: "payload-secret-marker", surface: "muse" }),
		});
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "payload-secret-marker", surface: "docs-scraper" }),
		});
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "payload-secret-marker", surface: "grok-bot" }),
		});
		expect(lines).toEqual([]);

		now += 60 * 60 * 1000;
		await fetch(`${harness.base}/healthz`);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[substrate] refused events:");
		expect(lines[0]).toContain("reason=validation status=400 caller=untokened surface=muse kind=unrecognised:brief.delivered 1");
		expect(lines[0]).toContain("surface=unrecognised:docs-scraper kind=note");
		expect(lines[0]).toContain("reason=attribution status=403 caller=untokened surface=grok-bot kind=note 1");
		expect(lines[0]).not.toContain("payload-secret-marker");
	});

	test("the refused-event log caps distinct keys per window and counts the rest as other", async () => {
		const lines: string[] = [];
		let now = 1_000;
		const harness = await start(BRIDGE, {}, {
			now: () => now,
			anonymousLog: () => {},
			refusalLog: (line) => {
				lines.push(line);
			},
			anonymousIntervalMs: 60 * 60 * 1000,
		});
		const post = (surface: string) =>
			fetch(`${harness.base}/events`, { method: "POST", body: JSON.stringify({ kind: "note", summary: "x", surface }) });
		const name = (i: number) => `made-up-${String(i).padStart(2, "0")}`;

		for (let i = 1; i <= 52; i++) await post(name(i));
		await post(name(1));
		await post(name(52));
		now += 60 * 60 * 1000;
		await fetch(`${harness.base}/healthz`);
		expect(lines).toHaveLength(1);
		const parts = lines[0]?.replace("[substrate] refused events: ", "").trim().split(", ") ?? [];
		expect(parts).toHaveLength(51);
		expect(parts).toContain(`reason=validation status=400 caller=untokened surface=unrecognised:${name(1)} kind=note 2`);
		expect(parts).toContain("other 3");
		expect(lines[0]).not.toContain(name(51));

		await post(name(60));
		now += 60 * 60 * 1000;
		await fetch(`${harness.base}/healthz`);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain(`surface=unrecognised:${name(60)} kind=note 1`);
		expect(lines[1]).not.toContain("other");
	});

	test("refusalShape keeps only slugs of unknown names", () => {
		expect(refusalShape({ surface: "cursor", kind: "commit" })).toEqual({ surface: "cursor", kind: "commit" });
		expect(refusalShape({ surface: "Bearer abc def", kind: 42 })).toEqual({ surface: "unrecognised:invalid", kind: "none" });
		expect(refusalShape(null)).toEqual({ surface: "none", kind: "none" });
	});

	test("a quiet window is logged when the server closes", async () => {
		const lines: string[] = [];
		const harness = await start(BRIDGE, {}, {
			anonymousLog: (line) => {
				lines.push(line);
			},
		});

		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "payload-secret-marker", surface: "hermes" }),
		});
		expect(lines).toEqual([]);

		harness.close();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("claimed=hermes");
		expect(lines[0]).not.toContain("payload-secret-marker");
	});

	async function callTool(harness: Harness, name: string, args: Record<string, unknown>, token?: string) {
		const response = await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const raw = await response.text();
		const data = raw
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		const envelope = JSON.parse(data ?? raw) as { result?: { content?: Array<{ text?: string }> } };
		return JSON.parse(envelope.result?.content?.[0]?.text ?? "null") as { error?: string; stored?: boolean };
	}

	test("an untokened MCP events_emit cannot name a tokened surface", async () => {
		const { written, greptime } = ledger();
		const harness = await start(BRIDGE, { greptime });
		const refused = await callTool(harness, "events_emit", {
			kind: "note",
			summary: "impersonating",
			surface: "grok-bot",
		});
		const allowed = await callTool(harness, "events_emit", {
			kind: "note",
			summary: "from a collector",
			surface: "hermes",
		});

		expect(refused.error ?? "").toContain("token");
		expect(allowed.error).toBeUndefined();
		expect(written.map((event) => event.surface)).toEqual(["hermes"]);
	});

	test("an untokened MCP handoff does not default to claude-code", async () => {
		const harness = await start({ ...BRIDGE, SUBSTRATE_HANDOFF_KEY: "k" });
		const result = await callTool(harness, "coord_handoff", { to: "muse", goal: "finish the migration" });

		expect(result.error ?? "").toContain("claude-code");
		expect(JSON.stringify(result)).not.toContain('"from"');
	});

	test("an untokened MCP claim cannot renew a tokened surface", async () => {
		const harness = await start(BRIDGE);
		const result = await callTool(harness, "graph_claim", {
			graph_id: "ut-1",
			node_id: "n1",
			session_id: "sess-public",
			surface: "grok-bot",
		});

		expect(result.error ?? "").toContain("token");
		expect(JSON.stringify(result)).not.toContain("lease_id");
	});

	test("a bearer that is not a surface token is refused on the bridge", async () => {
		const harness = await start({ ...BRIDGE, SUBSTRATE_OPERATOR_TOKENS: "tok-nowhere" });
		const response = await fetch(`${harness.base}/events`, {
			method: "POST",
			headers: { authorization: "Bearer tok-nowhere" },
			body: JSON.stringify({ kind: "note", summary: "unnamed operator" }),
		});

		expect(response.status).toBe(401);
	});
});

describe("refused /events posts are counted by reason", () => {
	async function refused(harness: Harness, reason: string, token?: string) {
		const response = await fetch(`${harness.base}/metrics`, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
		});
		const body = (await response.json()) as {
			metrics?: Array<{ name: string; points: Array<{ attributes: Record<string, string>; value: number }> }>;
		};
		const counter = body.metrics?.find((metric) => metric.name === "substrate.events.refused");
		return counter?.points.find((point) => point.attributes.reason === reason)?.value ?? 0;
	}

	test("auth, validation, attribution and graph_id each have their own count", async () => {
		const closed = await start({ SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" });
		await fetch(`${closed.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "missing bearer" }),
		});
		expect(await refused(closed, "auth", "tok-grok")).toBe(1);

		const harness = await start(BRIDGE);
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "not-a-kind", summary: "bad", surface: "hermes" }),
		});
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "impersonating", surface: "grok-bot" }),
		});
		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "note", summary: "bad id", surface: "hermes", graph_id: 1 }),
		});

		expect(await refused(harness, "validation")).toBe(1);
		expect(await refused(harness, "attribution")).toBe(1);
		expect(await refused(harness, "graph_id")).toBe(1);

		await fetch(`${harness.base}/events`, {
			method: "POST",
			body: JSON.stringify({ kind: "graph_id", summary: "bad field", surface: "hermes" }),
		});
		await fetch(`${harness.base}/events`, { method: "POST", body: "42" });
		await fetch(`${closed.base}/events`);

		expect(await refused(harness, "validation")).toBe(3);
		expect(await refused(harness, "graph_id")).toBe(1);
		expect(await refused(closed, "auth", "tok-grok")).toBe(1);
	});
});

describe("a 500 does not echo the cause", () => {
	test("the body is generic and the log carries a correlation id", async () => {
		const harness = await start();
		const lines: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const response = await fetch(`${harness.base}/brief`, {
				method: "POST",
				body: "x".repeat(1_000_001),
			});
			const body = (await response.json()) as { error: string; correlation_id?: string };

			expect(response.status).toBe(500);
			expect(body.error).toBe("internal error");
			expect(JSON.stringify(body)).not.toContain("request body too large");
			const correlationId = body.correlation_id ?? "";
			expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
			expect(lines.join("")).toContain(correlationId);
		} finally {
			process.stderr.write = original;
		}
	});
});

describe("POST /skills/propose", () => {
	const TOKENS = {
		SUBSTRATE_TOKEN_CLAUDE_CODE: "tok-agent",
		SUBSTRATE_TOKEN_CURSOR: "tok-cursor",
		SUBSTRATE_TOKEN_OMP: "tok-operator",
		SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
	};
	const body = {
		name: "demo-skill",
		files: { "SKILL.md": "---\nname: demo-skill\ndescription: a demo\n---\nbody\n" },
		rationale: "worth keeping",
	};
	const opened: ProposeResult = {
		status: "opened",
		pr_url: "https://github.com/swcstudiospace/agent-skills/pull/12",
		pr_number: 12,
		branch: "skill/claude-code/demo-skill-1-abcd",
		content_sha256: "ab".repeat(32),
		redactions: [],
	};

	/** A proposer that records its calls and answers (or throws) what the test says. */
	function proposer(answer: ProposeResult | Error = opened) {
		const calls: Array<{ input: Parameters<SkillProposer["propose"]>[0]; opts: Omit<ProposeOptions, "run"> }> = [];
		const seam: SkillProposer = {
			propose: async (input, opts) => {
				calls.push({ input, opts });
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
		return { calls, seam };
	}

	async function propose(harness: Harness, token: string | null, payload: unknown = body) {
		const response = await fetch(`${harness.base}/skills/propose`, {
			method: "POST",
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	}

	test("an anonymous caller is refused 401 before the body is read, with nothing proposed", async () => {
		const { calls, seam } = proposer();
		const bare = await start({}, { skills: seam });
		// Over the cap on purpose: a refusal that read the body first would answer 413 or 500.
		const oversize = await propose(bare, null, "x".repeat(1_000_001));
		expect(oversize.status).toBe(401);
		expect(String(oversize.json.error)).toContain("authenticated surface");

		const bridge = await start({ SUBSTRATE_ALLOW_ANONYMOUS: "1", ...TOKENS }, { skills: seam });
		expect((await propose(bridge, null)).status).toBe(401);
		expect(calls).toEqual([]);
	});

	test("an unknown bearer is refused 401 too", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });
		expect((await propose(harness, "tok-nobody")).status).toBe(401);
		expect(calls).toEqual([]);
	});

	test("a token surface proposes as itself: 200 with the result, and the proposer sees that surface", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });
		const reply = await propose(harness, "tok-agent");

		expect(reply.status).toBe(200);
		expect(reply.json).toEqual(opened as never);
		expect(calls[0]?.input).toMatchObject({ name: "demo-skill", surface: "claude-code", rationale: "worth keeping" });
		expect(calls[0]?.opts).toMatchObject({ maxBytes: 1_000_000, mode: "overlay", dryRun: false, reopen: false });
	});

	test.each(["existing", "unchanged", "declined", "dry_run"] as const)("a %s result is a 200 with the same body", async (status) => {
		const result: ProposeResult = { ...opened, status, pr_url: undefined };
		const harness = await start(TOKENS, { skills: proposer(result).seam });
		const reply = await propose(harness, "tok-agent");
		expect(reply.status).toBe(200);
		expect(reply.json.status).toBe(status);
	});

	test("a body surface equal to the token's is accepted; a different one is 403 and never re-attributed", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });

		expect((await propose(harness, "tok-agent", { ...body, surface: "claude-code" })).status).toBe(200);
		const mismatch = await propose(harness, "tok-agent", { ...body, surface: "cursor" });
		expect(mismatch.status).toBe(403);
		expect(String(mismatch.json.error)).toContain("claude-code");
		expect(calls).toHaveLength(1);
	});

	test("replace, reopen and doc examples are 403 for a surface token and pass for an operator token", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });
		for (const privileged of [{ mode: "replace" }, { reopen: true }, { allow_doc_examples: ["pem"] }]) {
			const refused = await propose(harness, "tok-agent", { ...body, ...privileged });
			expect(refused.status).toBe(403);
			expect(String(refused.json.error)).toContain("operator token");
		}
		expect(calls).toEqual([]);

		const allowed = await propose(harness, "tok-operator", { ...body, mode: "replace", reopen: true, allow_doc_examples: ["pem", "jwt"] });
		expect(allowed.status).toBe(200);
		expect(calls[0]?.opts).toMatchObject({ mode: "replace", reopen: true });
		expect([...(calls[0]?.opts.allowDocExamples ?? [])]).toEqual(["pem", "jwt"]);
	});

	test("a body that is not JSON, or not the right shape, is 400 before the proposer", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });

		const notJson = await propose(harness, "tok-agent", "{nope");
		expect(notJson.status).toBe(400);
		expect(notJson.json.error).toBe("request body is not valid JSON");

		for (const [payload, message] of [
			[{ ...body, name: 7 }, "name must be a string"],
			[{ ...body, files: { "SKILL.md": 1 } }, "every file must be a string"],
			[{ ...body, mode: "merge" }, "mode must be overlay or replace"],
			[[body], "body must be a JSON object"],
		] as const) {
			const reply = await propose(harness, "tok-agent", payload);
			expect(reply.status).toBe(400);
			expect(String(reply.json.error)).toContain(message);
		}
		expect(calls).toEqual([]);
	});

	test("a parsed object with a bad mode is audited and then refused", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory(), ...TOKENS }, { skills: proposer().seam });
		const reply = await propose(harness, "tok-agent", { ...body, mode: "merge" });
		expect(reply.status).toBe(400);
		expect(harness.observability.audit.recent()[0]).toMatchObject({ tool: "skills_propose", decision: "allowed" });
	});

	test("a refusal is 400 with findings as file, line and rule only", async () => {
		const refusal = new ProposeRefused("secret-like content in 1 place(s); remove it or use an env reference", [
			{ file: "SKILL.md", line: 4, rule: "github" },
		]);
		const harness = await start(TOKENS, { skills: proposer(refusal).seam });
		const reply = await propose(harness, "tok-agent");

		expect(reply.status).toBe(400);
		expect(reply.json).toEqual({ error: refusal.message, findings: [{ file: "SKILL.md", line: 4, rule: "github" }] });
	});

	test("a failed git or gh step is 502, redacted and at most 400 characters", async () => {
		// Assembled at run time so no token-shaped literal sits in the repository.
		const token = `ghp_${"D".repeat(36)}`;
		const harness = await start(TOKENS, { skills: proposer(new ProposeFailed(`git push exited 1: GITHUB_TOKEN=${token} ${"x".repeat(900)}`)).seam });
		const reply = await propose(harness, "tok-agent");

		expect(reply.status).toBe(502);
		const message = String(reply.json.error);
		expect(message.length).toBeLessThanOrEqual(400);
		expect(message).not.toContain(token);
		expect(message).toContain(REDACTED);
	});

	test("an error that is not the proposal's is a generic 500 that does not echo the cause", async () => {
		const harness = await start(TOKENS, { skills: proposer(new Error("disk full at /var/lib/substrate")).seam });
		const reply = await propose(harness, "tok-agent");
		expect(reply.status).toBe(500);
		expect(JSON.stringify(reply.json)).not.toContain("disk full");
	});

	test("an oversize body is 413 on this route", async () => {
		const { calls, seam } = proposer();
		const harness = await start(TOKENS, { skills: seam });
		const reply = await propose(harness, "tok-agent", "x".repeat(1_000_001));
		expect(reply.status).toBe(413);
		expect(reply.json.error).toBe("request body too large");
		expect(calls).toEqual([]);
	});

	test("it is audited as skills_propose on the REST transport, the body digested not stored", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory(), ...TOKENS }, { skills: proposer().seam });
		await propose(harness, "tok-agent");

		const [record] = harness.observability.audit.recent();
		expect(record).toMatchObject({ tool: "skills_propose", transport: "rest", decision: "allowed", surface: "claude-code" });
		expect(JSON.stringify(record)).not.toContain("worth keeping");
		expect(JSON.stringify(record)).not.toContain("SKILL.md");
	});

	test("a dry run is audited like any proposal", async () => {
		const harness = await start({ SUBSTRATE_AUDIT_PATH: auditDirectory(), ...TOKENS }, { skills: proposer({ ...opened, status: "dry_run" }).seam });
		await propose(harness, "tok-agent", { ...body, dry_run: true });
		expect(harness.observability.audit.recent()[0]).toMatchObject({ tool: "skills_propose" });
	});

	test("when the audit chain cannot take the record it is 503 and nothing is proposed", async () => {
		const { calls, seam } = proposer();
		const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath(), ...TOKENS }, { skills: seam });
		const reply = await propose(harness, "tok-agent");

		expect(reply.status).toBe(503);
		expect(calls).toEqual([]);
	});

	test("the route is a bounded metric label", async () => {
		const harness = await start(TOKENS, { skills: proposer().seam });
		await propose(harness, "tok-agent");
		const snapshot = (await (await fetch(`${harness.base}/metrics`, { headers: { authorization: "Bearer tok-agent" } })).json()) as {
			metrics?: unknown;
		};
		expect(JSON.stringify(snapshot)).toContain("/skills/propose");
	});
});

describe("desktop_run at the HTTP gate", () => {
	/** 4x3 test image: pixel (x, y) is RGB (10x+1, 20y+2, 7x+5y+3). */
	function httpXwd(): Buffer {
		const W = 4;
		const H = 3;
		const name = Buffer.from("xwdtest\0");
		const unit = 4;
		const bytesPerLine = W * unit + 4;
		const header = Buffer.alloc(100);
		const fields = [100 + name.length, 7, 2, 24, W, H, 0, 0, 32, 0, 32, 32, bytesPerLine, 4, 0xff0000, 0xff00, 0xff, 8, 256, 0, W, H, 0, 0, 0];
		fields.forEach((value, i) => header.writeUInt32BE(value, i * 4));
		const pixels = Buffer.alloc(bytesPerLine * H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				pixels.writeUIntLE(((10 * x + 1) << 16) | ((20 * y + 2) << 8) | (7 * x + 5 * y + 3), y * bytesPerLine + x * unit, unit);
			}
		}
		return Buffer.concat([header, name, pixels]);
	}

	interface DesktopRig {
		harness: Harness;
		calls: string[][];
		written: SubstrateEvent[];
	}

	/** A harness with tokens, an omp-only allowlist and a recording fake runner behind the driver. */
	async function startDesktop(
		envExtra: Record<string, string | undefined> = {},
	): Promise<DesktopRig> {
		const calls: string[][] = [];
		const written: SubstrateEvent[] = [];
		const shot = httpXwd();
		const dir = mkdtempSync(join(tmpdir(), "substrate-desktop-http-"));
		const harness = await start(
			{
				SUBSTRATE_TOKEN_OMP: "tok-omp",
				SUBSTRATE_TOKEN_CURSOR: "tok-cursor",
				SUBSTRATE_DESKTOP_SURFACES: "omp",
				SUBSTRATE_DESKTOP_DIR: dir,
				SUBSTRATE_AUDIT_PATH: auditDirectory(),
				...envExtra,
			},
			{
				greptime: {
					ensureAppendMode: async () => true,
					lastHash: async (): Promise<string | null> => null,
					insertEvent: async (event: SubstrateEvent) => {
						written.push(event);
					},
					queryEvents: async () => [],
					readEvents: async () => [],
				},
				desktop: createDesktopDriver({
					run: async (argv: readonly string[]) => {
						calls.push([...argv]);
						if (argv.includes("getdisplaygeometry")) return { code: 0, stdout: Buffer.from("1280 800\n"), stderr: "" };
						if (argv.includes("getwindowname")) return { code: 0, stdout: Buffer.from("stub-window\n"), stderr: "" };
						if (argv.includes("xwd")) return { code: 0, stdout: shot, stderr: "" };
						return { code: 0, stdout: Buffer.from(""), stderr: "" };
					},
					dir,
					sleep: async () => {},
				}),
			},
		);
		return { harness, calls, written };
	}

	async function mcpCall(
		base: string,
		token: string | null,
		name: string,
		args: unknown,
		extraHeaders: Record<string, string> = {},
	) {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...extraHeaders,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
		});
		return { status: response.status, raw: await response.text() };
	}

	/** The tool result out of the SSE stream, or the JSON-RPC error when the gate refused. */
	function toolResult(raw: string): { isError: boolean; text: string; error?: { code: number; message: string } } {
		const data = raw
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		const envelope = JSON.parse(data ?? raw) as {
			result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
			error?: { code: number; message: string };
		};
		if (envelope.error) return { isError: true, text: "", error: envelope.error };
		const content = envelope.result?.content ?? [];
		return { isError: envelope.result?.isError === true, text: content[0]?.text ?? "" };
	}

	test("no bearer is 401 before the runner or the audit ever see the call", async () => {
		const { harness, calls } = await startDesktop();

		const { status } = await mcpCall(harness.base, null, "desktop_run", { actions: [{ type: "screenshot" }] });

		expect(status).toBe(401);
		expect(calls).toEqual([]);
		expect(harness.observability.audit.recent().filter((record) => record.tool === "desktop_run")).toEqual([]);
	});

	test("a bogus bearer is 401 and runs nothing", async () => {
		const { harness, calls } = await startDesktop();

		const { status } = await mcpCall(harness.base, "nope", "desktop_run", { actions: [{ type: "screenshot" }] });

		expect(status).toBe(401);
		expect(calls).toEqual([]);
		expect(harness.observability.audit.recent().filter((record) => record.tool === "desktop_run")).toEqual([]);
	});

	test("an unlisted surface with a valid token is refused and runs nothing", async () => {
		const { harness, calls, written } = await startDesktop();

		const { status, raw } = await mcpCall(harness.base, "tok-cursor", "desktop_run", { actions: [{ type: "screenshot" }] });
		const result = toolResult(raw);

		expect(status).toBe(200);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("nothing was run");
		expect(calls).toEqual([]);
		expect(written).toEqual([]);
	});

	test("self-attribution through an argument or a header is rejected, never honoured", async () => {
		const { harness, calls, written } = await startDesktop();

		// September's propose header is gone from the server; sending it must change
		// nothing, and the strict schema drops the surface argument before dispatch.
		const { status, raw } = await mcpCall(
			harness.base,
			"tok-omp",
			"desktop_run",
			{ actions: [{ type: "screenshot" }], surface: "omp" },
			{ "x-substrate-propose-key": "whatever" },
		);
		const result = toolResult(raw);

		expect(status).toBe(200);
		expect(result.isError).toBe(true);
		expect(calls).toEqual([]);
		expect(written).toEqual([]);
	});

	test("an audit chain that will not take the record denies the fail-closed tool", async () => {
		const { harness, calls } = await startDesktop({ SUBSTRATE_AUDIT_PATH: unwritablePath() });

		const { status, raw } = await mcpCall(harness.base, "tok-omp", "desktop_run", { actions: [{ type: "screenshot" }] });
		const result = toolResult(raw);

		expect(status).toBe(200);
		expect(result.error?.code).toBe(-32000);
		expect(result.error?.message).toContain("desktop_run");
		expect(calls).toEqual([]);
	});

	test("the audit record carries keys plus digest only, in fail-closed mode", async () => {
		const { harness, calls } = await startDesktop();
		const sentinel = "AUDIT-SILENCE-SENTINEL";

		const { status, raw } = await mcpCall(harness.base, "tok-omp", "desktop_run", {
			actions: [{ type: "type", text: sentinel }, { type: "screenshot" }],
		});
		const result = toolResult(raw);

		expect(status).toBe(200);
		expect(result.isError).toBe(false);
		expect(calls.length).toBeGreaterThan(0);
		const records = harness.observability.audit.recent().filter((record) => record.tool === "desktop_run");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ tool: "desktop_run", mode: "fail-closed" });
		for (const key of records[0]?.arg_keys ?? []) {
			expect(["actions", "timeout"]).toContain(key);
		}
		expect(JSON.stringify(records)).not.toContain(sentinel);
		expect(JSON.stringify(records)).not.toContain("iVBOR");
	});
});
