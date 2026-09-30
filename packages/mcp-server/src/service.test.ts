import { describe, expect, test } from "bun:test";
import { isReviewToken, loadConfig } from "./config.ts";
import { MAX_QUERY_LIMIT, type EventQuery } from "./greptime.ts";
import { REDACTED } from "./redact.ts";
import { Substrate } from "./service.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

/** Records what reached the event log, and stands in for the index. */
function stubStores(graph: { repo?: string | null; branch?: string | null } | null) {
	const emitted: SubstrateEvent[] = [];
	const index = {
		claimNode: async (graph_id: string, node_id: string) => ({
			claimed: true,
			node: { graph_id, node_id, linear_identifier: "SPE-123" },
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
