/**
 * The LightRAG client against the v1.5.7 route contract in
 * `__fixtures__/lightrag-v1.5.7-routes.json`.
 *
 * The fixture is DERIVED FROM THE UPSTREAM SOURCE, not recorded from a live
 * server (see its `provenance`); the operator must diff it against the live
 * `/openapi.json` before cutover. What this test pins is the other half: the
 * client emits only routes the fixture lists, with every required request
 * member, never the clear-all denylist, and parses each hand-written sample
 * response to what the fixture says it should.
 *
 * `checkContract` and `checkSamples` return violations instead of asserting,
 * so the fail-before proofs can run them on a mutated copy of the fixture and
 * expect rejection: a checker that cannot fail proves nothing.
 */
import { describe, expect, test } from "bun:test";
import type { LightragConfig } from "../config.ts";
import {
	deleteDocuments,
	isClearAllRequest,
	lightragCall,
	parseDocuments,
	pollParseStatus,
	probeLightrag,
	resolveDocumentIds,
	retrieveChunks,
	scanDocuments,
	storePlanningPage,
	uploadDocument,
	type FetchLike,
	type LightragUploadRequest,
} from "./lightrag.ts";

interface FixtureRoute {
	id: string;
	method: string;
	path: string;
	source: string;
	request: { kind: "json" | "multipart" | "none"; required: string[]; optional: string[]; ignoredByServer: string[] };
	responseFieldsRead: string[];
	responseFieldsOptional?: string[];
	sampleResponse: unknown;
	clientExpects: unknown;
}

interface Fixture {
	provenance: string;
	auth: { header: string; neverSent: string[] };
	denylist: Array<{ method: string; path: string; reason: string; source: string }>;
	routes: FixtureRoute[];
}

const CONFIG: LightragConfig = { url: "http://lightrag.test", apiKey: "lr-contract-key" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`fixture: ${what} must be a string list`);
	return value;
}

/** Parse the fixture at the edge: a malformed fixture fails loudly here, not as a confusing mismatch later. */
function parseFixture(raw: unknown): Fixture {
	if (!isRecord(raw) || typeof raw.provenance !== "string" || !isRecord(raw.auth) || !Array.isArray(raw.denylist) || !Array.isArray(raw.routes)) {
		throw new Error("fixture: provenance, auth, denylist and routes are required");
	}
	const routes = raw.routes.map((entry: unknown): FixtureRoute => {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.method !== "string" || typeof entry.path !== "string" || typeof entry.source !== "string") {
			throw new Error("fixture: every route needs id, method, path and source");
		}
		const request = entry.request;
		if (!isRecord(request) || (request.kind !== "json" && request.kind !== "multipart" && request.kind !== "none")) {
			throw new Error(`fixture: route ${entry.id} needs a request kind`);
		}
		return {
			id: entry.id,
			method: entry.method,
			path: entry.path,
			source: entry.source,
			request: {
				kind: request.kind,
				required: stringList(request.required, `${entry.id}.request.required`),
				optional: stringList(request.optional, `${entry.id}.request.optional`),
				ignoredByServer: stringList(request.ignoredByServer, `${entry.id}.request.ignoredByServer`),
			},
			responseFieldsRead: stringList(entry.responseFieldsRead, `${entry.id}.responseFieldsRead`),
			...(entry.responseFieldsOptional !== undefined ? { responseFieldsOptional: stringList(entry.responseFieldsOptional, `${entry.id}.responseFieldsOptional`) } : {}),
			sampleResponse: entry.sampleResponse,
			clientExpects: entry.clientExpects,
		};
	});
	const denylist = raw.denylist.map((entry: unknown) => {
		if (!isRecord(entry) || typeof entry.method !== "string" || typeof entry.path !== "string" || typeof entry.reason !== "string" || typeof entry.source !== "string") {
			throw new Error("fixture: every denylist entry needs method, path, reason and source");
		}
		return { method: entry.method, path: entry.path, reason: entry.reason, source: entry.source };
	});
	return { provenance: raw.provenance, auth: { header: String(raw.auth.header), neverSent: stringList(raw.auth.neverSent, "auth.neverSent") }, denylist, routes };
}

