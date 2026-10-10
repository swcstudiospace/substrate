import { beforeEach, describe, expect, test } from "bun:test";
import { grantFor, parseScope } from "./memory-policy.ts";
import { REDACTED } from "./redact.ts";
import { SWARM_SURFACES } from "./types.ts";
import {
	DERIVED_KEY_WINDOW_MS,
	governMemoryWrite,
	IN_FLIGHT_TIMEOUT_MS,
	type ClaimResult,
	type MemoryStore,
	type NewMemoryEntry,
	type WriteRecord,
} from "./memory-write.ts";
import type { MemoryEntry, MemoryKind, MemoryWriteRequest, MemoryWriteResult, QuarantineReason } from "./types.ts";

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
export class FakeStore implements MemoryStore {
	clock = START;
	readonly rows = new Map<string, { entry: MemoryEntry; conflict_key: string | null }>();
	readonly writes = new Map<string, WriteRecord & { holder: string; claimed: number }>();
	private holders = 0;
	readonly quarantined: Array<NewMemoryEntry & { reason: QuarantineReason; detail: string }> = [];
	readonly reviews: Array<NewMemoryEntry & { reason: string; state: string; entry_id: string | null; created: number }> = [];

	/** Makes the read-back miss, which is the only way to reach `verified_persisted: false`. */
	hideFromReadBack = false;
	/** Makes the insert throw before writing anything, standing in for an index that is down. */
	failInsert: string | null = null;
	/**
	 * Writes the row and *then* throws — a connection lost during the commit.
	 *
	 * The case that makes "did it land?" unanswerable from the exception, and the reason
	 * the claim is held from the attempt rather than from the return.
	 */
	failAfterInsert: string | null = null;
	/** Makes the standing-entry lookup throw: a failure that is certainly before the insert. */
	failStanding: string | null = null;
	/** Makes the acknowledgement throw, standing in for a crash right after the commit. */
	failFinish: string | null = null;
	/** Makes the read throw, which must never be read as "the row is not there". */
	failReadEntry: string | null = null;
	/**
	 * Makes resolving a parked proposal throw, after the entry has committed.
	 *
	 * The shape of the repeat-approval bug: a duplicate key on the reviews table was
	 * one way to reach it, and an outage is another. Either way the entry is in the
	 * index, so the caller must not be told the write failed.
	 */
	failReleaseReviews: string | null = null;
	/**
	 * Runs at the top of `insertEntry`, before its claim check.
	 *
	 * The real store does that check inside the insert's transaction and under the same
	 * row lock `claimWrite` takes, so a takeover either lands before the insert or after
	 * it and never halfway through. This hook is how a test puts one in the "before"
	 * position deliberately.
	 */
	onInsert: (() => Promise<void>) | null = null;
	/**
	 * Restores the hand-over rule from before a claim with no `request_hash` was treated
	 * as unidentified: it matched whoever asked, and its reservation went with it.
	 *
	 * The store no longer does that. The flag is how the gate's own check on a
	 * reservation it did not make — defence in depth, and unreachable through a store
	 * that keeps the rule — is still exercised.
	 */
	legacyClaimsMatchAnyAsk = false;

	entries(): MemoryEntry[] {
		return [...this.rows.values()].map((row) => row.entry);
	}

	standing(): MemoryEntry[] {
		return this.entries().filter((entry) => !entry.superseded_by);
	}

	/** What a brief would carry: every standing entry, whatever its scope. */
	async memoryForBrief(): Promise<MemoryEntry[]> {
		return this.standing();
	}

	/** The brief's graph reads, empty for a store that holds only memories. */
	async getGraph(): Promise<null> {
		return null;
	}

	async openGraphs(): Promise<never[]> {
		return [];
	}

	async claimWrite(input: {
		key: string;
		explicit: boolean;
		entryHash: string;
		requestHash?: string;
		entryId: string;
	}): Promise<ClaimResult> {
		const existing = this.writes.get(input.key);
		const age = existing ? this.clock - existing.claimed : 0;
		const inFlight = existing?.outcome === "in-flight";
		// An in-flight claim is only handed over to a retry of the same request, because
		// that hand-over inherits the previous attempt's reserved `entry_id` — see the real
		// store. A claim raised without a `requestHash` stands in for one written before the
		// column existed: its identity is unknown, not a match for everyone, so it is handed
		// over only where doing so can strand nothing — when the row it reserved does not
		// exist yet, or already holds this write's content.
		const reservedHash = existing?.entry_id ? this.rows.get(existing.entry_id)?.entry.entry_hash : undefined;
		const reservationIsOurs =
			this.legacyClaimsMatchAnyAsk || reservedHash === undefined || reservedHash === input.entryHash;
		const sameAsk = Boolean(existing?.request_hash) && existing?.request_hash === input.requestHash;
		const legacyRecoverable = !existing?.request_hash && reservationIsOurs;
		// A claim raised straight from a test may carry no `requestHash`; the gate always
		// sends one. It stands for "this hand-over is the same request's", which is how a
		// test puts a takeover in a deliberate position — a seam in the fake, not a rule.
		const raisedByTest = input.requestHash === undefined;
		const free =
			!existing ||
			// A refused attempt wrote nothing, so re-asking is allowed a fresh answer.
			(existing.outcome !== "accepted" && !inFlight) ||
			(inFlight &&
				age >= IN_FLIGHT_TIMEOUT_MS &&
				(sameAsk || legacyRecoverable || raisedByTest) &&
				reservationIsOurs) ||
			(existing.outcome === "accepted" && !existing.explicit && age >= DERIVED_KEY_WINDOW_MS);
		if (!free) return { claimed: false, existing: { ...existing! } };

		const holder = `hold_${++this.holders}`;
		const tookOverFrom = inFlight ? (existing?.entry_id ?? null) : null;
		this.writes.set(input.key, {
			idempotency_key: input.key,
			explicit: input.explicit,
			outcome: "in-flight",
			// Reserved: the row this attempt will insert, recorded before it exists. An
			// in-flight claim's reservation is kept rather than replaced — it may point at a
			// row that already exists, and overwriting it would orphan that row.
			entry_id: tookOverFrom ?? input.entryId,
			entry_hash: input.entryHash,
			request_hash: input.requestHash ?? null,
			holder,
			claimed: this.clock,
		});
		return { claimed: true, holder, tookOverFrom };
	}

	async finishWrite(
		key: string,
		holder: string,
		outcome: MemoryWriteResult["outcome"],
		entryId: string | null,
	): Promise<void> {
		if (this.failFinish) throw new Error(this.failFinish);
		const record = this.writes.get(key);
		// Fenced: a claim that was taken over is no longer this holder's to finish.
		if (record?.holder !== holder) return;
		this.writes.set(key, { ...record, outcome, entry_id: entryId, claimed: this.clock });
	}

