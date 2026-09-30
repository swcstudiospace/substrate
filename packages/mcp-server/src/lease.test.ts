/**
 * The lease's one job: at most one holder at a time.
 *
 * The interesting tests here are not the unit checks on `decideClaim` — they are
 * the ones that race. `LeaseTable` below is a faithful stand-in for the row
 * `IndexStore` updates: it holds exactly the columns Postgres holds, and it
 * applies a decision only if the epoch it was taken against is still the epoch
 * on the row. That is the same compare-and-swap the SQL does, so a race that
 * two holders could both win here is one they could both win in production.
 *
 * The yield between read and write is the whole point. A store that read and
 * wrote in one synchronous step would never interleave in Bun's single-threaded
 * runtime, and the test would prove nothing.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LEASE_TTL_SECONDS,
	MAX_LEASE_TTL_SECONDS,
	MIN_LEASE_TTL_SECONDS,
	NO_LEASE,
	decideClaim,
	decideHeartbeat,
	decideRelease,
	leaseExpiry,
	leaseState,
	leaseView,
	newLeaseId,
	normalizeTtlSeconds,
	sameHolder,
	type ClaimDecision,
	type LeaseHolder,
	type LeaseSnapshot,
} from "./lease.ts";
import type { Surface } from "./types.ts";

/**
 * One node's lease row, with the same CAS discipline as the index.
 *
 * `clock` is explicit so expiry can be reached without waiting for it, and the
 * write path yields so that concurrent claims genuinely interleave.
 */
class LeaseTable {
	row: LeaseSnapshot = { ...NO_LEASE };
	now = Date.parse("2026-09-30T12:00:00.000Z");
	/** Every hold this node has ever had, in order — the transcript a test asserts on. */
	readonly history: Array<{ action: string; lease_id: string | null; holder: LeaseHolder | null }> = [];

	private async yieldOnce(): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	/** Read, decide, then apply only if nothing moved underneath — the real sequence. */
	async claim(holder: LeaseHolder, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS): Promise<ClaimDecision> {
		const observed = { ...this.row };
		const decision = decideClaim(observed, { ...holder, ttl_seconds: ttlSeconds }, this.now);
		await this.yieldOnce();
		if (!decision.granted) return decision;
		if (this.row.epoch !== decision.observed_epoch) {
			// Lost the race. Report what is true now rather than what was decided.
			return { ...decideClaim({ ...this.row }, { ...holder, ttl_seconds: ttlSeconds }, this.now), action: "denied", granted: false };
		}
		this.row = {
			lease_id: decision.lease_id,
			surface: holder.surface,
			session_id: holder.session_id,
			claimed_at: new Date(this.now).toISOString(),
			heartbeat_at: new Date(this.now).toISOString(),
			expires_at: new Date(this.now + decision.ttl_seconds * 1000).toISOString(),
			epoch: decision.epoch,
		};
		this.history.push({ action: decision.action, lease_id: decision.lease_id, holder });
		return decision;
	}

	async heartbeat(leaseId: string, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS) {
		const decision = decideHeartbeat({ ...this.row }, { lease_id: leaseId, ttl_seconds: ttlSeconds }, this.now);
		await this.yieldOnce();
		if (!decision.ok) return decision;
		if (this.row.lease_id !== leaseId) return { ok: false as const, reason: "lost" as const, holder: null, observed_expiry: null };
		this.row = {
			...this.row,
			heartbeat_at: new Date(this.now).toISOString(),
			expires_at: new Date(this.now + decision.ttl_seconds * 1000).toISOString(),
		};
		return decision;
	}

	async release(request: { lease_id?: string | null; force?: boolean }) {
		const decision = decideRelease({ ...this.row }, request, this.now);
		await this.yieldOnce();
		if (!decision.ok) return decision;
		if (this.row.epoch !== decision.observed_epoch) {
			return { ok: false as const, reason: "stale-lease" as const, holder: null, observed_epoch: this.row.epoch };
		}
		// The epoch is kept: it is monotonic per node, so a released node's next
		// claim cannot reuse a token a stale holder still remembers.
		this.row = { ...NO_LEASE, epoch: this.row.epoch };
		this.history.push({ action: decision.action, lease_id: decision.lease_id, holder: decision.evicted });
		return decision;
	}

