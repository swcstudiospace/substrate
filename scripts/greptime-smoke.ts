#!/usr/bin/env bun
/**
 * Live smoke test for the Greptime events ledger.
 *
 *   bun run smoke:greptime
 *
 * Reads `GREPTIME_URL`, `GREPTIME_USER`, `GREPTIME_PASSWORD` and `GREPTIME_DB`
 * from the environment — on the VPS that means
 * `set -a; . /etc/substrate/substrate.env; set +a` first. No credential is read
 * from this repo and none is printed: the report names the host and nothing else.
 *
 * The unit tests run against a mocked Greptime, so they pin the SQL this code
 * builds but cannot tell us how a real server parses it. That is what this
 * script is for. It goes through `Substrate` and `GreptimeClient` rather than
 * around them, so what it proves is the path `events_emit` actually takes:
 *
 *   1. migrate is idempotent, and `agent_events` is in append_mode — appends are
 *      fail-closed until it is, so this one gates the rest
 *   2. a credential in a summary is redacted before it is stored
 *   3. a summary containing a quote and a backslash round-trips byte-identically
 *      — the quoting dialect is right, which is what makes the hash chain
 *      verifiable at all
 *   4. the chain over the events just written verifies
 *   5. a burst through three sessions leaves exactly one ingest record per event,
 *      and the hour digest over every hour the burst touched is identical when
 *      computed twice, holds the burst in ingest order and puts a backdated event
 *      in the hour it was ingested in, not the hour its `ts` names — with the
 *      chain intact and every stored hash unchanged afterwards
 *   6. `events_query` reads those events back — the WHERE, ORDER BY, LIMIT and ISO
 *      time bound that only a real server's parser can confirm
 *   7. the client refuses to UPDATE or DELETE what it wrote
 *
 * It appends to the real ledger, which is append-only, so the rows it writes
 * cannot be cleaned up afterwards. They are tagged with a `smoke-` graph id and
 * session id and `kind: "note"` so they are easy to tell apart, and the brief
 * ignores them because they carry no repo.
 *
 * Prove it on scratch stores, never on production: the rehearsal harness starts a
 * throwaway Greptime and Postgres, and `stores.env` carries their credentials.
 *
 *   bun run rehearsal up --name p27
 *   set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env"; set +a
 *   bun run smoke:greptime
 *   bun run rehearsal down --name p27
 */
import { randomUUID } from "node:crypto";
import { hourEnd, hourStart } from "../packages/ledger/src/index.ts";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { AppendOnlyViolation, INGEST_LAG_MS, quote } from "../packages/mcp-server/src/greptime.ts";
import { Substrate } from "../packages/mcp-server/src/service.ts";
import { REDACTED } from "../packages/mcp-server/src/redact.ts";

/** A token-shaped string, assembled at runtime so no token pattern sits in git. */
const DECOY = `ghp_${"A".repeat(36)}`;
/** A quote and a backslash: the two characters that can close a SQL literal early. */
const AWKWARD = `wrote C:\\new\\table and it's fine -- really; yes`;

const results: Array<{ ok: boolean; what: string; detail?: string }> = [];

function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}

const config = loadConfig();
if (!config.greptime) {
	process.stderr.write(
		"GREPTIME_URL is not set. Load the deployment environment first, e.g.\n" +
			"  set -a; . /etc/substrate/substrate.env; set +a; bun run smoke:greptime\n",
	);
	process.exit(2);
}

// The index is explicitly absent: this proves the ledger on its own, and a
// missing Postgres must not be mistaken for a Greptime failure.
const substrate = new Substrate(config, { index: null });
const greptime = substrate.greptime;
if (!greptime) {
	process.stderr.write("no ledger client was built from GREPTIME_URL\n");
	process.exit(2);
}

const host = (() => {
	try {
		return new URL(config.greptime.url).host;
	} catch {
		return "(unparseable GREPTIME_URL)";
	}
})();
process.stdout.write(`\nGreptime events ledger smoke — ${host}, db ${config.greptime.db}\n\n`);

