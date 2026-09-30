import { describe, expect, test } from "bun:test";
import { isReviewToken, loadConfig } from "./config.ts";
import { MAX_QUERY_LIMIT, type EventQuery } from "./greptime.ts";
import { REDACTED } from "./redact.ts";
import type { ClaimAction } from "./lease.ts";
import { Substrate } from "./service.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

/** Records what reached the event log, and stands in for the index. */
function stubStores(
	graph: { repo?: string | null; branch?: string | null } | null,
	claim: { action?: ClaimAction; claimed?: boolean; evicted?: { surface: string; session_id: string } } = {},
) {
	const emitted: SubstrateEvent[] = [];
	const action = claim.action ?? "granted";
	const index = {
		claimNode: async (graph_id: string, node_id: string, surface: string, session_id: string) => ({
			claimed: claim.claimed ?? true,
			node: { graph_id, node_id, linear_identifier: "SPE-123" },
			lease: { lease_id: "lse_1", epoch: 1, expires_at: "2026-09-30T12:15:00.000Z", state: "held" },
			decision: {
				action,
				granted: action !== "denied",
				lease_id: "lse_1",
				epoch: 1,
				observed_epoch: 0,
				ttl_seconds: 900,
				evicted: claim.evicted ?? null,
				holder: { surface, session_id },
				observed_expiry: null,
			},
		}),
		getGraph: async () => (graph ? { repo: graph.repo ?? null, branch: graph.branch ?? null } : null),
	};
	const greptime = {
		// Append-only, so `emit` is not fail-closed here; enforcement has its own tests.
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	return { emitted, index, greptime };
}

describe("claimNode", () => {
	test("stamps the claim event with the graph's repo", async () => {
		// Regression: the claim event used to carry no repo, so it was invisible to
		// every repo-scoped brief — the one place a claim most needs to be seen.
		const { emitted, index, greptime } = stubStores({ repo: "swcstudiospace/x", branch: "main" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("claim");
		expect(emitted[0]?.repo).toBe("swcstudiospace/x");
		expect(emitted[0]?.branch).toBe("main");
		expect(emitted[0]?.surface).toBe("omp");
	});

	test("does not repeat the node id the brief already renders", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(emitted[0]?.summary).toBe("claimed SPE-123");
		expect(emitted[0]?.summary).not.toContain("n4");
	});

	test("still claims when the graph lookup fails — the claim matters more than its event", async () => {
		const { emitted, index, greptime } = stubStores(null);
		index.getGraph = async () => {
			throw new Error("postgres blipped");
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(result.claimed).toBe(true);
		expect(emitted[0]?.repo).toBeNull();
	});

	test("hands the caller the lease it is now holding", async () => {
		const { index, greptime } = stubStores({ repo: "r" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(result.action).toBe("granted");
		expect(result.lease.lease_id).toBe("lse_1");
		expect(result.lease.expires_at).toBe("2026-09-30T12:15:00.000Z");
	});

	test("a renewal writes no event — a heartbeat is the absence of news", async () => {
		// An event per renewal would bury the trail under the one thing in it that
		// carries no information, and a heartbeating agent renews for hours.
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { action: "renewed" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(result.claimed).toBe(true);
		expect(result.action).toBe("renewed");
		expect(emitted).toEqual([]);
	});

	test("a steal is a warning, naming who was evicted", async () => {
		// The one claim another agent has to notice: the evicted holder may still
		// believe it holds the node, and the brief lists warnings.
		const { emitted, index, greptime } = stubStores(
			{ repo: "swcstudiospace/x" },
			{ action: "stolen", evicted: { surface: "grok-bot", session_id: "sess-dead" } },
		);
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n2", "hermes", "sess-live");

		expect(result.evicted).toBe("grok-bot/sess-dead");
		expect(emitted[0]?.kind).toBe("warning");
		expect(emitted[0]?.summary).toContain("took over SPE-123");
		expect(emitted[0]?.summary).toContain("grok-bot");
		expect(emitted[0]?.payload).toMatchObject({ action: "stolen", lease_id: "lse_1" });
	});

	test("a re-claim after its own lease lapsed says so, and evicts nobody", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { action: "reclaimed" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n2", "hermes", "sess-live");

		expect(result.evicted).toBeNull();
		expect(emitted[0]?.kind).toBe("claim");
		expect(emitted[0]?.summary).toContain("re-claimed SPE-123");
	});

	test("a refused claim writes nothing and reports the holder", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { action: "denied", claimed: false });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n2", "hermes", "sess-live");

		expect(result.claimed).toBe(false);
		expect(emitted).toEqual([]);
	});

	test("without an index there is no durable lease, so the claim is refused outright", async () => {
		// Fail loudly rather than granting a lease that only this process knows
		// about: an in-memory hold is exactly the false exclusivity leases replace.
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		await expect(substrate.claimNode("ut-1", "n2", "hermes", "sess-1")).rejects.toThrow("SUBSTRATE_PG_URL");
		await expect(substrate.heartbeatNode("ut-1", "n2", "lse_1")).rejects.toThrow("SUBSTRATE_PG_URL");
	});
});

describe("releaseNode and completeNode", () => {
	/** An index stub whose one node holds `lease_id`, with the real fencing rules. */
	function leasedIndex(leaseId: string | null) {
		const emitted: SubstrateEvent[] = [];
		let state: string | null = null;
		const node = {
			graph_id: "ut-1",
			node_id: "n2",
			linear_identifier: "SPE-123",
			claimed_by: "hermes",
			claim_session: "sess-a",
			claimed_at: new Date().toISOString(),
			lease_id: leaseId,
			lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
			lease_heartbeat_at: new Date().toISOString(),
			lease_epoch: 3,
		};
		const index = {
			getGraph: async () => ({ repo: "swcstudiospace/x", branch: "main" }),
			// Deliberately present and expected never to fire: completion writes the
			// state inside the release's own guarded statement now, because two
			// statements let another agent claim the freed node in between and get
			// their live node marked completed. The real store no longer has this
			// method at all — the stub keeps it so the tripwire outlives the removal.
			setNodeState: async () => {
				throw new Error("completion must not write the state in a second statement");
			},
			releaseNode: async (
				_g: string,
				_n: string,
				request: { lease_id?: string | null; force?: boolean },
				alsoSetState?: string,
			) => {
				if (leaseId === null) {
					// Nothing holds it: a successful no-op, carrying no holder.
					return {
						released: true,
						node,
						decision: { ok: true as const, action: "noop" as const, lease_id: null, evicted: null, holder: null, observed_epoch: 3 },
					};
				}
				if (request.lease_id && request.lease_id !== leaseId) {
					return {
						released: false,
						node,
						decision: { ok: false as const, reason: "stale-lease" as const, holder: { surface: "hermes", session_id: "sess-a" }, observed_epoch: 3 },
					};
				}
				if (!request.lease_id && !request.force) {
					return {
						released: false,
						node,
						decision: { ok: false as const, reason: "lease-id-required" as const, holder: { surface: "hermes", session_id: "sess-a" }, observed_epoch: 3 },
					};
				}
				// The state arrives with the release, in one call, and lands on the row
				// the release returns.
				if (alsoSetState !== undefined) state = alsoSetState;
				return {
					released: true,
					node: { ...node, ...(alsoSetState === undefined ? {} : { state: alsoSetState }) },
					decision: {
						ok: true as const,
						action: request.force ? ("forced" as const) : ("released" as const),
						lease_id: leaseId,
						evicted: request.force ? { surface: "hermes" as const, session_id: "sess-a" } : null,
						holder: { surface: "hermes" as const, session_id: "sess-a" },
						observed_epoch: 3,
					},
				};
			},
		};
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: SubstrateEvent) => {
				emitted.push(event);
			},
		};
		return { emitted, index, greptime, stateAfter: () => state };
	}

	function substrateFor(stores: ReturnType<typeof leasedIndex>) {
		return new Substrate(loadConfig({}), { index: stores.index as never, greptime: stores.greptime as never });
	}

	test("the holder's release writes a note naming the node", async () => {
		const stores = leasedIndex("lse_live");
		const result = await substrateFor(stores).releaseNode("ut-1", "n2", { lease_id: "lse_live" });

		expect(result.released).toBe(true);
		expect(result.action).toBe("released");
		expect(stores.emitted[0]?.kind).toBe("note");
		expect(stores.emitted[0]?.summary).toBe("released SPE-123");
		expect(stores.emitted[0]?.repo).toBe("swcstudiospace/x");
	});

	test("a stale lease id is refused and writes nothing", async () => {
		const stores = leasedIndex("lse_live");
		const result = await substrateFor(stores).releaseNode("ut-1", "n2", { lease_id: "lse_old" });

		expect(result.released).toBe(false);
		expect(result.reason).toBe("stale-lease");
		expect(result.holder).toEqual({ surface: "hermes", session_id: "sess-a" });
		expect(stores.emitted).toEqual([]);
	});

	test("a forced release is a warning, not a note", async () => {
		const stores = leasedIndex("lse_live");
		const result = await substrateFor(stores).releaseNode("ut-1", "n2", { force: true });

		expect(result.action).toBe("forced");
		expect(stores.emitted[0]?.kind).toBe("warning");
		expect(stores.emitted[0]?.summary).toContain("forced the lease off");
	});

	test("completing a node a stale holder no longer owns does not close it", async () => {
		// The sharpest case for fencing: an agent that stalled past its TTL wakes up
		// and "finishes" a node a second agent has since claimed and is working on.
		const stores = leasedIndex("lse_live");

		const result = await substrateFor(stores).completeNode("ut-1", "n2", { lease_id: "lse_old" });

		expect(result.completed).toBe(false);
		expect(result.reason).toBe("stale-lease");
		expect(stores.stateAfter()).toBeNull();
	});

	test("the holder completing its own node writes the state", async () => {
		const stores = leasedIndex("lse_live");
		const result = await substrateFor(stores).completeNode("ut-1", "n2", { lease_id: "lse_live" });

		expect(result.completed).toBe(true);
		expect(stores.stateAfter()).toBe("completed");
	});

	test("completing a node nobody holds is refused: a no-op release is not ownership", async () => {
		// Releasing a free node succeeds as a no-op, which is right for a release and
		// wrong as a licence to complete — it let any caller close any unheld node
		// without ever holding it.
		const stores = leasedIndex(null);
		const result = await substrateFor(stores).completeNode("ut-1", "n2", { lease_id: "lse_whatever" });

		expect(result.completed).toBe(false);
		expect(result.reason).toBe("unheld");
		expect(stores.stateAfter()).toBeNull();
	});

	test("the release note is attributed to the agent that let the node go", async () => {
		// The row's holder columns are cleared by the release, so reading the holder
		// off the returned row attributed every ordinary release to the fallback
		// surface with no session. The decision saw the row before that.
		const stores = leasedIndex("lse_live");
		await substrateFor(stores).releaseNode("ut-1", "n2", { lease_id: "lse_live" });

		expect(stores.emitted[0]?.surface).toBe("hermes");
		expect(stores.emitted[0]?.session_id).toBe("sess-a");
	});
});

describe("emit", () => {
	const input: EventInput = { surface: "omp", kind: "shell", summary: "ran cargo test", session_id: "sess-1" };

	/** A ledger stub that records what it was given and can be made to fail. */
	function ledger(options: { lastHash?: string | null; fail?: string } = {}) {
		const written: SubstrateEvent[] = [];
		return {
			written,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => options.lastHash ?? null,
				insertEvent: async (event: SubstrateEvent) => {
					if (options.fail) throw new Error(options.fail);
					written.push(event);
				},
			},
		};
	}

	function substrateWith(greptime: unknown) {
		return new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	}

	test("reports a stored event, redacted, chained onto the session's last hash", async () => {
		const { written, greptime } = ledger({ lastHash: "prev-hash" });
		const result = await substrateWith(greptime).emit({ ...input, summary: "exported PGPASSWORD=s3cr3t" });

		expect(result.stored).toBe(true);
		expect(result.error).toBeUndefined();
		expect(written).toHaveLength(1);
		expect(written[0]?.prev).toBe("prev-hash");
		expect(written[0]?.summary).toBe(`exported PGPASSWORD=${REDACTED}`);
		// The caller is handed exactly the row that was stored, hash included, so
		// it can be quoted as a source_event.
		expect(result.event.hash).toBe(written[0]?.hash ?? "");
	});

	test("says so rather than pretending, when no ledger is configured", async () => {
		// The dishonest version of this returned the event and let the caller read
		// it as a durable append.
		const result = await substrateWith(null).emit(input);
		expect(result.stored).toBe(false);
		expect(result.error).toContain("GREPTIME_URL");
		expect(result.event.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("does not throw when the ledger refuses the write", async () => {
		// Fail open: an unreachable event store must never fail an agent's turn.
		const { greptime } = ledger({ fail: "greptime unreachable: connect ETIMEDOUT" });
		const result = await substrateWith(greptime).emit(input);
		expect(result.stored).toBe(false);
		expect(result.error).toContain("ETIMEDOUT");
	});

	test("redacts the failure it reports back", async () => {
		// A connection error can quote the URL it failed to reach, password and all.
		const { greptime } = ledger({ fail: "greptime unreachable: postgres://user:hunter2@host/db refused" });
		const result = await substrateWith(greptime).emit(input);
		expect(result.error).not.toContain("hunter2");
		expect(result.error).toContain(REDACTED);
	});

	test("still rejects an event that should never be stored", async () => {
		// Invalid input is the caller's bug, not an outage — it surfaces as an error.
		const { greptime } = ledger();
		await expect(substrateWith(greptime).emit({ ...input, kind: "nope" as never })).rejects.toThrow();
	});

	test("a session's first event chains from nothing", async () => {
		const { written, greptime } = ledger({ lastHash: null });
		await substrateWith(greptime).emit(input);
		expect(written[0]?.prev).toBeNull();
	});

	test("an unreadable previous hash starts a new chain rather than failing the append", async () => {
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => {
				throw new Error("greptime unreachable");
			},
			insertEvent: async () => undefined,
		};
		const result = await substrateWith(greptime).emit(input);
		expect(result.stored).toBe(true);
		expect(result.event.prev).toBeNull();
	});
});

describe("migrate", () => {
	test("surfaces a reachable-but-misconfigured ledger as degraded", async () => {
		const greptime = { migrate: async () => ({ warnings: ["agent_events is not in append_mode"] }) };
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });

		const result = await substrate.migrate();

		expect(result.greptime).toBe(true);
		expect(result.errors).toContain("greptime: agent_events is not in append_mode");
	});
});

describe("append-mode enforcement", () => {
	const input: EventInput = { surface: "omp", kind: "shell", summary: "ran cargo test", session_id: "sess-1" };

	function ledger(appendMode: boolean | null, quotingDialectKnown = true) {
		const written: SubstrateEvent[] = [];
		let asked = 0;
		return {
			written,
			asked: () => asked,
			greptime: {
				ensureAppendMode: async () => {
					asked++;
					return appendMode;
				},
				probeDialect: async () => quotingDialectKnown,
				quotingDialectKnown,
				lastHash: async () => null,
				insertEvent: async (event: SubstrateEvent) => {
					written.push(event);
				},
				ping: async () => true,
			},
		};
	}

	function substrateWith(greptime: unknown, env: Record<string, string> = {}) {
		return new Substrate(loadConfig(env), { index: null, greptime: greptime as never });
	}

	test("refuses the append when the table is not append-only", async () => {
		// Fail closed. Answering `stored: true` to a write Greptime may drop is the
		// one failure an events ledger must not have, and a lost row breaks the chain
		// for every event after it.
		const { written, greptime } = ledger(false);

		const result = await substrateWith(greptime).emit(input);

		expect(result.stored).toBe(false);
		expect(result.error).toContain("append_mode");
		expect(written).toEqual([]);
	});

	test("refuses the append when append_mode cannot be confirmed", async () => {
		const { written, greptime } = ledger(null);

		const result = await substrateWith(greptime).emit(input);

		expect(result.stored).toBe(false);
		expect(result.error).toContain("could not confirm");
		expect(written).toEqual([]);
	});

	test("does not throw while refusing, so an agent's turn is unaffected", async () => {
		// Fail closed at the ledger, fail open at the client: the caller gets its
		// normalised event and a reason, never an exception.
		const { greptime } = ledger(false);
		const result = await substrateWith(greptime).emit(input);
		expect(result.event.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("appends without comment once the table is append-only", async () => {
		const { written, greptime } = ledger(true);
		const result = await substrateWith(greptime).emit(input);

		expect(result.stored).toBe(true);
		expect(result.warning).toBeUndefined();
		expect(written).toHaveLength(1);
	});

	test("an operator can knowingly accept the loss, and is still told", async () => {
		const { written, greptime } = ledger(false);
		const result = await substrateWith(greptime, { SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER: "true" }).emit(input);

		expect(result.stored).toBe(true);
		expect(result.warning).toContain("may be silently dropped");
		expect(written).toHaveLength(1);
	});

	test("the override is off unless explicitly set", () => {
		expect(loadConfig({}).allowDeduplicatingLedger).toBe(false);
		expect(loadConfig({ SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER: "1" }).allowDeduplicatingLedger).toBe(true);
		expect(loadConfig({ SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER: "false" }).allowDeduplicatingLedger).toBe(false);
	});

	test("healthz separates reachability from writability", async () => {
		// The state a monitor has to see: `ping` succeeds while every append is refused.
		const { greptime } = ledger(false);
		expect(await substrateWith(greptime).health()).toEqual({
			index: false,
			greptime: true,
			appendOnly: false,
			quotingDialectKnown: true,
			eventsWritable: false,
		});
	});

	test("healthz reports writable once the table is append-only", async () => {
		const { greptime } = ledger(true);
		expect((await substrateWith(greptime).health()).eventsWritable).toBe(true);
	});

	test("an unknown quoting dialect is not a writable ledger either", async () => {
		// It refuses only events carrying a backslash, but a trail with holes in it is
		// not writable, and calling it so would hide the failure this reports.
		const { greptime } = ledger(true, false);
		const health = await substrateWith(greptime).health();

		expect(health.appendOnly).toBe(true);
		expect(health.quotingDialectKnown).toBe(false);
		expect(health.eventsWritable).toBe(false);
	});
});

describe("memory.write is fail-closed", () => {
	const entry = { scope: "graph:ut-1", kind: "fact" as const, text: "hermes finished n2", writer: "hermes" };

	/** Records what reached the ledger, so the audit trail can be asserted on. */
	function auditing() {
		const emitted: SubstrateEvent[] = [];
		return {
			emitted,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => null,
				insertEvent: async (event: SubstrateEvent) => {
					emitted.push(event);
				},
			},
		};
	}

	test("no index is a denial, not an exception and never a silent success", async () => {
		// `emit` hands a caller its event back when the ledger is gone, because a lost
		// event costs the trail. Memory is what the next four sessions act on, so the
		// same outage has to come back as a refusal — and as something an agent mid-turn
		// can act on, which a thrown error is not.
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		const result = await substrate.writeMemory(entry);

		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("store.unavailable");
		expect(result.verified_persisted).toBe(false);
		expect(result.remedy).toContain("SUBSTRATE_PG_URL");
	});

	test("an index that throws is a denial with the reason redacted", async () => {
		// A connection error quotes the URL it failed to reach, password and all.
		const index = {
			claimWrite: async () => {
				throw new Error("connect failed: postgres://user:hunter2@host/db");
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });

		const result = await substrate.writeMemory(entry);

		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("store.write-failed");
		expect(result.remedy).not.toContain("hunter2");
		expect(result.remedy).toContain(REDACTED);
	});

	test("a refused write is audited to the event log", async () => {
		// Governance that leaves no trace is indistinguishable from no governance: a
		// denial is otherwise visible only to the agent that was denied, which is the
		// one party with an interest in not mentioning it.
		const { emitted, greptime } = auditing();
		const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: greptime as never });

		const result = await substrate.writeMemory({ ...entry, scope: "person:ove" });

		expect(result.outcome).toBe("denied");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("warning");
		expect(emitted[0]?.summary).toContain("memory.write denied");
		expect(emitted[0]?.payload).toMatchObject({ outcome: "denied", reason: "rbac.no-grant" });
	});

	test("the audit event carries the decision and never the body", async () => {
		// The body may be exactly the secret that got the write quarantined, and copying
		// it into an append-only ledger to record that it was quarantined is absurd.
		const { emitted, greptime } = auditing();
		const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: greptime as never });

		await substrate.writeMemory({ ...entry, writer: "unknown", text: "PGPASSWORD=s3cr3t-do-not-log" });

		expect(JSON.stringify(emitted)).not.toContain("s3cr3t");
	});

	test("an unattributed writer is refused without an event, because emit would reject it too", async () => {
		// `unknown` is not a surface, so there is nothing to attribute the audit event
		// to; the stderr line is its trail. The refusal still happens.
		const { emitted, greptime } = auditing();
		const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: greptime as never });

		const result = await substrate.writeMemory({ ...entry, writer: "unknown" });

		expect(result.outcome).toBe("denied");
		expect(emitted).toEqual([]);
	});

	test("a ledger that cannot take the audit event does not change the decision", async () => {
		// The audit is fail-open on top of a fail-closed decision. Losing the trail must
		// not turn a denial into an exception.
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async () => {
				throw new Error("greptime unreachable");
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: greptime as never });

		expect((await substrate.writeMemory({ ...entry, scope: "person:ove" })).outcome).toBe("denied");
	});
});

