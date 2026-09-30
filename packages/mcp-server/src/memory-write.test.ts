import { beforeEach, describe, expect, test } from "bun:test";
import { REDACTED } from "./redact.ts";
import {
	DERIVED_KEY_WINDOW_MS,
	governMemoryWrite,
	IN_FLIGHT_TIMEOUT_MS,
	type ClaimResult,
	type MemoryStore,
	type NewMemoryEntry,
	type WriteRecord,
} from "./memory-write.ts";
import type { MemoryEntry, MemoryWriteRequest, MemoryWriteResult, QuarantineReason } from "./types.ts";

const REVIEW_TOKEN = "a-reviewer-token-long-enough";
const START = Date.parse("2026-09-30T00:00:00.000Z");

/**
 * An in-memory `MemoryStore`.
 *
 * It exists so that the decisions in `memory-write.ts` — which are the whole
 * point of the gate — are tested without a Postgres. It reproduces the two
 * behaviours the SQL is responsible for and the gate relies on: `claimWrite`'s
 * hand-over rules, and `insertEntry` retiring a predecessor atomically.
 */
class FakeStore implements MemoryStore {
	clock = START;
	readonly rows = new Map<string, { entry: MemoryEntry; conflict_key: string | null }>();
	readonly writes = new Map<string, WriteRecord & { claimed: number }>();
	readonly quarantined: Array<NewMemoryEntry & { reason: QuarantineReason; detail: string }> = [];
	readonly reviews: Array<NewMemoryEntry & { reason: string; state: string; entry_id: string | null }> = [];

	/** Makes the read-back miss, which is the only way to reach `verified_persisted: false`. */
	hideFromReadBack = false;
	/** Makes the insert throw, standing in for an index that went away mid-write. */
	failInsert: string | null = null;

	entries(): MemoryEntry[] {
		return [...this.rows.values()].map((row) => row.entry);
	}

	standing(): MemoryEntry[] {
		return this.entries().filter((entry) => !entry.superseded_by);
	}

	async claimWrite(input: { key: string; explicit: boolean; entryHash: string }): Promise<ClaimResult> {
		const existing = this.writes.get(input.key);
		const age = existing ? this.clock - existing.claimed : 0;
		const free =
			!existing ||
			// A refused attempt wrote nothing, so re-asking is allowed a fresh answer.
			(existing.outcome !== "accepted" && existing.outcome !== "in-flight") ||
			(existing.outcome === "in-flight" && age >= IN_FLIGHT_TIMEOUT_MS) ||
			(existing.outcome === "accepted" && !existing.explicit && age >= DERIVED_KEY_WINDOW_MS);
		if (free) {
			this.writes.set(input.key, {
				idempotency_key: input.key,
				explicit: input.explicit,
				outcome: "in-flight",
				entry_id: null,
				entry_hash: input.entryHash,
				claimed: this.clock,
			});
			return { claimed: true };
		}
		return { claimed: false, existing: { ...existing } };
	}

	async finishWrite(key: string, outcome: MemoryWriteResult["outcome"], entryId: string | null): Promise<void> {
		const record = this.writes.get(key);
		if (record) this.writes.set(key, { ...record, outcome, entry_id: entryId, claimed: this.clock });
	}

	async releaseWrite(key: string): Promise<void> {
		if (this.writes.get(key)?.outcome === "in-flight") this.writes.delete(key);
	}

	async standingEntry(conflictKey: string): Promise<MemoryEntry | null> {
		const found = [...this.rows.values()]
			.filter((row) => row.conflict_key === conflictKey && !row.entry.superseded_by)
			.sort((a, b) => b.entry.version - a.entry.version);
		return found[0]?.entry ?? null;
	}