const FIXTURE = parseFixture(await Bun.file(new URL("./__fixtures__/lightrag-v1.5.7-routes.json", import.meta.url)).json());

function cloneFixture(): Fixture {
	return structuredClone(FIXTURE);
}

function routeRegex(path: string): RegExp {
	return new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`);
}

function matchRoute(fixture: Fixture, method: string, path: string): FixtureRoute | undefined {
	return fixture.routes.find((route) => route.method === method.toUpperCase() && routeRegex(route.path).test(path));
}

interface Emitted {
	method: string;
	path: string;
	kind: "json" | "multipart" | "none";
	keys: string[];
	headers: Headers;
}

/**
 * A fetch that records every request the client emits and answers each from the fixture's sample response, so the
 * client runs against exactly what the contract says the server returns. `statusOverrides` (`"POST /path"` → status)
 * lets a scenario force one route to fail. A request the fixture does not list is recorded and answered 404.
 */
function recordingFetch(fixture: Fixture, emitted: Emitted[], statusOverrides: Record<string, number> = {}): FetchLike {
	return async (input, init) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const body = init?.body;
		let kind: Emitted["kind"] = "none";
		let keys: string[] = [];
		if (body instanceof FormData) {
			kind = "multipart";
			keys = [...new Set(body.keys())];
		} else if (typeof body === "string") {
			kind = "json";
			const parsed: unknown = JSON.parse(body);
			keys = isRecord(parsed) ? Object.keys(parsed) : [];
		}
		emitted.push({ method, path: url.pathname, kind, keys, headers: new Headers(init?.headers) });
		const forced = statusOverrides[`${method} ${url.pathname}`];
		if (forced !== undefined) return Response.json({ detail: "forced" }, { status: forced });
		const route = matchRoute(fixture, method, url.pathname);
		if (route === undefined) return Response.json({ detail: "no such route in the fixture" }, { status: 404 });
		return Response.json(route.sampleResponse);
	};
}

const UPLOAD: LightragUploadRequest = {
	name: "docs__a__README.md",
	content: "# Setup\nInstall it.",
	metadata: {
		source_url: "file:///repo/docs/a/README.md",
		commit: "abc1234",
		heading_path: "Setup",
		graph_entities: ["Hindsight"],
		graph_relations: [{ source: "docs/a", target: "docs/b", kind: "depends-on" }],
	},
};

/** Run every function of the client that can reach the network, and return what it emitted. */
async function driveClient(fixture: Fixture): Promise<Emitted[]> {
	const emitted: Emitted[] = [];
	const fetchImpl = recordingFetch(fixture, emitted);
	await retrieveChunks(CONFIG, { question: "what reads Hindsight?" }, fetchImpl);
	await uploadDocument(CONFIG, UPLOAD, fetchImpl);
	// The text fallback only runs after a 404 from the upload route.
	await uploadDocument(CONFIG, UPLOAD, recordingFetch(fixture, emitted, { "POST /documents/upload": 404 }));
	await storePlanningPage(CONFIG, { path: ".planning/phases/01/PLAN.md", sourceUrl: "file:///repo/.planning/phases/01/PLAN.md", body: "plan" }, fetchImpl);
	await scanDocuments(CONFIG, fetchImpl);
	await parseDocuments(CONFIG, "ds", ["unused"], fetchImpl);
	await pollParseStatus(CONFIG, { dataset_id: "ds", document_id: "unused" }, fetchImpl, { maxPolls: 1, intervalMs: 0 });
	await resolveDocumentIds(CONFIG, "upload_20260902_170612_abc123", fetchImpl, { maxPolls: 1 });
	await deleteDocuments(CONFIG, "ds", ["doc-3f2a9c"], fetchImpl);
	await probeLightrag(CONFIG, fetchImpl);
	return emitted;
}

/** The violations of the route contract in what the client emitted. Empty means the client conforms. */
function checkContract(fixture: Fixture, emitted: readonly Emitted[]): string[] {
	const violations: string[] = [];
	if (!fixture.denylist.some((entry) => entry.method === "DELETE" && entry.path === "/documents")) {
		violations.push("the denylist lost DELETE /documents (clear-all)");
	}
	for (const route of fixture.routes) {
		if (fixture.denylist.some((entry) => entry.method === route.method && entry.path === route.path)) {
			violations.push(`the fixture lists the denylisted route ${route.method} ${route.path}`);
		}
		if (!emitted.some((entry) => entry.method === route.method && routeRegex(route.path).test(entry.path))) {
			violations.push(`the client never emits ${route.method} ${route.path}: a stale route, or one the driver does not exercise`);
		}
	}
	for (const entry of emitted) {
		const label = `${entry.method} ${entry.path}`;
		if (isClearAllRequest(entry.method, entry.path) || fixture.denylist.some((denied) => denied.method === entry.method && denied.path === entry.path)) {
			violations.push(`the client emitted the denylisted ${label}`);
			continue;
		}
		for (const header of fixture.auth.neverSent) {
			if (entry.headers.has(header)) violations.push(`${label} sent the ${header} header`);
		}
		const route = matchRoute(fixture, entry.method, entry.path);
		if (route === undefined) {
			violations.push(`the client emits ${label}, which the fixture does not list`);
			continue;
		}
		if (entry.kind !== route.request.kind) violations.push(`${label} sent a ${entry.kind} body, the contract says ${route.request.kind}`);
		for (const field of route.request.required) {
			if (!entry.keys.includes(field)) violations.push(`${label} lacks the required request field ${field}`);
		}
		const known = [...route.request.required, ...route.request.optional, ...route.request.ignoredByServer];
		for (const field of entry.keys) {
			if (!known.includes(field)) violations.push(`${label} sends the unknown request field ${field}`);
		}
	}
	return violations;
}

/** Whether every member of `expected` is in `actual` (arrays index by position). */
function isSubset(expected: unknown, actual: unknown): boolean {
	if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((entry, index) => isSubset(entry, actual[index]));
	if (isRecord(expected)) return isRecord(actual) && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
	return expected === actual;
}

/** The client call that parses each route's response, by route id. Each is served the route's sample. */
const SCENARIOS: Record<string, (sample: unknown) => Promise<unknown>> = {
	query: (sample) => retrieveChunks(CONFIG, { question: "what reads Hindsight?" }, async () => Response.json(sample)),
	upload: (sample) => uploadDocument(CONFIG, UPLOAD, async () => Response.json(sample)),
	text: (sample) => {
		let first = true;
		return uploadDocument(CONFIG, UPLOAD, async () => {
			if (first) {
				first = false;
				return Response.json({ detail: "Not Found" }, { status: 404 });
			}
			return Response.json(sample);
		});
	},
	scan: (sample) => scanDocuments(CONFIG, async () => Response.json(sample)),
	pipeline_status: (sample) => pollParseStatus(CONFIG, { dataset_id: "ds", document_id: "unused" }, async () => Response.json(sample), { maxPolls: 1, intervalMs: 0 }),
	track_status: (sample) => resolveDocumentIds(CONFIG, "upload_20260902_170612_abc123", async () => Response.json(sample), { maxPolls: 1 }),
	delete_document: (sample) => deleteDocuments(CONFIG, "ds", ["doc-3f2a9c"], async () => Response.json(sample)),
	health: (sample) => probeLightrag(CONFIG, async () => Response.json(sample)),
};

/** The violations in how the client parses the fixture's sample responses. */
async function checkSamples(fixture: Fixture): Promise<string[]> {
	const violations: string[] = [];
	for (const route of fixture.routes) {
		const scenario = SCENARIOS[route.id];
		if (scenario === undefined) {
			violations.push(`${route.id}: no scenario parses this route's sample response`);
			continue;
		}
		for (const field of route.responseFieldsRead) {
			const [head, member] = field.split("[].");
			const container = isRecord(route.sampleResponse) ? route.sampleResponse[head ?? ""] : undefined;
			const present =
				member === undefined
					? isRecord(route.sampleResponse) && (head ?? "") in route.sampleResponse
					: Array.isArray(container) && container.every((entry) => isRecord(entry) && member in entry);
			if (!present) violations.push(`${route.id}: the sample response lacks the field ${field} the client reads`);
		}
		const outcome = await scenario(route.sampleResponse);
		if (!isSubset(route.clientExpects, outcome)) {
			violations.push(`${route.id}: the client parsed ${JSON.stringify(outcome)}, the fixture expects ${JSON.stringify(route.clientExpects)}`);
		}
	}
	return violations;
}

