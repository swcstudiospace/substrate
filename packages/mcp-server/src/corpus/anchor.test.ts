/**
 * The anchor status of a corpus root: which root events the ledger holds, and how the checkpoint verifier judged the newest.
 * A ledger fake and a verifier fake: no chain, no network, no clock of our own.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL } from "@substrate/corpus";
import { CheckpointVerifyError, type CheckpointEvidence, type CheckpointVerifyStatus } from "../checkpoint-verify.ts";
import { LOOKUP_ROW_LIMIT, type AnchorLedger, type AnchorVerifyPorts, type EventAnchorToolResult } from "../anchor-verify-deps.ts";
import { eventHash } from "../event.ts";
import type { EventQuery } from "../greptime.ts";
import { rowToEvent } from "../service.ts";
import { defined } from "../test-support.ts";
import type { SubstrateEvent } from "../types.ts";
import { ANCHOR_LOOKUP_MAX_PAGES, MAX_ANCHOR_CANDIDATES, corpusAnchorStatus, type AnchorVerifier } from "./anchor.ts";
import { CORPUS_ROOT_ACTION, CORPUS_ROOT_SESSION } from "./root.ts";

const ROOT = "0123456789abcdef".repeat(4);
const OTHER_ROOT = "fedcba9876543210".repeat(4);
const START = Date.UTC(2026, 9, 20, 10);
const HOUR = new Date(START).toISOString();

function rootEvent(id: string, at: number, over: { root?: string; action?: string; payload?: Record<string, unknown> } = {}): SubstrateEvent {
	const base: Omit<SubstrateEvent, "hash"> = {
		ts: new Date(at).toISOString(),
		surface: "substrate",
		session_id: CORPUS_ROOT_SESSION,
		graph_id: null,
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: "corpus root",
		payload: over.payload ?? { action: over.action ?? CORPUS_ROOT_ACTION, root: over.root ?? ROOT, count: 12, manifest_version: 34 },
		prev: null,
	};
	return { ...base, hash: eventHash(base) };
}

const toRow = (event: SubstrateEvent): Record<string, unknown> => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) });

/** The one ledger read the lookup makes. The other reads belong to the verifier, which these tests replace. */
class FakeLedger implements AnchorLedger {
	events: SubstrateEvent[] = [];
	queries: EventQuery[] = [];
	failure: string | null = null;

	async queryEvents(query: EventQuery = {}): Promise<Array<Record<string, unknown>>> {
		this.queries.push(query);
		if (this.failure !== null) throw new Error(this.failure);
		const match: Record<string, string | null | undefined> = query.match ?? {};
		return this.events
			.filter((event) => match.kind === undefined || event.kind === match.kind)
			.filter((event) => match.surface === undefined || event.surface === match.surface)
			.filter((event) => match.session_id === undefined || event.session_id === match.session_id)
			.filter((event) => query.until === undefined || event.ts <= query.until)
			.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
			.slice(0, query.limit ?? 50)
			.map(toRow);
	}
	async eventsByIds(): Promise<Array<Record<string, unknown>>> {
		throw new Error("the lookup never reads events by id");
	}
	async cursorPosition(): Promise<null> {
		throw new Error("the lookup never reads a cursor");
	}
	async hourLeaves(): Promise<never[]> {
		throw new Error("the lookup never reads an hour");
	}
	async anchorForPeriod(): Promise<null> {
		throw new Error("the lookup never reads an anchor row");
	}
}

function portsOf(ledger: AnchorLedger | null, decode: AnchorVerifyPorts["rowToEvent"] = rowToEvent): AnchorVerifyPorts {
	return {
		ledger,
		rowToEvent: decode,
		rpc: () => {
			throw new Error("the lookup never opens an RPC");
		},
		solana: { pubkey: null, problem: null },
		operatorSurfaces: new Set<string>(),
		nowMs: () => START + 10 * 3_600_000,
	};
}

const EVIDENCE: CheckpointEvidence = {
	event_hash: "ab".repeat(32),
	leaf_index: 4,
	proof: ["cd".repeat(32), "ef".repeat(32)],
	computed_root: "11".repeat(32),
	anchored_root: "11".repeat(32),
	count: 9,
	signature: `5${"a".repeat(87)}`,
	slot: 777,
	signer: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
	block_time_ms: START + 2 * 3_600_000,
	finality: "finalized",
};