describe("reviewer tokens", () => {
	test("none configured means every review path stays closed", () => {
		// The correct default: the queue fills, and nothing forged gets through.
		const config = loadConfig({});
		expect(config.memoryReviewTokens.size).toBe(0);
		expect(isReviewToken(config, "anything")).toBe(false);
		expect(isReviewToken(config, undefined)).toBe(false);
	});

	test("a configured token is accepted, and only that token", () => {
		const config = loadConfig({ SUBSTRATE_MEMORY_REVIEW_TOKENS: "reviewer-token-that-is-long, second-token-also-long" });
		expect(isReviewToken(config, "reviewer-token-that-is-long")).toBe(true);
		expect(isReviewToken(config, "second-token-also-long")).toBe(true);
		expect(isReviewToken(config, "reviewer-token")).toBe(false);
		expect(isReviewToken(config, "")).toBe(false);
	});

	test("a short value is a placeholder, not a token", () => {
		// Accepting `changeme` would hand reviewer authority to anybody who guessed it.
		const config = loadConfig({ SUBSTRATE_MEMORY_REVIEW_TOKENS: "changeme" });
		expect(config.memoryReviewTokens.size).toBe(0);
		expect(isReviewToken(config, "changeme")).toBe(false);
	});
});

describe("handoff", () => {
	const SIGNING_ENV = { SUBSTRATE_HANDOFF_KEY: "test-signing-key", SUBSTRATE_HANDOFF_KEY_ID: "k1" };

	function ledger(lastHash: string | null = null) {
		const written: SubstrateEvent[] = [];
		return {
			written,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => lastHash,
				insertEvent: async (event: SubstrateEvent) => {
					written.push(event);
				},
			},
		};
	}

	const input = {
		from: { surface: "grok-bot" as const, session_id: "sess-grok" },
		to: { surface: "hermes" as const, session_id: null },
		goal: "finish the lease CAS path",
		files: ["packages/mcp-server/src/index-store.ts"],
		dod: ["bun test green"],
		blockers: [],
		graph_id: "ut-1",
		node_id: "n2",
	};

	test("anchors the packet to the sender's chain tip without being told it", async () => {
		// `prev_event_hash` is a fact about the ledger, and the ledger is here. A
		// caller that had to supply it would be free to supply the wrong one.
		const { written, greptime } = ledger("tip-hash");
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: greptime as never });

		const result = await substrate.handoff(input);

		expect(result.packet.prev_event_hash).toBe("tip-hash");
		// The handoff event chains from the same tip, so the packet and the event it
		// arrived in agree about where the sender's trail had reached.
		expect(written[0]?.prev).toBe("tip-hash");
		expect(result.event.prev).toBe("tip-hash");
	});

	test("a caller cannot pin the anchor: a hash nothing checked would be signed and believed", async () => {
		// The signature says the substrate signed the packet, not that the hash is
		// real — so a caller-supplied anchor would hand a receiver `ok: true` on a
		// packet pointing at a trail that never happened. There is no input for it.
		const { greptime } = ledger("tip-hash");
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: greptime as never });

		const result = await substrate.handoff({ ...input, prev_event_hash: "d".repeat(64) } as never);

		expect(result.packet.prev_event_hash).toBe("tip-hash");
	});

	test("the lease is released only once the packet is durable", async () => {
		// Freeing the node first meant a refused append left it claimable with no
		// packet to replay: the next agent finds the work abandoned and no account of
		// it. Keeping the hold is the recoverable half — the sender can retry.
		const released: Array<{ node: string; lease: string | undefined }> = [];
		const index = {
			getGraph: async () => ({ repo: "swcstudiospace/x", branch: "main" }),
			releaseNode: async (_g: string, nodeId: string, request: { lease_id?: string }) => {
				released.push({ node: nodeId, lease: request.lease_id });
				return {
					released: true,
					node: { graph_id: "ut-1", node_id: nodeId, linear_identifier: "SPE-4792", lease_epoch: 1 },
					decision: { ok: true as const, action: "released" as const, lease_id: request.lease_id ?? null, evicted: null, holder: { surface: "grok-bot" as const, session_id: "sess-grok" }, observed_epoch: 1 },
				};
			},
		};

		// No ledger at all, so the append cannot land.
		const unstorable = new Substrate(loadConfig(SIGNING_ENV), { index: index as never, greptime: null });
		const refused = await unstorable.handoff({ ...input, handover_lease_id: "lse_a", release_lease: true });

		expect(refused.stored).toBe(false);
		expect(refused.lease_released).toBe(false);
		expect(released).toEqual([]);

		// And with a ledger that takes it, the release happens.
		const { greptime } = ledger();
		const stored = new Substrate(loadConfig(SIGNING_ENV), { index: index as never, greptime: greptime as never });
		const done = await stored.handoff({ ...input, handover_lease_id: "lse_a", release_lease: true });

		expect(done.stored).toBe(true);
		expect(done.lease_released).toBe(true);
		expect(released).toEqual([{ node: "n2", lease: "lse_a" }]);
	});

	test("the whole packet is in the event, signed, and verifies as stored", async () => {
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: greptime as never });

		const result = await substrate.handoff(input);

		expect(result.signed).toBe(true);
		expect(result.stored).toBe(true);
		expect(written[0]?.kind).toBe("handoff");
		expect(written[0]?.summary).toBe("handoff to hermes: finish the lease CAS path");
		// Read back out of the row that was stored, not out of the reply.
		expect(substrate.verifyHandoffPacket(written[0]?.payload.handoff)).toEqual({ ok: true, key_id: "k1" });
	});

	test("with no key configured the handoff still happens and says it is unsigned", async () => {
		// Fail open: a handoff that was refused for want of a key is context lost
		// outright, which is worse than context that cannot be authenticated.
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });

		const result = await substrate.handoff(input);

		expect(result.signed).toBe(false);
		expect(result.packet.signature).toBeNull();
		expect(written).toHaveLength(1);
	});

	test("an unstorable ledger does not lose the packet, and says it did not store it", async () => {
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: null });

		const result = await substrate.handoff(input);

		expect(result.stored).toBe(false);
		expect(result.error).toContain("GREPTIME_URL");
		expect(substrate.verifyHandoffPacket(result.packet).ok).toBe(true);
	});

	test("takes the repo from the graph, so the handoff shows up in that repo's brief", async () => {
		const { written, greptime } = ledger();
		const index = { getGraph: async () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }) };
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: index as never, greptime: greptime as never });

		const result = await substrate.handoff(input);

		expect(result.packet.repo).toBe("swcstudiospace/agent-substrate");
		expect(written[0]?.repo).toBe("swcstudiospace/agent-substrate");
	});

	test("names what a receiver will find missing rather than refusing a thin packet", async () => {
		const { greptime } = ledger();
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: greptime as never });

		const result = await substrate.handoff({ ...input, dod: [], files: [] });

		expect(result.gaps.join(" ")).toContain("Definition of Done");
		expect(result.signed).toBe(true);
	});

	test("replays a graph's handoffs back out of the ledger, each with its own verdict", async () => {
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig(SIGNING_ENV), { index: null, greptime: greptime as never });
		await substrate.handoff(input);

		// The ledger hands back loosely typed rows; the replay has to rebuild the
		// packet from them and verify what it rebuilt.
		const row = written[0]!;
		const replay = new Substrate(loadConfig(SIGNING_ENV), {
			index: null,
			greptime: {
				readEvents: async () => [
					{ ...row, ts: Date.parse(row.ts), payload: JSON.stringify(row.payload), step: null },
					{ ...row, id: "evt_other", kind: "note", payload: "{}", ts: Date.parse(row.ts), step: null },
				],
			} as never,
		});

		const handoffs = await replay.handoffsForGraph("ut-1");

		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.verdict).toEqual({ ok: true, key_id: "k1" });
		expect(handoffs[0]?.packet?.goal).toBe("finish the lease CAS path");
		expect(handoffs[0]?.packet?.dod).toEqual(["bun test green"]);
	});

	test("a packet that does not verify is still returned, with the reason", async () => {
		// Hiding it would leave a gap in the history with no explanation for it.
		const substrate = new Substrate(loadConfig(SIGNING_ENV), {
			index: null,
			greptime: {
				readEvents: async () => [
					{
						id: "evt_1",
						ts: Date.now(),
						surface: "grok-bot",
						kind: "handoff",
						summary: "handoff to hermes: x",
						payload: JSON.stringify({ handoff: { goal: "x", signature: null } }),
						hash: "h",
						prev: null,
						actor: "agent",
						step: null,
					},
				],
			} as never,
		});

		const handoffs = await substrate.handoffsForGraph("ut-1");

		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.verdict).toEqual({ ok: false, reason: "unsigned" });
	});
});

