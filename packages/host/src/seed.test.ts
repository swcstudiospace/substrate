import { describe, expect, test } from "bun:test";
import { redact } from "../../mcp-server/src/redact.ts";
import { parseRoute, type Route, type TestsRoute, trackerRoute } from "./options.ts";
import { renderPrompt, type RenderPromptInput, type SeedFile, type SeedFilesInput, seedFiles } from "./seed.ts";
import type { GraphView } from "./substrate.ts";

const A = ["loopback", "hostfn_proxy", "anthropic_key"] as const;
const B = ["hooks", "prompt_hostfn", "host_after_turn"] as const;
const C = ["vm_git", "sandbox_git", "hostfn_commit"] as const;
const S = ["mcp", "hostfn"] as const;

function allRoutes(): Route[] {
	const routes: Route[] = [];
	for (const a of A) for (const b of B) for (const c of C) for (const s of S) routes.push({ a, b, c, s });
	return routes;
}

const GID = "ut-a-12345678";
const NID = "n1";
const HOSTFN_ROUTE = parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn");
const MCP_ROUTE = parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:mcp");
const VM_MCP_ROUTE = parseRoute("a:loopback,b:hooks,c:vm_git,s:mcp");

function promptInput(overrides: Partial<RenderPromptInput> = {}): RenderPromptInput {
	return {
		identifier: "SWC-42",
		graphId: GID,
		nodeId: NID,
		repo: "swcstudiospace/agent-substrate",
		sessionId: NID,
		route: HOSTFN_ROUTE,
		testsRoute: "sandbox",
		...overrides,
	};
}

const GRAPH: GraphView = {
	graph_id: GID,
	repo: "swcstudiospace/agent-substrate",
	branch: "main",
	notion_task_page: "https://www.notion.so/task-0123456789abcdef0123456789abcdef",
	status: "Implementing",
	nodes: [
		{
			graph_id: GID,
			node_id: NID,
			linear_issue_id: "11111111-2222-3333-4444-555555555555",
			linear_identifier: "SWC-42",
			notion_page: "https://www.notion.so/node-0123456789abcdef0123456789abcdef",
			state: "unstarted",
			claimed_by: "claude-code",
			claimed_at: "2026-09-25T00:00:00Z",
			claim_session: NID,
		},
	],
};

const BARE_GRAPH: GraphView = {
	graph_id: GID,
	repo: "swcstudiospace/agent-substrate",
	branch: "main",
	nodes: [
		{
			graph_id: GID,
			node_id: NID,
			linear_issue_id: null,
			linear_identifier: null,
			notion_page: null,
			state: "unstarted",
			claimed_by: null,
			claimed_at: null,
			claim_session: null,
		},
	],
};

const PROMPT = renderPrompt(promptInput());
const CLOCK = () => new Date("2026-09-25T12:00:00Z");

function seedInput(overrides: Partial<SeedFilesInput> = {}): SeedFilesInput {
	return {
		brief: "## Substrate brief: swcstudiospace/agent-substrate — ut-a-12345678\n\nline two\n",
		skills: [
			{ name: "ultrathink-kickoff", files: [{ rel: "SKILL.md", content: "# kickoff\n" }] },
			{ name: "ultrathink-plan", files: [{ rel: "SKILL.md", content: "# plan\n" }] },
			{ name: "ultrathink-ship", files: [{ rel: "SKILL.md", content: "# ship\n" }] },
			{ name: "ultrathink-sync", files: [{ rel: "SKILL.md", content: "# sync\n" }] },
		],
		trackers: { notionDataSourceUrl: "collection://0123456789abcdef0123456789abcdef", linearTeam: "SWC" },
		graph: GRAPH,
		nodeId: NID,
		route: HOSTFN_ROUTE,
		prompt: PROMPT,
		now: CLOCK,
		...overrides,
	};
}

function fileAt(files: SeedFile[], path: string): string {
	const matches = files.filter((f) => f.path === path);
	expect(matches).toHaveLength(1);
	return matches[0]?.content ?? "";
}

