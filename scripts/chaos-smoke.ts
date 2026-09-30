#!/usr/bin/env bun
/**
 * Live chaos smoke for SPE-4793: **Greptime down for 60 s → emit fails open,
 * claim fails closed.**
 *
 *   bun run smoke:chaos
 *
 * The deterministic proof of the *decisions* is `packages/audit/src/chaos.test.ts`,
 * which runs in CI with no network and gates the build. This script proves the same
 * shape against a **running substrate-mcp**, over the wire, which is the part a unit
 * test cannot reach: that the service really does keep answering while its store is
 * gone, that the claim path really does refuse, and that the audit chain on disk
 * really does hold both halves afterwards.
 *
 * It talks HTTP only — it holds no ledger client, which is what the store lock
 * requires of anything outside `packages/mcp-server`. Nothing here reads a
 * credential and nothing is printed but a host and a count.
 *
 * ## Running it
 *
 * Point it at the service and make the ledger unreachable for the window:
 *
 *   # terminal 1 — blackhole the ledger for 60 s, then restore
 *   sudo iptables -I OUTPUT -d <ledger-ip> -j DROP && sleep 60 \
 *     && sudo iptables -D OUTPUT -d <ledger-ip> -j DROP
 *
 *   # terminal 2
 *   SUBSTRATE_URL=http://127.0.0.1:7410 SUBSTRATE_TOKEN=… bun run smoke:chaos
 *
 * `DROP` rather than `REJECT` on purpose: a dropped packet makes the client wait for
 * its own timeout, which is the failure mode a real Railway outage produces and the
 * one that actually tests whether the substrate fails open inside a hook's budget. A
 * `REJECT` returns immediately and proves much less.
 *
 * With no blackhole in place the script still runs and reports honestly — it will
 * say the ledger stayed healthy and that the fail-closed half was not exercised,
 * rather than passing vacuously.
 */

const BASE = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
const WINDOW_MS = Number(process.env.CHAOS_WINDOW_MS ?? 60_000);
const TICK_MS = Number(process.env.CHAOS_TICK_MS ?? 2000);
/** Generous: the point is to see the hook's own budget respected, not to race it. */
const REQUEST_TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 10_000);
const GRAPH_ID = `ut-chaos-${Date.now().toString(36)}`;
const SESSION_ID = `chaos-${Date.now().toString(36)}`;

function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

interface Attempt {
	status: number | null;
	body: unknown;
	/** Wall time the caller waited. The fail-open claim is about this, not just the status. */
	elapsedMs: number;
	error?: string;
}