describe("driftScan", () => {
	test("reports each record as not compared rather than throwing when it cannot be read", async () => {
		// A scan that threw would tell an agent nothing; one that reported agreement
		// would tell it something false.
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		const report = await substrate.driftScan({ repo: "swcstudiospace/agent-substrate" });

		expect(report.ok).toBe(true);
		expect(report.findings).toEqual([]);
		expect(report.unavailable).toHaveLength(3);
		expect(report.unavailable[0]).toContain("no path or git_tip given");
		expect(report.sources).toEqual({ git: false, ledger: false, index: false });
	});

	test("compares a supplied git tip against the trail, without reading a checkout", async () => {
		// The hook's path: it has just run in the checkout, so it knows the tip and
		// the substrate need not touch the filesystem at all.
		const substrate = new Substrate(loadConfig({}), {
			index: null,
			greptime: {
				recentForRepo: async () => [
					{
						id: "evt_1",
						ts: Date.now() - 60_000,
						surface: "cursor",
						kind: "commit",
						summary: "commit 9999999 something else",
						payload: JSON.stringify({ sha: "9999999" }),
						hash: "h",
						prev: null,
						actor: "human",
						step: null,
						repo: "swcstudiospace/agent-substrate",
					},
				],
				// Asked of the whole ledger, not just the window: no commit event names
				// this tip anywhere, so the finding is real rather than an artefact.
				commitEventsNaming: async () => [],
			} as never,
		});

		const report = await substrate.driftScan({
			repo: "swcstudiospace/agent-substrate",
			git_tip: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
			branch: "main",
		});

		expect(report.findings.map((finding) => finding.kind)).toEqual(["git.tip_unlogged"]);
		expect(report.git.short_sha).toBe("1a2b3c4");
		expect(report.ledger.last_commit).toMatchObject({ sha: "9999999", surface: "cursor" });
	});

	test("reads the repo from the ledger in the form the write path stores it", async () => {
		// The same trap as `emit` and `verifyGraph`: querying the raw value would
		// match nothing and report a silent ledger for a busy repo.
		const asked: string[] = [];
		const substrate = new Substrate(loadConfig({}), {
			index: null,
			greptime: {
				recentForRepo: async (repo: string) => {
					asked.push(repo);
					return [];
				},
			} as never,
		});

		await substrate.driftScan({ repo: `swcstudiospace/x-GITHUB_TOKEN=ghp_${"a".repeat(40)}` });

		expect(asked[0]).not.toContain("ghp_aaaa");
		expect(asked[0]).toContain("[REDACTED]");
	});

	test("a lapsed lease in the index is named even with no ledger at all", async () => {
		const substrate = new Substrate(loadConfig({}), {
			index: {
				claimedNodesForRepo: async () => [
					{
						graph_id: "ut-1",
						node_id: "n2",
						linear_identifier: "SPE-4792",
						state: "started",
						claimed_by: "grok-bot",
						claim_session: "sess-dead",
						claimed_at: new Date(Date.now() - 3_600_000).toISOString(),
						lease_id: "lse_dead",
						lease_expires_at: new Date(Date.now() - 1_800_000).toISOString(),
						lease_heartbeat_at: new Date(Date.now() - 1_900_000).toISOString(),
						lease_epoch: 2,
					},
				],
				nodesForRepo: async () => [],
				edgesForRepo: async () => [],
			} as never,
			greptime: null,
		});

		const report = await substrate.driftScan({ repo: "swcstudiospace/agent-substrate" });

		expect(report.findings.map((finding) => finding.kind)).toEqual(["lease.expired"]);
		expect(report.findings[0]?.surface).toBe("grok-bot");
		expect(report.claims[0]?.lease.state).toBe("expired");
	});

	test("one failing index query degrades the whole index record rather than half-comparing", async () => {
		// Comparing claims against edges that could not be read would report every
		// held node as unblocked, which is a confident wrong answer.
		const substrate = new Substrate(loadConfig({}), {
			index: {
				claimedNodesForRepo: async () => [],
				nodesForRepo: async () => [],
				edgesForRepo: async () => {
					throw new Error("postgres is down");
				},
			} as never,
			greptime: null,
		});

		const report = await substrate.driftScan({ repo: "swcstudiospace/agent-substrate" });

		expect(report.sources.index).toBe(false);
		expect(report.unavailable.some((line) => line.startsWith("index:"))).toBe(true);
	});
});