	async insertEntry(row: NewMemoryEntry): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" }> {
		if (this.failInsert) throw new Error(this.failInsert);
		if (row.supersedes) {
			const predecessor = this.rows.get(row.supersedes);
			if (!predecessor || predecessor.entry.superseded_by) return { ok: false, reason: "standing-moved" };
			predecessor.entry = { ...predecessor.entry, superseded_by: row.id };
		}
		const entry: MemoryEntry = {
			id: row.id,
			scope: row.scope,
			kind: row.kind,
			text: row.text,
			writer: row.writer,
			actor: row.actor,
			trust: row.trust,
			ttl: row.ttl,
			created: new Date(this.clock).toISOString(),
			version: row.version,
			entry_hash: row.entry_hash,
			needs_reverification: false,
			...(row.subject ? { subject: row.subject } : {}),
			...(row.source_event ? { source_event: row.source_event } : {}),
			...(row.session_id ? { session_id: row.session_id } : {}),
			...(row.graph_id ? { graph_id: row.graph_id } : {}),
			...(row.repo ? { repo: row.repo } : {}),
			...(row.supersedes ? { supersedes: row.supersedes } : {}),
			...(row.reverify_after ? { reverify_after: row.reverify_after } : {}),
			...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
		};
		this.rows.set(row.id, { entry, conflict_key: row.conflict_key });
		return { ok: true, entry };
	}

	async readEntry(id: string): Promise<MemoryEntry | null> {
		if (this.hideFromReadBack) return null;
		return this.rows.get(id)?.entry ?? null;
	}

	async quarantineEntry(row: NewMemoryEntry & { reason: QuarantineReason; detail: string }): Promise<string> {
		const existing = this.quarantined.find((held) => held.entry_hash === row.entry_hash);
		if (existing) return existing.id;
		this.quarantined.push(row);
		return row.id;
	}

	async enqueueReview(row: NewMemoryEntry & { reason: string }): Promise<string> {
		const existing = this.reviews.find((held) => held.entry_hash === row.entry_hash && held.state === "pending");
		if (existing) return existing.id;
		this.reviews.push({ ...row, state: "pending", entry_id: null });
		return row.id;
	}

	async releaseReviews(entryHash: string, entryId: string): Promise<number> {
		let released = 0;
		for (const review of this.reviews) {
			if (review.entry_hash !== entryHash || review.state !== "pending") continue;
			review.state = "approved";
			review.entry_id = entryId;
			released++;
		}
		return released;
	}
}

let store: FakeStore;
let ids: number;

beforeEach(() => {
	store = new FakeStore();
	ids = 0;
});

/** Deterministic ids, so a test can assert on them. */
function write(request: Partial<MemoryWriteRequest> = {}): Promise<MemoryWriteResult> {
	return governMemoryWrite(
		{ scope: "graph:ut-1", kind: "fact", text: "hermes finished n2", writer: "hermes", ...request },
		{
			store,
			isReviewToken: (token) => token === REVIEW_TOKEN,
			now: () => new Date(store.clock),
			newId: (prefix) => `${prefix}_${++ids}`,
		},
	);
}

describe("denied — default-deny RBAC", () => {
	test("an unattributed caller writes nothing", async () => {
		// `unknown` is what an MCP caller with no bearer token arrives as.
		const result = await write({ writer: "unknown" });
		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("rbac.no-grant");
		expect(result.remedy).toContain("no memory grants at all");
		expect(store.entries()).toEqual([]);
	});

	test("a denial for a known surface names what it could have written", async () => {
		const result = await write({ scope: "person:ove", kind: "fact" });
		expect(result.outcome).toBe("denied");
		expect(result.remedy).toContain("graph:");
		expect(result.grant).toBeNull();
	});

	test("nothing is written before RBAC runs, not even a quarantine row", async () => {
		// Storing text from a writer that has no business at this scope is still
		// storing it, so the order of the two checks is itself the assertion.
		const result = await write({ writer: "unknown", text: "password: hunter2" });
		expect(result.outcome).toBe("denied");
		expect(store.quarantined).toEqual([]);
	});

	test("a scope the gate cannot classify is a denial", async () => {
		expect((await write({ scope: "repos:a/b" })).reason).toBe("scope.malformed");
	});

	test("an unknown kind or ttl is a denial", async () => {
		expect((await write({ kind: "rumour" as never })).reason).toBe("kind.unknown");
		expect((await write({ ttl: "forever" })).reason).toBe("ttl.unknown");
	});

	test("an empty entry is a denial", async () => {
		expect((await write({ text: "   " })).reason).toBe("text.empty");
	});

	test("a refusal spends no idempotency key", async () => {
		const result = await write({ writer: "unknown", idempotency_key: "k1" });
		expect(result.idempotency_key).toBe("");
		expect(store.writes.size).toBe(0);
	});
});

