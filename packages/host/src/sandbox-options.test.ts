import { describe, expect, test } from "bun:test";
import {
	buildContainerSpec,
	egressConflict,
	egressRules,
	effectiveEgress,
	GRAPH_LABEL,
	parseSandboxEgress,
	SANDBOX_NETWORK,
	seedBurstRules,
	WORKTREES_ROOT,
	type ContainerSpecOptions,
} from "./sandbox-options.ts";

const graphId = "ut-abc-12345678";
const base: ContainerSpecOptions = {
	graphId,
	worktree: `${WORKTREES_ROOT}/${graphId}`,
	token: "t",
	image: "substrate-sandbox:0.1",
	network: "published_loopback",
};

type Spec = {
	Cmd: string[];
	Labels: Record<string, string>;
	HostConfig: {
		PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]>;
		Binds: string[];
		Privileged?: boolean;
		AutoRemove?: boolean;
		NetworkMode?: string;
	};
};

const spec = (overrides: Partial<ContainerSpecOptions> = {}) =>
	buildContainerSpec({ ...base, ...overrides }) as unknown as Spec;

describe("buildContainerSpec — published_loopback", () => {
	test("publishes the command port on host loopback only", () => {
		const bindings = spec().HostConfig.PortBindings?.["3000/tcp"];
		expect(bindings).toHaveLength(1);
		expect(bindings?.[0]?.HostIp).toBe("127.0.0.1");
		expect(bindings?.[0]?.HostPort ?? "").toMatch(/^(|[0-9]+)$/);
	});

	test("every port binding carries HostIp 127.0.0.1", () => {
		for (const list of Object.values(spec().HostConfig.PortBindings ?? {})) {
			for (const binding of list) expect(binding.HostIp).toBe("127.0.0.1");
		}
	});

	test("starts the server with the per-container token and never without one", () => {
		const cmd = spec().Cmd;
		const i = cmd.indexOf("--token");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(cmd[i + 1]).toBe("t");
		expect(cmd).not.toContain("--no-token");
	});

	test("turns the command server's telemetry off", () => {
		expect(spec().Cmd).toContain("--no-telemetry");
	});

	test("labels the container with its graph id", () => {
		expect(spec().Labels[GRAPH_LABEL]).toBe(graphId);
	});

	test("binds the worktree at /work, unprivileged, auto-removed, no docker socket", () => {
		const hc = spec().HostConfig;
		expect(hc.Binds).toContain(`${WORKTREES_ROOT}/${graphId}:/work`);
		expect(hc.Privileged ?? false).toBe(false);
		expect(hc.AutoRemove).toBe(true);
		expect(hc.Binds.some((b) => b.includes("docker.sock"))).toBe(false);
	});
});

describe("buildContainerSpec — internal", () => {
	test("joins the internal network and publishes no port", () => {
		const hc = spec({ network: "internal" }).HostConfig;
		expect(hc.NetworkMode).toBe(SANDBOX_NETWORK);
		expect(hc.PortBindings).toBeUndefined();
	});
});

describe("buildContainerSpec — read-only binds", () => {
	test("appends each read-only bind with :ro", () => {
		const hc = spec({ readOnlyBinds: ["/root/src/repos/agent-substrate/node_modules:/work/node_modules"] }).HostConfig;
		expect(hc.Binds).toEqual([
			`${WORKTREES_ROOT}/${graphId}:/work`,
			"/root/src/repos/agent-substrate/node_modules:/work/node_modules:ro",
		]);
	});

	test("refuses the docker socket even as a read-only bind", () => {
		expect(() => spec({ readOnlyBinds: ["/var/run/docker.sock:/var/run/docker.sock"] })).toThrow();
	});
});

describe("buildContainerSpec — refusals", () => {
	test.each(["../x", "a b", "", ".hidden", "x.lock", "x.", "a..b"])("refuses graph id %p", (bad) => {
		expect(() => spec({ graphId: bad, worktree: `${WORKTREES_ROOT}/${bad}` })).toThrow();
	});

	test("refuses a worktree outside the worktrees root", () => {
		expect(() => spec({ worktree: `/tmp/${graphId}` })).toThrow();
		expect(() => spec({ worktree: `/var/lib/substrate/${graphId}` })).toThrow();
	});

	test("refuses a worktree that does not end in the graph id", () => {
		expect(() => spec({ worktree: `${WORKTREES_ROOT}/ut-other-00000000` })).toThrow();
		expect(() => spec({ worktree: `${WORKTREES_ROOT}/${graphId}/sub` })).toThrow();
	});

	test("refuses an empty token", () => {
		expect(() => spec({ token: "" })).toThrow();
	});
});

