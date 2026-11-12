/**
 * Phase 72 criterion 2 for live sessions (verification item 16b): `updateLiveSession` answers an ungranted `repo_id` with the
 * same not-found an unknown session gets, before the authority issues or transitions anything. The real service runs; the
 * authority is the deterministic test model and the ledger is a recording stub.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { auditToolCalls, createObservability } from "./observe.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./planning/live-session.test-support.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV } from "./repo-scope.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

const CALLER = { surface: "cursor", isOperator: false } as const;

/** `owner/a` is granted to the cursor surface; `owner/b` is registered and not granted. */
function scopedEnv(): Record<string, string> {
	const dirA = mkdtempSync(join(tmpdir(), "live-gate-a-"));
	const dirB = mkdtempSync(join(tmpdir(), "live-gate-b-"));
	return {
		SUBSTRATE_PLANNING_STEERING: "on",
		SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp",
		[REPO_REGISTRY_ENV]: JSON.stringify({
			"owner/a": { checkouts: [dirA], worktrees: [] },
			"owner/b": { checkouts: [dirB], worktrees: [] },
		}),
		[REPO_SCOPES_ENV]: JSON.stringify({ cursor: ["owner/a"] }),
	};
}

/** A greptime stub: every append is recorded. Reads are not expected on the refused paths and are counted to prove it. */
function ledger() {
	const written: SubstrateEvent[] = [];
	const reads: string[] = [];
	const read = (name: string) => async () => {
		reads.push(name);
		return [];
	};
	return {
		written,
		reads,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
			queryEvents: read("queryEvents"),
			readEvents: read("readEvents"),
			recentForRepo: read("recentForRepo"),
			commitEventsNaming: read("commitEventsNaming"),
			graphIngest: async () => [],
			firstIngestMs: async () => null,
		},
	};
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function fixture() {
	const env = scopedEnv();
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	cleanup.push(() => observability.stop());
	const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
	const stub = ledger();
	const substrate = new Substrate(
		config,
		{ index: null, greptime: stub.greptime as never, steering: { history: null, liveSessions: authority } },
		observability.observer,
		{ auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport) },
	);
	return { substrate, authority, ledger: stub };
}

const refusalsOf = (written: SubstrateEvent[]) => written.filter((event) => (event.payload as { action?: string } | undefined)?.action === "repo.scope-refused");

describe("live session issue gate (criterion 2, verification item 16b)", () => {
	test("an issue for an ungranted repository is refused before authority.issue, reads no session, and records one refusal", async () => {
		const { substrate, authority, ledger: stub } = await fixture();
		const issue = spyOn(authority, "issue");
		const read = spyOn(authority, "read");
		const transition = spyOn(authority, "transition");

		await expect(substrate.updateLiveSession(CALLER, { repo_id: "owner/b", state: "ACTIVE" })).rejects.toMatchObject({
			refusal: { status: "refused", error: { code: "not-found" } },
		});

		expect(issue).not.toHaveBeenCalled();
		expect(transition).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();

		const refusals = refusalsOf(stub.written);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({ kind: "warning", surface: "cursor", payload: { action: "repo.scope-refused", route: "docs_steering_session", reason: "repo-not-granted" } });
		// The refusal is the only ledger write: no steering session event was written.
		expect(stub.written).toHaveLength(1);
		expect(stub.reads).toHaveLength(0);
	});

	test("positive control: an issue for a granted repository reaches authority.issue and is issued", async () => {
		const { substrate, authority, ledger: stub } = await fixture();
		const issue = spyOn(authority, "issue");

		const reply = await substrate.updateLiveSession(CALLER, { repo_id: "owner/a", state: "ACTIVE" });

		expect(reply).toMatchObject({ status: "issued", repo_id: "owner/a" });
		expect(issue).toHaveBeenCalledTimes(1);
		expect(refusalsOf(stub.written)).toHaveLength(0);
	});

	test("a transition naming an ungranted repository, for a session held in that repository, is refused by the scope gate before authority.transition and records one refusal", async () => {
		// A session in owner/b, seeded through the authority directly: the service refuses to issue one for an ungranted repository,
		// so this models a session issued before the grant was narrowed.
		const { substrate, authority, ledger: stub } = await fixture();
		const seeded = await issueLiveSession(authority, { caller: CALLER, repoId: "owner/b" });
		const transition = spyOn(authority, "transition");

		await expect(substrate.updateLiveSession(CALLER, { session_id: seeded.sessionId, session_binding: seeded.sessionBinding, repo_id: "owner/b", previous_state: "ACTIVE", state: "PAUSED" })).rejects.toMatchObject({
			refusal: { status: "refused", error: { code: "not-found" } },
		});

		expect(transition).not.toHaveBeenCalled();
		const refusals = refusalsOf(stub.written);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({ payload: { action: "repo.scope-refused", route: "docs_steering_session", reason: "repo-not-granted" } });
	});

	test("a transition for a session in an ungranted repository does not read that session before it refuses", async () => {
		// Asserts the requirement as written. Session-bound calls are read by the boundary's prepare step (steering-tools.ts:105)
		// before the effect that holds the repository gate (service.ts:2057), so this is expected to fail on current code.
		const { substrate, authority } = await fixture();
		const seeded = await issueLiveSession(authority, { caller: CALLER, repoId: "owner/b" });
		const read = spyOn(authority, "read");

		await expect(substrate.updateLiveSession(CALLER, { session_id: seeded.sessionId, session_binding: seeded.sessionBinding, repo_id: "owner/b", previous_state: "ACTIVE", state: "PAUSED" })).rejects.toMatchObject({
			refusal: { status: "refused", error: { code: "not-found" } },
		});

		expect(read).not.toHaveBeenCalled();
	});

	test("positive control: a transition of a session in a granted repository reaches authority.transition", async () => {
		const { substrate, authority, ledger: stub } = await fixture();
		const issued = await substrate.updateLiveSession(CALLER, { repo_id: "owner/a", state: "ACTIVE" });
		if (issued.status !== "issued") throw new Error("test issuance refused");
		const transition = spyOn(authority, "transition");

		const moved = await substrate.updateLiveSession(CALLER, { session_id: issued.session_id, session_binding: issued.session_binding, repo_id: "owner/a", previous_state: "ACTIVE", state: "PAUSED" });

		expect(moved).toMatchObject({ status: "updated", session_id: issued.session_id, state: "PAUSED" });
		expect(transition).toHaveBeenCalledTimes(1);
		expect(refusalsOf(stub.written)).toHaveLength(0);
	});
});