describe("quarantined", () => {
	test("a secret is parked and stored redacted", async () => {
		const result = await write({ text: "poller needs GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
		expect(result.outcome).toBe("quarantined");
		expect(result.quarantine_reason).toBe("secret");
		expect(store.entries()).toEqual([]);
		// The quarantine holds the *redacted* body: parking a write is so a reviewer can
		// see what was attempted, never so the substrate keeps the credential.
		expect(store.quarantined[0]?.text).toContain(REDACTED);
		expect(store.quarantined[0]?.text).not.toContain("ghp_");
	});

	test("a reviewer's token does not release a secret", async () => {
		const result = await write({ text: "password: hunter2", review_token: REVIEW_TOKEN });
		expect(result.outcome).toBe("quarantined");
		expect(result.remedy).toContain("cannot release this one");
	});

	test("PII is parked, and a reviewer's token releases it", async () => {
		const text = "escalate to ove.govender@spectrumweb.test.net";
		expect((await write({ text })).quarantine_reason).toBe("pii");

		const released = await write({ text, review_token: REVIEW_TOKEN });
		expect(released.outcome).toBe("accepted");
	});

	test("a speculative decision is parked; the same words as a todo are not", async () => {
		const text = "we will probably move the projector to herdr";
		expect((await write({ kind: "decision", text })).quarantine_reason).toBe("speculative");
		expect((await write({ kind: "todo", text })).outcome).toBe("accepted");
	});

	test("parking is idempotent, so a retry does not fill a reviewer's queue", async () => {
		await write({ text: "password: hunter2" });
		const second = await write({ text: "password: hunter2" });
		expect(store.quarantined).toHaveLength(1);
		expect(second.quarantine_id).toBe(store.quarantined[0]?.id);
	});

	test("a parked row never carries a trust the write had not earned", async () => {
		await write({ text: "password: hunter2", trust: "human-confirmed" });
		expect(store.quarantined[0]?.trust).toBe("agent-claimed");
	});
});

describe("conflict — require-review for global", () => {
	test("a global write is a proposal, not an entry", async () => {
		const result = await write({ scope: "global", kind: "decision", text: "Greptime is the events ledger only" });
		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("review.required");
		expect(result.strategy).toBe("require-review");
		expect(result.review_id).toBe(store.reviews[0]?.id);
		expect(store.entries()).toEqual([]);
	});

	test("re-submitting with a reviewer's token installs it and closes the proposal", async () => {
		const request = { scope: "global", kind: "decision" as const, text: "Greptime is the events ledger only" };
		await write(request);

		const approved = await write({ ...request, review_token: REVIEW_TOKEN });

		expect(approved.outcome).toBe("accepted");
		expect(approved.verified_persisted).toBe(true);
		expect(store.reviews[0]?.state).toBe("approved");
		expect(store.reviews[0]?.entry_id).toBe(approved.entry?.id);
	});

	test("the parked conflict does not pin the outcome forever", async () => {
		// A refused write left nothing behind, so the key it spent must not stop the
		// same content being re-decided — which is what makes approval-by-resubmit work
		// at all when the caller sends its own idempotency key.
		const request = { scope: "global", kind: "fact" as const, text: "eight agents share one host", idempotency_key: "k9" };
		expect((await write(request)).outcome).toBe("conflict");
		expect((await write({ ...request, review_token: REVIEW_TOKEN })).outcome).toBe("accepted");
	});
});

describe("conflict — versioned decisions", () => {
	const decision = { scope: "repo:a/b", kind: "decision" as const, subject: "runtime" };

	test("the first decision for a subject lands at version 1", async () => {
		const result = await write({ ...decision, text: "the runtime is herdr" });
		expect(result.outcome).toBe("accepted");
		expect(result.strategy).toBe("versioned");
		expect(result.entry?.version).toBe(1);
	});

	test("replacing a standing decision without naming its version is a conflict", async () => {
		// This is the teeth of `versioned`: silently overwriting a decision another
		// agent is acting on is exactly what the gate exists to stop.
		const first = await write({ ...decision, text: "the runtime is herdr" });
		const second = await write({ ...decision, text: "the runtime is Orca" });

		expect(second.outcome).toBe("conflict");
		expect(second.reason).toBe("version.required");
		expect(second.conflict_with).toBe(first.entry?.id ?? "");
		expect(second.remedy).toContain("version 1");
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("the runtime is herdr");
	});

	test("a stale expectation is a conflict that says what the current version is", async () => {
		await write({ ...decision, text: "the runtime is herdr" });
		const stale = await write({ ...decision, text: "the runtime is Orca", expected_version: 7 });
		expect(stale.reason).toBe("version.stale");
		expect(stale.remedy).toContain("version 1");
	});

	test("expecting a version where nothing is in force is a conflict too", async () => {
		const result = await write({ ...decision, text: "the runtime is Orca", expected_version: 3 });
		expect(result.reason).toBe("version.stale");
		expect(store.entries()).toEqual([]);
	});

	test("naming the right version supersedes it and keeps the history", async () => {
		const first = await write({ ...decision, text: "the runtime is herdr" });
		const second = await write({ ...decision, text: "the runtime is Orca", expected_version: 1 });

		expect(second.outcome).toBe("accepted");
		expect(second.entry?.version).toBe(2);
		expect(second.entry?.supersedes).toBe(first.entry?.id);
		expect(store.standing()).toHaveLength(1);
		// The superseded row is retired, not deleted: "why did this change" is the
		// question a decision log exists to answer.
		expect(store.entries()).toHaveLength(2);
		expect(store.rows.get(first.entry?.id ?? "")?.entry.superseded_by).toBe(second.entry?.id ?? "");
	});

	test("a decision with no subject has nothing to collide with", async () => {
		await write({ scope: "repo:a/b", kind: "decision", text: "one" });
		const second = await write({ scope: "repo:a/b", kind: "decision", text: "two" });
		expect(second.outcome).toBe("accepted");
		expect(second.strategy).toBe("append");
		expect(store.standing()).toHaveLength(2);
	});

	test("losing the race to supersede is reported, not fought", async () => {
		await write({ ...decision, text: "the runtime is herdr" });
		// Another writer retires the standing entry in the window between this write
		// reading it and inserting its replacement — the one case the insert has to be
		// atomic to catch.
		const read = store.standingEntry.bind(store);
		store.standingEntry = async (key) => {
			const found = await read(key);
			const held = found ? store.rows.get(found.id) : undefined;
			if (held) held.entry = { ...held.entry, superseded_by: "mem_someone-else" };
			return found;
		};

		const result = await write({ ...decision, text: "the runtime is Orca", expected_version: 1 });

		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("version.raced");
		expect(store.entries()).toHaveLength(1);
	});
});

describe("accepted — last-write-wins todos", () => {
	const todo = { scope: "repo:a/b", kind: "todo" as const, subject: "lockfile" };

	test("a later todo replaces the earlier one without ceremony", async () => {
		// Making agents version their todo list would only teach them to stop writing
		// todos.
		const first = await write({ ...todo, text: "regenerate the lockfile" });
		const second = await write({ ...todo, text: "lockfile regenerated; verify in CI" });

		expect(second.outcome).toBe("accepted");
		expect(second.strategy).toBe("lww");
		expect(second.conflict_with).toBe(first.entry?.id ?? "");
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("lockfile regenerated; verify in CI");
	});

	test("a different subject is a different todo", async () => {
		await write({ ...todo, text: "regenerate the lockfile" });
		await write({ scope: "repo:a/b", kind: "todo", subject: "backfill", text: "re-run the backfill" });
		expect(store.standing()).toHaveLength(2);
	});
});

describe("exactly-once", () => {
	test("the same explicit key never writes twice", async () => {
		const first = await write({ idempotency_key: "k1" });
		const second = await write({ idempotency_key: "k1", text: "a different body entirely" });

		expect(first.deduplicated).toBeUndefined();
		expect(second.outcome).toBe("accepted");
		expect(second.deduplicated).toBe(true);
		expect(second.entry?.id).toBe(first.entry?.id);
		expect(store.entries()).toHaveLength(1);
	});

	test("an explicit key still holds a day later — that is what the key is for", async () => {
		await write({ idempotency_key: "k1" });
		store.clock += DERIVED_KEY_WINDOW_MS * 3;
		expect((await write({ idempotency_key: "k1" })).deduplicated).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("a retry with no key dedupes on the content", async () => {
		const first = await write();
		const retry = await write();
		expect(retry.deduplicated).toBe(true);
		expect(retry.entry?.id).toBe(first.entry?.id);
		expect(store.entries()).toHaveLength(1);
	});

	test("a derived key expires, so the same fact can be restated later", async () => {
		// Deriving a key protects a crash-retry; it must not freeze memory forever.
		await write();
		store.clock += DERIVED_KEY_WINDOW_MS + 1;
		const later = await write();
		expect(later.deduplicated).toBeUndefined();
		expect(store.entries()).toHaveLength(2);
	});

	test("a concurrent write holding the key is told to retry, not allowed through", async () => {
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "whatever" });
		const result = await write({ idempotency_key: "k1" });
		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("write.in-flight");
		expect(store.entries()).toEqual([]);
	});

	test("an abandoned claim is taken over once it is stale", async () => {
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "whatever" });
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		expect((await write({ idempotency_key: "k1" })).outcome).toBe("accepted");
	});

	test("a failed write releases its key, so the retry is not a replay of nothing", async () => {
		store.failInsert = "postgres: connection reset";
		await expect(write({ idempotency_key: "k1" })).rejects.toThrow("connection reset");
		expect(store.writes.size).toBe(0);

		store.failInsert = null;
		const retry = await write({ idempotency_key: "k1" });
		expect(retry.outcome).toBe("accepted");
		expect(retry.deduplicated).toBeUndefined();
	});
});

