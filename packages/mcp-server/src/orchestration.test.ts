import { describe, expect, test } from "bun:test";
import {
	DelegationQueue,
	LeaderFence,
	agentNamespace,
	buildDelegation,
	checkDelegationPermission,
	recordDelegationAudit,
	type Delegation,
	type DelegationAuditPort,
} from "./orchestration.ts";
import type { RepoAllowlist } from "./repo-allowlist.ts";

const NOW = Date.parse("2026-11-28T12:00:00Z");

function allowlist(entries: Array<[string, string[]]>): RepoAllowlist {
	return new Map(entries.map(([session, repos]) => [session, new Map(repos.map((repo) => [repo, `CRED_${session}_${repo}`]))]));
}

describe("agentNamespace", () => {
	test("namespaces a surface as agent:<surface>", () => {
		expect(agentNamespace("claude-code")).toBe("agent:claude-code");
		expect(agentNamespace("grok-bot")).toBe("agent:grok-bot");
	});
});

describe("checkDelegationPermission", () => {
	const grants = allowlist([
		["sess-a", ["acme/app"]],
		["sess-b", ["acme/app"]],
		["sess-c", ["acme/other"]],
	]);

	test("allows when both sessions are granted the repo", () => {
		expect(checkDelegationPermission(grants, "sess-a", "sess-b", "acme/app")).toEqual({ ok: true });
	});

	test("denies when the sender has no grant", () => {
		expect(checkDelegationPermission(grants, "sess-c", "sess-b", "acme/app")).toEqual({ ok: false, reason: "not-allowed" });
	});

	test("denies when the receiver has no grant", () => {
		expect(checkDelegationPermission(grants, "sess-a", "sess-c", "acme/app")).toEqual({ ok: false, reason: "not-allowed" });
	});

	test("denies an unknown session for an unknown repo", () => {
		expect(checkDelegationPermission(grants, "sess-a", "sess-zz", "nope/repo")).toEqual({ ok: false, reason: "not-allowed" });
	});

	test("empty allowlist grants nothing", () => {
		expect(checkDelegationPermission(new Map(), "sess-a", "sess-b", "acme/app")).toEqual({ ok: false, reason: "empty-allowlist" });
	});
});

describe("buildDelegation + audit", () => {
	function delegation(): Delegation {
		return buildDelegation({
			from: { surface: "claude-code", session_id: "sess-a" },
			to_surface: "grok-bot",
			to_session: "sess-b",
			goal: "port login to grok",
			files: ["src/login.ts"],
			dod: ["tests green"],
			repo: "acme/app",
		});
	}

	test("packet carries the receiver and the sender namespace", () => {
		const d = delegation();
		expect(d.namespace).toBe("agent:claude-code");
		expect(d.to_session).toBe("sess-b");
		expect(d.repo).toBe("acme/app");
		expect(d.packet.from).toEqual({ surface: "claude-code", session_id: "sess-a" });
		expect(d.packet.to).toEqual({ surface: "grok-bot", session_id: "sess-b" });
		expect(d.packet.goal).toBe("port login to grok");
		expect(d.packet.files).toEqual(["src/login.ts"]);
	});
	test("one audit row per delegation through the port", async () => {
		const entries: unknown[] = [];
		const port: DelegationAuditPort = {
			appendAudit: (entry) => {
				entries.push(entry);
			},
		};
		const d = delegation();
		await recordDelegationAudit(port, d);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			namespace: "agent:claude-code",
			from_surface: "claude-code",
			from_session: "sess-a",
			to_surface: "grok-bot",
			to_session: "sess-b",
			repo: "acme/app",
			handoff_id: d.packet.handoff_id,
		});
	});
});

