// The agentOS VM definition (D-01, D-05, D-12, D-13): one actor per graph id. The only file
// besides main.ts that imports rivet.
//
// Three @rivet-dev/agentos 0.2.21 defects 03-01 found are carried here, exactly as the spike
// worked around them:
//   1. one sidecar process holds a single host-callback handler, so every VM gets its own
//      sidecar pool (`sidecar: { kind: "shared", pool: "vm-<gid>" }`);
//   2. AgentOs.create resolves hostFunctions before it expands `sandbox`, dropping the sandbox
//      collection — so resolveSandboxOptions runs inside resolveOptions; the actor layer spreads
//      the resolved options over the base ones, so the substrate collection is passed through the
//      same call instead of living on the base definition;
//   3. the expanded options carry their sandbox dispose hooks on a non-enumerable symbol that the
//      actor layer's spread drops — so they are kept per actor here and run from onVmDisposed.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import claude from "@agentos-software/claude-code";
import { agentOS, getSandboxDisposeHooks, type HostFunctionCollections, resolveSandboxOptions, setup } from "@rivet-dev/agentos";
import { sandboxAgentProvider } from "@rivet-dev/agentos-sandbox";
import { z } from "zod";
import { redact } from "../../mcp-server/src/redact.ts";
import { commit, execFileRunner, gitPush, PR_BODY_MAX, PR_TITLE_MAX, prCreate, COMMIT_MESSAGE_MAX } from "./hostfns.ts";
import { type HostSync, syncTask } from "./sync.ts";
import {
	copyLibraryInto,
	hostFunctionPermissions,
	libraryCopyPlan,
	listLibrary,
	loopbackPorts,
	MODEL_RELAY_PORT,
	MODEL_RELAY_URL,
	type MountRoute,
	networkPermissions,
	type Route,
	skillMounts,
	type TestsRoute,
	testRunArgv,
	worktreeFor,
} from "./options.ts";
import type { SandboxNetwork } from "./sandbox-options.ts";
import { substrateDocker } from "./sandbox-provider.ts";
import { hostCallTarget, type TaskService, type TaskStoreLike, type VmHandle } from "./tasks.ts";
import type { ApprovalBroker } from "./telegram.ts";
import type { Dod, SubstrateClient } from "./substrate.ts";
import { HOST_SURFACE } from "./substrate.ts";

export type HostVmConfig = {
	route: Route;
	sandboxNet: SandboxNetwork;
	/** 03-01's tests_route: on oneshot the substrate collection gains run-tests. */
	testsRoute: TestsRoute;
	/** The sandbox host-function collection name 03-01 recorded (hostfn_sandbox_collection). */
	sandboxCollection: string;
	/** `<checkout>/node_modules`, bound read-only at /work/node_modules when it exists. */
	checkoutNodeModules: string;
	store: TaskStoreLike;
	substrate: SubstrateClient;
	/** D-10 host-side sync (tracker_route host, the model's `agentos-substrate sync`); null when no tracker key is configured. */
	sync: HostSync | null;
	/** Late-bound: the service exists before the registry starts, the client only after. */
	tasks: () => TaskService;
	/** Set by main.ts before registry.start(); off when the approval bot keys are absent. */
	broker: ApprovalBroker;
	/** D-08: the git-backed skill library, read afresh at every VM boot. */
	libraryDir: string;
	/** 04-01-SPIKE.md mount_route (none = copy). */
	mountRoute: MountRoute;
	/** Skill names seed.ts writes (the ultrathink four): never mounted over or copied. */
	reservedSkills: readonly string[];
	log: (line: string) => void;
};

/** Actor keys are string arrays; the graph id is the first element. */
function graphIdOf(key: readonly unknown[]): string {
	const gid = key[0];
	if (typeof gid !== "string") throw new Error("VM actor key must start with the graph id");
	return gid;
}

/** Zod input → the argv shape hostCallTarget guards (`--node n1 --summary …`). */
function argvOf(input: Record<string, unknown>): string[] {
	const argv: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		argv.push(`--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`, String(value));
	}
	return argv;
}

/**
 * The `substrate` collection (route s:hostfn): agentos-substrate issue-get | release | complete.
 * Graph, node and claim session come only from hostCallTarget; a guest --graph/--session is refused.
 */
