#!/usr/bin/env bun
/**
 * Two-VM rehearsal proof (`bun run smoke:host`, D31-10).
 *
 * Two `openTask` calls for two graph ids against a fake VmHandle + fake
 * docker land in two actors with two sandbox containers: each carries the
 * graph label, loopback-only port bindings, no privileged flag, no
 * docker-socket mount, and distinct per-container tokens. Plus the disk-gate
 * refusal case and the loopback API bind. No rivet runtime, no daemon, no
 * substrate writes — the gated tail stays operator-run.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../packages/host/src/api.ts";
import { branchFor, commit, gitPush, prCreate, type Runner } from "../packages/host/src/hostfns.ts";
import { parseRoute } from "../packages/host/src/options.ts";
import {
	buildContainerSpec,
	GRAPH_LABEL,
	worktreeFor,
} from "../packages/host/src/sandbox-options.ts";
import { DISK_FLOOR_BYTES, ensureImagePulled } from "../packages/host/src/sandbox-provider.ts";
import { LeaseStore, type LeaseStoreLike, MemoryLeaseStore } from "../packages/host/src/substrate.ts";
import { HostSync, LinearLink, NotionSync, syncTask } from "../packages/host/src/sync.ts";
import {
	MemoryTaskStore,
	TaskService,
	TaskStore,
	type SubstrateLike,
	type VmHandle,
} from "../packages/host/src/tasks.ts";

export type SmokeResult = { name: string; ok: boolean; detail: string };

function fakeSubstrate(): SubstrateLike & { claims: string[] } {
	const claims: string[] = [];
	return {
		claims,
		graphGet: async (graphId: string) => ({
			graph_id: graphId,
			nodes: [
				{
					graph_id: graphId,
					node_id: "node-1",
					linear_issue_id: null,
					linear_identifier: "SWC-1",
					notion_page: null,
					state: null,
					claimed_by: null,
					claimed_at: null,
					claim_session: null,
				},
			],
		}),
		graphClaim: async (graphId: string, nodeId: string) => {
			claims.push(`${graphId}/${nodeId}`);
			return { claimed: true };
		},
		claimAndPersist: async (store, graphId: string, nodeId: string) => {
			claims.push(`${graphId}/${nodeId}`);
			const leaseId = `lse_smoke_${graphId}`;
			store.persist(graphId, nodeId, { lease_id: leaseId, acquiredAtMs: 0, ttlSeconds: 900 });
			return { claimed: true, lease: { lease_id: leaseId } };
		},
		heartbeat: async () => ({ ok: true }),
		graphComplete: async () => ({ completed: true }),
		graphRelease: async () => ({ released: true }),
		brief: async () => "smoke brief",
	};
}

export type FakeActor = {
	graphId: string;
	files: Map<string, string>;
	opens: Array<Parameters<VmHandle["sessions"]["open"]>[0]>;
	prompts: number;
};

export function fakeVmPool(pool: Map<string, FakeActor>): (graphId: string) => VmHandle {
	return (graphId: string) => {
		let actor = pool.get(graphId);
		if (!actor) {
			actor = { graphId, files: new Map(), opens: [], prompts: 0 };
			pool.set(graphId, actor);
		}
		const current = actor;
		return {
			filesystem: {
				mkdir: async () => undefined,
				writeFile: async (path: string, content: string | Uint8Array) => {
					current.files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
				},
				readFile: async (path: string) => Buffer.from(current.files.get(path) ?? ""),
			},
			sessions: {
				open: async (input) => {
					current.opens.push(input);
				},
				prompt: async () => {
					current.prompts += 1;
					return { stopReason: "end" };
				},
				get: async () => ({ state: { status: "done" }, latestSequence: 1 }),
				readHistory: async () => ({ events: [] }),
				cancelPrompt: async () => undefined,
				unload: async () => undefined,
			},
			respondPermission: async () => ({ status: "not_pending" as const }),
		};
	};
}

function check(name: string, ok: boolean, detail: string): SmokeResult {
	return { name, ok, detail };
}

/** Recorded substrate calls of the worked-node rehearsal. */
export type WorkedCalls = {
	heartbeats: Array<{ graphId: string; nodeId: string; leaseId: string }>;
	completes: Array<{ graphId: string; nodeId: string; leaseId: string | null; dod: unknown }>;
	releases: string[];
};