	/** Who the table says holds it, as any other reader would see it. */
	holder(): LeaseHolder | null {
		return leaseState(this.row, this.now) === "held" ? leaseView(this.row, this.now).holder : null;
	}
}

function holder(surface: Surface, session: string): LeaseHolder {
	return { surface, session_id: session };
}

describe("exclusive hold", () => {
	test("two agents racing for the same node: exactly one holds it", async () => {
		// The proof the work order asks for, at the level where it can be raced:
		// n2 is free, grok-bot and hermes both go for it, and only one lease exists
		// afterwards.
		const node = new LeaseTable();

		const [a, b] = await Promise.all([
			node.claim(holder("grok-bot", "sess-grok")),
			node.claim(holder("hermes", "sess-hermes")),
		]);

		expect([a?.granted, b?.granted].filter(Boolean)).toHaveLength(1);
		const winner = a?.granted ? a : b;
		const loser = a?.granted ? b : a;
		expect(node.holder()).toEqual(winner?.holder ?? null);
		expect(loser?.action).toBe("denied");
		// The loser is told who has it, so it can pick up something else rather than spin.
		expect(loser?.holder).toEqual(winner?.holder ?? null);
		expect(node.history).toHaveLength(1);
	});

	test("eight agents racing for one node: one lease, seven refusals", async () => {
		const node = new LeaseTable();
		const surfaces: Surface[] = ["grok-bot", "hermes", "omp", "muse", "cursor", "codex", "opencode", "pi"];

		const results = await Promise.all(surfaces.map((surface, i) => node.claim(holder(surface, `sess-${i}`))));

		expect(results.filter((result) => result.granted)).toHaveLength(1);
		expect(node.history).toHaveLength(1);
		expect(new Set(results.map((result) => result.lease_id)).size).toBeGreaterThan(0);
		// Every refusal names the same holder: nobody is told a lie about who has it.
		const holders = results.filter((result) => !result.granted).map((result) => JSON.stringify(result.holder));
		expect(new Set(holders).size).toBe(1);
	});

	test("two sessions of the same surface are two holders", async () => {
		// The Phase 0 bug. `claimed_by = 'hermes'` matched both Hermes sessions, so
		// both were told they held the node and both started editing.
		const node = new LeaseTable();

		const first = await node.claim(holder("hermes", "sess-a"));
		const second = await node.claim(holder("hermes", "sess-b"));

		expect(first.granted).toBe(true);
		expect(second.granted).toBe(false);
		expect(second.action).toBe("denied");
		expect(second.holder).toEqual(holder("hermes", "sess-a"));
	});

	test("the holder re-claiming its own live lease keeps the same lease id", async () => {
		const node = new LeaseTable();
		const first = await node.claim(holder("hermes", "sess-a"));
		node.now += 60_000;

		const again = await node.claim(holder("hermes", "sess-a"));

		expect(again.action).toBe("renewed");
		expect(again.lease_id).toBe(first.lease_id);
		expect(again.epoch).toBe(first.epoch);
		// And the renewal pushed the expiry out.
		expect(leaseExpiry(node.row)).toBeGreaterThan(Date.parse(String(first.observed_expiry ?? 0)));
	});
});