function substrateCollection(key: readonly unknown[], config: HostVmConfig) {
	const lookup = (gid: string, nid: string) => config.store.get(gid, nid);
	const target = (input: Record<string, unknown>) => hostCallTarget(key, argvOf(input), lookup);
	return {
		issueGet: {
			inputSchema: z
				.object({ node: z.string().describe("node id of this graph's task") })
				.describe("Fetch this node's Linear issue text (redacted, UNTRUSTED task text)"),
			execute: async (input: { node: string }) => {
				const t = target(input);
				if ("error" in t) return { error: t.error };
				return config.substrate.issueGet(t.graphId, t.nodeId);
			},
		},
		release: {
			inputSchema: z
				.object({
					node: z.string().describe("node id of this graph's task"),
					reason: z.string().describe("why the work cannot be done"),
				})
				.describe("Release this node's claim and stop (the issue returns to Todo)"),
			execute: async (input: { node: string; reason: string }) => {
				const t = target(input);
				if ("error" in t) return { error: t.error };
				config.log(`[substrate-host] release requested ${t.graphId}/${t.nodeId}: ${redact(input.reason).slice(0, 200)}`);
				return config.substrate.graphRelease(t.graphId, t.nodeId, HOST_SURFACE, t.sessionId);
			},
		},
		complete: {
			inputSchema: z
				.object({
					node: z.string().describe("node id of this graph's task"),
					summary: z.string().describe("what you did"),
					testsPass: z.boolean().describe("true only if the tests you ran passed"),
				})
				.describe("Complete this node through the Definition-of-Done gate"),
			execute: async (input: { node: string; summary: string; testsPass: boolean }) => {
				const t = target(input);
				if ("error" in t) return { error: t.error };
				const dod: Dod = { summary: redact(input.summary), tests_pass: input.testsPass };
				return config.substrate.graphComplete(t.graphId, t.nodeId, HOST_SURFACE, t.sessionId, dod);
			},
		},
	};
}

/**
 * Route a:hostfn_proxy only: the in-VM relay forwards the session's Anthropic traffic to this
 * function, which fetches the host shunt on 127.0.0.1:3001 and returns the buffered reply.
 */
function modelFetchCollection() {
	const ALLOWED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "x-api-key"];
	return {
		modelFetch: {
			timeout: 600_000,
			inputSchema: z
				.object({
					method: z.string(),
					path: z.string().describe("request path, starting with /"),
					headers: z.record(z.string(), z.string()).optional(),
					bodyBase64: z.string().optional(),
				})
				.describe("Forward one model API request to the host model route"),
			execute: async (input: { method: string; path: string; headers?: Record<string, string>; bodyBase64?: string }) => {
				if (!input.path.startsWith("/") || input.path.includes("..")) return { error: "invalid path" };
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(input.headers ?? {})) {
					if (ALLOWED_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
				}
				const response = await fetch(`${MODEL_RELAY_URL}${input.path}`, {
					method: input.method,
					headers,
					body: input.bodyBase64 ? Buffer.from(input.bodyBase64, "base64") : undefined,
					signal: AbortSignal.timeout(590_000),
				});
				const replyHeaders: Record<string, string> = {};
				response.headers.forEach((value, name) => {
					if (name !== "content-length" && name !== "transfer-encoding") replyHeaders[name] = value;
				});
				return { status: response.status, headers: replyHeaders, bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64") };
			},
		},
	};
}

/** run-tests (tests_route oneshot): 600 s wall clock, output tail capped and redacted. */
const TEST_RUN_TIMEOUT_MS = 600_000;
const TEST_RUN_TAIL_CHARS = 4_000;

/**
 * `agentos-substrate run-tests --node <nid> --path <file.test.ts>...` (tests_route oneshot only):
 * one network-less container over the read-only worktree (testRunArgv), run on the host through
 * execFile — argv only, no shell. The guest never names the worktree or the image.
 */
