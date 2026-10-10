// substrateDocker: the only sandbox provider substrate-host starts (D-01).
//
// Same SandboxProvider shape as upstream sandbox-agent@0.4.2 providers/docker.js (name "docker",
// create/destroy/getUrl), but every container body comes from buildContainerSpec: host-loopback
// port or an internal network, a per-container token, the graph label, the worktree bind, no
// privileged mode and no docker socket. The token reaches sandboxAgentProvider through getToken(),
// which SandboxAgent.start calls when no explicit token option is passed — so callers must not
// pass `token` to sandboxAgentProvider.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { SandboxProvider } from "sandbox-agent";
import {
	buildContainerSpec,
	GRAPH_LABEL,
	SANDBOX_IMAGE,
	SANDBOX_NETWORK,
	SANDBOX_PORT,
	type SandboxNetwork,
} from "./sandbox-options.ts";

type PortBinding = { HostIp?: string; HostPort?: string };

type ContainerInspect = {
	Config?: { Cmd?: string[] | null; Labels?: Record<string, string> | null };
	NetworkSettings?: {
		Ports?: Record<string, PortBinding[] | null> | null;
		Networks?: Record<string, { IPAddress?: string }> | null;
	};
};

type DockerContainer = {
	id: string;
	start(): Promise<unknown>;
	stop(opts?: { t?: number }): Promise<unknown>;
	remove(opts?: { force?: boolean }): Promise<unknown>;
	inspect(): Promise<ContainerInspect>;
};

type NetworkInspect = { Internal?: boolean };

/** The slice of dockerode this provider uses. */
export type DockerClient = {
	createContainer(body: Record<string, unknown>): Promise<DockerContainer>;
	getContainer(id: string): DockerContainer;
	getNetwork(name: string): { inspect(): Promise<NetworkInspect> };
	createNetwork(body: Record<string, unknown>): Promise<unknown>;
	getImage(name: string): { inspect(): Promise<unknown> };
	pull(name: string): Promise<unknown>;
	modem: { followProgress(stream: unknown, onFinished: (error: Error | null, output: unknown) => void): void };
};

export type SubstrateDockerOptions = {
	graphId: string;
	worktree: string;
	network: SandboxNetwork;
	readOnlyBinds?: string[];
	image?: string;
	/** Injected for tests; defaults to dockerode on /var/run/docker.sock. */
	docker?: DockerClient;
	/**
	 * Injected `df` runner for tests. Defaults to `df --output=avail -B1 /`
	 * (the substrate-desktop.sh 10 GiB floor pattern). Must return the raw
	 * stdout, or null when df is unreadable (fail-closed: refusal).
	 */
	runDf?: () => string | null;
};

/** LANEA-05: image builds and pulls are refused below 10 GiB free (D31-07). */
export const DISK_FLOOR_BYTES = 10_737_418_240;

export type DiskGate = { ok: true; availBytes: number } | { ok: false; availBytes: number | null };

function parseDfAvail(dfStdout: string): number | null {
	const lines = dfStdout.trim().split("\n");
	const last = (lines[lines.length - 1] ?? "").trim();
	const value = Number(last);
	return Number.isFinite(value) ? value : null;
}

/**
 * The disk gate: `df --output=avail -B1 / >= 10737418240` before any docker
 * call. Refuses below the floor and when df is unreadable (fail-closed,
 * Phase 16 guard pattern). The refusal names the free bytes and the floor.
 */
export function checkDiskFloor(runDf?: () => string | null): DiskGate {
	let stdout: string | null = null;
	if (runDf) {
		stdout = runDf();
	} else {
		try {
			stdout = execFileSync("df", ["--output=avail", "-B1", "/"], { encoding: "utf8", timeout: 10_000 });
		} catch {
			stdout = null;
		}
	}
	const availBytes = stdout === null ? null : parseDfAvail(stdout);
	if (availBytes === null || availBytes < DISK_FLOOR_BYTES) return { ok: false, availBytes };
	return { ok: true, availBytes };
}

export type SubstrateSandboxProvider = SandboxProvider & {
	getToken(sandboxId: string): Promise<string>;
};
/**
 * The single build/pull entry: no caller reaches a docker image without
 * passing the disk gate first. Present images skip the pull; missing images
 * are pulled only above the floor. Refusals name the free bytes and the floor.
 */
