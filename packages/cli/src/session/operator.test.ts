/**
 * `substrate session operator|conflicts` (phase 83, E1): grammar, exit codes and output through `runSession`
 * with a fake registry client (fakes only, never the network).
 */
import { describe, expect, test } from "bun:test";
import { EXIT_DONE, EXIT_FAILED, EXIT_REFUSED, EXIT_USAGE, type SessionDeps, parseSessionArgs, runSession } from "./command.ts";
import { RegistryMcpError, type OperatorOutcome, type SessionRegistryClient, type RegistrySnapshot } from "./registry-client.ts";
import { FakeTranscript, seededRandomBytes } from "./testkit.ts";

const SESSION = "sess-1";

interface FakeRegistry extends SessionRegistryClient {
	snapshotValue: RegistrySnapshot;
	takeValue: OperatorOutcome;
	releaseValue: OperatorOutcome;
	takes: Array<{ graph_id: string; node_id: string; session_id: string; surface: string }>;
	releases: Array<{ graph_id: string; node_id: string; lease_id: string }>;
	snapshotError?: Error;
}

function fakeRegistry(): FakeRegistry {
	const fake: FakeRegistry = {
		takes: [],
		releases: [],
		snapshotValue: { entries: [], conflicts: [], as_of: "2026-11-28T12:00:00Z", degraded: false },
		takeValue: { claimed: true, lease_id: "lse_first", action: "granted", reason: null, holder: SESSION },
		releaseValue: { released: true, ok: true, lease_id: "lse_first", action: "released", reason: null, holder: SESSION },
		async take(input) {
			this.takes.push(input);
			return this.takeValue;
		},
		async release(input) {
			this.releases.push(input);
			return this.releaseValue;
		},
		async snapshot() {
			if (this.snapshotError !== undefined) throw this.snapshotError;
			return this.snapshotValue;
		},
	};
	return fake;
}

interface Rig {
	registry: FakeRegistry;
	out: string[];
	err: string[];
	deps: SessionDeps;
}

function rig(): Rig {
	const registry = fakeRegistry();
	const dir = "/tmp/fake-worktree";
	const out: string[] = [];
	const err: string[] = [];
	const deps: SessionDeps = {
		worktree: dir,
		url: "http://127.0.0.1:7410",
		tokenFor: () => "tok",
		timeoutMs: 1500,
		now: () => new Date("2026-11-28T12:00:00Z"),
		randomBytes: seededRandomBytes(5),
		transcript: new FakeTranscript(),
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		registry,
		home: "/home/someone",
	};
	return { registry, out, err, deps };
}

const text = (lines: string[]): string => lines.join("");

async function session(r: Rig, ...argv: string[]): Promise<number> {
	return runSession(argv, r.deps);
}

function entry(session_id: string, graph_id: string | null, node_id: string | null, worktree_path: string | null, files: string[]) {
	return {
		session_id,
		surface: "claude-code" as const,
		repo: "someorg/repo",
		worktree_path,
		graph_id,
		node_id,
		lease_state: "held" as const,
		epoch: 3,
		expires_at: "2026-11-28T12:10:00Z",
		files,
		files_truncated: false,
	};
}