	async releaseWrite(key: string, holder: string): Promise<void> {
		const record = this.writes.get(key);
		if (record?.holder === holder && record.outcome === "in-flight") this.writes.delete(key);
	}

	async restoreWrite(key: string, holder: string, reserved: { entryId: string; entryHash: string }): Promise<void> {
		const record = this.writes.get(key);
		if (record?.holder !== holder || record.outcome !== "in-flight") return;
		this.writes.set(key, {
			...record,
			entry_id: reserved.entryId,
			entry_hash: reserved.entryHash,
			// This attempt has no right to speak for the write that reserved the row, so it
			// leaves no identity behind and no holder anyone has. Backdated like the real
			// store's, so the write that owns the claim can take it back now rather than
			// after another timeout.
			request_hash: null,
			holder: `hold_${++this.holders}`,
			claimed: this.clock - IN_FLIGHT_TIMEOUT_MS - 1,
		});
	}

	async standingEntry(conflictKey: string): Promise<MemoryEntry | null> {
		if (this.failStanding) throw new Error(this.failStanding);
		const found = [...this.rows.values()]
			.filter((row) => row.conflict_key === conflictKey && !row.entry.superseded_by)
			.sort((a, b) => b.entry.version - a.entry.version);
		return found[0]?.entry ?? null;
	}

