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

/** How long a reflect reply waits for one digest's Hindsight forward, ms. */
export const RETAIN_LEG_WAIT_MS = 5000;

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
		const { result, leg } = await deps.write(request);
		if (result.outcome !== "accepted") return { ok: false, reason: result.reason };
		if (!result.verified_persisted) return { ok: false, reason: "not-verified" };
		if (leg === null) return { ok: false, reason: "not-forwarded" };
		const settled = await Promise.race([leg, (deps.delay ?? sleep)(deps.waitMs ?? RETAIN_LEG_WAIT_MS).then((): null => null)]);
		return settled === null ? { ok: false, reason: "pending" } : deliveryOf(settled);
	} catch {
		return { ok: false, reason: "memory-write-failed" };
	}
}
