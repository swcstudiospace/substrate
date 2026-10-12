// Pure builders for substrate-host (D-08, D-12). No rivet import: bun:test loads this file
// without packages/host/node_modules, and vm.ts / tasks.ts consume the results unchanged.
//
// The route grammar is 03-01-SPIKE.md's `route_choice=` line: four `<letter>:<value>` segments
// in the order a (model/loopback), b (sync), c (git), s (substrate-call channel).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_IMAGE, WORKTREES_ROOT, worktreeFor } from "./sandbox-options.ts";

export { WORKTREES_ROOT, worktreeFor };

export type Route = {
	a: "loopback" | "hostfn_proxy" | "anthropic_key";
	b: "hooks" | "prompt_hostfn" | "host_after_turn";
	c: "vm_git" | "sandbox_git" | "hostfn_commit";
	s: "mcp" | "hostfn";
};

export type TestsRoute = "sandbox" | "oneshot" | "none";

const ROUTE_VALUES = {
	a: ["loopback", "hostfn_proxy", "anthropic_key"],
	b: ["hooks", "prompt_hostfn", "host_after_turn"],
	c: ["vm_git", "sandbox_git", "hostfn_commit"],
	s: ["mcp", "hostfn"],
} as const;

const ROUTE_ORDER = ["a", "b", "c", "s"] as const;

/** Exactly the 03-01 grammar: `a:<v>,b:<v>,c:<v>,s:<v>`. Throws on anything else. */
export function parseRoute(value: string): Route {
	const segments = value.trim().split(",");
	if (segments.length !== ROUTE_ORDER.length) {
		throw new Error(`invalid route ${JSON.stringify(value)}: expected a:,b:,c:,s: segments`);
	}
	const route: Record<string, string> = {};
	ROUTE_ORDER.forEach((letter, i) => {
		const segment = segments[i] ?? "";
		const prefix = `${letter}:`;
		if (!segment.startsWith(prefix)) {
			throw new Error(`invalid route ${JSON.stringify(value)}: segment ${i + 1} must start with ${prefix}`);
		}
		const choice = segment.slice(prefix.length);
		const allowed: readonly string[] = ROUTE_VALUES[letter];
		if (!allowed.includes(choice)) {
			throw new Error(`invalid route ${JSON.stringify(value)}: ${letter}:${choice} is not one of ${allowed.join("|")}`);
		}
		route[letter] = choice;
	});
	return route as Route;
}

export function formatRoute(route: Route): string {
	return ROUTE_ORDER.map((letter) => `${letter}:${route[letter]}`).join(",");
}

export function parseTestsRoute(value: string): TestsRoute {
	if (value === "sandbox" || value === "oneshot" || value === "none") return value;
	throw new Error(`invalid tests route ${JSON.stringify(value)}: expected sandbox|oneshot|none`);
}

/**
 * D-10 by 03-01's evidence: claude-ultrathink's kickoff and sync run inside the VM only when the
 * adapter fires its hooks (b:hooks) and the session holds MCP servers (s:mcp) — the rule 03-01
 * used for its `tracker_route=` line. Every other combination leaves the tracker writes to the host.
 */
export type TrackerRoute = "vm_mcp" | "host";

export function trackerRoute(route: Route): TrackerRoute {
	return route.b === "hooks" && route.s === "mcp" ? "vm_mcp" : "host";
}

/** D-12 egress allowlist (dns + tcp:443 each). Anthropic itself only on a:anthropic_key. */
export const D12_HOSTS = ["mcp.notion.com", "mcp.linear.app", "api.greptile.com", "github.com", "api.github.com"] as const;

