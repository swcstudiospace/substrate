import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runSteer, type SteerDeps } from "../../cli/src/steer/index.ts";
import { issueLiveSession } from "./planning/live-session.test-support.ts";
import { listSteering, LiveSessionBoundaryError, queueSteering } from "./planning/steering-tools.ts";
import { AUTH_OWNER, AUTH_FOREIGN, AUTH_OPERATOR, OWNER, FOREIGN, OPERATOR, UNKNOWN, NOT_FOUND, UNAVAILABLE, AUDIT_UNAVAILABLE, call, cleanupLiveHarness, responseFingerprint, serveLive, settle, toolValue } from "./live-session-consumer.test-support.ts";

const directories: string[] = [];
afterEach(async () => { await cleanupLiveHarness(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const requestTarget = z.object({ session_id: z.string(), binding_file: z.string() });

// These cases intentionally use the same bearer for independent siblings: knowing the public handle is never a grant.
const variants = ["missing-proof", "sibling-proof", "wrong-proof", "foreign", "unknown", "expired", "closed"] as const;
const operations = ["directives", "wait", "heartbeat", "close", "docs", "brief", "queue", "ack"] as const;

describe("real CLI and REST isolation", () => {
	test("production CLI open/list/heartbeat/close cooperates with real HTTP and a private retained file", async () => {
		const h = await serveLive();
		const directory = mkdtempSync(join(tmpdir(), "live-http-cli-")); directories.push(directory);
		const file = join(directory, "binding.json");
		const out: string[] = []; const err: string[] = []; const printed: string[] = [];
		const deps: SteerDeps = {
			url: h.base, tokenFor: (surface) => surface === "cursor" ? "tok-live-cursor" : undefined,
			timeoutMs: 5000, now: () => new Date(), repo: () => "owner/name", out: (text) => { out.push(text); printed.push(text); }, err: (text) => { err.push(text); printed.push(text); }, bindingDirectory: directory,
			fetch: (url, init) => fetch(url, init),
		};
		expect(await runSteer(["open", "--surface", "cursor", "--repo", "owner/name", "--binding-file", file, "--json"], deps)).toBe(0);
		const opened = requestTarget.parse(JSON.parse(out.join("")));
		expect(opened.binding_file).toBe(file); expect(statSync(file).mode & 0o777).toBe(0o600);
		const retained = z.object({ session_binding: z.string(), expires_at: z.string(), session_id: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
		expect(retained.session_id).toBe(opened.session_id);
		const initialExpiry = retained.expires_at;
		expect(out.join("") + err.join("")).not.toContain(retained.session_binding);
		out.length = 0;
		expect(await runSteer(["list", "--surface", "cursor", "--session", opened.session_id, "--binding-file", file, "--json"], deps)).toBe(0);
		const denied = await h.get(`/steering/directives?session_id=${opened.session_id}`);
		expect(denied.status).toBe(404); expect(await denied.json()).toEqual(NOT_FOUND);
		h.authority.advance(1000); out.length = 0;
		expect(await runSteer(["heartbeat", "--surface", "cursor", "--session", opened.session_id, "--binding-file", file, "--json"], deps)).toBe(0);
		const renewed = z.object({ expires_at: z.string(), session_binding: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
		expect(renewed.expires_at > initialExpiry).toBe(true); expect(renewed.session_binding).toBe(retained.session_binding);
		out.length = 0;
		expect(await runSteer(["close", "--surface", "cursor", "--session", opened.session_id, "--binding-file", file, "--json"], deps)).toBe(0);
		expect(existsSync(file)).toBe(false); expect(printed.join("")).not.toContain(retained.session_binding);
		const closed = await h.get(`/steering/directives?session_id=${opened.session_id}`, { ...AUTH_OWNER, "x-substrate-session-binding": retained.session_binding });
		expect(closed.status).toBe(404); expect(await closed.json()).toEqual(NOT_FOUND);
	});

	for (const operation of operations) test(`${operation}: every denied target has identical bytes, application headers and no effect even with failed audit`, async () => {
		const h = await serveLive();
		const closed = await issueLiveSession(h.authority, { caller: OWNER });
		const expired = await issueLiveSession(h.authority, { caller: OWNER });
		// Retain real directives against terminal targets, not unknown-directive substitutes.
		const directiveIds = new Map<string, string>();
		for (const row of [closed, expired]) {
			const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: row.sessionId, action: "annotate", priority: "normal", body: "PRIVATE-MATRIX-BODY", conflicts_with_active_plan: false });
			if (queued.status !== "queued") throw new Error("expected fixture directive");
			directiveIds.set(row.sessionId, queued.directive_id);
		}
		await h.authority.close(closed.access); h.authority.advance(3_600_001);
		const victim = await issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-MATRIX-DIRECTION", planningHash: "PRIVATE-MATRIX-PLAN" });
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: victim.sessionId, action: "annotate", priority: "normal", body: "PRIVATE-MATRIX-BODY", conflicts_with_active_plan: false });
		if (queued.status !== "queued") throw new Error("expected fixture directive");
		directiveIds.set(victim.sessionId, queued.directive_id);
		h.setAuditFailure(true);
		const fingerprints: unknown[] = [];
		for (const variant of variants) {
			const row = variant === "closed" ? closed : variant === "expired" ? expired : victim;
			const target = variant === "unknown" ? UNKNOWN : row.sessionId;
			const proof = variant === "missing-proof" ? undefined : variant === "sibling-proof" ? sibling.sessionBinding : variant === "wrong-proof" ? "0".repeat(64) : row.sessionBinding;
			const headers = { ...(variant === "foreign" ? AUTH_FOREIGN : AUTH_OWNER), ...(proof === undefined ? {} : { "x-substrate-session-binding": proof }) };
			const historyBefore = h.history.entries.length; const auditsBefore = h.batches.length;
			let response: Response;
			switch (operation) {
				case "directives": response = await h.get(`/steering/directives?session_id=${target}`, headers); break;
				case "wait": response = await h.get(`/steering/wait?session_id=${target}&timeout_ms=1`, headers); break;
				case "heartbeat": response = await h.post("/steering/sessions/heartbeat", { session_id: target }, headers); break;
				case "close": response = await h.post("/steering/sessions/close", { session_id: target }, headers); break;
				case "docs": response = await h.post("/docs/search", { question: "public question", steering_session_id: target }, headers); break;
				case "brief": response = await h.post("/brief", { repo: "owner/name", steering_session_id: target }, { ...headers, "if-none-match": "*" }); break;
				case "queue": response = await h.post("/steering/queue", { session_id: target, action: "pause", body: "PRIVATE-MATRIX-BODY" }, headers); break;
				case "ack": response = await h.post("/steering/acknowledge", { directive_id: directiveIds.get(target) ?? "unknown-directive", outcome: "applied" }, headers); break;
			}
			const fingerprint = await responseFingerprint(response);
			expect(fingerprint.status).toBe(404); expect(JSON.parse(fingerprint.body)).toEqual(NOT_FOUND); fingerprints.push(fingerprint);
			expect(h.history.entries.length).toBe(historyBefore); expect(h.batches.length).toBe(auditsBefore);
		}
		for (const fingerprint of fingerprints) expect(fingerprint).toEqual(fingerprints[0]);
		expect(await h.authority.read(victim.access, "private-read")).toEqual({ ok: true, snapshot: victim.snapshot });
		expect(JSON.stringify(fingerprints)).not.toContain(victim.sessionBinding);
	});

	test("explicit operator override is real but cannot target unknown, expired or closed identities", async () => {
		const h = await serveLive();
		const expired = await issueLiveSession(h.authority, { caller: OWNER }); h.authority.advance(3_600_001);
		const closed = await issueLiveSession(h.authority, { caller: OWNER }); await h.authority.close(closed.access);
		const active = await issueLiveSession(h.authority, { caller: OWNER });
		for (const target of [UNKNOWN, expired.sessionId, closed.sessionId]) {
			const queue = await h.post("/steering/queue", { session_id: target, action: "pause", body: "Hold" }, AUTH_OPERATOR);
			expect(queue.status).toBe(404); expect(await queue.json()).toEqual(NOT_FOUND);
		}
		const queued = await h.post("/steering/queue", { session_id: active.sessionId, action: "pause", body: "Hold" }, AUTH_OPERATOR);
		expect(queued.status).toBe(200);
		const { directive_id } = z.object({ directive_id: z.string() }).parse(await queued.json());
		const ack = await h.post("/steering/acknowledge", { directive_id, outcome: "applied" }, AUTH_OPERATOR);
		expect(ack.status).toBe(200); expect(await ack.json()).toMatchObject({ status: "acknowledged", checkpoint_hint: { trigger: "steering", directive_id } });
		expect((await h.get(`/steering/directives?session_id=${active.sessionId}`, AUTH_OPERATOR)).status).toBe(200);
	});

	for (const auditMode of ["failing", "missing"] as const) test(`direct service required writes with ${auditMode} audit cannot mutate, but denied targets stay404`, async () => {
		const h = await serveLive({}, { missingAudit: auditMode === "missing" }); h.setAuditFailure(true);
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		const denied = { session_id: UNKNOWN, session_binding: row.sessionBinding };
		for (const invoke of [
			() => h.substrate.updateLiveSession(OWNER, { ...denied, repo_id: "owner/name", state: "PAUSED" }),
			() => h.substrate.heartbeatLiveSession(OWNER, denied),
			() => h.substrate.closeLiveSession(OWNER, denied),
		]) await expect(invoke()).rejects.toMatchObject({ refusal: NOT_FOUND });
		const target = { session_id: row.sessionId, session_binding: row.sessionBinding };
		for (const invoke of [
			() => h.substrate.updateLiveSession(OWNER, { ...target, repo_id: "owner/name", state: "PAUSED" }),
			() => h.substrate.heartbeatLiveSession(OWNER, target),
			() => h.substrate.closeLiveSession(OWNER, target),
		]) await expect(invoke()).rejects.toMatchObject({ refusal: AUDIT_UNAVAILABLE });
		expect(await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: row.sessionId, action: "pause", body: "Hold", priority: "normal", conflicts_with_active_plan: false })).toEqual(AUDIT_UNAVAILABLE);
		const current = await h.authority.read(row.access, "private-read");
		expect(current).toEqual({ ok: true, snapshot: row.snapshot }); expect(h.history.entries).toHaveLength(0);
	});

	for (const operation of ["list", "directives", "docs", "brief", "heartbeat", "transition", "close", "wait"] as const) test(`direct ${operation} uses trusted context and the full denied-target matrix`, async () => {
		const h = await serveLive();
		const expired = await issueLiveSession(h.authority, { caller: OWNER }); h.authority.advance(3_600_001);
		const closed = await issueLiveSession(h.authority, { caller: OWNER }); await h.authority.close(closed.access);
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		for (const variant of variants) {
			const selected = variant === "expired" ? expired : variant === "closed" ? closed : row;
			const sessionId = variant === "unknown" ? UNKNOWN : selected.sessionId;
			const sessionBinding = variant === "missing-proof" ? undefined : variant === "sibling-proof" ? sibling.sessionBinding : variant === "wrong-proof" ? "0".repeat(64) : selected.sessionBinding;
			const caller = variant === "foreign" ? FOREIGN : OWNER;
			const input = { session_id: sessionId, session_binding: sessionBinding };
			const before = h.history.entries.length;
			if (operation === "list") expect(await listSteering(h.substrate.steering, caller, input)).toEqual(NOT_FOUND);
			else {
				let pending: Promise<unknown>;
				switch (operation) {
					case "directives": pending = h.substrate.readLiveDirectives(caller, { sessionId, status: "all" }, sessionBinding); break;
					case "wait": pending = h.substrate.waitLiveDirectives(caller, { sessionId, after: null, timeoutMs: 1 }, sessionBinding, new AbortController().signal); break;
					case "docs": pending = h.substrate.searchDocs({ question: "q", steering_session_id: sessionId }, caller.surface, { caller, sessionBinding }); break;
					case "brief": pending = h.substrate.brief({ surface: caller.surface, repo: "owner/name", steering_session_id: sessionId }, { caller, sessionBinding }); break;
					case "transition": pending = h.substrate.updateLiveSession(caller, { ...input, repo_id: "owner/name", state: "PAUSED" }); break;
					case "heartbeat": pending = h.substrate.heartbeatLiveSession(caller, input); break;
					case "close": pending = h.substrate.closeLiveSession(caller, input); break;
				}
				await expect(pending).rejects.toMatchObject({ refusal: NOT_FOUND });
			}
			expect(h.history.entries.length).toBe(before);
		}
		expect(await h.authority.read(row.access, "private-read")).toEqual({ ok: true, snapshot: row.snapshot });
		// A public attribution surface/handle is not the trusted access option.
		await expect(h.substrate.searchDocs({ question: "q", steering_session_id: row.sessionId }, OWNER.surface)).rejects.toBeInstanceOf(LiveSessionBoundaryError);
	});

	test("metadata discovery lets siblings discover IDs, never proof/text/hash/counts or private fanout", async () => {
		const h = await serveLive();
		const rows = await Promise.all([issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-DISCOVERY-A", planningHash: "PRIVATE-HASH-A" }), issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-DISCOVERY-B", planningHash: "PRIVATE-HASH-B" })]);
		const response = await h.get("/steering/sessions?repo_id=owner/name"); expect(response.status).toBe(200);
		const metadata = z.object({ sessions: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json());
		expect(metadata.sessions.map((row) => row.session_id).sort()).toEqual(rows.map((row) => row.sessionId).sort());
		for (const row of metadata.sessions) expect(Object.keys(row).sort()).toEqual(["expires_at", "repo_id", "session_id", "state", "surface", "updated_at"]);
		const encoded = JSON.stringify(metadata); expect(encoded).not.toContain("PRIVATE-");
		for (const row of rows) expect(encoded).not.toContain(row.sessionBinding);
		const attempt = toolValue(await h.rpc(call(1, "docs_steering_session", { session_id: rows[0]?.sessionId, repo_id: "owner/name", state: "ACTIVE" }), AUTH_FOREIGN));
		expect(attempt).toEqual(NOT_FOUND);
	});

	for (const source of ["retrieval", "ledger"] as const) for (const failure of ["close", "expiry", "outage"] as const) for (const transport of ["rest", "mcp"] as const) test(`${transport} docs final release after ${source} await rejects ${failure}`, async () => {
		const h = await serveLive(source === "ledger" ? { LIGHTRAG_URL: undefined } : {});
		const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-AWAIT-DIRECTION", planningHash: "PRIVATE-AWAIT-HASH" });
		const release = Promise.withResolvers<void>();
		if (source === "retrieval") h.retrieval.barrier = release.promise;
		else h.ledger.readBarrier = release.promise;
		const input = { question: "PUBLIC-AWAIT-QUESTION", steering_session_id: row.sessionId, context: source === "ledger" };
		const pending = transport === "rest"
			? h.post("/docs/search", input, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding })
			: h.rpc(call(300, "docs_search", { ...input, session_binding: row.sessionBinding }));
		// Observe the outcome now: if a settle failure below ends the test early, a later rejection must not go unhandled.
		const observed = pending.catch(() => undefined);
		try {
			await settle(() => source === "retrieval" ? h.retrieval.reads > 0 : h.ledger.reads > 0);
			if (failure === "close") await h.authority.close(row.access);
			else if (failure === "expiry") h.authority.advance(3_600_001);
			else h.authority.unavailable = true;
		} finally {
			release.resolve();
			await observed;
		}
		const answer = await pending;
		if (answer instanceof Response) {
			expect(answer.status).toBe(failure === "outage" ? 503 : 404);
			expect(await answer.json()).toEqual(failure === "outage" ? UNAVAILABLE : NOT_FOUND);
		} else expect(toolValue(answer)).toEqual(failure === "outage" ? UNAVAILABLE : NOT_FOUND);
		expect(JSON.stringify(h.retrieval.inputs)).not.toContain(row.sessionBinding);
		if (source === "retrieval") expect(JSON.stringify(h.retrieval.inputs)).toContain("PRIVATE-AWAIT-DIRECTION");
		expect(JSON.stringify(h.auditRecords)).not.toContain(row.sessionBinding);
		expect(JSON.stringify(h.ledger.events)).not.toContain("PRIVATE-AWAIT-");
		const requests = h.cacheReads.mock.calls.map(([request]) => ({ klass: request.klass, args: request.args }));
		expect(requests.some((request) => request.klass === "docs-search")).toBe(false);
		// Context recall is keyed by the original public question, not the privately augmented retrieval prompt.
		for (const request of requests.filter((request) => request.klass === "memory-search")) expect(request.args).toMatchObject({ recall: true, query: "PUBLIC-AWAIT-QUESTION" });
		const cachedResults = await Promise.all(h.cacheReads.mock.results.map((result) => result.value));
		const cacheBytes = JSON.stringify({ requests, cachedResults });
		for (const privateValue of ["PRIVATE-AWAIT-DIRECTION", "PRIVATE-AWAIT-HASH", row.sessionBinding, row.sessionId]) expect(cacheBytes).not.toContain(privateValue);
	});

	test("separate validation/authentication errors do not replace denied well-shaped target tests", async () => {
		const h = await serveLive();
		expect((await h.post("/steering/sessions/heartbeat", { session_id: UNKNOWN }, {})).status).toBe(401);
		expect((await h.post("/steering/sessions/heartbeat", {})).status).toBe(400);
		const row = await issueLiveSession(h.authority, { caller: OWNER }); h.authority.unavailable = true;
		const response = await h.get(`/steering/directives?session_id=${row.sessionId}`, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		expect(response.status).toBe(503); expect(await response.json()).toEqual(UNAVAILABLE);
	});
});
