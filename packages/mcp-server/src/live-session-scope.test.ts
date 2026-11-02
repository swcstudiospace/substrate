/**
 * Phase 72 at the live-session door: a scoped surface's live-session issue and transition are refused at the public routes
 * before any session is read or written. Each test drives the REST route or the MCP tool the way a client does, and asserts the
 * refusal the route answers with. The surface `cursor` is granted `owner/name` only; `owner/other` is registered and not granted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_OWNER, call, cleanupLiveHarness, serveLive, UNKNOWN } from "./live-session-consumer.test-support.ts";

afterEach(cleanupLiveHarness);

const MCP_HEADERS = { accept: "application/json, text/event-stream" };

function scopedEnv(): Record<string, string | undefined> {
	const granted = mkdtempSync(join(tmpdir(), "live-scope-granted-"));
	const other = mkdtempSync(join(tmpdir(), "live-scope-other-"));
	return {
		SUBSTRATE_REPO_REGISTRY: JSON.stringify({
			"owner/name": { checkouts: [granted], worktrees: [] },
			"owner/other": { checkouts: [other], worktrees: [] },
		}),
		SUBSTRATE_REPO_SCOPES: JSON.stringify({ cursor: ["owner/name"] }),
	};
}

/** The ledger writes that are not a refusal's own audit row: a refused request must leave none. */
function nonAuditWrites(events: ReadonlyArray<{ payload?: unknown }>): unknown[] {
	return events.filter((event) => (event.payload as { action?: string } | undefined)?.action !== "repo.scope-refused");
}

describe("live-session issue under scope, at the public routes", () => {
	test("boundary: REST issue of a session for an ungranted repository is refused before any session is written", async () => {
		const h = await serveLive(scopedEnv());
		const reply = await h.post("/steering/sessions", { repo_id: "owner/other", state: "ACTIVE" }, AUTH_OWNER);
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "not-declared-for-scope" });
		expect(nonAuditWrites(h.ledger.events)).toHaveLength(0);
	});

	test("boundary: MCP docs_steering_session issue for an ungranted repository is refused before any session is written", async () => {
		const h = await serveLive(scopedEnv());
		const reply = await h.post("/mcp", call(1, "docs_steering_session", { repo_id: "owner/other", state: "ACTIVE" }), { ...MCP_HEADERS, ...AUTH_OWNER });
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "not-declared-for-scope" });
		expect(nonAuditWrites(h.ledger.events)).toHaveLength(0);
	});
});

describe("live-session transition under scope, at the public routes", () => {
	test("boundary: MCP docs_steering_session transition by a scoped surface is refused before the session authority is read", async () => {
		const h = await serveLive(scopedEnv());
		const reply = await h.post(
			"/mcp",
			call(2, "docs_steering_session", { session_id: UNKNOWN, session_binding: "0".repeat(64), repo_id: "owner/name", state: "RESUMED" }),
			{ ...MCP_HEADERS, ...AUTH_OWNER },
		);
		expect(reply.status).toBe(403);
		expect(await reply.json()).toMatchObject({ error: "not-declared-for-scope" });
		expect(nonAuditWrites(h.ledger.events)).toHaveLength(0);
		expect(h.ledger.reads).toBe(0);
	});
});