export const SUBSTRATE_MCP_PORT = 7410;
export const MODEL_RELAY_PORT = 3001;
/** The host's tracker MCP proxy (notion, linear) — served and reachable only on tracker_route vm_mcp. */
export const TRACKER_PROXY_PORT = 7412;
/** The in-VM substrate MCP relay (I-04): VM-local only, never a host loopback exemption. */
export const SUBSTRATE_RELAY_PORT = 7413;
export const SUBSTRATE_MCP_URL = `http://127.0.0.1:${SUBSTRATE_MCP_PORT}/mcp`;
/** Where the guest's substrate MCP client connects on s:mcp: the in-VM relay (credential-free). */
export const SUBSTRATE_RELAY_URL = `http://127.0.0.1:${SUBSTRATE_RELAY_PORT}/mcp`;
/** The session's model endpoint: host shunt or the existing in-VM model relay. */
export const MODEL_RELAY_URL = `http://127.0.0.1:${MODEL_RELAY_PORT}`;
export const ANTHROPIC_DIRECT_URL = "https://api.anthropic.com";

/**
 * Host loopback ports the VM may reach (the sidecar's SSRF exemption list): only on a:loopback,
 * plus the tracker proxy when tracker_route is vm_mcp (s:mcp implies a:loopback).
 */
export function loopbackPorts(route: Route): number[] {
	if (route.a !== "loopback") return [];
	const ports = [SUBSTRATE_MCP_PORT, MODEL_RELAY_PORT];
	if (trackerRoute(route) === "vm_mcp") ports.push(TRACKER_PROXY_PORT);
	return ports;
}

export type PatternRule = { mode: "allow" | "deny"; operations: string[]; patterns: string[] };
export type RulePermissions = { default: "deny"; rules: PatternRule[] };

export function networkPermissions(route: Route): RulePermissions {
	const patterns: string[] = [];
	for (const host of D12_HOSTS) patterns.push(`dns://${host}`, `tcp://${host}:443`);
	if (route.a === "loopback") {
		patterns.push(`tcp://127.0.0.1:${SUBSTRATE_MCP_PORT}`, `tcp://127.0.0.1:${MODEL_RELAY_PORT}`);
	}
	if (trackerRoute(route) === "vm_mcp") patterns.push(`tcp://127.0.0.1:${TRACKER_PROXY_PORT}`);
	if (route.a === "anthropic_key") {
		patterns.push("dns://api.anthropic.com", "tcp://api.anthropic.com:443");
	}
	return {
		default: "deny",
		rules: [
			{ mode: "allow", operations: ["listen"], patterns: ["tcp://**", "unix:**"] },
			{ mode: "allow", operations: ["*"], patterns },
		],
	};
}

/**
 * Only the substrate collection and the sandbox collection 03-01 recorded may be invoked. The
 * sidecar names the resource `<collection>:<command>` (observed live in 03-03: "blocked by
 * hostFunction.invoke policy for substrate:issue-get"), so each collection is allowed as `<name>:*`.
 */
export function hostFunctionPermissions(sandboxCollection: string): RulePermissions {
	return {
		default: "deny",
		rules: [{ mode: "allow", operations: ["invoke"], patterns: ["substrate:*", `${sandboxCollection}:*`] }],
	};
}

export type SessionEnvInput = {
	route: Route;
	model: string;
	graphId: string;
	nodeId: string;
	/** SUBSTRATE_VM_ANTHROPIC_API_KEY from the host env; read only on a:anthropic_key (D-08). */
	directKey?: string;
};

/** Exactly the five D-08 keys; nothing else from the host environment reaches sessions.open. */
export function sessionEnv(input: SessionEnvInput): Record<string, string> {
	const { route, model, graphId, nodeId } = input;
	let baseUrl = MODEL_RELAY_URL;
	let apiKey = "shunt";
	if (route.a === "anthropic_key") {
		if (!input.directKey) throw new Error("SUBSTRATE_VM_ANTHROPIC_API_KEY required on route a:anthropic_key");
		baseUrl = ANTHROPIC_DIRECT_URL;
		apiKey = input.directKey;
	}
	return {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: apiKey,
		ANTHROPIC_MODEL: model,
		SUBSTRATE_GRAPH_ID: graphId,
		SUBSTRATE_NODE_ID: nodeId,
	};
}

