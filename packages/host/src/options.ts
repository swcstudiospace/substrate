// Pure builders for substrate-host (D-08, D-12). No rivet import: bun:test loads this file
// without packages/host/node_modules, and vm.ts / tasks.ts consume the results unchanged.
//
// The route grammar is 03-01-SPIKE.md's `route_choice=` line: four `<letter>:<value>` segments
// in the order a (model/loopback), b (sync), c (git), s (substrate-call channel).

export { WORKTREES_ROOT, worktreeFor } from "./sandbox-options.ts";

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

/** D-12 egress allowlist (dns + tcp:443 each). Anthropic itself only on a:anthropic_key. */
export const D12_HOSTS = ["mcp.notion.com", "mcp.linear.app", "api.greptile.com", "github.com", "api.github.com"] as const;

export const SUBSTRATE_MCP_PORT = 7410;
export const MODEL_RELAY_PORT = 3001;
export const SUBSTRATE_MCP_URL = `http://127.0.0.1:${SUBSTRATE_MCP_PORT}/mcp`;
/** Where the session's Anthropic client connects on a:loopback (host shunt) and a:hostfn_proxy (in-VM relay). */
export const MODEL_RELAY_URL = `http://127.0.0.1:${MODEL_RELAY_PORT}`;
export const ANTHROPIC_DIRECT_URL = "https://api.anthropic.com";

/** Host loopback ports the VM may reach: only on a:loopback (the sidecar's SSRF exemption list). */
export function loopbackPorts(route: Route): number[] {
	return route.a === "loopback" ? [SUBSTRATE_MCP_PORT, MODEL_RELAY_PORT] : [];
}

export type PatternRule = { mode: "allow" | "deny"; operations: string[]; patterns: string[] };
export type RulePermissions = { default: "deny"; rules: PatternRule[] };

export function networkPermissions(route: Route): RulePermissions {
	const patterns: string[] = [];
	for (const host of D12_HOSTS) patterns.push(`dns://${host}`, `tcp://${host}:443`);
	if (route.a === "loopback") {
		patterns.push(`tcp://127.0.0.1:${SUBSTRATE_MCP_PORT}`, `tcp://127.0.0.1:${MODEL_RELAY_PORT}`);
	}
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
		if (!input.directKey) {
			throw new Error("route a:anthropic_key requires SUBSTRATE_VM_ANTHROPIC_API_KEY in the host environment");
		}
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