function verdict(status: CheckpointVerifyStatus, id: string, reasons: string[] = []): EventAnchorToolResult {
	return { status, ref: id, event: { id, ts: HOUR, kind: "note", session_id: CORPUS_ROOT_SESSION }, hour_start: HOUR, evidence: status === "anchored" ? EVIDENCE : { ...EVIDENCE, signature: null, slot: null, signer: null, block_time_ms: null, finality: null }, reasons };
}

function verifierOf(byId: Record<string, EventAnchorToolResult>, asked: string[] = []): AnchorVerifier {
	return async (_ports, id) => {
		asked.push(id);
		return defined(byId[id], `a verdict for ${id}`);
	};
}

describe("corpusAnchorStatus classifies a root the way a checkpoint is classified", () => {
	for (const status of ["anchored", "pending", "unanchored", "unverified", "mismatch"] as const) {
		test(`${status}: the verifier's verdict, with the event's own count and manifest version`, async () => {
			const ledger = new FakeLedger();
			ledger.events = [rootEvent("evt_root_1", START + 1_000)];
			const reasons = status === "anchored" ? [] : [`the hour says ${status}`];
			const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({ evt_root_1: verdict(status, "evt_root_1", reasons) }));
			expect(answer).toMatchObject({ protocol: CORPUS_PROTOCOL, root: ROOT, status, reasons, eventId: "evt_root_1", count: 12, manifestVersion: 34, hourStart: HOUR });
			if (status === "anchored") {
				expect(answer.evidence).toEqual({
					anchoredRoot: EVIDENCE.anchored_root,
					hourEventCount: 9,
					eventHash: EVIDENCE.event_hash,
					leafIndex: 4,
					hourProof: EVIDENCE.proof,
					signature: EVIDENCE.signature,
					slot: 777,
					signer: EVIDENCE.signer,
					blockTimeMs: START + 2 * 3_600_000,
					finality: "finalized",
				});
			} else {
				expect(answer.evidence).toMatchObject({ signature: null, slot: null, finality: null });
			}
		});
	}

	test("the ledger is asked for the root session's notes on the substrate surface, newest first, with payloads", async () => {
		const ledger = new FakeLedger();
		await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({}));
		expect(ledger.queries).toEqual([{ match: { kind: "note", surface: "substrate", session_id: CORPUS_ROOT_SESSION }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true }]);
	});
});

describe("a root with no event", () => {
	test("is unanchored, not an error, when the whole root session was read; events for another root or action do not count", async () => {
		const ledger = new FakeLedger();
		ledger.events = [rootEvent("evt_other_root", START + 1_000, { root: OTHER_ROOT }), rootEvent("evt_other_action", START + 2_000, { action: "docs.corpus.ingest" })];
		const asked: string[] = [];
		const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({}, asked));
		expect(answer).toMatchObject({ status: "unanchored", eventId: null, count: null, manifestVersion: null, hourStart: null, evidence: null });
		expect(answer.reasons).toHaveLength(1);
		expect(asked).toEqual([]);
	});

	test("is unverified, never unanchored, when there is no ledger", async () => {
		const answer = await corpusAnchorStatus(portsOf(null), ROOT, verifierOf({}));
		expect(answer.status).toBe("unverified");
		expect(answer.reasons.join(" ")).toContain("ledger is not configured");
	});

	test("is unverified when the ledger read fails, with the failure as the reason", async () => {
		const ledger = new FakeLedger();
		ledger.failure = "greptime timed out";
		const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({}));
		expect(answer.status).toBe("unverified");
		expect(answer.reasons.join(" ")).toContain("greptime timed out");
	});

	test("is unverified, not unanchored, when the read stopped at its page limit before the start of the session", async () => {
		const ledger = new FakeLedger();
		const total = ANCHOR_LOOKUP_MAX_PAGES * LOOKUP_ROW_LIMIT + 5;
		ledger.events = Array.from({ length: total }, (_, index) => rootEvent(`evt_other_${index}`, START + index, { root: OTHER_ROOT }));
		const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({}));
		expect(answer.status).toBe("unverified");
		expect(answer.reasons.join(" ")).toContain("page limit");
		expect(ledger.queries).toHaveLength(ANCHOR_LOOKUP_MAX_PAGES);
	});

	test("an event found past the first page is judged, and a row the ledger returned in an odd shape leaves the read incomplete", async () => {
		const ledger = new FakeLedger();
		ledger.events = [...Array.from({ length: LOOKUP_ROW_LIMIT + 3 }, (_, index) => rootEvent(`evt_other_${index}`, START + 10_000 + index, { root: OTHER_ROOT })), rootEvent("evt_old_match", START)];
		const found = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({ evt_old_match: verdict("pending", "evt_old_match") }));
		expect(found).toMatchObject({ status: "pending", eventId: "evt_old_match" });

		const poisoned = new FakeLedger();
		poisoned.events = [rootEvent("evt_poison", START + 5_000, { root: OTHER_ROOT })];
		const decode: AnchorVerifyPorts["rowToEvent"] = (row) => {
			if (row.id === "evt_poison") throw new Error("odd row");
			return rowToEvent(row);
		};
		const unread = await corpusAnchorStatus(portsOf(poisoned, decode), ROOT, verifierOf({}));
		expect(unread.status).toBe("unverified");
		expect(unread.reasons.join(" ")).toContain("could not be decoded");
	});
});

