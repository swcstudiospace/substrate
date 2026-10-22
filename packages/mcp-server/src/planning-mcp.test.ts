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
import { PLANNING_ROOT_ENV } from "./planning/config.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import type { EventInput } from "./types.ts";
import { Substrate } from "./service.ts";

const CALLER: McpCaller = { surface: "omp", isOperator: false };
const PLANNING_TOOLS = ["planning_status", "planning_sessions"] as const;
const BODY = "PLANNING-BODY-SECRET";
const PHASE = ".planning/phases/52-planning-awareness-core";

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

function substrateWith(env: Record<string, string | undefined>, ledger: EventInput[] = []) {
	return new Substrate(loadConfig(env), {
		index: null,
		greptime: null,
		planning: {
			presence: null,
			emit: async (event) => {
				ledger.push(event);
				return true;
			},
		},
	});
}

async function connect(substrate: Substrate) {
	const server = createMcpServer(substrate, CALLER);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/** A tool's JSON reply: its text, whether it errored, and a parser. */
async function call(client: Client, name: string) {
	const result = await client.callTool({ name, arguments: {} });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content[0]?.text ?? "";
	return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
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
			expect(reply.json()).toEqual({ state: "disabled", reason: "root-unset" });
		}
	});

	test("with a root, planning_status reports counts and hashes and never a file body", async () => {
		await writeFile(join(root, PHASE, "52-PLAN.md"), `---\nphase: "52"\n---\n${BODY}\n`);
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		await writeFile(join(root, PHASE, "BAD.md"), `---\nphase: [unclosed\n${BODY}\n`);
		const client = await connect(substrateWith({ [PLANNING_ROOT_ENV]: root }));
		const reply = await call(client, "planning_status");
		expect(reply.isError).toBe(false);
		expect(reply.text).not.toContain(BODY);
		const view = reply.json();
		expect(view["state"]).toBe("ok");
		expect(view["counts"]).toEqual({ documents: 2, errors: 1, byKind: { phase: 2 } });
		expect(view["errors"]).toEqual([expect.objectContaining({ path: `${PHASE}/BAD.md`, code: "malformed-frontmatter" })]);
	});

	test("status reads write nothing to the ledger: a change reaches it only through the planning observer's scan", async () => {
		await writeFile(join(root, PHASE, "52-CONTEXT.md"), `${BODY}\n`);
		await mkdir(join(root, ".git"), { recursive: true });
		await writeFile(join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n');
		const ledger: EventInput[] = [];
		const substrate = substrateWith({ [PLANNING_ROOT_ENV]: root }, ledger);
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
