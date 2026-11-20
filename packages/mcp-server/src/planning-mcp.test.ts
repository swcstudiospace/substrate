/**
 * The planning tools (phase 52, SOTA-08), driven through a real MCP client over a temp checkout. Covered: both tools are
 * listed as read-only and admitted as reads; with no root both answer disabled and not as an error; with a root the
 * status carries hashes and counts and no file body, and a change between two calls reaches the ledger once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolClass } from "./admission.ts";
import { loadConfig } from "./config.ts";
import { PLANNING_ROOTS_ENV } from "./planning/config.ts";
import type { SessionRecord } from "./planning/presence.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import type { EventInput } from "./types.ts";
import { Substrate } from "./service.ts";

const CALLER: McpCaller = { surface: "omp", isOperator: false };
const PLANNING_TOOLS = ["planning_status", "planning_sessions"] as const;
const BODY = "PLANNING-BODY-SECRET";
const PHASE = ".planning/phases/52-planning-awareness-core";
const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");

let dir: string;
let root: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "planning-mcp-"));
	root = join(dir, "checkout");
	await mkdir(join(root, PHASE), { recursive: true });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function substrateWith(env: Record<string, string | undefined>, ledger: EventInput[] = [], presence: unknown = null) {
	return new Substrate(loadConfig(env), {
		index: null,
		greptime: null,
		planning: {
			presence: presence as never,
			emit: async (event) => {
				ledger.push(event);
				return true;
			},
		},
	});
}

/** A real repository with `origin` set: the observer resolves `origin` by asking git, which does not recognise a bare config file. */
function gitInitWithOrigin(): void {
	for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:swcstudiospace/agent-substrate.git"]]) {
		const run = Bun.spawnSync(["git", "-C", root, ...args], { env: { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
		expect(run.exitCode).toBe(0);
	}
}

async function connect(substrate: Substrate) {
	const server = createMcpServer(substrate, CALLER);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/** A tool's JSON reply: its text, whether it errored, and a parser. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content[0]?.text ?? "";
	return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

/** The checkout key the plane gives a root: the `checkout` a reply names it by. */
function keyOf(path: string): string {
	const checkout = loadConfig({ [PLANNING_ROOTS_ENV]: path }).planningCheckouts[0];
	if (checkout === undefined) throw new Error(`no checkout for ${path}`);
	return checkout.key;
}

/** A key no configured checkout has. */
const UNKNOWN_KEY = `wt-${"0".repeat(24)}`;
/** The server clock the presence fake reads at. */
const NOW = 1_800_000_000_000;

/** A presence store holding fixed records: the reader needs only the listing and the server clock. */
function presenceOver(records: SessionRecord[]) {
	return { listWithin: async () => ({ records, truncated: false }), serverNowMs: async () => NOW };
}

describe("planning tools", () => {
	test("both tools are listed as read-only and admitted as reads", async () => {
		const client = await connect(substrateWith({}));
		const { tools } = await client.listTools();
		for (const name of PLANNING_TOOLS) {
			expect(tools.find((candidate) => candidate.name === name)?.annotations?.readOnlyHint).toBe(true);
			expect(toolClass(name)).toBe("read");
		}
	});

	test("with no root, both answer disabled and neither is an error", async () => {
		const client = await connect(substrateWith({}));
		for (const name of PLANNING_TOOLS) {
			const reply = await call(client, name);
			expect(reply.isError).toBe(false);
			expect(reply.json()["state"]).toBe("disabled");
			expect(reply.json()["reason"]).toBe("root-unset");
		}
		const sessions = (await call(client, "planning_sessions")).json()["view"] as { state: string; text: string };
		expect(sessions.state).toBe("DEGRADED");
		expect(sessions.text.trim()).not.toBe("");
	});

	test("with a root, planning_status reports counts and hashes and never a file body", async () => {
		await writeFile(join(root, PHASE, "52-PLAN.md"), `---\nphase: "52"\n---\n${BODY}\n`);
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		await writeFile(join(root, PHASE, "BAD.md"), `---\nphase: [unclosed\n${BODY}\n`);
		const client = await connect(substrateWith({ [PLANNING_ROOTS_ENV]: root }));
		const reply = await call(client, "planning_status");
		expect(reply.isError).toBe(false);
		expect(reply.text).not.toContain(BODY);
		const view = reply.json();
		expect(view["state"]).toBe("ok");
		expect(view["counts"]).toEqual({ documents: 2, errors: 1, byKind: { phase: 2 } });
		expect(view["errors"]).toEqual([expect.objectContaining({ path: `${PHASE}/BAD.md`, code: "malformed-frontmatter" })]);
		expect(view["checkouts"]).toEqual([expect.objectContaining({ key: keyOf(root), root, view: expect.objectContaining({ state: "ok", counts: { documents: 2, errors: 1, byKind: { phase: 2 } } }) })]);
	});

	test("with roots, status answers every checkout, a checkout key names one, and an unknown key names none", async () => {
		const other = join(dir, "other");
		await writeFile(join(root, PHASE, "52-PLAN.md"), `---\nphase: "52"\n---\n${BODY}\n`);
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		await mkdir(join(other, PHASE), { recursive: true });
		await writeFile(join(other, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		const client = await connect(substrateWith({ [PLANNING_ROOTS_ENV]: `${root},${other}` }));

		const all = await call(client, "planning_status");
		expect(all.isError).toBe(false);
		expect(all.text).not.toContain(BODY);
		expect(all.json()["counts"]).toEqual({ documents: 2, errors: 0, byKind: { phase: 2 } });
		expect(all.json()["checkouts"]).toEqual([
			expect.objectContaining({ key: keyOf(root), root, view: expect.objectContaining({ state: "ok", counts: { documents: 2, errors: 0, byKind: { phase: 2 } } }) }),
			expect.objectContaining({ key: keyOf(other), root: other, view: expect.objectContaining({ state: "ok", counts: { documents: 1, errors: 0, byKind: { phase: 1 } } }) }),
		]);

		const named = await call(client, "planning_status", { checkout: keyOf(other) });
		expect(named.json()["checkouts"]).toEqual([expect.objectContaining({ key: keyOf(other), root: other })]);
		expect(named.json()["counts"]).toEqual({ documents: 1, errors: 0, byKind: { phase: 1 } });

		expect((await call(client, "planning_status", { checkout: UNKNOWN_KEY })).json()).toEqual({ state: "unavailable", reason: "unknown-checkout" });
	});

	test("with roots, sessions answers each checkout's own session, a checkout key names one, and an unknown key names none", async () => {
		const other = join(dir, "other");
		const session = (sessionId: string, worktree: string): SessionRecord => ({ sessionId, worktree, branch: "main", lastHeartbeatMs: NOW });
		const records = [session(keyOf(root), root), session(keyOf(other), other), session(`wt-${"f".repeat(24)}`, join(dir, "agent"))];
		const client = await connect(substrateWith({ [PLANNING_ROOTS_ENV]: `${root},${other}` }, [], presenceOver(records)));

		const all = await call(client, "planning_sessions");
		expect(all.json()["state"]).toBe("ok");
		expect(all.json()["sessions"]).toEqual([expect.objectContaining({ sessionId: keyOf(root), status: "active" })]);
		expect(all.json()["checkouts"]).toEqual([
			expect.objectContaining({ key: keyOf(root), root, view: expect.objectContaining({ state: "ok", sessions: [expect.objectContaining({ sessionId: keyOf(root) })], conflicts: [] }) }),
			expect.objectContaining({ key: keyOf(other), root: other, view: expect.objectContaining({ state: "ok", sessions: [expect.objectContaining({ sessionId: keyOf(other) })], conflicts: [] }) }),
		]);

		const named = await call(client, "planning_sessions", { checkout: keyOf(other) });
		expect(named.json()["checkouts"]).toEqual([expect.objectContaining({ key: keyOf(other) })]);
		expect(named.json()["sessions"]).toEqual([expect.objectContaining({ sessionId: keyOf(other) })]);

		const unknown = (await call(client, "planning_sessions", { checkout: UNKNOWN_KEY })).json();
		expect(unknown).toMatchObject({ state: "unavailable", reason: "unknown-checkout" });
		expect(unknown["checkouts"]).toBeUndefined();
	});

	test("status reads write nothing to the ledger: a change reaches it only through the planning observer's scan", async () => {
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		// A real repository: the observer resolves `origin` by asking git, which does not recognise a bare config file.
		gitInitWithOrigin();
		const ledger: EventInput[] = [];
		const substrate = substrateWith({ [PLANNING_ROOTS_ENV]: root }, ledger);
		const client = await connect(substrate);

		expect((await call(client, "planning_status")).json()["state"]).toBe("ok");
		expect(await substrate.planningObserver.scan()).toMatchObject({ state: "observed", outcome: "baseline" });
		expect(ledger).toEqual([]);

		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY} edited\n`);
		expect((await call(client, "planning_status")).json()["state"]).toBe("ok");
		expect(ledger).toEqual([]);

		expect(await substrate.planningObserver.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ surface: "substrate", kind: "note", repo: "swcstudiospace/agent-substrate", payload: { kind: "planning.changed" } });
		expect(JSON.stringify(ledger)).not.toContain(BODY);
	});
});

describe("the planning transition follows the metrics-history switch", () => {
	/** A substrate whose ledger writer keeps each write it is asked for. The planning reader gets no sink, so the wiring under test chooses it. */
	function substrateWithLedgerWriter(env: Record<string, string>, writes: unknown[][]) {
		const greptime = {
			recordMetricSamples: async (rows: unknown[]) => {
				writes.push(rows);
				return { stored: rows.length, drops: {} };
			},
		};
		return new Substrate(loadConfig({ ...env, [GREPTIME_URL_KEY]: "http://greptime.test:4000", [PLANNING_ROOTS_ENV]: root }), {
			index: null,
			greptime: greptime as never,
			planning: { presence: null, emit: async () => true },
		});
	}

	/** One detected change after a baseline read. Returns the stdout lines a transition wrote while it was delivered. */
	async function oneDetectedChange(substrate: Substrate): Promise<string[]> {
		gitInitWithOrigin();
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		await substrate.planningObserver.scan();
		const lines: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY} edited\n`);
			await substrate.planningObserver.scan();
			await substrate.planningObserver.settleTransitions();
		} finally {
			process.stdout.write = original;
		}
		return lines.filter((line) => line.includes("planning.transition"));
	}

	test("with the switch unset, the transition is one stdout line and no ledger write", async () => {
		const writes: unknown[][] = [];
		const lines = await oneDetectedChange(substrateWithLedgerWriter({}, writes));
		expect(writes).toEqual([]);
		expect(lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ metric: "planning.transition", outcome: "applied" })]);
	});

	test("with the switch on, the transition is one ledger metric write and no stdout line", async () => {
		const writes: unknown[][] = [];
		const lines = await oneDetectedChange(substrateWithLedgerWriter({ SUBSTRATE_METRICS_HISTORY: "on" }, writes));
		expect(writes).toEqual([[expect.objectContaining({ series: "planning.transition", labels: { outcome: "applied" }, value: 1 })]]);
		expect(lines).toEqual([]);
	});
});