// ── 1. migrate, twice, and append_mode ───────────────────────────────────────
const first = await greptime.migrate().catch((cause: unknown) => ({ warnings: [String(cause)], failed: true }));
check(!("failed" in first), "migrate reaches the ledger", "failed" in first ? first.warnings[0] : undefined);
if ("failed" in first) {
	process.stderr.write("\nthe ledger is unreachable; nothing further can be proven from here\n");
	process.exit(1);
}
for (const warning of first.warnings) process.stdout.write(`  note  ${warning}\n`);

const second = await greptime.migrate();
check(second.warnings.length === first.warnings.length, "migrate is idempotent");

const appendOnly = await greptime.appendModeEnabled();
check(
	appendOnly === true,
	"agent_events is in append_mode",
	appendOnly === null ? "could not read SHOW CREATE TABLE" : appendOnly ? undefined : "recreate the table; see docs",
);

// Writes are fail-closed, so on a table that is not yet append-only every check
// below would fail for that one reason. Say so once and stop, rather than printing
// six failures that all mean "recreate the table".
if (appendOnly !== true && !config.allowDeduplicatingLedger) {
	process.stdout.write(
		"\nAppends are refused while agent_events is not provably append-only — this is the fail-closed\n" +
			"behaviour working, not a separate fault. Recreate the table (docs/greptime-ledger.md), or re-run\n" +
			"with SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true to exercise the rest of the path and knowingly\n" +
			"accept that a colliding event may be dropped.\n",
	);
	process.exit(1);
}

// ── 2–3. emit a chain through the real write path ────────────────────────────
const graphId = `smoke-${randomUUID().slice(0, 8)}`;
const sessionId = `smoke-${Date.now()}`;
const common = { surface: "claude-code", kind: "note", session_id: sessionId, graph_id: graphId } as const;

const emitted = [];
for (const summary of [`phase 0 ledger smoke ${graphId}`, `carrying a decoy: GITHUB_TOKEN=${DECOY}`, AWKWARD]) {
	const result = await substrate.emit({ ...common, summary });
	emitted.push(result);
	if (!result.stored) check(false, `append "${summary.slice(0, 32)}…"`, result.error);
}
check(
	emitted.every((result) => result.stored),
	`appended ${emitted.length} chained events as ${graphId}`,
);
check(
	emitted[0]?.event.prev === null && emitted[1]?.event.prev === emitted[0]?.event.hash,
	"each event chains onto the previous one's hash",
);

// ── read the rows back ───────────────────────────────────────────────────────
const rows = await greptime.readEvents("graph_id", graphId).catch(() => []);
check(rows.length === emitted.length, `read back ${rows.length} of ${emitted.length} rows`);

const summaries = rows.map((row) => String(row.summary));
check(
	!summaries.some((summary) => summary.includes(DECOY)) && summaries.some((summary) => summary.includes(REDACTED)),
	"the decoy credential was redacted before it was stored",
);

// The hash is computed over the text as submitted, so a stored summary that
// differs by even one character makes the chain unverifiable. This is the check
// that tells us the quoting dialect is right.
const stored = summaries.find((summary) => summary.startsWith("wrote C:"));
check(
	stored === AWKWARD,
	"a summary with a quote and a backslash round-trips byte-identically",
	stored === AWKWARD ? undefined : `stored as ${JSON.stringify(stored)}`,
);

// ── 4. the chain verifies ────────────────────────────────────────────────────
const verified = await substrate.verifyGraph(graphId);
check(verified.ok, `the hash chain over ${graphId} verifies`, verified.ok ? undefined : verified.reason);

