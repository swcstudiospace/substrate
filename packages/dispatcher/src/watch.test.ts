/**
 * Tests for the claim watch and the persistent given-up set (DISP-06,
 * T-24-03d, T-24-03e). Clock, signals, and lease reads are injected; the
 * given-up set lives in tmp dirs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GIVEN_UP_FILENAME,
	isGivenUp,
	isLanded,
	isLiveLease,
	markGivenUp,
	readGivenUp,
	SIGTERM_GRACE_MS,
	WATCH_BUDGET_MS,
	watchClaim,
	type GivenUpOutcome,
	type WatchedNode,
} from "./watch.ts";
import { DEFAULT_LEASE_TTL_SECONDS } from "../../mcp-server/src/lease.ts";

const tmpBases: string[] = [];
afterEach(() => {
	while (tmpBases.length > 0) {
		const base = tmpBases.pop();
		if (base !== undefined) rmSync(base, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const base = mkdtempSync(join(tmpdir(), "dispatcher-watch-"));
	tmpBases.push(base);
	return base;
}

const SESSION = "hermes:ut-mkts36-abcdef01:n3";
const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function node(overrides: Partial<WatchedNode> = {}): WatchedNode {
	return {
		node_id: "n3",
		claimed_by: null,
		claim_session: null,
		lease_id: null,
		lease_expires_at: null,
		...overrides,
	};
}

const LIVE = new Date(NOW + 600_000).toISOString();
const PAST = new Date(NOW - 1_000).toISOString();

describe("landed triple condition", () => {
	test("matching session plus future expiry lands despite null lease_id", () => {
		expect(
			isLanded(node({ claimed_by: "hermes", claim_session: SESSION, lease_expires_at: LIVE, lease_id: null }), SESSION, NOW),
		).toBe(true);
	});

	test("foreign surface, foreign session, past or missing expiry never land", () => {
		const landed = { claimed_by: "hermes", claim_session: SESSION, lease_expires_at: LIVE };
		expect(isLanded(node({ ...landed, claimed_by: "cursor" }), SESSION, NOW)).toBe(false);
		expect(isLanded(node({ ...landed, claim_session: "hermes:other:n9" }), SESSION, NOW)).toBe(false);
		expect(isLanded(node({ ...landed, lease_expires_at: PAST }), SESSION, NOW)).toBe(false);
		expect(isLanded(node({ ...landed, lease_expires_at: new Date(NOW).toISOString() }), SESSION, NOW)).toBe(false);
		expect(isLanded(node({ ...landed, lease_expires_at: null }), SESSION, NOW)).toBe(false);
		expect(isLanded(node({ ...landed, claimed_by: null }), SESSION, NOW)).toBe(false);
		expect(isLanded(null, SESSION, NOW)).toBe(false);
	});

	test("a foreign live lease is a live lease, not a landing", () => {
		const foreign = node({ claimed_by: "cursor", claim_session: "cursor:sess", lease_expires_at: LIVE });
		expect(isLiveLease(foreign, NOW)).toBe(true);
		expect(isLanded(foreign, SESSION, NOW)).toBe(false);
		expect(isLiveLease(node({ claimed_by: "hermes", claim_session: SESSION, lease_expires_at: PAST }), NOW)).toBe(false);
		expect(isLiveLease(node(), NOW)).toBe(false);
		expect(isLiveLease(null, NOW)).toBe(false);
	});
});

describe("given-up store", () => {
	test("missing file reads as an empty set; writes round-trip mode 0600", () => {
		const dir = makeTmp();
		expect(readGivenUp(dir)).toEqual({});
		expect(isGivenUp(dir, "iss-1")).toBe(false);

		markGivenUp(dir, "iss-1", "exited-unclaimed", new Date(NOW).toISOString());
		expect(isGivenUp(dir, "iss-1")).toBe(true);
		expect(isGivenUp(dir, "iss-2")).toBe(false);
		const entry = readGivenUp(dir)["iss-1"];
		if (!entry) throw new Error("expected a given-up entry");
		expect(entry.outcome).toBe("exited-unclaimed");
		expect(statSync(join(dir, GIVEN_UP_FILENAME)).mode & 0o777).toBe(0o600);
	});

	test("a corrupt file fails loudly, never silently relaunches", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, GIVEN_UP_FILENAME), "{nope");
		expect(() => isGivenUp(dir, "iss-1")).toThrow();
	});

	test("a non-ENOENT read failure throws instead of reading as empty", () => {
		const dir = makeTmp();
		mkdirSync(join(dir, GIVEN_UP_FILENAME));
		expect(() => readGivenUp(dir)).toThrow();
	});

	test("writes land atomically: no tmp file survives beside the set", () => {
		const dir = makeTmp();
		markGivenUp(dir, "iss-1", "exited-unclaimed", new Date(NOW).toISOString());
		markGivenUp(dir, "iss-2", "claim-timeout", new Date(NOW).toISOString());
		expect(readdirSync(dir)).toEqual([GIVEN_UP_FILENAME]);
		expect(readGivenUp(dir)["iss-2"]?.outcome).toBe("claim-timeout");
	});
});

describe("watchClaim", () => {
	test("a landed claim stops the watch with no signal and no file", async () => {
		const dir = makeTmp();
		let polls = 0;
		const signals: string[] = [];
		let reported: GivenUpOutcome | undefined;
		const result = await watchClaim(
			{ childPid: 111, sessionId: SESSION, issueId: "iss-1", givenUpDir: dir },
			{
				getNode: () => {
					polls += 1;
					return polls < 2
						? node()
						: node({ claimed_by: "hermes", claim_session: SESSION, lease_expires_at: LIVE });
				},
				isAlive: () => true,
				signal: (_pid, signal) => void signals.push(signal),
				sleep: async () => {},
				now: () => NOW,
				pollIntervalMs: 1,
				onUnclaimed: (outcome) => void (reported = outcome),
			},
		);
		expect(result).toEqual({ status: "landed" });
		expect(signals).toEqual([]);
		expect(reported).toBeUndefined();
		expect(isGivenUp(dir, "iss-1")).toBe(false);
	});

	test("process exit before landing writes exited-unclaimed before reporting", async () => {
		const dir = makeTmp();
		const order: string[] = [];
		const result = await watchClaim(
			{ childPid: 111, sessionId: SESSION, issueId: "iss-7", givenUpDir: dir },
			{
				getNode: () => node(),
				isAlive: () => false,
				signal: () => {},
				sleep: async () => {},
				now: () => NOW,
				pollIntervalMs: 1,
				onUnclaimed: (outcome) => {
					order.push(isGivenUp(dir, "iss-7") ? "file-first" : "comment-first");
					order.push(outcome);
				},
			},
		);
		expect(result).toEqual({ status: "exited-unclaimed" });
		expect(order).toEqual(["file-first", "exited-unclaimed"]);
		const exitedEntry = readGivenUp(dir)["iss-7"];
		if (!exitedEntry) throw new Error("expected a given-up entry");
		expect(exitedEntry.outcome).toBe("exited-unclaimed");
	});

	test("900 s without landing sends SIGTERM, waits the grace, then SIGKILL", async () => {
		expect(WATCH_BUDGET_MS).toBe(900_000);
		expect(SIGTERM_GRACE_MS).toBe(5_000);
		const dir = makeTmp();
		let now = NOW;
		const signals: Array<{ signal: string; at: number }> = [];
		const order: string[] = [];
		const result = await watchClaim(
			{ childPid: 222, sessionId: SESSION, issueId: "iss-9", givenUpDir: dir },
			{
				getNode: () => node(),
				isAlive: () => true,
				signal: (_pid, signal) => void signals.push({ signal, at: now }),
				sleep: async (ms) => void (now += ms),
				now: () => now,
				pollIntervalMs: 60_000,
				onUnclaimed: (outcome) => {
					order.push(isGivenUp(dir, "iss-9") ? "file-first" : "comment-first");
					order.push(outcome);
				},
			},
		);
		expect(result).toEqual({ status: "claim-timeout" });
		expect(signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
		const term = signals[0];
		const kill = signals[1];
		if (!term || !kill) throw new Error("expected SIGTERM then SIGKILL");
		expect(kill.at - term.at).toBe(SIGTERM_GRACE_MS);
		expect(term.at - NOW).toBeGreaterThanOrEqual(WATCH_BUDGET_MS);
		expect(order).toEqual(["file-first", "claim-timeout"]);
		const timeoutEntry = readGivenUp(dir)["iss-9"];
		if (!timeoutEntry) throw new Error("expected a given-up entry");
		expect(timeoutEntry.outcome).toBe("claim-timeout");
	});

	test("a claim that lands with the exit still counts as landed", async () => {
		const dir = makeTmp();
		const result = await watchClaim(
			{ childPid: 111, sessionId: SESSION, issueId: "iss-1", givenUpDir: dir },
			{
				getNode: () => node({ claimed_by: "hermes", claim_session: SESSION, lease_expires_at: LIVE }),
				isAlive: () => false,
				signal: () => {},
				sleep: async () => {},
				now: () => NOW,
				pollIntervalMs: 1,
			},
		);
		expect(result).toEqual({ status: "landed" });
		expect(isGivenUp(dir, "iss-1")).toBe(false);
	});

	test("a child that exits during the SIGTERM grace is exited-unclaimed, file first", async () => {
		const dir = makeTmp();
		let now = NOW + WATCH_BUDGET_MS + 1;
		const order: string[] = [];
		const result = await watchClaim(
			{ childPid: 333, sessionId: SESSION, issueId: "iss-grace", givenUpDir: dir },
			{
				getNode: () => node(),
				isAlive: () => false,
				signal: () => {},
				sleep: async (ms) => void (now += ms),
				now: () => now,
				pollIntervalMs: 1,
				onUnclaimed: (outcome) => {
					order.push(isGivenUp(dir, "iss-grace") ? "file-first" : "comment-first");
					order.push(outcome);
				},
			},
		);
		expect(result).toEqual({ status: "exited-unclaimed" });
		expect(order).toEqual(["file-first", "exited-unclaimed"]);
	});

	test("SIGKILL still reaches the group when the parent exits during the grace", async () => {
		const dir = makeTmp();
		let now = NOW;
		let alive = true;
		const signals: string[] = [];
		const result = await watchClaim(
			{ childPid: 333, sessionId: SESSION, issueId: "iss-group", givenUpDir: dir },
			{
				getNode: () => node(),
				isAlive: () => alive,
				signal: (_pid, signal) => {
					signals.push(signal);
					if (signal === "SIGTERM") alive = false;
				},
				sleep: async (ms) => void (now += ms),
				now: () => now,
				pollIntervalMs: WATCH_BUDGET_MS,
			},
		);
		expect(result).toEqual({ status: "exited-unclaimed" });
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(isGivenUp(dir, "iss-group")).toBe(true);
	});

	test("a claim that released between polls is not saved as a give-up", async () => {
		const dir = makeTmp();
		const result = await watchClaim(
			{ childPid: 111, sessionId: SESSION, issueId: "iss-fast", givenUpDir: dir, leaseEpochAtLaunch: 2 },
			{
				getNode: () => node({ lease_epoch: 3 }),
				isAlive: () => false,
				signal: () => {},
				sleep: async () => {},
				now: () => NOW,
				pollIntervalMs: 1,
			},
		);
		expect(result).toEqual({ status: "landed" });
		expect(isGivenUp(dir, "iss-fast")).toBe(false);
	});

	test("a finished node is not saved as a give-up", async () => {
		const dir = makeTmp();
		const result = await watchClaim(
			{ childPid: 111, sessionId: SESSION, issueId: "iss-done", givenUpDir: dir, leaseEpochAtLaunch: 4 },
			{
				getNode: () => node({ lease_epoch: 4, state: "completed" }),
				isAlive: () => false,
				signal: () => {},
				sleep: async () => {},
				now: () => NOW,
				pollIntervalMs: 1,
			},
		);
		expect(result).toEqual({ status: "landed" });
		expect(isGivenUp(dir, "iss-done")).toBe(false);
	});

	test("signal delivery to an already-dead child still completes the give-up path", async () => {
		const dir = makeTmp();
		let now = NOW + WATCH_BUDGET_MS + 1;
		const attempts: string[] = [];
		const result = await watchClaim(
			{ childPid: 444, sessionId: SESSION, issueId: "iss-dead", givenUpDir: dir },
			{
				getNode: () => node(),
				isAlive: () => true,
				signal: (_pid, signal) => {
					attempts.push(signal);
					throw new Error("kill ESRCH");
				},
				sleep: async (ms) => void (now += ms),
				now: () => now,
				pollIntervalMs: 1,
			},
		);
		expect(result).toEqual({ status: "claim-timeout" });
		expect(attempts).toEqual(["SIGTERM", "SIGKILL"]);
		expect(isGivenUp(dir, "iss-dead")).toBe(true);
	});

	test("the budget constant matches the lease TTL it supervises", () => {
		expect(DEFAULT_LEASE_TTL_SECONDS).toBe(900);
		expect(WATCH_BUDGET_MS).toBe(DEFAULT_LEASE_TTL_SECONDS * 1000);
	});
});
