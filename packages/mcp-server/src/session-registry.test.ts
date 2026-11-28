import { describe, expect, test } from "bun:test";
import {
	SessionRegistry,
	buildSessionRegistry,
	detectSessionConflicts,
	registryRelease,
	registryTake,
	type RegistryRows,
} from "./session-registry.ts";
import { NO_LEASE, type LeaseSnapshot } from "./lease.ts";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const TTL_MS = 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function rows(overrides: Partial<RegistryRows> = {}): RegistryRows {
	return {
		nodes: [],
		bindings: [],
		worktrees: [],
		...overrides,
	};
}

describe("buildSessionRegistry", () => {
	test("joins binding, held lease, and fresh worktree for one session", () => {
		const entries = buildSessionRegistry(
			rows({
				bindings: [{ session_id: "sess-1", owner_surface: "hermes", repo_id: "someorg/repo", expires_at: iso(NOW + 600_000), closed_at: null }],
				nodes: [
					{
						graph_id: "g-1",
						node_id: "n-1",
						claimed_by: "hermes",
						claim_session: "sess-1",
						claimed_at: iso(NOW - 60_000),
						lease_expires_at: iso(NOW + 600_000),
						lease_heartbeat_at: iso(NOW - 10_000),
						lease_epoch: 3,
					},
				],
				worktrees: [
					{
						host: "h1",
						path: "/repo/wt-a",
						repo: "someorg/repo",
						branch: "feat",
						session_id: "sess-1",
						graph_id: "g-1",
						last_seen_at: iso(NOW - 1_000),
						files: ["b.ts", "a.ts"],
						files_truncated: false,
					},
				],
			}),
			NOW,
			{ worktreeTtlMs: TTL_MS },
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			session_id: "sess-1",
			surface: "hermes",
			repo: "someorg/repo",
			worktree_path: "/repo/wt-a",
			graph_id: "g-1",
			node_id: "n-1",
			lease_state: "held",
			epoch: 3,
			files: ["a.ts", "b.ts"],
			files_truncated: false,
		});
		expect("lease_id" in (entries[0] as unknown as Record<string, unknown>)).toBe(false);
	});

	test("excludes expired binding, free lease, and stale worktree", () => {
		const now = NOW;
		const entries = buildSessionRegistry(
			rows({
				bindings: [
					// Expired: not live.
					{ session_id: "sess-dead", owner_surface: "hermes", repo_id: "r", expires_at: iso(now - 1_000), closed_at: null },
					// Closed: not live even if unexpired.
					{ session_id: "sess-closed", owner_surface: "hermes", repo_id: "r", expires_at: iso(now + 60_000), closed_at: iso(now - 1_000) },
					// PAUSED still counts: `state` is not a liveness filter.
					{ session_id: "sess-paused", owner_surface: "hermes", repo_id: "r", expires_at: iso(now + 60_000), closed_at: null },
				],
				nodes: [
					// Lapsed lease: read as free, does not make the session live.
					{
						graph_id: "g-1",
						node_id: "n-1",
						claimed_by: "hermes",
						claim_session: "sess-lapsed",
						claimed_at: iso(now - 10_000),
						lease_expires_at: iso(now - 1_000),
						lease_heartbeat_at: iso(now - 10_000),
						lease_epoch: 1,
					},
				],
				worktrees: [
					// Stale report: outside the TTL window.
					{
						host: "h1",
						path: "/repo/wt-stale",
						repo: "r",
						branch: null,
						session_id: "sess-stale",
						graph_id: null,
						last_seen_at: iso(now - TTL_MS - 1),
						files: null,
						files_truncated: false,
					},
				],
			}),
			now,
			{ worktreeTtlMs: TTL_MS },
		);
		expect(entries.map((entry) => entry.session_id)).toEqual(["sess-paused"]);
	});

	test("sorts entries deterministically", () => {
		const bindings = ["sess-b", "sess-a"].map((session_id) => ({ session_id, owner_surface: "hermes", repo_id: "r", expires_at: iso(NOW + 60_000), closed_at: null }));
		const first = buildSessionRegistry(rows({ bindings }), NOW, { worktreeTtlMs: TTL_MS });
		const second = buildSessionRegistry(rows({ bindings: [...bindings].reverse() }), NOW, { worktreeTtlMs: TTL_MS });
		expect(first.map((entry) => entry.session_id)).toEqual(["sess-a", "sess-b"]);
		expect(second.map((entry) => entry.session_id)).toEqual(["sess-a", "sess-b"]);
	});

	test("an unowned unreported worktree attributes nobody", () => {
		const entries = buildSessionRegistry(
			rows({
				worktrees: [
					{ host: "h1", path: "/repo/wt", repo: "r", branch: null, session_id: null, graph_id: null, last_seen_at: iso(NOW), files: [], files_truncated: false },
				],
			}),
			NOW,
			{ worktreeTtlMs: TTL_MS },
		);
		expect(entries).toEqual([]);
	});
});

