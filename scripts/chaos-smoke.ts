#!/usr/bin/env bun
/**
 * Live chaos smoke for SPE-4793: **Greptime down for 60 s → emit fails open,
 * claim fails closed** — and, since uplift-2 R2, **any plane down → the
 * breaker opens, `/healthz` names it, the brief still answers in time**.
 *
 *   bun run smoke:chaos                      # the ledger, as before
 *   bun run smoke:chaos -- --plane hindsight # one of index|hindsight|lightrag|cache
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
 * Point it at the service and make the plane unreachable for the window:
 *
 *   # terminal 1 — blackhole the plane for 60 s, then restore
 *   sudo iptables -I OUTPUT -d <plane-ip> -j DROP && sleep 60 \
 *     && sudo iptables -D OUTPUT -d <plane-ip> -j DROP
 *
 *   # terminal 2
 *   SUBSTRATE_URL=http://127.0.0.1:7410 SUBSTRATE_TOKEN=… bun run smoke:chaos -- --plane <name>
 *
 * `DROP` rather than `REJECT` on purpose: a dropped packet makes the client wait for
 * its own timeout, which is the failure mode a real Railway outage produces and the
 * one that actually tests whether the substrate fails open inside a hook's budget. A
 * `REJECT` returns immediately and proves much less. The cache plane is loopback:
 * stop it (`systemctl stop redis-server`) rather than blackhole it.
 *
 * ## It cannot pass without exercising the outage
 *
 * A smoke that goes green having proven nothing is worse than no smoke. The run
 * **fails** unless the outage was observed: for the ledger, at least one emit refused
 * and at least one claim withdrawn; for any other plane, at least one `/healthz` read
 * during the window reporting that plane `ok: false` or its breaker `open`. Run it
 * with no blackhole and it exits non-zero saying which half did not happen.
 *
 * `CHAOS_REHEARSAL=1` turns those checks into notes, for checking the script itself
 * against a healthy deployment. It is the only way to get a green run without an
 * outage, and it says so in the report. **Every check that only holds during the
 * outage goes through `require_`**, including "no claim was granted": a healthy
 * deployment grants claims, and that is the behaviour, so a rehearsal that failed on it
 * was failing on the deployment being healthy — which is the one thing a rehearsal
 * assumes.
 */

export const CHAOS_PLANES = ["greptime", "index", "hindsight", "lightrag", "cache"] as const;
export type ChaosPlane = (typeof CHAOS_PLANES)[number];

