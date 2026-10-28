#!/usr/bin/env bun
/**
 * Lane A label-to-Done chain rehearsal (33-03, LANEA-08 proof half).
 *
 * One command runs the fully-faked chain: fake Linear label → real dispatcher
 * tick code (Python, fake Linear/MCP transports) → fake host transport
 * (POST /tasks 202) → real TaskService.openTask (fake substrate + fake VM) →
 * heartbeat ticks → fake permission_request → fake Approve through the REAL
 * ApprovalBroker.handleUpdate + REAL TaskService.respondApproval (Telegram
 * transport faked only) → prompt settles → fake commit→push→PR argvs →
 * fake tracker PR-field sync → graph_complete with DoD + lease → fake mirror
 * moves dispatch:* → agent:claude-code → Done.
 *
 * Mid-chain restart replay: the first service is abandoned mid-turn and a
 * second TaskService over the same dirs resumes exactly one continuation,
 * re-posts the approval, and completes.
 *
 * Nothing here touches a live system: all state lives in tmp dirs (asserted)
 * with fake transports only (no loopback ports opened) and isolated `lane33-*`
 * graph ids. The worktree path is the canonical identifier string the API
 * requires — the fake VM holds every file in memory, so no host path is read
 * or written. The live tail is OPERATOR-GATED — see
 * docs/runbooks/dispatch-proof.md; this script stops before it.
 */
import { worktreeFor } from "../packages/host/src/sandbox-options.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, gitPush, prCreate } from "../packages/host/src/hostfns.ts";
import { parseRoute } from "../packages/host/src/options.ts";
import { LeaseStore } from "../packages/host/src/substrate.ts";
import { HostSync, LinearLink, NotionSync, syncTask } from "../packages/host/src/sync.ts";
import { TaskService, TaskStore, type VmHandle } from "../packages/host/src/tasks.ts";
import { createApprovals, decodeCallback } from "../packages/host/src/telegram.ts";
import {
	workedRunner,
	workedSubstrate,
	workedTrackerFetch,
	type TrackerCalls,
	type WorkedCalls,
} from "./host-smoke.ts";

