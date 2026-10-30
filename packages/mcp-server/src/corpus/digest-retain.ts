/**
 * What happened to a stored digest's Hindsight leg (v1.7 phase 66), for the reply of `POST /corpus/reflect`.
 *
 * The memory write forwards an accepted entry to Hindsight in the background, after its own reply is decided, so "the index write
 * succeeded and Hindsight is configured" says nothing about delivery. This reads the forward's own outcome instead, under a short
 * bound. A forward still running at the bound, or parked in the retain outbox for a retry, is reported as `pending`: the caller
 * is told the delivery is not known yet, never that it worked.
 */
import { HINDSIGHT_NOT_CONFIGURED, type ForwardOutcome } from "../memory-retain.ts";
import type { MemoryWriteRequest, MemoryWriteResult } from "../types.ts";
import type { RetainOutcome } from "./reflect-service.ts";

/** How long one digest's Hindsight forward is waited for when the caller sets no bound, ms. */
export const RETAIN_LEG_WAIT_MS = 5000;
/** The memory-write text cap. A retain part must fit in this, trailer included. */
export const DIGEST_RETAIN_TEXT_MAX = 4000;
const DIGEST_SUBJECT_PREFIX = "corpus-digest:";
const DECISIONS_HEADING = "## Recent decisions";
const OPEN_HEADING = "## Open items";
const PROJECT_HEADING = "## Project";
const CUT_AT = 3990;
const CUT_TRAILER = "\n[cut]\n";

export interface DigestRetainPart {
	subject: string;
	text: string;
	/** True when this part was longer than the memory text cap and was cut. */
	cut: boolean;
}

/**
 * Splits one digest into at most three standalone section retains.
 *
 * - `corpus-digest:<repo>` is everything before `## Recent decisions`, plus `## Project` when that heading follows the
 *   decisions heading, so a long open list cannot cut the project. When the decisions heading is absent, it is the whole text.
 * - `corpus-digest:<repo>:decisions` runs from `## Recent decisions` up to but not including `## Open items` or `## Project`.
 * - `corpus-digest:<repo>:open` runs from `## Open items` up to but not including `## Project`.
 *
 * A missing heading is not written. A present heading is written even when its section is empty. A part longer than 4000
 * characters is cut to 3990 and closed with `\n[cut]\n`.
 */
export function splitDigestRetain(repo: string, text: string): DigestRetainPart[] {
	const base = `${DIGEST_SUBJECT_PREFIX}${repo}`;
	const decisionsAt = text.indexOf(DECISIONS_HEADING);
	const openAt = text.indexOf(OPEN_HEADING);
	const projectAt = text.indexOf(PROJECT_HEADING);
	const project = projectAt === -1 ? "" : text.slice(projectAt);
	const raw: Array<{ subject: string; text: string }> = [];
	if (decisionsAt === -1) {
		raw.push({ subject: base, text });
	} else {
		const overview = text.slice(0, decisionsAt);
		raw.push({ subject: base, text: projectAt > decisionsAt ? `${overview}${project}` : overview });
		const decisionsEnd = openAt > decisionsAt ? openAt : projectAt > decisionsAt ? projectAt : text.length;
		raw.push({ subject: `${base}:decisions`, text: text.slice(decisionsAt, decisionsEnd) });
	}
	if (openAt !== -1) {
		const openEnd = projectAt > openAt ? projectAt : text.length;
		raw.push({ subject: `${base}:open`, text: text.slice(openAt, openEnd) });
	}
	return raw.map(boundRetainPart);
}

function boundRetainPart(part: { subject: string; text: string }): DigestRetainPart {
	if (part.text.length <= DIGEST_RETAIN_TEXT_MAX) return { ...part, cut: false };
	return { subject: part.subject, text: `${part.text.slice(0, CUT_AT)}${CUT_TRAILER}`, cut: true };
}

export interface DigestRetainDeps {
	/** A governed memory write and the background forward it started (null when none was started). */
	write: (request: MemoryWriteRequest) => Promise<{ result: MemoryWriteResult; leg: Promise<ForwardOutcome> | null }>;
	waitMs?: number | undefined;
	/** Resolves after `ms`; tests hand in a promise they control. */
	delay?: ((ms: number) => Promise<void>) | undefined;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(() => resolve(), ms).unref();
	return promise;
}

/** The closed reason a finished forward adds to a result: none when it landed, `pending` when it is parked for a retry. */
export function deliveryOf(outcome: ForwardOutcome): RetainOutcome {
	if (outcome.forwarded) return { ok: true };
	if (outcome.queued === true) return { ok: false, reason: "pending" };
	if (outcome.reason === HINDSIGHT_NOT_CONFIGURED) return { ok: false, reason: "not-configured" };
	return { ok: false, reason: outcome.reason ?? "not-forwarded" };
}

/** Writes one digest as a governed memory entry and reports what became of its Hindsight leg. Never throws. */
export async function retainDigestOutcome(deps: DigestRetainDeps, request: MemoryWriteRequest): Promise<RetainOutcome> {
	try {
		const waitMs = deps.waitMs ?? RETAIN_LEG_WAIT_MS;
		const { result, leg } = await deps.write(request);
		if (result.outcome !== "accepted") return { ok: false, reason: result.reason };
		if (!result.verified_persisted) return { ok: false, reason: "not-verified" };
		if (leg === null) return { ok: false, reason: "not-forwarded" };
		// A spent request budget still starts the write. It does not wait, and it does not report a delivery it did not observe.
		if (waitMs <= 0) return { ok: false, reason: "pending" };
		const settled = await Promise.race([leg, (deps.delay ?? sleep)(waitMs).then((): null => null)]);
		if (settled === null) return { ok: false, reason: "pending" };
		const delivered = deliveryOf(settled);
		if (delivered.ok && result.truncated === true) return { ok: true, truncated: true };
		return delivered;
	} catch {
		return { ok: false, reason: "memory-write-failed" };
	}
}