/**
 * Fake substrate for the worked node: grants one fixed lease id, answers heartbeats ok,
 * and records every heartbeat/complete/release for the assertions below.
 */
export function workedSubstrate(calls: WorkedCalls, leaseId: string): SubstrateLike {
	const graph = (graphId: string) => ({
		graph_id: graphId,
		repo: "swcstudiospace/agent-substrate",
		branch: "main",
		nodes: [
			{
				graph_id: graphId,
				node_id: "node-1",
				linear_issue_id: null,
				linear_identifier: "SWC-1",
				notion_page: null,
				state: null,
				claimed_by: null,
				claimed_at: null,
				claim_session: null,
			},
		],
	});
	return {
		graphGet: async (graphId: string) => graph(graphId),
		graphClaim: async () => ({ claimed: true }),
		claimAndPersist: async (store: LeaseStoreLike, graphId: string, nodeId: string) => {
			store.persist(graphId, nodeId, { lease_id: leaseId, acquiredAtMs: 0, ttlSeconds: 900 });
			return { claimed: true, lease: { lease_id: leaseId } };
		},
		heartbeat: async (graphId: string, nodeId: string, lid: string) => {
			calls.heartbeats.push({ graphId, nodeId, leaseId: lid });
			return { ok: true };
		},
		graphComplete: async (graphId: string, nodeId: string, lid: string | null, dod: unknown) => {
			calls.completes.push({ graphId, nodeId, leaseId: lid, dod });
			return { completed: true };
		},
		graphRelease: async (graphId: string, nodeId: string, lid: string | null) => {
			calls.releases.push(`${graphId}/${nodeId}:${lid ?? "null"}`);
			return { released: true };
		},
		brief: async () => "smoke brief",
	};
}

/** The worked node's VM: a prompt that stays pending until the rehearsal settles it. */
export type WorkedActor = {
	files: Map<string, string>;
	opens: Array<Parameters<VmHandle["sessions"]["open"]>[0]>;
	prompts: string[];
	permissionCalls: number;
	settle: (stopReason: string) => void;
};

export function workedVm(actor: WorkedActor): VmHandle {
	let resolvePrompt: ((result: { stopReason: string }) => void) | null = null;
	actor.settle = (stopReason) => resolvePrompt?.({ stopReason });
	return {
		filesystem: {
			mkdir: async () => undefined,
			writeFile: async (path: string, content: string | Uint8Array) => {
				actor.files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
			},
			readFile: async (path: string) => Buffer.from(actor.files.get(path) ?? ""),
		},
		sessions: {
			open: async (input) => {
				actor.opens.push(input);
			},
			prompt: (input) => {
				actor.prompts.push(input.idempotencyKey);
				return new Promise<{ stopReason: string }>((resolve) => {
					resolvePrompt = resolve;
				});
			},
			get: async () => ({ state: { status: "idle" }, latestSequence: 1 }),
			readHistory: async () => ({ events: [] }),
			cancelPrompt: async () => undefined,
			unload: async () => undefined,
		},
		respondPermission: async () => {
			actor.permissionCalls += 1;
			return { status: "not_pending" as const };
		},
	};
}

/** Fake git/gh runner for the worked node: probes answer clean, every argv is recorded. */
export function workedRunner(gid: string, repo: string, branch: string, argvLog: string[][]): Runner {
	return async (argv) => {
		argvLog.push([...argv]);
		const key = argv[0] === "git" && argv[1] === "-C" ? argv.slice(3).join(" ") : argv.join(" ");
		if (key === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: `${branch}\n`, stderr: "" };
		if (key === "remote get-url origin") return { code: 0, stdout: `https://github.com/${repo}.git\n`, stderr: "" };
		if (key === "diff --name-only origin/main...HEAD") return { code: 0, stdout: "packages/host/src/tasks.ts\n", stderr: "" };
		if (key === "rev-parse HEAD") return { code: 0, stdout: `${"deadbeef".repeat(5)}\n`, stderr: "" };
		if (key.startsWith("gh pr create")) return { code: 0, stdout: `https://github.com/${repo}/pull/99\n`, stderr: "" };
		if (key.startsWith("push origin ") || key.startsWith("add -A") || key.includes("commit -m")) return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
	};
}