// ── U1: the sandbox egress allowlist ─────────────────────────────────────────────────────────

const RESOLVED = new Map([["registry.npmjs.org", ["104.16.1.1", "104.16.1.2"]]]);

describe("parseSandboxEgress (U1)", () => {
	test("unset, blank and comma-blank input is deny-all", () => {
		expect(parseSandboxEgress(undefined)).toEqual({ allow: [] });
		expect(parseSandboxEgress("")).toEqual({ allow: [] });
		expect(parseSandboxEgress("  ")).toEqual({ allow: [] });
		expect(parseSandboxEgress(" ,, ")).toEqual({ allow: [] });
	});

	test("parses trimmed host:port entries in order", () => {
		expect(parseSandboxEgress(" registry.npmjs.org:443 , api.github.com:443 ")).toEqual({
			allow: [
				{ host: "registry.npmjs.org", port: 443 },
				{ host: "api.github.com", port: 443 },
			],
		});
	});

	test("an entry without a port refuses naming the entry", () => {
		expect(() => parseSandboxEgress("example.com")).toThrow(/example\.com/);
		expect(() => parseSandboxEgress("example.com:")).toThrow(/example\.com/);
	});

	test("a non-host leading character refuses naming the entry", () => {
		expect(() => parseSandboxEgress(":443")).toThrow(/:443/);
		expect(() => parseSandboxEgress("-host:443")).toThrow(/-host:443/);
		expect(() => parseSandboxEgress("[::1]:443")).toThrow(/\[::1\]:443/);
	});

	test("a malformed port refuses naming the entry", () => {
		expect(() => parseSandboxEgress("host:0")).toThrow(/host:0/);
		expect(() => parseSandboxEgress("host:65536")).toThrow(/host:65536/);
		expect(() => parseSandboxEgress("host:4x3")).toThrow(/host:4x3/);
		expect(parseSandboxEgress("host:443 ").allow).toEqual([{ host: "host", port: 443 }]); // trimmed, valid
	});
});

describe("effectiveEgress (U1)", () => {
	const bootstrap = [{ host: "registry.npmjs.org", port: 443 }];
	const operator = { allow: [{ host: "api.github.com", port: 443 }] };

	test("off: the operator policy stands alone", () => {
		expect(effectiveEgress(operator, false, bootstrap)).toBe(operator);
	});

	test("on: the bootstrap destinations ride behind the operator policy", () => {
		expect(effectiveEgress(operator, true, bootstrap)).toEqual({
			allow: [...operator.allow, ...bootstrap],
		});
	});
});

describe("egressConflict (U1)", () => {
	const allow = { allow: [{ host: "registry.npmjs.org", port: 443 }] };

	test("an allowlist on the internal network refuses — no route to open", () => {
		expect(egressConflict(allow, "internal")).toMatch(/internal network has no external route/);
	});

	test("deny-all is free on the internal network; the published bridge takes any policy", () => {
		expect(egressConflict({ allow: [] }, "internal")).toBeNull();
		expect(egressConflict(allow, "published_loopback")).toBeNull();
		expect(egressConflict({ allow: [] }, "published_loopback")).toBeNull();
	});
});