describe("identifier lookups", () => {
	test("looks the session up by the id it will store, not the one it was given", async () => {
		// The bug: the raw id was used for the lookup while a cleaned one was stored,
		// so lastHash never matched and every append restarted the chain.
		const asked: string[] = [];
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async (sessionId: string) => {
				asked.push(sessionId);
				return "prev-hash";
			},
			insertEvent: async () => undefined,
		};
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });

		const raw = `sess-GITHUB_TOKEN=ghp_${"a".repeat(40)}`;
		const result = await substrate.emit({ surface: "omp", kind: "note", summary: "x", session_id: raw });

		expect(asked).toEqual([result.event.session_id ?? ""]);
		expect(asked[0]).not.toBe(raw);
		expect(result.event.prev).toBe("prev-hash");
	});

	test("verifyGraph reads by the stored form of the graph id", async () => {
		const asked: Array<[string, string]> = [];
		const greptime = {
			ensureAppendMode: async () => true,
			readEvents: async (column: "graph_id", value: string) => {
				asked.push([column, value]);
				return [];
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });

		await substrate.verifyGraph("ut-1".padEnd(900, "x"));

		expect(asked[0]?.[1].length).toBe(512);
	});
});

describe("queryEvents", () => {
	/** A ledger stub that records the query it was handed and replies with fixed rows. */
	function reader(rows: Array<Record<string, unknown>> = [], fail?: string) {
		const queries: EventQuery[] = [];
		return {
			queries,
			greptime: {
				queryEvents: async (query: EventQuery) => {
					queries.push(query);
					if (fail) throw new Error(fail);
					return rows;
				},
			},
		};
	}

	function substrateWith(greptime: unknown) {
		return new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	}

	/** One stored row, as Greptime hands it back: epoch millis, payload as JSON text. */
	function row(over: Record<string, unknown> = {}) {
		return {
			ts: 1790186361859,
			id: "evt_1",
			surface: "omp",
			session_id: "sess-1",
			graph_id: "ut-1",
			node_id: null,
			linear_identifier: null,
			step: null,
			repo: "swcstudiospace/x",
			branch: "main",
			actor: "agent",
			kind: "shell",
			summary: "ran cargo test",
			hash: "h1",
			prev: null,
			...over,
		};
	}

	test("looks identifiers up in the form the write path stores them", async () => {
		// The regression this shares with `emit`: the write path redacts and caps every
		// identifier, so querying the raw value matches nothing — and an empty window is
		// indistinguishable from an empty ledger.
		const { queries, greptime } = reader();
		await substrateWith(greptime).queryEvents({ session_id: `sess-${"x".repeat(600)}` });

		const value = String(queries[0]?.match?.session_id);
		expect(value.length).toBe(512);
		expect(value.startsWith("sess-x")).toBe(true);
	});

	test("redacts a credential pasted into a filter rather than sending it", async () => {
		const { queries, greptime } = reader();
		await substrateWith(greptime).queryEvents({ branch: "feat/token-ghp_0123456789abcdefghijklmnopqrstuvwxyz" });

		expect(String(queries[0]?.match?.branch)).toContain(REDACTED);
	});

	test("refuses a filter on a surface, kind, actor or order that cannot exist", async () => {
		const substrate = substrateWith(reader().greptime);
		// Each would quietly match nothing, which reads to the caller as "nothing happened".
		await expect(substrate.queryEvents({ surface: "claude-cod" })).rejects.toThrow(/unknown surface/);
		await expect(substrate.queryEvents({ kind: "file.edited" })).rejects.toThrow(/unknown kind/);
		await expect(substrate.queryEvents({ actor: "robot" })).rejects.toThrow(/unknown actor/);
		await expect(substrate.queryEvents({ order: "sideways" as never })).rejects.toThrow(/unknown order/);
	});

	test("refuses a time bound that is not a date", async () => {
		await expect(substrateWith(reader().greptime).queryEvents({ since: "last tuesday" })).rejects.toThrow(
			/invalid since/,
		);
		await expect(substrateWith(reader().greptime).queryEvents({ until: "soon" })).rejects.toThrow(/invalid until/);
	});

	test("normalises the time bounds to ISO", async () => {
		const { queries, greptime } = reader();
		await substrateWith(greptime).queryEvents({ since: "2026-09-30", until: "2026-09-30T12:00:00Z" });

		expect(queries[0]?.since).toBe("2026-09-30T00:00:00.000Z");
		expect(queries[0]?.until).toBe("2026-09-30T12:00:00.000Z");
	});

	test("rebuilds the event the chain was computed over", async () => {
		const { greptime } = reader([row()]);
		const { events, count, truncated } = await substrateWith(greptime).queryEvents({ graph_id: "ut-1" });

		expect(count).toBe(1);
		expect(truncated).toBe(false);
		// Greptime returns a TIMESTAMP as an integer; the chain hashed an ISO string.
		expect(events[0]?.ts).toBe("2026-09-23T17:59:21.859Z");
		expect(events[0]?.hash).toBe("h1");
		expect(events[0]?.node_id).toBeNull();
	});

	test("omits the payload unless it was asked for, and parses it when it was", async () => {
		const withPayload = row({ payload: '{"file":"gateway/ws.rs"}' });

		const bare = await substrateWith(reader([withPayload]).greptime).queryEvents({});
		expect("payload" in (bare.events[0] ?? {})).toBe(false);

		const full = await substrateWith(reader([withPayload]).greptime).queryEvents({ include_payload: true });
		expect(full.events[0]?.payload).toEqual({ file: "gateway/ws.rs" });
	});

	test("reports a full window as truncated so the caller knows to narrow it", async () => {
		const { greptime } = reader([row(), row({ id: "evt_2" })]);
		expect((await substrateWith(greptime).queryEvents({ limit: 2 })).truncated).toBe(true);
		expect((await substrateWith(greptime).queryEvents({ limit: 3 })).truncated).toBe(false);
	});

	test("clamps an oversized limit rather than refusing the read", async () => {
		const { queries, greptime } = reader();
		await substrateWith(greptime).queryEvents({ limit: 10_000 });
		expect(queries[0]?.limit).toBe(MAX_QUERY_LIMIT);
	});

	test("an unconfigured ledger is an empty window with a reason, not a thrown error", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		expect(await substrate.queryEvents({})).toEqual({
			events: [],
			count: 0,
			truncated: false,
			error: "GREPTIME_URL is not set",
		});
	});

	test("an unreachable ledger reports a redacted reason", async () => {
		const { greptime } = reader([], "greptime unreachable: postgres://user:hunter2@host/db refused");
		const result = await substrateWith(greptime).queryEvents({});

		expect(result.events).toEqual([]);
		expect(result.error).toContain(REDACTED);
		expect(result.error).not.toContain("hunter2");
	});
});

