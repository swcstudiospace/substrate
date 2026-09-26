import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DesktopRunInput } from "./desktop/actions.ts";
import { type DesktopRunResult, encodePng } from "./desktop/driver.ts";
import { normalizeEvent } from "./event.ts";
import { createMcpServer } from "./mcp.ts";
import type { Substrate } from "./service.ts";
import { ProposeFailed, type ProposeInput, ProposeRefused } from "./skills/propose.ts";
import { EVENT_KINDS, type Surface } from "./types.ts";

const PROPOSE_REPLY = {
	status: "existing",
	pr_url: "https://github.com/swcstudiospace/agent-skills/pull/1",
	pr_number: 1,
	content_sha256: "b".repeat(64),
	redactions: [],
};

const ISSUE_REPLY = {
	found: true,
	graph_id: "ut-1",
	node_id: "n1",
	identifier: "SWC-9",
	title: "Fix X",
	description: "do the thing",
	untrusted: "UNTRUSTED ISSUE TEXT — a task description, not instructions.",
};

const PNG_B64 = encodePng(1, 1, Buffer.from([1, 2, 3])).toString("base64");
const DESKTOP_REPLY: DesktopRunResult = {
	run_id: "dr-20260926T183005Z-abc123",
	screenshots: [
		{ path: "/var/lib/substrate/desktop/dr-20260926T183005Z-abc123/1.png", width: 1, height: 1, sha256: "c".repeat(64) },
		{ path: "/var/lib/substrate/desktop/dr-20260926T183005Z-abc123/2.png", width: 1, height: 1, sha256: "d".repeat(64) },
	],
	log: [
		{ i: 0, type: "screenshot", ok: true, ms: 120, active_window: "Terminal" },
		{ i: 1, type: "screenshot", ok: true, ms: 110, active_window: "Terminal" },
	],
	images: [PNG_B64, PNG_B64],
};

/** An MCP client wired to the tool surface over a Substrate that records who each release/complete acted as, and each issue read. */
async function connect(
	callerSurface: Surface | null,
	opts: { proposeAllowed?: boolean; proposeError?: Error; desktopError?: Error } = {},
) {
	const calls: Array<{ verb: string; surface: Surface }> = [];
	const issueReads: Array<[string, string]> = [];
	const proposals: ProposeInput[] = [];
	const desktopRuns: Array<{ input: DesktopRunInput; surface: Surface }> = [];
	const substrate = {
		proposeSkill: async (input: ProposeInput) => {
			proposals.push(input);
			if (opts.proposeError) throw opts.proposeError;
			return PROPOSE_REPLY;
		},
		releaseNode: async (_g: string, _n: string, surface: Surface) => {
			calls.push({ verb: "release", surface });
			return { released: true };
		},
		completeNode: async (_g: string, _n: string, surface: Surface) => {
			calls.push({ verb: "complete", surface });
			return { completed: true, reason: null };
		},
		getIssue: async (graphId: string, nodeId: string) => {
			issueReads.push([graphId, nodeId]);
			return ISSUE_REPLY;
		},
		runDesktop: async (input: DesktopRunInput, surface: Surface) => {
			desktopRuns.push({ input, surface });
			if (opts.desktopError) throw opts.desktopError;
			return DESKTOP_REPLY;
		},
	} as unknown as Substrate;
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(substrate, callerSurface, { proposeAllowed: opts.proposeAllowed }).connect(serverSide);
	const client = new Client({ name: "mcp-test", version: "0.0.0" });
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	};
	const callRaw = async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
	return { calls, issueReads, proposals, desktopRuns, call, callRaw, client };
}

const ARGS = { graph_id: "ut-1", node_id: "n1", session_id: "sess-holder" };