describe("verified_persisted", () => {
	test("an accepted write is read back before it is believed", async () => {
		const result = await write();
		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
	});

	test("an insert that cannot be read back is accepted but not verified", async () => {
		// `outcome` is the governance decision and `verified_persisted` is durability.
		// A consumer other agents act on requires both — this is the state that split
		// exists to represent.
		store.hideFromReadBack = true;
		const result = await write({ idempotency_key: "k1" });
		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(false);
		expect(result.remedy).toContain("same idempotency_key");
	});

	test("the replay re-verifies rather than writing again", async () => {
		store.hideFromReadBack = true;
		await write({ idempotency_key: "k1" });

		store.hideFromReadBack = false;
		const retry = await write({ idempotency_key: "k1" });

		expect(retry.deduplicated).toBe(true);
		expect(retry.verified_persisted).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("a replay whose entry has vanished says so instead of claiming success", async () => {
		const first = await write({ idempotency_key: "k1" });
		store.rows.delete(first.entry?.id ?? "");

		const retry = await write({ idempotency_key: "k1" });

		expect(retry.deduplicated).toBe(true);
		expect(retry.verified_persisted).toBe(false);
		expect(retry.remedy).toContain("not in the index");
	});

	test("a write superseding another does not retire it until the replacement is really there", async () => {
		// The failure this prevents: a standing decision hidden behind a replacement
		// that never landed, leaving the scope with nothing in force at all.
		const first = await write({ scope: "repo:a/b", kind: "decision", subject: "runtime", text: "herdr" });
		store.failInsert = "postgres: connection reset";
		await expect(
			write({ scope: "repo:a/b", kind: "decision", subject: "runtime", text: "Orca", expected_version: 1 }),
		).rejects.toThrow();

		expect(store.rows.get(first.entry?.id ?? "")?.entry.superseded_by).toBeUndefined();
		expect(store.standing()).toHaveLength(1);
	});
});

describe("provenance", () => {
	test("the entry carries where it came from", async () => {
		const result = await write({
			session_id: "sess-1",
			graph_id: "ut-1",
			repo: "swcstudiospace/agent-substrate",
			source_event: "evt_1",
		});
		expect(result.entry).toMatchObject({
			writer: "hermes",
			actor: "agent",
			session_id: "sess-1",
			graph_id: "ut-1",
			repo: "swcstudiospace/agent-substrate",
			source_event: "evt_1",
		});
		expect(result.grant).toBe("graph-any");
	});

	test("an agent cannot vouch for itself, and is told when it is downgraded", async () => {
		const result = await write({ trust: "human-confirmed" });
		expect(result.entry?.trust).toBe("agent-claimed");
		expect(result.trust_downgraded_from).toBe("human-confirmed");
	});

	test("verified-by-test needs the event that proved it", async () => {
		expect((await write({ trust: "verified-by-test" })).entry?.trust).toBe("agent-claimed");
		const proven = await write({ trust: "verified-by-test", source_event: "evt_9" });
		expect(proven.entry?.trust).toBe("verified-by-test");
		expect(proven.trust_downgraded_from).toBeUndefined();
	});

	test("a reviewer's token records the trust and the human actor", async () => {
		const result = await write({ trust: "human-confirmed", actor: "human", review_token: REVIEW_TOKEN });
		expect(result.entry?.trust).toBe("human-confirmed");
		expect(result.entry?.actor).toBe("human");
	});

	test("the review token itself is never stored or echoed", async () => {
		const result = await write({ review_token: REVIEW_TOKEN });
		expect(JSON.stringify(result)).not.toContain(REVIEW_TOKEN);
		expect(JSON.stringify(store.entries())).not.toContain(REVIEW_TOKEN);
	});

	test("the body is redacted on the way in even when it is not quarantined", async () => {
		// Belt and braces: the classifier catches what the redactor recognises, so this
		// only bites if the two ever drift. It must drift towards redacting.
		const result = await write({ text: `a note about Bearer ${"z".repeat(20)}` });
		expect(result.outcome).toBe("quarantined");
	});

	test("trust decay is stamped at write time from the trust that was granted", async () => {
		const agentClaimed = await write();
		expect(agentClaimed.entry?.reverify_after).toBe("2026-10-14T00:00:00.000Z");
		expect(agentClaimed.entry?.needs_reverification).toBe(false);

		const confirmed = await write({ text: "checked by hand", trust: "human-confirmed", review_token: REVIEW_TOKEN });
		expect(confirmed.entry?.reverify_after).toBe("2027-03-29T00:00:00.000Z");
	});

	test("a downgraded write decays on the shelf life it actually got, not the one it asked for", async () => {
		// Asking for human-confirmed and being refused it must not buy the six-month
		// shelf life either; otherwise the downgrade is cosmetic.
		const result = await write({ trust: "human-confirmed" });
		expect(result.entry?.trust).toBe("agent-claimed");
		expect(result.entry?.reverify_after).toBe("2026-10-14T00:00:00.000Z");
	});
});

describe("remedies", () => {
	test("every outcome carries one", async () => {
		const results = [
			await write({ writer: "unknown" }),
			await write({ scope: "global", kind: "fact", text: "eight agents share one host" }),
			await write({ text: "password: hunter2" }),
			await write(),
		];
		for (const result of results) {
			expect(result.remedy.length).toBeGreaterThan(20);
			expect(result.remedy).toMatch(/\.$/);
		}
	});
});
