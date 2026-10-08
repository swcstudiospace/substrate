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
	holderLeaseView,
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

	/**
	 * Read, decide, then apply only if nothing moved underneath — the real sequence.
	 * `caller` is the token's surface; null is an anonymous local run, which is not checked.
	 */
	async claim(
		holder: LeaseHolder,
		ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
		caller: Surface | null = null,
	): Promise<ClaimDecision> {
		const observed = { ...this.row };
		const request = { ...holder, ttl_seconds: ttlSeconds, caller };
		const decision = decideClaim(observed, request, this.now);
		await this.yieldOnce();
		if (!decision.granted) return decision;
		if (this.row.epoch !== decision.observed_epoch) {
			// Lost the race. Report what is true now rather than what was decided.
			return { ...decideClaim({ ...this.row }, request, this.now), action: "denied", granted: false };
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

	/** `caller` is the token's surface; null is an anonymous local run, which is not checked. */
	async heartbeat(leaseId: string, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS, caller: Surface | null = null) {
		const decision = decideHeartbeat({ ...this.row }, { lease_id: leaseId, ttl_seconds: ttlSeconds, caller }, this.now);
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

	async release(request: { lease_id?: string | null; force?: boolean }, caller: Surface | null = null) {
		const decision = decideRelease({ ...this.row }, { ...request, caller }, this.now);
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

	test("a denied claim names the holder but never hands over its lease id", async () => {
		// Every fenced call takes the id as proof of holding, so a loser told the id
		// could release or complete the winner's node.
		const node = new LeaseTable();
		const first = await node.claim(holder("swarm-a05-be", "A05@r0:ut-x"));

		const denied = await node.claim(holder("swarm-a09-rev", "A09@r0:ut-x"));

		expect(denied.granted).toBe(false);
		expect(denied.lease_id).toBeNull();
		expect(denied.holder).toEqual(holder("swarm-a05-be", "A05@r0:ut-x"));
		expect(first.lease_id).toMatch(/^lse_/);
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

describe("only the holder's surface may beat or release", () => {
	test("another surface is refused not-holder even with the right lease id", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("swarm-a05-be", "A05@r0:ut-x"), 60);
		const before = node.row.expires_at;

		const beat = await node.heartbeat(claim.lease_id ?? "", 600, "swarm-a09-rev");
		const release = await node.release({ lease_id: claim.lease_id }, "swarm-a09-rev");

		expect(beat.ok === false && beat.reason).toBe("not-holder");
		expect(beat.ok === false && beat.holder).toEqual(holder("swarm-a05-be", "A05@r0:ut-x"));
		expect(release.ok === false && release.reason).toBe("not-holder");
		expect(node.holder()).toEqual(holder("swarm-a05-be", "A05@r0:ut-x"));
		expect(node.row.expires_at).toBe(before);
	});

	test("the refusal is the same whatever id the stranger sends, so it confirms nothing", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("hermes", "sess-a"));
		const before = { ...node.row };

		const right = await node.heartbeat(claim.lease_id ?? "", 60, "omp");
		const wrong = await node.heartbeat("lse_guess", 60, "omp");
		const missing = await node.release({}, "omp");
		const rightRelease = await node.release({ lease_id: claim.lease_id }, "omp");
		const wrongRelease = await node.release({ lease_id: "lse_guess" }, "omp");

		expect(right).toEqual(wrong);
		expect(missing.ok === false && missing.reason).toBe("not-holder");
		expect(rightRelease).toEqual(wrongRelease);
		expect(rightRelease).toEqual(missing);
		expect(node.row).toEqual(before);
	});

	test("the holder's own surface beats and releases as before", async () => {
		const node = new LeaseTable();
		const claim = await node.claim(holder("swarm-a05-be", "A05@r0:ut-x"), 60);

		const beat = await node.heartbeat(claim.lease_id ?? "", 60, "swarm-a05-be");
		const released = await node.release({ lease_id: claim.lease_id }, "swarm-a05-be");

		expect(beat.ok).toBe(true);
		expect(released.ok === true && released.action).toBe("released");
		expect(node.holder()).toBeNull();
	});

	test("an anonymous local run is not checked", async () => {
		// No tokens configured means no identity to compare; the lease id still fences.
		const node = new LeaseTable();
		const claim = await node.claim(holder("omp", "sess-a"), 60);

		expect((await node.heartbeat(claim.lease_id ?? "", 60, null)).ok).toBe(true);
		const stale = await node.release({ lease_id: "lse_stale" }, null);
		expect(stale.ok === false && stale.reason).toBe("stale-lease");
		expect((await node.release({ lease_id: claim.lease_id }, null)).ok).toBe(true);
	});

	test("an operator's force is not held to the holder's surface", async () => {
		const node = new LeaseTable();
		await node.claim(holder("swarm-a05-be", "A05@r0:ut-x"));

		const forced = await node.release({ force: true }, "hermes");

		expect(forced.ok === true && forced.action).toBe("forced");
		expect(forced.ok === true && forced.evicted).toEqual(holder("swarm-a05-be", "A05@r0:ut-x"));
		expect(node.holder()).toBeNull();
	});

	test("a free node is unheld or a no-op for anyone, stranger or not", async () => {
		const node = new LeaseTable();

		const beat = await node.heartbeat("lse_x", 60, "omp");
		expect(beat.ok === false && beat.reason).toBe("unheld");
		const released = await node.release({ lease_id: "lse_x" }, "omp");
		expect(released.ok === true && released.action).toBe("noop");
	});

	test("re-claiming as the holder from another surface's token renews nothing", async () => {
		// The holder's surface and session are public — a denial names them — so a
		// claim naming them proves nothing. Renewing would move the holder's expiry
		// and hand back its lease id.
		const node = new LeaseTable();
		const a05 = holder("swarm-a05-be", "A05@r0:ut-x");
		const claim = await node.claim(a05, 600, "swarm-a05-be");
		const before = { ...node.row };
		node.now += 60_000;

		const renewal = await node.claim(a05, 30, "hermes");

		expect(renewal).toMatchObject({ action: "denied", granted: false, reason: "not-holder", lease_id: null });
		expect(renewal.holder).toEqual(a05);
		expect(node.row).toEqual(before);
		expect(node.history).toHaveLength(1);
		expect(claim.lease_id).toMatch(/^lse_/);
	});

	test("re-claiming as the holder of a lapsed lease from another surface's token is refused too", async () => {
		const node = new LeaseTable();
		const a05 = holder("swarm-a05-be", "A05@r0:ut-x");
		await node.claim(a05, 60, "swarm-a05-be");
		const before = { ...node.row };
		node.now += 61_000;

		const reclaim = await node.claim(a05, 600, "hermes");

		expect(reclaim).toMatchObject({ action: "denied", reason: "not-holder", lease_id: null });
		expect(node.row).toEqual(before);
	});

	test("the holder's own surface still renews and re-claims", async () => {
		const node = new LeaseTable();
		const a05 = holder("swarm-a05-be", "A05@r0:ut-x");
		const first = await node.claim(a05, 60, "swarm-a05-be");
		node.now += 30_000;

		const renewed = await node.claim(a05, 60, "swarm-a05-be");
		expect(renewed).toMatchObject({ action: "renewed", granted: true, lease_id: first.lease_id, reason: null });

		node.now += 61_000;
		const reclaimed = await node.claim(a05, 60, "swarm-a05-be");
		expect(reclaimed.action).toBe("reclaimed");
		expect(reclaimed.lease_id).not.toBe(first.lease_id);
	});

	test("an anonymous re-claim is not checked", async () => {
		const node = new LeaseTable();
		const first = await node.claim(holder("omp", "sess-a"), 60, null);

		const renewed = await node.claim(holder("omp", "sess-a"), 60, null);

		expect(renewed).toMatchObject({ action: "renewed", lease_id: first.lease_id });
	});

	test("another surface's token still takes a free node, but cannot renew it afterwards", async () => {
		// Supplied-first attribution: a non-swarm token may claim as another non-swarm
		// surface. The lease then belongs to the surface it named.
		const node = new LeaseTable();
		const granted = await node.claim(holder("omp", "sess-a"), 60, "hermes");
		expect(granted.action).toBe("granted");

		const renewal = await node.claim(holder("omp", "sess-a"), 60, "hermes");
		expect(renewal).toMatchObject({ action: "denied", reason: "not-holder", lease_id: null });
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

	test("a no-op is not proof of ownership", async () => {
		// It succeeded because there was nothing to release, not because the caller
		// held anything — so it carries no holder. `completeNode` read `ok` alone and
		// let any caller close any unheld node; the holder is what distinguishes them.
		const node = new LeaseTable();
		const released = await node.release({ lease_id: "lse_nothing" });

		expect(released.ok === true && released.action).toBe("noop");
		expect(released.ok === true && released.holder).toBeNull();
	});

	test("an ordinary release names the holder that let the node go", async () => {
		// The row's holder columns are about to be cleared, so a caller reading the
		// holder off the returned row would find null and attribute the release to
		// nobody. The decision saw the row before that.
		const node = new LeaseTable();
		const claim = await node.claim(holder("hermes", "sess-a"));

		const released = await node.release({ lease_id: claim.lease_id });

		expect(released.ok === true && released.holder).toEqual(holder("hermes", "sess-a"));
		expect(released.ok === true && released.evicted).toBeNull();
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
	const now = Date.parse("2026-09-30T12:00:00.000Z");
	const held: LeaseSnapshot = {
		lease_id: "lse_abc",
		surface: "hermes",
		session_id: "sess-a",
		claimed_at: new Date(now - 120_000),
		heartbeat_at: new Date(now - 10_000),
		expires_at: new Date(now + 300_000),
		epoch: 4,
	};

	test("reports the hold as a reader sees it, expiry included, and no lease id", () => {
		expect(leaseView(held, now)).toEqual({
			lease_id: null,
			holder: { surface: "hermes", session_id: "sess-a" },
			epoch: 4,
			state: "held",
			claimed_at: new Date(now - 120_000).toISOString(),
			heartbeat_at: new Date(now - 10_000).toISOString(),
			expires_at: new Date(now + 300_000).toISOString(),
			expires_in_seconds: 300,
		});
	});

	test("the holder's view is the same hold with its id", () => {
		expect(holderLeaseView(held, now)).toEqual({ ...leaseView(held, now), lease_id: "lse_abc" });
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
