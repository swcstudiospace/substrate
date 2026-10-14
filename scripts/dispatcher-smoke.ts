#!/usr/bin/env bun
/**
 * Dispatcher rehearsal smoke for Phase 24 (substrate-dispatcher, DISP-08 rehearsal half).
 *
 * Two layers, both rehearsal-only:
 *
 * (a) CLI layer — the real `python3 -m substrate_dispatcher --once --dry-run`
 *     against loopback HTTP fakes (fake Linear GraphQL + fake substrate-mcp
 *     JSON-RPC on ephemeral ports). Proves the poll → resolve → decide path
 *     over the real wire, including bearer carriage, plus the WR-04 `--once`
 *     refusal and the kill-switch stop. Dry-run writes nothing.
 * (b) Process layer — `scripts/dispatcher-driver.py` (real tick/reap/launch,
 *     real git worktrees, real hermes spawn into a shell-script fake, all
 *     roots under tmp). Proves launch argv, the landed-claim watch, every
 *     refusal marker, the September incident replays and the double-launch
 *     matrix. The driver exits nonzero on the first failed scenario.
 *
 * Dedicated fakes, not the Phase 16 rehearsal harness (approved deviation,
 * same precedent as mirror-smoke): the dispatcher's only externals are
 * Linear GraphQL and MCP JSON-RPC, and the harness's Postgres + real MCP
 * would add weight without covering the Linear half.
 *
 * Isolation: ephemeral 127.0.0.1 ports only (7410/7411 refused), run dir
 * under the OS tmp dir, random scratch keys, tmp state dir via
 * SUBSTRATE_STATE_DIR. Zero production writes: the fakes record every
 * request so the smoke can assert nothing was written in dry-run.
 *
 * Exit codes: 0 pass, 1 a check mismatched (names it), 2 precondition
 * refused (python3/httpx missing, production port, non-tmp run dir).
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { refuseTarget } from "./vocabulary-smoke.ts";

const RUN = `rh-disp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const GID = `rh-disp-${Date.now().toString(36)}`;
let checks = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
	checks += 1;
	if (cond) {
		process.stdout.write(`PASS ${name}\n`);
	} else {
		failures.push(name);
		process.stdout.write(`FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
	}
}

interface LinearIssue {
	id: string;
	identifier: string;
	labels: Array<{ id: string; name: string }>;
	comments: string[];
}
interface LinearRequest {
	op: string;
	auth: string | null;
	variables: Record<string, unknown>;
}
interface McpRequest {
	tool: string;
	auth: string | null;
	args: Record<string, unknown>;
}

interface FakeWorld {
	issues: Map<string, LinearIssue>;
	graphs: Map<string, { find: Record<string, unknown>; node: Record<string, unknown> }>;
	linear: LinearRequest[];
	mcp: McpRequest[];
}

function issueNode(issue: LinearIssue): Record<string, unknown> {
	return {
		id: issue.id,
		identifier: issue.identifier,
		team: { id: "t-rh", key: "RHS" },
		labels: { nodes: issue.labels.map((l) => ({ ...l })) },
	};
}

function linearResponse(
	world: FakeWorld,
	body: { query: string; variables?: Record<string, unknown> },
	auth: string | null,
): Response {
	const { query, variables = {} } : { query: string; variables?: Record<string, unknown> } = body;
	const json = (data: unknown, status = 200): Response => Response.json({ data }, { status });
	const op = query.includes("DispatchCandidates")
		? "Poll"
		: query.includes("IssueComments")
			? "Comments"
			: query.includes("commentCreate")
				? "CommentCreate"
				: query.includes("issueUpdate")
					? "IssueUpdate"
					: "unknown";
	world.linear.push({ op, auth, variables });
	if (op === "Poll") return json({ issues: { nodes: [...world.issues.values()].map(issueNode) } });
	if (op === "Comments") {
		const issue = world.issues.get(String(variables["id"]));
		if (!issue) return json({ issue: null });
		return json({ issue: { comments: { nodes: issue.comments.map((b) => ({ body: b })) } } });
	}
	if (op === "CommentCreate") {
		const input = variables["input"] as { issueId: string; body: string };
		world.issues.get(input.issueId)?.comments.push(input.body);
		return json({ commentCreate: { success: true } });
	}
	if (op === "IssueUpdate") return json({ issueUpdate: { success: true } });
	return json({ errors: [{ message: "unknown operation" }] }, 400);
}

function mcpResponse(
	world: FakeWorld,
	rpc: { id: number; params: { name: string; arguments: Record<string, unknown> } },
	auth: string | null,
): Response {
	const { name, arguments: args } = rpc.params;
	world.mcp.push({ tool: name, auth, args });
	const reply = (result: unknown): Response =>
		Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } });
	if (name === "graph_find") {
		const g = [...world.graphs.values()].find((v) => (v.find["linear_issue_id"] as string) === String(args["linear_issue_id"]));
		return reply(g ? g.find : { found: false, reason: "unknown" });
	}
	if (name === "graph_get") {
		const g = [...world.graphs.values()].find((v) => (v.find["graph_id"] as string) === String(args["graph_id"]));
		if (!g) return reply("No such graph.");
		return reply({ graph_id: args["graph_id"], nodes: [g.node] });
	}
	if (name === "events_emit") return reply({ stored: true });
	return reply({ error: "unknown tool" });
}

function hit(graphId: string, issueId: string, claimed: string | null = null): { find: Record<string, unknown>; node: Record<string, unknown> } {
	return {
		find: { found: true, graph_id: graphId, node_id: "n1", repo: "rhsmoke/smoke-repo", branch: "main", linear_issue_id: issueId, node: { node_id: "n1", state: "unstarted", claimed_by: claimed } },
		node: { node_id: "n1", state: "unstarted", claimed_by: claimed },
	};
}

async function main(argv: string[]): Promise<number> {
	void argv;
	const repoRoot = process.cwd();
	if (!existsSync(join(repoRoot, "packages/dispatcher/pyproject.toml"))) {
		process.stderr.write("[dispatcher-smoke] refusing: run from the agent-substrate checkout root.\n");
		return 2;
	}
	const py = Bun.which("python3");
	if (!py) {
		process.stderr.write("[dispatcher-smoke] refusing: python3 not on PATH.\n");
		return 2;
	}
	const runDir = mkdtempSync(join(tmpdir(), `${RUN}-`));
	if (!runDir.startsWith(tmpdir())) {
		process.stderr.write(`[dispatcher-smoke] refusing: run dir ${runDir} outside the tmp dir.\n`);
		return 2;
	}
	const linearKey = `rh-linear-${randomBytes(8).toString("hex")}`;
	const mcpBearer = `rh-bearer-${randomBytes(8).toString("hex")}`;
	const world: FakeWorld = { issues: new Map(), graphs: new Map(), linear: [], mcp: [] };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		routes: {
			"/graphql": {
				POST: async (req) =>
					linearResponse(world, ((await req.json()) as { query: string; variables?: Record<string, unknown> }), req.headers.get("authorization")),
			},
			"/mcp": {
				POST: async (req) =>
					mcpResponse(
						world,
						((await req.json()) as { id: number; params: { name: string; arguments: Record<string, unknown> } }),
						req.headers.get("authorization"),
					),
			},
		},
	});
	const fakeBase = `http://127.0.0.1:${server.port}`;
	for (const url of [`${fakeBase}/graphql`, `${fakeBase}/mcp`]) {
		const refused = refuseTarget(url);
		if (refused !== null) {
			process.stderr.write(`[dispatcher-smoke] refusing fake target: ${refused}.\n`);
			server.stop();
			return 2;
		}
	}

	const envFile = join(runDir, "substrate.env");
	writeFileSync(envFile, `LINEAR_API_KEY=${linearKey}\n`);
	const baseEnv: Record<string, string> = {
		...process.env as Record<string, string>,
		SUBSTRATE_LINEAR_URL: fakeBase,
		SUBSTRATE_MCP_URL: `${fakeBase}/mcp`,
		LINEAR_API_KEY: linearKey,
		SUBSTRATE_TOKEN: mcpBearer,
		// Pin the whole bearer chain to scratch: an inherited
		// SUBSTRATE_TOKEN_SUBSTRATE (now first priority) or token file
		// must never reach the fakes, and a failed check must never print
		// a real header (Greptile P1 security).
		SUBSTRATE_TOKEN_SUBSTRATE: mcpBearer,
		SUBSTRATE_TOKEN_FILE: "",
		SUBSTRATE_ENV_FILE: envFile,
		SUBSTRATE_STATE_DIR: join(runDir, "state"),
		PYTHONPATH: join(repoRoot, "packages/dispatcher/src"),
	};

	async function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
		const proc = Bun.spawn([py!, "-m", "substrate_dispatcher", ...args], {
			cwd: repoRoot,
			env: { ...baseEnv, ...extraEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	}
	const newIssue = (n: number, surface = "hermes"): LinearIssue => ({
		id: `i-${n}`,
		identifier: `RHS-${100 + n}`,
		labels: [{ id: `l-${surface}-${n}`, name: `dispatch:${surface}` }],
		comments: [],
	});

	process.stdout.write(`\nDispatcher smoke — ${RUN}\n\n`);

	// C1: one hermes candidate + hit → launch decision, wire auth, zero writes.
	world.issues.set("i-1", newIssue(1));
	world.graphs.set("i-1", hit(`${GID}-c1`, "i-1"));
	const linearBefore = world.linear.length;
	const c1 = await cli(["--once", "--dry-run"]);
	const c1log = c1.out + c1.err;
	check("c1 dry-run exits 0", c1.code === 0, c1.err.slice(0, 200));
	check("c1 logs the launch decision", c1log.includes("RHS-101 dispatch:hermes → launch: graph"), c1.out.slice(0, 300));
	const c1Poll = world.linear.find((r) => r.op === "Poll");
	check("c1 Linear poll carries the raw key", c1Poll?.auth === linearKey, c1Poll ? "wrong key" : "no poll request");
	const c1Find = world.mcp.find((r) => r.tool === "graph_find");
	check("c1 graph_find carries the substrate bearer", c1Find?.auth === `Bearer ${mcpBearer}`, c1Find ? "wrong bearer" : "no graph_find request");
	check(
		"c1 dry-run writes nothing",
		world.linear.every((r) => r.op === "Poll" || r.op === "Comments") && world.mcp.every((r) => r.tool !== "events_emit"),
		`linear=${world.linear.slice(linearBefore).map((r) => r.op)} mcp=${world.mcp.map((r) => r.tool)}`,
	);

	// C2: refusal classes → comment decisions, still zero writes.
	world.issues.clear();
	world.graphs.clear();
	world.issues.set("i-2", newIssue(2));
	world.issues.set("i-3", { ...newIssue(3), labels: [{ id: "l-omp-3", name: "dispatch:omp" }] });
	world.issues.set("i-4", newIssue(4));
	world.graphs.set("i-4", hit(`${GID}-c2`, "i-4", "omp"));
	const mcpBefore = world.mcp.length;
	const c2 = await cli(["--once", "--dry-run"]);
	const c2log = c2.out + c2.err;
	check("c2 exits 0", c2.code === 0, c2.err.slice(0, 200));
	check("c2 no-node logged", c2log.includes("RHS-102 dispatch:hermes → comment: no node"), c2.out.slice(0, 500));
	check("c2 not-dispatchable logged", c2log.includes("RHS-103 dispatch:omp → comment: surface omp not dispatchable"), c2.out.slice(0, 500));
	check("c2 already-claimed logged", c2log.includes("RHS-104 dispatch:hermes → comment: node already claimed by omp"), c2.out.slice(0, 500));
	check(
		"c2 dry-run writes nothing",
		world.linear.slice(linearBefore).every((r) => r.op === "Poll" || r.op === "Comments") &&
			world.mcp.slice(mcpBefore).every((r) => r.tool === "graph_find"),
		"unexpected write op",
	);

	// C3: WR-04 replay — --once without --dry-run is refused, launches nothing.
	const mcpWritesBefore = world.mcp.length;
	const linearWritesBefore = world.linear.length;
	const c3 = await cli(["--once"]);
	check("c3 --once without --dry-run exits nonzero", c3.code !== 0, `exit=${c3.code}`);
	check("c3 refusal names the rule", c3.err.includes("--once requires --dry-run"), c3.err.slice(0, 200));
	check(
		"c3 refused run contacts nothing",
		world.mcp.length === mcpWritesBefore && world.linear.length === linearWritesBefore,
		"fakes were contacted",
	);

	// C4: kill switch on → dispatch disabled before any client call.
	writeFileSync(envFile, `LINEAR_API_KEY=${linearKey}\nSUBSTRATE_DISPATCH_DISABLED=1\n`);
	const c4 = await cli(["--once", "--dry-run"]);
	const c4log = c4.out + c4.err;
	check("c4 exits 0", c4.code === 0, c4.err.slice(0, 200));
	check("c4 logs dispatch disabled", c4log.includes("dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)"), c4.out.slice(0, 200));
	check(
		"c4 disabled tick contacts nothing",
		world.mcp.length === mcpWritesBefore && world.linear.length === linearWritesBefore,
		"fakes were contacted",
	);
	writeFileSync(envFile, `LINEAR_API_KEY=${linearKey}\n`);

	// C5: two dispatch labels on one issue → two candidates, both decided.
	world.issues.clear();
	world.graphs.clear();
	world.issues.set("i-5", {
		id: "i-5",
		identifier: "RHS-105",
		labels: [
			{ id: "l-hermes-5", name: "dispatch:hermes" },
			{ id: "l-claude-code-5", name: "dispatch:claude-code" },
		],
		comments: [],
	});
	world.graphs.set("i-5", hit(`${GID}-c5`, "i-5"));
	const c5 = await cli(["--once", "--dry-run"]);
	const c5log = c5.out + c5.err;
	check("c5 exits 0", c5.code === 0, c5.err.slice(0, 200));
	check("c5 hermes launch logged", c5log.includes("RHS-105 dispatch:hermes → launch: graph"), c5.out.slice(0, 300));
	check("c5 claude-code launch logged", c5log.includes("RHS-105 dispatch:claude-code → launch: graph"), c5.out.slice(0, 300));

	// Process layer: the Python driver (real spawn/git/watch, tmp roots only).
	const driver = Bun.spawn([py!, join(repoRoot, "scripts/dispatcher-driver.py"), "--run-dir", join(runDir, "driver")], {
		cwd: repoRoot,
		env: { ...baseEnv, PYTHONPATH: join(repoRoot, "packages/dispatcher/src") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [driverOut, driverErr, driverCode] = await Promise.all([
		new Response(driver.stdout).text(),
		new Response(driver.stderr).text(),
		driver.exited,
	]);
	for (const line of driverOut.split("\n")) {
		if (line.startsWith("PASS ") || line.startsWith("FAIL ")) process.stdout.write(`${line}\n`);
	}
	check("driver exits 0 (all scenarios green)", driverCode === 0, driverErr.slice(-500) + driverOut.split("\n").filter((l) => l.startsWith("FAIL")).join("; "));

	server.stop();
	process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
	for (const failure of failures) process.stdout.write(` MISMATCH ${failure}\n`);
	return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