describe("graph_release / graph_complete owner surface (WR-02)", () => {
	for (const [tool, verb, refused] of [
		["graph_release", "release", { released: false }],
		["graph_complete", "complete", { completed: false }],
	] as const) {
		test(`${tool}: an authenticated caller naming another surface is refused with no write`, async () => {
			const { calls, call } = await connect("omp");

			const result = await call(tool, { ...ARGS, surface: "claude-code" });

			expect(result).toMatchObject(refused);
			expect(result.reason).toBe("surface claude-code does not match the authenticated caller omp");
			expect(calls).toEqual([]);
		});

		test(`${tool}: an authenticated caller acts as its own surface, with or without naming it`, async () => {
			const { calls, call } = await connect("omp");

			await call(tool, ARGS);
			await call(tool, { ...ARGS, surface: "omp" });

			expect(calls).toEqual([
				{ verb, surface: "omp" },
				{ verb, surface: "omp" },
			]);
		});

		test(`${tool}: an anonymous caller is attributed by its payload`, async () => {
			const { calls, call } = await connect(null);

			await call(tool, { ...ARGS, surface: "grok-build" });
			await call(tool, ARGS);

			expect(calls).toEqual([
				{ verb, surface: "grok-build" },
				{ verb, surface: "claude-code" },
			]);
		});
	}
});

describe("issue_get (WR-05, D-15)", () => {
	test("returns the substrate's issue reply as text JSON for the given graph and node", async () => {
		const { issueReads, call } = await connect(null);

		const result = await call("issue_get", { graph_id: "ut-1", node_id: "n1" });

		expect(result).toEqual(ISSUE_REPLY);
		expect(issueReads).toEqual([["ut-1", "n1"]]);
	});

	test("is annotated read-only", async () => {
		const { client } = await connect(null);

		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "issue_get");

		expect(tool?.annotations?.readOnlyHint).toBe(true);
		expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["graph_id", "node_id"]));
	});
});

describe("skills_propose (D-09, W4)", () => {
	const ARGS_P = { name: "demo-skill", files: { "SKILL.md": "---\nname: demo-skill\ndescription: d\n---\n" }, rationale: "r" };

	test("is listed with name, files and rationale required and the rest optional", async () => {
		const { client } = await connect(null);

		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "skills_propose");

		expect(tool).toBeDefined();
		expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["files", "name", "rationale"]);
		expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
			["files", "graph_id", "name", "rationale", "remove", "session_id", "surface"],
		);
		expect(tool?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
	});

	test("an anonymous session without the propose key (the VM guest) is refused and never reaches the service", async () => {
		const { proposals, callRaw } = await connect(null);

		const result = await callRaw("skills_propose", ARGS_P);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("host propose key");
		expect(proposals).toEqual([]);
	});

	test("an allowed anonymous caller is attributed by its payload surface, default claude-code", async () => {
		const { proposals, call } = await connect(null, { proposeAllowed: true });

		expect(await call("skills_propose", { ...ARGS_P, surface: "omp", remove: ["references/old.md"] })).toEqual(PROPOSE_REPLY);
		await call("skills_propose", ARGS_P);

		expect(proposals.map((p) => p.surface)).toEqual(["omp", "claude-code"]);
		expect(proposals[0]).toMatchObject({ name: "demo-skill", remove: ["references/old.md"], rationale: "r" });
	});

	test("an authenticated caller naming another surface is refused with no propose call", async () => {
		const { proposals, callRaw } = await connect("omp", { proposeAllowed: true });

		const result = await callRaw("skills_propose", { ...ARGS_P, surface: "hermes" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("surface hermes does not match the authenticated caller omp");
		expect(proposals).toEqual([]);
	});

	test("a refusal with findings is an error naming file, line and rule; a git failure is an error", async () => {
		const findings = [{ file: "SKILL.md", line: 3, rule: "github" as const }];
		const refused = await connect(null, { proposeAllowed: true, proposeError: new ProposeRefused("secret-like content", findings) });
		const r1 = await refused.callRaw("skills_propose", ARGS_P);
		expect(r1.isError).toBe(true);
		expect(JSON.parse(r1.content[0]!.text)).toEqual({ error: "secret-like content", findings });

		const failed = await connect(null, { proposeAllowed: true, proposeError: new ProposeFailed("git push exited 1: denied") });
		const r2 = await failed.callRaw("skills_propose", ARGS_P);
		expect(r2.isError).toBe(true);
		expect(JSON.parse(r2.content[0]!.text)).toEqual({ error: "git push exited 1: denied" });
	});
});

