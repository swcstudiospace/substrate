/**
 * Tests for the LANEA-05 disk gate: any image build or pull below 10 GiB
 * free is refused before any docker call, with a stubbed df runner.
 * Docker is faked; no daemon is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_LABEL, parseSandboxEgress, worktreeFor } from "./sandbox-options.ts";
import { SEED_EGRESS } from "./seed.ts";
import {
	checkDiskFloor,
	defaultSandboxStatePath,
	destroySandbox,
	DISK_FLOOR_BYTES,
	ensureImagePulled,
	type DockerClient,
	listSandboxes,
	runEgressCleanup,
	setEgressWarnSink,
	substrateDocker,
} from "./sandbox-provider.ts";
import { reconcileSandboxes, SandboxStateStore } from "./tasks.ts";

function dfWith(availBytes: number): () => string | null {
	return () => `Avail\n${availBytes}\n`;
}

function notFoundError(): Error {
	return Object.assign(new Error("No such image"), { statusCode: 404 });
}

function fakeDocker(): { docker: DockerClient; calls: string[] } {
	const calls: string[] = [];
	const docker = {
		getImage: (name: string) => {
			calls.push(`getImage:${name}`);
			return { inspect: async () => ({}) };
		},
		pull: async (name: string) => {
			calls.push(`pull:${name}`);
			return { stream: true };
		},
		modem: {
			followProgress: (stream: unknown, onFinished: (error: Error | null, output: unknown) => void) => {
				calls.push("followProgress");
				expect(stream).toEqual({ stream: true });
				onFinished(null, []);
			},
		},
		createContainer: async () => {
			throw new Error("not needed here");
		},
		getContainer: (id: string) => {
			throw new Error(`not needed here: ${id}`);
		},
		getNetwork: () => {
			throw new Error("not needed here");
		},
		listContainers: async () => [],
		createNetwork: async () => undefined,
	} satisfies DockerClient;
	return { docker, calls };
}

describe("checkDiskFloor", () => {
	test("refuses below the floor and names the free bytes and the floor", () => {
		const gate = checkDiskFloor(dfWith(DISK_FLOOR_BYTES - 1));
		expect(gate.ok).toBe(false);
	});

	test("allows above the floor", () => {
		const gate = checkDiskFloor(dfWith(DISK_FLOOR_BYTES + 1));
		expect(gate).toEqual({ ok: true, availBytes: DISK_FLOOR_BYTES + 1 });
	});

	test("unreadable df refuses (fail-closed)", () => {
		expect(checkDiskFloor(() => null).ok).toBe(false);
		expect(checkDiskFloor(() => "garbage").ok).toBe(false);
	});
});

describe("ensureImagePulled", () => {
	test("present image skips the pull without a docker pull call", async () => {
		const { docker, calls } = fakeDocker();
		const result = await ensureImagePulled(docker, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES + 1));
		expect(result).toBe("present");
		expect(calls.some((call) => call.startsWith("pull:"))).toBe(false);
	});

	test("missing image pulls, but only after the gate passes", async () => {
		const { docker, calls } = fakeDocker();
		const missing = {
			...docker,
			getImage: (name: string) => {
				calls.push(`getImage:${name}`);
				return { inspect: async () => { throw notFoundError(); } };
			},
		} satisfies DockerClient;
		const result = await ensureImagePulled(missing, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES + 1));
		expect(result).toBe("pulled");
		expect(calls).toEqual([
			"getImage:substrate-sandbox:0.1",
			"pull:substrate-sandbox:0.1",
			"followProgress",
		]);
	});

	test("below the floor no docker call happens at all", async () => {
		const { docker, calls } = fakeDocker();
		await expect(
			ensureImagePulled(docker, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES - 1)),
		).rejects.toThrow(/floor 10737418240/);
		expect(calls).toEqual([]);
	});

	test("unreadable df refuses before any docker call", async () => {
		const { docker, calls } = fakeDocker();
		await expect(ensureImagePulled(docker, "substrate-sandbox:0.1", () => null)).rejects.toThrow(
			/refusing image substrate-sandbox:0.1/,
		);
		expect(calls).toEqual([]);
	});
});

/** State-file paths created by tests, removed after each test. */
const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tmp-path state store; a store warning here is a failure — nothing in these tests may note. */
function tmpState(): SandboxStateStore {
	const dir = mkdtempSync(join(tmpdir(), "u2-provider-"));
	tmpDirs.push(dir);
	return new SandboxStateStore(join(dir, "sandboxes.json"), (line) => {
		throw new Error(line);
	});
}

