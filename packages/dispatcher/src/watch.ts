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
 * group: SIGTERM, a 5 s grace (assumption A4), then SIGKILL. The outcome
 * is decided from whether the parent was alive after that grace, not from
 * a later `isAlive` check: SIGKILL itself makes the parent look exited.
 *
 * A raised `lease_epoch` or a terminal `state` is not proof this session's
 * claim stood. `claimNode` bumps the epoch before the ledger accepts the
 * claim, and a withdrawn claim does not lower it; another session's claim
 * bumps it too. An expired holder field is not proof either: `graph_get`
 * keeps it, and the session id is reused by the next launch. The node
 * evidence is a live lease held by this session. A claim that already
 * released is a stored granted, reclaimed, or stolen event at or after
 * this launch.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Watch budget: both the poll window and the lease TTL (DISP-06). */
export const WATCH_BUDGET_MS = 900_000;

/** SIGTERM grace before SIGKILL (assumption A4). */
export const SIGTERM_GRACE_MS = 5_000;

export type GivenUpOutcome = "exited-unclaimed" | "claim-timeout";

export const GIVEN_UP_FILENAME = "given-up.json";

/** graph id → the Hermes child still using that graph's checkout. */
export const ACTIVE_CHILDREN_FILENAME = "active-children.json";

/** Start time of one child, so a reused pid is not treated as that child. */
export interface ChildIdentity {
	/** `starttime` from `/proc/<pid>/stat`, clock ticks since boot. */
	startTicks: number;
	/** `/proc/sys/kernel/random/boot_id` at the moment the child was recorded. */
	bootId: string;
}

interface ActiveChild {
	pid: number;
	startTicks: number | null;
	bootId: string | null;
}

/** Public lease fields of one node, as `graph_get` reports them. */
export interface WatchedNode {
	node_id: string;
	claimed_by: string | null;
	claim_session: string | null;
	/** Ignored by the watch: public reads always null it. */
	lease_id: string | null;
	lease_expires_at: string | null;
	/** Monotonic holder generation. A bump during the watch means a claim happened. */
	lease_epoch?: number;
	/** Workflow state. A terminal state means the session finished the node. */
	state?: string | null;
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

/**
 * The whole set, keyed by Linear issue id. A missing file is an empty set;
 * any other read failure (corrupt JSON, permissions, I/O) throws, so a
 * set that cannot be read fails loudly instead of silently relaunching.
 */
export function readGivenUp(dir: string): Record<string, GivenUpEntry> {
	let raw: string;
	try {
		raw = readFileSync(givenUpPath(dir), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return {};
		}
		throw error;
	}
	return JSON.parse(raw) as Record<string, GivenUpEntry>;
}

/** Membership probe for the tick's skip. Throws on a corrupt file: a set
 * that cannot be read must fail loudly, never silently relaunch. */
export function isGivenUp(dir: string, issueId: string): boolean {
	return readGivenUp(dir)[issueId] !== undefined;
}

/**
 * Persist one give-up, mode 0600. Called before any comment or label edit.
 * The write lands on a tmp file and renames over the set, so a crash
 * mid-write never leaves a truncated `given-up.json` behind.
 */
export function markGivenUp(dir: string, issueId: string, outcome: GivenUpOutcome, at?: string): void {
	mkdirSync(dir, { recursive: true });
	const current = readGivenUp(dir);
	current[issueId] = { outcome, at: at ?? new Date().toISOString() };
	const path = givenUpPath(dir);
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	chmodSync(path, 0o600);
}

function asActiveChild(value: unknown): ActiveChild | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return { pid: value, startTicks: null, bootId: null };
	}
	if (typeof value !== "object" || value === null) return null;
	const record = value as { pid?: unknown; startTicks?: unknown; bootId?: unknown };
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
	const startTicks =
		typeof record.startTicks === "number" && Number.isInteger(record.startTicks) && record.startTicks >= 0
			? record.startTicks
			: null;
	const bootId = typeof record.bootId === "string" && record.bootId.length > 0 ? record.bootId : null;
	return { pid: record.pid, startTicks, bootId };
}

function readActiveChildren(dir: string): Record<string, ActiveChild> {
	let raw: string;
	try {
		raw = readFileSync(join(dir, ACTIVE_CHILDREN_FILENAME), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return {};
	const active: Record<string, ActiveChild> = {};
	for (const [graphId, value] of Object.entries(parsed)) {
		const child = asActiveChild(value);
		if (child) active[graphId] = child;
	}
	return active;
}

function writeActiveChildren(dir: string, active: Record<string, ActiveChild>): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, ACTIVE_CHILDREN_FILENAME);
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(active)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	chmodSync(path, 0o600);
}

/**
 * Process start and boot id for `pid`. Null when `/proc` cannot be read:
 * the caller then records a pid only, and a later check cannot tell a
 * reused pid from this child.
 */
export function readProcIdentity(pid: number): ChildIdentity | null {
	try {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		if (end < 0 || bootId.length === 0) return null;
		// Fields after `comm`: state is 3, starttime is 22, so index 19.
		const startTicks = Number(stat.slice(end + 2).trim().split(/\s+/)[19]);
		if (!Number.isInteger(startTicks) || startTicks < 0) return null;
		return { startTicks, bootId };
	} catch {
		return null;
	}
}