describe("renderPrompt (D-15)", () => {
	test("carries the ids, orders issue_get before graph_complete, ends with release-and-stop, names claude-code and the host claim", () => {
		const prompt = renderPrompt(promptInput());
		for (const id of ["SWC-42", GID, NID, "swcstudiospace/agent-substrate"]) expect(prompt).toContain(id);
		expect(prompt).toContain(`session id ${NID}`);
		const issueGet = prompt.indexOf("issue_get");
		const complete = prompt.indexOf("graph_complete");
		expect(issueGet).toBeGreaterThan(-1);
		expect(complete).toBeGreaterThan(issueGet);
		const releaseStep = prompt.slice(prompt.lastIndexOf("(6)"));
		expect(releaseStep).toContain("graph_release");
		expect(releaseStep).toContain(NID);
		expect(releaseStep).toContain("stop");
		expect(prompt).toContain("claude-code");
		expect(prompt).toContain("already claimed this node");
	});

	test("names the s: channel's issue_get: agentos-substrate issue-get on hostfn, mcp__substrate__issue_get on mcp", () => {
		expect(renderPrompt(promptInput({ route: HOSTFN_ROUTE }))).toContain(`agentos-substrate issue-get --node ${NID}`);
		expect(renderPrompt(promptInput({ route: HOSTFN_ROUTE }))).not.toContain("mcp__substrate__issue_get");
		expect(renderPrompt(promptInput({ route: MCP_ROUTE }))).toContain("mcp__substrate__issue_get");
		expect(renderPrompt(promptInput({ route: MCP_ROUTE }))).not.toContain("agentos-substrate issue-get");
	});

	test("rejects an invalid identifier, node id, graph id or repo", () => {
		expect(() => renderPrompt(promptInput({ identifier: "swc-42" }))).toThrow(/identifier/);
		expect(() => renderPrompt(promptInput({ identifier: "SWC-42; rm -rf /" }))).toThrow(/identifier/);
		expect(() => renderPrompt(promptInput({ nodeId: "n1/../x" }))).toThrow(/node id/);
		expect(() => renderPrompt(promptInput({ graphId: "../etc" }))).toThrow(/graph id/);
		expect(() => renderPrompt(promptInput({ repo: "no-slash" }))).toThrow(/repo/);
		expect(() => renderPrompt(promptInput({ repo: "a/../b" }))).toThrow(/repo/);
		expect(() => renderPrompt(promptInput({ sessionId: "s p a c e" }))).toThrow(/session id/);
	});

	test("is ids-only: no issue-text parameter, no title:/description: content, and forbids committing .substrate- files", () => {
		const keys = Object.keys(promptInput()).sort();
		expect(keys).toEqual(["graphId", "identifier", "nodeId", "repo", "route", "sessionId", "testsRoute"]);
		for (const route of allRoutes()) {
			for (const testsRoute of ["sandbox", "oneshot", "none"] as const) {
				const prompt = renderPrompt(promptInput({ route, testsRoute }));
				expect(prompt).not.toMatch(/\btitle:\s*\S/);
				expect(prompt).not.toMatch(/\bdescription:\s*\S/);
				expect(prompt).toContain("never add files whose names start with .substrate- to a commit");
			}
		}
	});

	test("kickoff step (stateFile) only on tracker_route vm_mcp, before the issue_get step", () => {
		for (const route of allRoutes()) {
			const prompt = renderPrompt(promptInput({ route }));
			const skill = prompt.indexOf("/home/agentos/.claude/skills/ultrathink-kickoff/SKILL.md");
			const state = prompt.indexOf("stateFile=/home/agentos/.substrate/ultrathink-state.json");
			if (trackerRoute(route) === "vm_mcp") {
				expect(skill).toBeGreaterThan(-1);
				expect(state).toBeGreaterThan(-1);
				expect(state).toBeLessThan(prompt.indexOf("issue_get"));
				expect(skill).toBeLessThan(prompt.indexOf("issue_get"));
			} else {
				expect(skill).toBe(-1);
				expect(state).toBe(-1);
			}
		}
	});

	test("tests step follows testsRoute: sandbox run-command | agentos-substrate run-tests --node | cannot run here", () => {
		const step = (testsRoute: TestsRoute) => {
			const prompt = renderPrompt(promptInput({ testsRoute }));
			return prompt.slice(prompt.indexOf("(4)"), prompt.indexOf("(5)"));
		};
		expect(step("sandbox")).toContain("agentos-sandbox run-command");
		expect(step("sandbox")).not.toContain("run-tests");
		expect(step("oneshot")).toContain(`agentos-substrate run-tests --node ${NID}`);
		expect(step("oneshot")).not.toContain("agentos-sandbox run-command");
		expect(step("none")).toContain("cannot run on this host");
		expect(step("none")).toContain("tests_pass false");
		expect(step("none")).toContain("say why");
		expect(step("none")).not.toContain("run-command");
		expect(step("none")).not.toContain("run-tests");
	});

	test("step (4) names the c-route's commit, then git-push and pr-create, before graph_complete (03-07)", () => {
		for (const route of allRoutes()) {
			const prompt = renderPrompt(promptInput({ route }));
			const step = prompt.slice(prompt.indexOf("(4)"), prompt.indexOf("(5)"));
			const push = step.indexOf(`agentos-substrate git-push --node ${NID}`);
			const pr = step.indexOf(`agentos-substrate pr-create --node ${NID} --title`);
			expect(push).toBeGreaterThan(-1);
			expect(pr).toBeGreaterThan(push);
			expect(step).toContain("--body");
			expect(step.indexOf("Commit your work")).toBeLessThan(push);
			expect(prompt.indexOf("graph_complete")).toBeGreaterThan(prompt.indexOf("pr-create"));
			if (route.c === "hostfn_commit") {
				expect(step).toContain(`agentos-substrate commit --node ${NID} --message`);
				expect(step).not.toContain("shim");
			} else if (route.c === "sandbox_git") {
				expect(step).toContain("shim");
				expect(step).toContain("-m only");
				expect(step).not.toContain("agentos-substrate commit");
			} else {
				expect(step).toContain("git in /home/agentos/work");
				expect(step).not.toContain("shim");
				expect(step).not.toContain("agentos-substrate commit");
			}
		}
	});

	test("sync step (D-10): vm_mcp runs ultrathink-sync in the VM through the notion/linear servers with the state file and PR URL, PR fields only, never Done, no agentos-substrate sync", () => {
		for (const route of allRoutes()) {
			if (trackerRoute(route) !== "vm_mcp") continue;
			const prompt = renderPrompt(promptInput({ route }));
			const step = prompt.slice(prompt.indexOf("(4)"), prompt.indexOf("(5)"));
			expect(step).toContain("/home/agentos/.claude/skills/ultrathink-sync/SKILL.md");
			expect(step).toContain("stateFile=/home/agentos/.substrate/ultrathink-state.json");
			expect(step).toContain("prUrl=<the PR URL>");
			expect(step).toContain("notion and linear MCP servers");
			expect(step).toContain("PR URL, PR #, PR State (Open), Repo and Branch");
			expect(step).toContain("PR link on the Linear issue");
			expect(step).toContain("no Linear state change");
			expect(step).toContain("never Done");
			expect(step).not.toContain("agentos-substrate sync");
			expect(step.indexOf("pr-create")).toBeLessThan(step.indexOf("ultrathink-sync"));
		}
	});

	test("sync step (D-10): tracker_route host applies the same SKILL through agentos-substrate sync --node on b:hooks and b:prompt_hostfn; b:host_after_turn has no sync step", () => {
		for (const route of allRoutes()) {
			if (trackerRoute(route) !== "host") continue;
			const prompt = renderPrompt(promptInput({ route }));
			const step = prompt.slice(prompt.indexOf("(4)"), prompt.indexOf("(5)"));
			if (route.b === "host_after_turn") {
				expect(step).not.toContain("ultrathink-sync");
				expect(step).not.toContain("agentos-substrate sync");
				expect(prompt).not.toContain("sync");
			} else {
				expect(step).toContain("/home/agentos/.claude/skills/ultrathink-sync/SKILL.md");
				expect(step).toContain(`agentos-substrate sync --node ${NID} --pr-url`);
				expect(step).toContain("PR URL, PR #, PR State (Open), Repo and Branch");
				expect(step).toContain("never Done");
				expect(step).not.toContain("stateFile=");
				expect(step).not.toContain("MCP servers");
			}
		}
	});
});