function runTestsCollection(key: readonly unknown[], config: HostVmConfig) {
	const lookup = (gid: string, nid: string) => config.store.get(gid, nid);
	return {
		runTests: {
			timeout: TEST_RUN_TIMEOUT_MS,
			inputSchema: z
				.object({
					node: z.string().describe("node id of this graph's task"),
					path: z.array(z.string()).describe("worktree-relative *.test.ts files (at most 8)"),
				})
				.describe("Run bun test on the given files in a one-shot container without network"),
			execute: async (input: { node: string; path: string[] }) => {
				const t = hostCallTarget(key, ["--node", input.node], lookup);
				if ("error" in t) return { error: t.error };
				let argv: string[];
				try {
					argv = testRunArgv({
						graphId: t.graphId,
						worktree: worktreeFor(t.graphId),
						nodeModules: existsSync(config.checkoutNodeModules) ? config.checkoutNodeModules : null,
						paths: input.path,
					});
				} catch (cause) {
					return { error: cause instanceof Error ? cause.message : String(cause) };
				}
				config.log(`[substrate-host] run-tests ${t.graphId}/${t.nodeId} ${input.path.length} file(s)`);
				return new Promise<{ exit_code: number | null; output_tail: string }>((resolve) => {
					execFile(
						argv[0] as string,
						argv.slice(1),
						{ timeout: TEST_RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
						(error, stdout, stderr) => {
							const output = `${stdout}${stderr}`;
							const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
							resolve({ exit_code: exitCode, output_tail: redact(output.slice(-TEST_RUN_TAIL_CHARS)) });
						},
					);
				});
			},
		},
	};
}

/** git/gh run on the host under the 120 s runner; the sidecar timeout leaves headroom for the reply. */
const GIT_HOSTFN_TIMEOUT_MS = 130_000;
/** A GitHub PR URL is `https://github.com/<owner>/<repo>/pull/<n>`; anything longer is not one. */
const PR_URL_MAX = 512;

/**
 * `agentos-substrate git-push | pr-create` on every route, `commit` on c:hostfn_commit (03-07,
 * D-08): the owner's GitHub credential answers git and gh on the host only; the guest supplies
 * text within limits, the executors fix worktree, branch, remote, repo and base (T-03-07-01).
 */
function gitCollection(key: readonly unknown[], config: HostVmConfig) {
	const lookup = (gid: string, nid: string) => config.store.get(gid, nid);
	const context = (node: string) => {
		const t = hostCallTarget(key, ["--node", node], lookup);
		if ("error" in t) return t;
		return { graphId: t.graphId, nodeId: t.nodeId, store: config.store, substrate: config.substrate, run: execFileRunner, log: config.log };
	};
	const functions: HostFunctionCollections[string] = {
		"git-push": {
			timeout: GIT_HOSTFN_TIMEOUT_MS,
			inputSchema: z
				.object({ node: z.string().describe("node id of this graph's task") })
				.describe("Push this task's branch (substrate/<graph>) to origin from the host; refuses .substrate- files"),
			execute: async (input: { node: string }) => {
				const ctx = context(input.node);
				if ("error" in ctx) return { error: ctx.error };
				return gitPush(ctx);
			},
		},
		"pr-create": {
			timeout: GIT_HOSTFN_TIMEOUT_MS,
			inputSchema: z
				.object({
					node: z.string().describe("node id of this graph's task"),
					title: z.string().max(PR_TITLE_MAX).describe("pull request title"),
					body: z.string().max(PR_BODY_MAX).describe("pull request body"),
				})
				.describe("Open the pull request for this task's branch against the graph's base branch (once; returns the recorded URL after that)"),
			execute: async (input: { node: string; title: string; body: string }) => {
				const ctx = context(input.node);
				if ("error" in ctx) return { error: ctx.error };
				return prCreate({ ...ctx, title: input.title, body: input.body });
			},
		},
	};
	if (config.route.c === "hostfn_commit") {
		// c:hostfn_commit only: `agentos-substrate commit --node <nid> --message …`.
		functions["commit"] = {
			timeout: GIT_HOSTFN_TIMEOUT_MS,
			inputSchema: z
				.object({
					node: z.string().describe("node id of this graph's task"),
					message: z.string().max(COMMIT_MESSAGE_MAX).describe("commit message"),
				})
				.describe("git add -A (excluding .substrate-* files) and git commit on the worktree, run by the host"),
			execute: async (input: { node: string; message: string }) => {
				const ctx = context(input.node);
				if ("error" in ctx) return { error: ctx.error };
				return commit({ ...ctx, message: redact(input.message) });
			},
		};
	}
	// D-10, tracker_route host: the model applies ultrathink-sync through this function; the URL must be the recorded one.
	functions["sync"] = {
		timeout: GIT_HOSTFN_TIMEOUT_MS,
		inputSchema: z
			.object({
				node: z.string().describe("node id of this graph's task"),
				prUrl: z.string().max(PR_URL_MAX).describe("the pull request URL pr-create returned"),
			})
			.describe("Write PR URL, PR #, PR State (Open), Repo and Branch on the Notion Task row and attach the PR link to the Linear issue (never a state change)"),
		execute: async (input: { node: string; prUrl: string }) => {
			const t = hostCallTarget(key, ["--node", input.node], lookup);
			if ("error" in t) return { error: t.error };
			if (!config.sync) return { error: "tracker sync is not configured on this host" };
			return syncTask({ graphId: t.graphId, nodeId: t.nodeId, prUrl: input.prUrl, store: config.store, substrate: config.substrate, sync: config.sync });
		},
	};
	return functions;
}

/** Node source run inside the VM on a:hostfn_proxy: an HTTP relay on 127.0.0.1:3001 → agentos-substrate model-fetch. */
const RELAY_SCRIPT = `
const http = require("node:http");
const { execFile } = require("node:child_process");
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const input = { method: req.method, path: req.url, headers: req.headers, bodyBase64: Buffer.concat(chunks).toString("base64") };
    execFile("agentos-substrate", ["model-fetch", "--json", JSON.stringify(input)], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      let reply = null;
      try { reply = JSON.parse(String(stdout || "")); } catch {}
      const result = reply && reply.result ? reply.result : null;
      if (error || !result) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "model relay failed" })); return; }
      res.writeHead(result.status, result.headers || {});
      res.end(Buffer.from(result.bodyBase64 || "", "base64"));
    });
  });
}).listen(${MODEL_RELAY_PORT}, "127.0.0.1");
`;

const RELAY_PROBE = `fetch("${MODEL_RELAY_URL}/", { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(7));`;

type ProcessHandle = {
	process: {
		execFile(command: string, args: readonly string[], options?: Record<string, unknown>): Promise<{ exitCode: number }>;
		spawn(command: string, args?: string[], options?: Record<string, unknown>): Promise<unknown>;
	};
};

/**
 * Awaited by TaskService before sessions.open and before every prompt. Off a:hostfn_proxy it
 * returns at once; on it, the in-VM relay is started when nothing answers on 127.0.0.1:3001
 * (the relay dies with the VM's processes on a host restart, D-07).
 */
export function createEnsureModelRoute(route: Route, log: (line: string) => void) {
	return async (handle: VmHandle, graphId: string): Promise<void> => {
		if (route.a !== "hostfn_proxy") return;
		const vm = handle as unknown as ProcessHandle; // the client handle carries every action; VmHandle names only the task slice
		const probe = await vm.process.execFile("node", ["-e", RELAY_PROBE], { output: { capture: "all" }, timeoutMs: 10_000 });
		if (probe.exitCode === 0) return;
		await vm.process.spawn("node", ["-e", RELAY_SCRIPT], { cwd: "/home/agentos" });
		log(`[substrate-host] model relay started ${graphId}`);
	};
}

function errorName(cause: unknown): string {
	return cause instanceof Error ? cause.name : "Error";
}

/** Nested/sibling: read-only host_dir mounts of the current library; any failure → none (fail open). */
function libraryMounts(gid: string, config: HostVmConfig) {
	try {
		const mounts = skillMounts({ route: config.mountRoute, libraryDir: config.libraryDir, names: listLibrary(config.libraryDir), reserved: config.reservedSkills });
		if (config.mountRoute !== "copy") config.log(`[substrate-host] vm skills ${gid} mounted ${mounts.length} (${config.mountRoute})`);
		return mounts;
	} catch (cause) {
		config.log(`[substrate-host] vm skills ${gid} unavailable: ${errorName(cause)}`);
		return [];
	}
}

const GIT_TIMEOUT_MS = 30_000;

function isRegularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false; // tracked but deleted in the work tree
	}
}

