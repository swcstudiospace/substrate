/**
 * Per-graph head commitments (D73-01, D73-02). Each (graph, session) pair that wrote events in an
 * anchored hour contributes one record. `headsRoot` commits the set of records, so an anchor proves
 * which heads it covers, not only which events. Each record is hashed with plain SHA-256 over its
 * canonical JSON, and the hashes are folded by the RFC 6962 tree in merkle.ts.
 */

import { bytesToHex, merkleRootHex, sha256 } from "./merkle.ts";
import { HOUR_MS } from "./period.ts";

const HEX64_RE = /^[0-9a-f]{64}$/;

export type GraphHeadRecord = {
	graphId: string;
	/** "" is legal: it is the bucket for events written without a session, as verifyGraph groups them. */
	sessionId: string;
	periodStartMs: number;
	count: number;
	leavesRootHex: string;
	headEventId: string;
	headHashHex: string;
};

/** SHA-256 (lowercase hex) of the UTF-8 bytes of the record's canonical JSON array. */
export function headRecordHash(record: GraphHeadRecord): string {
	const { graphId, sessionId, periodStartMs, count, leavesRootHex, headEventId, headHashHex } = record;
	if (typeof graphId !== "string" || graphId === "") throw new Error("headRecordHash: graphId is empty");
	if (typeof sessionId !== "string") throw new Error("headRecordHash: sessionId is not a string");
	if (!Number.isSafeInteger(periodStartMs) || periodStartMs % HOUR_MS !== 0) {
		throw new Error("headRecordHash: period is not a whole UTC hour");
	}
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("headRecordHash: count must be a positive integer");
	if (!HEX64_RE.test(leavesRootHex)) throw new Error("headRecordHash: leaves root is not 64 lowercase hex characters");
	if (typeof headEventId !== "string" || headEventId === "") throw new Error("headRecordHash: headEventId is empty");
	if (!HEX64_RE.test(headHashHex)) throw new Error("headRecordHash: head hash is not 64 lowercase hex characters");
	const canonical = JSON.stringify([
		graphId,
		sessionId,
		periodStartMs,
		count,
		leavesRootHex,
		headEventId,
		headHashHex,
	]);
	return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/** Code-unit order on graphId, then sessionId: the order any reader reproduces without a locale. */
function byGraphThenSession(a: GraphHeadRecord, b: GraphHeadRecord): number {
	if (a.graphId !== b.graphId) return a.graphId < b.graphId ? -1 : 1;
	if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
	return 0;
}

/**
 * The Merkle root over one hour's head records: one leaf per (graphId, sessionId) pair, sorted so the
 * input order never matters. An anchor covers exactly one hour, so every record must share its period.
 */
export function headsRoot(records: readonly GraphHeadRecord[]): string {
	const [first] = records;
	if (first === undefined) throw new Error("headsRoot: empty input (an hour with no graph heads is never anchored)");
	const seen = new Set<string>();
	for (const record of records) {
		if (record.periodStartMs !== first.periodStartMs) throw new Error("headsRoot: records cover different periods");
		const pair = JSON.stringify([record.graphId, record.sessionId]);
		if (seen.has(pair)) {
			throw new Error(`headsRoot: duplicate graphId/sessionId pair ${record.graphId}/${record.sessionId}`);
		}
		seen.add(pair);
	}
	return merkleRootHex([...records].sort(byGraphThenSession).map((record) => headRecordHash(record)));
}

/**
 * The same root as headsRoot, over only the records of `graphId` (a v3 pointer commits to one graph's heads). With no record
 * for the graph it throws exactly as headsRoot does on an empty list.
 */
export function graphHeadsRoot(records: readonly GraphHeadRecord[], graphId: string): string {
	return headsRoot(records.filter((record) => record.graphId === graphId));
}
