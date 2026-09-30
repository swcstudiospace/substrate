/**
 * Row-to-entry mapping.
 *
 * The SQL in `IndexStore` needs a live Postgres, so it is proved by the live
 * Phase 0.5 run rather than here. What *is* testable without one is the mapping —
 * and it is worth testing, because it is where a Phase 0 row written before the
 * governance gate meets a type that now expects governance columns.
 */
import { describe, expect, test } from "bun:test";
import { toMemoryEntry } from "./index-store.ts";

const CREATED = new Date("2026-09-30T00:00:00.000Z");

/** The shape Postgres hands back for a fully governed entry. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "mem_1",
		scope: "repo:swcstudiospace/agent-substrate",
		kind: "decision",
		body: "the runtime is herdr",
		subject: "runtime",
		writer: "hermes",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: CREATED,
		version: 2,
		supersedes: "mem_0",
		superseded_by: null,
		entry_hash: "abc",
		reverify_after: new Date("2026-10-14T00:00:00.000Z"),
		idempotency_key: "k1",
		source_event: "evt_1",
		session_id: "sess-1",
		graph_id: "ut-1",
		repo: "swcstudiospace/agent-substrate",
		...over,
	};
}

describe("toMemoryEntry", () => {
	test("carries provenance and version through", () => {
		expect(toMemoryEntry(row(), CREATED.getTime())).toMatchObject({
			id: "mem_1",
			actor: "agent",
			version: 2,
			supersedes: "mem_0",
			entry_hash: "abc",
			session_id: "sess-1",
			graph_id: "ut-1",
			reverify_after: "2026-10-14T00:00:00.000Z",
		});
	});

	test("derives needs_reverification on read, so an entry decays where it sits", () => {
		// No sweeper job exists, and one that ran hourly would still leave an hour in
		// which a stale entry read as settled.
		expect(toMemoryEntry(row(), CREATED.getTime()).needs_reverification).toBe(false);
		expect(toMemoryEntry(row(), Date.parse("2026-10-20T00:00:00.000Z")).needs_reverification).toBe(true);
	});

	test("a row written before the gate reads as an honest version 1", () => {
		// Phase 0 wrote memory_entries with none of these columns. The migration
		// backfills the defaults; this asserts the mapping does not then invent
		// anything — no hash, no deadline, and so nothing reported as decayed.
		const legacy = toMemoryEntry(
			{
				id: "mem_old",
				scope: "global",
				kind: "warning",
				body: "disk is at 90%",
				writer: "claude-code",
				trust: "agent-claimed",
				ttl: "permanent",
				created: CREATED,
				actor: "agent",
				version: 1,
				subject: null,
				supersedes: null,
				superseded_by: null,
				entry_hash: null,
				reverify_after: null,
				idempotency_key: null,
				source_event: null,
				session_id: null,
				graph_id: null,
				repo: null,
			},
			Date.parse("2027-01-01T00:00:00.000Z"),
		);

		expect(legacy.version).toBe(1);
		expect(legacy.entry_hash).toBe("");
		expect(legacy.reverify_after).toBeUndefined();
		expect(legacy.needs_reverification).toBe(false);
		expect(legacy.subject).toBeUndefined();
	});

	test("an unrecognised actor reads as an agent", () => {
		// The column is text, and `actor: human` is the claim that needs a reviewer's
		// token — so anything that is not exactly that is an agent.
		expect(toMemoryEntry(row({ actor: "operator" })).actor).toBe("agent");
		expect(toMemoryEntry(row({ actor: "human" })).actor).toBe("human");
	});

	test("a timestamptz that arrived as a string is still an ISO string out", () => {
		const entry = toMemoryEntry(row({ created: "2026-09-30 00:00:00+00" }));
		expect(entry.created).toBe("2026-09-30 00:00:00+00");
	});
});
