#!/usr/bin/node
/**
 * substrate-host entry point (D-05): the rivet registry with its local engine on 127.0.0.1:6420,
 * persistent VM storage under /var/lib/substrate/agentos, and the task API on 127.0.0.1:7411.
 *
 * Config comes from the unit's environment (infra/vps/substrate-host.service). Nothing from
 * /etc/substrate/substrate.env reaches a VM except, on route a:anthropic_key only,
 * SUBSTRATE_VM_ANTHROPIC_API_KEY as the session's model auth (D-08).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import { join } from "node:path";
import { type Client, createClient } from "@rivet-dev/agentos/client";
import { createApiServer } from "./api.ts";
import { startTrackerProxy } from "./mcp-proxy.ts";
import { formatRoute, parseRoute, parseTestsRoute, type Route, type TestsRoute, trackerRoute } from "./options.ts";
import { GRAPH_LABEL, type SandboxNetwork } from "./sandbox-options.ts";
import type { Skill, TrackerLocators } from "./seed.ts";
import { SubstrateClient } from "./substrate.ts";
import { TaskService, TaskStore, type VmHandle } from "./tasks.ts";
import { createEnsureModelRoute, createHostVm } from "./vm.ts";

const log = (line: string) => process.stdout.write(`${line}\n`);

function env(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function fail(message: string): never {
	process.stderr.write(`[substrate-host] ${message}\n`);
	process.exit(2);
}

const routeValue = env("SUBSTRATE_HOST_ROUTE") ?? fail("SUBSTRATE_HOST_ROUTE is required (03-01-SPIKE.md route_choice)");
let route: Route;
try {
	route = parseRoute(routeValue);
} catch (cause) {
	fail(String(cause));
}
const testsRouteValue = env("SUBSTRATE_TESTS_ROUTE") ?? fail("SUBSTRATE_TESTS_ROUTE is required (03-01-SPIKE.md tests_route)");
let testsRoute: TestsRoute;
try {
	testsRoute = parseTestsRoute(testsRouteValue);
} catch (cause) {
	fail(String(cause));
}

const model = env("SUBSTRATE_HOST_MODEL") ?? "grok-4.6";
const sandboxNetValue = env("SUBSTRATE_SANDBOX_NET") ?? "published_loopback";
if (sandboxNetValue !== "published_loopback" && sandboxNetValue !== "internal") fail(`invalid SUBSTRATE_SANDBOX_NET ${sandboxNetValue}`);
const sandboxNet: SandboxNetwork = sandboxNetValue;
const sandboxCollection = env("SUBSTRATE_SANDBOX_HOSTFN") ?? "sandbox";
const mcpBase = (env("SUBSTRATE_MCP_URL") ?? "http://127.0.0.1:7410/mcp").replace(/\/mcp\/?$/, "");
const apiPort = Number(env("SUBSTRATE_HOST_PORT") ?? "7411");
const engineEndpoint = env("SUBSTRATE_ENGINE_ENDPOINT") ?? "http://127.0.0.1:6420";
const storageDir = env("RIVETKIT_STORAGE_PATH") ?? "/var/lib/substrate/agentos";
const checkout = env("SUBSTRATE_CHECKOUT") ?? "/root/src/repos/agent-substrate";
const skillsDir = env("SUBSTRATE_SKILLS_DIR") ?? "/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0/skills";
const ultrathinkConfig = env("SUBSTRATE_ULTRATHINK_CONFIG") ?? "/root/.config/ultrathink/config.json";
const directKey = route.a === "anthropic_key" ? env("SUBSTRATE_VM_ANTHROPIC_API_KEY") : undefined;

// Storage: root only (rivet keeps session env and history in plaintext, D-08).
for (const dir of [storageDir, join(storageDir, "tasks")]) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

/** Shared skills: claude-ultrathink 0.3.0's four skills, every file copied verbatim. */
function loadSkills(root: string): Skill[] {
	if (!existsSync(root)) fail(`skills directory ${root} does not exist`);
	const skills: Skill[] = [];
	for (const name of readdirSync(root).sort()) {
		const dir = join(root, name);
		if (!statSync(dir).isDirectory()) continue;
		const files: Skill["files"] = [];
		const walk = (sub: string) => {
			for (const entry of readdirSync(join(dir, sub)).sort()) {
				const rel = sub ? `${sub}/${entry}` : entry;
				const full = join(dir, rel);
				if (statSync(full).isDirectory()) walk(rel);
				else files.push({ rel, content: readFileSync(full, "utf8") });
			}
		};
		walk("");
		skills.push({ name, files });
	}
	return skills;
}

