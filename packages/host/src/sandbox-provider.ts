// substrateDocker: the only sandbox provider substrate-host starts (D-01).
//
// Same SandboxProvider shape as upstream sandbox-agent@0.4.2 providers/docker.js (name "docker",
// create/destroy/getUrl), but every container body comes from buildContainerSpec: host-loopback
// port or an internal network, a per-container token, the graph label, the worktree bind, no
// privileged mode and no docker socket. The token reaches sandboxAgentProvider through getToken(),
// which SandboxAgent.start calls when no explicit token option is passed — so callers must not
// pass `token` to sandboxAgentProvider.

import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { SandboxProvider } from "sandbox-agent";
import {
	buildContainerSpec,
	egressConflict,
	egressRules as composeEgressRules,
	GRAPH_LABEL,
	parseSandboxEgress,
	SANDBOX_EGRESS_ENV,
	SANDBOX_IMAGE,
	SANDBOX_NETWORK,
	SANDBOX_PORT,
	seedBurstRules,
	type EgressDestination,
	type EgressPolicy,
	type SandboxNetwork,
} from "./sandbox-options.ts";
import { SEED_EGRESS } from "./seed.ts";
import { type SandboxListing, SandboxStateStore } from "./tasks.ts";

type PortBinding = { HostIp?: string; HostPort?: string };