/** Recorded tracker traffic of the worked-node rehearsal. */
export type TrackerCalls = { notionBodies: unknown[]; linearBodies: unknown[]; headers: Array<Record<string, string>> };

/**
 * Fake Notion/Linear endpoints: the task row exists, the PATCH lands, Linear exposes the
 * link-only attachment mutation. Every body and header set is recorded for the fields-only scan.
 */
export function workedTrackerFetch(calls: TrackerCalls): typeof fetch {
	return (async (url: unknown, init: unknown) => {
		const u = String(url);
		const { headers, body } = (init ?? {}) as { headers?: Record<string, string>; body?: string };
		calls.headers.push({ ...(headers ?? {}) });
		const parsed = body ? (JSON.parse(String(body)) as Record<string, unknown>) : {};
		if (u.includes("api.notion.com")) {
			if (u.includes("/query")) {
				return new Response(JSON.stringify({ results: [{ id: "page-smoke-1", properties: { "PR URL": { url: null } } }] }), { status: 200 });
			}
			calls.notionBodies.push(parsed);
			return new Response(JSON.stringify({}), { status: 200 });
		}
		calls.linearBodies.push(parsed);
		const query = String((parsed as { query?: unknown }).query ?? "");
		if (query.includes("__type")) {
			return new Response(JSON.stringify({ data: { __type: { fields: [{ name: "attachmentLinkURL" }] } } }), { status: 200 });
		}
		if (query.includes("IssueId")) {
			return new Response(JSON.stringify({ data: { issue: { id: "issue-smoke-1" } } }), { status: 200 });
		}
		return new Response(JSON.stringify({ data: { attachmentLinkURL: { success: true } } }), { status: 200 });
	}) as unknown as typeof fetch;
}

/**
 * The worked-node rehearsal (32-03, D32-10): open → claim persisted → seed read-back →
 * ask-policy open → heartbeat during the turn → host-side commit → push → pr-create →
 * PR-fields-only sync → complete with DoD + lease → single release. The prompt settles
 * after the completion, so the settle finds the `released` flag and re-releases nothing.
 * Fake VM + fake substrate + fake docker + fake trackers; no network, no daemon, no writes.
 */