/** Only the two tracker locators; the credential files beside this one are never read. */
function loadTrackers(path: string): TrackerLocators {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { notion?: { dataSourceUrl?: unknown }; linear?: { team?: unknown } };
	const notionDataSourceUrl = parsed.notion?.dataSourceUrl;
	const linearTeam = parsed.linear?.team;
	if (typeof notionDataSourceUrl !== "string" || typeof linearTeam !== "string") {
		fail(`${path} must hold notion.dataSourceUrl and linear.team`);
	}
	return { notionDataSourceUrl, linearTeam };
}

/** D-04: at boot remove only containers this host labelled; nothing else is listed or touched. */
async function sweepOrphanSandboxes(): Promise<number> {
	type Container = { Id: string; Names?: string[] };
	type Docker = {
		listContainers(opts: { all: boolean; filters: string }): Promise<Container[]>;
		getContainer(id: string): { remove(opts: { force: boolean }): Promise<unknown> };
	};
	const DockerCtor = createRequire(import.meta.url)("dockerode") as new () => Docker;
	const docker = new DockerCtor();
	const orphans = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [GRAPH_LABEL] }) });
	for (const container of orphans) {
		await docker.getContainer(container.Id).remove({ force: true });
		log(`[substrate-host] removed orphan sandbox ${container.Id.slice(0, 12)} ${container.Names?.join(",") ?? ""}`);
	}
	return orphans.length;
}

const skills = loadSkills(skillsDir);
const trackers = loadTrackers(ultrathinkConfig);
const store = new TaskStore(join(storageDir, "tasks"));
const substrate = new SubstrateClient({ baseUrl: mcpBase });

let client: Client<typeof registry> | null = null;
let engineReady = false;

const service = new TaskService({
	substrate,
	vmFor: (graphId) => {
		if (!client) throw new Error("rivet client not started");
		return client.vm.getOrCreate([graphId]) as unknown as VmHandle; // the actor handle carries every action; VmHandle names the slice TaskService drives
	},
	store,
	ensureModelRoute: createEnsureModelRoute(route, log),
	route,
	testsRoute,
	model,
	directKey,
	skills,
	trackers,
	log,
});

const { registry } = createHostVm({
	route,
	sandboxNet,
	testsRoute,
	sandboxCollection,
	checkoutNodeModules: join(checkout, "node_modules"),
	store,
	substrate,
	tasks: () => service,
	log,
});

const swept = await sweepOrphanSandboxes().catch((cause: unknown) => {
	log(`[substrate-host] orphan sweep failed: ${String(cause)}`);
	return 0;
});
log(`[substrate-host] orphan sandboxes removed: ${swept}`);

await registry.startAndWait();
engineReady = true;
client = createClient<typeof registry>({ endpoint: engineEndpoint });
log(`[substrate-host] engine ${engineEndpoint.replace(/^https?:\/\//, "")}`);

// D-10: the tracker MCP proxy exists only on the evidence-selected vm_mcp route; elsewhere the seeded
// notion/linear entries are inert (port neither exempted nor served) and the host does those writes.
const trackerProxy: Server | null = trackerRoute(route) === "vm_mcp" ? startTrackerProxy({ log }) : null;
if (!trackerProxy) log("[substrate-host] tracker mcp proxy off (tracker route host)");

const server = createApiServer(service, { engineReady: () => engineReady });
server.listen(apiPort, "127.0.0.1", () => {
	log(`[substrate-host] api 127.0.0.1:${apiPort}`);
	log(`[substrate-host] route ${formatRoute(route)}`);
	log(`[substrate-host] tests route ${testsRoute}; model ${model}; sandbox ${sandboxNet}; skills ${skills.map((s) => s.name).join(",")}`);
	log("[substrate-host] telegram approvals off");
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		log(`[substrate-host] ${signal}: stopping`);
		server.close();
		trackerProxy?.close();
		registry
			.shutdown()
			.catch((cause: unknown) => log(`[substrate-host] shutdown: ${String(cause)}`))
			.finally(() => process.exit(0));
	});
}