	async insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<
		{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" | "standing-exists" }
	> {
		if (this.onInsert) await this.onInsert();
		if (this.failInsert) throw new Error(this.failInsert);
		// Fenced, like the real store: an attempt whose claim was taken over does not get
		// to write its row. Enforced here too, or the one thing this check exists to stop
		// passes in the tests and fails only against Postgres.
		const owner = this.writes.get(claim.key);
		if (owner?.holder !== claim.holder || owner.outcome !== "in-flight") {
			return { ok: false, reason: "claim-lost" };
		}
		// Same order as the real store, which retires the predecessor before it inserts:
		// a predecessor somebody else already replaced is `standing-moved`, whatever the
		// insert would have met. Checked before the conflict key, or a rewrite that lost
		// to another rewrite reads here as the identity race Postgres never reports for it.
		if (row.supersedes) {
			const predecessor = this.rows.get(row.supersedes);
			if (!predecessor || predecessor.entry.superseded_by) return { ok: false, reason: "standing-moved" };
		}
		// `memory_standing_idx` is a unique partial index in the real store, so the fake
		// enforces it too. Otherwise a row that should never have carried a conflict key
		// passes here and fails only against Postgres. The predecessor is excluded because
		// the real store has already retired it by the time its insert meets the index.
		//
		// Refused rather than thrown, because that is what the real store does: the
		// insert declines under `on conflict … do nothing` and the transaction rolls
		// back, retire included — which is why nothing here is mutated before both
		// checks pass. A throw here would be the bug this refusal replaced — the gate
		// cannot tell a rolled-back statement from a committed one, so it keeps the
		// loser's key in flight for a race the loser could have retried at once.
		if (row.conflict_key) {
			const clash = [...this.rows.values()].find(
				(held) => held.conflict_key === row.conflict_key && !held.entry.superseded_by && held.entry.id !== row.supersedes,
			);
			if (clash) return { ok: false, reason: "standing-exists" };
		}
		if (row.supersedes) {
			const predecessor = this.rows.get(row.supersedes);
			if (predecessor) predecessor.entry = { ...predecessor.entry, superseded_by: row.id };
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
		// The row is in. Throwing now is a connection lost after the commit: the caller
		// gets an exception and the entry exists anyway.
		if (this.failAfterInsert) throw new Error(this.failAfterInsert);
		return { ok: true, entry };
	}

	async readEntry(id: string): Promise<MemoryEntry | null> {
		if (this.failReadEntry) throw new Error(this.failReadEntry);
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
		this.reviews.push({ ...row, state: "pending", entry_id: null, created: this.clock });
		return row.id;
	}

	async releaseReviews(entryHash: string, entryId: string): Promise<number> {
		if (this.failReleaseReviews) throw new Error(this.failReleaseReviews);
		const entry = this.rows.get(entryId);
		if (!entry) return 0;
		let released = 0;
		for (const review of this.reviews) {
			if (review.entry_hash !== entryHash || review.state !== "pending") continue;
			// The real store's conditions, because they are what stops an entry resolving
			// a proposal it does not answer — see `releaseReviews` there.
			if (review.created > Date.parse(entry.entry.created)) continue;
			if (review.ttl !== entry.entry.ttl) continue;
			review.state = "approved";
			review.entry_id = entryId;
			released++;
		}
		return released;
	}
}

let store: FakeStore;
let ids: number;
/** Event ids the stand-in ledger will confirm. Empty, unless a test says otherwise. */
let knownEvents: Set<string>;
/** Set to make the ledger lookup throw, which must read as "unconfirmed". */
let ledgerFails: string | null;

beforeEach(() => {
	store = new FakeStore();
	ids = 0;
	knownEvents = new Set();
	ledgerFails = null;
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
			verifySourceEvent: async (eventId) => {
				if (ledgerFails) throw new Error(ledgerFails);
				return knownEvents.has(eventId);
			},
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

	test("approving the same content twice is honest about what is stored", async () => {
		// The same race one step on: the second proposal exists (parked before this fix,
		// or by a store that allows it), and a reviewer approves it. The entry commits
		// first and the proposal is resolved after, so a failure to resolve must never
		// read back to the caller as "nothing was stored".
		const request = { scope: "global", kind: "fact" as const, text: "eight agents share one host" };
		await write(request);
		const first = await write({ ...request, review_token: REVIEW_TOKEN });
		store.reviews.push({ ...store.reviews[0]!, id: "memr_stale", state: "pending", entry_id: null });

		store.clock += DERIVED_KEY_WINDOW_MS + 1;
		const second = await write({ ...request, review_token: REVIEW_TOKEN });

		expect(second.outcome).toBe("accepted");
		expect(second.verified_persisted).toBe(true);
		expect(second.entry?.id).not.toBe(first.entry?.id);
		// Both proposals are resolved, and the second approval is recorded beside the
		// first rather than colliding with it.
		expect(store.reviews.every((review) => review.state === "approved")).toBe(true);
	});

	test("a proposal that cannot be resolved is not reported as a write that did not happen", async () => {
		// The repeat-approval bug, at its root. Approving content that was approved
		// before used to raise a duplicate key on the reviews table — *after* the entry
		// had committed and the claim recorded it — and the caller was told nothing was
		// stored. The index no longer collides, and this proves the caller is told the
		// truth even when resolving the proposal fails for some other reason.
		const request = { scope: "global", kind: "fact" as const, text: "eight agents share one host" };
		await write(request);
		store.failReleaseReviews = "reviews table unavailable";

		const approved = await write({ ...request, review_token: REVIEW_TOKEN });

		expect(approved.outcome).toBe("accepted");
		expect(approved.verified_persisted).toBe(true);
		expect(store.standing()).toHaveLength(1);
		// The proposal stays pending — a reviewer sees a stale row, which is a far
		// smaller problem than an agent believing its memory was not stored.
		expect(store.reviews[0]?.state).toBe("pending");
	});

	test("a retry clears the proposal that the write could not resolve", async () => {
		// The other half of guarding that call: the stale row has to be cleared by
		// something, and nothing else ever reaches it — an explicit key replays for
		// ever and never runs the accepted path again. So the retry reconciles.
		const request = {
			scope: "global",
			kind: "fact" as const,
			text: "eight agents share one host",
			review_token: REVIEW_TOKEN,
			idempotency_key: "k-review",
		};
		await write({ ...request, review_token: undefined });
		store.failReleaseReviews = "reviews table unavailable";
		const installed = await write(request);
		expect(installed.outcome).toBe("accepted");
		expect(store.reviews[0]?.state).toBe("pending");

		store.failReleaseReviews = null;
		const retried = await write(request);

		expect(retried.reason).toBe("idempotent.replay");
		expect(retried.entry?.id).toBe(installed.entry?.id);
		expect(store.reviews[0]?.state).toBe("approved");
		expect(store.reviews[0]?.entry_id).toBe(installed.entry?.id);
		// And nothing was written a second time to achieve it.
		expect(store.standing()).toHaveLength(1);
	});

	test("a replay does not approve a proposal raised after its entry", async () => {
		// The reconciliation above must resolve the proposal its own write left behind,
		// not whatever shares the content hash. A replay carries no review token — the
		// token is not part of the request identity — so without this it is a way to
		// take a live request out of a reviewer's queue: the proposal is marked approved
		// against an entry that does not hold what it asked for, and nobody ever sees it.
		const request = {
			scope: "global",
			kind: "fact" as const,
			text: "eight agents share one host",
			idempotency_key: "k-installed",
		};
		const installed = await write({ ...request, review_token: REVIEW_TOKEN });
		expect(installed.outcome).toBe("accepted");

		// Later, the same words are proposed again — but kept for 30 days rather than
		// for ever, which is a different ask and one the queue does record.
		store.clock += 1000;
		const proposed = await write({ ...request, ttl: "30d", idempotency_key: "k-30d" });
		expect(proposed.reason).toBe("review.required");

		const replayed = await write({ ...request, review_token: REVIEW_TOKEN });

		expect(replayed.reason).toBe("idempotent.replay");
		// Still pending, still a reviewer's to decide.
		expect(store.reviews.find((review) => review.ttl === "30d")?.state).toBe("pending");
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
		// The version to re-submit against travels with the refusal, so the caller does
		// not have to find the decision again — a search it may not be able to win.
		expect(second.current_version).toBe(1);
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("the runtime is herdr");
	});

	test("a stale expectation is a conflict that says what the current version is", async () => {
		await write({ ...decision, text: "the runtime is herdr" });
		const stale = await write({ ...decision, text: "the runtime is Orca", expected_version: 7 });
		expect(stale.reason).toBe("version.stale");
		expect(stale.remedy).toContain("version 1");
		expect(stale.current_version).toBe(1);
	});

	test("expecting a version where nothing is in force is a conflict too", async () => {
		const result = await write({ ...decision, text: "the runtime is Orca", expected_version: 3 });
		expect(result.reason).toBe("version.stale");
		// Present and null: nothing is in force, so the re-submit carries no expectation.
		expect(result).toHaveProperty("current_version", null);
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

	test("two first decisions for one subject race cleanly, and the loser may retry at once", async () => {
		// Different idempotency keys, same subject, nothing in force yet. Neither write
		// retires a predecessor, so neither `standing-moved` check fires and nothing in
		// the plan tells them apart — the identity goes to whichever insert reaches the
		// unique index first. The loser used to get a raw duplicate-key error out of the
		// store, which the gate cannot tell from a lost connection over a committed row:
		// it held the key in flight, so the retry its remedy asked for was refused until
		// the takeover timeout.
		const hook = store.onInsert;
		store.onInsert = async () => {
			store.onInsert = hook;
			await write({ ...decision, text: "the runtime is Orca", idempotency_key: "winner" });
		};

		const loser = await write({ ...decision, text: "the runtime is herdr", idempotency_key: "loser" });

		expect(loser.outcome).toBe("conflict");
		expect(loser.reason).toBe("standing.raced");
		expect(loser.conflict_with).toBe(store.standing()[0]?.id);
		expect(loser.remedy).toContain("expected_version");
		expect(loser.current_version).toBe(1);
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("the runtime is Orca");

		// Refused, not in flight: the key records a conflict, so the same key is takeable
		// now rather than after IN_FLIGHT_TIMEOUT_MS.
		expect(store.writes.get("loser")?.outcome).toBe("conflict");
		const retry = await write({
			...decision,
			text: "the runtime is herdr",
			expected_version: 1,
			idempotency_key: "loser",
		});
		expect(retry.outcome).toBe("accepted");
		expect(retry.entry?.version).toBe(2);
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
		// The entry it was replacing is retired and nothing replaced it here, so nothing
		// is in force now — said as null rather than left out.
		expect(result).toHaveProperty("current_version", null);
		expect(result.remedy).toContain("without expected_version");
	});

	test("a decision replaced under a write reports the version in force now, not the one it read", async () => {
		const first = await write({ ...decision, text: "the runtime is herdr" });
		// Another rewrite against the same v1 lands between this write's read and its
		// insert. The real store retires the predecessor before it inserts, so it finds
		// v1 already retired and answers `standing-moved` — a version race, not the
		// identity race the winner's row would suggest if the insert were checked first.
		const hook = store.onInsert;
		store.onInsert = async () => {
			store.onInsert = hook;
			await write({ ...decision, text: "the runtime is Orca", expected_version: 1, idempotency_key: "winner" });
		};

		const loser = await write({
			...decision,
			text: "the runtime is Zellij",
			expected_version: 1,
			idempotency_key: "loser",
		});

		expect(loser.outcome).toBe("conflict");
		expect(loser.reason).toBe("version.raced");
		// The version to re-submit against is the winner's, not the v1 this write read.
		expect(loser.current_version).toBe(2);
		// `conflict_with` names the entry this write was replacing.
		expect(loser.conflict_with).toBe(first.entry?.id);
		// Rolled back, retire included: the winner stays in force and v1 stays retired by it.
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("the runtime is Orca");
		expect(store.entries()).toHaveLength(2);
		expect(store.writes.get("loser")?.outcome).toBe("conflict");

		const retry = await write({
			...decision,
			text: "the runtime is Zellij",
			expected_version: loser.current_version ?? undefined,
			idempotency_key: "loser",
		});
		expect(retry.outcome).toBe("accepted");
		expect(retry.entry?.version).toBe(3);
	});

	test("a race whose winner cannot be looked up leaves current_version out rather than reporting none", async () => {
		// Null would tell the caller to re-submit with no expectation against a decision
		// that may well be in force. Absence sends it back to reading instead.
		const hook = store.onInsert;
		store.onInsert = async () => {
			store.onInsert = hook;
			await write({ ...decision, text: "the runtime is Orca", idempotency_key: "winner" });
			store.failStanding = "postgres: connection reset";
		};

		const loser = await write({ ...decision, text: "the runtime is herdr", idempotency_key: "loser" });

		expect(loser.reason).toBe("standing.raced");
		expect("current_version" in loser).toBe(false);
		expect(loser.remedy).toContain("re-read");
	});

	test("a superseding race whose lookup fails leaves current_version out too", async () => {
		await write({ ...decision, text: "the runtime is herdr" });
		const read = store.standingEntry.bind(store);
		store.standingEntry = async (key) => {
			const found = await read(key);
			const held = found ? store.rows.get(found.id) : undefined;
			if (held) held.entry = { ...held.entry, superseded_by: "mem_someone-else" };
			// Only the gate's first read succeeds; the lookup after the race does not.
			store.failStanding = "postgres: connection reset";
			return found;
		};

		const result = await write({ ...decision, text: "the runtime is Orca", expected_version: 1 });

		expect(result.reason).toBe("version.raced");
		expect("current_version" in result).toBe(false);
		expect(result.remedy).toContain("re-read");
	});

	test("a conflict that is not about a version carries no current_version", async () => {
		const parked = await write({
			scope: "global",
			kind: "decision",
			subject: "runtime",
			text: "Greptime is the events ledger only",
		});
		expect(parked.reason).toBe("review.required");
		expect("current_version" in parked).toBe(false);

		await store.claimWrite({ key: "k1", explicit: true, entryHash: "whatever", entryId: "mem_someone-else" });
		const busy = await write({ ...decision, text: "the runtime is herdr", idempotency_key: "k1" });
		expect(busy.reason).toBe("write.in-flight");
		expect("current_version" in busy).toBe(false);
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

	test("two first todos for one subject race cleanly too", async () => {
		// Last-write-wins is not an excuse to skip the race: the second writer still has
		// to see the entry it is replacing, and a todo that vanished into a store error
		// is a todo nobody does.
		const hook = store.onInsert;
		store.onInsert = async () => {
			store.onInsert = hook;
			await write({ ...todo, text: "regenerate the lockfile", idempotency_key: "winner" });
		};

		const loser = await write({ ...todo, text: "bump the lockfile by hand", idempotency_key: "loser" });

		expect(loser.outcome).toBe("conflict");
		expect(loser.reason).toBe("standing.raced");
		expect(loser.strategy).toBe("lww");
		// Not a versioned write, so there is no version to report.
		expect("current_version" in loser).toBe(false);
		expect(store.standing()).toHaveLength(1);

		// And the retry, which for `lww` needs no version, replaces it.
		const retry = await write({ ...todo, text: "bump the lockfile by hand", idempotency_key: "loser" });
		expect(retry.outcome).toBe("accepted");
		expect(store.standing()).toHaveLength(1);
		expect(store.standing()[0]?.text).toBe("bump the lockfile by hand");
	});

	test("a different subject is a different todo", async () => {
		await write({ ...todo, text: "regenerate the lockfile" });
		await write({ scope: "repo:a/b", kind: "todo", subject: "backfill", text: "re-run the backfill" });
		expect(store.standing()).toHaveLength(2);
	});
});

describe("accepted — appending kinds carry no conflict identity", () => {
	test("two warnings about one subject are two warnings", async () => {
		// The break this fixes: an appending kind was still stamped with a conflict key,
		// and `memory_standing_idx` is unique over the entries in force — so the second
		// warning about one subject became a store error instead of a second warning.
		const first = await write({ scope: "repo:a/b", kind: "warning", subject: "poller", text: "the poller 401s" });
		const second = await write({
			scope: "repo:a/b",
			kind: "warning",
			subject: "poller",
			text: "the poller 401s again after the rotate",
		});

		expect(first.outcome).toBe("accepted");
		expect(second.outcome).toBe("accepted");
		expect(second.strategy).toBe("append");
		expect(store.standing()).toHaveLength(2);
	});

	test("nor do facts or handoffs", async () => {
		for (const kind of ["fact", "handoff"] as const) {
			await write({ scope: "graph:ut-1", kind, subject: "n2", text: `first ${kind}` });
			expect((await write({ scope: "graph:ut-1", kind, subject: "n2", text: `second ${kind}` })).outcome).toBe(
				"accepted",
			);
		}
		expect(store.standing()).toHaveLength(4);
	});

	test("the row itself records no identity, which is what the index cares about", async () => {
		await write({ scope: "repo:a/b", kind: "warning", subject: "poller", text: "the poller 401s" });
		const held = [...store.rows.values()][0];
		expect(held?.conflict_key).toBeNull();
	});
});

describe("claim ownership", () => {
	test("a timed-out writer cannot finish the claim that replaced it", async () => {
		// Identifying a claim by key alone lets a slow attempt come back and record its
		// outcome over its successor's, so the idempotency record ends up pointing at the
		// wrong entry — or at nothing.
		const first = await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: "mem_a" });
		if (!first.claimed) throw new Error("the first claim should have been granted");

		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const second = await store.claimWrite({ key: "k1", explicit: true, entryHash: "h2", entryId: "mem_b" });
		if (!second.claimed) throw new Error("a stale claim should be takeable");

		// The original, still running, now tries to finish and then to release.
		await store.finishWrite("k1", first.holder, "accepted", "mem_a");
		await store.releaseWrite("k1", first.holder);

		const record = store.writes.get("k1");
		expect(record?.holder).toBe(second.holder);
		expect(record?.outcome).toBe("in-flight");
		// And the reservation is the one it inherited, not the successor's own: `mem_a` may
		// already exist, so the pointer to it survives the hand-over.
		expect(record?.entry_id).toBe("mem_a");
		expect(second.tookOverFrom).toBe("mem_a");
	});

	test("an inherited reservation is used for the insert, not a fresh id", async () => {
		// Two reasons, and the second is the better one: the claim row already points at
		// this id, so a crash stays recoverable without another write; and a fenced-out
		// attempt that is still alive collides on the primary key instead of adding a row.
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: "mem_reserved" });
		store.clock += IN_FLIGHT_TIMEOUT_MS;

		const result = await write({ idempotency_key: "k1" });

		expect(result.entry?.id).toBe("mem_reserved");
		expect(store.entries()).toHaveLength(1);
	});

	test("a read that fails is not evidence the row is absent", async () => {
		// The duplicate this prevents: swallowing the read error made a transient failure
		// look like "nothing was written", so the retry inserted a second entry under a key
		// that already had one. Failing the write costs a retry; a duplicate memory cannot
		// be taken back.
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: "mem_maybe" });
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		store.failReadEntry = "postgres: connection reset";

		await expect(write({ idempotency_key: "k1" })).rejects.toThrow("connection reset");
		expect(store.entries()).toEqual([]);
		// And the reservation survives the failure, so the next retry looks for the same
		// row rather than starting a fresh one it would then duplicate.
		expect(store.writes.get("k1")?.entry_id).toBe("mem_maybe");
	});

	test("recovering a reviewed global write also closes its proposal", async () => {
		// The acknowledgement died, not the review. Leaving the proposal pending would have
		// a reviewer weighing a decision that is already in force.
		const global = { scope: "global", kind: "decision" as const, text: "Greptime is the events ledger only" };
		await write(global);
		expect(store.reviews[0]?.state).toBe("pending");

		store.failFinish = "postgres: connection reset";
		await expect(write({ ...global, review_token: REVIEW_TOKEN, idempotency_key: "k1" })).rejects.toThrow();

		store.failFinish = null;
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const recovered = await write({ ...global, review_token: REVIEW_TOKEN, idempotency_key: "k1" });

		expect(recovered.reason).toBe("recovered.orphan");
		expect(store.reviews[0]?.state).toBe("approved");
		expect(store.reviews[0]?.entry_id).toBe(recovered.entry?.id);
	});

	test("a timed-out writer cannot land the row either, not just the bookkeeping", async () => {
		// Fencing `finishWrite` and `releaseWrite` stops a slow attempt corrupting the
		// claim *record*. It does not stop the attempt reaching the insert — it is still
		// running, and nothing on that path had asked whether it still held the key. For
		// an appending kind that is two visible entries for one write, which is the
		// duplicate the claim exists to prevent. So the insert is fenced too.
		store.onInsert = async () => {
			store.onInsert = null;
			store.clock += IN_FLIGHT_TIMEOUT_MS;
			// A retry decides the claim is abandoned and takes it over, mid-insert.
			await store.claimWrite({ key: "k1", explicit: true, entryHash: "h2", entryId: "mem_retry" });
		};

		const result = await write({ kind: "warning", subject: "poller", idempotency_key: "k1" });

		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("write.superseded");
		expect(store.entries()).toEqual([]);
		// And the successor's claim is untouched: still in flight, and still holding the
		// reservation it inherited, so the retry writes that row exactly once.
		const record = store.writes.get("k1");
		expect(record?.outcome).toBe("in-flight");
		expect(record?.entry_id).toBe("mem_1");
		// And the remedy must not send the caller to a fresh key. The retry that owns this
		// one may already have written the entry, so for an appending kind a fresh key is
		// how a caller turns one write into two by following our own advice.
		expect(result.remedy).toContain("same idempotency_key");
		expect(result.remedy).not.toMatch(/(?:write|submit|try) again (?:under|with) a (?:fresh|new)/i);
	});

	test("a claim reserves the row it will write, so an unacknowledged commit is findable", async () => {
		const claim = await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: "mem_a" });
		expect(claim.claimed).toBe(true);
		expect(store.writes.get("k1")?.entry_id).toBe("mem_a");
	});

	test("a committed write that was never acknowledged is recovered, not written twice", async () => {
		// The gap: the insert commits, then the acknowledgement throws. Releasing the key
		// would let the retry insert a second visible entry; this keeps the claim and has
		// the successor look for the row the dead attempt reserved.
		store.failFinish = "postgres: connection reset";
		await expect(write({ idempotency_key: "k1" })).rejects.toThrow("connection reset");
		expect(store.entries()).toHaveLength(1);
		// The claim is deliberately *not* released — an abandoned claim is recoverable,
		// a duplicate entry is not.
		expect(store.writes.get("k1")?.outcome).toBe("in-flight");

		store.failFinish = null;
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const retry = await write({ idempotency_key: "k1" });

		expect(retry.outcome).toBe("accepted");
		expect(retry.reason).toBe("recovered.orphan");
		expect(retry.deduplicated).toBe(true);
		expect(retry.verified_persisted).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("taking over a claim whose row never landed just writes it", async () => {
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: "mem_never" });
		store.clock += IN_FLIGHT_TIMEOUT_MS;

		const result = await write({ idempotency_key: "k1" });

		expect(result.outcome).toBe("accepted");
		expect(result.reason).toBe("accepted");
		expect(store.entries()).toHaveLength(1);
	});

	test("a recovered reservation holding another write's content is never this write's", async () => {
		// Defence in depth for a claim raised before `request_hash` was recorded: the store
		// cannot tell those two asks apart, so the gate compares the content it recovered
		// before calling it this request's. `accepted` here would be the same falsehood by
		// a different road — a caller handed somebody else's entry as proof of its own write.
		const other = await write({ text: "hermes finished n2" });
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "h1", entryId: String(other.entry?.id) });
		store.clock += IN_FLIGHT_TIMEOUT_MS;

		const result = await write({ idempotency_key: "k1", text: "omp finished n4" });

		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("idempotency.reused");
		expect(result.conflict_with).toBe(String(other.entry?.id));
		expect(result.verified_persisted).toBe(false);
		expect(result.entry).toBeUndefined();
		expect(store.entries()).toHaveLength(1);
	});

	test("an aged-out derived key is a new write, not an orphan to recover", async () => {
		// The row from the earlier write is still in force; the point of the expiry is
		// that the same fact may be stated again, so the old entry must not be replayed.
		const first = await write();
		store.clock += DERIVED_KEY_WINDOW_MS + 1;
		const later = await write();

		expect(later.deduplicated).toBeUndefined();
		expect(later.entry?.id).not.toBe(first.entry?.id);
		expect(store.entries()).toHaveLength(2);
	});
});

