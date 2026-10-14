/**
 * Shared teachable fixture corpus (Phase 29, D29-08).
 *
 * Every later assertion reuses these requests: the accepted teachable, one per
 * non-accepting outcome (refused, quarantined, conflict), and the
 * fold-collision pair that pins the skill-name numeric-suffix rule. Outcomes
 * are pinned by `teachable.test.ts` through `governMemoryWrite` over a
 * `FakeStore`, so the corpus cannot drift from the gate it exercises.
 */
import type { MemoryWriteRequest } from "./types.ts";

/** One corpus row: the request plus what the gate must answer for it. */
export interface TeachableFixture {
	/** Stable name tests address this row by. */
	name: string;
	request: MemoryWriteRequest;
	/** The gate outcome `teachable.test.ts` pins for this row. */
	outcome: "accepted" | "denied" | "quarantined" | "conflict";
	/** The slug `teachableSlug` must derive, or null when not a teachable. */
	slug: string | null;
}

const SCOPE = "graph:ut-teach";

/** The accepted teachable every emit, card, and anchor proof builds on. */
export const ACCEPTED_TEACHABLE: TeachableFixture = {
	name: "accepted",
	request: {
		scope: SCOPE,
		kind: "fact",
		text: "cap retries at three before paging the human",
		writer: "hermes",
		subject: "teachable:retry-budget",
		session_id: "sess-p29-teachable",
		graph_id: "ut-teach",
	},
	outcome: "accepted",
	slug: "retry-budget",
};

/** A teachable the gate refuses (no grant at this scope): no trail event. */
export const REFUSED_TEACHABLE: TeachableFixture = {
	name: "refused",
	request: {
		scope: "person:ove",
		kind: "fact",
		text: "cap retries at three before paging the human",
		writer: "hermes",
		subject: "teachable:retry-budget",
		session_id: "sess-p29-teachable",
		graph_id: "ut-teach",
	},
	outcome: "denied",
	slug: "retry-budget",
};

/** A teachable parked as a secret: quarantined, never emitted. */
export const QUARANTINED_TEACHABLE: TeachableFixture = {
	name: "quarantined",
	request: {
		scope: SCOPE,
		kind: "fact",
		text: "the deploy key is password: hunter2 — rotate it before teaching this",
		writer: "hermes",
		subject: "teachable:deploy-key",
		session_id: "sess-p29-teachable",
		graph_id: "ut-teach",
	},
	outcome: "quarantined",
	slug: "deploy-key",
};

/** A teachable proposed at global scope: conflict, never emitted. */
export const CONFLICT_TEACHABLE: TeachableFixture = {
	name: "conflict",
	request: {
		scope: "global",
		kind: "fact",
		text: "cap retries at three before paging the human",
		writer: "hermes",
		subject: "teachable:retry-budget",
		session_id: "sess-p29-teachable",
		graph_id: "ut-teach",
	},
	outcome: "conflict",
	slug: "retry-budget",
};

/**
 * Two subjects that fold onto one `SKILL_NAME_RE` name: the card builder must
 * keep both entries and disambiguate with a numeric suffix (U-04, pinned).
 */
export const FOLD_COLLISION_TEACHABLES: TeachableFixture[] = [
	{
		name: "fold-a",
		request: {
			scope: SCOPE,
			kind: "fact",
			text: "cap retries at three before paging the human",
			writer: "hermes",
			subject: "teachable:Retry-Budget",
			session_id: "sess-p29-teachable",
			graph_id: "ut-teach",
		},
		outcome: "accepted",
		slug: "retry-budget",
	},
	{
		name: "fold-b",
		request: {
			scope: SCOPE,
			kind: "fact",
			text: "budgets compose per surface, not per session",
			writer: "hermes",
			subject: "teachable:retry_budget",
			session_id: "sess-p29-teachable",
			graph_id: "ut-teach",
		},
		outcome: "accepted",
		slug: "retry_budget",
	},
];

/** The whole corpus in one list, fold pair included. */
export const TEACHABLE_FIXTURES: TeachableFixture[] = [
	ACCEPTED_TEACHABLE,
	REFUSED_TEACHABLE,
	QUARANTINED_TEACHABLE,
	CONFLICT_TEACHABLE,
	...FOLD_COLLISION_TEACHABLES,
];