describe("detectSessionConflicts", () => {
	const entry = (session_id: string, files: string[]) => ({
		session_id,
		surface: "hermes" as const,
		repo: "r",
		worktree_path: "/wt",
		graph_id: null,
		node_id: null,
		lease_state: null,
		epoch: null,
		expires_at: null,
		files,
		files_truncated: false,
	});

	test("names a (worktree, file) two live sessions touch, sorted", () => {
		const conflicts = detectSessionConflicts([entry("sess-b", ["a.ts", "b.ts"]), entry("sess-a", ["b.ts", "c.ts"])]);
		expect(conflicts).toEqual([{ worktree_path: "/wt", file: "b.ts", session_ids: ["sess-a", "sess-b"] }]);
	});

	test("one session touching a file twice is no conflict", () => {
		expect(detectSessionConflicts([entry("sess-a", ["a.ts"]), entry("sess-a", ["a.ts"])])).toEqual([]);
	});

	test("a file nobody lists never conflicts", () => {
		expect(detectSessionConflicts([entry("sess-a", []), entry("sess-b", [])])).toEqual([]);
	});
});

describe("SessionRegistry", () => {
	test("serves last-known degraded when the store fails; cold start is empty degraded", async () => {
		let down = false;
		const store = {
			async snapshot(): Promise<RegistryRows> {
				if (down) throw new Error("index down");
				return rows({
					bindings: [{ session_id: "sess-1", owner_surface: "hermes", repo_id: "r", expires_at: iso(NOW + 60_000), closed_at: null }],
				});
			},
		};
		const registry = new SessionRegistry(store, { worktreeTtlMs: TTL_MS });
		const ok = await registry.current(NOW);
		expect(ok.degraded).toBe(false);
		expect(ok.entries.map((entry) => entry.session_id)).toEqual(["sess-1"]);

		down = true;
		const degraded = await registry.current(NOW);
		expect(degraded.degraded).toBe(true);
		expect(degraded.entries.map((entry) => entry.session_id)).toEqual(["sess-1"]);

		const cold = await new SessionRegistry(store, { worktreeTtlMs: TTL_MS }).current(NOW);
		expect(cold.degraded).toBe(true);
		expect(cold.entries).toEqual([]);
	});
});

describe("operator lease helpers", () => {
	const held: LeaseSnapshot = {
		lease_id: "lse_abc",
		surface: "hermes",
		session_id: "sess-1",
		claimed_at: iso(NOW - 60_000),
		heartbeat_at: iso(NOW),
		expires_at: iso(NOW + 600_000),
		epoch: 3,
	};

	test("registryTake renews for the holder and denies a stranger's surface", () => {
		const holder = registryTake(held, { surface: "hermes", session_id: "sess-1" }, "hermes", NOW);
		expect(holder.granted).toBe(true);
		expect(holder.action).toBe("renewed");
		const stranger = registryTake(held, { surface: "hermes", session_id: "sess-1" }, "claude-code", NOW);
		expect(stranger.granted).toBe(false);
		expect(stranger.reason).toBe("not-holder");
	});

	test("registryRelease needs the holder's lease id; the holder is accepted", () => {
		const missing = registryRelease(held, {}, "hermes", NOW);
		expect(missing.ok).toBe(false);
		expect("reason" in missing && missing.reason).toBe("lease-id-required");
		const released = registryRelease(held, { lease_id: "lse_abc" }, "hermes", NOW);
		expect(released.ok).toBe(true);
		const stranger = registryRelease(held, { lease_id: "lse_abc" }, "claude-code", NOW);
		expect(stranger.ok).toBe(false);
		expect("reason" in stranger && stranger.reason).toBe("not-holder");
	});

	test("a released node has nothing to hold", () => {
		const decision = registryRelease(NO_LEASE, {}, null, NOW);
		expect(decision.ok).toBe(true);
	});
});
