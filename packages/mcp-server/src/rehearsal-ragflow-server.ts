#!/usr/bin/env bun
/**
 * The owned RAGFlow stand-in for the rehearsal harness (`--ragflow-fixture`).
 *
 * A loopback-only Bun process over the recording `ragflow-fake.ts` with
 * uploads served as chunks, so a pin over real uploads matches served chunks.
 * The harness spawns it with exactly two env vars — the scratch key and the
 * listen port — and `--no-env-file`, so it can never read a real env file or
 * a production credential. The key travels by env only: never a CLI arg, a
 * log line or a consumer export.
 *
 * Doors:
 *
 * - `/api/*` — the repo-attested retrieval skeleton plus dataset discovery,
 *   uploads and parse polls, delegated to the fake. Every call needs
 *   `Authorization: Bearer <scratch key>`; anything else is a 401 that names
 *   the status only.
 * - `/__fixture/health` — `{ ok: true }`, for harness readiness.
 * - `/__fixture/counts` — `{ requests, retrievals, uploads, documents }`:
 *   numbers only, never keys or bodies.
 * - `/__fixture/reset` (POST) — clears recorded requests, uploads and
 *   injected failures; answers the fresh counts.
 * - `/__fixture/fail-retrieval` (POST) — `{ status: 500 | 502 | 503 | null }`:
 *   inject or clear a retrieval failure. Anything else is a 400.
 * - `/__fixture/parse` (POST) — `{ behavior: "done" | "never" }`: parse
 *   settles after two polls, or stays parsing so timeout logic is provable.
 * - `/__fixture/seed-chunks` (POST) — `{ dataset, chunks: [{ content,
 *   document_id, source_url?, heading_path?, score?, dataset? }] }`: seed at
 *   most 20 synthetic retrieval chunks, served after uploads under
 *   serveUploadsAsChunks and cleared by reset. Anything else is a 400.
 *
 * Control bodies are streamed with a 64 KiB UTF-8 byte cap enforced before
 * the whole body is buffered, then parsed as JSON; oversize or broken bodies
 * are a 413/400 that names the status only. The cap applies per control
 * reader only, never as a server-wide body limit, so authenticated `/api/*`
 * uploads keep their 5 MB page/call allowance and the 6 MB docs transport.
 * Seed-chunks is a fixture-only proof control: never a product door, never
 * live RAG, synthetic content only, never counted as uploads or documents.
 * Nothing here prints a credential: startup names the host and port, and
 * every refusal names a locator, never a value.
 */
import { RagflowFake } from "./ragflow-fake.ts";
import {
	FIXTURE_COUNTS_PATH,
	FIXTURE_FAIL_PATH,
	FIXTURE_FAILURE_STATUSES,
	FIXTURE_HEALTH_PATH,
	FIXTURE_PARSE_PATH,
	FIXTURE_RESET_PATH,
	FIXTURE_SEED_PATH,
	parseFailRetrievalBody,
	parseFixtureCounts,
	parseParseBehaviourBody,
	parseSeedChunksBody,
	RAGFLOW_FIXTURE_KEY_ENV,
	RAGFLOW_FIXTURE_PORT_ENV,
} from "./rehearsal-ragflow.ts";

/** Control request bodies larger than this many UTF-8 bytes are refused while streaming, before parsing. */
const CONTROL_BODY_MAX_BYTES = 64 * 1024;

function fail(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

function readPort(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return port;
}

const scratchKey = process.env[RAGFLOW_FIXTURE_KEY_ENV] ?? "";
if (scratchKey.length < 32) {
	process.stderr.write("[ragflow-fixture] refused: no scratch key in the child env.\n");
	process.exit(2);
}
const listenPort = readPort(process.env[RAGFLOW_FIXTURE_PORT_ENV]);
if (listenPort === null) {
	process.stderr.write("[ragflow-fixture] refused: no listen port in the child env.\n");
	process.exit(2);
}

const fake = new RagflowFake();
fake.serveUploadsAsChunks = true;

async function readControlBody(req: Request): Promise<{ text: string } | { status: number }> {
	try {
		if (req.body === null) return { text: "" };
		const reader = req.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > CONTROL_BODY_MAX_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// The oversize body is already refused; a cancel failure changes nothing.
				}
				return { status: 413 };
			}
			chunks.push(next.value);
		}
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { text: new TextDecoder().decode(combined) };
	} catch {
		return { status: 400 };
	}
}