/**
 * Copy route: the git-tracked library files (regular files only, so a tracked symlink cannot pull
 * a non-library host file into the guest) at the library's HEAD. Any error → one log line and the
 * VM keeps working without the library.
 */
async function copyLibrary(gid: string, filesystem: Parameters<typeof copyLibraryInto>[0], config: HostVmConfig): Promise<void> {
	try {
		const git = (args: string[]) => execFileSync("git", ["-C", config.libraryDir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
		const head = git(["rev-parse", "HEAD"]).trim();
		if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("library HEAD unreadable");
		const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
		const plan = libraryCopyPlan({ libraryDir: config.libraryDir, files, reserved: config.reservedSkills }).filter((entry) => isRegularFile(entry.hostPath));
		const started = Date.now();
		const result = await copyLibraryInto(filesystem, plan, head, readFileSync);
		if (result.skipped) config.log(`[substrate-host] vm skills ${gid} current (copy)`);
		else if (result.failed.length > 0) config.log(`[substrate-host] vm skills ${gid} partial ${result.failed.length} failed (copy)`);
		else config.log(`[substrate-host] vm skills ${gid} copied ${result.copied} files in ${Date.now() - started} ms (copy)`);
	} catch (cause) {
		config.log(`[substrate-host] vm skills ${gid} unavailable: ${errorName(cause)}`);
	}
}

export function createHostVm(config: HostVmConfig) {
	const disposeHooks = new Map<string, Array<() => void | Promise<void>>>();
	const readOnlyBinds = existsSync(config.checkoutNodeModules) ? [`${config.checkoutNodeModules}:/work/node_modules`] : [];

	const vm = agentOS({
		software: [claude],
		loopbackExemptPorts: loopbackPorts(config.route),
		permissions: {
			network: networkPermissions(config.route),
			hostFunction: hostFunctionPermissions(config.sandboxCollection),
		},
		// run-tests and model-fetch declare 600 s timeouts; the cap must admit them.
		limits: { hostFunctions: { maxTimeoutMs: TEST_RUN_TIMEOUT_MS } },

		resolveOptions: async (c) => {
			const gid = graphIdOf(c.key);
			const worktree = worktreeFor(gid);
			const hostFunctions: HostFunctionCollections = {};
			if (config.route.s === "hostfn") hostFunctions.substrate = substrateCollection(c.key, config);
			if (config.route.a === "hostfn_proxy") hostFunctions.substrate = { ...hostFunctions.substrate, ...modelFetchCollection() };
			if (config.testsRoute === "oneshot") hostFunctions.substrate = { ...hostFunctions.substrate, ...runTestsCollection(c.key, config) };
			// git-push, pr-create (and commit) live on `agentos-substrate` whatever the s: channel: no MCP path exists for them.
			hostFunctions.substrate = { ...hostFunctions.substrate, ...gitCollection(c.key, config) };
			const expanded = await resolveSandboxOptions({
				sidecar: { kind: "shared" as const, pool: `vm-${gid}` },
				mounts: [{ path: "/home/agentos/work", plugin: { id: "host_dir", config: { hostPath: worktree } } }, ...libraryMounts(gid, config)],
				sandbox: {
					// No `token` option: SandboxAgent.start reads it through substrateDocker.getToken() (sandbox-provider.ts).
					provider: sandboxAgentProvider(substrateDocker({ graphId: gid, worktree, network: config.sandboxNet, readOnlyBinds })),
					mountPath: "/mnt/sandbox",
				},
				hostFunctions,
			});
			disposeHooks.set(c.actorId, getSandboxDisposeHooks(expanded));
			config.log(`[substrate-host] vm resolved ${gid} worktree ${worktree} sandbox ${config.sandboxNet}`);
			return expanded;
		},

		// D-08 copy route (mount_route none): trusted host code writes the library into the VM.
		onVmStart: async (c, vm) => {
			if (config.mountRoute !== "copy") return;
			await copyLibrary(graphIdOf(c.key), vm.filesystem, config);
		},

		onVmDisposed: async (c, reason) => {
			const hooks = disposeHooks.get(c.actorId) ?? [];
			disposeHooks.delete(c.actorId);
			for (const hook of hooks) {
				try {
					await hook();
				} catch (cause) {
					config.log(`[substrate-host] sandbox dispose ${graphIdOf(c.key)} failed: ${String(cause)}`);
				}
			}
			config.log(`[substrate-host] vm disposed ${graphIdOf(c.key)} reason=${reason} sandboxes=${hooks.length}`);
		},

		// D-13 floor: record and log every permission request; nothing here ever answers one.
		onSessionEvent: (c, sessionId, event) => {
			const gid = graphIdOf(c.key);
			if (event.type === "permission_request") {
				const title = event.toolCall?.title ?? event.toolCall?.kind ?? "tool";
				config.tasks().recordApproval(gid, sessionId, event.requestId, redact(String(title)).slice(0, 200));
				const broker = config.broker;
				void broker.post({
					graphId: gid,
					nodeId: sessionId,
					sessionId,
					requestId: event.requestId,
					tool: String(title),
					input: event.toolCall?.rawInput ?? null,
					options: event.options.map((option) => ({ optionId: option.optionId, kind: option.kind, name: option.name })),
				}).catch((cause: unknown) => {
					config.log(`[substrate-host] approval post failed: ${cause instanceof Error ? cause.name : "Error"}`);
				});
			} else if (event.type === "permission_response") {
				config.tasks().resolveApproval(gid, sessionId, event.requestId);
			}
		},
	});

	const registry = setup({ use: { vm } });
	return { vm, registry };
}
