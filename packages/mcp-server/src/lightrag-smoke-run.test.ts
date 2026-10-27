/**
 * The LightRAG live smoke runner against an in-memory fake server over the
 * injected fetch (the `lightrag.test.ts` seam). No network, no real waits:
 * the clock and the sleep are one counter the fake `sleep` advances.
 */
import { describe, expect, test } from "bun:test";
import type { LightragConfig } from "./config.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import {
	checkClearAllGuard,
	defaultMarker,
	formatSmoke,
	main,
	parseSmokeArgs,
	runSmoke,
	SmokeUsageError,
	type SmokeDeps,
	type SmokeResult,
} from "./lightrag-smoke-run.ts";

const KEY = "lr-test-secret-key-0123456789";
const URL_BASE = "http://lightrag.test";
const KEYED: LightragConfig = { url: URL_BASE, apiKey: KEY };
const MARKER = "lrsmoke00000001";

interface Call {
	method: string;
	path: string;
	key: string | null;
	body: unknown;
}

interface FakeOptions {
	/** The key the server demands; null is an open server that answers anonymous calls. */
	apiKey: string | null;
	version?: string;
	healthStatus?: string;
	/** Pipeline reads that answer busy after an upload or a delete. Default 1. */
	busyReads?: number;
	neverIdle?: boolean;
	/** The pipeline reports `recovery_required` and mutations answer 503. */
	recovery?: boolean;
	omitMarkerInQuery?: boolean;
	trackNeverListed?: boolean;
	docStatus?: string;
	ignoreDelete?: boolean;
	busyDeleteOnce?: boolean;
	unreachable?: boolean;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface FakeServer {
	fetch: FetchLike;
	calls: Call[];
	docs: Map<string, { id: string; track: string; text: string }>;
	clearAll: () => number;
}

interface JsonReport {
	schema: number;
	version: string | null;
	checks: Array<Record<string, unknown>>;
	ok: boolean;
}

/** One member of a parsed JSON body, narrowed with `in`; undefined when the body has no such member. */
function bodyField(body: unknown, name: string): unknown {
	return body !== null && typeof body === "object" && name in body ? (body as Record<string, unknown>)[name] : undefined;
}

/** A stateful LightRAG stand-in: documents, a pipeline that goes busy then idle, auth, query and delete. */
function fakeServer(options: FakeOptions): FakeServer {
	const calls: Call[] = [];
	const docs = new Map<string, { id: string; track: string; text: string }>();
	docs.set("pre-existing", { id: "pre-existing", track: "trk-old", text: "an unrelated document that must survive" });
	let busyReads = 0;
	let seq = 0;
	let clearAll = 0;
	let busyDeleteLeft = options.busyDeleteOnce === true ? 1 : 0;
	const fetchImpl: FetchLike = async (input, init) => {
		const url = String(input);
		if (options.unreachable === true) throw new Error(`connect ECONNREFUSED ${url}`);
		const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const rawBody = init?.body;
		let body: unknown;
		let fileText = "";
		if (typeof rawBody === "string") body = JSON.parse(rawBody);
		else if (rawBody instanceof FormData) {
			const file = rawBody.get("file");
			fileText = file instanceof Blob ? await file.text() : "";
		}
		calls.push({ method, path, key: headers.get("x-api-key"), body });
		if (method === "DELETE" && path === "/documents") {
			clearAll += 1;
			docs.clear();
			return json({ status: "success" });
		}
		if (path !== "/health" && options.apiKey !== null && headers.get("x-api-key") !== options.apiKey) {
			return json({ detail: "Not authenticated" }, 401);
		}
		if (method === "GET" && path === "/health") {
			return json({ status: options.healthStatus ?? "healthy", core_version: options.version ?? "1.5.7", pipeline_busy: false });
		}
		if (method === "POST" && path === "/documents/upload") {
			seq += 1;
			docs.set(`doc-${seq}`, { id: `doc-${seq}`, track: `trk-${seq}`, text: fileText });
			busyReads = options.busyReads ?? 1;
			return json({ status: "success", message: "queued", track_id: `trk-${seq}` });
		}
		if (method === "GET" && path === "/documents/pipeline_status") {
			if (options.recovery === true) return json({ busy: false, recovery_required: true, recovery_message: "workspace fenced" });
			if (options.neverIdle === true) return json({ busy: true });
			if (busyReads > 0) {
				busyReads -= 1;
				return json({ busy: true });
			}
			return json({ busy: false });
		}
		if (method === "GET" && path.startsWith("/documents/track_status/")) {
			const track = decodeURIComponent(path.slice("/documents/track_status/".length));
			const listed = options.trackNeverListed === true ? [] : [...docs.values()].filter((doc) => doc.track === track);
			return json({
				track_id: track,
				documents: listed.map((doc) => ({ id: doc.id, status: options.docStatus ?? "processed", file_path: "x.md", ...(options.docStatus === "failed" ? { error_msg: "llm refused" } : {}) })),
				total_count: listed.length,
			});
		}
		if (method === "POST" && path === "/query") {
			const question = String(bodyField(body, "query") ?? "");
			const marker = /lrsmoke[a-z0-9]+/.exec(question)?.[0] ?? "";
			if (options.omitMarkerInQuery === true) return json({ status: "success", data: { chunks: [{ content: "something else entirely" }] } });
			const hits = [...docs.values()].filter((doc) => marker !== "" && doc.text.includes(marker));
			return json({ status: "success", data: { chunks: hits.map((doc) => ({ content: doc.text, file_path: doc.id })) } });
		}
		if (method === "DELETE" && path === "/documents/delete_document") {
			if (options.recovery === true) return json({ detail: "recovery required" }, 503);
			if (busyDeleteLeft > 0) {
				busyDeleteLeft -= 1;
				return json({ status: "busy", message: "pipeline busy" });
			}
			const requested = bodyField(body, "doc_ids");
			const ids = Array.isArray(requested) ? requested.map(String) : [];
			if (options.ignoreDelete !== true) for (const id of ids) docs.delete(id);
			busyReads = options.busyReads ?? 1;
			return json({ status: "deletion_started", message: "ok" });
		}
		return json({ detail: "Not Found" }, 404);
	};
	return { fetch: fetchImpl, calls, docs, clearAll: () => clearAll };
}

function harness(options: FakeOptions, overrides: Partial<SmokeDeps> = {}) {
	const fake = fakeServer(options);
	const clock = { t: 1_000_000 };
	const sleeps: number[] = [];
	const deps: SmokeDeps = {
		config: KEYED,
		fetchImpl: fake.fetch,
		now: () => clock.t,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.t += ms;
		},
		newMarker: () => MARKER,
		pollIntervalMs: 1000,
		totalDeadlineMs: 20_000,
		cleanupBudgetMs: 10_000,
		...overrides,
	};
	return { fake, clock, sleeps, deps, start: clock.t };
}