describe("session operator", () => {
	test("parse accepts operator with take and conflicts with graph", () => {
		const operator = parseSessionArgs(["operator", "--session", SESSION, "--surface", "claude-code", "--graph", "g-1", "--node", "n-1", "--take"]);
		expect(typeof operator).toBe("object");
		expect(typeof parseSessionArgs(["conflicts", "--graph", "g-1"])).toBe("object");
		expect(parseSessionArgs(["operator", "--bogus"])).toContain("unknown flag");
	});

	test("take with --graph/--node prints the holder's lease id", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--surface", "claude-code", "--graph", "g-1", "--node", "n-1", "--take");
		expect(code).toBe(EXIT_DONE);
		expect(r.registry.takes).toEqual([{ graph_id: "g-1", node_id: "n-1", session_id: SESSION, surface: "claude-code" }]);
		expect(text(r.out)).toContain("operator g-1/n-1: granted");
		expect(text(r.out)).toContain("lease lse_first");
	});

	test("release without --lease refuses instead of sending a doomed call", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--release", "--graph", "g-1", "--node", "n-1");
		expect(code).toBe(EXIT_REFUSED);
		expect(r.registry.releases).toHaveLength(0);
		expect(text(r.err)).toContain("lease-id-required");
	});

	test("release with --lease sends the lease id", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--release", "--graph", "g-1", "--node", "n-1", "--lease", "lse_first");
		expect(code).toBe(EXIT_DONE);
		expect(r.registry.releases).toEqual([{ graph_id: "g-1", node_id: "n-1", lease_id: "lse_first" }]);
		expect(text(r.out)).toContain("operator g-1/n-1: released");
	});

	test("both --take and --release is a usage error", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--take", "--release");
		expect(code).toBe(EXIT_USAGE);
		expect(text(r.err)).toContain("exactly one of --take or --release");
	});

	test("neither --take nor --release is a usage error", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--graph", "g-1", "--node", "n-1");
		expect(code).toBe(EXIT_USAGE);
	});

	test("a denied claim (held by another) exits refused", async () => {
		const r = rig();
		r.registry.takeValue = { claimed: false, lease_id: null, action: "denied", reason: null, holder: "sess-other" };
		const code = await session(r, "operator", "--session", SESSION, "--graph", "g-1", "--node", "n-1", "--take");
		expect(code).toBe(EXIT_REFUSED);
		expect(text(r.out)).toContain("refused g-1/n-1: denied");
		expect(text(r.out)).toContain("holder sess-other");
	});

	test("an unreachable registry exits failed", async () => {
		const r = rig();
		r.registry.snapshotError = new RegistryMcpError("unreachable", "the substrate did not answer session_registry: fetch failed");
		const code = await session(r, "operator", "--session", SESSION, "--take");
		expect(code).toBe(EXIT_FAILED);
	});

	test("without graph flags, operator takes all attributed held nodes", async () => {
		const r = rig();
		r.registry.snapshotValue = {
			entries: [
				entry(SESSION, "g-1", "n-1", "/wt", ["a.ts"]),
				entry(SESSION, "g-1", "n-2", "/wt", ["a.ts"]),
				entry("sess-other", "g-1", "n-3", "/wt", ["a.ts"]),
				entry(SESSION, null, null, "/wt", []),
			],
			conflicts: [],
			as_of: "2026-11-28T12:00:00Z",
			degraded: false,
		};
		const code = await session(r, "operator", "--session", SESSION, "--take");
		expect(code).toBe(EXIT_DONE);
		expect(r.registry.takes.map((take) => `${take.graph_id}/${take.node_id}`)).toEqual(["g-1/n-1", "g-1/n-2"]);
	});

	test("no attributed node refuses instead of calling the server blindly", async () => {
		const r = rig();
		const code = await session(r, "operator", "--session", SESSION, "--take");
		expect(code).toBe(EXIT_REFUSED);
		expect(r.registry.takes).toHaveLength(0);
		expect(text(r.err)).toContain("no held node is attributed");
	});

	test("without a registry client, operator refuses", async () => {
		const r = rig();
		r.deps.registry = undefined;
		const code = await session(r, "operator", "--session", SESSION, "--graph", "g-1", "--node", "n-1", "--take");
		expect(code).toBe(EXIT_REFUSED);
	});
});

describe("session conflicts", () => {
	test("prints conflicts sorted, read-only", async () => {
		const r = rig();
		r.registry.snapshotValue = {
			entries: [
				entry("sess-a", "g-1", "n-1", "/wt", ["b.ts", "a.ts"]),
				entry("sess-b", "g-1", "n-2", "/wt", ["b.ts", "c.ts"]),
			],
			conflicts: [{ worktree_path: "/wt", file: "b.ts", session_ids: ["sess-a", "sess-b"] }],
			as_of: "2026-11-28T12:00:00Z",
			degraded: false,
		};
		const code = await session(r, "conflicts");
		expect(code).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("conflict /wt b.ts sessions sess-a,sess-b");
	});

	test("--json carries the conflicts and the degraded flag", async () => {
		const r = rig();
		r.registry.snapshotValue = {
			entries: [],
			conflicts: [{ worktree_path: "/wt", file: "a.ts", session_ids: ["sess-a", "sess-b"] }],
			as_of: "2026-11-28T12:00:00Z",
			degraded: true,
		};
		const code = await session(r, "conflicts", "--json");
		expect(code).toBe(EXIT_DONE);
		const parsed = JSON.parse(text(r.out).trim()) as { degraded: boolean; conflicts: unknown[] };
		expect(parsed.degraded).toBe(true);
		expect(parsed.conflicts).toHaveLength(1);
	});

	test("--graph filters to that graph's worktrees", async () => {
		const r = rig();
		r.registry.snapshotValue = {
			entries: [
				entry("sess-a", "g-1", "n-1", "/wt1", ["a.ts"]),
				entry("sess-b", "g-2", "n-1", "/wt2", ["a.ts"]),
			],
			conflicts: [
				{ worktree_path: "/wt1", file: "a.ts", session_ids: ["sess-a", "sess-x"] },
				{ worktree_path: "/wt2", file: "a.ts", session_ids: ["sess-b", "sess-y"] },
			],
			as_of: "2026-11-28T12:00:00Z",
			degraded: false,
		};
		const code = await session(r, "conflicts", "--graph", "g-2");
		expect(code).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("conflict /wt2 a.ts");
		expect(text(r.out)).not.toContain("/wt1");
	});

	test("no conflicts prints the empty line", async () => {
		const r = rig();
		const code = await session(r, "conflicts");
		expect(code).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("no conflicting files");
	});

	test("without a registry client, conflicts refuses", async () => {
		const r = rig();
		r.deps.registry = undefined;
		const code = await session(r, "conflicts");
		expect(code).toBe(EXIT_REFUSED);
	});
});