describe("the v1.5.7 route contract", () => {
	test("the fixture says it is derived from source and names the operator diff against /openapi.json", () => {
		expect(FIXTURE.provenance).toContain("DERIVED FROM THE UPSTREAM SOURCE");
		expect(FIXTURE.provenance).toContain("NOT RECORDED FROM A LIVE SERVER");
		expect(FIXTURE.provenance).toContain("/openapi.json");
		for (const route of FIXTURE.routes) expect(route.source).toStartWith("lightrag v1.5.7 ");
		for (const entry of FIXTURE.denylist) expect(entry.source).toStartWith("lightrag v1.5.7 ");
	});

	test("every (method, path) the client emits is in the fixture, with every required field and none unknown", async () => {
		expect(checkContract(FIXTURE, await driveClient(FIXTURE))).toEqual([]);
	});

	test("the client authenticates with X-API-Key only", async () => {
		const emitted = await driveClient(FIXTURE);
		expect(emitted.length).toBeGreaterThan(0);
		for (const entry of emitted) {
			expect(entry.headers.get(FIXTURE.auth.header)).toBe("lr-contract-key");
			expect(entry.headers.get("authorization")).toBeNull();
		}
	});

	test("every route path the client source calls is a fixture route (a new route cannot slip past the driver)", async () => {
		const source = await Bun.file(new URL("./lightrag.ts", import.meta.url)).text();
		const paths = [...source.matchAll(/call\(config, fetchImpl,\s*([`"])([^`"]*)\1/g)].map((match) => (match[2] ?? "").replace(/\$\{[^}]*\}/g, "x"));
		expect(paths.length).toBe(FIXTURE.routes.length);
		for (const path of paths) {
			expect(FIXTURE.routes.some((route) => routeRegex(route.path).test(path))).toBe(true);
		}
	});

	test("the clear-all route is on the denylist, unreachable from any client function, and refused by the choke point", async () => {
		expect(FIXTURE.denylist).toEqual([expect.objectContaining({ method: "DELETE", path: "/documents" })]);
		const emitted: Emitted[] = [];
		const fetchImpl = recordingFetch(FIXTURE, emitted);
		await deleteDocuments(CONFIG, "ds", ["documents", "/", ".."], fetchImpl);
		expect(emitted.every((entry) => entry.path === "/documents/delete_document")).toBe(true);
		const refused = await lightragCall(CONFIG, fetchImpl, "/documents", { method: "DELETE", json: true, body: "{}", timeoutMs: 100 });
		expect(refused).toEqual({ ok: false, reason: "lightrag clear-all refused" });
		expect(emitted.some((entry) => entry.path === "/documents")).toBe(false);
	});

	test("each hand-written sample response parses to what the fixture expects", async () => {
		expect(await checkSamples(FIXTURE)).toEqual([]);
	});
});

describe("fail-before: the checker rejects a mutated fixture or a non-conforming client", () => {
	test("a route missing from the fixture is a violation", async () => {
		const mutated = cloneFixture();
		mutated.routes = mutated.routes.filter((route) => route.id !== "delete_document");
		const violations = checkContract(mutated, await driveClient(mutated));
		expect(violations).toContain("the client emits DELETE /documents/delete_document, which the fixture does not list");
	});

	test("a required request field the client does not send is a violation", async () => {
		const mutated = cloneFixture();
		const route = mutated.routes.find((entry) => entry.id === "delete_document");
		route?.request.required.push("doc_ids_v2");
		const violations = checkContract(mutated, await driveClient(mutated));
		expect(violations).toContain("DELETE /documents/delete_document lacks the required request field doc_ids_v2");
	});

	test("a request field the contract does not know is a violation", async () => {
		const mutated = cloneFixture();
		const route = mutated.routes.find((entry) => entry.id === "query");
		if (route !== undefined) route.request.optional = route.request.optional.filter((field) => field !== "top_k");
		const violations = checkContract(mutated, await driveClient(mutated));
		expect(violations).toContain("POST /query sends the unknown request field top_k");
	});

	test("a denylist that lost clear-all, or a fixture that lists it as a route, is a violation", async () => {
		const emitted = await driveClient(FIXTURE);
		const lost = cloneFixture();
		lost.denylist = [];
		expect(checkContract(lost, emitted)).toContain("the denylist lost DELETE /documents (clear-all)");
		const listed = cloneFixture();
		listed.routes.push({ id: "clear", method: "DELETE", path: "/documents", source: "x", request: { kind: "none", required: [], optional: [], ignoredByServer: [] }, responseFieldsRead: [], sampleResponse: {}, clientExpects: {} });
		expect(checkContract(listed, emitted)).toContain("the fixture lists the denylisted route DELETE /documents");
	});

	test("a client that emitted DELETE /documents would be caught, in every spelling", () => {
		const bad = (path: string): Emitted => ({ method: "DELETE", path, kind: "json", keys: ["doc_ids"], headers: new Headers() });
		for (const path of ["/documents", "/documents/", "/Documents"]) {
			expect(checkContract(FIXTURE, [bad(path)])).toContain(`the client emitted the denylisted DELETE ${path}`);
		}
	});

	test("a client that sent an Authorization header would be caught", () => {
		const emitted: Emitted = { method: "GET", path: "/health", kind: "none", keys: [], headers: new Headers({ authorization: "Bearer k" }) };
		expect(checkContract(FIXTURE, [emitted])).toContain("GET /health sent the Authorization header");
	});

	test("a sample response the client cannot parse is a violation", async () => {
		const noTrack = cloneFixture();
		const upload = noTrack.routes.find((entry) => entry.id === "upload");
		if (upload !== undefined) upload.sampleResponse = { status: "success", message: "m" };
		expect((await checkSamples(noTrack)).some((line) => line.startsWith("upload: "))).toBe(true);

		const noBusy = cloneFixture();
		const pipeline = noBusy.routes.find((entry) => entry.id === "pipeline_status");
		if (pipeline !== undefined) pipeline.sampleResponse = { unrelated: true };
		expect((await checkSamples(noBusy)).some((line) => line.startsWith("pipeline_status: "))).toBe(true);

		const noDocs = cloneFixture();
		const tracked = noDocs.routes.find((entry) => entry.id === "track_status");
		if (tracked !== undefined) tracked.sampleResponse = { track_id: "t", documents: [], total_count: 0, status_summary: {} };
		expect((await checkSamples(noDocs)).some((line) => line.startsWith("track_status: "))).toBe(true);
	});

	test("a route with no parsing scenario, or a read field missing from the sample, is a violation", async () => {
		const extra = cloneFixture();
		extra.routes.push({ id: "query_data", method: "POST", path: "/query/data", source: "x", request: { kind: "json", required: ["query"], optional: [], ignoredByServer: [] }, responseFieldsRead: [], sampleResponse: {}, clientExpects: {} });
		expect(await checkSamples(extra)).toContain("query_data: no scenario parses this route's sample response");
		const missing = cloneFixture();
		const health = missing.routes.find((entry) => entry.id === "health");
		if (health !== undefined) health.responseFieldsRead.push("uptime");
		expect(await checkSamples(missing)).toContain("health: the sample response lacks the field uptime the client reads");
	});
});
