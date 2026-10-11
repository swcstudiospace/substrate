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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiServer } from "../packages/host/src/api.ts";
import { parseRoute } from "../packages/host/src/options.ts";
import {
	buildContainerSpec,
	GRAPH_LABEL,
	worktreeFor,
} from "../packages/host/src/sandbox-options.ts";
import { DISK_FLOOR_BYTES, ensureImagePulled } from "../packages/host/src/sandbox-provider.ts";
import { MemoryLeaseStore } from "../packages/host/src/substrate.ts";
import {
	MemoryTaskStore,
	TaskService,
	type SubstrateLike,
	type VmHandle,
} from "../packages/host/src/tasks.ts";

export type SmokeResult = { name: string; ok: boolean; detail: string };

function fakeSubstrate(): SubstrateLike & { claims: string[] } {
	const claims: string[] = [];
	return {
		claims,
		bearer: "smoke-bearer",
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
			return { claimed: true, lease_id: leaseId };
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
			check(`seed bearer ${graphId}`, claudeJson.includes("Bearer smoke-bearer"), "substrate MCP entry carries the bearer header"),
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