describe("TTL and auto-release", () => {
	test("a lapsed lease reads as free to everyone else", async () => {
		const node = new LeaseTable();
		await node.claim(holder("grok-bot", "sess-grok"), 60);
		expect(node.holder()).toEqual(holder("grok-bot", "sess-grok"));

		node.now += 61_000;

		expect(leaseState(node.row, node.now)).toBe("expired");
		expect(node.holder()).toBeNull();
	});

	test("the next claimant takes over a lapsed lease and is told whose it was", async () => {
		const node = new LeaseTable();
		await node.claim(holder("grok-bot", "sess-grok"), 60);
		node.now += 61_000;

		const stolen = await node.claim(holder("hermes", "sess-hermes"));

		expect(stolen.action).toBe("stolen");
		expect(stolen.granted).toBe(true);
		expect(stolen.evicted).toEqual(holder("grok-bot", "sess-grok"));
		expect(node.holder()).toEqual(holder("hermes", "sess-hermes"));
	});

	test("a holder whose own lease lapsed gets a new lease id, not its old one", async () => {
		// This is what makes the steal safe: the old id is dead the moment the hold
		// changes, so a woken holder cannot heartbeat its way back in.
		const node = new LeaseTable();
		const first = await node.claim(holder("hermes", "sess-a"), 60);
		node.now += 61_000;

		const again = await node.claim(holder("hermes", "sess-a"));

		expect(again.action).toBe("reclaimed");
		expect(again.lease_id).not.toBe(first.lease_id);
		expect(again.epoch).toBe(first.epoch + 1);
		expect(again.evicted).toBeNull();
	});

	test("a claim that predates leases lapses instead of holding forever", () => {
		// A Phase 0 row: claimed_by and claimed_at, no lease at all. Read as held for
		// one default TTL after the claim, then free — so the node heals itself.
		const legacy: LeaseSnapshot = {
			...NO_LEASE,
			surface: "omp",
			session_id: null,
			claimed_at: "2026-09-30T12:00:00.000Z",
		};
		const claimed = Date.parse("2026-09-30T12:00:00.000Z");

		expect(leaseState(legacy, claimed + 60_000)).toBe("held");
		expect(leaseState(legacy, claimed + (DEFAULT_LEASE_TTL_SECONDS + 1) * 1000)).toBe("expired");
		// And it is nobody's holder, so it cannot be renewed into permanence.
		expect(sameHolder(legacy, holder("omp", ""))).toBe(false);
	});

	test("a claim with no timestamps at all is expired, not eternal", () => {
		const orphan: LeaseSnapshot = { ...NO_LEASE, surface: "muse", session_id: "sess-x", lease_id: "lse_x" };
		expect(leaseState(orphan, Date.now())).toBe("expired");
	});
});

describe("heartbeat", () => {
	test("keeps a live lease alive without changing hands", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("hermes", "sess-a"), 60);
		node.now += 30_000;

		const beat = await node.heartbeat(claim.lease_id ?? "", 60);

		expect(beat.ok).toBe(true);
		expect(node.row.epoch).toBe(claim.epoch);
		expect(leaseState(node.row, node.now + 45_000)).toBe("held");
	});

	test("a stale lease id cannot extend the lease that replaced it", async () => {
		const node = new LeaseTable();
		const first = await node.claim(holder("grok-bot", "sess-grok"), 60);
		node.now += 61_000;
		const second = await node.claim(holder("hermes", "sess-hermes"), 60);

		const beat = await node.heartbeat(first.lease_id ?? "", 600);

		expect(beat.ok).toBe(false);
		expect(beat.ok === false && beat.reason).toBe("lost");
		expect(beat.ok === false && beat.holder).toEqual(holder("hermes", "sess-hermes"));
		// And the live lease was not extended by the attempt.
		expect(node.row.lease_id).toBe(second.lease_id);
		expect(leaseState(node.row, node.now + 120_000)).toBe("expired");
	});

	test("a lapsed lease is not revived by a heartbeat, even unopposed", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("hermes", "sess-a"), 60);
		node.now += 61_000;

		const beat = await node.heartbeat(claim.lease_id ?? "", 60);

		expect(beat.ok).toBe(false);
		expect(beat.ok === false && beat.reason).toBe("expired");
	});

	test("nothing to beat on a free node", async () => {
		const node = new LeaseTable();
		const beat = await node.heartbeat("lse_whatever");
		expect(beat.ok === false && beat.reason).toBe("unheld");
	});
});