describe("a held change's transition reaches stdout once, whatever the ledger does", () => {
	/** A substrate with no ledger writer; `emit`, when given, stands in for the planning ledger publish. */
	function substrateWithoutLedger(emit?: (event: EventInput) => Promise<boolean>) {
		return new Substrate(loadConfig({ [PLANNING_ROOTS_ENV]: root }), {
			index: null,
			greptime: null,
			planning: emit === undefined ? { presence: null } : { presence: null, emit },
		});
	}

	/** The planning.transition lines written to stdout while `run` executes, parsed. */
	async function transitionLines(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
		const lines: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await run();
		} finally {
			process.stdout.write = original;
		}
		return lines.filter((line) => line.includes("planning.transition")).map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	async function withOrigin(): Promise<void> {
		gitInitWithOrigin();
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
	}

	test("with no ledger configured, a held change writes one transition line, and a later read of it writes no second", async () => {
		await withOrigin();
		const substrate = substrateWithoutLedger();
		await substrate.planningObserver.scan();
		const records = await transitionLines(async () => {
			await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY} edited\n`);
			const held = await substrate.planningObserver.scan();
			expect(held).toMatchObject({ state: "observed", outcome: "not-published" });
			await substrate.planningObserver.settleTransitions();
			await substrate.planningObserver.scan();
			await substrate.planningObserver.settleTransitions();
		});
		expect(records).toEqual([expect.objectContaining({ metric: "planning.transition", outcome: "refused" })]);
	});

	test("with a failed ledger write, a held change writes one transition line, and a later read of it writes no second", async () => {
		await withOrigin();
		const substrate = substrateWithoutLedger(async () => false);
		await substrate.planningObserver.scan();
		const records = await transitionLines(async () => {
			await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY} edited\n`);
			await substrate.planningObserver.scan();
			await substrate.planningObserver.settleTransitions();
			await substrate.planningObserver.scan();
			await substrate.planningObserver.settleTransitions();
		});
		expect(records).toEqual([expect.objectContaining({ metric: "planning.transition", outcome: "refused" })]);
	});
});