/** Remember a spawned child so a later issue on this graph waits for it to exit. */
export function rememberActiveChild(dir: string, graphId: string, pid: number, identity: ChildIdentity | null = null): void {
	const active = readActiveChildren(dir);
	active[graphId] = {
		pid,
		startTicks: identity?.startTicks ?? null,
		bootId: identity?.bootId ?? null,
	};
	writeActiveChildren(dir, active);
}

/** Drop a graph whose child has exited, so the next issue may use the checkout. */
export function forgetActiveChild(dir: string, graphId: string): void {
	const active = readActiveChildren(dir);
	if (active[graphId] === undefined) return;
	delete active[graphId];
	writeActiveChildren(dir, active);
}

function sameChild(record: ActiveChild, identityOf: (pid: number) => ChildIdentity | null): boolean {
	if (record.startTicks === null || record.bootId === null) return true;
	const now = identityOf(record.pid);
	return now !== null && now.startTicks === record.startTicks && now.bootId === record.bootId;
}

/**
 * True when this graph's recorded child is still that process.
 * Dead pids and reused pids (a different start time or boot id) are
 * pruned, including other graphs, so a stale record cannot block a
 * checkout. A record with no start time falls back to the pid check.
 */
export function graphChildRunning(
	dir: string,
	graphId: string,
	isAlive: (pid: number) => boolean,
	identityOf: (pid: number) => ChildIdentity | null = readProcIdentity,
): boolean {
	const active = readActiveChildren(dir);
	let changed = false;
	for (const [graph, child] of Object.entries(active)) {
		if (!isAlive(child.pid) || !sameChild(child, identityOf)) {
			delete active[graph];
			changed = true;
		}
	}
	if (changed) writeActiveChildren(dir, active);
	return active[graphId] !== undefined;
}

export interface WatchInput {
	/** Process-group id to signal on timeout (the spawned child's pid). */
	childPid: number;
	/** The session id written into the launch prompt. */
	sessionId: string;
	/** Linear issue id, the given-up set key. */
	issueId: string;
	/**
	 * Kept so callers can still pass the pre-launch epoch. It is not
	 * evidence: a withdrawn claim and another session's claim both raise it.
	 */
	leaseEpochAtLaunch?: number;
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
	/**
	 * True when a stored claim event shows this session's claim stood
	 * during the watch, after release has cleared the node. A throw is
	 * not evidence and must not skip the give-up.
	 */
	claimStood?: () => boolean | Promise<boolean>;
}

export type WatchResult = { status: "landed" } | { status: GivenUpOutcome };

async function storedClaimStood(deps: WatchDeps): Promise<boolean> {
	if (!deps.claimStood) return false;
	try {
		return await deps.claimStood();
	} catch {
		return false;
	}
}


/**
 * Finish an unclaimed ending. A failed node read still writes the give-up:
 * leaving it unwritten lets the restarted service launch the issue again.
 * `aliveBeforeStop` is the parent's state before SIGKILL, so a parent that
 * survived the grace is `claim-timeout` even if SIGKILL reaps it before
 * the node read returns.
 */
async function finishUnclaimed(
	input: WatchInput,
	deps: WatchDeps,
	aliveBeforeStop: boolean,
	nowMs: number,
): Promise<WatchResult> {
	let settled: WatchedNode | null = null;
	try {
		settled = await deps.getNode();
	} catch {
		settled = null;
	}
	if (isLanded(settled, input.sessionId, nowMs) || (await storedClaimStood(deps))) {
		return { status: "landed" };
	}
	const outcome: GivenUpOutcome = aliveBeforeStop ? "claim-timeout" : "exited-unclaimed";
	markGivenUp(input.givenUpDir, input.issueId, outcome);
	await deps.onUnclaimed?.(outcome);
	return { status: outcome };
}

/**
 * Poll until landed, process exit, or the 900 s budget. A landed claim
 * wins over a simultaneous exit: the session claimed, then stopped.
 * Signal delivery to an already-dead child is a no-op. The grace always
 * SIGKILLs the process group before the give-up write, so a tool child
 * does not outlive the parent.
 */
export async function watchClaim(input: WatchInput, deps: WatchDeps): Promise<WatchResult> {
	const now = deps.now ?? Date.now;
	const pollInterval = deps.pollIntervalMs ?? 5_000;
	const deadline = now() + WATCH_BUDGET_MS;
	for (;;) {
		const at = now();
		if (at >= deadline) {
			try {
				deps.signal(input.childPid, "SIGTERM");
			} catch {
				// Already dead: the post-grace check below reports the exit.
			}
			await deps.sleep(SIGTERM_GRACE_MS);
			// Snapshot before SIGKILL. The kill itself makes a parent that
			// survived the grace look exited by the time getNode returns.
			const survivedGrace = deps.isAlive();
			try {
				// The parent can exit during the grace while a tool child
				// is still in the group. Stop the group before deciding.
				deps.signal(input.childPid, "SIGKILL");
			} catch {
				// The group is already gone.
			}
			return finishUnclaimed(input, deps, survivedGrace, now());
		}
		let node: WatchedNode | null = null;
		try {
			node = await deps.getNode();
		} catch {
			// A failed poll must not escape: the child may already be dead,
			// and an escaped error skips the give-up the restart would honour.
			if (!deps.isAlive()) return finishUnclaimed(input, deps, false, at);
			await deps.sleep(pollInterval);
			continue;
		}
		if (isLanded(node, input.sessionId, at)) return { status: "landed" };
		if (!deps.isAlive()) return finishUnclaimed(input, deps, false, at);
		await deps.sleep(pollInterval);
	}
}
