/**
 * The chaos scenario SPE-4793 asks for, run deterministically:
 *
 *   **Greptime down for 60 s → `emit` fails open, `claim` fails closed.**
 *
 * Driven against the narrow ports rather than a socket, so it runs in CI with no
 * ledger, no clock and no network. `scripts/chaos-smoke.ts` runs the same shape
 * against a live deployment, where the ledger is genuinely blackholed; this is the
 * proof that the *decisions* are right, and it is the one that gates the build.
 *
 * The asymmetry is the whole point. Both calls hit the same unreachable ledger, and
 * they must not behave the same way:
 *
 *   - a dropped event costs a line in the trail, and refusing the turn over it would
 *     mean a substrate outage blocking every prompt on the host;
 *   - a claim whose event dropped costs *mutual exclusion*, because no other agent's
 *     brief would show the node as taken — the brief reads recent actions from the
 *     ledger — so the second agent to arrive sees a node nobody is working on.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC, SubstrateInstruments, evaluateSlos, findCounter, sumCounter } from "@substrate/observability";
import { AuditLog, AuditUnavailableError } from "./log.ts";
import { auditMode, decideClaim } from "./policy.ts";

const START = 1_790_186_361_000;
const OUTAGE_MS = 60_000;

/** A ledger that is unreachable for a window of wall-clock time. */
class FaultyLedger {
	private downUntil = 0;

	constructor(private readonly clock: { now: number }) {}

	goDown(forMs: number): void {
		this.downUntil = this.clock.now + forMs;
	}

	private get reachable(): boolean {
		return this.clock.now >= this.downUntil;
	}

	append(): { stored: boolean; error?: string } {
		return this.reachable ? { stored: true } : { stored: false, error: "greptime unreachable: connect ETIMEDOUT" };
	}
}

/**
 * The two call paths under test, wired the way `Substrate` wires them.
 *
 * `requireRecorded` is true because a ledger *is* configured — it is merely down,
 * which is exactly the state fail-closed exists for.
 */
function harness() {
	const clock = { now: START };
	const ledger = new FaultyLedger(clock);
	const instruments = new SubstrateInstruments();
	const audit = new AuditLog({ path: null, now: () => new Date(clock.now), maxRetained: 10_000 });

	async function emit(surface: string, graphId: string): Promise<{ stored: boolean; threw: boolean }> {
		const tool = "events_emit";
		let threw = false;
		let stored = false;
		try {
			const appended = ledger.append();
			stored = appended.stored;
			await audit.append({
				surface,
				tool,
				graph_id: graphId,
				decision: "allowed",
				mode: auditMode(tool),
				transport: "mcp",
				...(appended.error ? { reason: appended.error } : {}),
			});
			instruments.recordEmit({ surface, graph_id: graphId, kind: "shell", stored, durationMs: 4 });
		} catch {
			threw = true;
		}
		return { stored, threw };
	}

	async function claim(surface: string, graphId: string, nodeId: string) {
		const tool = "graph_claim";
		// The index grants it first — the index is up; only the ledger is down.
		const recorded = ledger.append().stored;
		const verdict = decideClaim({ claimed: true, recorded, requireRecorded: true });

		await audit.append({
			surface,
			tool,
			graph_id: graphId,
			node_id: nodeId,
			decision: verdict.decision === "granted" ? "allowed" : "denied",
			mode: auditMode(tool),
			transport: "mcp",
			reason: verdict.reason,
		});
		instruments.recordClaim({
			surface,
			graph_id: graphId,
			outcome: verdict.decision === "granted" ? "granted" : verdict.decision === "contended" ? "contended" : "revoked",
		});
		if (verdict.quarantineReason) {
			instruments.recordQuarantine({ surface, graph_id: graphId, reason: verdict.quarantineReason });
		}
		return verdict;
	}

	return { clock, ledger, instruments, audit, emit, claim };
}

