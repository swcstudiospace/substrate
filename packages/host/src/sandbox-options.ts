// Pure container spec for the substrate sandbox (D-01). No imports: bun:test loads this file
// without rivet, and sandbox-provider.ts builds every container body from buildContainerSpec.
//
// Why not upstream sandbox-agent@0.4.2 providers/docker.js: it publishes the command server on
// every host interface (PortBindings without HostIp) with token auth switched off, and a caller
// HostConfig replaces its HostConfig wholesale. This builder owns the whole body instead.

export const SANDBOX_IMAGE = "substrate-sandbox:0.1";
export const SANDBOX_NETWORK = "substrate-sandbox";
export const SANDBOX_PORT = 3000;
export const GRAPH_LABEL = "substrate.graph_id";
export const WORKTREES_ROOT = "/var/lib/substrate/worktrees";

/** Same rule as packages/dispatcher/src/substrate_dispatcher/worktree.py GRAPH_ID_RE. */
const GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SandboxNetwork = "published_loopback" | "internal";

export type ContainerSpecOptions = {
	graphId: string;
	worktree: string;
	token: string;
	image?: string;
	network: SandboxNetwork;
	readOnlyBinds?: string[] | undefined;
};

export function isValidGraphId(graphId: unknown): graphId is string {
	return (
		typeof graphId === "string" &&
		GRAPH_ID_RE.test(graphId) &&
		!graphId.includes("..") &&
		!graphId.endsWith(".lock") &&
		!graphId.endsWith(".")
	);
}

/** The only worktree a graph may bind: the dispatcher's `<WORKTREES_ROOT>/<graph_id>`. */
export function worktreeFor(graphId: string): string {
	if (!isValidGraphId(graphId)) throw new Error(`invalid graph id ${JSON.stringify(graphId)}`);
	return `${WORKTREES_ROOT}/${graphId}`;
}

const BIND_PATH_RE = /^\/[A-Za-z0-9._/-]*$/;

function readOnlyBind(entry: string): string {
	const parts = entry.split(":");
	const [hostPath, containerPath] = parts;
	if (
		parts.length !== 2 ||
		hostPath === undefined ||
		containerPath === undefined ||
		!BIND_PATH_RE.test(hostPath) ||
		!BIND_PATH_RE.test(containerPath) ||
		hostPath.split("/").includes("..") ||
		containerPath.split("/").includes("..")
	) {
		throw new Error(`invalid read-only bind ${JSON.stringify(entry)}`);
	}
	if (hostPath.includes("docker.sock") || containerPath.includes("docker.sock")) {
		throw new Error("the docker socket is never mounted into a sandbox");
	}
	return `${hostPath}:${containerPath}:ro`;
}

/** dockerode createContainer body for one graph's sandbox. */
export function buildContainerSpec(opts: ContainerSpecOptions): Record<string, unknown> {
	const { graphId, worktree, token, network } = opts;
	if (!isValidGraphId(graphId)) throw new Error(`invalid graph id ${JSON.stringify(graphId)}`);
	if (worktree !== worktreeFor(graphId)) {
		throw new Error(`worktree must be ${WORKTREES_ROOT}/${graphId}, got ${JSON.stringify(worktree)}`);
	}
	if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/.test(token)) {
		throw new Error("sandbox token must be 1-256 URL-safe characters");
	}
	if (network !== "published_loopback" && network !== "internal") {
		throw new Error(`invalid sandbox network ${JSON.stringify(network)}`);
	}

	const port = `${SANDBOX_PORT}/tcp`;
	const binds = [`${worktree}:/work`, ...(opts.readOnlyBinds ?? []).map(readOnlyBind)];
	const hostConfig: Record<string, unknown> = {
		AutoRemove: true,
		Privileged: false,
		Binds: binds,
	};
	if (network === "internal") {
		hostConfig.NetworkMode = SANDBOX_NETWORK;
	} else {
		// HostPort "" lets Docker pick a free port, bound to host loopback only.
		hostConfig.PortBindings = { [port]: [{ HostIp: "127.0.0.1", HostPort: "" }] };
	}

	return {
		Image: opts.image ?? SANDBOX_IMAGE,
		// 0.0.0.0 is the container's own interface; reachability is decided by HostConfig above.
		// --no-telemetry: the command server makes no call home.
		Cmd: ["server", "--token", token, "--host", "0.0.0.0", "--port", String(SANDBOX_PORT), "--no-telemetry"],
		ExposedPorts: { [port]: {} },
		Labels: { [GRAPH_LABEL]: graphId },
		WorkingDir: "/work",
		HostConfig: hostConfig,
	};
}