describe("LeaderFence", () => {
	test("first acquire grants epoch 1 and a fresh token passes", async () => {
		const fence = new LeaderFence();
		const acquired = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) throw new Error("unreachable");
		expect(acquired.action).toBe("granted");
		expect(acquired.token.epoch).toBe(1);
		expect(acquired.token.lease_id.startsWith("lse_")).toBe(true);
		expect(fence.assertFresh(acquired.token)).toEqual({ ok: true });
		const write = await fence.fencedWrite(acquired.token, () => "wrote");
		expect(write).toEqual({ ok: true, value: "wrote" });
	});

	test("a stranger is denied while held", () => {
		const fence = new LeaderFence();
		fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		expect(fence.acquire("sess-b", "grok-bot", "/repo/wt-a", NOW)).toEqual({ ok: false, reason: "held-not-holder" });
	});

	test("same holder re-acquire renews and keeps the epoch", () => {
		const fence = new LeaderFence();
		const first = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		const again = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW + 60_000);
		if (!first.ok || !again.ok) throw new Error("unreachable");
		expect(again.action).toBe("renewed");
		expect(again.token.epoch).toBe(first.token.epoch);
		expect(again.token.lease_id).toBe(first.token.lease_id);
	});

	test("renew extends the hold and keeps the epoch", () => {
		const fence = new LeaderFence();
		const acquired = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		if (!acquired.ok) throw new Error("unreachable");
		const renewed = fence.renew(acquired.token, NOW + 60_000);
		expect(renewed).toEqual({ ok: true, token: { ...acquired.token, observed_epoch: 1 }, action: "renewed" });
	});

	test("after TTL expiry a stranger's acquire bumps the epoch; the old token is not the holder", async () => {
		const fence = new LeaderFence();
		const first = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		if (!first.ok) throw new Error("unreachable");
		const late = NOW + 901_000;
		const stolen = fence.acquire("sess-b", "grok-bot", "/repo/wt-a", late);
		if (!stolen.ok) throw new Error("unreachable");
		expect(stolen.token.epoch).toBe(2);
		expect(fence.assertFresh(first.token)).toEqual({ ok: false, reason: "not-holder" });
		let ran = false;
		const write = await fence.fencedWrite(first.token, () => {
			ran = true;
			return "wrote";
		});
		expect(write).toEqual({ ok: false, reason: "not-holder" });
		expect(ran).toBe(false);
		expect(fence.assertFresh(stolen.token)).toEqual({ ok: true });
	});

	test("same holder re-acquiring after TTL bumps the epoch; the pre-expiry token is stale", async () => {
		const fence = new LeaderFence();
		const first = fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		if (!first.ok) throw new Error("unreachable");
		const late = NOW + 901_000;
		const reclaimed = fence.acquire("sess-a", "claude-code", "/repo/wt-a", late);
		if (!reclaimed.ok) throw new Error("unreachable");
		expect(reclaimed.action).toBe("reclaimed");
		expect(reclaimed.token.epoch).toBe(2);
		expect(fence.assertFresh(first.token)).toEqual({ ok: false, reason: "stale-epoch" });
		let ran = false;
		const write = await fence.fencedWrite(first.token, () => {
			ran = true;
			return "wrote";
		});
		expect(write).toEqual({ ok: false, reason: "stale-epoch" });
		expect(ran).toBe(false);
	});

	test("other worktrees are fenced independently", () => {
		const fence = new LeaderFence();
		fence.acquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		expect(fence.acquire("sess-b", "grok-bot", "/repo/wt-b", NOW).ok).toBe(true);
	});
});

describe("DelegationQueue", () => {
	const task = (id: string) => ({
		id,
		from_surface: "claude-code" as const,
		from_session: "sess-a",
		to_surface: "grok-bot" as const,
		to_session: "sess-b",
		repo: "acme/app",
		goal: `goal ${id}`,
	});

	test("enqueue stamps the default 900s TTL and dequeue takes ready tasks FIFO", () => {
		const queue = new DelegationQueue();
		const first = queue.enqueue(task("t1"), { now: NOW });
		expect(first.ttl_seconds).toBe(900);
		expect(first.expires_at).toBe(NOW + 900_000);
		queue.enqueue(task("t2"), { now: NOW + 1 });
		expect(queue.pendingCount()).toBe(2);
		const ready = queue.dequeue(NOW + 2);
		expect(ready.map((entry) => entry.id)).toEqual(["t1", "t2"]);
		expect(queue.pendingCount()).toBe(0);
	});

	test("expired entries move to the dead-letter list, never silently dropped", () => {
		const queue = new DelegationQueue();
		queue.enqueue(task("t1"), { now: NOW });
		queue.enqueue(task("t2"), { now: NOW });
		expect(queue.dequeue(NOW + 901_000)).toEqual([]);
		expect(queue.pendingCount()).toBe(0);
		expect(queue.deadCount()).toBe(2);
		const dead = queue.listDead();
		expect(dead.map((entry) => entry.task.id)).toEqual(["t1", "t2"]);
		expect(dead.every((entry) => entry.reason === "ttl-expired")).toBe(true);
		expect(dead[0]?.dead_at).toBe(NOW + 901_000);
	});

	test("failed entries land in the dead-letter list with a reason", () => {
		const queue = new DelegationQueue();
		queue.enqueue(task("t1"), { now: NOW });
		queue.enqueue(task("t2"), { now: NOW });
		expect(queue.fail("t1", "receiver down", NOW + 5)).toBe(true);
		expect(queue.fail("missing", "nope", NOW + 5)).toBe(false);
		expect(queue.listDead()).toEqual([
			{ task: expect.objectContaining({ id: "t1" }), reason: "failed", dead_at: NOW + 5, detail: "receiver down" },
		]);
		expect(queue.dequeue(NOW + 6).map((entry) => entry.id)).toEqual(["t2"]);
		expect(queue.deadCount()).toBe(1);
	});

	test("duplicate ids are refused", () => {
		const queue = new DelegationQueue();
		queue.enqueue(task("t1"), { now: NOW });
		expect(() => queue.enqueue(task("t1"), { now: NOW })).toThrow("duplicate delegation task: t1");
	});
});