describe("exactly-once", () => {
	test("a key already spent on different content is a conflict, not a success", async () => {
		// The dishonest version reported `accepted` and handed back the *other* write's
		// entry. A caller that asked to store B and is told "accepted" will believe B is in
		// force; nothing in the system would contradict it. No remedy makes that honest.
		const first = await write({ idempotency_key: "k1", text: "hermes finished n2" });
		const second = await write({ idempotency_key: "k1", text: "omp finished n4" });

		expect(second.outcome).toBe("conflict");
		expect(second.reason).toBe("idempotency.reused");
		expect(second.conflict_with).toBe(first.entry?.id ?? "");
		expect(second.entry).toBeUndefined();
		expect(second.verified_persisted).toBe(false);
		expect(store.entries()).toHaveLength(1);
	});

	test("a key whose write lost its acknowledgement cannot be taken over for other content", async () => {
		// The takeover this closes. A commits and then dies before acknowledging itself, so
		// its claim is left in flight still pointing at A's row. B arrives on the same key,
		// inherits that pointer and stamps its own hashes over the record — which now reads
		// "this key was spent on B, and the row it wrote is A". Recovery hands A back, and
		// B's next retry is told `accepted` / `verified_persisted: true` for a write that
		// never happened. Exactly-once survived; the verified acknowledgement did not.
		store.failFinish = "postgres: connection reset";
		await expect(write({ idempotency_key: "k1", text: "hermes finished n2" })).rejects.toThrow("connection reset");
		const committed = store.entries()[0];
		expect(store.writes.get("k1")?.outcome).toBe("in-flight");

		store.failFinish = null;
		store.clock += IN_FLIGHT_TIMEOUT_MS;

		const takeover = await write({ idempotency_key: "k1", text: "omp finished n4" });
		expect(takeover.outcome).toBe("conflict");
		expect(takeover.reason).toBe("idempotency.reused");
		expect(takeover.verified_persisted).toBe(false);
		expect(takeover.entry).toBeUndefined();
		// The reservation is untouched, so it still names the row that was actually written.
		expect(store.writes.get("k1")?.entry_id).toBe(String(committed?.id));

		// The replay is where the lie used to surface: B asks again and the record, now
		// carrying B's hashes and A's entry id, answers for a write nobody made.
		const retry = await write({ idempotency_key: "k1", text: "omp finished n4" });
		expect(retry.outcome).toBe("conflict");
		expect(retry.reason).toBe("idempotency.reused");
		expect(retry.verified_persisted).toBe(false);
		expect(retry.entry).toBeUndefined();

		// Nothing of B's is in the index, on either answer.
		expect(store.entries()).toHaveLength(1);
		expect(store.entries()[0]?.text).toBe("hermes finished n2");

		// And the key is not bricked for the write that spent it: A's own retry still finds
		// the row its dead attempt left behind, rather than writing a second one.
		const recovered = await write({ idempotency_key: "k1", text: "hermes finished n2" });
		expect(recovered.outcome).toBe("accepted");
		expect(recovered.reason).toBe("recovered.orphan");
		expect(recovered.entry?.id).toBe(String(committed?.id));
		expect(recovered.verified_persisted).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("a claim recorded before request_hash is not a wildcard the next write can spend", async () => {
		// The strand this closes. A record predating `request_hash` carries no identity, and
		// reading that absence as "matches whoever asks" let any write take the claim over,
		// stamp its own hashes on it and keep A's reservation. The gate then refused to hand
		// A's row back — rightly, it is A's — but the rewritten claim was left in flight, so
		// A's own retry read a key spent on a different ask, was told `idempotency.reused`,
		// and could never reach the row it had already committed. `verified_persisted` was
		// out of reach for a write that had in fact landed.

		// A commits its row and dies before acknowledging it, leaving a claim that still
		// reserves that row — and, being of the older shape, records no identity for it.
		store.failFinish = "postgres: connection reset";
		await expect(write({ idempotency_key: "k1", text: "hermes finished n2" })).rejects.toThrow("connection reset");
		store.failFinish = null;
		const committed = store.entries()[0];
		const legacy = store.writes.get("k1");
		if (!committed || !legacy) throw new Error("the first attempt should have left a row and its claim");
		store.writes.set("k1", { ...legacy, request_hash: null });

		store.clock += IN_FLIGHT_TIMEOUT_MS;

		// A stranger on the same key is told what the key was spent on, not given it.
		const stranger = await write({ idempotency_key: "k1", text: "omp finished n4" });
		expect(stranger.outcome).toBe("conflict");
		expect(stranger.reason).toBe("idempotency.reused");
		expect(stranger.conflict_with).toBe(committed.id);
		expect(stranger.verified_persisted).toBe(false);
		expect(stranger.entry).toBeUndefined();

		// And the claim is untouched: no identity of the stranger's on it, still reserving
		// the row that was written. That is what keeps the next assertion possible.
		const after = store.writes.get("k1");
		expect(after?.request_hash).toBeNull();
		expect(after?.entry_id).toBe(committed.id);
		expect(after?.entry_hash).toBe(legacy.entry_hash);

		// So the write that made the claim still recovers its own committed row.
		const recovered = await write({ idempotency_key: "k1", text: "hermes finished n2" });
		expect(recovered.outcome).toBe("accepted");
		expect(recovered.reason).toBe("recovered.orphan");
		expect(recovered.entry?.id).toBe(committed.id);
		expect(recovered.verified_persisted).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("a reservation the gate will not honour is handed back, not held on to", async () => {
		// Defence in depth for the rule above. A store that parts with a reservation only to
		// the write that made it never gets here; the gate checks anyway, and refusing is
		// only half the answer. Keeping the claim would leave it in flight carrying this
		// request's hashes over another write's row — the exact record that locks that write
		// out of its own entry. So it goes back to what it reserved, and this attempt lets go.
		store.legacyClaimsMatchAnyAsk = true;

		store.failFinish = "postgres: connection reset";
		await expect(write({ idempotency_key: "k1", text: "hermes finished n2" })).rejects.toThrow("connection reset");
		store.failFinish = null;
		const committed = store.entries()[0];
		const legacy = store.writes.get("k1");
		if (!committed || !legacy) throw new Error("the first attempt should have left a row and its claim");
		store.writes.set("k1", { ...legacy, request_hash: null });

		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const stranger = await write({ idempotency_key: "k1", text: "omp finished n4" });
		expect(stranger.reason).toBe("idempotency.reused");

		const after = store.writes.get("k1");
		expect(after?.request_hash).toBeNull();
		expect(after?.entry_id).toBe(committed.id);
		expect(after?.entry_hash).toBe(committed.entry_hash);
		// Held by nobody: neither this attempt nor the one it displaced can finish it.
		expect(after?.holder).not.toBe(legacy.holder);

		store.legacyClaimsMatchAnyAsk = false;
		const recovered = await write({ idempotency_key: "k1", text: "hermes finished n2" });
		expect(recovered.outcome).toBe("accepted");
		expect(recovered.reason).toBe("recovered.orphan");
		expect(recovered.entry?.id).toBe(committed.id);
		expect(recovered.verified_persisted).toBe(true);
		expect(store.entries()).toHaveLength(1);
	});

	test("the same words asking for a different ttl is a different request", async () => {
		// The lie this closes: the content hash does not cover `ttl`, so the reply came
		// back `accepted` / `verified_persisted: true` while the stored row still said 30d.
		// The caller asked for permanent retention, was told its write landed, and would
		// have believed the entry outlives the month.
		await write({ idempotency_key: "k1", ttl: "30d" });
		const second = await write({ idempotency_key: "k1", ttl: "permanent" });

		expect(second.outcome).toBe("conflict");
		expect(second.reason).toBe("idempotency.reused");
		expect(second.remedy).toContain("ttl");
		expect(store.entries()).toHaveLength(1);
		expect(store.entries()[0]?.ttl).toBe("30d");
	});

	test("the same words asking for different trust is a different request", async () => {
		// Same shape, and worse in effect: a reviewer's escalation silently not happening
		// leaves the entry at agent-claimed with a reply that says otherwise.
		await write({ idempotency_key: "k1" });
		const escalated = await write({
			idempotency_key: "k1",
			trust: "human-confirmed",
			review_token: REVIEW_TOKEN,
		});

		expect(escalated.outcome).toBe("conflict");
		expect(escalated.reason).toBe("idempotency.reused");
		expect(store.entries()[0]?.trust).toBe("agent-claimed");
	});

	test("a retry from a new session is still the same request", async () => {
		// The other side of the line. A hook retrying after a restart arrives in a new
		// session, and the session that wrote the row is honestly the one recorded — so
		// this must replay, not refuse.
		const first = await write({ idempotency_key: "k1", session_id: "sess-1" });
		const retry = await write({ idempotency_key: "k1", session_id: "sess-2" });

		expect(retry.outcome).toBe("accepted");
		expect(retry.deduplicated).toBe(true);
		expect(retry.entry?.id).toBe(first.entry?.id);
		expect(store.entries()).toHaveLength(1);
	});

	test("the same explicit key never writes twice", async () => {
		// A true retry: same key, same content. The reply is the first write's entry, and
		// the second call is a read rather than a write.
		const first = await write({ idempotency_key: "k1" });
		const second = await write({ idempotency_key: "k1" });

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
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "whatever", entryId: "mem_someone-else" });
		const result = await write({ idempotency_key: "k1" });
		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("write.in-flight");
		expect(store.entries()).toEqual([]);
	});

	test("an abandoned claim is taken over once it is stale", async () => {
		await store.claimWrite({ key: "k1", explicit: true, entryHash: "whatever", entryId: "mem_someone-else" });
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		expect((await write({ idempotency_key: "k1" })).outcome).toBe("accepted");
	});

	test("a failure before the insert releases its key, so the retry is not a replay of nothing", async () => {
		// Nothing can have been written yet, so burning the key would cost a real write
		// and buy nothing.
		store.failStanding = "postgres: connection reset";
		await expect(write({ kind: "todo", subject: "poller", idempotency_key: "k1" })).rejects.toThrow(
			"connection reset",
		);
		expect(store.writes.size).toBe(0);

		store.failStanding = null;
		const retry = await write({ kind: "todo", subject: "poller", idempotency_key: "k1" });
		expect(retry.outcome).toBe("accepted");
		expect(retry.deduplicated).toBeUndefined();
	});

	test("an insert that throws keeps its key, because the row may have landed anyway", async () => {
		// A connection lost during the commit throws *and* commits. The exception cannot
		// tell the two apart, so the claim is held from the attempt rather than from the
		// return — releasing it here is how one write becomes two entries.
		store.failInsert = "postgres: connection reset";
		await expect(write({ kind: "warning", subject: "poller", idempotency_key: "k1" })).rejects.toThrow(
			"connection reset",
		);
		expect(store.writes.get("k1")?.outcome).toBe("in-flight");

		store.failInsert = null;
		// Immediately, the key is still held and the caller is told to wait rather than
		// being handed a second attempt at a write that might already exist.
		const early = await write({ kind: "warning", subject: "poller", idempotency_key: "k1" });
		expect(early.outcome).toBe("conflict");
		expect(early.reason).toBe("write.in-flight");

		// Past the timeout the successor takes over, finds no row under the id the dead
		// attempt reserved, and writes it once.
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const retry = await write({ kind: "warning", subject: "poller", idempotency_key: "k1" });
		expect(retry.outcome).toBe("accepted");
		expect(store.entries()).toHaveLength(1);
	});

	test("a commit that threw is recovered by the retry, not written a second time", async () => {
		// The other half of the same in-doubt window, and the one that actually duplicates:
		// the row *did* land. An appending kind has nothing to collide on, so a second
		// insert is simply a second warning about one thing — invisible until an agent
		// reads its brief and sees it twice.
		store.failAfterInsert = "postgres: connection reset";
		await expect(write({ kind: "warning", subject: "poller", idempotency_key: "k1" })).rejects.toThrow(
			"connection reset",
		);
		expect(store.entries()).toHaveLength(1);
		expect(store.writes.get("k1")?.outcome).toBe("in-flight");

		store.failAfterInsert = null;
		store.clock += IN_FLIGHT_TIMEOUT_MS;
		const retry = await write({ kind: "warning", subject: "poller", idempotency_key: "k1" });

		expect(retry.outcome).toBe("accepted");
		expect(retry.reason).toBe("recovered.orphan");
		expect(retry.deduplicated).toBe(true);
		expect(store.entries()).toHaveLength(1);
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
		expect(retry.remedy).toContain("no longer in the index");
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

	test("verified-by-test needs an event the ledger confirms, not just a string", async () => {
		// The hole this closes: any nonempty `source_event` used to buy the verified label
		// and its longer shelf life. An id nobody looked up is an assertion, not provenance.
		expect((await write({ trust: "verified-by-test" })).entry?.trust).toBe("agent-claimed");

		const invented = await write({ trust: "verified-by-test", source_event: "evt_i-made-this-up" });
		expect(invented.entry?.trust).toBe("agent-claimed");
		expect(invented.trust_downgraded_from).toBe("verified-by-test");

		knownEvents.add("evt_9");
		const proven = await write({ trust: "verified-by-test", source_event: "evt_9" });
		expect(proven.entry?.trust).toBe("verified-by-test");
		expect(proven.trust_downgraded_from).toBeUndefined();
	});

	test("a ledger that cannot answer means unconfirmed, not assumed", async () => {
		ledgerFails = "greptime unreachable";
		knownEvents.add("evt_9");
		const result = await write({ trust: "verified-by-test", source_event: "evt_9" });
		expect(result.outcome).toBe("accepted");
		expect(result.entry?.trust).toBe("agent-claimed");
		expect(result.trust_downgraded_from).toBe("verified-by-test");
	});

	test("the ledger is consulted only when the answer could matter", async () => {
		// An ordinary write must not pay a round trip for a claim it is not making.
		const asked: string[] = [];
		const result = await governMemoryWrite(
			{ scope: "graph:ut-1", kind: "fact", text: "hermes finished n2", writer: "hermes", source_event: "evt_9" },
			{
				store,
				isReviewToken: () => false,
				now: () => new Date(store.clock),
				newId: (prefix) => `${prefix}_${++ids}`,
				verifySourceEvent: async (eventId) => {
					asked.push(eventId);
					return true;
				},
			},
		);
		expect(result.outcome).toBe("accepted");
		expect(asked).toEqual([]);
	});

	test("the reply says which surface the write was attributed to", async () => {
		// A token overrides a caller-named surface, so the caller has to be told which
		// name RBAC was actually decided on.
		expect((await write({ writer: "omp" })).writer).toBe("omp");
		expect((await write({ writer: "unknown" })).writer).toBe("unknown");
		expect((await write({ scope: "nonsense" })).writer).toBe("hermes");
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

describe("swarm surfaces — default-deny proven from the outside (ADR 0001 S3)", () => {
	const swarm = (request: Partial<MemoryWriteRequest>) =>
		write({ writer: "swarm-a05-be", scope: "repo:acme/widgets", kind: "fact", ...request });
	// `accepted` alone is a governance verdict, not a durability claim: a success is only
	// a success when it was read back and the row is actually in the store.
	const expectStored = (result: MemoryWriteResult, scope: string, kind: MemoryKind) => {
		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);
		const row = store.rows.get(result.entry?.id ?? "");
		expect(row).toBeDefined();
		expect(row?.entry.scope).toBe(scope);
		expect(row?.entry.kind).toBe(kind);
		expect(row?.entry.writer).toBe("swarm-a05-be");
	};

	test("a swarm surface writes fact at graph, repo and its own agent scope, and decision at repo", async () => {
		for (const scope of ["repo:acme/widgets", "graph:ut-abc-0123abcd", "agent:swarm-a05-be"]) {
			const result = await swarm({ scope, text: `fact at ${scope}` });
			expectStored(result, scope, "fact");
		}
		const decision = await swarm({ kind: "decision", text: "use postgres" });
		expectStored(decision, "repo:acme/widgets", "decision");
		expect(store.entries()).toHaveLength(4);
	});

	test("another surface's agent scope, any person scope, and a decision at its own agent scope are refused", async () => {
		for (const scope of ["agent:swarm-a09-rev", "person:ove"]) {
			const result = await swarm({ scope, text: `refused at ${scope}` });
			expect(result.outcome).toBe("denied");
			expect(result.reason).toBe("rbac.no-grant");
		}
		const decision = await swarm({ scope: "agent:swarm-a05-be", kind: "decision", text: "use postgres" });
		expect(decision.outcome).toBe("denied");
		expect(decision.reason).toBe("rbac.no-grant");
		expect(store.entries()).toEqual([]);
	});

	test("teachable is not a memory kind, so it is refused before any grant is consulted", async () => {
		const result = await swarm({ kind: "teachable" as never });
		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("kind.unknown");
		expect(store.entries()).toEqual([]);
	});

	test("an unauthenticated caller is still refused where a swarm surface is not", async () => {
		const result = await swarm({ writer: "unknown" });
		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("rbac.no-grant");
		expect(store.entries()).toEqual([]);
	});

	test("a global write by a swarm surface is a proposal, not an entry, without a reviewer token", async () => {
		const result = await swarm({ scope: "global", text: "swarm-wide pattern" });
		expect(result.outcome).toBe("conflict");
		expect(result.reason).toBe("review.required");
		expect(result.verified_persisted).toBe(false);
		expect(result.review_id).toBe(store.reviews[0]?.id);
		expect(store.reviews[0]?.state).toBe("pending");
		expect(store.entries()).toEqual([]);

		const released = await swarm({ scope: "global", text: "swarm-wide pattern", review_token: REVIEW_TOKEN });
		expectStored(released, "global", "fact");
		expect(store.entries()).toHaveLength(1);
		// The proposal is released by the entry that answers it, not left pending beside it.
		expect(store.reviews).toHaveLength(1);
		expect(store.reviews[0]?.state).toBe("approved");
		expect(store.reviews[0]?.entry_id).toBe(released.entry?.id);
	});

	test("all 15 swarm surfaces hold working grants, own-agent only, and never person", () => {
		expect(SWARM_SURFACES).toHaveLength(15);
		const at = (surface: string, raw: string, kind: "decision" | "fact") => {
			const scope = parseScope(raw);
			if (!scope) throw new Error(raw);
			return grantFor(surface, scope, kind);
		};
		for (const surface of SWARM_SURFACES) {
			const other = SWARM_SURFACES.find((candidate) => candidate !== surface)!;
			for (const kind of ["decision", "fact"] as const) {
				expect(at(surface, "graph:ut-1", kind)).not.toBeNull();
				expect(at(surface, "repo:acme/widgets", kind)).not.toBeNull();
				expect(at(surface, `agent:${other}`, kind)).toBeNull();
				expect(at(surface, "person:ove", kind)).toBeNull();
			}
			expect(at(surface, `agent:${surface}`, "fact")).not.toBeNull();
			// a decision is never grantable at agent scope: it is shared, versioned standing.
			expect(at(surface, `agent:${surface}`, "decision")).toBeNull();
		}
		// Non-swarm surfaces are unchanged.
		expect(at("hermes", "agent:hermes", "fact")?.name).toBe("agent-self");
		expect(at("hermes", "repo:acme/widgets", "decision")?.name).toBe("repo-working");
	});
});