const statusOf = (result: SmokeResult, name: string) => result.report.checks.find((check) => check.name === name);
const deleteCalls = (fake: FakeServer) => fake.calls.filter((call) => call.method === "DELETE" && call.path === "/documents/delete_document");

describe("parseSmokeArgs", () => {
	test("refuses without --confirm-live and names the reason", () => {
		expect(() => parseSmokeArgs([])).toThrow(SmokeUsageError);
		expect(() => parseSmokeArgs(["--json"])).toThrow("--confirm-live is required");
	});

	test("accepts exactly the three flags, once each", () => {
		expect(parseSmokeArgs(["--confirm-live"])).toEqual({ json: false, noAuthExpected: false });
		expect(parseSmokeArgs(["--confirm-live", "--json", "--no-auth-expected"])).toEqual({ json: true, noAuthExpected: true });
		expect(() => parseSmokeArgs(["--confirm-live", "--json", "--json"])).toThrow("given twice");
		expect(() => parseSmokeArgs(["--confirm-live", "--json=1"])).toThrow("unknown argument");
		expect(() => parseSmokeArgs(["--confirm-live", "positional"])).toThrow("unknown argument");
	});

	test("never echoes an unknown argument", () => {
		expect(() => parseSmokeArgs(["--confirm-live", KEY])).toThrow("unknown argument at position 2");
		try {
			parseSmokeArgs(["--confirm-live", KEY]);
		} catch (cause) {
			expect(String((cause as Error).message)).not.toContain(KEY);
		}
	});
});

