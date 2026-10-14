/**
 * `postEvent` and the replay with the event spool: what is parked, what never
 * is, what a replay sends, and when it refuses to send at all. The server is a
 * real loopback stub (or a `fetch` stand-in where the failure is a transport
 * one), the clock is the real one only where `AbortSignal.timeout` needs it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countSpoolDrops,
	drainEventSpool,
	eventSpool,
	parkEvent,
	postEvent,
	prepareEvent,
	recordRefusal,
	resetSpoolReplayState,
	spoolProbeCacheSize,
} from "./emit.ts";
import { runSpool } from "../../cli/src/spool.ts";
import { EventSpool } from "./spool.ts";
import { isolateSpoolEnv } from "./spool-test-env.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

// Runtime-assembled so no credential shape sits in source (redact-lock rule 4).
const decoy = `ghp_${"a1B2c3D4e5".repeat(4)}`;

const event: EventInput = {
	surface: "claude-code",
	kind: "note",
	summary: "spool-test summary",
	payload: { n: 1 },
};

interface Hit {
	method: string;
	path: string;
	replay: string | null;
	auth: string | null;
	body: string;
}

interface Stub {
	url: string;
	hits: Hit[];
	events: () => Hit[];
	healthz: () => Hit[];
	close: () => void;
}

interface StubRoutes {
	healthz?: () => Response;
	events?: (hit: Hit) => Response | Promise<Response>;
}

const ACCEPTING: StubRoutes = {
	healthz: () => Response.json({ idempotency: "accept", greptime: true }),
	events: () => Response.json({ stored: true }, { status: 202 }),
};

function stub(routes: StubRoutes): Stub {
	const hits: Hit[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const path = new URL(req.url).pathname;
			const hit: Hit = {
				method: req.method,
				path,
				replay: req.headers.get("x-substrate-replay"),
				auth: req.headers.get("authorization"),
				body: await req.text(),
			};
			hits.push(hit);
			if (path === "/healthz") return routes.healthz ? routes.healthz() : Response.json({});
			return routes.events ? routes.events(hit) : Response.json({ stored: true }, { status: 202 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		hits,
		events: () => hits.filter((hit) => hit.path === "/events"),
		healthz: () => hits.filter((hit) => hit.path === "/healthz"),
		close: () => void server.stop(true),
	};
}

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: Uint8Array | string) => {
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	return { lines, restore: () => void (process.stderr.write = original) };
}

let restoreEnv: () => void = () => undefined;
const realFetch = globalThis.fetch;
let stateDir = "";
let stubs: Stub[] = [];
let stderr: { lines: string[]; restore: () => void } | null = null;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "emit-spool-"));
	// Every spool and credential variable cleared (spool explicitly off, an empty tokens dir), restored afterwards.
	restoreEnv = isolateSpoolEnv();
	process.env.SUBSTRATE_STATE_DIR = stateDir;
	resetSpoolReplayState();
	stderr = captureStderr();
});

afterEach(() => {
	for (const server of stubs) server.close();
	stubs = [];
	stderr?.restore();
	stderr = null;
	globalThis.fetch = realFetch;
	restoreEnv();
});

function serve(routes: StubRoutes): Stub {
	const server = stub(routes);
	stubs.push(server);
	return server;
}

function spoolOn(): void {
	process.env.SUBSTRATE_EVENT_SPOOL = "on";
}

function spoolPath(): string {
	return join(stateDir, "event-spool.jsonl");
}

function spooled(): Array<{ key: string; attempts: number; event: Record<string, unknown>; next_at: number }> {
	if (!existsSync(spoolPath())) return [];
	return readFileSync(spoolPath(), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { key: string; attempts: number; event: Record<string, unknown>; next_at: number });
}

function journal(): Record<string, unknown>[] {
	const path = join(stateDir, "refused-emits.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const DOWN: StubRoutes = { events: () => Response.json({ error: "ledger down", stored: false }, { status: 503 }) };

describe("flag off is today's behaviour exactly", () => {
	test("a failed emit parks nothing, sends the bare event, and touches no file", async () => {
		const server = serve(DOWN);
		process.env.SUBSTRATE_URL = server.url;

		const outcome = await postEvent(event, { collector: "t" });

		expect(outcome).toEqual({ kind: "failed", status: 503, error: "ledger down" });
		expect(server.events()[0]?.body).toBe(JSON.stringify(event));
		expect(readdirSync(stateDir)).toEqual([]);
	});

	test("an unreachable substrate and a timeout park nothing", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await postEvent(event, { collector: "t" })).toEqual({ kind: "failed", error: "unreachable" });
		globalThis.fetch = (async () => {
			throw Object.assign(new Error("t"), { name: "TimeoutError" });
		}) as unknown as typeof fetch;
		expect(await postEvent(event, { collector: "t" })).toEqual({ kind: "failed", error: "timeout" });

		expect(readdirSync(stateDir)).toEqual([]);
	});

	test("a refusal writes only the refused journal, as before", async () => {
		const server = serve({ events: () => Response.json({ error: "nope" }, { status: 400 }) });

		await postEvent(event, { collector: "t", url: server.url });

		expect(readdirSync(stateDir)).toEqual(["refused-emits.jsonl"]);
	});

	test("an unknown or misspelled flag value is off, and a pre-existing spool file is never opened by a drain", async () => {
		process.env.SUBSTRATE_EVENT_SPOOL = "enabled";
		const server = serve(ACCEPTING);
		process.env.SUBSTRATE_URL = server.url;
		writeFileSync(spoolPath(), "leftover from an earlier run\n");

		expect(eventSpool()).toBeNull();
		expect(await drainEventSpool({ all: true })).toEqual({ status: "off" });

		expect(server.hits).toEqual([]);
		expect(readFileSync(spoolPath(), "utf8")).toBe("leftover from an earlier run\n");
		expect(stderr?.lines.join("")).toContain("SUBSTRATE_EVENT_SPOOL must be off or on");
	});

	test("parkEvent with the flag off opens nothing and says so", () => {
		const prepared = prepareEvent(event, { collector: "t" });

		expect(parkEvent(prepared, { collector: "t", source: "t", reason: "unreachable" })).toBe(false);
		expect(readdirSync(stateDir)).toEqual([]);
	});
});

describe("what is parked", () => {
	beforeEach(spoolOn);

	test("a 5xx parks the exact body it sent, stamped with ts and a key, in a 0600 file", async () => {
		const server = serve(DOWN);

		const outcome = await postEvent(event, { collector: "t", source: "t.row", url: server.url });

		expect(outcome).toEqual({ kind: "failed", status: 503, error: "ledger down", spooled: true });
		const sent = JSON.parse(server.events()[0]?.body ?? "{}") as Record<string, unknown>;
		expect(typeof sent.ts).toBe("string");
		expect(Number.isNaN(Date.parse(sent.ts as string))).toBe(false);
		expect(sent.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
		const [entry] = spooled();
		expect(entry?.key).toBe(sent.idempotency_key as string);
		expect(entry?.event.ts).toBe(sent.ts as string);
		const parked: Record<string, unknown> = { ...entry?.event, idempotency_key: entry?.key };
		expect(parked).toEqual(sent);
		expect(statSync(spoolPath()).mode & 0o777).toBe(0o600);
	});

	test("a network error and a timeout park the event", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		const unreachable = await postEvent(event, { collector: "t" });
		globalThis.fetch = (async () => {
			throw Object.assign(new Error("t"), { name: "TimeoutError" });
		}) as unknown as typeof fetch;
		const timedOut = await postEvent({ ...event, summary: "second" }, { collector: "t" });

		expect(unreachable).toEqual({ kind: "failed", error: "unreachable", spooled: true });
		expect(timedOut).toEqual({ kind: "failed", error: "timeout", spooled: true });
		expect(spooled().map((entry) => entry.event.summary)).toEqual(["spool-test summary", "second"]);
	});

	test("a 4xx is refused and logged, never parked", async () => {
		for (const status of [400, 401, 403, 413, 429]) {
			const server = serve({ events: () => Response.json({ error: `no ${status}` }, { status }) });
			const outcome = await postEvent(event, { collector: "t", url: server.url });
			expect(outcome).toEqual({ kind: "refused", status, error: `no ${status}` });
		}

		expect(existsSync(spoolPath())).toBe(false);
		expect(journal()).toHaveLength(5);
	});

	test("a stored event is not parked and creates no file", async () => {
		const server = serve(ACCEPTING);

		expect(await postEvent(event, { collector: "t", url: server.url })).toEqual({ kind: "stored" });

		expect(existsSync(spoolPath())).toBe(false);
	});

	test("a planted secret is redacted before the first send and never reaches the spool file", async () => {
		const server = serve(DOWN);
		const leaky: EventInput = {
			...event,
			summary: `deploy with ${decoy}`,
			session_id: `sess-${decoy}`,
			branch: `feat/${decoy}`,
			payload: { note: decoy, nested: { password: "hunter2-not-a-pattern" } },
		};

		await postEvent(leaky, { collector: "t", url: server.url });

		expect(server.events()[0]?.body).not.toContain(decoy);
		expect(server.events()[0]?.body).not.toContain("hunter2");
		expect(readFileSync(spoolPath(), "utf8")).not.toContain(decoy);
		expect(readFileSync(spoolPath(), "utf8")).not.toContain("hunter2");
	});

	test("the bearer is never written to the spool", async () => {
		process.env.SUBSTRATE_TOKEN = "tok-live";
		const server = serve(DOWN);

		await postEvent(event, { collector: "t", url: server.url });

		expect(server.events()[0]?.auth).toBe("Bearer tok-live");
		expect(readFileSync(spoolPath(), "utf8")).not.toContain("tok-live");
	});

	test("an event over the server's body cap is dropped visibly, not parked", async () => {
		const server = serve(DOWN);

		const outcome = await postEvent({ ...event, summary: "x".repeat(1_100_000) }, { collector: "t", url: server.url });

		expect(outcome).toMatchObject({ kind: "failed", status: 503 });
		expect(outcome).not.toHaveProperty("spooled");
		expect(existsSync(spoolPath())).toBe(false);
		expect(countSpoolDrops(stateDir)).toEqual({ oversize: 1 });
	});

	test("overflow drops the oldest and leaves a dropped line with no summary or payload", async () => {
		process.env.SUBSTRATE_EVENT_SPOOL_MAX = "2";
		const server = serve(DOWN);
		for (const summary of ["first", "second", "third"]) {
			await postEvent({ ...event, summary, payload: { secret: "payload-marker" } }, { collector: "t", source: "t.row", url: server.url });
		}

		expect(spooled().map((entry) => entry.event.summary)).toEqual(["second", "third"]);
		const dropped = journal().filter((line) => line.kind === "dropped");
		expect(dropped).toHaveLength(1);
		expect(dropped[0]).toMatchObject({ collector: "t", source: "t.row", surface: "claude-code", status: 0, error: "spool-overflow event_kind=note" });
		expect(JSON.stringify(dropped)).not.toContain("first");
		expect(JSON.stringify(dropped)).not.toContain("payload-marker");
		expect(stderr?.lines.join("")).toContain("dropped spooled event");
		expect(countSpoolDrops(stateDir)).toEqual({ overflow: 1 });
	});
});

describe("the key and the first-attempt ts", () => {
	test("the same content at the same ts has the same key; any content difference changes it", () => {
		const at = "2026-01-01T00:00:00.000Z";
		const a = prepareEvent({ ...event, ts: at, payload: { a: 1, b: { c: 2, d: 3 } } }, { collector: "t" });
		const reordered = prepareEvent({ ...event, ts: at, payload: { b: { d: 3, c: 2 }, a: 1 } }, { collector: "t" });

		expect(a.key).toBe(reordered.key);
		for (const changed of [
			{ ...event, ts: at, payload: { a: 2, b: { c: 2, d: 3 } } },
			{ ...event, ts: "2026-01-01T00:00:00.001Z", payload: { a: 1, b: { c: 2, d: 3 } } },
			{ ...event, ts: at, summary: "other", payload: { a: 1, b: { c: 2, d: 3 } } },
			{ ...event, ts: at, session_id: "s2", payload: { a: 1, b: { c: 2, d: 3 } } },
			{ ...event, ts: at, kind: "warning" as const, payload: { a: 1, b: { c: 2, d: 3 } } },
		]) {
			expect(prepareEvent(changed, { collector: "t" }).key).not.toBe(a.key);
		}
		expect(prepareEvent({ ...event, ts: at, payload: { a: 1, b: { c: 2, d: 3 } } }, { collector: "other" }).key).not.toBe(a.key);
	});

	test("a caller ts is kept as the same instant in ISO form; a missing one is stamped once and fixed in the body", () => {
		const given = prepareEvent({ ...event, ts: "2026-03-04T05:06:07Z" }, { collector: "t" });
		const stamped = prepareEvent(event, { collector: "t" });

		expect(given.event.ts).toBe("2026-03-04T05:06:07.000Z");
		expect(JSON.parse(given.body).ts).toBe("2026-03-04T05:06:07.000Z");
		expect(JSON.parse(stamped.body).ts).toBe(stamped.event.ts as string);
		expect(Math.abs(Date.parse(stamped.event.ts as string) - Date.now())).toBeLessThan(5000);
	});

	test("a numeric epoch-ms ts is normalised to that instant, not replaced by now; zero and non-finite count as absent", () => {
		const ms = Date.parse("2026-03-04T05:06:07.000Z");
		const numeric = prepareEvent({ ...event, ts: ms as unknown as string }, { collector: "t" });

		expect(numeric.event.ts).toBe("2026-03-04T05:06:07.000Z");
		expect(JSON.parse(numeric.body).ts).toBe("2026-03-04T05:06:07.000Z");
		for (const absent of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
			const stamped = prepareEvent({ ...event, ts: absent as unknown as string }, { collector: "t" });
			expect(Math.abs(Date.parse(stamped.event.ts as string) - Date.now())).toBeLessThan(5000);
		}
	});

	test("a delimiter inside a field cannot alias a neighbouring field", () => {
		const at = "2026-01-01T00:00:00.000Z";
		const a = prepareEvent({ ...event, ts: at, summary: "x|y", repo: "z" }, { collector: "t" });
		const b = prepareEvent({ ...event, ts: at, summary: "x", repo: "y|z" }, { collector: "t" });

		expect(a.key).not.toBe(b.key);
	});

	test("a valid caller key is used as given; a malformed one falls back to the content key", () => {
		const good = prepareEvent(event, { collector: "t", idempotencyKey: "gk1:abcdef0123456789" });
		const short = prepareEvent(event, { collector: "t", idempotencyKey: "short" });
		const spaced = prepareEvent(event, { collector: "t", idempotencyKey: "has space in it" });

		expect(good.key).toBe("gk1:abcdef0123456789");
		expect(short.key).toMatch(/^ik1:[0-9a-f]{64}$/);
		expect(spaced.key).toMatch(/^ik1:[0-9a-f]{64}$/);
	});

	test("an event the server will refuse as malformed keeps its bad ts and is refused, not parked", async () => {
		spoolOn();
		const server = serve({ events: () => Response.json({ error: "invalid ts: nope" }, { status: 400 }) });

		const outcome = await postEvent({ ...event, ts: "nope" }, { collector: "t", url: server.url });

		expect(outcome).toMatchObject({ kind: "refused", status: 400 });
		expect(JSON.parse(server.events()[0]?.body ?? "{}").ts).toBe("nope");
		expect(existsSync(spoolPath())).toBe(false);
	});
});

describe("replay", () => {
	beforeEach(spoolOn);

	async function park(server: Stub, summary = "parked"): Promise<void> {
		const down = serve(DOWN);
		await postEvent({ ...event, summary }, { collector: "t", source: "t.row", url: down.url });
		process.env.SUBSTRATE_URL = server.url;
	}

	test("replays with the marker and the body it first sent, then empties the spool; the live attempt carried no marker", async () => {
		const down = serve(DOWN);
		await postEvent(event, { collector: "t", url: down.url });
		const live = down.events()[0] as Hit;
		const server = serve(ACCEPTING);
		process.env.SUBSTRATE_URL = server.url;

		const result = await drainEventSpool({ all: true });

		expect(live.replay).toBeNull();
		expect(result).toMatchObject({ status: "ran", delivered: 1, remaining: 0 });
		expect(server.events()).toHaveLength(1);
		expect(server.events()[0]?.replay).toBe("1");
		expect(server.events()[0]?.body).toBe(live.body);
		expect(spooled()).toEqual([]);
	});

	test("a timeout after the server stored the row replays harmlessly: same key, one row", async () => {
		const rows = new Set<string>();
		const server = serve({
			healthz: ACCEPTING.healthz,
			events: (hit) => {
				const key = (JSON.parse(hit.body) as { idempotency_key: string }).idempotency_key;
				if (hit.replay === "1" && rows.has(key)) return Response.json({ stored: true, deduplicated: true }, { status: 202 });
				rows.add(key);
				// The first attempt landed in the ledger but the answer was lost.
				return hit.replay === "1" ? Response.json({ stored: true }, { status: 202 }) : Response.json({ stored: false }, { status: 503 });
			},
		});
		process.env.SUBSTRATE_URL = server.url;

		const outcome = await postEvent(event, { collector: "t" });
		const result = await drainEventSpool({ all: true });

		expect(outcome).toMatchObject({ kind: "failed", spooled: true });
		expect(result).toMatchObject({ status: "ran", delivered: 1 });
		expect(rows.size).toBe(1);
		expect(spooled()).toEqual([]);
	});

	test("never replays against a server that reports idempotency off, lacks the field, or has no ledger", async () => {
		for (const healthz of [
			() => Response.json({ idempotency: "off", greptime: true }),
			() => Response.json({ greptime: true }),
			() => Response.json({ idempotency: "bogus", greptime: true }),
			() => Response.json({ idempotency: "accept", greptime: false }, { status: 503 }),
			() => new Response("not json", { status: 200 }),
		]) {
			resetSpoolReplayState();
			const server = serve({ healthz, events: ACCEPTING.events });
			await park(server, `parked-${stubs.length}`);

			const result = await drainEventSpool({ all: true });

			expect(result.status).toBe("held");
			expect(server.events()).toEqual([]);
		}
		expect(spooled().length).toBe(5);
	});

	test("holds, consuming no attempt, when the ledger is reachable but not writable, or healthz is not 200", async () => {
		const cases: Array<[string, () => Response]> = [
			["ledger-not-writable", () => Response.json({ idempotency: "accept", greptime: true, eventsWritable: false }, { status: 503 })],
			["ledger-not-writable", () => Response.json({ idempotency: "accept", greptime: true, ledger: { writable: false } })],
			["healthz-500", () => Response.json({ idempotency: "accept", greptime: true, eventsWritable: true }, { status: 500 })],
		];
		for (const [reason, healthz] of cases) {
			resetSpoolReplayState();
			const server = serve({ healthz, events: ACCEPTING.events });
			await park(server, `parked-${stubs.length}`);

			expect(await drainEventSpool({ all: true })).toEqual({ status: "held", reason, dropped: 0, remaining: expect.any(Number) });
			expect(server.events()).toEqual([]);
		}
		expect(spooled().map((entry) => entry.attempts)).toEqual([1, 1, 1]);
	});

	describe("mixed surfaces and credentials", () => {
		const GOOD = "tok-good";
		const BAD = "tok-revoked";

		/** A per-surface token file, as the resolver reads it. */
		function tokenFor(surface: string, token: string): void {
			writeFileSync(join(process.env.SUBSTRATE_TOKENS_DIR as string, surface), `${token}\n`);
		}

		/** Parks one entry directly: `ageMs` back in time, so it is expired, due or (age 0) not yet due. */
		function seed(surface: string, summary: string, ageMs: number): void {
			const at = Date.now() - ageMs;
			new EventSpool({ path: spoolPath(), now: () => at }).append({
				key: `key-${summary}-00000000`,
				collector: "t",
				source: "t.row",
				event: { surface: surface as EventInput["surface"], kind: "note", summary, ts: new Date(at).toISOString() },
				reason: "unreachable",
			});
		}

		/** /events accepts only GOOD; /healthz too, unless `openHealth` (any credential may read it). Everything refused is 401. */
		function authServer(openHealth = false): Stub {
			const seen: Hit[] = [];
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async (req) => {
					const path = new URL(req.url).pathname;
					const auth = req.headers.get("authorization");
					await req.text();
					seen.push({ method: req.method, path, replay: req.headers.get("x-substrate-replay"), auth, body: "" });
					if (path === "/healthz" && openHealth) return Response.json({ idempotency: "accept", greptime: true });
					if (auth !== `Bearer ${GOOD}`) return Response.json({ error: "unknown or missing bearer token" }, { status: 401 });
					if (path === "/healthz") return Response.json({ idempotency: "accept", greptime: true });
					return Response.json({ stored: true }, { status: 202 });
				},
			});
			const handle: Stub = {
				url: `http://127.0.0.1:${server.port}`,
				hits: seen,
				events: () => seen.filter((hit) => hit.path === "/events"),
				healthz: () => seen.filter((hit) => hit.path === "/healthz"),
				close: () => void server.stop(true),
			};
			stubs.push(handle);
			return handle;
		}

		beforeEach(() => {
			process.env.SUBSTRATE_EVENT_SPOOL_TTL_H = "1";
		});

		test("an expired head with a revoked credential is still cleaned up, and a valid later entry is delivered", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", GOOD);
			seed("omp", "expired-head", 2 * 3_600_000);
			seed("codex", "valid-later", 120_000);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({ all: true });

			expect(result).toMatchObject({ status: "ran", delivered: 1 });
			expect(spooled()).toEqual([]);
			expect(countSpoolDrops(stateDir)).toEqual({ ttl: 1 });
			// The probe never had to use the dead entry's credential.
			expect(server.hits.every((hit) => hit.auth === `Bearer ${GOOD}`)).toBe(true);
		});

		test("a not-yet-due head with a revoked credential does not block a due entry of another surface", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", GOOD);
			seed("omp", "not-due-head", 0);
			seed("codex", "due-later", 120_000);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			expect(result).toMatchObject({ status: "ran", delivered: 1, remaining: 1 });
			expect(spooled().map((entry) => [entry.event.summary, entry.attempts])).toEqual([["not-due-head", 1]]);
		});

		test("when the probe's first credential is refused, the next distinct surface's credential is tried", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", GOOD);
			seed("omp", "first", 120_000);
			seed("codex", "second", 120_000);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			// First entry's credential is refused at /events too (kept, no attempt); the second is delivered.
			expect(result).toMatchObject({ status: "ran", delivered: 1, skipped: 1 });
			expect(server.healthz().map((hit) => hit.auth)).toEqual([`Bearer ${BAD}`, `Bearer ${GOOD}`]);
			expect(spooled().map((entry) => [entry.event.summary, entry.attempts])).toEqual([["first", 1]]);
		});

		test("a credential refused on /events once skips that surface's remaining entries without more requests", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", GOOD);
			for (const summary of ["o1", "o2", "o3"]) seed("omp", summary, 120_000);
			seed("codex", "c1", 120_000);
			const picked = authServer(true);
			process.env.SUBSTRATE_URL = picked.url;

			const result = await drainEventSpool({});

			expect(result).toMatchObject({ status: "ran", delivered: 1, skipped: 3 });
			// The refused credential is asked once; its other two entries cost no request.
			expect(picked.events()).toHaveLength(2);
			expect(spooled().map((entry) => entry.attempts)).toEqual([1, 1, 1]);
		});

		test("every surface revoked: held, nothing dropped, no attempt consumed", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", BAD);
			seed("omp", "a", 120_000);
			seed("codex", "b", 120_000);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			expect(result).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
			expect(spooled().map((entry) => entry.attempts)).toEqual([1, 1]);
			expect(countSpoolDrops(stateDir)).toEqual({});
		});

		test("a refusal first met on /events for every entry reports the pass held, still untouched", async () => {
			tokenFor("omp", BAD);
			seed("omp", "only", 120_000);
			const server = authServer(true);
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			expect(result).toMatchObject({ status: "ran", delivered: 0, skipped: 1, held: "unauthorized", remaining: 1 });
			expect(spooled()[0]?.attempts).toBe(1);
		});

		test("an authentication failure is never cached: a corrected token works at once, with no reset between", async () => {
			seed("claude-code", "needs-token", 120_000);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;

			const wrong = await drainEventSpool({ token: BAD });
			const right = await drainEventSpool({ token: GOOD });

			expect(wrong).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
			expect(right).toMatchObject({ status: "ran", delivered: 1 });
			expect(server.healthz().map((hit) => hit.auth)).toEqual([`Bearer ${BAD}`, `Bearer ${GOOD}`]);
		});

		test("a rotated token-file value is picked up within the cache window", async () => {
			seed("codex", "rotated", 120_000);
			tokenFor("codex", BAD);
			const server = authServer();
			process.env.SUBSTRATE_URL = server.url;
			expect(await drainEventSpool({})).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });

			tokenFor("codex", GOOD);
			const result = await drainEventSpool({});

			expect(result).toMatchObject({ status: "ran", delivered: 1 });
		});

		test("successful answers are cached per credential: two surfaces with different valid tokens are probed separately", async () => {
			const allowedA = "tok-a";
			const allowedB = "tok-b";
			tokenFor("omp", allowedA);
			tokenFor("codex", allowedB);
			const server = serve({ healthz: ACCEPTING.healthz, events: ACCEPTING.events });
			seed("omp", "x", 120_000);
			process.env.SUBSTRATE_URL = server.url;
			await drainEventSpool({});
			seed("codex", "y", 120_000);
			await drainEventSpool({});

			expect(server.healthz().map((hit) => hit.auth)).toEqual([`Bearer ${allowedA}`, `Bearer ${allowedB}`]);
		});

		/** A server that accepts exactly the bearers in `accepted` (healthz and events), 401 otherwise; the set may change between drains. */
		function gate(accepted: Set<string>, openHealth = false): Stub {
			const seen: Hit[] = [];
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async (req) => {
					const path = new URL(req.url).pathname;
					const auth = req.headers.get("authorization");
					await req.text();
					seen.push({ method: req.method, path, replay: req.headers.get("x-substrate-replay"), auth, body: "" });
					if (path === "/healthz" && openHealth) return Response.json({ idempotency: "accept", greptime: true });
					if (auth === null || !accepted.has(auth.replace("Bearer ", ""))) return Response.json({ error: "unknown or missing bearer token" }, { status: 401 });
					return path === "/healthz" ? Response.json({ idempotency: "accept", greptime: true }) : Response.json({ stored: true }, { status: 202 });
				},
			});
			const handle: Stub = {
				url: `http://127.0.0.1:${server.port}`,
				hits: seen,
				events: () => seen.filter((hit) => hit.path === "/events"),
				healthz: () => seen.filter((hit) => hit.path === "/healthz"),
				close: () => void server.stop(true),
			};
			stubs.push(handle);
			return handle;
		}

		test("the sweep runs before the probe: only expired entries and a refused credential still drop them and report it everywhere", async () => {
			tokenFor("omp", BAD);
			seed("omp", "dead-1", 2 * 3_600_000);
			seed("omp", "dead-2", 3 * 3_600_000);
			const server = gate(new Set([GOOD]));
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({ all: true });

			// Nothing is eligible once the dead entries are swept, so no probe is even needed; the drops are reported.
			expect(result).toMatchObject({ status: "ran", delivered: 0, dropped: 2, remaining: 0 });
			expect(server.hits).toEqual([]);
			expect(spooled()).toEqual([]);
			expect(countSpoolDrops(stateDir)).toEqual({ ttl: 2 });
		});

		test("an expired head is dropped even though the probe is refused for the live entry behind it, and the hold reports the drop", async () => {
			tokenFor("omp", BAD);
			tokenFor("codex", BAD);
			seed("omp", "dead", 2 * 3_600_000);
			seed("codex", "live", 120_000);
			const server = gate(new Set([GOOD]));
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			expect(result).toEqual({ status: "held", reason: "healthz-auth", dropped: 1, remaining: expect.any(Number) });
			expect(spooled().map((entry) => entry.event.summary)).toEqual(["live"]);
			expect(countSpoolDrops(stateDir)).toEqual({ ttl: 1 });
		});

		test("the CLI line and the Grok summary report a cleanup-only hold", async () => {
			tokenFor("omp", BAD);
			seed("omp", "dead", 2 * 3_600_000);
			seed("omp", "live", 120_000);
			const server = gate(new Set([GOOD]));
			process.env.SUBSTRATE_URL = server.url;
			const out: string[] = [];

			await runSpool(["flush"], { out: (text) => out.push(text), err: () => undefined });

			expect(out.join("")).toContain("replay held: healthz-auth");
			expect(out.join("")).toContain("dropped 1 expired or exhausted");
		});

		test("the same bearer refused (revoked) and then accepted on the next drain works with no reset: a 401 is never cached", async () => {
			seed("claude-code", "revoked-then-back", 120_000);
			const accepted = new Set<string>();
			const server = gate(accepted);
			process.env.SUBSTRATE_URL = server.url;

			expect(await drainEventSpool({ token: GOOD })).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
			accepted.add(GOOD);
			const second = await drainEventSpool({ token: GOOD });

			expect(second).toMatchObject({ status: "ran", delivered: 1 });
			expect(server.healthz().map((hit) => hit.auth)).toEqual([`Bearer ${GOOD}`, `Bearer ${GOOD}`]);
		});

		test("at most four distinct credentials are tried for the probe; a fifth surface's is never sent", async () => {
			const surfaces = ["omp", "codex", "opencode", "pi", "hermes"];
			for (const [i, surface] of surfaces.entries()) {
				tokenFor(surface, `tok-s${i}`);
				seed(surface, `s${i}`, 120_000);
			}
			const server = gate(new Set(["tok-s4"]));
			process.env.SUBSTRATE_URL = server.url;

			const result = await drainEventSpool({});

			expect(result).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
			expect(server.healthz().map((hit) => hit.auth)).toEqual(["Bearer tok-s0", "Bearer tok-s1", "Bearer tok-s2", "Bearer tok-s3"]);
		});

		test("two surfaces that share one bearer: one refusal skips both without more requests, and the next drain delivers both", async () => {
			process.env.SUBSTRATE_TOKEN = GOOD;
			seed("omp", "shared-a", 120_000);
			seed("codex", "shared-b", 120_000);
			const accepted = new Set<string>();
			const server = gate(accepted, true);
			process.env.SUBSTRATE_URL = server.url;

			const first = await drainEventSpool({});

			expect(first).toMatchObject({ status: "ran", delivered: 0, skipped: 2, held: "unauthorized", remaining: 2 });
			expect(server.events()).toHaveLength(1);
			accepted.add(GOOD);
			const second = await drainEventSpool({});

			expect(second).toMatchObject({ status: "ran", delivered: 2, remaining: 0 });
			expect(spooled().map((entry) => entry.attempts)).toEqual([]);
		});

		describe("a failed sweep is outstanding only until a later rewrite commits", () => {
			/** The sweep's rewrite fails (its temp file name is taken by a directory) until `unblock()` removes it. */
			function blockRewrite(): { unblock: () => void } {
				const blocker = `${spoolPath()}.${process.pid}.tmp`;
				mkdirSync(blocker);
				return { unblock: () => rmSync(blocker, { recursive: true, force: true }) };
			}

			test("a one-shot sweep failure followed by a successful replay is cleared: writeFailed false, the drop counted once, CLI line clean", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "live", 120_000);
				const block = blockRewrite();
				const server = serve({
					healthz: ACCEPTING.healthz,
					events: () => {
						block.unblock();
						return Response.json({ stored: true }, { status: 202 });
					},
				});
				process.env.SUBSTRATE_URL = server.url;
				const out: string[] = [];

				await runSpool(["flush"], { out: (text) => out.push(text), err: () => undefined });

				expect(out.join("")).toContain("delivered=1");
				expect(out.join("")).toContain("dropped=1");
				expect(out.join("")).toContain("remaining=0");
				expect(out.join("")).not.toContain("write failed");
				expect(spooled()).toEqual([]);
				expect(countSpoolDrops(stateDir)).toEqual({ ttl: 1 });
			});

			test("the same recovery through the drain result: writeFailed false, dropped 1", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "live", 120_000);
				const block = blockRewrite();
				const server = serve({
					healthz: ACCEPTING.healthz,
					events: () => {
						block.unblock();
						return Response.json({ stored: true }, { status: 202 });
					},
				});
				process.env.SUBSTRATE_URL = server.url;

				const result = await drainEventSpool({ all: true });

				expect(result).toMatchObject({ status: "ran", delivered: 1, dropped: 1, remaining: 0, writeFailed: false, readFailed: false });
			});

			test("a sweep failure with no replay that rewrites stays reported (held)", async () => {
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "live", 120_000);
				blockRewrite();
				const server = serve({ healthz: () => Response.json({ idempotency: "off" }), events: ACCEPTING.events });
				process.env.SUBSTRATE_URL = server.url;

				const result = await drainEventSpool({ all: true });

				expect(result).toEqual({ status: "held", reason: "idempotency-off", dropped: 0, failure: "write", remaining: expect.any(Number) });
				expect(spooled().map((entry) => entry.event.summary)).toEqual(["expired", "live"]);
			});

			test("early hold (probe refused) after a failed first sweep and a successful re-sweep reports what is really on disk", async () => {
				// The live entry comes first in the file, so no replay ever reaches the expired one behind it.
				seed("claude-code", "live", 120_000);
				seed("claude-code", "expired", 2 * 3_600_000);
				const block = blockRewrite();
				const server = serve({
					healthz: () => {
						block.unblock();
						return Response.json({ idempotency: "off" });
					},
					events: ACCEPTING.events,
				});
				process.env.SUBSTRATE_URL = server.url;

				// A concurrent writer appends right after the re-sweep commits (the drop line is written just after the
				// commit): the file then holds 2, so a result that re-read the file instead of using the committed depth says 2.
				const patched = process.stderr.write;
				let raced = false;
				process.stderr.write = ((chunk: Uint8Array | string) => {
					if (!raced && String(chunk).includes("dropped spooled event")) {
						raced = true;
						seed("claude-code", "raced-in", 120_000);
					}
					return true;
				}) as typeof process.stderr.write;

				let result: Awaited<ReturnType<typeof drainEventSpool>>;
				try {
					result = await drainEventSpool({ all: true });
				} finally {
					process.stderr.write = patched;
				}

				expect(raced).toBe(true);
				expect(result).toEqual({ status: "held", reason: "idempotency-off", dropped: 1, remaining: 1 });
				expect(spooled().map((entry) => entry.event.summary)).toEqual(["live", "raced-in"]);
				expect(countSpoolDrops(stateDir)).toEqual({ ttl: 1 });
			});

			test("an unreadable spool is held with an UNKNOWN depth: null, never 0, in the result, the CLI text and the CLI JSON", async () => {
				mkdirSync(spoolPath());
				const server = serve(ACCEPTING);
				process.env.SUBSTRATE_URL = server.url;

				const result = await drainEventSpool({ all: true });
				const text: string[] = [];
				const json: string[] = [];
				await runSpool(["flush"], { out: (t) => text.push(t), err: () => undefined });
				await runSpool(["flush", "--json"], { out: (t) => json.push(t), err: () => undefined });

				expect(result).toEqual({ status: "held", reason: "spool-unreadable", dropped: 0, remaining: null, failure: "read" });
				expect(text.join("")).toContain("spool file could not be read, nothing was changed");
				expect(text.join("")).not.toContain("remaining=");
				expect(JSON.parse(json.join(""))).toMatchObject({ status: "held", remaining: null, failure: "read" });
				expect(server.hits).toEqual([]);
			});

			test("an exhausted time budget after a failed first sweep and a successful re-sweep: remaining is the committed depth, nothing is double-counted", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "live", 120_000);
				seed("claude-code", "expired", 2 * 3_600_000);
				const block = blockRewrite();
				const server = serve({
					healthz: () => {
						block.unblock();
						return Response.json({ idempotency: "accept", greptime: true });
					},
					events: ACCEPTING.events,
				});
				process.env.SUBSTRATE_URL = server.url;
				const out: string[] = [];

				// A zero budget stops the replay before its first entry: no delivery, no write-back of its own.
				const result = await drainEventSpool({ all: true, budgetMs: 0 });
				resetSpoolReplayState();
				await runSpool(["status"], { out: (text) => out.push(text), err: () => undefined });

				expect(result).toMatchObject({ status: "ran", delivered: 0, budgetExhausted: true, dropped: 1, remaining: 1, writeFailed: false, readFailed: false });
				expect(out.join("")).toContain("depth: 1");
			});

			/**
			 * Fails the first `failures` rewrites of the process's live spool (the first sweep, the replay write-back), then lets
			 * the re-sweep through. Patches the spool's disk seam, because the drain reaches the spool through `eventSpool()`.
			 */
			function failFirstRewrites(failures: number): void {
				const live = eventSpool() as unknown as { io: { writeFile: (path: string, body: string, options: { mode: number }) => void } };
				const real = live.io.writeFile;
				let calls = 0;
				live.io.writeFile = (path, body, options) => {
					calls += 1;
					if (calls <= failures) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
					real(path, body, options);
				};
			}

			test("(a) expired + a skipped entry: first sweep and write-back fail, the re-sweep commits => failure cleared, drop counted once, CLI clean", async () => {
				tokenFor("omp", BAD);
				seed("omp", "expired", 2 * 3_600_000);
				seed("omp", "skipped", 120_000);
				const server = authServer(true);
				process.env.SUBSTRATE_URL = server.url;
				failFirstRewrites(2);
				const out: string[] = [];

				await runSpool(["flush"], { out: (text) => out.push(text), err: () => undefined });

				expect(out.join("")).toContain("dropped=1");
				expect(out.join("")).toContain("remaining=1");
				expect(out.join("")).toContain("skipped=1");
				expect(out.join("")).not.toContain("write failed");
				expect(spooled().map((entry) => [entry.event.summary, entry.attempts])).toEqual([["skipped", 1]]);
				expect(countSpoolDrops(stateDir)).toEqual({ ttl: 1 });
			});

			test("(a2) the same through the result object", async () => {
				tokenFor("omp", BAD);
				seed("omp", "expired", 2 * 3_600_000);
				seed("omp", "skipped", 120_000);
				const server = authServer(true);
				process.env.SUBSTRATE_URL = server.url;
				failFirstRewrites(2);

				expect(await drainEventSpool({ all: true })).toMatchObject({ status: "ran", dropped: 1, remaining: 1, writeFailed: false, readFailed: false, skipped: 1 });
			});

			test("(b) a delivered entry whose removal could not be saved keeps the failure reported, though the re-sweep committed", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "delivered", 120_000);
				const server = serve(ACCEPTING);
				process.env.SUBSTRATE_URL = server.url;
				failFirstRewrites(2);

				const result = await drainEventSpool({ all: true });

				expect(result).toMatchObject({ status: "ran", delivered: 1, dropped: 1, writeFailed: true, remaining: 1 });
				// The delivered entry is still on disk and will be replayed (and deduplicated) next pass.
				expect(spooled().map((entry) => entry.event.summary)).toEqual(["delivered"]);
			});

			test("(c) a retried entry whose attempt delta could not be saved keeps the failure reported", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "retried", 120_000);
				const server = serve({ healthz: ACCEPTING.healthz, events: () => Response.json({ stored: false }, { status: 503 }) });
				process.env.SUBSTRATE_URL = server.url;
				failFirstRewrites(2);

				const result = await drainEventSpool({ all: true });

				expect(result).toMatchObject({ status: "ran", retried: 1, dropped: 1, writeFailed: true });
				expect(spooled().map((entry) => [entry.event.summary, entry.attempts])).toEqual([["retried", 1]]);
			});

			test("a sweep failure with nothing eligible to replay stays reported, and counts nothing as dropped", async () => {
				seed("claude-code", "expired", 2 * 3_600_000);
				blockRewrite();
				const server = serve(ACCEPTING);
				process.env.SUBSTRATE_URL = server.url;

				const result = await drainEventSpool({ all: true });

				expect(result).toMatchObject({ status: "ran", dropped: 0, writeFailed: true, remaining: 1 });
			});

			test("a sweep failure whose replay write-back also fails is still reported, and a later pass clears it with the drop counted once", async () => {
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "expired", 2 * 3_600_000);
				seed("claude-code", "live", 120_000);
				const block = blockRewrite();
				const server = serve(ACCEPTING);
				process.env.SUBSTRATE_URL = server.url;

				const first = await drainEventSpool({ all: true });
				block.unblock();
				const second = await drainEventSpool({ all: true });

				expect(first).toMatchObject({ status: "ran", delivered: 1, dropped: 0, writeFailed: true });
				expect(second).toMatchObject({ status: "ran", dropped: 1, writeFailed: false });
			});
		});

		describe("the probe cache and the log throttle", () => {
			const realNow = Date.now;
			let skew = 0;
			beforeEach(() => {
				skew = 0;
				Date.now = () => realNow() + skew;
			});
			afterEach(() => {
				Date.now = realNow;
			});

			test("a 200 is cached for 15 s: a second drain inside the TTL asks /healthz nothing, one after it does", async () => {
				const server = gate(new Set([GOOD]));
				process.env.SUBSTRATE_URL = server.url;
				process.env.SUBSTRATE_TOKEN = GOOD;
				seed("claude-code", "one", 120_000);
				await drainEventSpool({});
				seed("claude-code", "two", 120_000);
				skew = 14_000;
				await drainEventSpool({});
				expect(server.healthz()).toHaveLength(1);

				seed("claude-code", "three", 120_000);
				skew = 16_000;
				await drainEventSpool({});

				expect(server.healthz()).toHaveLength(2);
			});

			test("the cache stays within 16 entries however many credentials are probed", async () => {
				const accepted = new Set<string>();
				const server = gate(accepted);
				process.env.SUBSTRATE_URL = server.url;
				for (let i = 0; i < 20; i += 1) {
					accepted.add(`tok-${i}`);
					seed("claude-code", `e${i}`, 120_000);
					await drainEventSpool({ token: `tok-${i}` });
					expect(spoolProbeCacheSize()).toBeLessThanOrEqual(16);
				}
				expect(server.healthz()).toHaveLength(20);
			});

			test("healthz-auth is logged once a minute, not once per drain", async () => {
				const server = gate(new Set());
				process.env.SUBSTRATE_URL = server.url;
				seed("claude-code", "x", 120_000);
				const held = (): number => (stderr?.lines ?? []).filter((line) => line.includes("replay held: healthz-auth")).length;

				await drainEventSpool({ token: BAD });
				await drainEventSpool({ token: BAD });
				skew = 30_000;
				await drainEventSpool({ token: BAD });
				expect(held()).toBe(1);

				skew = 61_000;
				await drainEventSpool({ token: BAD });

				expect(held()).toBe(2);
			});
		});
	});

	test("a 401 or 403 on /healthz holds as healthz-auth, not as a missing capability, and the probe carries the replay's bearer", async () => {
		for (const status of [401, 403]) {
			resetSpoolReplayState();
			const server = serve({ healthz: () => Response.json({ error: "unknown or missing bearer token" }, { status }), events: ACCEPTING.events });
			await park(server, `auth-${status}`);

			expect(await drainEventSpool({ all: true })).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
			expect(server.events()).toEqual([]);
		}
		resetSpoolReplayState();
		const open = serve(ACCEPTING);
		await park(open, "with token");
		await drainEventSpool({ all: true, token: "tok-probe" });
		expect(open.hits.find((hit) => hit.path === "/healthz")?.auth).toBe("Bearer tok-probe");
		expect(open.events()[0]?.auth).toBe("Bearer tok-probe");
	});

	test("a healthy server that says writable replays", async () => {
		const server = serve({
			healthz: () => Response.json({ idempotency: "enforce", greptime: true, eventsWritable: true, ledger: { writable: true } }),
			events: ACCEPTING.events,
		});
		await park(server);

		expect(await drainEventSpool({ all: true })).toMatchObject({ status: "ran", delivered: 1 });
	});

	test("a 403 (this credential is not the event's) keeps the entry untouched and the pass goes on to the next; other 4xx are removed", async () => {
		const down = serve(DOWN);
		for (const summary of ["mine-not", "deliverable", "invalid"]) {
			await postEvent({ ...event, summary }, { collector: "t", source: "t.row", url: down.url });
		}
		const server = serve({
			healthz: ACCEPTING.healthz,
			events: (hit) => {
				const summary = (JSON.parse(hit.body) as { summary: string }).summary;
				if (summary === "mine-not") return Response.json({ error: "attribution" }, { status: 403 });
				if (summary === "invalid") return Response.json({ error: "replay_ts_missing" }, { status: 400 });
				return Response.json({ stored: true }, { status: 202 });
			},
		});
		process.env.SUBSTRATE_URL = server.url;
		const before = spooled()[0];

		const result = await drainEventSpool({ all: true });

		expect(result).toMatchObject({ status: "ran", delivered: 1, refused: 1, skipped: 1, retried: 0, remaining: 1 });
		expect(server.events()).toHaveLength(3);
		expect(spooled()).toEqual([before as NonNullable<typeof before>]);
		expect(spooled()[0]?.event.summary).toBe("mine-not");
		expect(spooled()[0]?.attempts).toBe(1);
		expect(journal().map((line) => line.status)).toEqual([400]);
	});

	test("the health answer is cached briefly: a held server is asked once, not once per pass", async () => {
		const server = serve({ healthz: () => Response.json({ idempotency: "off" }) });
		await park(server);

		await drainEventSpool({ all: true });
		await drainEventSpool({ all: true });

		expect(server.healthz()).toHaveLength(1);
	});

	test("an unreachable health endpoint holds the spool and consumes no attempt", async () => {
		const server = serve(ACCEPTING);
		await park(server);
		server.close();

		const result = await drainEventSpool({ all: true });

		expect(result).toEqual({ status: "held", reason: "healthz-unreachable", dropped: 0, remaining: expect.any(Number) });
		expect(spooled()[0]?.attempts).toBe(1);
	});

	test("an empty spool, or nothing due yet, asks the server nothing", async () => {
		const server = serve(ACCEPTING);
		process.env.SUBSTRATE_URL = server.url;
		expect(await drainEventSpool({})).toMatchObject({ status: "ran", delivered: 0 });
		await park(server);

		// The entry's first retry is ~30 s away: a scheduled pass leaves it alone.
		expect(await drainEventSpool({})).toMatchObject({ status: "ran", delivered: 0, remaining: 1 });

		expect(server.hits).toEqual([]);
	});

	test("connection refused during replay holds the pass without consuming attempts; a 401 does too, and neither is a refusal", async () => {
		const server = serve(ACCEPTING);
		await park(server);
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/healthz")) return Response.json({ idempotency: "accept", greptime: true });
			void init;
			throw new TypeError("connect ECONNREFUSED");
		}) as unknown as typeof fetch;

		const refused = await drainEventSpool({ all: true });

		expect(refused).toMatchObject({ status: "ran", delivered: 0, held: "unreachable", remaining: 1 });
		expect(spooled()[0]?.attempts).toBe(1);

		resetSpoolReplayState();
		globalThis.fetch = realFetch;
		const unauthorized = serve({ healthz: ACCEPTING.healthz, events: () => Response.json({ error: "missing bearer" }, { status: 401 }) });
		process.env.SUBSTRATE_URL = unauthorized.url;
		const second = await drainEventSpool({ all: true });

		expect(second).toMatchObject({ status: "ran", delivered: 0, held: "unauthorized", remaining: 1 });
		expect(spooled()[0]?.attempts).toBe(1);
		expect(journal()).toEqual([]);
	});

	test("a replay the server refuses with a 4xx is removed and logged; a 5xx stays, one attempt more, with a later schedule", async () => {
		const server = serve({ healthz: ACCEPTING.healthz, events: () => Response.json({ error: "invalid kind" }, { status: 400 }) });
		await park(server);

		const refused = await drainEventSpool({ all: true });

		expect(refused).toMatchObject({ status: "ran", refused: 1, remaining: 0 });
		expect(journal().map((line) => [line.status, line.error])).toEqual([[400, "invalid kind"]]);

		const flaky = serve({ healthz: ACCEPTING.healthz, events: () => Response.json({ stored: false }, { status: 503 }) });
		await park(flaky, "again");
		const before = Date.now();
		const retried = await drainEventSpool({ all: true });

		expect(retried).toMatchObject({ status: "ran", retried: 1, remaining: 1 });
		expect(spooled()[0]?.attempts).toBe(2);
		expect(spooled()[0]?.next_at).toBeGreaterThan(before + 40_000);
	});

	test("the bearer is re-resolved at replay time, not read back from the file", async () => {
		process.env.SUBSTRATE_TOKEN = "tok-old";
		const down = serve(DOWN);
		await postEvent(event, { collector: "t", url: down.url });
		process.env.SUBSTRATE_TOKEN = "tok-new";
		const server = serve(ACCEPTING);
		process.env.SUBSTRATE_URL = server.url;

		await drainEventSpool({ all: true });

		expect(server.events()[0]?.auth).toBe("Bearer tok-new");
	});

	test("a hook's parkEvent only appends: one write, no request of any kind", () => {
		globalThis.fetch = (() => {
			throw new Error("a hook must not touch the network after a failed attempt");
		}) as unknown as typeof fetch;
		const prepared = prepareEvent(event, { collector: "hook" });

		expect(parkEvent(prepared, { collector: "hook", source: "hook.row", reason: "unreachable" })).toBe(true);

		expect(spooled().map((entry) => entry.key)).toEqual([prepared.key]);
	});

	test("overlapping drains in one process share a single pass", async () => {
		const server = serve(ACCEPTING);
		await park(server);

		const [first, second] = await Promise.all([drainEventSpool({ all: true }), drainEventSpool({ all: true })]);

		expect(second).toBe(first);
		expect(server.events()).toHaveLength(1);
	});
});