/** A full fake daemon for provider-level tests: containers live in a map, every call is recorded. */
function daemonDocker(): { docker: DockerClient; calls: string[] } {
	const calls: string[] = [];
	const containers = new Map<string, { labels: Record<string, string>; running: boolean }>();
	const handle = (id: string) => ({
		id,
		start: async () => {
			calls.push(`start:${id}`);
			const container = containers.get(id);
			if (container) container.running = true;
		},
		stop: async () => {
			calls.push(`stop:${id}`);
		},
		remove: async () => {
			calls.push(`remove:${id}`);
			containers.delete(id);
		},
		inspect: async () => {
			const container = containers.get(id);
			if (!container) throw Object.assign(new Error("No such container"), { statusCode: 404 });
			// U1: the provider pins egress rules to the container's bridge address.
			return { Config: { Labels: container.labels }, NetworkSettings: { IPAddress: "172.17.0.2" } };
		},
	});
	const docker = {
		createContainer: async (body: Record<string, unknown>) => {
			const id = `c${containers.size + 1}`;
			calls.push(`create:${id}`);
			// buildContainerSpec always sends Labels: { [GRAPH_LABEL]: string }.
			const labels = body.Labels as Record<string, string> | undefined;
			containers.set(id, { labels: labels ?? {}, running: false });
			return handle(id);
		},
		getContainer: (id: string) => handle(id),
		// U1 internal-network tests join the existing SANDBOX_NETWORK; it is internal.
		getNetwork: () => ({ inspect: async () => ({ Internal: true }) }),
		createNetwork: async () => undefined,
		getImage: (name: string) => {
			calls.push(`getImage:${name}`);
			return { inspect: async () => ({}) };
		},
		pull: async (name: string) => {
			calls.push(`pull:${name}`);
			return { stream: true };
		},
		listContainers: async () =>
			[...containers].map(([Id, container]) => ({
				Id,
				Labels: container.labels,
				State: container.running ? "running" : "exited",
			})),
		modem: {
			followProgress: (stream: unknown, onFinished: (error: Error | null, output: unknown) => void) => {
				expect(stream).toEqual({ stream: true });
				onFinished(null, []);
			},
		},
	} satisfies DockerClient;
	return { docker, calls };
}

const U2_GID = "ut-a-12345678";
const dfAboveFloor = () => `Avail\n${DISK_FLOOR_BYTES + 1}\n`;

function u2Provider(docker: DockerClient, state: SandboxStateStore) {
	return substrateDocker({
		graphId: U2_GID,
		worktree: worktreeFor(U2_GID),
		network: "published_loopback",
		docker,
		runDf: dfAboveFloor,
		// U1 deny-all is in force here (no egress config): the DOCKER-USER argv is stubbed out
		// because these tests pin U2 state behavior, not rule application (pinned in U1's suite).
		runIptables: () => undefined,
		sandboxState: state,
	});
}

