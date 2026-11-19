import { describe, expect, test } from "bun:test";
import { auditTotals, containerViolations, formatAudit, secretHits, secretKey } from "./audit.ts";
import { GRAPH_LABEL, SANDBOX_NETWORK, WORKTREES_ROOT } from "./sandbox-options.ts";

const GID = "ut-a-12345678";

type Inspect = Record<string, unknown>;

/** A docker-inspect object shaped like what buildContainerSpec produces (03-01: observed live). */
function inspect(overrides: { config?: Record<string, unknown>; host?: Record<string, unknown>; labels?: Record<string, string> | null } = {}): Inspect {
	const labels = overrides.labels === undefined ? { [GRAPH_LABEL]: GID } : overrides.labels;
	return {
		Id: "5efaf37c2690abcdef",
		Name: "/interesting_wescoff",
		Config: {
			Cmd: ["server", "--token", "tok-abc", "--host", "0.0.0.0", "--port", "3000", "--no-telemetry"],
			Labels: labels,
			...overrides.config,
		},
		HostConfig: {
			AutoRemove: true,
			Privileged: false,
			Binds: [`${WORKTREES_ROOT}/${GID}:/work`, "/root/src/repos/agent-substrate/node_modules:/work/node_modules:ro"],
			PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "32770" }] },
			NetworkMode: "bridge",
			...overrides.host,
		},
	};
}

describe("containerViolations", () => {
	test("the locked shape has no violation on published_loopback, nor on internal with the sandbox network and no published port", () => {
		expect(containerViolations(inspect(), "published_loopback")).toEqual([]);
		const internal = inspect({ host: { PortBindings: {}, NetworkMode: SANDBOX_NETWORK } });
		expect(containerViolations(internal, "internal")).toEqual([]);
		const internalNoBindings = inspect({ host: { PortBindings: null, NetworkMode: SANDBOX_NETWORK } });
		expect(containerViolations(internalNoBindings, "internal")).toEqual([]);
	});

	test("one named violation each: unbound or wildcard HostIp, privileged, docker.sock, writable non-worktree bind, --no-token, missing label", () => {
		const cases: Array<[string, Inspect, string]> = [
			["empty HostIp", inspect({ host: { PortBindings: { "3000/tcp": [{ HostIp: "", HostPort: "" }] } } }), "port_binding"],
			["wildcard HostIp", inspect({ host: { PortBindings: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] } } }), "port_binding"],
			["privileged", inspect({ host: { Privileged: true } }), "privileged"],
			["docker.sock", inspect({ host: { Binds: [`${WORKTREES_ROOT}/${GID}:/work`, "/var/run/docker.sock:/var/run/docker.sock:ro"] } }), "docker_sock"],
			["writable bind", inspect({ host: { Binds: [`${WORKTREES_ROOT}/${GID}:/work`, "/etc/substrate:/etc/substrate"] } }), "writable_bind"],
			["writable rw bind", inspect({ host: { Binds: [`${WORKTREES_ROOT}/${GID}:/work`, "/root:/root:rw"] } }), "writable_bind"],
			["--no-token", inspect({ config: { Cmd: ["server", "--no-token", "--host", "0.0.0.0", "--port", "3000"] } }), "token"],
			["missing label", inspect({ labels: null }), "label"],
			["empty label", inspect({ labels: { [GRAPH_LABEL]: "" } }), "label"],
		];
		for (const [name, obj, violation] of cases) {
			const found = containerViolations(obj, "published_loopback");
			expect(found, name).toHaveLength(1);
			expect(found[0]?.split(":")[0], name).toBe(violation);
		}
	});

	test("a foreign worktree mounted writable is a violation; the graph's own worktree is not", () => {
		const foreign = inspect({ host: { Binds: [`${WORKTREES_ROOT}/ut-other-99999999:/work`] } });
		expect(containerViolations(foreign, "published_loopback").map((v) => v.split(":")[0])).toEqual(["writable_bind"]);
		const own = inspect({ host: { Binds: [`${WORKTREES_ROOT}/${GID}:/work:rw`] } });
		expect(containerViolations(own, "published_loopback")).toEqual([]);
	});

	test("a bind under a non-default root from SUBSTRATE_WORKTREE_ROOTS is the graph's own worktree; with no root set it is foreign", () => {
		const alt = inspect({ host: { Binds: [`/srv/alt-worktrees/${GID}:/work`] } });
		expect(containerViolations(alt, "published_loopback", { SUBSTRATE_WORKTREE_ROOTS: "/srv/alt-worktrees" })).toEqual([]);
		expect(containerViolations(alt, "published_loopback", {}).map((v) => v.split(":")[0])).toEqual(["writable_bind"]);
	});

	test("on internal, a NetworkMode other than substrate-sandbox or any PortBindings entry is one network_mode violation; published_loopback ignores NetworkMode", () => {
		const bridged = inspect({ host: { PortBindings: {}, NetworkMode: "bridge" } });
		expect(containerViolations(bridged, "internal")).toEqual(["network_mode:bridge"]);
		const published = inspect({ host: { NetworkMode: SANDBOX_NETWORK } }); // still has the 127.0.0.1 binding
		expect(containerViolations(published, "internal").map((v) => v.split(":")[0])).toEqual(["network_mode"]);
		expect(containerViolations(inspect({ host: { NetworkMode: "host" } }), "published_loopback")).toEqual([]);
	});

	test("a container with several faults reports each once, and a Mounts-only inspect (no Binds) still finds the socket", () => {
		const bad = inspect({
			host: {
				Privileged: true,
				Binds: ["/var/run/docker.sock:/var/run/docker.sock", "/etc/substrate:/etc/substrate"],
				PortBindings: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] },
			},
			config: { Cmd: ["server", "--no-token"] },
			labels: null,
		});
		expect(containerViolations(bad, "published_loopback").map((v) => v.split(":")[0]).sort()).toEqual(
			["docker_sock", "label", "port_binding", "privileged", "token", "writable_bind"].sort(),
		);
		const mountsOnly = inspect({ host: { Binds: null } });
		mountsOnly.Mounts = [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false }];
		expect(containerViolations(mountsOnly, "published_loopback").map((v) => v.split(":")[0])).toEqual(["docker_sock"]);
	});
});