describe("seedFiles (SC-2, D-08, D-11)", () => {
	test(".claude.json names exactly substrate, notion and linear with loopback urls, type http, no headers or env — on every route", () => {
		for (const route of allRoutes()) {
			const files = seedFiles(seedInput({ route }));
			const parsed = JSON.parse(fileAt(files, "/home/agentos/.claude.json")) as {
				mcpServers: Record<string, Record<string, unknown>>;
			};
			expect(Object.keys(parsed.mcpServers).sort()).toEqual(["linear", "notion", "substrate"]);
			expect(parsed.mcpServers.substrate).toEqual({ type: "http", url: "http://127.0.0.1:7410/mcp" });
			expect(parsed.mcpServers.notion).toEqual({ type: "http", url: "http://127.0.0.1:7412/mcp/notion" });
			expect(parsed.mcpServers.linear).toEqual({ type: "http", url: "http://127.0.0.1:7412/mcp/linear" });
			for (const server of Object.values(parsed.mcpServers)) {
				expect(server).not.toHaveProperty("headers");
				expect(server).not.toHaveProperty("env");
			}
		}
	});

	test("config.json holds exactly notion.dataSourceUrl and linear.team; one SKILL.md per skill; the brief verbatim", () => {
		const input = seedInput();
		const files = seedFiles(input);
		const config = JSON.parse(fileAt(files, "/home/agentos/.config/ultrathink/config.json")) as Record<string, Record<string, unknown>>;
		expect(Object.keys(config).sort()).toEqual(["linear", "notion"]);
		expect(Object.keys(config.notion ?? {})).toEqual(["dataSourceUrl"]);
		expect(Object.keys(config.linear ?? {})).toEqual(["team"]);
		expect(config.notion?.dataSourceUrl).toBe("collection://0123456789abcdef0123456789abcdef");
		expect(config.linear?.team).toBe("SWC");
		const skillPaths = files.map((f) => f.path).filter((p) => p.endsWith("/SKILL.md"));
		expect(skillPaths).toEqual(input.skills.map((s) => `/home/agentos/.claude/skills/${s.name}/SKILL.md`));
		expect(fileAt(files, "/home/agentos/SUBSTRATE_BRIEF.md")).toBe(input.brief);
	});

	test("ultrathink-state.json is a complete-tracking SessionRecord for the node; the .xml is the rendered prompt", () => {
		const files = seedFiles(seedInput());
		const state = JSON.parse(fileAt(files, "/home/agentos/.substrate/ultrathink-state.json")) as Record<string, any>;
		expect(state.sessionId).toBe(NID);
		expect(state.host).toBe("claude-code");
		expect(state).not.toHaveProperty("engine");
		expect(state.result).toEqual({ xml: PROMPT, original: "", root: "", source: "fallback" });
		expect(state.plan.graphId).toBe(GID);
		expect(state.plan.task).toMatchObject({
			graphId: GID,
			item: `dispatched node ${NID} of graph ${GID}`,
			agent: "claude-code",
			status: "Implementing",
			linearState: "In Progress",
			repo: "swcstudiospace/agent-substrate",
			branch: "main",
		});
		expect(state.plan.task.item).not.toContain("SWC-42");
		for (const list of ["issues", "subIssues", "linearIssues", "linearSubIssues"]) expect(state.plan[list]).toEqual([]);
		expect(state.plan.hitl).toEqual({ blocking: [], nonBlocking: [] });
		expect(state.tracking.graphId).toBe(GID);
		expect(state.tracking.status).toBe("complete");
		expect(state.tracking.linearTeam).toBe("SWC");
		expect(state.tracking.linear.nodes).toEqual({
			[NID]: { id: "11111111-2222-3333-4444-555555555555", identifier: "SWC-42", url: "", title: "" },
		});
		expect(state.tracking.linear.steps).toEqual({});
		expect(state.tracking.notion.taskUrl).toBe("https://www.notion.so/task-0123456789abcdef0123456789abcdef");
		expect(state.tracking.notion.nodes).toEqual({ [NID]: "https://www.notion.so/node-0123456789abcdef0123456789abcdef" });
		expect(state.tracking.errors).toEqual([]);
		expect(state.tracking.updatedAt).toBe(CLOCK().getTime());
		expect(fileAt(files, "/home/agentos/.substrate/ultrathink-state.xml")).toBe(PROMPT);
	});

	test("omits the Linear ref and the Notion task url when the graph lacks them", () => {
		const files = seedFiles(seedInput({ graph: BARE_GRAPH }));
		const state = JSON.parse(fileAt(files, "/home/agentos/.substrate/ultrathink-state.json")) as Record<string, any>;
		expect(state.tracking.status).toBe("complete");
		expect(state.tracking.linear.nodes).toEqual({});
		expect(state.tracking.notion).not.toHaveProperty("taskUrl");
		expect(state.tracking.notion.nodes).toEqual({});
		expect(state.plan.graphId).toBe(GID);
	});

	test("no seeded file changes under redact() on any route (no credential in any file)", () => {
		for (const route of allRoutes()) {
			for (const file of seedFiles(seedInput({ route, prompt: renderPrompt(promptInput({ route })) }))) {
				expect(redact(file.content)).toBe(file.content);
			}
		}
	});

	test("b:hooks seeds PostToolUse(Bash) and Stop shims only; every other b-route seeds no settings.json", () => {
		const SETTINGS = "/home/agentos/.claude/settings.json";
		for (const route of allRoutes()) {
			const files = seedFiles(seedInput({ route }));
			const settings = files.filter((f) => f.path === SETTINGS);
			if (route.b !== "hooks") {
				expect(settings).toHaveLength(0);
				continue;
			}
			expect(settings).toHaveLength(1);
			type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> };
			const hooks = (JSON.parse(settings[0]?.content ?? "") as { hooks: { PostToolUse: HookEntry[]; Stop: HookEntry[] } }).hooks;
			expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "Stop"]);
			expect(hooks).not.toHaveProperty("UserPromptSubmit");
			expect(hooks.PostToolUse).toHaveLength(1);
			expect(hooks.PostToolUse[0]?.matcher).toBe("Bash");
			const post = hooks.PostToolUse[0]?.hooks[0]?.command ?? "";
			const stop = hooks.Stop[0]?.hooks[0]?.command ?? "";
			expect(hooks.Stop[0]).not.toHaveProperty("matcher");
			for (const [command, hook] of [
				[post, "pr-sync"],
				[stop, "stop"],
			] as const) {
				expect(command).toContain("cat > /home/agentos/work/.substrate-hook-input.json");
				expect(command).toContain("agentos-sandbox run-command");
				expect(command).toContain(`bun /opt/claude-ultrathink/hooks/${hook}.ts < /work/.substrate-hook-input.json`);
				expect(command).toContain("rm -f /home/agentos/work/.substrate-hook-input.json");
				expect(command.indexOf("cat >")).toBeLessThan(command.indexOf("run-command"));
				expect(command.indexOf("run-command")).toBeLessThan(command.indexOf("rm -f"));
			}
		}
	});

	test("rejects a skill name or file path that escapes the skills directory", () => {
		expect(() => seedFiles(seedInput({ skills: [{ name: "../x", files: [] }] }))).toThrow(/skill name/);
		expect(() => seedFiles(seedInput({ skills: [{ name: "ok", files: [{ rel: "../SKILL.md", content: "" }] }] }))).toThrow(/skill file path/);
	});
});

describe("seed on the 03-01 route", () => {
	test("tracker_route host still seeds the three servers and the state file; the prompt has no kickoff step", () => {
		expect(trackerRoute(HOSTFN_ROUTE)).toBe("host");
		const files = seedFiles(seedInput({ route: HOSTFN_ROUTE }));
		expect(files.map((f) => f.path)).toContain("/home/agentos/.substrate/ultrathink-state.json");
		expect(files.map((f) => f.path)).not.toContain("/home/agentos/.claude/settings.json");
		expect(PROMPT).not.toContain("ultrathink-kickoff/SKILL.md");
	});

	test("vm_mcp route: the prompt and the shim agree on the state file and the scratch file", () => {
		const prompt = renderPrompt(promptInput({ route: VM_MCP_ROUTE }));
		const files = seedFiles(seedInput({ route: VM_MCP_ROUTE, prompt }));
		expect(prompt).toContain("stateFile=/home/agentos/.substrate/ultrathink-state.json");
		expect(fileAt(files, "/home/agentos/.substrate/ultrathink-state.xml")).toBe(prompt);
		expect(fileAt(files, "/home/agentos/.claude/settings.json")).toContain(".substrate-hook-input.json");
	});
});