export async function ensureImagePulled(
	docker: DockerClient,
	image: string,
	runDf?: () => string | null,
): Promise<"present" | "pulled"> {
	const gate = checkDiskFloor(runDf);
	if (!gate.ok) {
		throw new Error(
			`refusing image ${image}: ${gate.availBytes === null ? "unreadable" : `${gate.availBytes} bytes free`}, floor ${DISK_FLOOR_BYTES} bytes`,
		);
	}
	try {
		await docker.getImage(image).inspect();
		return "present";
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const stream = await docker.pull(image);
	docker.modem.followProgress(stream, (error) => {
		if (error) reject(error);
		else resolve();
	});
	await promise;
	return "pulled";
}

// dockerode ships no types and only the slice above is used, so it is loaded untyped.
function defaultDocker(): DockerClient {
	const Docker = createRequire(import.meta.url)("dockerode") as new (opts: { socketPath: string }) => DockerClient;
	return new Docker({ socketPath: "/var/run/docker.sock" });
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { statusCode?: unknown }).statusCode === 404;
}

async function ensureInternalNetwork(docker: DockerClient): Promise<void> {
	try {
		const info = await docker.getNetwork(SANDBOX_NETWORK).inspect();
		if (info.Internal !== true) {
			throw new Error(`docker network ${SANDBOX_NETWORK} exists but is not internal; refusing to use it`);
		}
		return;
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	try {
		await docker.createNetwork({ Name: SANDBOX_NETWORK, Driver: "bridge", Internal: true, CheckDuplicate: true });
	} catch (error) {
		// A concurrent create won the race; the inspect on the next create() re-checks Internal.
		if ((error as { statusCode?: unknown }).statusCode !== 409) throw error;
	}
}

export function substrateDocker(opts: SubstrateDockerOptions): SubstrateSandboxProvider {
	const { graphId, worktree, network, readOnlyBinds } = opts;
	const image = opts.image ?? SANDBOX_IMAGE;
	// Validate once up front so a bad graph id or worktree fails before any Docker call.
	buildContainerSpec({ graphId, worktree, token: "validate", image, network, readOnlyBinds });
	let client: DockerClient | undefined = opts.docker;
	const docker = (): DockerClient => (client ??= defaultDocker());

	/** Inspect a container and refuse any that this graph's provider did not create. */
	async function inspectOwned(sandboxId: string): Promise<ContainerInspect> {
		const info = await docker().getContainer(sandboxId).inspect();
		if (info.Config?.Labels?.[GRAPH_LABEL] !== graphId) {
			throw new Error(`container ${sandboxId} is not a ${GRAPH_LABEL}=${graphId} sandbox`);
		}
		return info;
	}

	return {
		name: "docker",
		defaultCwd: "/work",

		async create() {
			// The disk gate runs before any docker call: a missing image would pull here.
			await ensureImagePulled(docker(), image, opts.runDf);
			if (network === "internal") await ensureInternalNetwork(docker());
			const token = randomBytes(32).toString("base64url");
			const container = await docker().createContainer(
				buildContainerSpec({ graphId, worktree, token, image, network, readOnlyBinds }),
			);
			try {
				await container.start();
			} catch (error) {
				await container.remove({ force: true }).catch(() => undefined);
				throw error;
			}
			return container.id;
		},

		async destroy(sandboxId) {
			try {
				await inspectOwned(sandboxId);
			} catch (error) {
				if (isNotFound(error)) return; // AutoRemove already took it
				throw error;
			}
			const container = docker().getContainer(sandboxId);
			await container.stop({ t: 5 }).catch(() => undefined);
			await container.remove({ force: true }).catch((error: unknown) => {
				// 404: already gone; 409: AutoRemove started removing it when stop() returned.
				const status = (error as { statusCode?: unknown }).statusCode;
				if (status !== 404 && status !== 409) throw error;
			});
		},

		async getUrl(sandboxId) {
			const info = await inspectOwned(sandboxId);
			if (network === "internal") {
				const ip = info.NetworkSettings?.Networks?.[SANDBOX_NETWORK]?.IPAddress;
				if (!ip) throw new Error(`sandbox ${sandboxId} has no address on ${SANDBOX_NETWORK}`);
				return `http://${ip}:${SANDBOX_PORT}`;
			}
			const binding = info.NetworkSettings?.Ports?.[`${SANDBOX_PORT}/tcp`]?.[0];
			if (binding?.HostIp !== "127.0.0.1" || !binding.HostPort) {
				throw new Error(`sandbox ${sandboxId} port ${SANDBOX_PORT} is not published on 127.0.0.1`);
			}
			return `http://127.0.0.1:${binding.HostPort}`;
		},

		async getToken(sandboxId) {
			const cmd = (await inspectOwned(sandboxId)).Config?.Cmd ?? [];
			const token = cmd[cmd.indexOf("--token") + 1];
			if (cmd.indexOf("--token") < 0 || !token) throw new Error(`sandbox ${sandboxId} has no token`);
			return token;
		},
	};
}