// ── 5. ingest order and the hour digest ─────────────────────────────────────
// Three sessions emit three events each at once through the path `events_emit`
// takes, one of them backdated to September. What only a real server can
// confirm: each event leaves exactly one ingest record, the digest over every
// hour the burst touched is the same twice and holds the burst in ingest order,
// and a backdated event sits in the hour it was ingested in. The ledger already
// holds the events from sections 2–3, so the burst is checked as a subset of
// each hour, never against an exact count.
const burstGraph = `${graphId}-ingest`;
const BACKDATED_TS = "2026-09-01T03:00:00.000Z";
const burst = (
	await Promise.all(
		[0, 1, 2].map(async (lane) => {
			const lanes = [];
			for (let step = 0; step < 3; step++) {
				lanes.push(
					await substrate.emit({
						...common,
						session_id: `${sessionId}-lane${lane}`,
						graph_id: burstGraph,
						summary: `ingest order burst ${lane}.${step}`,
						...(lane === 0 && step === 1 ? { ts: BACKDATED_TS } : {}),
					}),
				);
			}
			return lanes;
		}),
	)
).flat();
check(
	burst.length === 9 && burst.every((result) => result.stored && result.warning === undefined),
	`appended ${burst.length} events across 3 sessions as ${burstGraph}`,
	burst.find((result) => !result.stored || result.warning)?.error ?? burst.find((result) => result.warning)?.warning,
);

const burstIds = burst.map((result) => result.event.id);
const ingestRows = await greptime
	.sql(`SELECT "event_id", "ingested_at" FROM "event_ingest" WHERE "event_id" IN (${burstIds.map((id) => quote(id)).join(", ")})`)
	.catch(() => []);
check(
	ingestRows.length === burstIds.length && burstIds.every((id) => ingestRows.filter((row) => row.event_id === id).length === 1),
	"every burst event has exactly one ingest record",
	`${ingestRows.length} records for ${burstIds.length} events`,
);

