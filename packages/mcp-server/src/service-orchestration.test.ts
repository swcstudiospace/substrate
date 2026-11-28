/**
 * E4/E7 orchestration wiring (phase 85) over fakes: a ledger stub that records
 * what reached the log, an index stub standing in for the graph reads. No
 * network, no clock beyond explicit `now` values.
 *
 * What must hold: a granted delegation stores one handoff event plus one
 * audit note carrying the `agent:<surface>` namespace; a denied delegation
 * stores nothing; expired queue entries surface in `deadLetters()` with the
 * count; the fence acquire/renew/stale-reject round-trip audits on acquire.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent, Surface } from "./types.ts";

const NOW = Date.parse("2026-11-28T12:00:00Z");

const GRANTS: Record<string, string | undefined> = {
	SUBSTRATE_REPO_ALLOWLIST: JSON.stringify({
		"sess-a": { "acme/app": "CRED_A" },
		"sess-b": { "acme/app": "CRED_B" },
	}),
};

function stubSubstrate() {
	const emitted: SubstrateEvent[] = [];
	const index = {
		getGraph: async () => null,
		claimNode: async () => ({ claimed: false }),
		releaseNode: async () => ({ released: false }),
	};
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });
	return { emitted, substrate };
}

const delegationInput = {
	from: { surface: "claude-code" as Surface, session_id: "sess-a" },
	to_surface: "grok-bot" as Surface,
	to_session: "sess-b",
	goal: "port login to grok",
	files: ["src/login.ts"],
	dod: ["tests green"],
	repo: "acme/app",
};

describe("delegateHandoff", () => {
	test("granted delegation stores one handoff event and one audit note with the namespace", async () => {
		const { emitted, substrate } = stubSubstrate();
		const reply = await substrate.delegateHandoff(delegationInput, GRANTS);
		expect(reply.ok).toBe(true);
		if (!reply.ok) throw new Error("unreachable");
		expect(reply.namespace).toBe("agent:claude-code");
		expect(reply.stored).toBe(true);
		expect(reply.packet.to).toEqual({ surface: "grok-bot", session_id: "sess-b" });
		expect(emitted).toHaveLength(2);
		expect(emitted[0]?.kind).toBe("handoff");
		expect(emitted[1]?.kind).toBe("note");
		const payload = emitted[1]?.payload as { delegation?: Record<string, unknown> } | undefined;
		expect(payload?.delegation?.namespace).toBe("agent:claude-code");
		expect(payload?.delegation?.to_session).toBe("sess-b");
		expect(payload?.delegation?.repo).toBe("acme/app");
		expect(payload?.delegation?.handoff_id).toBe(reply.packet.handoff_id);
	});

	test("denied delegation stores nothing", async () => {
		const { emitted, substrate } = stubSubstrate();
		const reply = await substrate.delegateHandoff({ ...delegationInput, to_session: "sess-zz" }, GRANTS);
		expect(reply).toEqual({ ok: false, reason: "not-allowed" });
		expect(emitted).toHaveLength(0);
	});

	test("empty allowlist denies every delegation", async () => {
		const { emitted, substrate } = stubSubstrate();
		const reply = await substrate.delegateHandoff(delegationInput, {});
		expect(reply).toEqual({ ok: false, reason: "empty-allowlist" });
		expect(emitted).toHaveLength(0);
	});
});

describe("delegation queue + dead letters", () => {
	const task = (id: string) => ({
		id,
		from_surface: "claude-code" as Surface,
		from_session: "sess-a",
		to_surface: "grok-bot" as Surface,
		to_session: "sess-b",
		repo: "acme/app",
		goal: `goal ${id}`,
	});

	test("expired entries surface in queueDeadLetters with the count", () => {
		const { substrate } = stubSubstrate();
		substrate.enqueueDelegation(task("t1"), { now: NOW });
		substrate.enqueueDelegation(task("t2"), { now: NOW });
		expect(substrate.dequeueDelegations(NOW + 2).map((entry) => entry.id)).toEqual(["t1", "t2"]);
		substrate.enqueueDelegation(task("t3"), { now: NOW });
		expect(substrate.dequeueDelegations(NOW + 901_000)).toEqual([]);
		const surface = substrate.queueDeadLetters();
		expect(surface.dead_count).toBe(1);
		expect(surface.dead_letters).toHaveLength(1);
		expect(surface.dead_letters[0]?.task.id).toBe("t3");
		expect(surface.dead_letters[0]?.reason).toBe("ttl-expired");
	});
});

describe("fence acquire/renew/stale-reject", () => {
	test("acquire audits once, renew keeps the epoch, a stale write is rejected", async () => {
		const { emitted, substrate } = stubSubstrate();
		const acquired = await substrate.fenceAcquire("sess-a", "claude-code", "/repo/wt-a", NOW);
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) throw new Error("unreachable");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("note");
		const renewed = substrate.fenceRenew(acquired.token, NOW + 60_000);
		if (!renewed.ok) throw new Error("unreachable");
		expect(renewed.token.epoch).toBe(acquired.token.epoch);
		const denied = await substrate.fenceAcquire("sess-b", "grok-bot", "/repo/wt-a", NOW + 60_000);
		expect(denied).toEqual({ ok: false, reason: "held-not-holder" });
		let ran = false;
		const write = await substrate.fenceWrite({ ...acquired.token, epoch: 0 }, () => {
			ran = true;
			return "wrote";
		});
		expect(write.ok).toBe(false);
		expect(ran).toBe(false);
	});
});
