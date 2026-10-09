/**
 * Claim watch and persistent given-up set (DISP-06, T-24-03d, T-24-03e).
 *
 * After a successful Hermes spawn the dispatcher polls `graph_get` until
 * the claim lands, the process exits, or 900 s elapse. A claim counts as
 * landed only on the triple condition — `claimed_by === "hermes"`, the
 * prompt's session id in `claim_session`, and `lease_expires_at` strictly
 * in the future — ignoring `lease_id`, which public reads always null
 * (`withoutLeaseIds` in `packages/mcp-server/src/service.ts`).
 *
 * `already-claimed` is a pre-launch fact (a live lease held by another
 * surface or session), never a landed verdict. Both unclaimed endings
 * persist the given-up entry BEFORE invoking the report callback, so a
 * crash between the file write and the Linear comment cannot relaunch an
 * issue the dispatcher already gave up. The 900 s stop kills the process
 * group: SIGTERM, a 5 s grace (assumption A4), then SIGKILL.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** Watch budget: both the poll window and the lease TTL (DISP-06). */
export const WATCH_BUDGET_MS = 900_000;

/** SIGTERM grace before SIGKILL (assumption A4). */
export const SIGTERM_GRACE_MS = 5_000;

export type GivenUpOutcome = "exited-unclaimed" | "claim-timeout";

export const GIVEN_UP_FILENAME = "given-up.json";

/** Public lease fields of one node, as `graph_get` reports them. */
export interface WatchedNode {
	node_id: string;
	claimed_by: string | null;
	claim_session: string | null;
	/** Ignored by the watch: public reads always null it. */
	lease_id: string | null;
	lease_expires_at: string | null;
}

/**
 * Landed means this launch's Hermes session holds a live lease. A foreign
 * surface or session with a future expiry is not landed here — it is the
 * `already-claimed` the pre-launch gate reports.
 */
export function isLanded(node: WatchedNode | null, sessionId: string, nowMs: number): boolean {
	if (node === null) return false;
	if (node.claimed_by !== "hermes") return false;
	if (node.claim_session !== sessionId) return false;
	if (node.lease_expires_at === null) return false;
	const expiry = Date.parse(node.lease_expires_at);
	return !Number.isNaN(expiry) && expiry > nowMs;
}

/** A live lease by anyone: the pre-launch `already-claimed` gate. */
export function isLiveLease(node: WatchedNode | null, nowMs: number): boolean {
	if (node === null || node.claimed_by === null) return false;
	if (node.lease_expires_at === null) return false;
	const expiry = Date.parse(node.lease_expires_at);
	return !Number.isNaN(expiry) && expiry > nowMs;
}

export function givenUpPath(dir: string): string {
	return join(dir, GIVEN_UP_FILENAME);
}

export interface GivenUpEntry {
	outcome: GivenUpOutcome;
	at: string;
}

/** The whole set, keyed by Linear issue id. A missing file is an empty set. */
export function readGivenUp(dir: string): Record<string, GivenUpEntry> {
	let raw: string;
	try {
		raw = readFileSync(givenUpPath(dir), "utf8");
	} catch {
		return {};
	}
	return JSON.parse(raw) as Record<string, GivenUpEntry>;
}

/** Membership probe for the tick's skip. Throws on a corrupt file: a set
 * that cannot be read must fail loudly, never silently relaunch. */
export function isGivenUp(dir: string, issueId: string): boolean {
	return readGivenUp(dir)[issueId] !== undefined;
}

/** Persist one give-up, mode 0600. Called before any comment or label edit. */
export function markGivenUp(dir: string, issueId: string, outcome: GivenUpOutcome, at?: string): void {
	mkdirSync(dir, { recursive: true });
	const current = readGivenUp(dir);
	current[issueId] = { outcome, at: at ?? new Date().toISOString() };
	const path = givenUpPath(dir);
	writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export interface WatchInput {
	/** Process-group id to signal on timeout (the spawned child's pid). */
	childPid: number;
	/** The session id written into the launch prompt. */
	sessionId: string;
	/** Linear issue id, the given-up set key. */
	issueId: string;
	/** Injected root: tmp in tests, never `/var/lib/substrate` here. */
	givenUpDir: string;
}

export interface WatchDeps {
	/** Fresh `graph_get` node read per poll. */
	getNode: () => WatchedNode | null | Promise<WatchedNode | null>;
	/** False once the Hermes process has exited. */
	isAlive: () => boolean;
	/** Group kill on timeout: SIGTERM first, SIGKILL after the grace. */
	signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
	/** Overridden to milliseconds in tests; production polls every 5 s. */
	pollIntervalMs?: number;
	/**
	 * Runs after the given-up file write for an unclaimed ending — the
	 * tick's marker comment plus dispatch-label removal. Never runs landed.
	 */
	onUnclaimed?: (outcome: GivenUpOutcome) => void | Promise<void>;
}

export type WatchResult = { status: "landed" } | { status: GivenUpOutcome };

/**
 * Poll until landed, process exit, or the 900 s budget. A landed claim
 * wins over a simultaneous exit: the session claimed, then stopped.
 */
export async function watchClaim(input: WatchInput, deps: WatchDeps): Promise<WatchResult> {
	const now = deps.now ?? Date.now;
	const pollInterval = deps.pollIntervalMs ?? 5_000;
	const deadline = now() + WATCH_BUDGET_MS;
	for (;;) {
		const at = now();
		if (at >= deadline) {
			deps.signal(input.childPid, "SIGTERM");
			await deps.sleep(SIGTERM_GRACE_MS);
			deps.signal(input.childPid, "SIGKILL");
			markGivenUp(input.givenUpDir, input.issueId, "claim-timeout");
			await deps.onUnclaimed?.("claim-timeout");
			return { status: "claim-timeout" };
		}
		const node = await deps.getNode();
		if (isLanded(node, input.sessionId, at)) return { status: "landed" };
		if (!deps.isAlive()) {
			markGivenUp(input.givenUpDir, input.issueId, "exited-unclaimed");
			await deps.onUnclaimed?.("exited-unclaimed");
			return { status: "exited-unclaimed" };
		}
		await deps.sleep(pollInterval);
	}
}
