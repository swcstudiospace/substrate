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
 * ## It cannot pass without exercising the outage
 *
 * A smoke that goes green having proven nothing is worse than no smoke. Two checks
 * exist for exactly that: the run **fails** unless at least one emit was actually
 * refused, and unless at least one claim was actually withdrawn. Run it with no
 * blackhole and it exits non-zero saying which half did not happen.
 *
 * `CHAOS_REHEARSAL=1` turns those two into notes, for checking the script itself
 * against a healthy deployment. It is the only way to get a green run without an
 * outage, and it says so in the report.
 */

const BASE = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
const WINDOW_MS = Number(process.env.CHAOS_WINDOW_MS ?? 60_000);
const TICK_MS = Number(process.env.CHAOS_TICK_MS ?? 2000);
/** Generous: the point is to see the hook's own budget respected, not to race it. */
const REQUEST_TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 10_000);
const GRAPH_ID = `ut-chaos-${Date.now().toString(36)}`;
const SESSION_ID = `chaos-${Date.now().toString(36)}`;
const NODE_ID = "n1";
/** Allows a green run against a healthy deployment, for checking the script itself. */
const REHEARSAL = /^(1|true|yes)$/i.test(process.env.CHAOS_REHEARSAL?.trim() ?? "");

function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return {
		"content-type": "application/json",
		// Both media types, because `/mcp` is the MCP streamable transport and it answers
		// a POST with **406** unless both are acceptable. Without this every tool call
		// came back unreadable, and "unreadable" is what this script is careful not to
		// read as a verdict — so the claim half could never run, whatever the ledger did.
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

/**
 * The JSON in a response body, however it was framed.
 *
 * A refusal is JSON, a brief is markdown, and a **dispatched MCP tool result is one
 * `text/event-stream` frame** — the transport streams unless JSON responses are
 * enabled, so a tool result arrives as `data: {…}` rather than as bare JSON. Parsing
 * only the bare form left every successful call looking like a call that answered
 * nothing.
 */
function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the SSE framing.
	}
	const frames = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	for (const frame of frames.reverse()) {
		try {
			return JSON.parse(frame);
		} catch {
			// Not this frame.
		}
	}
	return text;
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
		return { status: response.status, body: parseBody(text), elapsedMs: performance.now() - started };
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

/** A check that only a rehearsal is allowed to skip. */
function require_(ok: boolean, what: string, detail?: string): void {
	if (ok || !REHEARSAL) check(ok, what, detail);
	else note(`${what} (not exercised; CHAOS_REHEARSAL is set)`, detail);
}