export type TestRunInput = {
	graphId: string;
	/** Must be worktreeFor(graphId): the only tree a one-shot test container may see. */
	worktree: string;
	/** The graph repo checkout's node_modules, bound read-only; null when the checkout has none. */
	nodeModules: string | null;
	/** Worktree-relative *.test.ts files, at most 8. */
	paths: string[];
};

export const TEST_RUN_LABEL = "substrate.test_run";
export const TEST_RUN_MAX_PATHS = 8;

/**
 * tests_route oneshot (T-03-04-06): one network-less container over a read-only worktree, no
 * docker socket, no privileged flag, fixed image. The argv is exact so vm.ts can hand it to
 * execFile without a shell.
 */
export function testRunArgv(input: TestRunInput): string[] {
	const { graphId, worktree, nodeModules, paths } = input;
	if (worktree !== worktreeFor(graphId)) throw new Error(`worktree must be ${worktreeFor(graphId)}`);
	if (paths.length === 0) throw new Error("at least one test path is required");
	if (paths.length > TEST_RUN_MAX_PATHS) throw new Error(`at most ${TEST_RUN_MAX_PATHS} test paths per run`);
	for (const path of paths) {
		if (path.startsWith("/")) throw new Error(`test path ${JSON.stringify(path)} is absolute`);
		if (path.split("/").includes("..")) throw new Error(`test path ${JSON.stringify(path)} contains ..`);
		if (!path.endsWith(".test.ts") || path.split("/").includes("")) throw new Error(`test path ${JSON.stringify(path)} must be a worktree-relative .test.ts file`);
	}
	const argv = ["docker", "run", "--rm", "--network", "none", "--label", `${TEST_RUN_LABEL}=${graphId}`, "--tmpfs", "/tmp", "-v", `${worktree}:/work:ro`];
	if (nodeModules !== null) argv.push("-v", `${nodeModules}:/work/node_modules:ro`);
	argv.push("-w", "/work", SANDBOX_IMAGE, "bun", "test", ...paths);
	return argv;
}

// ── D-08: the skill library in every rivet-agentos VM ────────────────────────────────────────
// 04-01-SPIKE.md's mount_route picks the delivery: nested (one read-only host_dir mount per skill
// under the seeded skills dir), sibling (one read-only mount of the whole library), or copy (the
// spike's `none`: trusted host code writes the git-tracked library into the VM at boot). Every
// host path and copy source is `<libraryDir>/<valid skill name>/…`, so no other host state (the
// 04-03 propose key under /var/lib/substrate included) can reach a guest.

export type MountRoute = "nested" | "sibling" | "copy";

/** Where seed.ts writes the ultrathink skills; nested mounts sit beside them. */
export const VM_SKILLS_DIR = "/home/agentos/.claude/skills";
/** The sibling mount point and the copy route's target. */
export const VM_LIBRARY_DIR = "/home/agentos/agent-skills";
/** Copy route: the library HEAD the VM holds; empty or absent means no complete copy. */
export const LIBRARY_HEAD_MARKER = `${VM_LIBRARY_DIR}/.library-head`;

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COPY_BATCH = 200;

/**
 * readOnly at both levels (04-01-SPIKE.md Gaps): `plugin.config.readOnly` is what host_dir
 * enforces, the top-level flag is what listMounts reports.
 */
export type HostDirMount = {
	path: string;
	readOnly: true;
	plugin: { id: "host_dir"; config: { hostPath: string; readOnly: true } };
};

function hostDirMount(path: string, hostPath: string): HostDirMount {
	return { path, readOnly: true, plugin: { id: "host_dir", config: { hostPath, readOnly: true } } };
}