describe("queryEvents input checks", () => {
	/** A ledger stub that records the query it was handed. */
	function reader() {
		const queries: EventQuery[] = [];
		return {
			queries,
			greptime: {
				queryEvents: async (query: EventQuery) => {
					queries.push(query);
					return [];
				},
			},
		};
	}

	function substrateWith(greptime: unknown) {
		return new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	}

	test("refuses an identifier that was supplied but empty, rather than widening the read", async () => {
		// `normalizeIdentifier("")` is null, and a dropped clause is not a narrower
		// query — it is every event the other filters allow. A caller passing an unset
		// variable would have been handed unrelated events.
		const { queries, greptime } = reader();
		const substrate = substrateWith(greptime);

		await expect(substrate.queryEvents({ session_id: "" })).rejects.toThrow(/session_id is empty/);
		await expect(substrate.queryEvents({ repo: "" })).rejects.toThrow(/repo is empty/);
		expect(queries).toEqual([]);

		// Absent is still absent: no clause, and no refusal.
		await substrate.queryEvents({});
		expect(queries[0]?.match?.session_id).toBeUndefined();
	});

	test("refuses a filter of the wrong type instead of failing inside redaction", async () => {
		// A JSON body is not typed. `redact` is written for strings, so a number used to
		// reach `.replace` and surface as a 500 rather than a 400 naming the field.
		const { queries, greptime } = reader();
		const substrate = substrateWith(greptime);

		await expect(substrate.queryEvents({ session_id: 123 as never })).rejects.toThrow(
			/session_id must be a string/,
		);
		await expect(substrate.queryEvents({ surface: 7 as never })).rejects.toThrow(/surface must be a string/);
		await expect(substrate.queryEvents({ include_payload: "yes" as never })).rejects.toThrow(
			/include_payload must be a boolean/,
		);
		await expect(substrate.queryEvents({ order: 1 as never })).rejects.toThrow(/order must be a string/);
		expect(queries).toEqual([]);
	});

	test("refuses a numeric time bound rather than reading it as 1970", async () => {
		// `new Date(123)` is a valid date, so this used to be a silently empty window.
		await expect(substrateWith(reader().greptime).queryEvents({ until: 123 as never })).rejects.toThrow(
			/until must be an ISO date string/,
		);
	});

	test("refuses a limit that is not a number rather than silently using the default", async () => {
		const { queries, greptime } = reader();
		await expect(substrateWith(greptime).queryEvents({ limit: "10" as never })).rejects.toThrow(
			/limit must be a number/,
		);
		expect(queries).toEqual([]);
	});
});