// ── U1: the sandbox egress allowlist (SUBSTRATE_SANDBOX_EGRESS) ──────────────────────────────
//
// Deny-all by default: the operator allowlists every host:port a sandbox may reach. Enforcement
// rides the two mechanisms the spec builder genuinely has (egressConflict/egressRules): the
// internal docker bridge has no external route at all — deny-all for free, an allowlist
// impossible — and the published bridge is filtered by DOCKER-USER rules whose argv is composed
// here, executed by sandbox-provider.ts between create and start, and recorded for teardown.

export const SANDBOX_EGRESS_ENV = "SUBSTRATE_SANDBOX_EGRESS";

export type EgressDestination = { readonly host: string; readonly port: number };

export type EgressPolicy = { readonly allow: readonly EgressDestination[] };

const EGRESS_DENY_ALL: EgressPolicy = { allow: [] };

/** A hostname or IPv4 address: alnum lead (no `:`, no `[`, no option dash), then dot or dash. */
const EGRESS_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Strict `host:port` allowlist parse, the desktop allowlist idiom (rehearsal.ts
 * parseDesktopSurfaces): unset or blank is deny-all, blank segments are skipped, and every
 * malformed entry refuses naming it — a missing port or a non-host leading character
 * (`:443`, `-host:80`, `[::1]:443`) never degrades into a looser policy.
 */
export function parseSandboxEgress(raw: string | undefined): EgressPolicy {
	if (raw === undefined) return EGRESS_DENY_ALL;
	const allow: EgressDestination[] = [];
	for (const entry of raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)) {
		const colon = entry.lastIndexOf(":");
		const host = colon < 0 ? "" : entry.slice(0, colon);
		const port = colon < 0 ? "" : entry.slice(colon + 1);
		const portNumber = Number(port);
		if (
			host === "" ||
			!EGRESS_HOST_RE.test(host) ||
			!/^[0-9]{1,5}$/.test(port) ||
			!Number.isInteger(portNumber) ||
			portNumber < 1 ||
			portNumber > 65535
		) {
			throw new Error(`invalid ${SANDBOX_EGRESS_ENV} entry ${JSON.stringify(entry)}: expected host:port`);
		}
		allow.push({ host, port: portNumber });
	}
	return { allow };
}

/** The seed burst: the seeder's bootstrap destinations unioned onto the operator policy. */
export function effectiveEgress(
	policy: EgressPolicy,
	seedMode: boolean,
	bootstrap: readonly EgressDestination[],
): EgressPolicy {
	return seedMode ? { allow: [...policy.allow, ...bootstrap] } : policy;
}

/**
 * Fail-closed config check: a refusal reason, or null when the policy is enforceable on this
 * network. The internal bridge has no external route — deny-all comes free, but there is no
 * route an allowlist could open, so an allowlist there refuses instead of silently never
 * applying. The provider runs this before any Docker call.
 */
export function egressConflict(policy: EgressPolicy, network: SandboxNetwork): string | null {
	if (network === "internal" && policy.allow.length > 0) {
		return `${SANDBOX_EGRESS_ENV} allowlists ${policy.allow.length} destination(s) but the internal network has no external route an allowlist could open; use the published_loopback network`;
	}
	return null;
}