describe("a root carried by several events", () => {
	test("the first anchored one is reported, newest first, even when the newest is only pending", async () => {
		const ledger = new FakeLedger();
		ledger.events = [rootEvent("evt_a", START + 3_000), rootEvent("evt_b", START + 2_000), rootEvent("evt_c", START + 1_000)];
		const asked: string[] = [];
		const answer = await corpusAnchorStatus(
			portsOf(ledger),
			ROOT,
			verifierOf({ evt_a: verdict("pending", "evt_a"), evt_b: verdict("anchored", "evt_b"), evt_c: verdict("anchored", "evt_c") }, asked),
		);
		expect(answer).toMatchObject({ status: "anchored", eventId: "evt_b" });
		expect(asked).toEqual(["evt_a", "evt_b"]);
	});

	test("with none anchored the newest event's verdict stands", async () => {
		const ledger = new FakeLedger();
		ledger.events = [rootEvent("evt_a", START + 2_000), rootEvent("evt_b", START + 1_000)];
		const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf({ evt_a: verdict("unanchored", "evt_a"), evt_b: verdict("mismatch", "evt_b") }));
		expect(answer).toMatchObject({ status: "unanchored", eventId: "evt_a" });
	});

	test("only the newest few are judged", async () => {
		const ledger = new FakeLedger();
		ledger.events = Array.from({ length: MAX_ANCHOR_CANDIDATES + 3 }, (_, index) => rootEvent(`evt_${index}`, START + index * 1_000));
		const asked: string[] = [];
		const byId: Record<string, EventAnchorToolResult> = {};
		for (const event of ledger.events) byId[event.id] = verdict("pending", event.id);
		await corpusAnchorStatus(portsOf(ledger), ROOT, verifierOf(byId, asked));
		expect(asked).toHaveLength(MAX_ANCHOR_CANDIDATES);
		expect(asked[0]).toBe(`evt_${MAX_ANCHOR_CANDIDATES + 2}`);
	});

	test("a verifier that refuses one event is a status of its own, never a throw", async () => {
		const ledger = new FakeLedger();
		ledger.events = [rootEvent("evt_gone", START + 2_000), rootEvent("evt_bad", START + 1_000)];
		const gone: AnchorVerifier = async () => {
			throw new CheckpointVerifyError("not-found", "no event matches evt_gone");
		};
		expect(await corpusAnchorStatus(portsOf(ledger), ROOT, gone)).toMatchObject({ status: "unanchored", eventId: "evt_gone" });
		const broken: AnchorVerifier = async () => {
			throw new Error("rpc exploded");
		};
		const answer = await corpusAnchorStatus(portsOf(ledger), ROOT, broken);
		expect(answer.status).toBe("unverified");
		expect(answer.reasons.join(" ")).toContain("rpc exploded");
	});
});
