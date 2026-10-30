/**
 * What happened to a stored digest's Hindsight leg (v1.7 phase 66), for the reply of `POST /corpus/reflect`.
 *
 * The memory write forwards an accepted entry to Hindsight in the background, after its own reply is decided, so "the index write
 * succeeded and Hindsight is configured" says nothing about delivery. This reads the forward's own outcome instead, under a short
 * bound. A forward still running at the bound, or parked in the retain outbox for a retry, is reported as `pending`: the caller
 * is told the delivery is not known yet, never that it worked.
 */
import { createHash } from "node:crypto";
import { HINDSIGHT_NOT_CONFIGURED, type ForwardOutcome } from "../memory-retain.ts";
import { MAX_SUBJECT } from "../memory-policy.ts";
import type { MemoryWriteRequest, MemoryWriteResult } from "../types.ts";
import type { RetainOutcome } from "./reflect-service.ts";

/** How long one digest's Hindsight forward is waited for when the caller sets no bound, ms. */
export const RETAIN_LEG_WAIT_MS = 5000;
/** The memory-write text cap. A retain part must fit in this, trailer included. */
export const DIGEST_RETAIN_TEXT_MAX = 4000;
const DIGEST_SUBJECT_PREFIX = "corpus-digest:";
const DECISIONS_SUFFIX = ":decisions";
const OPEN_SUFFIX = ":open";
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
 * - `corpus-digest:<repo>` is everything before a `## Recent decisions` heading line, plus a `## Project` heading line
 *   when that line follows the decisions heading, so a long open list cannot cut the project. When the decisions heading
 *   is absent, it is the whole text.
 * - `corpus-digest:<repo>:decisions` runs from that decisions heading line up to the next open-items or project heading line.
 * - `corpus-digest:<repo>:open` runs from the open-items heading line up to the project heading line.
 * A heading is a line that starts with the heading, not a mention inside a bullet. A suffix that would be cut by the
 * 200-character subject cap is replaced by a short hash tag, so the three parts cannot collapse to one subject.
 *
 * A missing heading is not written. A present heading is written even when its section is empty. A part longer than 4000
 * characters is cut to 3990 and closed with `\n[cut]\n`.
 */
export function splitDigestRetain(repo: string, text: string): DigestRetainPart[] {
	const decisionsAt = headingAt(text, DECISIONS_HEADING);
	const openAt = headingAt(text, OPEN_HEADING);
	const projectAt = headingAt(text, PROJECT_HEADING);
	const project = projectAt === -1 ? "" : text.slice(projectAt);
	const raw: Array<{ subject: string; text: string }> = [];
	if (decisionsAt === -1) {
		raw.push({ subject: digestSubject(repo, ""), text });
	} else {
		const overview = text.slice(0, decisionsAt);
		raw.push({ subject: digestSubject(repo, ""), text: projectAt > decisionsAt ? `${overview}${project}` : overview });
		const decisionsEnd = openAt > decisionsAt ? openAt : projectAt > decisionsAt ? projectAt : text.length;
		raw.push({ subject: digestSubject(repo, DECISIONS_SUFFIX), text: text.slice(decisionsAt, decisionsEnd) });
	}
	if (openAt !== -1) {
		const openEnd = projectAt > openAt ? projectAt : text.length;
		raw.push({ subject: digestSubject(repo, OPEN_SUFFIX), text: text.slice(openAt, openEnd) });
	}
	return raw.map(boundRetainPart);
}

/** A line that starts with `heading`. A mention inside a bullet is not a section boundary. */
function headingAt(text: string, heading: string): number {
	let from = 0;
	while (from <= text.length) {
		const at = text.indexOf(heading, from);
		if (at === -1) return -1;
		const atLineStart = at === 0 || text[at - 1] === "\n";
		const after = text[at + heading.length];
		const boundary = after === undefined || after === "\n" || after === "\r" || after === " ";
		if (atLineStart && boundary) return at;
		from = at + heading.length;
	}
	return -1;
}

/**
 * The subject the memory gate will store. `normalizeSubject` keeps 200 characters and lowercases, so a long label plus
 * `:decisions` would be sliced back to the overview subject and the last-write-wins rule would replace that part.
 * When the readable form fits, it is kept, so an existing overview row is still retired. When it does not, a short tag
 * and a hash of the label stand in. The tag keeps the three sections distinct.
 */
function digestSubject(repo: string, suffix: string): string {
	const label = repo.toLowerCase();
	const readable = `${DIGEST_SUBJECT_PREFIX}${label}${suffix}`;
	if (readable.length <= MAX_SUBJECT) return readable;
	const tag = suffix === DECISIONS_SUFFIX ? "d" : suffix === OPEN_SUFFIX ? "n" : "o";
	const hash = createHash("sha256").update(label, "utf8").digest("hex").slice(0, 12);
	return `${DIGEST_SUBJECT_PREFIX}${tag}:${hash}`;
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