type EgressRules = { apply: string[][]; remove: string[][] };

const IPTABLES = "iptables";
/** Docker reserves this chain for exactly this kind of operator rule: consulted before its own. */
const EGRESS_CHAIN = "DOCKER-USER";
const EGRESS_DNS_PORT = "53";

/**
 * One DOCKER-USER rule: the pinned insert argv at an explicit position (the chain is read
 * top-down, so the rules apply in the order composed here) and its position-free delete
 * argv — deletion matches on the rule spec, so it works whatever shifted positions since.
 */
function userRule(position: number, spec: readonly string[]): { apply: string[]; remove: string[] } {
	return {
		apply: [IPTABLES, "-I", EGRESS_CHAIN, String(position), ...spec],
		remove: [IPTABLES, "-D", EGRESS_CHAIN, ...spec],
	};
}

/**
 * The DOCKER-USER argv for one sandbox on the published bridge, in final chain order:
 * the allow destinations pinned to their resolved addresses, DNS (udp+tcp 53) left open
 * whenever anything is allowed — the sandbox must resolve the names itself — and a source
 * drop for the container's every other outbound packet. Replies to allowed connections are
 * never matched (the peer sources them, not the container), so no conntrack rule is needed.
 * An allow destination with no resolved address throws naming it: fail-closed, the sandbox
 * refuses to start rather than starting with that entry silently unenforceable.
 */
export function egressRules(
	ip: string,
	allow: readonly EgressDestination[],
	resolved: ReadonlyMap<string, readonly string[]>,
): EgressRules {
	const specs: string[][] = [];
	for (const destination of allow) {
		const addresses = resolved.get(destination.host) ?? [];
		if (addresses.length === 0) {
			throw new Error(
				`egress destination ${JSON.stringify(`${destination.host}:${destination.port}`)} does not resolve; refusing to start`,
			);
		}
		for (const address of addresses) {
			specs.push(["-s", ip, "-d", address, "-p", "tcp", "--dport", String(destination.port), "-j", "ACCEPT"]);
		}
	}
	if (specs.length > 0) {
		specs.unshift(["-s", ip, "-p", "tcp", "--dport", EGRESS_DNS_PORT, "-j", "ACCEPT"]);
		specs.unshift(["-s", ip, "-p", "udp", "--dport", EGRESS_DNS_PORT, "-j", "ACCEPT"]);
	}
	specs.push(["-s", ip, "-j", "DROP"]);
	const rules = specs.map((spec, index) => userRule(index + 1, spec));
	return { apply: rules.map((rule) => rule.apply), remove: rules.map((rule) => rule.remove) };
}

/**
 * The seed burst: head-inserted ACCEPT rules for the bootstrap destinations only, so they
 * stand above the standing drop while the seeder runs, plus the paired delete argv that
 * removes exactly what was inserted — the drop happens even when the seeded work throws.
 */
export function seedBurstRules(
	ip: string,
	bootstrap: readonly EgressDestination[],
	resolved: ReadonlyMap<string, readonly string[]>,
): EgressRules {
	const apply: string[][] = [];
	const remove: string[][] = [];
	for (const destination of bootstrap) {
		const addresses = resolved.get(destination.host) ?? [];
		if (addresses.length === 0) {
			throw new Error(
				`seed egress destination ${JSON.stringify(`${destination.host}:${destination.port}`)} does not resolve; refusing the burst`,
			);
		}
		for (const address of addresses) {
			const spec = ["-s", ip, "-d", address, "-p", "tcp", "--dport", String(destination.port), "-j", "ACCEPT"];
			apply.push([IPTABLES, "-I", EGRESS_CHAIN, ...spec]);
			remove.push([IPTABLES, "-D", EGRESS_CHAIN, ...spec]);
		}
	}
	return { apply, remove };
}