describe("release is fenced", () => {
	test("a stale holder cannot release the lease that replaced its own", async () => {
		// The failure this prevents: an agent stalls past its TTL, a second agent
		// claims the node and starts work, the first wakes up and "finishes" by
		// releasing — dropping a lease it does not hold, silently.
		const node = new LeaseTable();
		const first = await node.claim(holder("grok-bot", "sess-grok"), 60);
		node.now += 61_000;
		const second = await node.claim(holder("hermes", "sess-hermes"), 600);

		const refused = await node.release({ lease_id: first.lease_id });

		expect(refused.ok).toBe(false);
		expect(refused.ok === false && refused.reason).toBe("stale-lease");
		expect(node.row.lease_id).toBe(second.lease_id);
		expect(node.holder()).toEqual(holder("hermes", "sess-hermes"));
	});

	test("the holder releases its own lease and the node goes free", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("hermes", "sess-a"));

		const released = await node.release({ lease_id: claim.lease_id });

		expect(released.ok).toBe(true);
		expect(released.ok === true && released.action).toBe("released");
		expect(node.holder()).toBeNull();
	});

	test("a release with no lease id is refused rather than guessed at", async () => {
		const node = new LeaseTable();
		await node.claim(holder("hermes", "sess-a"));

		const refused = await node.release({});

		expect(refused.ok).toBe(false);
		expect(refused.ok === false && refused.reason).toBe("lease-id-required");
		expect(node.holder()).toEqual(holder("hermes", "sess-a"));
	});

	test("force drops someone else's lease and says whose it was", async () => {
		const node = new LeaseTable();
		await node.claim(holder("hermes", "sess-a"));

		const forced = await node.release({ force: true });

		expect(forced.ok === true && forced.action).toBe("forced");
		expect(forced.ok === true && forced.evicted).toEqual(holder("hermes", "sess-a"));
		expect(node.holder()).toBeNull();
	});

	test("releasing a free node is a no-op, not an error", async () => {
		const node = new LeaseTable();
		const released = await node.release({ lease_id: "lse_nothing" });
		expect(released.ok === true && released.action).toBe("noop");
	});

	test("the epoch never goes backwards across a release", async () => {
		// The CAS token has to stay monotonic, or a claim decided against an old
		// epoch could land after a release and reuse a lease a stale holder remembers.
		const node = new LeaseTable();
		const first = await node.claim(holder("hermes", "sess-a"));
		await node.release({ lease_id: first.lease_id });
		const second = await node.claim(holder("omp", "sess-b"));

		expect(second.epoch).toBeGreaterThan(first.epoch);
	});
});

describe("TTL bounds", () => {
	test("clamped rather than rejected, with a sane default", () => {
		expect(normalizeTtlSeconds(undefined)).toBe(DEFAULT_LEASE_TTL_SECONDS);
		expect(normalizeTtlSeconds(0)).toBe(MIN_LEASE_TTL_SECONDS);
		expect(normalizeTtlSeconds(-5)).toBe(MIN_LEASE_TTL_SECONDS);
		expect(normalizeTtlSeconds(1e9)).toBe(MAX_LEASE_TTL_SECONDS);
		expect(normalizeTtlSeconds(Number.NaN)).toBe(DEFAULT_LEASE_TTL_SECONDS);
		expect(normalizeTtlSeconds(600)).toBe(600);
		expect(normalizeTtlSeconds(90.7)).toBe(90);
	});

	test("a lease id is unguessable and unique", () => {
		const ids = new Set(Array.from({ length: 500 }, newLeaseId));
		expect(ids.size).toBe(500);
		for (const id of ids) expect(id).toMatch(/^lse_[0-9a-f]{32}$/);
	});
});

describe("leaseView", () => {
	test("reports the hold as a reader sees it, expiry included", () => {
		const now = Date.parse("2026-09-30T12:00:00.000Z");
		const view = leaseView(
			{
				lease_id: "lse_abc",
				surface: "hermes",
				session_id: "sess-a",
				claimed_at: new Date(now - 120_000),
				heartbeat_at: new Date(now - 10_000),
				expires_at: new Date(now + 300_000),
				epoch: 4,
			},
			now,
		);

		expect(view).toEqual({
			lease_id: "lse_abc",
			holder: { surface: "hermes", session_id: "sess-a" },
			epoch: 4,
			state: "held",
			claimed_at: new Date(now - 120_000).toISOString(),
			heartbeat_at: new Date(now - 10_000).toISOString(),
			expires_at: new Date(now + 300_000).toISOString(),
			expires_in_seconds: 300,
		});
	});

	test("a lapsed lease reports negative time and state expired", () => {
		const now = Date.now();
		const view = leaseView(
			{ ...NO_LEASE, lease_id: "l", surface: "omp", session_id: "s", expires_at: new Date(now - 60_000) },
			now,
		);
		expect(view.state).toBe("expired");
		expect(view.expires_in_seconds).toBe(-60);
	});
});