/** `--plane <name>` or `--plane=<name>`; the ledger when absent. Anything else is a usage error. */
export function parseArgs(argv: readonly string[]): { plane: ChaosPlane } | { error: string } {
	let plane: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--plane") {
			plane = argv[i + 1];
			i += 1;
		} else if (arg.startsWith("--plane=")) {
			plane = arg.slice("--plane=".length);
		} else {
			return { error: `unknown argument ${arg}; usage: chaos-smoke [--plane ${CHAOS_PLANES.join("|")}]` };
		}
		if (plane === undefined || plane === "") return { error: `--plane needs one of ${CHAOS_PLANES.join("|")}` };
	}
	if (plane === undefined) return { plane: "greptime" };
	if (!(CHAOS_PLANES as readonly string[]).includes(plane)) {
		return { error: `unknown plane ${plane}; one of ${CHAOS_PLANES.join("|")}` };
	}
	return { plane: plane as ChaosPlane };
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
export function parseBody(text: string): unknown {
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

/**
 * Whether a `/healthz` body shows `plane` down: `ok: false`, or its breaker
 * `open`. An unconfigured plane (`ok: null`, no breaker) is not an outage, and
 * neither is a body without `planes` at all — an older server proves nothing.
 */
export function planeOutageIn(body: unknown, plane: ChaosPlane): boolean {
	if (body === null || typeof body !== "object" || !("planes" in body)) return false;
	const planes = body.planes;
	if (planes === null || typeof planes !== "object" || !(plane in planes)) return false;
	const entry = (planes as Record<string, unknown>)[plane];
	if (entry === null || typeof entry !== "object") return false;
	const ok = "ok" in entry ? entry.ok : undefined;
	const breaker = "breaker" in entry ? entry.breaker : null;
	const state = breaker !== null && typeof breaker === "object" && "state" in breaker ? breaker.state : null;
	return ok === false || state === "open";
}

/** Whether a read answered `degraded: true` — the fail-open shape recall and docs search share. */
export function degradedIn(body: unknown): boolean {
	return body !== null && typeof body === "object" && "degraded" in body && body.degraded === true;
}

/** The read that must degrade while `plane` is down, if any; the brief covers the rest. */
export function degradedReadFor(plane: ChaosPlane): { path: string; body: Record<string, unknown> } | null {
	if (plane === "hindsight") return { path: "/memory/recall", body: { query: "chaos smoke" } };
	if (plane === "lightrag") return { path: "/docs/search", body: { question: "chaos smoke" } };
	return null;
}

interface Attempt {
	status: number | null;
	body: unknown;
	/** Wall time the caller waited. The fail-open claim is about this, not just the status. */
	elapsedMs: number;
	error?: string;
}

interface Tally {
	ok: boolean;
	what: string;
	detail?: string | undefined;
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	const PLANE = parsed.plane;
	const BASE = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const WINDOW_MS = Number(process.env.CHAOS_WINDOW_MS ?? 60_000);
	const TICK_MS = Number(process.env.CHAOS_TICK_MS ?? 2000);
	/** Generous: the point is to see the hook's own budget respected, not to race it. */
	const REQUEST_TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 10_000);
	/** The brief's own budget: a degraded brief that takes longer than this failed the hook anyway. */
	const BRIEF_BUDGET_MS = 1500;
	const GRAPH_ID = `ut-chaos-${Date.now().toString(36)}`;
	const SESSION_ID = `chaos-${Date.now().toString(36)}`;
	const NODE_ID = "n1";
	/** Allows a green run against a healthy deployment, for checking the script itself. */
	const REHEARSAL = /^(1|true|yes)$/i.test(process.env.CHAOS_REHEARSAL?.trim() ?? "");

	const headers = (): Record<string, string> => {
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
	};

	const call = async (path: string, body?: unknown): Promise<Attempt> => {
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
	};

	const results: Tally[] = [];

	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push({ ok, what, detail });
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};

	const note = (what: string, detail?: string): void => {
		process.stdout.write(`  --   ${what}${detail ? ` — ${detail}` : ""}\n`);
	};

	/** A check that only a rehearsal is allowed to skip. */
	const require_ = (ok: boolean, what: string, detail?: string): void => {
		if (ok || !REHEARSAL) check(ok, what, detail);
		else note(`${what} (not exercised; CHAOS_REHEARSAL is set)`, detail);
	};

	/** One MCP tool call over `/mcp`, as JSON-RPC. */
	const tool = (id: number, name: string, args: Record<string, unknown>): Promise<Attempt> =>
		call("/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

	/** Why a call produced no decision: the layer that refused before the tool ran. */
	const whyNoDecision = (attempt: Attempt): string | null => {
		if (attempt.status === null) return attempt.error ?? "no response";
		if (attempt.status !== 200) return `HTTP ${attempt.status}`;
		const body = attempt.body as { error?: { message?: string }; result?: { isError?: boolean } } | null;
		if (body?.error?.message) return body.error.message;
		if (body?.result?.isError === true) return "the tool reported an error";
		if (!body?.result) return "no result in the reply";
		return "the result was not the JSON a decision comes in";
	};

	/** The JSON a tool returned, or null if it errored or answered something else. */
	const toolResult = (attempt: Attempt): Record<string, unknown> | null => {
		const body = attempt.body as { result?: { content?: Array<{ text?: string }> } } | null;
		const text = body?.result?.content?.[0]?.text;
		if (typeof text !== "string") return null;
		try {
			const value: unknown = JSON.parse(text);
			return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};

	const report = (appended: number): number => {
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
		if (appended > 0) {
			process.stdout.write(
				`\nThis appended ${appended} note event(s) under ${GRAPH_ID}. The ledger is append-only, so they stay; ` +
					"they carry no repo, so no brief shows them.\n\n",
			);
		}
		return failed.length === 0 ? 0 : 1;
	};

	const host = (() => {
		try {
			return new URL(BASE).host;
		} catch {
			return "(unparseable SUBSTRATE_URL)";
		}
	})();

	process.stdout.write(`\nSubstrate chaos smoke — ${host}, plane ${PLANE}, graph ${GRAPH_ID}\n\n`);

	// ── 0. the service is there at all ───────────────────────────────────────────
	const boot = await call("/healthz");
	if (boot.status === null) {
		process.stderr.write(
			`substrate-mcp is unreachable at ${BASE}: ${boot.error}\n` +
				"Start it (bun run mcp, or systemctl start substrate-mcp) and set SUBSTRATE_URL.\n",
		);
		return 2;
	}
	if (boot.status === 401) {
		process.stderr.write("substrate-mcp refused the token. Set SUBSTRATE_TOKEN to one of its configured tokens.\n");
		return 2;
	}

	const health = boot.body as {
		greptime?: boolean;
		eventsWritable?: boolean;
		auditDurable?: boolean;
		planes?: Record<string, { ok?: boolean | null }>;
		cache?: { enabled?: boolean };
	};
	note("health at start", JSON.stringify(health));
	check(
		health.auditDurable === true,
		"the MCP audit chain is durable",
		health.auditDurable ? undefined : "SUBSTRATE_AUDIT_PATH is unset, so the trail this smoke writes ends at the next restart",
	);

	if (PLANE !== "greptime") {
		await planeSmoke();
		return report(0);
	}

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
	// This is a statement about an outage, so it is one of the checks the outage has to have
	// happened for. It was unconditional, which made `CHAOS_REHEARSAL` self-contradictory: the
	// rehearsal exists to run the script against a *healthy* deployment, and against a healthy
	// deployment a claim is granted — the correct behaviour — so the rehearsal failed on it
	// while the two checks either side of it were being relaxed for exactly that reason. A
	// granted claim is a failure only when the ledger was refusing, which is what `require_`
	// already encodes.
	require_(
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

	return report(emits.length);

	/**
	 * The per-plane half (uplift-2 R2): during the window, every tick reads
	 * `/healthz`, asks for a brief as `grok-bot`, and — for Hindsight and LightRAG
	 * — makes the read that plane serves. Nothing is appended.
	 */
	async function planeSmoke(): Promise<void> {
		const entry = health.planes?.[PLANE];
		// `ok: null` is "not configured" — except for the cache, whose `null` also
		// covers "enabled but no command has run yet", which `cache.enabled` settles.
		const configured = entry !== undefined && (entry.ok !== null || (PLANE === "cache" && health.cache?.enabled === true));
		if (!configured) {
			check(false, `${PLANE} is configured on this deployment`, "/healthz reports it null (unconfigured, or a server older than uplift-2 R2); nothing to blackhole");
			return;
		}
		const read = degradedReadFor(PLANE);
		process.stdout.write(
			`\nholding for ${Math.round(WINDOW_MS / 1000)} s, one healthz, one brief${read ? ` and one ${read.path}` : ""} every ${TICK_MS} ms\n\n`,
		);

		const healths: Attempt[] = [];
		const briefs: Attempt[] = [];
		const reads: Attempt[] = [];
		const deadline = Date.now() + WINDOW_MS;
		while (Date.now() < deadline) {
			healths.push(await call("/healthz"));
			briefs.push(await call("/brief", { surface: "grok-bot", graph_id: GRAPH_ID, session_id: SESSION_ID }));
			if (read) reads.push(await call(read.path, { ...read.body, surface: "grok-bot" }));
			const remaining = deadline - Date.now();
			if (remaining > TICK_MS) await Bun.sleep(TICK_MS);
		}

		// ── the outage was observed ────────────────────────────────────────────────
		const outages = healths.filter((attempt) => planeOutageIn(attempt.body, PLANE));
		const opened = healths.filter((attempt) => {
			const planes = (attempt.body as { planes?: Record<string, { breaker?: { state?: string } | null }> } | null)?.planes;
			return planes?.[PLANE]?.breaker?.state === "open";
		});
		note(`healthz read ${healths.length} time(s)`, `${outages.length} showed ${PLANE} down, ${opened.length} with its breaker open`);
		require_(
			outages.length > 0,
			`/healthz reported ${PLANE} ok:false or breaker open at least once (${outages.length} of ${healths.length})`,
			outages.length === 0 ? `${PLANE} stayed healthy for the whole window; blackhole it and run again` : undefined,
		);

		// ── the brief still answers inside its budget ──────────────────────────────
		const briefOk = briefs.filter((attempt) => attempt.status === 200);
		const briefSlowest = Math.max(...briefs.map((attempt) => attempt.elapsedMs));
		check(briefOk.length === briefs.length, `every brief answered 200 (${briefOk.length}/${briefs.length})`);
		check(
			briefs.every((attempt) => attempt.elapsedMs <= BRIEF_BUDGET_MS),
			`every brief answered within ${BRIEF_BUDGET_MS} ms (slowest ${Math.round(briefSlowest)} ms)`,
			briefSlowest > BRIEF_BUDGET_MS ? "a brief outlasted the hook's budget while the plane was down" : undefined,
		);

		// ── the plane's own read degraded, not errored ─────────────────────────────
		if (read) {
			const answered = reads.filter((attempt) => attempt.status === 200);
			const degraded = reads.filter((attempt) => degradedIn(attempt.body));
			check(answered.length === reads.length, `every ${read.path} answered 200 (${answered.length}/${reads.length})`);
			require_(
				degraded.length > 0,
				`${read.path} answered degraded:true at least once (${degraded.length} of ${reads.length})`,
				degraded.length === 0 ? `no read degraded; ${PLANE} was never seen down by the read path` : undefined,
			);
		}

		// ── the breaker opened, and /slo names the plane ───────────────────────────
		if (outages.length > 0) {
			check(opened.length > 0, `${PLANE}'s breaker opened during the window`, opened.length === 0 ? "every outage read showed ok:false with the breaker still closed — SUBSTRATE_BREAKER=0, or fewer failures than the threshold" : undefined);
		}
		const slo = await call("/slo");
		const planes = (slo.body as { planes?: Array<{ id: string; status: string; detail: string }> } | null)?.planes ?? [];
		const objective = planes.find((candidate) => candidate.id === `plane.${PLANE}.availability`);
		check(objective !== undefined, `/slo lists plane.${PLANE}.availability`);
		if (objective) note(`slo ${objective.id}`, `${objective.status} — ${objective.detail}`);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