function trimDir(dir: string): string {
	return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

/** Sorted names of the library's real (non-symlink, non-dot) subdirectories that hold SKILL.md; a missing dir lists nothing. */
export function listLibrary(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(dir, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

export function parseMountRoute(raw: string): MountRoute {
	if (raw === "nested" || raw === "sibling" || raw === "copy") return raw;
	if (raw === "none") return "copy";
	throw new Error(`invalid mount route ${JSON.stringify(raw)}: expected nested|sibling|copy (none = copy)`);
}

export function skillMounts(input: { route: MountRoute; libraryDir: string; names: readonly string[]; reserved: readonly string[] }): HostDirMount[] {
	const libraryDir = trimDir(input.libraryDir);
	if (input.route === "copy") return [];
	if (input.route === "sibling") return [hostDirMount(VM_LIBRARY_DIR, libraryDir)];
	const reserved = new Set(input.reserved);
	return [...new Set(input.names)]
		.filter((name) => SKILL_NAME_RE.test(name) && !reserved.has(name))
		.sort()
		.map((name) => hostDirMount(`${VM_SKILLS_DIR}/${name}`, `${libraryDir}/${name}`));
}

/**
 * Copy route: `files` are `git -C <libraryDir> ls-files -z` entries. Kept: `<valid name>/<rel>`
 * with no empty, `.`, `..` or `.git` segment, the name not reserved (seeded by seed.ts).
 */
export function libraryCopyPlan(input: { libraryDir: string; files: readonly string[]; reserved: readonly string[] }): { hostPath: string; vmPath: string }[] {
	const libraryDir = trimDir(input.libraryDir);
	const reserved = new Set(input.reserved);
	const kept = new Set<string>();
	for (const file of input.files) {
		const segments = file.split("/");
		const name = segments[0] ?? "";
		if (segments.length < 2 || !SKILL_NAME_RE.test(name) || reserved.has(name)) continue;
		if (segments.some((s) => s === "" || s === "." || s === ".." || s === ".git")) continue;
		kept.add(file);
	}
	return [...kept].sort().map((rel) => ({ hostPath: `${libraryDir}/${rel}`, vmPath: `${VM_LIBRARY_DIR}/${rel}` }));
}

/** The slice of rivet's `vm.filesystem` the copy uses (structural: no rivet import). */
export type LibraryCopyTarget = {
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	writeFiles(entries: { path: string; content: Uint8Array }[]): Promise<{ path: string; success: boolean; error?: string }[]>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
};

/**
 * Copy the planned library files into a VM unless it already holds `head`. An existing marker is
 * emptied before anything else, and `head` is written only when every BatchWriteResult succeeded,
 * so an interrupted or partial copy is retried on the next boot. Rejections propagate (the caller
 * logs and fails open).
 */
export async function copyLibraryInto(
	target: LibraryCopyTarget,
	entries: readonly { hostPath: string; vmPath: string }[],
	head: string,
	readHost: (path: string) => Uint8Array,
): Promise<{ copied: number; skipped: boolean; failed: string[] }> {
	let marker: string | null = null;
	try {
		marker = new TextDecoder().decode(await target.readFile(LIBRARY_HEAD_MARKER)).trim();
	} catch {
		marker = null; // absent: no copy yet
	}
	if (marker !== null && marker === head) return { copied: 0, skipped: true, failed: [] };
	if (marker !== null) await target.writeFile(LIBRARY_HEAD_MARKER, "");

	const dirs = new Set<string>([VM_LIBRARY_DIR]);
	for (const entry of entries) dirs.add(entry.vmPath.slice(0, entry.vmPath.lastIndexOf("/")));
	for (const dir of [...dirs].sort()) await target.mkdir(dir, { recursive: true });

	let copied = 0;
	const failed: string[] = [];
	for (let i = 0; i < entries.length; i += COPY_BATCH) {
		const batch = entries.slice(i, i + COPY_BATCH).map((entry) => ({ path: entry.vmPath, content: readHost(entry.hostPath) }));
		for (const result of await target.writeFiles(batch)) {
			if (result.success) copied += 1;
			else failed.push(result.path);
		}
	}
	if (failed.length === 0) await target.writeFile(LIBRARY_HEAD_MARKER, head);
	return { copied, skipped: false, failed };
}