describe("substrateDocker sandbox state (U2)", () => {
	test("create records the sandbox after a successful start; destroy drops the entry", async () => {
		const { docker, calls } = daemonDocker();
		const state = tmpState();
		const sandboxId = await u2Provider(docker, state).create();
		expect(calls).toEqual([`getImage:substrate-sandbox:0.1`, `create:${sandboxId}`, `start:${sandboxId}`]);
		expect(state.list()).toEqual([
			{
				sandbox_id: sandboxId,
				graph_id: U2_GID,
				node_id: null,
				task: null,
				opened_at: expect.any(String),
				// U1×U2: the published bridge's deny-all source drop is the one recorded delete.
				egress_cleanup: [["iptables", "-D", "DOCKER-USER", "-s", "172.17.0.2", "-j", "DROP"]],
			},
		]);
		await u2Provider(docker, state).destroy(sandboxId);
		expect(calls).toContain(`stop:${sandboxId}`);
		expect(calls).toContain(`remove:${sandboxId}`);
		expect(state.list()).toEqual([]);
	});

	test("destroy of an already-removed sandbox takes the AutoRemove path and still drops the entry", async () => {
		const { docker } = daemonDocker();
		const state = tmpState();
		const provider = u2Provider(docker, state);
		const sandboxId = await provider.create();
		await docker.getContainer(sandboxId).remove({ force: true }); // the daemon removed it first
		await provider.destroy(sandboxId); // must not throw; entry dies with the container
		expect(state.list()).toEqual([]);
	});

	test("a failed start records nothing: only sandboxes that came up are re-adoptable", async () => {
		const { docker } = daemonDocker();
		const state = tmpState();
		const failing = {
			...docker,
			createContainer: async (body: Record<string, unknown>) => {
				const handle = await docker.createContainer(body);
				return {
					...handle,
					start: async () => {
						throw new Error("port already published");
					},
				};
			},
		} satisfies DockerClient;
		await expect(u2Provider(failing, state).create()).rejects.toThrow(/port already published/);
		expect(state.list()).toEqual([]);
	});

	test("listSandboxes reports every container with its labels and state; destroySandbox stops and removes", async () => {
		const { docker, calls } = daemonDocker();
		const provider = u2Provider(docker, tmpState());
		const sandboxId = await provider.create();
		expect(await listSandboxes(docker)).toEqual([
			{ sandbox_id: sandboxId, labels: { [GRAPH_LABEL]: U2_GID }, state: "running" },
		]);
		await destroySandbox(sandboxId, docker);
		expect(calls).toContain(`stop:${sandboxId}`);
		expect(calls).toContain(`remove:${sandboxId}`);
		expect(await listSandboxes(docker)).toEqual([]);
	});
});