describe("secretKey", () => {
	test("true for an underscore-delimited secret segment, false for names that only contain one inside a word", () => {
		for (const name of [
			"LINEAR_API_KEY",
			"NOTION_API_KEY",
			"SUBSTRATE_APPROVAL_BOT_TOKEN",
			"SUBSTRATE_VM_ANTHROPIC_API_KEY",
			"SUBSTRATE_TOKEN_CLAUDE_CODE",
			"GITHUB_PAT",
			"WEBHOOK_SECRET",
			"X_KEYS",
			"X_TOKENS",
			"X_SECRETS",
			"DB_PASSWORD",
			"DB_PASSWD",
			"AWS_CREDENTIAL",
			"AWS_CREDENTIALS",
			"SSH_PRIVATE",
			"SESSION_COOKIE",
		]) {
			expect(secretKey(name), name).toBe(true);
		}
		for (const name of ["NOTION_TASK_GRAPH_DS", "SUBSTRATE_DISPATCH_DISABLED", "SUBSTRATE_APPROVAL_CHAT_ID", "SUBSTRATE_APPROVAL_USER_IDS", "PATH", "HOME", "KEYSTONE", "MYTOKEN", ""]) {
			expect(secretKey(name), name).toBe(false);
		}
	});
});

describe("secretHits", () => {
	test("counts every occurrence of each value, ignores values shorter than 12 characters and keys the result by label only", () => {
		const data = new TextEncoder().encode("xx lin_api_0123456789abc yy lin_api_0123456789abc zz ntn_9876543210zz shortval");
		const hits = secretHits(data, [
			{ label: "LINEAR_API_KEY", value: "lin_api_0123456789abc" },
			{ label: "NOTION_API_KEY", value: "ntn_9876543210zz" },
			{ label: "ABSENT_TOKEN", value: "not-in-the-data-at-all" },
			{ label: "SHORT_KEY", value: "shortval" },
		]);
		expect(hits).toEqual({ LINEAR_API_KEY: 2, NOTION_API_KEY: 1, ABSENT_TOKEN: 0 });
		expect(JSON.stringify(hits)).not.toContain("lin_api_");
	});

	test("a value at the very end of the buffer and overlapping repeats are counted without double counting", () => {
		const data = new TextEncoder().encode("aaaaaaaaaaaaaaaaaaaaaaaa"); // 24 a's
		expect(secretHits(data, [{ label: "A_KEY", value: "aaaaaaaaaaaa" }])).toEqual({ A_KEY: 2 });
		const tail = new TextEncoder().encode("prefix-then-secretvalue123");
		expect(secretHits(tail, [{ label: "T_KEY", value: "secretvalue123" }])).toEqual({ T_KEY: 1 });
	});
});