/** One MCP tool call over `/mcp`, as JSON-RPC. */
async function tool(id: number, name: string, args: Record<string, unknown>): Promise<Attempt> {
	return call("/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

/** Why a call produced no decision: the layer that refused before the tool ran. */
function whyNoDecision(attempt: Attempt): string | null {
	if (attempt.status === null) return attempt.error ?? "no response";
	if (attempt.status !== 200) return `HTTP ${attempt.status}`;
	const body = attempt.body as { error?: { message?: string }; result?: { isError?: boolean } } | null;
	if (body?.error?.message) return body.error.message;
	if (body?.result?.isError === true) return "the tool reported an error";
	if (!body?.result) return "no result in the reply";
	return "the result was not the JSON a decision comes in";
}

/** The JSON a tool returned, or null if it errored or answered something else. */
function toolResult(attempt: Attempt): Record<string, unknown> | null {
	const body = attempt.body as { result?: { content?: Array<{ text?: string }> } } | null;
	const text = body?.result?.content?.[0]?.text;
	if (typeof text !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
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

// ── 1. a node to claim ───────────────────────────────────────────────────────
//
// Registered before the window, while the ledger is still up. Without this the graph
// is unknown to the index and `graph_claim` fails with "unknown node" *before* the
// fail-closed logic runs — so every claim would come back not-granted and the check
// below would pass without the withdrawal path ever executing. That is exactly the
// vacuous pass this script must not produce.
const registered = await tool(0, "graph_register", {
	graph_id: GRAPH_ID,
	repo: "swcstudiospace/agent-substrate",
	branch: "chaos-smoke",
	nodes: [{ node_id: NODE_ID }],
});
const graphRegistered = toolResult(registered) !== null;
// A precondition for the claim half, so it is gated the same way: without it the
// withdrawal path cannot run, and a run that cannot reach it must not read as a pass.
require_(
	graphRegistered,
	`registered ${GRAPH_ID}/${NODE_ID}, so a claim reaches the withdrawal path`,
	graphRegistered
		? undefined
		: `graph_register did not answer with a graph (${whyNoDecision(registered) ?? "unknown"}); ` +
			"without an index there is no node to claim",
);

// ── 2. the outage window ─────────────────────────────────────────────────────
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
	// `graph_claim` is MCP-only, so this goes through /mcp as JSON-RPC.
	claims.push(await tool(tick, "graph_claim", { graph_id: GRAPH_ID, node_id: NODE_ID, session_id: SESSION_ID }));
	const remaining = deadline - Date.now();
	if (remaining > TICK_MS) await Bun.sleep(TICK_MS);
}

// ── 3. emit failed open ──────────────────────────────────────────────────────
const emitAnswered = emits.filter((attempt) => attempt.status !== null);
const emitStored = emits.filter((attempt) => (attempt.body as { stored?: boolean } | null)?.stored === true);
const emitDropped = emits.filter((attempt) => (attempt.body as { stored?: boolean } | null)?.stored === false);
const slowest = Math.max(...emits.map((attempt) => attempt.elapsedMs));

check(emitAnswered.length === emits.length, `every emit was answered (${emitAnswered.length}/${emits.length})`);
check(
	emits.every((attempt) => (attempt.body as { id?: string } | null)?.id !== undefined),
	"every emit got its normalised event back, stored or not — the caller can carry on",
);
note(`slowest emit ${Math.round(slowest)} ms`, `${emitStored.length} stored, ${emitDropped.length} dropped`);

// The outage has to have happened. A green run over a healthy ledger proves nothing
// about failing open, and used to be only a note — so the smoke could exit 0 having
// tested none of what it exists to test.
require_(
	emitDropped.length > 0,
	`the ledger refused at least one append (${emitDropped.length} of ${emits.length})`,
	emitDropped.length === 0 ? "the ledger stayed healthy for the whole window; blackhole it and run again" : undefined,
);
if (emitDropped.length > 0) {
	check(
		emitDropped.every((attempt) => attempt.status === 503),
		"a refused append is reported as 503 with the normalised event, not as a silent success",
	);
}

// ── 4. claim failed closed ───────────────────────────────────────────────────
//
// Read from the claim's own `decision`, not from the absence of a grant. "Not granted"
// is also what an unknown node, a missing index and a transport error all look like,
// so it was a check that could pass for the wrong reason; `revoked` can only come from
// the withdrawal path actually running.
const claimsAnswered = claims.filter((attempt) => attempt.status !== null);
const decisions = claims.map((attempt) => toolResult(attempt)?.decision);
const granted = decisions.filter((decision) => decision === "granted");
const revoked = decisions.filter((decision) => decision === "revoked");
const undecided = claims.filter((attempt) => toolResult(attempt) === null);

check(claimsAnswered.length === claims.length, `every claim call was answered (${claimsAnswered.length}/${claims.length})`);
check(
	granted.length === 0,
	"no claim was granted while the ledger was refusing",
	granted.length > 0 ? `${granted.length} claim(s) were granted — fail-closed did not hold` : undefined,
);
if (undecided.length > 0) {
	// With the reason attached: every one of these is a layer refusing before the tool
	// ran — a transport status, the audit gate's JSON-RPC error, or the tool's own throw
	// — and the operator is otherwise left to guess which.
	note(
		`${undecided.length} claim call(s) returned no decision`,
		`an error rather than a verdict — the withdrawal path did not run for those; first: ${
			whyNoDecision(undecided[0] as Attempt) ?? "unknown"
		}`,
	);
}
require_(
	revoked.length > 0,
	`the substrate withdrew at least one claim (${revoked.length} of ${claims.length})`,
	revoked.length > 0
		? undefined
		: health.greptime !== true
			? "no ledger is configured, so claims are deliberately fail-open; run against a deployment with both stores and blackhole the ledger"
			: "no claim reported `revoked`; the withdrawal path was not exercised",
);

// ── 5. the audit chain holds both halves ─────────────────────────────────────
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

// ── 6. the SLOs saw it ───────────────────────────────────────────────────────
for (const slo of bundle?.slos ?? []) note(`slo ${slo.id}`, `${slo.status} — ${slo.detail}`);

const emitSuccess = bundle?.slos?.find((slo) => slo.id === "emit.success");
if (emitDropped.length > 0) {
	check(
		emitSuccess?.status === "breached",
		"the emit-success objective reports the outage",
		emitSuccess ? `it reports ${emitSuccess.status}` : "it was not evaluated",
	);
}

// ── 7. tokens and cost were attributed ───────────────────────────────────────
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
if (REHEARSAL) {
	// Never let a rehearsal be mistaken for a proof. It is green by a different rule.
	process.stdout.write(
		"\nCHAOS_REHEARSAL was set: the checks that require the outage to have actually happened were " +
			"downgraded to notes. This run does not prove fail-open or fail-closed behaviour.\n",
	);
}
process.stdout.write(
	`\nThis appended ${emits.length} note event(s) under ${GRAPH_ID}. The ledger is append-only, so they stay; ` +
		"they carry no repo, so no brief shows them.\n\n",
);
process.exit(failed.length === 0 ? 0 : 1);