type ContainerInspect = {
	Config?: { Cmd?: string[] | null; Labels?: Record<string, string> | null };
	NetworkSettings?: {
		/** The container's bridge address; the U1 egress rules pin the container's own traffic by it. */
		IPAddress?: string;
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

/** One entry of docker's container list, the slice reconciliation classifies on (U2). */
type ContainerSummary = { Id: string; Names?: string[]; Labels?: Record<string, string> | null; State?: string };

/** The slice of dockerode this provider uses. */
export type DockerClient = {
	createContainer(body: Record<string, unknown>): Promise<DockerContainer>;
	getContainer(id: string): DockerContainer;
	getNetwork(name: string): { inspect(): Promise<NetworkInspect> };
	createNetwork(body: Record<string, unknown>): Promise<unknown>;
	getImage(name: string): { inspect(): Promise<unknown> };
	pull(name: string): Promise<unknown>;
	listContainers(opts: { all: boolean }): Promise<ContainerSummary[]>;
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
	 * U2: the durable sandbox→task map this provider writes on create and drops on destroy.
	 * Defaults to the shared store at `defaultSandboxStatePath()`; tests inject a tmp-path store.
	 */
	sandboxState?: SandboxStateStore;
	/**
	 * Injected `df` runner for tests. Defaults to `df --output=avail -B1 /`
	 * (the substrate-desktop.sh 10 GiB floor pattern). Must return the raw
	 * stdout, or null when df is unreadable (fail-closed: refusal).
	 */
	runDf?: () => string | null;
	/**
	 * U1: explicit egress policy. Absent: parsed from SUBSTRATE_SANDBOX_EGRESS (`env`,
	 * default process.env) — unset is deny-all.
	 */
	egress?: EgressPolicy;
	/** U1: the env source for SUBSTRATE_SANDBOX_EGRESS; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/**
	 * U1: injected iptables runner for tests; defaults to execFileSync on PATH (the desktop
	 * argv-stub idiom). Receives the exact composed argv, one rule per call; a throw is a
	 * policy application failure (fail-closed: the sandbox refuses to start).
	 */
	runIptables?: (argv: readonly string[]) => void;
	/** U1: injected host resolver for tests; defaults to an A-record DNS lookup. */
	resolveEgressHost?: (host: string) => Promise<readonly string[]>;
	/** U1: one warning event per egress refusal, the reconcile warn idiom (action + reason). */
	warn?: (payload: { action: string; reason: string }) => void;
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
	/**
	 * U1 seed burst: run `work` with the seeder's bootstrap destinations (seed.ts SEED_EGRESS)
	 * open above the standing policy. The additions are dropped again even when `work` throws;
	 * a sandbox on the internal network refuses the burst (no route to open). The seeder opts
	 * in by wrapping its seed phase; the drop happens in a finally, not on a success path.
	 */
	withSeedEgress<T>(sandboxId: string, work: () => Promise<T>): Promise<T>;
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

/**
 * U2: where the sandbox reconciliation state file lives — `SUBSTRATE_SANDBOX_STATE` overrides,
 * else `<storage root>/sandboxes.json` (RIVETKIT_STORAGE_PATH, the unit's storage-dir idiom,
 * same root main.ts derives). The provider and main.ts derive the path independently because
 * the provider is constructed inside the rivet VM factory, which takes no host wiring.
 */
export function defaultSandboxStatePath(env: NodeJS.ProcessEnv = process.env): string {
	const override = (env["SUBSTRATE_SANDBOX_STATE"] ?? "").trim();
	if (override !== "") return override;
	const storage = (env["RIVETKIT_STORAGE_PATH"] ?? "").trim() || "/var/lib/substrate/agentos";
	return join(storage, "sandboxes.json");
}

/** One shared default state store and docker client behind the module-level reconcile entry points. */
let sharedState: SandboxStateStore | undefined;
let sharedDocker: DockerClient | undefined;
function sharedSandboxState(): SandboxStateStore {
	return (sharedState ??= new SandboxStateStore(defaultSandboxStatePath()));
}
function anyDocker(): DockerClient {
	return (sharedDocker ??= defaultDocker());
}

/** U1: the default iptables runner — execFileSync on PATH, the desktop argv-stub idiom. */
function defaultRunIptables(argv: readonly string[]): void {
	const [file, ...args] = argv;
	if (file === undefined) return;
	execFileSync(file, args, { timeout: 10_000, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * U1: the egress warn sink for providers built without an explicit `warn` option. The provider
 * is constructed inside the rivet VM factory (vm.ts), which takes no host wiring, so main.ts
 * installs the events_emit sink at boot; until then, and whenever unset, a refusal keeps the
 * stderr-note fallback so it is never invisible.
 */
let egressWarnSink: ((payload: { action: string; reason: string }) => void) | undefined;

export function setEgressWarnSink(warn: ((payload: { action: string; reason: string }) => void) | undefined): void {
	egressWarnSink = warn;
}

/**
 * U1×U2: execute the egress delete argvs recorded in a sandbox's state entry, best-effort per
 * rule (a failure is a stderr note, never a throw) and with the field cleared by the take.
 * Every destroy path goes through here — provider destroy and the module-level destroySandbox
 * that boot reconciliation terminates orphans through — so crash-orphaned rules are deleted
 * from the recorded argv, not from a dead process's memory. A failed cleanup leaves the
 * standing rule in place, and a standing rule only narrows: fail-open in the narrow direction,
 * never wider.
 */
export function runEgressCleanup(
	sandboxId: string,
	state: Pick<SandboxStateStore, "takeEgressCleanup">,
	runIptables: (argv: readonly string[]) => void = defaultRunIptables,
	note: (line: string) => void = (line) => process.stderr.write(`[substrate-host] ${line}\n`),
): void {
	for (const argv of state.takeEgressCleanup(sandboxId)) {
		try {
			runIptables(argv);
		} catch (cause) {
			note(`egress cleanup ${sandboxId.slice(0, 12)} delete failed (${argv.join(" ")}): ${String(cause)}`);
		}
	}
}

/** U2: every container on the daemon, running or exited, with the labels reconciliation classifies on. */
export async function listSandboxes(docker: DockerClient = anyDocker()): Promise<SandboxListing[]> {
	const containers = await docker.listContainers({ all: true });
	return containers.map((container) => ({
		sandbox_id: container.Id,
		labels: container.Labels ?? {},
		state: container.State ?? "unknown",
	}));
}

/**
 * U2: remove one container by id — stop, then force-remove, an already-gone container is
 * success. Only ever called with host-labeled ids: reconcileSandboxes classifies before it
 * terminates, and the classification is the guard.
 */
export async function destroySandbox(
	sandboxId: string,
	docker: DockerClient = anyDocker(),
	state: Pick<SandboxStateStore, "takeEgressCleanup"> = sharedSandboxState(),
	runIptables: (argv: readonly string[]) => void = defaultRunIptables,
): Promise<void> {
	// U1×U2: the standing DOCKER-USER rules outlive this process in the state file — run the
	// recorded deletes (best-effort) before the container goes, whether this boot applied them
	// or not. Boot reconciliation terminates orphans through here, so crash-orphan rules die too.
	runEgressCleanup(sandboxId, state, runIptables);
	const container = docker.getContainer(sandboxId);
	await container.stop({ t: 5 }).catch(() => undefined);
	await container.remove({ force: true }).catch((error: unknown) => {
		if (isNotFound(error)) return; // already gone
		const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
		// 409: AutoRemove started removing it when stop() returned.
		if (status !== 409) throw error;
	});
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
	// U2: durable sandbox→task records; the provider learns only the graph, so node/task stay null.
	const sandboxState = opts.sandboxState ?? sharedSandboxState();
	// U1: one warning event per egress refusal. Wired by main.ts to events_emit through the
	// module sink (the provider is constructed inside the rivet VM factory, which takes no host
	// wiring); until the sink is installed the fallback is the stderr-note idiom
	// (SandboxStateStore) so a refusal is never invisible.
	const warn = opts.warn ?? ((payload: { action: string; reason: string }) => {
		const sink = egressWarnSink;
		if (sink === undefined) {
			process.stderr.write(`[substrate-host] ${payload.action}: ${payload.reason}\n`);
			return;
		}
		sink(payload);
	});
	const refuse = (reason: string): never => {
		warn({ action: "sandbox.egress", reason });
		throw new Error(reason);
	};
	// U1: parse and conflict-check the policy before any Docker call — a bad entry or a policy
	// the network cannot enforce refuses here (fail-closed, naming the entry/reason) rather
	// than at first create.
	let egress: EgressPolicy;
	try {
		egress = opts.egress ?? parseSandboxEgress(opts.env?.[SANDBOX_EGRESS_ENV] ?? process.env[SANDBOX_EGRESS_ENV]);
	} catch (cause) {
		// refuse throws; the explicit return also marks egress definitely-assigned past this catch.
		return refuse(String(cause));
	}
	const conflict = egressConflict(egress, network);
	if (conflict !== null) refuse(conflict);
	const runIptables = opts.runIptables ?? defaultRunIptables;
	const resolveHost =
		opts.resolveEgressHost ??
		(async (host: string) => (await lookup(host, { all: true, family: 4 })).map((entry) => entry.address));
	// U1: the seeder's bootstrap destinations (seed.ts SEED_EGRESS), under the same strict grammar.
	const bootstrap: readonly EgressDestination[] = parseSandboxEgress(SEED_EGRESS.join(",")).allow;

	/** Inspect a container and refuse any that this graph's provider did not create. */
	async function inspectOwned(sandboxId: string): Promise<ContainerInspect> {
		const info = await docker().getContainer(sandboxId).inspect();
		if (info.Config?.Labels?.[GRAPH_LABEL] !== graphId) {
			throw new Error(`container ${sandboxId} is not a ${GRAPH_LABEL}=${graphId} sandbox`);
		}
		return info;
	}

	/** U1: resolve every allow host once per application; unresolvable names refuse (fail-closed). */
	async function resolveEgress(policy: EgressPolicy): Promise<Map<string, readonly string[]>> {
		const resolved = new Map<string, readonly string[]>();
		for (const destination of policy.allow) {
			if (resolved.has(destination.host)) continue;
			let addresses: readonly string[];
			try {
				addresses = await resolveHost(destination.host);
			} catch (cause) {
				throw new Error(`egress destination ${JSON.stringify(destination.host)} could not be resolved: ${String(cause)}`);
			}
			if (addresses.length === 0) {
				throw new Error(`egress destination ${JSON.stringify(destination.host)} does not resolve`);
			}
			resolved.set(destination.host, addresses);
		}
		return resolved;
	}

	/** U1: the bridge address the rules pin the container's own traffic by. */
	function containerIp(info: ContainerInspect): string {
		const ip = info.NetworkSettings?.IPAddress;
		if (typeof ip !== "string" || ip === "") {
			throw new Error("sandbox container has no bridge address to pin egress rules to");
		}
		return ip;
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
			// U1: the policy argv runs between create and start — the container never runs a
			// millisecond wider than its policy. On the internal bridge deny-all is docker-native
			// (no external route) and nothing is composed; on the published bridge the DOCKER-USER
			// rules are pinned to the container's bridge address. Any failure here is a refused
			// start: the rules applied so far are removed, the container is torn down, one warning
			// event is emitted and the error propagates (fail-closed).
			const applied: string[][] = [];
			if (network === "published_loopback") {
				try {
					const info = await container.inspect();
					const rules = composeEgressRules(containerIp(info), egress.allow, await resolveEgress(egress));
					for (let i = 0; i < rules.apply.length; i += 1) {
						const apply = rules.apply[i];
						const remove = rules.remove[i];
						if (!apply || !remove) continue;
						runIptables(apply);
						applied.push(remove);
					}
				} catch (cause) {
					for (const argv of applied.splice(0)) {
						try {
							runIptables(argv);
						} catch {
							// Rollback is best-effort; the refusal below is what fails the start.
						}
					}
					await container.remove({ force: true }).catch(() => undefined);
					refuse(String(cause));
				}
			}
			try {
				await container.start();
			} catch (error) {
				// A refused start must not leave the just-applied rules pinned to a dead IP.
				for (const argv of applied.splice(0)) {
					try {
						runIptables(argv);
					} catch {
						// Rollback is best-effort; the start failure below is what propagates.
					}
				}
				await container.remove({ force: true }).catch(() => undefined);
				throw error;
			}
			// U2: written only after a successful start, so a restarted host re-adopts exactly the
			// sandboxes that came up. Best-effort: a failed record is a stderr warning, never an
			// open failure (the sandbox works; only re-adoption loses its memory). U1×U2: the
			// entry carries the exact delete argvs, so the standing rules outlive a crash — a
			// copy, since teardown runs straight from this record.
			sandboxState.record(container.id, {
				graph_id: graphId,
				node_id: null,
				task: null,
				opened_at: new Date().toISOString(),
				egress_cleanup: applied.map((argv) => [...argv]),
			});
			return container.id;
		},

		async destroy(sandboxId) {
			try {
				await inspectOwned(sandboxId);
			} catch (error) {
				if (isNotFound(error)) {
					runEgressCleanup(sandboxId, sandboxState, runIptables); // AutoRemove took the container; its recorded rules still stand
					sandboxState.forget(sandboxId); // the entry dies with it
					return;
				}
				throw error;
			}
			const container = docker().getContainer(sandboxId);
			await container.stop({ t: 5 }).catch(() => undefined);
			await container.remove({ force: true }).catch((error: unknown) => {
				// 404: already gone; 409: AutoRemove started removing it when stop() returned.
				const status = (error as { statusCode?: unknown }).statusCode;
				if (status !== 404 && status !== 409) throw error;
			});
			// U1: normal teardown — the standing rules die with the sandbox, and the next boot
			// must not re-adopt this sandbox. U1×U2: the deletes come from the entry, so a
			// re-adopted sandbox's rules (applied by an earlier boot) die here too.
			runEgressCleanup(sandboxId, sandboxState, runIptables);
			sandboxState.forget(sandboxId);
		},

		async withSeedEgress<T>(sandboxId: string, work: () => Promise<T>): Promise<T> {
			const info = await inspectOwned(sandboxId);
			if (network !== "published_loopback") {
				refuse("seed egress needs the published_loopback network; the internal bridge has no route a burst could open");
			}
			let rules: { apply: string[][]; remove: string[][] };
			try {
				rules = seedBurstRules(containerIp(info), bootstrap, await resolveEgress({ allow: bootstrap }));
			} catch (cause) {
				// refuse throws; the explicit return also marks rules definitely-assigned past this catch.
				return refuse(String(cause));
			}
			const burst: string[][] = [];
			try {
				for (let i = 0; i < rules.apply.length; i += 1) {
					const apply = rules.apply[i];
					const remove = rules.remove[i];
					if (!apply || !remove) continue;
					try {
						runIptables(apply);
					} catch (cause) {
						refuse(`seed egress rule failed: ${String(cause)}`);
					}
					burst.push(remove);
				}
				return await work();
			} finally {
				// The seeder's additions die with the burst — success, throw or refusal alike.
				for (const argv of burst.splice(0)) {
					try {
						runIptables(argv);
					} catch {
						// Best-effort; a stale burst rule never fails the seeder's own outcome.
					}
				}
			}
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