describe("auditTotals", () => {
	test("total sums only unsanctioned labels; sanctioned labels are reported by name and an absent sanctioned name reads 0", () => {
		const hits = { LINEAR_API_KEY: 0, NOTION_API_KEY: 3, SUBSTRATE_VM_ANTHROPIC_API_KEY: 5 };
		expect(auditTotals(hits, ["SUBSTRATE_VM_ANTHROPIC_API_KEY"])).toEqual({ total: 3, sanctioned: { SUBSTRATE_VM_ANTHROPIC_API_KEY: 5 } });
		expect(auditTotals(hits, [])).toEqual({ total: 8, sanctioned: {} });
		expect(auditTotals({ LINEAR_API_KEY: 1 }, ["SUBSTRATE_VM_ANTHROPIC_API_KEY"])).toEqual({ total: 1, sanctioned: { SUBSTRATE_VM_ANTHROPIC_API_KEY: 0 } });
	});
});

describe("formatAudit", () => {
	test("prints only key=value lines of names, modes and integers, never a scanned value", () => {
		const lines = formatAudit({
			storageMode: "700",
			secretHits: { LINEAR_API_KEY: 0, NOTION_API_KEY: 0, SUBSTRATE_VM_ANTHROPIC_API_KEY: 2 },
			configHits: { NOTION_TASK_GRAPH_DS: 4, INVOCATION_ID: 0 },
			sanctioned: ["SUBSTRATE_VM_ANTHROPIC_API_KEY"],
			containers: [
				{ id: "5efaf37c2690abcdef", violations: [] },
				{ id: "0123456789abcdef", violations: ["privileged", "writable_bind:/etc/substrate:/etc/substrate"] },
			],
		});
		expect(lines).toEqual([
			"storage_mode=700",
			"secret_keys=LINEAR_API_KEY,NOTION_API_KEY",
			"secret_hits_LINEAR_API_KEY=0",
			"secret_hits_NOTION_API_KEY=0",
			"secret_hits_total=0",
			"sanctioned_keys=SUBSTRATE_VM_ANTHROPIC_API_KEY",
			"sanctioned_hits_SUBSTRATE_VM_ANTHROPIC_API_KEY=2",
			"config_keys=INVOCATION_ID,NOTION_TASK_GRAPH_DS",
			"config_hits_INVOCATION_ID=0",
			"config_hits_NOTION_TASK_GRAPH_DS=4",
			"config_hits_total=4",
			"containers_inspected=2",
			"container_violation=0123456789ab:privileged",
			"container_violation=0123456789ab:writable_bind:/etc/substrate:/etc/substrate",
			"container_violations=2",
		]);
		for (const line of lines) expect(line).toMatch(/^[a-z_]+(?:_[A-Z0-9_]+)?=[^\s]*$/);
	});

	test("nothing sanctioned and no config keys print none; no containers print 0", () => {
		const lines = formatAudit({ storageMode: "700", secretHits: { LINEAR_API_KEY: 0 }, configHits: {}, sanctioned: [], containers: [] });
		expect(lines).toContain("sanctioned_keys=none");
		expect(lines).toContain("config_keys=none");
		expect(lines).toContain("config_hits_total=0");
		expect(lines).toContain("containers_inspected=0");
		expect(lines).toContain("container_violations=0");
		expect(lines.filter((l) => l.startsWith("sanctioned_hits_"))).toEqual([]);
	});
});