const ingestAt = new Map(ingestRows.map((row) => [String(row.event_id), Number(row.ingested_at)]));
const hours = [...new Set([...ingestAt.values()].map((at) => hourStart(at)))].sort((a, b) => a - b);
const hourIso = (start: number) => new Date(start).toISOString();
for (const hour of hours) {
	const now = hourEnd(hour) + INGEST_LAG_MS;
	const once = await substrate.hourDigest(hour, now).catch((cause: unknown) => cause as Error);
	const twice = await substrate.hourDigest(hour, now).catch((cause: unknown) => cause as Error);
	if (once instanceof Error || twice instanceof Error) {
		check(false, `hour ${hourIso(hour)} digests`, String(once instanceof Error ? once : twice));
		continue;
	}
	check(
		JSON.stringify(once) === JSON.stringify(twice) &&
			/^[0-9a-f]{64}$/.test(once.root ?? "") &&
			once.memo?.startsWith("substrate:v1:") === true &&
			once.event_count === once.event_ids.length,
		`hour ${hourIso(hour)} digests to the same root and memo twice`,
		`${once.event_count} events`,
	);
	// The order is recomputed from the raw ingest rows, independently of hourLeaves.
	const expected = burstIds
		.filter((id) => hourStart(ingestAt.get(id) ?? Number.NaN) === hour)
		.sort((a, b) => (ingestAt.get(a) ?? 0) - (ingestAt.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
	check(
		JSON.stringify(once.event_ids.filter((id) => burstIds.includes(id))) === JSON.stringify(expected),
		`the burst is in ingest order within hour ${hourIso(hour)}`,
		`${expected.length} of the burst`,
	);
}

// The backdated event keeps its September `ts`, but its place is its ingest hour.
const backdated = burst[1]?.event;
const backdatedHour = hourStart(ingestAt.get(backdated?.id ?? "") ?? Number.NaN);
const backdatedDigest = Number.isNaN(backdatedHour)
	? new Error("no ingest record for the backdated event")
	: await substrate.hourDigest(backdatedHour, hourEnd(backdatedHour) + INGEST_LAG_MS).catch((cause: unknown) => cause as Error);
check(
	backdated?.ts === BACKDATED_TS && !(backdatedDigest instanceof Error) && backdatedDigest.event_ids.includes(backdated?.id ?? ""),
	"a backdated event is a member of the hour it was ingested in",
	backdatedDigest instanceof Error ? backdatedDigest.message : undefined,
);
const septemberHour = hourStart(Date.parse(BACKDATED_TS));
const september = await substrate
	.hourDigest(septemberHour, hourEnd(septemberHour) + INGEST_LAG_MS)
	.catch((cause: unknown) => cause as Error);
check(
	!(september instanceof Error) && september.event_count === 0 && september.root === null && september.memo === null,
	"the hour its ts names holds nothing: collector time plays no part",
	september instanceof Error ? september.message : undefined,
);

const burstVerified = await substrate.verifyGraph(burstGraph);
check(burstVerified.ok, `the hash chain over ${burstGraph} verifies`, burstVerified.ok ? undefined : burstVerified.reason);
const burstRows = await greptime.readEvents("graph_id", burstGraph).catch(() => []);
check(
	burstRows.length === burst.length &&
		burst.every((result) => burstRows.some((row) => row.id === result.event.id && row.hash === result.event.hash)),
	"the digest reads left every stored event hash unchanged",
);

// ── 6. the read path a desk seat takes ───────────────────────────────────────
// `readEvents` above is the verifier's read: one column, no bounds. This is the
// statement `events_query` builds, and the parts no mock can prove are how a real
// server parses an ISO literal against a TIMESTAMP column and how it orders and
// limits the result.
const queried = await substrate.queryEvents({ graph_id: graphId, order: "asc", limit: 10 });
check(
	queried.error === undefined && queried.count === emitted.length,
	`events_query returns ${queried.count} of ${emitted.length} rows for ${graphId}`,
	queried.error,
);

const byHash = new Map(queried.events.map((event) => [event.hash, event]));
check(
	emitted.every((result) => byHash.has(result.event.hash)),
	"every appended event comes back under the hash it was stored with",
);
// Greptime hands a TIMESTAMP back as an integer; the chain hashed an ISO string, so
// this is the round trip the chain depends on.
check(
	emitted.every((result) => byHash.get(result.event.hash)?.ts === result.event.ts),
	"a queried timestamp round-trips to the ISO string the chain hashed",
);
check(
	queried.events.every((event) => !("payload" in event)),
	"the payload is left out of a query that did not ask for it",
);

const oneRow = await substrate.queryEvents({ graph_id: graphId, include_payload: true, limit: 1 });
check(
	oneRow.error === undefined && oneRow.count === 1 && typeof oneRow.events[0]?.payload === "object",
	"include_payload returns one parsed payload",
	oneRow.error,
);
check(oneRow.truncated, "a full window reports itself truncated");

const firstTs = Date.parse(emitted[0]?.event.ts ?? "");
const window = await substrate.queryEvents({
	graph_id: graphId,
	since: new Date(firstTs - 60_000).toISOString(),
	until: new Date(Date.now() + 60_000).toISOString(),
});
check(
	window.error === undefined && window.count === emitted.length,
	"an ISO time window bounds a live TIMESTAMP column",
	window.error,
);

const before = await substrate.queryEvents({ graph_id: graphId, until: new Date(firstTs - 60_000).toISOString() });
check(
	before.error === undefined && before.count === 0,
	"a window that excludes them is empty rather than an error",
	before.error,
);

const otherKind = await substrate.queryEvents({ graph_id: graphId, kind: "warning" });
check(
	otherKind.error === undefined && otherKind.count === 0,
	"a filter matching nothing is an empty window, not a failure",
	otherKind.error,
);

// ── 7. the ledger refuses to be rewritten ────────────────────────────────────
for (const statement of [
	`UPDATE "agent_events" SET "summary" = 'rewritten' WHERE "graph_id" = '${graphId}'`,
	`DELETE FROM "agent_events" WHERE "graph_id" = '${graphId}'`,
]) {
	const verb = statement.split(" ")[0] ?? "";
	let refused = false;
	try {
		await greptime.sql(statement);
	} catch (cause) {
		refused = cause instanceof AppendOnlyViolation;
	}
	check(refused, `the client refuses ${verb}`);
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = results.filter((result) => !result.ok);
process.stdout.write(
	`\n${results.length - failed.length}/${results.length} checks passed. ` +
		`Rows written under graph_id ${graphId} cannot be cleaned up` +
		`${appendOnly === true ? " — the table is append-only" : ""}.\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
