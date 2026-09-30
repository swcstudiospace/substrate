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
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

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
	stores: Partial<{ index: unknown; greptime: unknown }> = {},
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
	const server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		close() {
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