describe("the governance queue withholds what quarantine was protecting", () => {
	/** Two parked rows, one of each kind, as the index would return them. */
	const index = {
		governanceQueue: async () => ({
			reviews: [
				{
					id: "memr_1",
					scope: "global",
					kind: "decision" as const,
					writer: "hermes",
					reason: "global scope requires review",
					created: "2026-09-30T00:00:00.000Z",
					text: "Greptime is the events ledger only",
					subject: "store lock",
				},
			],
			quarantined: [
				{
					id: "memq_1",
					scope: "repo:a/b",
					kind: "fact" as const,
					writer: "omp",
					reason: "pii",
					created: "2026-09-30T00:00:00.000Z",
					text: "escalate to someone@a-real-domain.test",
					subject: "escalation",
					detail: "the text carried an email address",
				},
			],
		}),
	};

	function substrateWithTokens(tokens?: string) {
		return new Substrate(loadConfig(tokens ? { SUBSTRATE_MEMORY_REVIEW_TOKENS: tokens } : {}), {
			index: index as never,
			greptime: null,
		});
	}

	test("a caller with no reviewer token sees that something is parked, not what", async () => {
		// Redaction strips credentials, not the email address that caused the quarantine.
		// A queue that showed every body to every agent holding any surface token would
		// publish exactly what quarantining it was meant to contain — to more readers
		// than accepting the write would have.
		const queue = await substrateWithTokens().governanceQueue({});

		expect(queue.authorized).toBe(false);
		expect(queue.quarantined[0]?.text).toBeUndefined();
		expect(queue.quarantined[0]?.subject).toBeUndefined();
		expect(JSON.stringify(queue)).not.toContain("a-real-domain.test");
		// The parts worth knowing survive, and none of them is the payload.
		expect(queue.quarantined[0]).toMatchObject({
			id: "memq_1",
			scope: "repo:a/b",
			writer: "omp",
			reason: "pii",
			detail: "the text carried an email address",
		});
		expect(queue.reviews[0]?.text).toBeUndefined();
	});

	test("a reviewer sees the bodies", async () => {
		const token = "reviewer-token-that-is-long";
		const queue = await substrateWithTokens(token).governanceQueue({ review_token: token });

		expect(queue.authorized).toBe(true);
		expect(queue.quarantined[0]?.text).toContain("a-real-domain.test");
		expect(queue.reviews[0]?.text).toContain("Greptime");
	});

	test("a wrong token is no token", async () => {
		const queue = await substrateWithTokens("reviewer-token-that-is-long").governanceQueue({
			review_token: "not-the-reviewer-token",
		});
		expect(queue.authorized).toBe(false);
		expect(queue.quarantined[0]?.text).toBeUndefined();
	});
});

describe("the audit line is redacted", () => {
	test("a credential in a caller-supplied scope does not reach the journal", async () => {
		// `scope` is caller-controlled and a refused write is exactly where a malformed one
		// arrives. A credential in the journal is leaked whether or not the event that
		// would have carried it was ever emitted.
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: null });
			await substrate.writeMemory({
				scope: "graph:GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				kind: "fact",
				text: "x",
				writer: "hermes",
			});
		} finally {
			process.stderr.write = original;
		}

		const log = written.join("");
		expect(log).toContain("memory.write");
		expect(log).not.toContain("ghp_aaaa");
		expect(log).toContain(REDACTED);
	});
});