async function call(path: string, body?: unknown): Promise<Attempt> {
	const started = performance.now();
	try {
		const response = await fetch(`${BASE}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: headers(),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		let parsed: unknown = text;
		try {
			parsed = JSON.parse(text);
		} catch {
			// A brief comes back as markdown. Keep the text.
		}
		return { status: response.status, body: parsed, elapsedMs: performance.now() - started };
	} catch (cause) {
		return { status: null, body: null, elapsedMs: performance.now() - started, error: String(cause) };
	}
}

const results: Array<{ ok: boolean; what: string; detail?: string }> = [];

function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}

function note(what: string, detail?: string): void {
	process.stdout.write(`  --   ${what}${detail ? ` — ${detail}` : ""}\n`);
}

const host = (() => {
	try {
		return new URL(BASE).host;
	} catch {
		return "(unparseable SUBSTRATE_URL)";
	}
})();

process.stdout.write(`\nSubstrate chaos smoke — ${host}, graph ${GRAPH_ID}\n\n`);

// ── 0. the service is there at all ───────────────────────────────────────────
const boot = await call("/healthz");
if (boot.status === null) {
	process.stderr.write(
		`substrate-mcp is unreachable at ${BASE}: ${boot.error}\n` +
			"Start it (bun run mcp, or systemctl start substrate-mcp) and set SUBSTRATE_URL.\n",
	);
	process.exit(2);
}
if (boot.status === 401) {
	process.stderr.write("substrate-mcp refused the token. Set SUBSTRATE_TOKEN to one of its configured tokens.\n");
	process.exit(2);
}

const health = boot.body as { greptime?: boolean; eventsWritable?: boolean; auditDurable?: boolean };
note("health at start", JSON.stringify(health));
check(
	health.auditDurable === true,
	"the MCP audit chain is durable",
	health.auditDurable ? undefined : "SUBSTRATE_AUDIT_PATH is unset, so the trail this smoke writes ends at the next restart",
);

// ── 1. the outage window ─────────────────────────────────────────────────────
process.stdout.write(`\nholding for ${Math.round(WINDOW_MS / 1000)} s, one emit and one claim every ${TICK_MS} ms\n\n`);

const emits: Attempt[] = [];
const claims: Attempt[] = [];
const deadline = Date.now() + WINDOW_MS;
let tick = 0;

while (Date.now() < deadline) {
	tick++;
	emits.push(
		await call("/events", {
			surface: "grok-bot",
			kind: "note",
			summary: `chaos smoke tick ${tick}`,
			graph_id: GRAPH_ID,
			session_id: SESSION_ID,
			payload: { usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.0001, model: "chaos-smoke" } },
		}),
	);
	// `graph_claim` is MCP-only, so this goes through /mcp as JSON-RPC. A graph that is
	// not in the index answers with an error rather than a claim — which is still the
	// right probe: what is being tested is that the *call* is served and audited, and
	// that a claim never succeeds unrecorded.
	claims.push(
		await call("/mcp", {
			jsonrpc: "2.0",
			id: tick,
			method: "tools/call",
			params: { name: "graph_claim", arguments: { graph_id: GRAPH_ID, node_id: "n1", session_id: SESSION_ID } },
		}),
	);
	const remaining = deadline - Date.now();
	if (remaining > TICK_MS) await Bun.sleep(TICK_MS);
}

// ── 2. emit failed open ──────────────────────────────────────────────────────
const emitAnswered = emits.filter((attempt) => attempt.status !== null);
const emitStored = emits.filter((attempt) => (attempt.body as { stored?: boolean } | null)?.stored === true);
const emitDropped = emits.filter((attempt) => (attempt.body as { stored?: boolean } | null)?.stored === false);
const slowest = Math.max(...emits.map((attempt) => attempt.elapsedMs));

check(emitAnswered.length === emits.length, `every emit was answered (${emitAnswered.length}/${emits.length})`);
check(
	emitDropped.every((attempt) => attempt.status === 503),
	"a refused append is reported as 503 with the normalised event, not as a silent success",
);
check(
	emits.every((attempt) => (attempt.body as { id?: string } | null)?.id !== undefined),
	"every emit got its normalised event back, stored or not — the caller can carry on",
);
note(`slowest emit ${Math.round(slowest)} ms`, `${emitStored.length} stored, ${emitDropped.length} dropped`);

if (emitDropped.length === 0) {
	note(
		"the ledger stayed healthy for the whole window",
		"the fail-open half was not exercised; blackhole the ledger and run again",
	);
}

// ── 3. claim failed closed ───────────────────────────────────────────────────
function claimGranted(attempt: Attempt): boolean {
	const body = attempt.body as { result?: { content?: Array<{ text?: string }> } } | null;
	const text = body?.result?.content?.[0]?.text ?? "";
	try {
		return (JSON.parse(text) as { claimed?: boolean }).claimed === true;
	} catch {
		return false;
	}
}

const claimsAnswered = claims.filter((attempt) => attempt.status !== null);
const granted = claims.filter(claimGranted);

check(claimsAnswered.length === claims.length, `every claim call was answered (${claimsAnswered.length}/${claims.length})`);
check(
	granted.length === 0,
	"no claim was granted while the ledger was refusing",
	granted.length > 0 ? `${granted.length} claim(s) were granted — fail-closed did not hold` : undefined,
);
if (health.greptime !== true) {
	// Said out loud rather than left to be inferred from a green run. With no ledger
	// configured at all, claims are deliberately fail-open and a graph that is not in
	// the index cannot be claimed either — so "no claim was granted" above passed, but
	// not because the withdrawal path ran. A real proof needs both stores configured
	// and the ledger blackholed.
	note(
		"claims are fail-open in this deployment",
		"no ledger is configured, so the withdrawal path was not exercised; run against a deployment with both stores and blackhole the ledger",
	);
}

// ── 4. the audit chain holds both halves ─────────────────────────────────────
const evidence = await call("/evidence", { graph_id: GRAPH_ID });
const bundle = evidence.body as {
	chains?: { mcp_audit?: { ok?: boolean | null; records?: number; durable?: boolean } };
	audit?: { total?: number; allowed?: number; denied?: number };
	slos?: Array<{ id: string; status: string; detail: string }>;
	usage?: { inputTokens: number; costUsd: number } | null;
} | null;

check(evidence.status === 200, "the evidence bundle is served after the outage");
check(bundle?.chains?.mcp_audit?.ok === true, "the MCP audit chain verifies", bundle?.chains?.mcp_audit?.ok === false ? "it does not" : undefined);
check(
	(bundle?.audit?.total ?? 0) >= emits.length,
	`the audit recorded this graph's calls (${bundle?.audit?.total ?? 0} record(s))`,
);
note("audit tally", `${bundle?.audit?.allowed ?? 0} allowed, ${bundle?.audit?.denied ?? 0} denied`);

// ── 5. the SLOs saw it ───────────────────────────────────────────────────────
for (const slo of bundle?.slos ?? []) note(`slo ${slo.id}`, `${slo.status} — ${slo.detail}`);

const emitSuccess = bundle?.slos?.find((slo) => slo.id === "emit.success");
if (emitDropped.length > 0) {
	check(
		emitSuccess?.status === "breached",
		"the emit-success objective reports the outage",
		emitSuccess ? `it reports ${emitSuccess.status}` : "it was not evaluated",
	);
}

// ── 6. tokens and cost were attributed ───────────────────────────────────────
check(
	(bundle?.usage?.inputTokens ?? 0) > 0,
	"the usage on those events was attributed to this graph",
	bundle?.usage ? undefined : "no usage came back; check that the token counts survived redaction",
);

// ── report ───────────────────────────────────────────────────────────────────
const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
	process.stdout.write("\nfailed:\n");
	for (const result of failed) process.stdout.write(`  - ${result.what}${result.detail ? ` (${result.detail})` : ""}\n`);
}
process.stdout.write(
	`\nThis appended ${emits.length} note event(s) under ${GRAPH_ID}. The ledger is append-only, so they stay; ` +
		"they carry no repo, so no brief shows them.\n\n",
);
process.exit(failed.length === 0 ? 0 : 1);