describe("egressRules (U1)", () => {
	test("deny-all composes exactly one rule: the standing source drop", () => {
		const rules = egressRules("172.17.0.2", [], new Map());
		expect(rules.apply).toEqual([["iptables", "-I", "DOCKER-USER", "1", "-s", "172.17.0.2", "-j", "DROP"]]);
		expect(rules.remove).toEqual([["iptables", "-D", "DOCKER-USER", "-s", "172.17.0.2", "-j", "DROP"]]);
	});

	test("an allowlist composes DNS, per-address accepts and the drop, in chain order", () => {
		const rules = egressRules("172.17.0.2", [{ host: "registry.npmjs.org", port: 443 }], RESOLVED);
		expect(rules.apply).toEqual([
			["iptables", "-I", "DOCKER-USER", "1", "-s", "172.17.0.2", "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
			["iptables", "-I", "DOCKER-USER", "2", "-s", "172.17.0.2", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
			["iptables", "-I", "DOCKER-USER", "3", "-s", "172.17.0.2", "-d", "104.16.1.1", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
			["iptables", "-I", "DOCKER-USER", "4", "-s", "172.17.0.2", "-d", "104.16.1.2", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
			["iptables", "-I", "DOCKER-USER", "5", "-s", "172.17.0.2", "-j", "DROP"],
		]);
		// Every apply has a position-free delete twin; the drop deletes as the drop.
		expect(rules.remove).toHaveLength(rules.apply.length);
		expect(rules.remove[4]).toEqual(["iptables", "-D", "DOCKER-USER", "-s", "172.17.0.2", "-j", "DROP"]);
		expect(rules.remove[2]).toEqual([
			"iptables",
			"-D",
			"DOCKER-USER",
			"-s",
			"172.17.0.2",
			"-d",
			"104.16.1.1",
			"-p",
			"tcp",
			"--dport",
			"443",
			"-j",
			"ACCEPT",
		]);
	});

	test("an unlisted host gets no accept rule, and the source DROP is the last rule", () => {
		const only = new Map([["registry.npmjs.org", ["104.16.1.1"]]]);
		const rules = egressRules("172.17.0.2", [{ host: "registry.npmjs.org", port: 443 }], only);
		// Only the listed host's resolved address is ever an accept destination.
		const destinations = rules.apply.flatMap((argv) =>
			argv.includes("ACCEPT") && argv.includes("-d") ? [argv[argv.indexOf("-d") + 1]] : [],
		);
		expect(destinations).toEqual(["104.16.1.1"]);
		// No rule names any address beyond the container and that one destination.
		const addresses = rules.apply.flat().filter((token) => /^\d+\.\d+\.\d+\.\d+$/.test(token));
		expect(addresses.filter((token) => token !== "172.17.0.2" && token !== "104.16.1.1")).toEqual([]);
		// The standing source drop for the container is the final apply rule.
		expect(rules.apply.slice(-1)).toEqual([["iptables", "-I", "DOCKER-USER", "4", "-s", "172.17.0.2", "-j", "DROP"]]);
	});

	test("deny-all opens no DNS hole", () => {
		const rules = egressRules("172.17.0.2", [], new Map());
		expect(rules.apply.flat().join(" ")).not.toContain("53");
	});

	test("an unresolvable destination refuses, naming host:port", () => {
		expect(() => egressRules("172.17.0.2", [{ host: "gone.invalid", port: 443 }], new Map())).toThrow(
			/gone\.invalid:443.*does not resolve/,
		);
		expect(() => egressRules("172.17.0.2", [{ host: "gone.invalid", port: 443 }], RESOLVED)).toThrow(
			/gone\.invalid:443/,
		);
	});
});

describe("seedBurstRules (U1)", () => {
	const bootstrap = [{ host: "registry.npmjs.org", port: 443 }];

	test("head-inserted accepts with matching delete argv, nothing else", () => {
		const rules = seedBurstRules("172.17.0.2", bootstrap, RESOLVED);
		expect(rules.apply).toEqual([
			["iptables", "-I", "DOCKER-USER", "-s", "172.17.0.2", "-d", "104.16.1.1", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
			["iptables", "-I", "DOCKER-USER", "-s", "172.17.0.2", "-d", "104.16.1.2", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
		]);
		expect(rules.remove).toEqual([
			["iptables", "-D", "DOCKER-USER", "-s", "172.17.0.2", "-d", "104.16.1.1", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
			["iptables", "-D", "DOCKER-USER", "-s", "172.17.0.2", "-d", "104.16.1.2", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
		]);
	});

	test("an unresolvable bootstrap destination refuses, naming host:port", () => {
		expect(() => seedBurstRules("172.17.0.2", [{ host: "gone.invalid", port: 443 }], new Map())).toThrow(
			/gone\.invalid:443/,
		);
	});
});