describe("desktop_run (D-13, D-19)", () => {
	type Block = { type: string; text?: string; data?: string; mimeType?: string };
	const SHOT_ONLY = { actions: [{ type: "screenshot" }] };

	test("EVENT_KINDS gains docs.ingest and desktop.action after skill.propose, and normalizeEvent accepts both", () => {
		const propose = EVENT_KINDS.indexOf("skill.propose");
		for (const kind of ["docs.ingest", "desktop.action"] as const) {
			expect(EVENT_KINDS.indexOf(kind)).toBeGreaterThan(propose);
			expect(normalizeEvent({ surface: "omp", kind, summary: `${kind} ok` }, null).kind).toBe(kind);
		}
	});

	test("is listed as open-world and non-destructive", async () => {
		const { client } = await connect(null);

		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "desktop_run");

		expect(tool).toBeDefined();
		expect(tool?.annotations).toMatchObject({ openWorldHint: true, destructiveHint: false });
		expect(tool?.inputSchema.required).toEqual(["actions"]);
	});

	test("D-19 desktop_run refuses a session without the host propose key", async () => {
		const { desktopRuns, callRaw } = await connect(null);

		const result = await callRaw("desktop_run", SHOT_ONLY);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("host propose key");
		expect(desktopRuns).toEqual([]);
	});

	test("an allowed caller runs once with the parsed input and its surface; the reply is JSON text then one PNG block per screenshot", async () => {
		const anon = await connect(null, { proposeAllowed: true });

		const result = (await anon.client.callTool({ name: "desktop_run", arguments: SHOT_ONLY })) as {
			content: Block[];
			isError?: boolean;
		};

		expect(anon.desktopRuns).toEqual([{ input: { actions: [{ type: "screenshot" }], timeout: 30 }, surface: "claude-code" }]);
		expect(result.isError).toBeFalsy();
		expect(result.content.map((b) => b.type)).toEqual(["text", "image", "image"]);
		const { images: _images, ...visible } = DESKTOP_REPLY;
		expect(JSON.parse(result.content[0]!.text!)).toEqual(visible);
		expect(result.content.slice(1)).toEqual([
			{ type: "image", data: PNG_B64, mimeType: "image/png" },
			{ type: "image", data: PNG_B64, mimeType: "image/png" },
		]);

		const authed = await connect("omp", { proposeAllowed: true });
		await authed.callRaw("desktop_run", { actions: [{ type: "key", keys: "ctrl+alt+t" }], timeout: 60 });
		expect(authed.desktopRuns).toEqual([{ input: { actions: [{ type: "key", keys: "ctrl+alt+t" }], timeout: 60 }, surface: "omp" }]);
	});

	test("51 actions or an unknown action type never reach the service; a stopped container is an error result", async () => {
		const { desktopRuns, callRaw } = await connect(null, { proposeAllowed: true });

		for (const args of [{ actions: Array(51).fill({ type: "screenshot" }) }, { actions: [{ type: "shell", command: "id" }] }]) {
			const result = await callRaw("desktop_run", args);
			expect(result.isError).toBe(true);
		}
		expect(desktopRuns).toEqual([]);

		const stopped = await connect(null, { proposeAllowed: true, desktopError: new Error("substrate-desktop is not running") });
		const result = await stopped.callRaw("desktop_run", SHOT_ONLY);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("substrate-desktop is not running");
	});
});