describe("egress cleanup persistence (U1×U2)", () => {
	const DEST = "104.16.1.1";
	const allowNpm = { egress: { allow: [{ host: "registry.npmjs.org", port: 443 }] } };
	// The delete argv of every rule the allowlist compose inserts (spec without the -I position).
	const recordedDeletes = (): string[][] => [
		["iptables", "-D", "DOCKER-USER", "-s", IP, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
		["iptables", "-D", "DOCKER-USER", "-s", IP, "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
		["iptables", "-D", "DOCKER-USER", "-s", IP, "-d", DEST, "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
		["iptables", "-D", "DOCKER-USER", "-s", IP, "-j", "DROP"],
	];

	test("create persists the exact delete argv into the state entry", async () => {
		const { provider, state } = egressRig(allowNpm);
		const sandboxId = await provider.create();
		expect(state.list()).toEqual([
			{
				sandbox_id: sandboxId,
				graph_id: EGRESS_GID,
				node_id: null,
				task: null,
				opened_at: expect.any(String),
				egress_cleanup: recordedDeletes(),
			},
		]);
	});

	test("a fresh provider instance (re-adopt) destroys standing rules from the recorded argv, once", async () => {
		const { provider, docker, calls, state } = egressRig(allowNpm);
		const sandboxId = await provider.create();
		calls.length = 0; // forget this boot's apply timeline; only the teardown below may appear
		const reborn = substrateDocker({
			graphId: EGRESS_GID,
			worktree: worktreeFor(EGRESS_GID),
			network: "published_loopback",
			docker,
			runDf: dfAboveFloor,
			runIptables: (argv) => calls.push(argv.join(" ")),
			resolveEgressHost: async (host) => (host === "registry.npmjs.org" ? [DEST] : []),
			sandboxState: state,
		});
		await reborn.destroy(sandboxId); // this instance never applied the rules itself
		expect(calls.filter((call) => call.includes("DOCKER-USER"))).toEqual(
			recordedDeletes().map((argv) => argv.join(" ")),
		);
		expect(state.list()).toEqual([]); // the deletes ran, then the entry died with the sandbox
	});

	test("destroySandbox — the reconciliation terminate — runs the recorded deletes and clears the field", async () => {
		const { docker, calls } = daemonDocker();
		const state = tmpState();
		state.record("box-a", {
			graph_id: EGRESS_GID,
			node_id: null,
			task: null,
			opened_at: "t",
			egress_cleanup: recordedDeletes(),
		});
		const deletes: string[][] = [];
		await destroySandbox("box-a", docker, state, (argv) => deletes.push([...argv]));
		expect(deletes).toEqual(recordedDeletes());
		expect(calls).toContain("stop:box-a"); // the teardown proceeded past the cleanup
		expect(state.list()).toEqual([
			{ sandbox_id: "box-a", graph_id: EGRESS_GID, node_id: null, task: null, opened_at: "t", egress_cleanup: null },
		]); // the field is cleared; the caller's forget drops the rest
	});

	test("a failed recorded delete is a stderr note, never a throw; the field clears — a standing rule only narrows", () => {
		const state = tmpState();
		state.record("box-a", {
			graph_id: EGRESS_GID,
			node_id: null,
			task: null,
			opened_at: "t",
			egress_cleanup: recordedDeletes(),
		});
		const notes: string[] = [];
		const stderr = process.stderr.write;
		process.stderr.write = ((line: string | Uint8Array) => {
			notes.push(String(line));
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(() =>
				runEgressCleanup("box-a", state, () => {
					throw new Error("iptables: permission denied");
				}),
			).not.toThrow();
		} finally {
			process.stderr.write = stderr;
		}
		expect(notes.join("")).toContain("egress cleanup box-a delete failed");
		expect(notes.join("")).toContain("iptables: permission denied");
		// Design: the take clears unconditionally. The un-deleted rule stands — and a standing
		// rule only denies, so a failed cleanup is fail-open in the narrow direction.
		expect(state.list()).toEqual([
			{ sandbox_id: "box-a", graph_id: EGRESS_GID, node_id: null, task: null, opened_at: "t", egress_cleanup: null },
		]);
	});

	test("boot reconciliation terminates a crash orphan through destroySandbox and cleans its recorded rules", async () => {
		const { docker } = daemonDocker();
		const state = tmpState();
		state.record("box-a", {
			graph_id: EGRESS_GID,
			node_id: null,
			task: null,
			opened_at: "t",
			egress_cleanup: recordedDeletes(),
		});
		const deletes: string[][] = [];
		const warnings: Array<{ action: string; sandbox_id: string }> = [];
		const result = await reconcileSandboxes({
			enumerate: async () => [{ sandbox_id: "box-a", labels: { [GRAPH_LABEL]: EGRESS_GID }, state: "exited" }],
			state,
			taskFor: () => null, // the crash lost the task's claim — the sandbox is an orphan
			terminate: (sandboxId) => destroySandbox(sandboxId, docker, state, (argv) => deletes.push([...argv])),
			warn: (payload) => warnings.push(payload),
		});
		expect(result.terminated).toEqual(["box-a"]);
		expect(deletes).toEqual(recordedDeletes()); // the crash-orphan's standing rules are deleted
		expect(state.list()).toEqual([]); // the field cleared with the take, the entry dropped with the forget
		expect(warnings).toEqual([{ action: "host.orphan", sandbox_id: "box-a" }]);
	});

	test("without a warn option an egress refusal routes through the module sink (main.ts events_emit wiring)", async () => {
		const events: WarnEvent[] = [];
		setEgressWarnSink((payload) => events.push(payload));
		try {
			const { provider } = egressRig({ ...allowNpm, warn: undefined, resolveEgressHost: async () => [] });
			await expect(provider.create()).rejects.toThrow(/does not resolve/);
			expect(events).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("does not resolve") }]);
		} finally {
			setEgressWarnSink(undefined); // the sink is process-global; never leak it into other tests
		}
	});
});

describe("defaultSandboxStatePath (U2)", () => {
	test("SUBSTRATE_SANDBOX_STATE wins, else the storage root, else the unit default", () => {
		expect(defaultSandboxStatePath({ SUBSTRATE_SANDBOX_STATE: "/tmp/sandboxes.json" })).toBe("/tmp/sandboxes.json");
		expect(defaultSandboxStatePath({ RIVETKIT_STORAGE_PATH: "/var/lib/substrate/agentos" })).toBe(
			"/var/lib/substrate/agentos/sandboxes.json",
		);
		expect(defaultSandboxStatePath({})).toBe("/var/lib/substrate/agentos/sandboxes.json");
	});
});

// ── U1: the sandbox egress allowlist ─────────────────────────────────────────────────────────

const EGRESS_GID = "ut-eg-12345678";
const IP = "172.17.0.2";

type WarnEvent = { action: string; reason: string };

type ProviderOpts = Parameters<typeof substrateDocker>[0];

/**
 * A published-bridge rig: the iptables argv lands in the same timeline as the docker calls, so
 * an exact `calls` assertion pins rule application between create and start (the desktop
 * PATH-stub precedent — argv is pinned end to end). Host resolution answers only the npm
 * registry, so an unlisted host is unresolvable.
 */
function egressRig(overrides: Partial<ProviderOpts> = {}) {
	const { docker, calls } = daemonDocker();
	const warnings: WarnEvent[] = [];
	const state = overrides.sandboxState ?? tmpState(); // isolated so cleanup reads never hit a shared path
	const provider = substrateDocker({
		graphId: EGRESS_GID,
		worktree: worktreeFor(EGRESS_GID),
		network: "published_loopback",
		docker,
		runDf: dfAboveFloor,
		runIptables: (argv) => calls.push(argv.join(" ")),
		resolveEgressHost: async (host) => (host === "registry.npmjs.org" ? ["104.16.1.1"] : []),
		warn: (payload) => warnings.push(payload),
		sandboxState: state,
		...overrides,
	});
	return { provider, docker, calls, warnings, state };
}

describe("substrateDocker egress policy (U1)", () => {
	test("deny-all default: the standing source drop is applied between create and start", async () => {
		const { provider, calls } = egressRig();
		const sandboxId = await provider.create();
		expect(calls).toEqual([
			"getImage:substrate-sandbox:0.1",
			`create:${sandboxId}`,
			`iptables -I DOCKER-USER 1 -s ${IP} -j DROP`,
			`start:${sandboxId}`,
		]);
		await provider.destroy(sandboxId);
		expect(calls).toContain(`iptables -D DOCKER-USER -s ${IP} -j DROP`);
	});

	test("the internal bridge needs no argv: deny-all is docker-native there", async () => {
		const { provider, calls } = egressRig({ network: "internal" });
		const sandboxId = await provider.create();
		expect(calls).toEqual(["getImage:substrate-sandbox:0.1", `create:${sandboxId}`, `start:${sandboxId}`]);
		await provider.destroy(sandboxId);
		expect(calls.some((call) => call.includes("DOCKER-USER"))).toBe(false);
	});

	test("destroy of an already-gone sandbox still removes the standing rules", async () => {
		const { provider, docker, calls } = egressRig();
		const sandboxId = await provider.create();
		await docker.getContainer(sandboxId).remove({ force: true }); // the daemon removed it first
		await provider.destroy(sandboxId);
		expect(calls.filter((call) => call.includes("DOCKER-USER"))).toEqual([
			`iptables -I DOCKER-USER 1 -s ${IP} -j DROP`,
			`iptables -D DOCKER-USER -s ${IP} -j DROP`,
		]);
	});

	test("an allowlist opens exactly DNS and the listed destinations, pinned to resolved addresses", async () => {
		const { provider, calls } = egressRig({ egress: { allow: [{ host: "registry.npmjs.org", port: 443 }] } });
		const sandboxId = await provider.create();
		expect(calls.slice(2)).toEqual([
			`iptables -I DOCKER-USER 1 -s ${IP} -p udp --dport 53 -j ACCEPT`,
			`iptables -I DOCKER-USER 2 -s ${IP} -p tcp --dport 53 -j ACCEPT`,
			`iptables -I DOCKER-USER 3 -s ${IP} -d 104.16.1.1 -p tcp --dport 443 -j ACCEPT`,
			`iptables -I DOCKER-USER 4 -s ${IP} -j DROP`,
			`start:${sandboxId}`,
		]);
	});

	test("SUBSTRATE_SANDBOX_EGRESS drives the policy without an explicit option", async () => {
		const { docker, calls } = daemonDocker();
		const provider = substrateDocker({
			graphId: EGRESS_GID,
			worktree: worktreeFor(EGRESS_GID),
			network: "published_loopback",
			docker,
			runDf: dfAboveFloor,
			env: { SUBSTRATE_SANDBOX_EGRESS: "example.com:443, api.github.com:443" },
			runIptables: (argv) => calls.push(argv.join(" ")),
			resolveEgressHost: async () => ["93.184.216.34"],
		});
		const sandboxId = await provider.create();
		expect(calls.slice(2)).toEqual([
			`iptables -I DOCKER-USER 1 -s ${IP} -p udp --dport 53 -j ACCEPT`,
			`iptables -I DOCKER-USER 2 -s ${IP} -p tcp --dport 53 -j ACCEPT`,
			`iptables -I DOCKER-USER 3 -s ${IP} -d 93.184.216.34 -p tcp --dport 443 -j ACCEPT`,
			`iptables -I DOCKER-USER 4 -s ${IP} -d 93.184.216.34 -p tcp --dport 443 -j ACCEPT`,
			`iptables -I DOCKER-USER 5 -s ${IP} -j DROP`,
			`start:${sandboxId}`,
		]);
	});

	test("a failed rule application refuses the start: rollback, container removed, one warning", async () => {
		const { docker, calls } = daemonDocker();
		const warnings: WarnEvent[] = [];
		const provider = substrateDocker({
			graphId: EGRESS_GID,
			worktree: worktreeFor(EGRESS_GID),
			network: "published_loopback",
			docker,
			runDf: dfAboveFloor,
			runIptables: (argv) => {
				if (argv.includes("-I")) throw new Error("iptables: permission denied");
				calls.push(argv.join(" "));
			},
			warn: (payload) => warnings.push(payload),
		});
		await expect(provider.create()).rejects.toThrow(/permission denied/);
		expect(calls).toEqual(["getImage:substrate-sandbox:0.1", "create:c1", "remove:c1"]);
		expect(warnings).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("permission denied") }]);
	});

	test("an unresolvable allowlist entry refuses the start before any rule runs", async () => {
		const { provider, calls, warnings } = egressRig({ egress: { allow: [{ host: "gone.invalid", port: 443 }] } });
		await expect(provider.create()).rejects.toThrow(/gone\.invalid.*does not resolve/);
		expect(calls.some((call) => call.includes("DOCKER-USER"))).toBe(false);
		expect(calls).toContain("remove:c1");
		expect(calls).not.toContain("start:c1");
		expect(warnings).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("gone.invalid") }]);
	});

	test("a container without a bridge address refuses the start", async () => {
		const base = daemonDocker();
		const warnings: WarnEvent[] = [];
		const noAddress: DockerClient = {
			...base.docker,
			createContainer: async (body) => {
				const handle = await base.docker.createContainer(body);
				return {
					...handle,
					inspect: async () => ({ Config: { Labels: { [GRAPH_LABEL]: EGRESS_GID } } }),
				};
			},
		};
		const provider = substrateDocker({
			graphId: EGRESS_GID,
			worktree: worktreeFor(EGRESS_GID),
			network: "published_loopback",
			docker: noAddress,
			runDf: dfAboveFloor,
			runIptables: () => undefined,
			warn: (payload) => warnings.push(payload),
		});
		await expect(provider.create()).rejects.toThrow(/no bridge address/);
		expect(base.calls).toContain("remove:c1");
		expect(base.calls.some((call) => call.startsWith("iptables"))).toBe(false);
		expect(warnings).toHaveLength(1);
	});

	test("a bad SUBSTRATE_SANDBOX_EGRESS entry refuses at construction, before any docker call", () => {
		const base = daemonDocker();
		const warnings: WarnEvent[] = [];
		expect(() =>
			substrateDocker({
				graphId: EGRESS_GID,
				worktree: worktreeFor(EGRESS_GID),
				network: "published_loopback",
				docker: base.docker,
				runDf: dfAboveFloor,
				runIptables: () => undefined,
				env: { SUBSTRATE_SANDBOX_EGRESS: "example.com" },
				warn: (payload) => warnings.push(payload),
			}),
		).toThrow(/example\.com/);
		expect(warnings).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("example.com") }]);
		expect(base.calls).toEqual([]);
	});

	test("an allowlist on the internal network refuses at construction", () => {
		const base = daemonDocker();
		const warnings: WarnEvent[] = [];
		expect(() =>
			substrateDocker({
				graphId: EGRESS_GID,
				worktree: worktreeFor(EGRESS_GID),
				network: "internal",
				docker: base.docker,
				runDf: dfAboveFloor,
				runIptables: () => undefined,
				egress: { allow: [{ host: "registry.npmjs.org", port: 443 }] },
				warn: (payload) => warnings.push(payload),
			}),
		).toThrow(/internal network has no external route/);
		expect(warnings).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("internal network") }]);
		expect(base.calls).toEqual([]);
	});

	test("the default runner forks the composed argv as an iptables binary found on PATH", async () => {
		// The desktop stub precedent: the binary resolves through PATH, the flags are pinned.
		const dir = mkdtempSync(join(tmpdir(), "u1-iptables-"));
		tmpDirs.push(dir);
		const log = join(dir, "argv.log");
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "iptables"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
		const { docker } = daemonDocker();
		const prevPath = process.env.PATH ?? "";
		process.env.PATH = `${bin}:${prevPath}`;
		try {
			const provider = substrateDocker({
				graphId: EGRESS_GID,
				worktree: worktreeFor(EGRESS_GID),
				network: "published_loopback",
				docker,
				runDf: dfAboveFloor,
			});
			await provider.create();
		} finally {
			process.env.PATH = prevPath;
		}
		expect(readFileSync(log, "utf8").split("\n")).toEqual([
			"-I",
			"DOCKER-USER",
			"1",
			"-s",
			IP,
			"-j",
			"DROP",
			"",
		]);
	});
});

