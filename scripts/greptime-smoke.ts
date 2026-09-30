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
 *   5. the client refuses to UPDATE or DELETE what it wrote
 *
 * It appends to the real ledger, which is append-only, so the rows it writes
 * cannot be cleaned up afterwards. They are tagged with a `smoke-` graph id and
 * session id and `kind: "note"` so they are easy to tell apart, and the brief
 * ignores them because they carry no repo.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { AppendOnlyViolation } from "../packages/mcp-server/src/greptime.ts";
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

// ── 5. the ledger refuses to be rewritten ────────────────────────────────────
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