function countsBody(): Response {
	const counts = parseFixtureCounts({
		requests: fake.requests.length,
		retrievals: fake.retrievals().length,
		uploads: fake.uploads.length,
		documents: new Set(fake.uploads.map((upload) => upload.document_id)).size,
	});
	// The shape above is built from numbers by construction; a null here is
	// an internal error, never a client fault.
	if (counts === null) return fail(500, "counts unavailable");
	return Response.json(counts);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: listenPort,
	async fetch(req): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;
		if (req.method === "GET" && path === FIXTURE_HEALTH_PATH) {
			return Response.json({ ok: true });
		}
		if (req.method === "GET" && path === FIXTURE_COUNTS_PATH) {
			return countsBody();
		}
		if (req.method === "POST" && path === FIXTURE_RESET_PATH) {
			fake.requests.length = 0;
			fake.uploads.length = 0;
			fake.seeds.length = 0;
			fake.failRetrievalWith = null;
			fake.parseBehavior = "done";
			return countsBody();
		}
		if (req.method === "POST" && path === FIXTURE_FAIL_PATH) {
			const read = await readControlBody(req);
			if ("status" in read) return fail(read.status, "unreadable control body");
			let body: unknown;
			try {
				body = read.text.length > 0 ? JSON.parse(read.text) : null;
			} catch {
				return fail(400, "control body is not JSON");
			}
			const parsed = parseFailRetrievalBody(body);
			if (parsed === null) {
				return fail(400, `status must be one of ${(FIXTURE_FAILURE_STATUSES as readonly number[]).join(", ")} or null`);
			}
			fake.failRetrievalWith = parsed.status;
			return Response.json({ ok: true });
		}
		if (req.method === "POST" && path === FIXTURE_PARSE_PATH) {
			const read = await readControlBody(req);
			if ("status" in read) return fail(read.status, "unreadable control body");
			let body: unknown;
			try {
				body = read.text.length > 0 ? JSON.parse(read.text) : null;
			} catch {
				return fail(400, "control body is not JSON");
			}
			const parsed = parseParseBehaviourBody(body);
			if (parsed === null) return fail(400, 'behavior must be "done" or "never"');
			fake.parseBehavior = parsed.behavior;
			return Response.json({ ok: true });
		}
		if (req.method === "POST" && path === FIXTURE_SEED_PATH) {
			const read = await readControlBody(req);
			if ("status" in read) return fail(read.status, "unreadable control body");
			let body: unknown;
			try {
				body = read.text.length > 0 ? JSON.parse(read.text) : null;
			} catch {
				return fail(400, "control body is not JSON");
			}
			const parsed = parseSeedChunksBody(body);
			if (parsed === null) return fail(400, "seed body needs a dataset and 1-20 bounded chunks");
			// Seeds arrive naming datasets the way the product names them; the
			// fake serves retrieval by dataset id, so resolve every name to the
			// actual existing fake dataset id (per-chunk override included)
			// before changing any seeds. An unknown name is a 400 with nothing
			// stored; the count below names only actually accepted seeds.
			const byId: Record<string, string> = {};
			const byName: Record<string, string> = {};
			for (const dataset of fake.datasets) {
				byId[dataset.id] = dataset.id;
				byName[dataset.name] = dataset.id;
			}
			const resolved: string[] = [];
			for (const seed of parsed.seeds) {
				const id = byId[seed.dataset] ?? byName[seed.dataset];
				if (id === undefined) return fail(400, "seed dataset is unknown");
				resolved.push(id);
			}
			for (let n = 0; n < parsed.seeds.length; n++) {
				const seed = parsed.seeds[n];
				if (seed === undefined) continue;
				fake.seeds.push({
					dataset_id: (resolved[n] as string),
					document_id: seed.document_id,
					content: seed.content,
					source_url: seed.source_url,
					heading_path: seed.heading_path,
					score: seed.score,
				});
			}
			return Response.json({ ok: true, seeded: resolved.length });
		}
		if (path.startsWith("/__fixture/")) {
			return fail(404, "unknown fixture control route");
		}
		if (!path.startsWith("/api/")) return fail(404, "unknown route");
		if (req.headers.get("authorization") !== `Bearer ${scratchKey}`) return fail(401, "fixture bearer required");
		let body: string | undefined;
		if (req.method === "POST") {
			try {
				body = await req.text();
			} catch {
				return fail(400, "unreadable request body");
			}
		}
		return fake.fetch(url, { method: req.method, body: body !== undefined && body.length > 0 ? body : undefined });
	},
});

process.stdout.write(`[ragflow-fixture] listening on 127.0.0.1:${server.port}\n`);