describe("Greptime down for 60 s", () => {
	test("emit fails open: every call returns, none throws, and none claims to be stored", async () => {
		const { clock, ledger, emit } = harness();
		ledger.goDown(OUTAGE_MS);

		const results: Array<{ stored: boolean; threw: boolean }> = [];
		for (let second = 0; second < 60; second++) {
			clock.now = START + second * 1000;
			results.push(await emit("omp", "ut-1"));
		}

		expect(results.every((result) => result.threw === false)).toBe(true);
		expect(results.every((result) => result.stored === false)).toBe(true);
	});

	test("claim fails closed: every claim is withdrawn and quarantined", async () => {
		const { clock, ledger, claim, instruments } = harness();
		ledger.goDown(OUTAGE_MS);

		for (let second = 0; second < 60; second += 6) {
			clock.now = START + second * 1000;
			const verdict = await claim("omp", "ut-1", `n${second}`);
			expect(verdict.decision).toBe("revoked");
			expect(verdict.quarantineReason).toBe("unrecorded-claim");
		}

		const quarantines = findCounter(instruments.snapshot(), METRIC.quarantines);
		expect(sumCounter(quarantines!, { reason: "unrecorded-claim" })).toBe(10);
		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.claims)!, { outcome: "revoked" })).toBe(10);
	});

	test("both halves are recorded in the audit chain, and it verifies", async () => {
		// The audit is a local file precisely so that it still works when the store it
		// audits does not. This is the outage where the record of what was denied
		// matters most.
		const { clock, ledger, emit, claim, audit } = harness();
		ledger.goDown(OUTAGE_MS);

		for (let second = 0; second < 60; second += 10) {
			clock.now = START + second * 1000;
			await emit("omp", "ut-1");
			await claim("muse", "ut-1", `n${second}`);
		}

		const verdict = await audit.verify();
		expect(verdict.ok).toBe(true);
		expect(verdict.records).toBe(12);

		const records = await audit.readAll();
		const denials = records.records.filter((record) => record.decision === "denied");
		expect(denials).toHaveLength(6);
		expect(denials.every((record) => record.tool === "graph_claim")).toBe(true);
		expect(denials.every((record) => (record.reason ?? "").includes("withdrawn"))).toBe(true);

		// The emits are recorded as allowed, because they were: the substrate accepted
		// and normalised each one. Whether the ledger kept it is a separate fact, and it
		// is the ledger's own `stored` that carries it.
		const allowed = records.records.filter((record) => record.decision === "allowed");
		expect(allowed.every((record) => record.tool === "events_emit")).toBe(true);
	});

	test("the SLOs show the outage", async () => {
		const { clock, ledger, emit, claim, instruments } = harness();

		// A healthy minute first, so there are enough samples to judge.
		for (let i = 0; i < 40; i++) {
			clock.now = START + i * 100;
			await emit("omp", "ut-1");
			await claim("omp", "ut-1", `n${i}`);
		}
		expect(evaluateSlos(instruments.snapshot()).find((slo) => slo.id === "emit.success")?.status).toBe("ok");

		clock.now = START + 10_000;
		ledger.goDown(OUTAGE_MS);
		for (let second = 0; second < 60; second++) {
			clock.now = START + 10_000 + second * 1000;
			await emit("omp", "ut-1");
		}
		for (let i = 0; i < 20; i++) await claim("omp", "ut-1", `m${i}`);

		const results = evaluateSlos(instruments.snapshot());
		expect(results.find((slo) => slo.id === "emit.success")?.status).toBe("breached");
		expect(results.find((slo) => slo.id === "quarantine.rate")?.status).toBe("breached");
	});

	test("recovery: claims are granted again once the ledger is back", async () => {
		const { clock, ledger, claim } = harness();
		ledger.goDown(OUTAGE_MS);

		clock.now = START + 30_000;
		expect((await claim("omp", "ut-1", "n1")).decision).toBe("revoked");

		clock.now = START + OUTAGE_MS + 1;
		expect((await claim("omp", "ut-1", "n1")).decision).toBe("granted");
	});

	test("the counters are cumulative, so recovery does not erase the breach", async () => {
		// Deliberate. These are process-lifetime totals; a rolling window is the
		// collector's job, and an SLO that healed itself the moment the outage ended
		// would hide the outage from anyone reading `/slo` afterwards.
		const { clock, ledger, emit, instruments } = harness();
		ledger.goDown(OUTAGE_MS);
		for (let i = 0; i < 100; i++) {
			clock.now = START + i * 500;
			await emit("omp", "ut-1");
		}

		clock.now = START + OUTAGE_MS + 1;
		for (let i = 0; i < 100; i++) await emit("omp", "ut-1");

		const emitTotal = findCounter(instruments.snapshot(), METRIC.emitTotal)!;
		expect(sumCounter(emitTotal, { outcome: "dropped" })).toBe(100);
		expect(sumCounter(emitTotal, { outcome: "stored" })).toBe(100);
		expect(evaluateSlos(instruments.snapshot()).find((slo) => slo.id === "emit.success")?.status).toBe("breached");
	});
});

describe("the audit sink itself being down", () => {
	/** A path whose parent is a regular file: impossible to create, whoever is running. */
	function unwritablePath(): string {
		const directory = mkdtempSync(join(tmpdir(), "substrate-chaos-"));
		writeFileSync(join(directory, "not-a-directory"), "");
		return join(directory, "not-a-directory", "mcp-audit.jsonl");
	}

	test("a claim is refused with a healthy ledger, because nothing could record who asked", async () => {
		// The other fail-closed direction, and the reason the gate sits in front of the
		// dispatcher rather than after it: a claim must not be granted with no record of
		// who asked for it.
		const audit = new AuditLog({ path: unwritablePath() });
		await audit.open();

		await expect(
			audit.append({ surface: "omp", tool: "graph_claim", decision: "allowed", mode: auditMode("graph_claim") }),
		).rejects.toBeInstanceOf(AuditUnavailableError);
	});

	test("an emit still goes through, and says its record was lost", async () => {
		const audit = new AuditLog({ path: unwritablePath() });
		await audit.open();

		const result = await audit.append({
			surface: "omp",
			tool: "events_emit",
			decision: "allowed",
			mode: auditMode("events_emit"),
		});
		expect(result.written).toBe(false);
	});
});
