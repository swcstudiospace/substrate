/**
 * The authority of a document: one number in 0..1 that says how much a retrieval should trust it (v1.7 phase 66,
 * decision D66-4).
 *
 * Pure and deterministic: no clock, no randomness, no model. The caller measures the age and counts the feedback and this
 * module only combines them, so the same inputs always give the same score and the function tests without a store.
 *
 * score = (W_TIER * tier + W_KIND * kind + W_RECENCY * recency + W_FEEDBACK * feedback) * (superseded ? SUPERSEDED_FACTOR : 1)
 *
 * Every term is in 0..1 and the four weights sum to 1, so the score is in 0..1 without clamping.
 */
import type { DocKind, DocTier } from "./protocol.ts";

export interface FeedbackCounts {
	helpful: number;
	unhelpful: number;
	stale: number;
	wrong: number;
	duplicate: number;
}

export interface AuthorityInput {
	tier: DocTier;
	kind: DocKind;
	/** Whole or fractional days since the document last changed; null when unknown (a neutral recency, not the oldest). */
	ageDays: number | null;
	/** The key of the document that supersedes this one, or null. */
	supersededBy: string | null;
	feedback: FeedbackCounts;
}

/**
 * Why each constant is what it is. They are fixed numbers chosen by hand and kept in one place; nothing tunes them at
 * run time, so a score can always be reproduced from its inputs.
 */
export const AUTHORITY_WEIGHTS = {
	/** The tier is the owner's own statement of authority (classify.ts), so it carries the most weight. */
	tier: 0.35,
	/** Kind says how often a document states current truth (a STATE file does, an archive does not), a smaller signal than the tier. */
	kind: 0.2,
	/** Recency breaks ties between equal-tier documents; documents age slowly, so it weighs the least. */
	recency: 0.15,
	/** Feedback is evidence from use, which is the point of reflecting, so it is the second largest term. */
	feedback: 0.3,
	/** A superseded document keeps 40% of its score: still findable, always below the document that replaced it. */
	supersededFactor: 0.4,
	/** The recency term halves every year: a document untouched for a year is half as fresh as one written today. */
	recencyHalfLifeDays: 365,
	/** The recency of a document whose age is unknown: neither fresh nor stale. */
	unknownRecency: 0.5,
	/** Pseudo-counts on each side of the feedback ratio, so one vote cannot move a document from neutral to an extreme. */
	feedbackPrior: 2,
	/** How much one report of each negative kind counts against a document: a wrong document is worse than a duplicate one. */
	negativeCost: { unhelpful: 1, stale: 1.5, wrong: 2, duplicate: 1 },
	/** The tier term: tier 1 beats tier 2 beats tier 3 by a margin that stays visible next to the other terms. */
	tierScore: { 1: 1, 2: 0.6, 3: 0.3 },
	/** The kind term: how much a document of this kind is expected to state what is true now. */
	kindScore: {
		"planning-state": 1,
		"planning-roadmap": 0.9,
		"planning-requirements": 0.8,
		"planning-project": 0.8,
		agents: 0.9,
		adr: 0.9,
		runbook: 0.9,
		digest: 0.9,
		doc: 0.8,
		skill: 0.8,
		readme: 0.7,
		"planning-context": 0.6,
		"planning-summary": 0.6,
		"planning-verification": 0.6,
		"planning-research": 0.5,
		"planning-milestones": 0.5,
		"planning-audit": 0.5,
		changelog: 0.5,
		"greptile-kb": 0.5,
		"planning-plan": 0.3,
		"planning-other": 0.3,
		other: 0.3,
		"planning-archive": 0.1,
	} satisfies Record<DocKind, number>,
} as const;

/** A count that is not a finite non-negative number counts as zero, so a bad row can never push a score out of range. */
function count(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 1 for a document changed today, falling by half per half-life; unknown or invalid ages are neutral. */
function recencyTerm(ageDays: number | null): number {
	if (ageDays === null || !Number.isFinite(ageDays)) return AUTHORITY_WEIGHTS.unknownRecency;
	return 0.5 ** (Math.max(0, ageDays) / AUTHORITY_WEIGHTS.recencyHalfLifeDays);
}

/** (helpful + prior) / (helpful + cost-weighted negatives + 2 prior): 0.5 with no feedback, rising with helpful, falling with the rest. */
function feedbackTerm(feedback: FeedbackCounts): number {
	const prior = AUTHORITY_WEIGHTS.feedbackPrior;
	const cost = AUTHORITY_WEIGHTS.negativeCost;
	const helpful = count(feedback.helpful);
	const negative =
		count(feedback.unhelpful) * cost.unhelpful +
		count(feedback.stale) * cost.stale +
		count(feedback.wrong) * cost.wrong +
		count(feedback.duplicate) * cost.duplicate;
	return (helpful + prior) / (helpful + negative + 2 * prior);
}

/**
 * 0..1. Monotone: more helpful never lowers it, more unhelpful, stale, wrong or duplicate never raises it, a superseded
 * document scores strictly below the same document not superseded, an older document never scores above a newer one, and
 * tier 1 beats tier 2 beats tier 3. A null age counts as unknown (neutral).
 */
export function scoreDocument(input: AuthorityInput): number {
	const w = AUTHORITY_WEIGHTS;
	const base =
		w.tier * w.tierScore[input.tier] +
		w.kind * w.kindScore[input.kind] +
		w.recency * recencyTerm(input.ageDays) +
		w.feedback * feedbackTerm(input.feedback);
	const score = input.supersededBy === null ? base : base * w.supersededFactor;
	return Math.min(1, Math.max(0, score));
}