export async function runWorkedNode(): Promise<SmokeResult[]> {
	const results: SmokeResult[] = [];
	const gid = "ut-smoke-ccc33333";
	const nid = "node-1";
	const repo = "swcstudiospace/agent-substrate";
	const branch = `substrate/${gid}`;
	const leaseId = `lse_smoke_${gid}`;
	const prUrl = `https://github.com/${repo}/pull/99`;
	const dir = mkdtempSync(join(tmpdir(), "smoke-worked-"));
	try {
		const store = new TaskStore(join(dir, "tasks"));
		const leases = new LeaseStore(join(dir, "leases"));
		const calls: WorkedCalls = { heartbeats: [], completes: [], releases: [] };
		const substrate = workedSubstrate(calls, leaseId);
		const actor: WorkedActor = { files: new Map(), opens: [], prompts: [], permissionCalls: 0, settle: () => undefined };
		const handle = workedVm(actor);
		const logs: string[] = [];
		const service = new TaskService({
			substrate,
			vmFor: () => handle,
			store,
			leases,
			ensureModelRoute: async () => undefined,
			ensureSubstrateRoute: async () => undefined,
			route: parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn"),
			testsRoute: "sandbox",
			model: "smoke-model",
			skills: [],
			trackers: { notionDataSourceUrl: "collection://smoke", linearTeam: "SWC" },
			log: (line) => logs.push(line),
		});

		const open = await service.openTask({ graph_id: gid, node_id: nid, identifier: "SWC-1", repo, worktree: worktreeFor(gid) });
		results.push(check("worked open", open.status === 202, `status ${open.status} (claim + seed + open + prompt)`));

		let leaseMode = 0;
		try {
			leaseMode = statSync(join(dir, "leases", `${gid}__${nid}.lease.json`)).mode & 0o777;
		} catch {
			leaseMode = 0;
		}
		results.push(
			check("worked lease file", leaseMode === 0o600 && leases.load(gid, nid)?.lease_id === leaseId, `mode ${leaseMode.toString(8)} in the sibling leases dir`),
		);

		const claudeJson = actor.files.get("/home/agentos/.claude.json") ?? "";
		results.push(
			check(
				"worked seed",
				actor.files.get("/home/agentos/SUBSTRATE_BRIEF.md") === "smoke brief" &&
					claudeJson.includes("http://127.0.0.1:7410/mcp") &&
					!claudeJson.includes("Bearer") &&
					!claudeJson.includes("smoke-bearer"),
				"brief written and read back; s:hostfn substrate entry headerless and inert (host functions carry it)",
			),
		);
		results.push(
			check("worked ask-policy open", actor.opens[0]?.permissionPolicy === "ask" && actor.opens[0]?.sessionId === nid, `policy=${actor.opens[0]?.permissionPolicy}`),
		);

		const tick = await service.heartbeatTick(gid, nid);
		results.push(
			check("worked heartbeat", tick === "ok" && calls.heartbeats.length === 1 && calls.heartbeats[0]?.leaseId === leaseId, `tick=${tick} fenced on the persisted lease`),
		);

		const argvLog: string[][] = [];
		const hostCtx = {
			graphId: gid,
			nodeId: nid,
			store,
			substrate: { graphGet: (id: string) => substrate.graphGet(id) },
			run: workedRunner(gid, repo, branch, argvLog),
			log: (line: string) => logs.push(line),
		};
		const committed = await commit({ ...hostCtx, message: "worked node" });
		const pushed = await gitPush(hostCtx);
		const pr1 = await prCreate({ ...hostCtx, title: "Worked node", body: "fake rehearsal proof" });
		const pr2 = await prCreate({ ...hostCtx, title: "Worked node", body: "fake rehearsal proof" });
		const flat = argvLog.map((argv) => argv.join(" "));
		results.push(check("worked commit", "committed" in committed && committed.committed === true, "host-side add (scratch excluded) + commit"));
		results.push(
			check("worked push", "pushed" in pushed && pushed.pushed === branch && flat.includes(`git -C ${worktreeFor(gid)} push origin ${branch}`), `fixed target origin ${branch}`),
		);
		const ghCalls = flat.filter((cmd) => cmd.startsWith("gh pr create"));
		results.push(
			check(
				"worked pr-create",
				"pr_url" in pr1 && pr1.pr_url === prUrl && "existing" in pr2 && pr2.existing === true && ghCalls.length === 1,
				"one PR per task; the second call returns the recorded URL without running gh",
			),
		);
		results.push(
			check(
				"worked git targets",
				flat.some((cmd) => cmd.includes(`--repo ${repo}`) && cmd.includes("--base main") && cmd.includes(`--head ${branch}`)) &&
					flat.some((cmd) => cmd.includes(":(exclude,glob)**/.substrate-*")) &&
					!flat.some((cmd) => cmd.includes("--force")),
				"repo/base/head fixed by the host; scratch excluded; no force",
			),
		);

		const trackerCalls: TrackerCalls = { notionBodies: [], linearBodies: [], headers: [] };
		const fetchImpl = workedTrackerFetch(trackerCalls);
		const sync = new HostSync({ notion: new NotionSync("ntn_smoke_key", { fetchImpl }), linear: new LinearLink("lin_smoke_key", { fetchImpl }), log: () => undefined });
		const synced = await syncTask({ graphId: gid, nodeId: nid, prUrl, store, substrate: { graphGet: (id: string) => substrate.graphGet(id) }, sync });
		results.push(check("worked sync", !("error" in synced) && synced.notion === "updated" && synced.linear === "attached", "PR fields reach both trackers through the real HostSync"));
		const patchText = JSON.stringify(trackerCalls.notionBodies[0] ?? {});
		const trafficText = JSON.stringify([...trackerCalls.notionBodies, ...trackerCalls.linearBodies, ...trackerCalls.headers]);
		results.push(
			check(
				"worked sync fields",
				patchText ===
					JSON.stringify({
						properties: {
							"PR URL": { url: prUrl },
							"PR #": { number: 99 },
							"PR State": { select: { name: "Open" } },
							Repo: { rich_text: [{ text: { content: repo } }] },
							Branch: { rich_text: [{ text: { content: branch } }] },
						},
					}) &&
					!trafficText.includes("issueUpdate") &&
					!trafficText.includes("Status") &&
					!trafficText.includes("smoke-bearer") &&
					!trafficText.includes(leaseId),
				"PR URL/# /State/Repo/Branch only; no workflow state; no bearer or lease value",
			),
		);

		const done = await service.complete(gid, nid, { summary: "worked node proof", tests_pass: true });
		const completeCall = calls.completes[0];
		results.push(
			check(
				"worked complete",
				done.completed === true &&
					completeCall?.leaseId === leaseId &&
					JSON.stringify(completeCall?.dod) === JSON.stringify({ summary: "worked node proof", tests_pass: true }),
				"DoD + persisted lease reach graph_complete",
			),
		);
		actor.settle("end_turn");
		await service.turns.get(`${gid}/${nid}`);
		results.push(
			check("worked single release", calls.releases.length === 0 && store.get(gid, nid)?.released === true, "release via complete only; the settle re-releases nothing"),
		);
		results.push(
			check("worked approvals untouched", actor.permissionCalls === 0 && (store.get(gid, nid)?.pending_approvals ?? []).length === 0, "respondApproval never called; nothing pending"),
		);
		results.push(
			check(
				"worked logs presence-only",
				logs.some((line) => line.includes("lease persisted") && line.includes("yes")) &&
					!logs.some((line) => line.includes("smoke-bearer") || line.includes(leaseId)),
				"lease presence logged; neither value appears",
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return results;
}

/** The rehearsal proof. No network, no daemon, no substrate writes. */
export async function runSmoke(): Promise<SmokeResult[]> {
	const results: SmokeResult[] = [];
	const pool = new Map<string, FakeActor>();
	const substrate = fakeSubstrate();
	const service = new TaskService({
		substrate,
		vmFor: fakeVmPool(pool),
		store: new MemoryTaskStore(),
		leases: new MemoryLeaseStore(),
		ensureModelRoute: async () => undefined,
		ensureSubstrateRoute: async () => undefined,
		route: parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn"),
		testsRoute: "sandbox",
		model: "smoke-model",
		skills: [],
		trackers: { notionDataSourceUrl: "collection://smoke", linearTeam: "SWC" },
		log: () => undefined,
	});

	const graphs = ["ut-smoke-aaa11111", "ut-smoke-bbb22222"];
	for (const graphId of graphs) {
		const result = await service.openTask({
			graph_id: graphId,
			node_id: "node-1",
			identifier: "SWC-1",
			repo: "swcstudiospace/agent-substrate",
			worktree: worktreeFor(graphId),
		});
		results.push(
			check(`openTask ${graphId}`, result.status === 202, `status ${result.status} (claim + seed + open + prompt)`),
		);
	}

	results.push(check("two actors", pool.size === 2, `${pool.size} vm handles for ${graphs.length} graph ids`));
	for (const graphId of graphs) {
		const actor = pool.get(graphId);
		const opened = actor?.opens[0];
		results.push(
			check(
				`session ${graphId}`,
				opened?.permissionPolicy === "ask" && opened?.agent === "claude" && (actor?.prompts ?? 0) >= 1,
				`policy=${opened?.permissionPolicy} agent=${opened?.agent} prompts=${actor?.prompts}`,
			),
		);
		const brief = actor?.files.get("/home/agentos/SUBSTRATE_BRIEF.md");
		results.push(check(`seed ${graphId}`, brief === "smoke brief", "brief file written and read back"));
		const claudeJson = actor?.files.get("/home/agentos/.claude.json") ?? "";
		results.push(
			check(`seed credential-free ${graphId}`, !claudeJson.includes("Bearer") && !claudeJson.includes("smoke-bearer"), "substrate MCP entry carries no bearer header"),
		);
	}

	const tokens = new Map<string, string>();
	for (const graphId of graphs) {
		const token = randomBytes(32).toString("base64url");
		tokens.set(graphId, token);
		const spec = buildContainerSpec({ graphId, worktree: worktreeFor(graphId), token, network: "published_loopback" });
		const labels = (spec["Labels"] ?? {}) as Record<string, string>;
		const hostConfig = (spec["HostConfig"] ?? {}) as Record<string, unknown>;
		const bindings = (hostConfig["PortBindings"] ?? {}) as Record<string, Array<{ HostIp?: string }>>;
		const firstBinding = Object.values(bindings)[0]?.[0];
		const binds = (hostConfig["Binds"] ?? []) as string[];
		results.push(check(`label ${graphId}`, labels[GRAPH_LABEL] === graphId, `${GRAPH_LABEL}=${labels[GRAPH_LABEL]}`));
		results.push(
			check(`loopback ${graphId}`, firstBinding?.HostIp === "127.0.0.1", `HostIp=${firstBinding?.HostIp}`),
		);
		results.push(check(`unprivileged ${graphId}`, hostConfig["Privileged"] === false, "Privileged=false"));
		results.push(
			check(
				`no socket ${graphId}`,
				binds.every((bind) => !bind.includes("docker.sock")),
				`${binds.length} binds, none mounts the docker socket`,
			),
		);
	}
	const [tokenA, tokenB] = graphs.map((graphId) => tokens.get(graphId));
	results.push(check("tokens distinct", !!tokenA && !!tokenB && tokenA !== tokenB, "per-container tokens differ"));

	const refused = await ensureImagePulled(
		{
			getImage: () => {
				throw new Error("docker must not be reached below the floor");
			},
			pull: async () => {
				throw new Error("docker must not be reached below the floor");
			},
			modem: { followProgress: () => undefined },
			createContainer: async () => {
				throw new Error("unreachable");
			},
			getContainer: () => {
				throw new Error("unreachable");
			},
			getNetwork: () => {
				throw new Error("unreachable");
			},
			createNetwork: async () => undefined,
		},
		"substrate-sandbox:0.1",
		() => `Avail\n${DISK_FLOOR_BYTES - 1}\n`,
	).then(
		() => null,
		(error: unknown) => String(error),
	);
	results.push(
		check("disk gate refuses", refused !== null && refused.includes(`floor ${DISK_FLOOR_BYTES}`), refused ?? "gate allowed (BAD)"),
	);

	const api = createApiServer(service, { engineReady: () => true });
	const bound = await new Promise<{ address: string; port: number }>((resolve, reject) => {
		api.on("error", reject);
		api.listen(0, "127.0.0.1", () => {
			const address = api.address();
			if (address && typeof address === "object") resolve({ address: address.address, port: address.port });
			else reject(new Error("api did not bind"));
		});
	});
	results.push(check("api loopback", bound.address === "127.0.0.1", `bound ${bound.address}:${bound.port}`));
	const reply = await fetch(`http://127.0.0.1:${bound.port}/tasks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ bogus: true }),
	});
	results.push(check("api refuses bad body", reply.status === 400, `POST /tasks → ${reply.status}`));
	await new Promise<void>((resolve) => api.close(() => resolve()));

	const root = join(import.meta.dir, "..");
	const mainSource = readFileSync(join(root, "packages/host/src/main.ts"), "utf8");
	results.push(
		check("main binds loopback", mainSource.includes('listen(apiPort, "127.0.0.1"'), "api listen is 127.0.0.1, not 0.0.0.0"),
	);
	const unit = readFileSync(join(root, "infra/vps/substrate-host.service"), "utf8");
	results.push(
		check(
			"unit staged (not installed)",
			unit.includes("SUBSTRATE_HOST_PORT=7411") && unit.includes("STAGED ONLY"),
			"port 7411 staged; install is OPERATOR-GATED G4",
		),
	);
	for (const worked of await runWorkedNode()) results.push(worked);
	return results;
}

if (import.meta.main) {
	const results = await runSmoke();
	let failed = 0;
	for (const result of results) {
		process.stdout.write(`[smoke:host] ${result.ok ? "pass" : "FAIL"} ${result.name} — ${result.detail}\n`);
		if (!result.ok) failed += 1;
	}
	if (failed > 0) process.exit(1);
	process.stdout.write(`[smoke:host] ${results.length} checks green (fakes only; gated tail stays operator-run)\n`);
}