describe("substrateDocker withSeedEgress (U1 seed burst)", () => {
	const BURST_ACCEPT = `iptables -I DOCKER-USER -s ${IP} -d 104.16.1.1 -p tcp --dport 443 -j ACCEPT`;
	const BURST_REMOVE = `iptables -D DOCKER-USER -s ${IP} -d 104.16.1.1 -p tcp --dport 443 -j ACCEPT`;

	test("opens the seeder's declared registries above the drop, then drops them", async () => {
		const { provider, calls } = egressRig();
		const sandboxId = await provider.create();
		calls.length = 0;
		let ran = false;
		await provider.withSeedEgress(sandboxId, async () => {
			ran = true;
			return "seeded";
		});
		expect(ran).toBe(true);
		// The burst opens exactly what seed.ts declares, resolved like any allowlist entry.
		const bootstrap = parseSandboxEgress(SEED_EGRESS.join(",")).allow;
		expect(bootstrap).toEqual([{ host: "registry.npmjs.org", port: 443 }]);
		expect(calls).toEqual([BURST_ACCEPT, BURST_REMOVE]);
	});

	test("drops the burst even when the seeded work throws", async () => {
		const { provider, calls, warnings } = egressRig();
		const sandboxId = await provider.create();
		calls.length = 0;
		await expect(
			provider.withSeedEgress(sandboxId, async () => {
				throw new Error("seed failed");
			}),
		).rejects.toThrow(/seed failed/);
		expect(calls).toEqual([BURST_ACCEPT, BURST_REMOVE]);
		expect(warnings).toEqual([]);
	});

	test("a failing burst rule refuses with one warning and leaves only the standing rules", async () => {
		const { provider, calls, warnings } = egressRig({
			runIptables: (argv) => {
				if (argv.includes("-d")) throw new Error("iptables: boom");
				calls.push(argv.join(" "));
			},
		});
		const sandboxId = await provider.create();
		// After create the only iptables line is the standing drop; restart the timeline at it.
		calls.length = 0;
		calls.push(`iptables -I DOCKER-USER 1 -s ${IP} -j DROP`);
		await expect(provider.withSeedEgress(sandboxId, async () => "never")).rejects.toThrow(/seed egress rule failed/);
		expect(warnings).toEqual([{ action: "sandbox.egress", reason: expect.stringContaining("boom") }]);
		expect(calls).toEqual([`iptables -I DOCKER-USER 1 -s ${IP} -j DROP`]);
	});

	test("refuses the burst on the internal network — no route a burst could open", async () => {
		const { provider, warnings } = egressRig({ network: "internal" });
		const sandboxId = await provider.create();
		await expect(provider.withSeedEgress(sandboxId, async () => "never")).rejects.toThrow(
			/no route a burst could open/,
		);
		expect(warnings).toHaveLength(1);
	});
});
