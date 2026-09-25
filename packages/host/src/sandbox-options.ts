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
export const GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SandboxNetwork = "published_loopback" | "internal";

export type ContainerSpecOptions = {
	graphId: string;
	worktree: string;
	token: string;
	image?: string;
	network: SandboxNetwork;
	readOnlyBinds?: string[];
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