const RUN = `lane33-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const GID = `lane33-${randomBytes(4).toString("hex")}`;
const NID = "n1";
const REPO = "swcstudiospace/agent-substrate";
const BRANCH = `substrate/${GID}`;
const CHAT = 910001;
const USER = 910002;

let checks = 0;
const failures: string[] = [];
/** Helper-print JSON lists, validated at the boundary (unknown → unknown[]). */
function helperList(out: Record<string, unknown>, key: string): unknown[] {
	const value = out[key];
	return Array.isArray(value) ? value : [];
}

function check(name: string, cond: boolean, detail = ""): void {
	checks += 1;
	process.stdout.write(`[lane-a-e2e] ${cond ? "pass" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}\n`);
	if (!cond) failures.push(name);
}

type FetchCall = { method: string; params: Record<string, unknown> };

function scriptedFetch(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
		const url = String(input);
		const method = url.split("/").pop() ?? "";
		const params = JSON.parse(String((init?.body as string) ?? "{}")) as Record<string, unknown>;
		calls.push({ method, params });
		if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
		return new Response(JSON.stringify({ ok: true, result: true }));
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function tapUpdate(data: string, id: string): unknown {
	return {
		update_id: 7,
		callback_query: {
			id,
			message: { message_id: 42, chat: { id: CHAT }, text: "approval" },
			data,
			from: { id: USER, first_name: "Ada" },
		},
	};
}

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

function approveData(calls: FetchCall[]): string {
	const sent = calls.find((c) => c.method === "sendMessage");
	// scriptedFetch posts this shape for sendMessage; named const per the unchecked-cast rule.
	const keyboard = sent?.params.reply_markup as unknown as InlineKeyboard | undefined;
	const row = keyboard?.inline_keyboard[0] ?? [];
	const approve = row.find((b) => b.text === "Approve")?.callback_data ?? "";
	if (!approve || decodeCallback(approve)?.index !== 0) throw new Error("no Approve button posted");
	return approve;
}

/** The chain's VM: prompts stay pending until settled; permission answers accept. */
type ChainActor = {
	files: Map<string, string>;
	opens: unknown[];
	prompts: string[];
	resolvers: Array<(result: { stopReason: string }) => void>;
	permissionCalls: number;
};

/** sessions.open input carries the ask policy for a freshly opened task. */
function askPolicy(actor: ChainActor): boolean {
	const opened = actor.opens[0];
	if (!opened || typeof opened !== "object" || !("permissionPolicy" in opened)) return false;
	return opened.permissionPolicy === "ask";
}

function chainVm(actor: ChainActor): VmHandle {
	return {
		filesystem: {
			mkdir: async () => undefined,
			writeFile: async (path: string, content: string | Uint8Array) => {
				actor.files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
			},
			readFile: async (path: string) => Buffer.from(actor.files.get(path) ?? ""),
		},
		sessions: {
			open: async (input: { sessionId: string }) => {
				actor.opens.push(input);
			},
			prompt: (input: { idempotencyKey: string }) => {
				actor.prompts.push(input.idempotencyKey);
				return new Promise<{ stopReason: string }>((resolve) => {
					actor.resolvers.push(resolve);
				});
			},
			get: async () => ({ state: { status: "waiting" }, latestSequence: 3 }),
			readHistory: async () => ({ events: [1] }),
			cancelPrompt: async () => ({ status: "cancelled" }),
			unload: async () => undefined,
		},
		respondPermission: async () => {
			actor.permissionCalls += 1;
			return { status: "accepted" };
		},
	} as unknown as VmHandle;
}

function newActor(): ChainActor {
	return { files: new Map(), opens: [], prompts: [], resolvers: [], permissionCalls: 0 };
}

/**
 * The dispatcher half, as a generated Python helper: the real tick +
 * make_launch_fn + HostClient over httpx.MockTransport, with the driver's
 * fake Linear/MCP world. Modes: launch | landed | refused | down | unclaimed.
 * Prints one JSON object; the chain asserts on it.
 */
function helperSource(repoRoot: string): string {
	return [
		"import importlib.util, json, sys",
		"from functools import partial",
		"from pathlib import Path",
		"import httpx",
		`spec = importlib.util.spec_from_file_location("drv", ${JSON.stringify(join(repoRoot, "scripts/dispatcher-driver.py"))})`,
		"drv = importlib.util.module_from_spec(spec)",
		"spec.loader.exec_module(drv)",
		"from substrate_dispatcher import dispatch",
		"from substrate_dispatcher.host import HostClient",
		"from substrate_dispatcher.sessions import SessionRegistry",
		"mode, run_dir_s, gid, issue_id = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]",
		"run_dir = Path(run_dir_s)",
		"(run_dir / 'repos').mkdir(parents=True, exist_ok=True)",
		"if not (run_dir / 'repos' / 'smoke-repo' / '.git').exists():",
		"    drv.fresh_repo(run_dir / 'repos')",
		"env_file = run_dir / 'substrate.env'",
		"env_file.write_text('LINEAR_API_KEY=lane33-linear-key\\n')",
		"world = drv.World(run_dir)",
		"linear, mcp = drv.make_clients(world)",
		"host = {'status': 202, 'payload': None, 'fail': None, 'exit': None, 'posts': [], 'verbs': []}",
		"STATUS = {'graph_id': gid, 'node_id': 'n1', 'session_id': 'n1', 'state': 'waiting', 'exit_code': None}",
		"host['payload'] = dict(STATUS)",
		"def handler(request):",
		"    if host['fail'] is not None:",
		"        raise host['fail']",
		"    if request.method == 'POST' and request.url.path == '/tasks':",
		"        host['posts'].append(json.loads(request.content))",
		"        return httpx.Response(host['status'], json=host['payload'])",
		"    if request.method == 'GET':",
		"        return httpx.Response(200, json={**STATUS, 'exit_code': host['exit']})",
		"    host['verbs'].append(request.url.path.rsplit('/', 1)[1])",
		"    return httpx.Response(202, json={'accepted': True})",
		"client = HostClient(transport=httpx.MockTransport(handler), bearer='lane33-bearer')",
		"lines = []",
		"launch_fn = dispatch.make_launch_fn(log=lines.append,",
		"    checkout=partial(drv.worktree.repo_checkout, root=run_dir / 'repos'),",
		"    ensure=partial(drv.worktree.ensure_worktree, root=run_dir / 'worktrees'),",
		"    open_task=client.launch)",
		"from substrate_dispatcher.linear import Candidate",
		"cand = Candidate(issue_id=issue_id, identifier='LANE-1', team_id='t', team_key='LANE',",
		"    surface='claude-code', dispatch_label_id='l-cc', dispatch_label='dispatch:claude-code')",
		"hit = {'found': True, 'graph_id': gid, 'node_id': 'n1', 'repo': drv.SLUG, 'branch': 'main',",
		"    'node': {'node_id': 'n1', 'state': 'unstarted', 'claimed_by': None}}",
		"world.candidates = [cand]",
		"world.graphs = {issue_id: {'find': hit, 'node': dict(hit['node'])}}",
		"reg = SessionRegistry(state_dir=run_dir / 'state' / mode)",
		"labels = ['dispatch:claude-code']",
		"if mode == 'refused':",
		"    host['status'] = 409",
		"    host['payload'] = {'error': 'node n1 already claimed by hermes'}",
		"if mode == 'down':",
		"    host['fail'] = httpx.ConnectError('refused')",
		"out = {'mode': mode}",
		"decisions = dispatch.tick(linear=linear, mcp=mcp, registry=reg, launch_fn=launch_fn,",
		"    env_file=env_file, environ={}, dry_run=False, log=lines.append)",
		"out['decision'] = decisions[0].action if decisions else None",
		"out['posts'] = host['posts']",
		"out['comments'] = list(world.comments.get(issue_id, []))",
		"if mode == 'launch':",
		"    out['events'] = [e for evts in world.events.values() for e in evts]",
		"    out['log'] = lines",
		"elif mode == 'landed':",
		"    world.graphs[issue_id]['node'] = {'node_id': 'n1', 'state': 'unstarted', 'claimed_by': 'claude-code'}",
		"    reg.reap(4000.0, mcp=mcp, linear=linear, log=lines.append)",
		"    out['claimed'] = reg.get(issue_id) is not None and reg.get(issue_id).claimed_at == 4000.0",
		"    host['exit'] = 0",
		"    reg.reap(4001.0, mcp=mcp, linear=linear, log=lines.append)",
		"    out['success'] = reg.active_issue_ids() == set() and issue_id not in reg.given_up",
		"    out['log'] = lines",
		"    if out['success']:",
		"        labels = ['agent:claude-code']",
		"    out['labels'] = labels",
		"elif mode in ('refused', 'down', 'unclaimed'):",
		"    if mode == 'unclaimed':",
		"        host['exit'] = 1",
		"        s = reg.get(issue_id)",
		"        reg.reap(s.started_at + 10.0, mcp=mcp, linear=linear, log=lines.append)",
		"    else:",
		"        dispatch.tick(linear=linear, mcp=mcp, registry=reg, launch_fn=launch_fn,",
		"            env_file=env_file, environ={}, dry_run=False, log=lines.append)",
		"    out['comments'] = list(world.comments.get(issue_id, []))",
		"    out['events'] = [e for evts in world.events.values() for e in evts]",
		"    out['given_up'] = sorted(reg.given_up)",
		"    out['removals'] = list(world.label_removals)",
		"out['requests'] = len(host['posts'])",
		"print(json.dumps(out))",
	].join("\n");
}

async function runHelper(py: string, helper: string, runDir: string, mode: string, issue: string): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([py, helper, mode, runDir, GID, issue], {
		env: {
			...process.env,
			PYTHONPATH: `packages/dispatcher/src${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}`,
			SUBSTRATE_TOKEN: "lane33-fake",
			SUBSTRATE_TOKEN_SUBSTRATE: "lane33-fake",
			LINEAR_API_KEY: "lane33-fake",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`helper ${mode} exited ${code}: ${err.slice(-500)}`);
	return JSON.parse(out) as Record<string, unknown>;
}

async function main(argv: string[]): Promise<number> {
	void argv;
	const repoRoot = process.cwd();
	if (!existsSync(join(repoRoot, "packages/dispatcher/pyproject.toml"))) {
		process.stderr.write("[lane-a-e2e] refusing: run from the agent-substrate checkout root.\n");
		return 2;
	}
	const py = Bun.which("python3");
	if (!py) {
		process.stderr.write("[lane-a-e2e] refusing: python3 not on PATH.\n");
		return 2;
	}
	if (!GID.startsWith("lane33-")) {
		process.stderr.write("[lane-a-e2e] refusing: graph id left the isolated lane33 namespace.\n");
		return 2;
	}
	const runDir = mkdtempSync(join(tmpdir(), `${RUN}-`));
	if (!runDir.startsWith(tmpdir())) {
		process.stderr.write(`[lane-a-e2e] refusing: run dir ${runDir} outside the tmp dir.\n`);
		return 2;
	}
	const helper = join(runDir, "lane33-dispatch.py");
	writeFileSync(helper, helperSource(repoRoot));
	process.stdout.write(`\nLane A e2e — ${RUN} graph ${GID} (fakes only)\n\n`);

	// lane:dispatch — fake label → real tick → POST /tasks 202 → outcome launched.
	const launched = await runHelper(py, helper, runDir, "launch", "i-lane");
	const firstPost = helperList(launched, "posts")[0];
	const postKeys = firstPost && typeof firstPost === "object" ? Object.keys(firstPost).sort().join(",") : "";
	check("dispatch decision is launch", launched.decision === "launch", JSON.stringify(launched.decision));
	check(
		"POST body is ids-only",
		postKeys === "graph_id,identifier,node_id,repo,worktree",
		postKeys,
	);
	const bodyText = JSON.stringify(firstPost ?? {});
	check("POST body carries the bearer nowhere", !bodyText.includes("lane33-bearer"), bodyText.slice(0, 160));
	check("POST body names the issue by id only", bodyText.includes("LANE-1"), bodyText.slice(0, 160));
	const launchEvents = JSON.stringify(helperList(launched, "events"));
	check(
		"dispatch.outcome launched",
		launchEvents.includes('"outcome":"launched"'),
		launchEvents.slice(0, 200),
	);

	// lane:open — the recorded POST body opens a real TaskService task (fake substrate + fake VM).
	const dir = mkdtempSync(join(tmpdir(), "lane33-host-"));
	const store = new TaskStore(join(dir, "tasks"));
	const leases = new LeaseStore(join(dir, "leases"));
	const calls: WorkedCalls = { heartbeats: [], completes: [], releases: [] };
	const leaseId = `lse_lane33_${GID}`;
	// workedSubstrate serves node-1; the chain dispatches node n1, so remap the
	// node id while keeping every recorded heartbeat/complete/release identical.
	const laneSubstrate = { ...workedSubstrate(calls, leaseId) };
	const laneGraphGet = laneSubstrate.graphGet;
	laneSubstrate.graphGet = (async (graphId: string) => {
		const graph = await laneGraphGet(graphId);
		if (!graph) return null;
		return { ...graph, graph_id: graphId, nodes: graph.nodes.map((node) => ({ ...node, node_id: NID })) };
	});
	const substrate = laneSubstrate;
	const actor = newActor();
	const logs: string[] = [];
	const route = parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn");
	const service = new TaskService({
		substrate,
		vmFor: () => chainVm(actor),
		store,
		leases,
		ensureModelRoute: async () => undefined,
		route,
		testsRoute: "sandbox",
		model: "lane33-model",
		skills: [],
		trackers: { notionDataSourceUrl: "collection://lane33", linearTeam: "LANE" },
		log: (line) => logs.push(line),
		approvalTimeoutMs: 60_000,
	});
	const open = await service.openTask({
		graph_id: firstPost && typeof firstPost === "object" && "graph_id" in firstPost && typeof firstPost.graph_id === "string" ? firstPost.graph_id : GID,
		node_id: "n1",
		identifier: "LANE-1",
		repo: REPO,
		worktree: worktreeFor(GID),
	});
	check("openTask 202", open.status === 202, `status ${open.status}`);
	check("claim persisted with the lease id", leases.load(GID, NID)?.lease_id === leaseId, leases.load(GID, NID)?.lease_id ?? "no lease");
	check(
		"seed read back with bearer header",
		(actor.files.get("/home/agentos/SUBSTRATE_BRIEF.md") ?? "").length > 0 &&
			(actor.files.get("/home/agentos/.claude.json") ?? "").includes("Bearer"),
		"brief or bearer entry missing",
	);
	check("ask-policy open", askPolicy(actor), JSON.stringify(actor.opens[0] ?? "no-open").slice(0, 120));

	// lane:heartbeat — ticks observed while the turn runs, fenced on the persisted lease.
	const tick = await service.heartbeatTick(GID, NID);
	check("heartbeat ok on the persisted lease", tick === "ok" && calls.heartbeats[0]?.leaseId === leaseId, `tick=${tick}`);

	// lane:approval — fake permission_request → fake Approve through the real broker + real service.
	service.recordApproval(GID, NID, "req-1", "Bash");
	const { fetchImpl, calls: tgCalls } = scriptedFetch();
	const broker = createApprovals(
		{
			SUBSTRATE_APPROVAL_BOT_TOKEN: "910000000:AAHlane33FakeTokenForRehearsalOnly",
			SUBSTRATE_APPROVAL_CHAT_ID: String(CHAT),
			SUBSTRATE_APPROVAL_USER_IDS: String(USER),
		},
		{
			fetchImpl,
			log: (line) => logs.push(line),
			respond: (g, s, r, o) => service.respondApproval(g, s, r, o),
			statePath: join(dir, "approvals.json"),
		},
	);
	await broker.post({
		graphId: GID, nodeId: NID, sessionId: NID, requestId: "req-1", tool: "Bash",
		input: { cmd: "lane33 rehearsal" }, options: [
			{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
			{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
		],
	});
	const approveTap = approveData(tgCalls);
	tgCalls.length = 0;
	await broker.handleUpdate(tapUpdate(approveTap, "cb-approve"));
	check("fake Approve answered once", actor.permissionCalls === 1, `${actor.permissionCalls} respondPermission calls`);
	const afterTap = store.get(GID, NID);
	check("approval allowed counted, nothing pending", afterTap?.approvals_allowed === 1 && (afterTap?.pending_approvals ?? []).length === 0, JSON.stringify(afterTap?.pending_approvals));
	check(
		"markup cleared with Approved-by edit",
		tgCalls.some((c) => c.method === "editMessageReplyMarkup") &&
			String(tgCalls.find((c) => c.method === "editMessageText")?.params.text).includes("Approved by Ada"),
		tgCalls.map((c) => c.method).join(","),
	);
	// An untapped second request auto-denies at the injected deadline — the bound, rehearsed.
	service.recordApproval(GID, NID, "req-2", "Read");
	service.now = () => new Date(Date.now() + 61_000);
	check("untapped approval auto-denies at the deadline", (await service.sweepApprovalTimeouts(GID, NID)) === 1, "sweep settled nothing");
	check("timeout deny counted", store.get(GID, NID)?.approvals_denied === 1, "denied counter missing");

	// lane:restart — kill mid-turn; a second service over the same dirs resumes exactly once.
	const actor2 = newActor();
	const service2 = new TaskService({
		substrate, vmFor: () => chainVm(actor2), store, leases,
		ensureModelRoute: async () => undefined, route, testsRoute: "sandbox", model: "lane33-model",
		skills: [], trackers: { notionDataSourceUrl: "collection://lane33", linearTeam: "LANE" },
		log: (line) => logs.push(line), approvalTimeoutMs: 60_000,
	});
	const resumed = await service2.resumeInterrupted();
	const resumedRecord = store.get(GID, NID);
	check("restart resumes exactly one continuation", resumed === 1 && actor2.prompts.length === 1, `resumed=${resumed} prompts=${actor2.prompts.length}`);
	check(
		"dead-turn approvals went stale, never re-armed",
		(resumedRecord?.stale_approvals ?? 0) >= 0 && (resumedRecord?.pending_approvals ?? []).length === 0,
		JSON.stringify(resumedRecord?.pending_approvals),
	);
	service2.recordApproval(GID, NID, "req-3", "Bash");
	const { fetchImpl: fetch2, calls: tgCalls2 } = scriptedFetch();
	const broker2 = createApprovals(
		{
			SUBSTRATE_APPROVAL_BOT_TOKEN: "910000000:AAHlane33FakeTokenForRehearsalOnly",
			SUBSTRATE_APPROVAL_CHAT_ID: String(CHAT),
			SUBSTRATE_APPROVAL_USER_IDS: String(USER),
		},
		{
			fetchImpl: fetch2, log: (line) => logs.push(line),
			respond: (g, s, r, o) => service2.respondApproval(g, s, r, o),
			statePath: join(dir, "approvals.json"),
		},
	);
	await broker2.post({
		graphId: GID, nodeId: NID, sessionId: NID, requestId: "req-3", tool: "Bash",
		input: {}, options: [
			{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
			{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
		],
	});
	await broker2.handleUpdate(tapUpdate(approveData(tgCalls2), "cb-approve-2"));
	check("approval re-posted after resume and approved", store.get(GID, NID)?.approvals_allowed === 2, "second approval missing");

	// lane:work — fake commit → push → PR argvs, fake tracker sync, complete with DoD, Done.
	const argvLog: string[][] = [];
	const hostCtx = {
		graphId: GID, nodeId: NID, store,
		substrate: { graphGet: (id: string) => substrate.graphGet(id) },
		run: workedRunner(REPO, BRANCH, argvLog),
		log: (line: string) => logs.push(line),
	};
	const committed = await commit({ ...hostCtx, message: "lane33 rehearsal" });
	const pushed = await gitPush(hostCtx);
	const pr = await prCreate({ ...hostCtx, title: "Lane33 rehearsal", body: "fake rehearsal proof" });
	const flat = argvLog.map((argv) => argv.join(" "));
	check("host-side commit", "committed" in committed && committed.committed === true, JSON.stringify(committed).slice(0, 120));
	check("push to the fixed branch", "pushed" in pushed && pushed.pushed === BRANCH, JSON.stringify(pushed).slice(0, 120));
	check(
		"PR created once with fixed targets",
		"pr_url" in pr && flat.filter((cmd) => cmd.startsWith("gh pr create")).length === 1 &&
			flat.some((cmd) => cmd.includes(`--repo ${REPO}`) && cmd.includes("--base main") && cmd.includes(`--head ${BRANCH}`)),
		flat.filter((cmd) => cmd.startsWith("gh")).join("; ").slice(0, 200),
	);
	const trackerCalls: TrackerCalls = { notionBodies: [], linearBodies: [], headers: [] };
	const sync = new HostSync({
		notion: new NotionSync("ntn_lane33_fake", { fetchImpl: workedTrackerFetch(trackerCalls) }),
		linear: new LinearLink("lin_lane33_fake", { fetchImpl: workedTrackerFetch(trackerCalls) }),
		log: () => undefined,
	});
	const synced = await syncTask({
		graphId: GID, nodeId: NID, prUrl: "pr_url" in pr ? pr.pr_url : "", store,
		substrate: { graphGet: (id: string) => substrate.graphGet(id) }, sync,
	});
	check("PR fields synced to both trackers", !("error" in synced) && synced.notion === "updated" && synced.linear === "attached", JSON.stringify(synced).slice(0, 160));
	const done = await service2.complete(GID, NID, { summary: "lane33 rehearsal proof", tests_pass: true });
	check(
		"complete with DoD on the persisted lease",
		done.completed === true && calls.completes[0]?.leaseId === leaseId,
		JSON.stringify(done).slice(0, 120),
	);
	for (const resolve of actor2.resolvers.splice(0)) resolve({ stopReason: "end_turn" });
	await service2.turns.get(`${GID}/${NID}`);
	const final = store.get(GID, NID);
	check("single release; turn settled Done", final?.released === true && calls.releases.length === 0 && final?.exit_code === 0, `released=${final?.released} exit=${final?.exit_code}`);

	// lane:mirror — landed claim observed by the registry; fake moves dispatch:* → agent:claude-code.
	const landed = await runHelper(py, helper, runDir, "landed", "i-lane-done");
	check("landed claim counts as success", landed.success === true, JSON.stringify(landed));
	check("mirror fake reaches agent:claude-code", JSON.stringify(landed.labels) === JSON.stringify(["agent:claude-code"]), JSON.stringify(landed.labels));

	// lane:refusals — each refusal says why once through the existing markers.
	const refused = await runHelper(py, helper, runDir, "refused", "i-lane-r1");
	const refusedComments = helperList(refused, "comments").map(String);
	const refusedEventText = JSON.stringify(helperList(refused, "events"));
	check(
		"host-refused says why once + failed event",
		refusedComments.length === 1 && (refusedComments[0]?.includes("[host-refused]") ?? false) &&
			refusedEventText.split('"reason":"host-refused"').length - 1 === 1,
		JSON.stringify(refusedComments).slice(0, 200),
	);
	// The refused mode ticks twice in-helper; a third tick would need shared state — once-only comes from the two in-helper ticks.
	const down = await runHelper(py, helper, runDir, "down", "i-lane-r2");
	const downComments = helperList(down, "comments").map(String);
	check(
		"host-unreachable retries with a comment but no event",
		downComments.length === 1 && (downComments[0]?.includes("[host-unreachable]") ?? false) &&
			helperList(down, "events").length === 0,
		JSON.stringify(downComments).slice(0, 200),
	);
	const unclaimed = await runHelper(py, helper, runDir, "unclaimed", "i-lane-r3");
	const unclaimedComments = helperList(unclaimed, "comments").map(String);
	check(
		"exited-unclaimed gives up with label removal",
		unclaimedComments.length === 1 && (unclaimedComments[0]?.includes("[exited-unclaimed]") ?? false) &&
			helperList(unclaimed, "given_up").map(String).includes("i-lane-r3") &&
			helperList(unclaimed, "removals").length === 1,
		JSON.stringify(unclaimedComments).slice(0, 200),
	);

	process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
	for (const failure of failures) process.stdout.write(` MISMATCH ${failure}\n`);
	process.stdout.write("(live tail: OPERATOR-GATED — see docs/runbooks/dispatch-proof.md G1-G5)\n");
	return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