describe("defaultMarker", () => {
	test("is unique per call and URL-safe", () => {
		const first = defaultMarker();
		expect(first).toMatch(/^lrsmoke[0-9a-f]{16}$/);
		expect(defaultMarker()).not.toBe(first);
	});
});

describe("runSmoke: a healthy, guarded server", () => {
	test("all six checks pass in order and only the created document is deleted", async () => {
		const { fake, deps } = harness({ apiKey: KEY });
		const result = await runSmoke(deps);
		expect(result.report.checks.map((check) => [check.name, check.status])).toEqual([
			["health", "pass"],
			["auth-negative", "pass"],
			["ingest", "pass"],
			["query", "pass"],
			["delete", "pass"],
			["clear-all-guard", "pass"],
		]);
		expect(result.exitCode).toBe(0);
		expect(result.report.ok).toBe(true);
		expect(result.report.version).toBe("1.5.7");
		// Only the document this run created went; the pre-existing one and clear-all are untouched.
		const deletes = deleteCalls(fake);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.body).toEqual({ doc_ids: ["doc-1"], delete_file: false, delete_llm_cache: false });
		expect(fake.docs.has("doc-1")).toBe(false);
		expect(fake.docs.has("pre-existing")).toBe(true);
		expect(fake.clearAll()).toBe(0);
		expect(fake.calls.some((call) => call.path === "/documents" && call.method === "DELETE")).toBe(false);
	});

	test("the only keyless request is the anonymous one, and the query uses the client's default mode and only_need_context", async () => {
		const { fake, deps } = harness({ apiKey: KEY });
		await runSmoke(deps);
		const keyless = fake.calls.filter((call) => call.key === null);
		expect(keyless.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /documents/pipeline_status"]);
		expect(fake.calls.filter((call) => call.key !== null).every((call) => call.key === KEY)).toBe(true);
		const query = fake.calls.find((call) => call.path === "/query");
		expect(query?.body).toEqual({ query: `Which document mentions ${MARKER}?`, mode: "hybrid", top_k: 10, only_need_context: true });
	});

	test("records a duration for every check and no real time passes", async () => {
		const { deps } = harness({ apiKey: KEY });
		const result = await runSmoke(deps);
		for (const check of result.report.checks) {
			expect(Number.isInteger(check.durationMs)).toBe(true);
			expect(check.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	test("neither the summary nor the JSON carries the key, the URL or the document text", async () => {
		const { deps } = harness({ apiKey: KEY });
		const result = await runSmoke(deps);
		for (const text of [formatSmoke(result), JSON.stringify(result.report)]) {
			expect(text).not.toContain(KEY);
			expect(text).not.toContain("lightrag.test");
			expect(text).not.toContain("Synthetic text");
		}
		expect(formatSmoke(result)).toContain(MARKER);
	});
});

describe("runSmoke: auth-negative", () => {
	test("a server that answers anonymous calls fails as unauthenticated-access-allowed, and still cleans up", async () => {
		const { fake, deps } = harness({ apiKey: null });
		const result = await runSmoke(deps);
		const auth = statusOf(result, "auth-negative");
		expect(auth?.status).toBe("fail");
		expect(auth?.reason.startsWith("unauthenticated-access-allowed")).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.report.ok).toBe(false);
		expect(statusOf(result, "delete")?.status).toBe("pass");
		expect(fake.docs.has("doc-1")).toBe(false);
	});

	test("--no-auth-expected skips the check loudly, makes no anonymous call, and warns in the summary", async () => {
		const { fake, deps } = harness({ apiKey: null }, { noAuthExpected: true });
		const result = await runSmoke(deps);
		const auth = statusOf(result, "auth-negative");
		expect(auth?.status).toBe("skip");
		expect(auth?.reason).toContain("NO-AUTH-EXPECTED");
		expect(fake.calls.every((call) => call.key === KEY)).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(formatSmoke(result)).toContain("WARNING");
		expect(formatSmoke(result)).toContain("NOT checked");
	});

	test("a keyless config against a keyed server fails the anonymous check as inconclusive only for non-401/403 answers", async () => {
		// The server answers 404 to the anonymous probe: that is neither a refusal nor an acceptance.
		const fake = fakeServer({ apiKey: KEY });
		const wrapped: FetchLike = async (input, init) => {
			if (!new Headers(init?.headers).has("x-api-key") && String(input).endsWith("/documents/pipeline_status")) return json({ detail: "gone" }, 404);
			return fake.fetch(input, init);
		};
		const { deps } = harness({ apiKey: KEY }, { fetchImpl: wrapped });
		const result = await runSmoke(deps);
		expect(statusOf(result, "auth-negative")?.status).toBe("fail");
		expect(statusOf(result, "auth-negative")?.reason.startsWith("auth-negative inconclusive")).toBe(true);
	});
});

describe("runSmoke: ingest", () => {
	test("a pipeline that never goes idle fails within the deadline and the created document is still deleted", async () => {
		const { fake, deps, clock, start } = harness({ apiKey: KEY, neverIdle: true });
		const result = await runSmoke(deps);
		const ingest = statusOf(result, "ingest");
		expect(ingest?.status).toBe("fail");
		expect(ingest?.reason).toBe("pipeline did not go idle before the deadline");
		expect(ingest?.durationMs).toBeLessThanOrEqual(20_000);
		expect(statusOf(result, "query")?.status).toBe("skip");
		// Cleanup ran after the failure and deleted only the created id.
		const deletes = deleteCalls(fake);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.body).toEqual({ doc_ids: ["doc-1"], delete_file: false, delete_llm_cache: false });
		expect(statusOf(result, "delete")?.status).toBe("fail");
		expect(result.exitCode).toBe(1);
		// Bounded: total deadline plus the cleanup budget, plus one poll interval of slack.
		expect(clock.t - start).toBeLessThanOrEqual(20_000 + 10_000 + 1000);
		expect(fake.docs.has("pre-existing")).toBe(true);
	});

	test("recovery_required is a failure that names it, and cleanup is attempted once", async () => {
		const { fake, deps } = harness({ apiKey: KEY, recovery: true });
		const result = await runSmoke(deps);
		const ingest = statusOf(result, "ingest");
		expect(ingest?.status).toBe("fail");
		expect(ingest?.reason).toContain("recovery_required");
		expect(ingest?.reason).toContain("workspace fenced");
		expect(deleteCalls(fake)).toHaveLength(1);
		expect(statusOf(result, "delete")?.status).toBe("fail");
		expect(result.exitCode).toBe(1);
	});

	test("a document that ends failed is a failure carrying its error, not a pass", async () => {
		const { deps } = harness({ apiKey: KEY, docStatus: "failed" });
		const result = await runSmoke(deps);
		const ingest = statusOf(result, "ingest");
		expect(ingest?.status).toBe("fail");
		expect(ingest?.reason).toContain("failed");
		expect(ingest?.reason).toContain("llm refused");
		expect(statusOf(result, "delete")?.status).toBe("pass");
	});

	test("an upload whose document id never appears fails, deletes nothing and says how to clean up by hand", async () => {
		const { fake, deps, clock, start } = harness({ apiKey: KEY, trackNeverListed: true });
		const result = await runSmoke(deps);
		expect(statusOf(result, "ingest")?.status).toBe("fail");
		expect(statusOf(result, "ingest")?.reason).toContain("document id not resolved");
		const cleanup = statusOf(result, "delete");
		expect(cleanup?.status).toBe("fail");
		expect(cleanup?.reason).toContain(MARKER);
		expect(deleteCalls(fake)).toHaveLength(0);
		expect(clock.t - start).toBeLessThanOrEqual(20_000 + 10_000 + 1000);
	});

	test("an upload the server refuses fails the ingest and skips the delete: nothing was created", async () => {
		const failing: FetchLike = async (input, init) => {
			if (String(input).endsWith("/documents/upload")) return json({ detail: "boom" }, 500);
			return fakeServer({ apiKey: KEY }).fetch(input, init);
		};
		const { deps } = harness({ apiKey: KEY }, { fetchImpl: failing });
		const result = await runSmoke(deps);
		expect(statusOf(result, "ingest")?.reason).toBe("upload failed: lightrag 500");
		expect(statusOf(result, "delete")?.status).toBe("skip");
		expect(statusOf(result, "delete")?.reason).toBe("nothing was uploaded");
	});

	test("a marker generator returning an unusable marker fails before any upload", async () => {
		const { fake, deps } = harness({ apiKey: KEY }, { newMarker: () => "BAD marker!" });
		const result = await runSmoke(deps);
		expect(statusOf(result, "ingest")?.reason).toBe("the marker generator returned an invalid marker");
		expect(fake.calls.some((call) => call.path === "/documents/upload")).toBe(false);
		expect(statusOf(result, "delete")?.status).toBe("skip");
	});
});

describe("runSmoke: query", () => {
	test("a query whose chunks lack the marker fails, and the document is still deleted", async () => {
		const { fake, deps } = harness({ apiKey: KEY, omitMarkerInQuery: true });
		const result = await runSmoke(deps);
		const query = statusOf(result, "query");
		expect(query?.status).toBe("fail");
		expect(query?.reason).toBe("query returned 1 chunk(s), none containing the marker");
		expect(statusOf(result, "delete")?.status).toBe("pass");
		expect(fake.docs.has("doc-1")).toBe(false);
		expect(result.exitCode).toBe(1);
	});
});

describe("runSmoke: delete", () => {
	test("a busy answer is retried within the cleanup budget and the delete body stays the created id", async () => {
		const { fake, deps, sleeps } = harness({ apiKey: KEY, busyDeleteOnce: true });
		const result = await runSmoke(deps);
		expect(statusOf(result, "delete")?.status).toBe("pass");
		const deletes = deleteCalls(fake);
		expect(deletes).toHaveLength(2);
		expect(deletes.every((call) => JSON.stringify(call.body) === JSON.stringify({ doc_ids: ["doc-1"], delete_file: false, delete_llm_cache: false }))).toBe(true);
		expect(sleeps.length).toBeGreaterThan(0);
	});

	test("a document that is still listed after the delete fails within the cleanup budget", async () => {
		const { deps, clock, start } = harness({ apiKey: KEY, ignoreDelete: true });
		const result = await runSmoke(deps);
		const cleanup = statusOf(result, "delete");
		expect(cleanup?.status).toBe("fail");
		expect(cleanup?.reason).toBe("the created document is still listed after the delete");
		expect(clock.t - start).toBeLessThanOrEqual(20_000 + 10_000 + 1000);
	});
});

describe("runSmoke: clear-all guard", () => {
	test("the guard passes against the real client and never touches the server", async () => {
		const { fake, deps } = harness({ apiKey: KEY });
		const result = await runSmoke(deps);
		expect(statusOf(result, "clear-all-guard")?.status).toBe("pass");
		expect(fake.clearAll()).toBe(0);
	});

	test("checkClearAllGuard passes on the real choke point with zero network calls", async () => {
		expect((await checkClearAllGuard(URL_BASE)).status).toBe("pass");
	});

	test("a choke point that lets clear-all through is a regression failure", async () => {
		const open = await checkClearAllGuard(URL_BASE, async () => ({ ok: true, body: {} }));
		expect(open.status).toBe("fail");
		expect(open.reason).toContain("clear-all guard regression");
		const other = await checkClearAllGuard(URL_BASE, async () => ({ ok: false, reason: "lightrag 500" }));
		expect(other.status).toBe("fail");
	});

	test("a refusal that still reaches the network is a regression failure", async () => {
		const leaky = await checkClearAllGuard(URL_BASE, async (_config, fetchImpl) => {
			await fetchImpl(`${URL_BASE}/documents`, { method: "DELETE" }).catch(() => undefined);
			return { ok: false, reason: "lightrag clear-all refused" };
		});
		expect(leaky.status).toBe("fail");
		expect(leaky.reason).toContain("reached the network");
	});
});

describe("runSmoke: health", () => {
	test("an unreachable server is exit 3, skips the network checks, still runs the local guard, and never names the URL", async () => {
		const { deps } = harness({ apiKey: KEY, unreachable: true });
		const result = await runSmoke(deps);
		expect(result.exitCode).toBe(3);
		expect(result.report.ok).toBe(false);
		expect(result.report.checks.map((check) => [check.name, check.status])).toEqual([
			["health", "fail"],
			["auth-negative", "skip"],
			["ingest", "skip"],
			["query", "skip"],
			["delete", "skip"],
			["clear-all-guard", "pass"],
		]);
		for (const text of [formatSmoke(result), JSON.stringify(result.report)]) {
			expect(text).not.toContain("lightrag.test");
			expect(text).not.toContain(KEY);
		}
	});

	test("an unhealthy status fails the health check (exit 1) and the rest still run", async () => {
		const { deps } = harness({ apiKey: KEY, healthStatus: "degraded" });
		const result = await runSmoke(deps);
		expect(statusOf(result, "health")?.status).toBe("fail");
		expect(statusOf(result, "health")?.reason).toBe("lightrag health: degraded");
		expect(statusOf(result, "ingest")?.status).toBe("pass");
		expect(result.exitCode).toBe(1);
	});

	test("a server that reports no version still passes, with the version null", async () => {
		const fake = fakeServer({ apiKey: KEY });
		const noVersion: FetchLike = async (input, init) =>
			String(input).endsWith("/health") ? json({ status: "healthy" }) : fake.fetch(input, init);
		const { deps } = harness({ apiKey: KEY }, { fetchImpl: noVersion });
		const result = await runSmoke(deps);
		expect(result.report.version).toBeNull();
		expect(statusOf(result, "health")?.reason).toBe("healthy, core version not reported");
	});

	test("a version carrying the URL, the host or the key never reaches the JSON or the human output", async () => {
		for (const version of [`1.5.7 ${URL_BASE}`, "1.5.7-lightrag.test", KEY, `v${KEY}`, "x".repeat(41), "1.5.7\nnext line"]) {
			const fake = fakeServer({ apiKey: KEY });
			const hostile: FetchLike = async (input, init) =>
				String(input).endsWith("/health") ? json({ status: "healthy", core_version: version }) : fake.fetch(input, init);
			const { deps } = harness({ apiKey: KEY }, { fetchImpl: hostile });
			const result = await runSmoke(deps);
			expect(result.report.version).toBeNull();
			expect(statusOf(result, "health")?.reason).toBe("healthy, core version not reported");
			for (const text of [JSON.stringify(result.report), formatSmoke(result)]) {
				expect(text).not.toContain(KEY);
				expect(text).not.toContain("lightrag.test");
				expect(text).not.toContain("xxxxxxxx");
			}
		}
	});

	test("a plain version string is kept", async () => {
		const { deps } = harness({ apiKey: KEY, version: "1.5.7+build.3-rc1" });
		const result = await runSmoke(deps);
		expect(result.report.version).toBe("1.5.7+build.3-rc1");
		expect(formatSmoke(result)).toContain("(core 1.5.7+build.3-rc1)");
	});
});

describe("main", () => {
	const ENV = { LIGHTRAG_URL: URL_BASE, LIGHTRAG_API_KEY: KEY };

	function io(fetchImpl: FetchLike, env: Record<string, string | undefined> = ENV) {
		const out: string[] = [];
		const err: string[] = [];
		const clock = { t: 5_000 };
		return {
			out,
			err,
			io: {
				env,
				fetchImpl,
				now: () => clock.t,
				sleep: async (ms: number) => {
					clock.t += ms;
				},
				newMarker: () => MARKER,
				write: (text: string) => void out.push(text),
				writeErr: (text: string) => void err.push(text),
			},
		};
	}

	const never: FetchLike = async () => {
		throw new Error("a refusal must not reach the network");
	};

	test("refuses without --confirm-live: exit 2, usage on stderr, no network", async () => {
		const run = io(never);
		expect(await main([], run.io)).toBe(2);
		expect(run.out).toEqual([]);
		expect(run.err.join("")).toContain("--confirm-live is required");
		expect(run.err.join("")).toContain("usage:");
	});

	test("an unknown or repeated flag is exit 2 and the unknown value is not echoed", async () => {
		const run = io(never);
		expect(await main(["--confirm-live", "--bogus-flag"], run.io)).toBe(2);
		expect(run.err.join("")).not.toContain("--bogus-flag");
		expect(await main(["--confirm-live", "--json", "--json"], run.io)).toBe(2);
	});

	test("an unset LIGHTRAG_URL is exit 2 with no network", async () => {
		const run = io(never, {});
		expect(await main(["--confirm-live"], run.io)).toBe(2);
		expect(run.err.join("")).toContain("LIGHTRAG_URL is not set");
	});

	test("an unusable LIGHTRAG_URL is exit 2 and the value is not echoed", async () => {
		for (const url of ["not a url", "ftp://lightrag.test"]) {
			const run = io(never, { LIGHTRAG_URL: url, LIGHTRAG_API_KEY: KEY });
			expect(await main(["--confirm-live"], run.io)).toBe(2);
			expect(run.err.join("")).not.toContain(KEY);
			expect(run.err.join("")).not.toContain(url);
		}
	});

	test("--json prints one object with a stable schema and exits 0 on a good server", async () => {
		const fake = fakeServer({ apiKey: KEY });
		const run = io(fake.fetch);
		expect(await main(["--confirm-live", "--json"], run.io)).toBe(0);
		expect(run.out).toHaveLength(1);
		const text = run.out[0] ?? "";
		const parsed: JsonReport = JSON.parse(text);
		expect(Object.keys(parsed)).toEqual(["schema", "version", "checks", "ok"]);
		expect(parsed.schema).toBe(1);
		expect(parsed.version).toBe("1.5.7");
		expect(parsed.ok).toBe(true);
		expect(parsed.checks.map((check) => check.name)).toEqual(["health", "auth-negative", "ingest", "query", "delete", "clear-all-guard"]);
		for (const check of parsed.checks) {
			expect(Object.keys(check)).toEqual(["name", "status", "reason", "durationMs"]);
			expect(typeof check.durationMs).toBe("number");
		}
		expect(text).not.toContain(KEY);
		expect(text).not.toContain("lightrag.test");
	});

	test("the human summary is the default, exits 1 on a failed check, and prints no secret", async () => {
		const fake = fakeServer({ apiKey: null });
		const run = io(fake.fetch);
		expect(await main(["--confirm-live"], run.io)).toBe(1);
		const text = run.out.join("");
		expect(text).toContain("[lightrag-smoke] FAILED");
		expect(text).toContain("[fail] auth-negative");
		expect(text).not.toContain(KEY);
		expect(text).not.toContain("lightrag.test");
	});

	test("an unreachable server is exit 3", async () => {
		const fake = fakeServer({ apiKey: KEY, unreachable: true });
		const run = io(fake.fetch);
		expect(await main(["--confirm-live", "--json"], run.io)).toBe(3);
	});
});