describe("refused-emits.jsonl is bounded", () => {
	test("a malformed, too-small or too-large cap uses the default or the bound and warns once; blank and unset are silent", () => {
		const warnings = (): string => (stderr?.lines ?? []).filter((line) => line.includes("SUBSTRATE_REFUSED_EMITS_MAX_BYTES")).join("");
		const note = (): void => recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: "x" });

		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "   ";
		note();
		expect(warnings()).toBe("");

		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "lots";
		note();
		note();
		expect(warnings().match(/must be a positive integer; using 1048576/g)).toHaveLength(1);

		// Zero and a negative number are not positive integers: the default, not the minimum.
		for (const bad of ["0", "-5"]) {
			resetSpoolReplayState();
			process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = bad;
			for (let i = 0; i < 30; i += 1) recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: "x".repeat(60) });
			expect(warnings()).toContain("must be a positive integer; using 1048576");
			expect(existsSync(join(stateDir, "refused-emits.jsonl.1"))).toBe(false);
		}

		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "10";
		note();
		expect(warnings()).toContain("below the minimum 4096; using 4096");

		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "999999999999";
		note();
		expect(warnings()).toContain("above the ceiling 67108864; using 67108864");
	});

	test("at the cap the file rotates to one .1 and the newest line is in the live file", () => {
		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "4096";
		for (let i = 0; i < 80; i += 1) {
			recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: `refusal number ${i} ${"x".repeat(60)}` });
		}

		const live = join(stateDir, "refused-emits.jsonl");
		expect(existsSync(`${live}.1`)).toBe(true);
		expect(readdirSync(stateDir).sort()).toEqual(["refused-emits.jsonl", "refused-emits.jsonl.1"]);
		expect(statSync(live).size).toBeLessThan(4096 + 400);
		expect(statSync(`${live}.1`).size).toBeLessThan(4096 + 400);
		expect(readFileSync(live, "utf8")).toContain("refusal number 79");
		expect(readFileSync(live, "utf8")).not.toContain("refusal number 0 ");
	});

	test("below the cap nothing rotates, and a cap below the floor is raised to it", () => {
		for (let i = 0; i < 5; i += 1) recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: "x" });
		expect(readdirSync(stateDir)).toEqual(["refused-emits.jsonl"]);

		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "10";
		for (let i = 0; i < 5; i += 1) recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: "x" });
		expect(readdirSync(stateDir)).toEqual(["refused-emits.jsonl"]);
	});

	test("the status reporter counts the rotated file too", () => {
		process.env.SUBSTRATE_REFUSED_EMITS_MAX_BYTES = "4096";
		for (let i = 0; i < 80; i += 1) {
			recordRefusal({ event, collector: "t", source: "t.row", status: 400, error: `refusal ${i} ${"x".repeat(60)}` });
		}

		const first = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "status.ts"), "--json", "--state-dir", stateDir]);
		const summary = JSON.parse(first.stdout.toString()) as { refused: unknown[] };

		expect(summary.refused.length).toBeGreaterThan(10);
		const lineCount = (path: string): number => readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).length;
		expect(summary.refused).toHaveLength(lineCount(join(stateDir, "refused-emits.jsonl")) + lineCount(join(stateDir, "refused-emits.jsonl.1")));
	});
});
