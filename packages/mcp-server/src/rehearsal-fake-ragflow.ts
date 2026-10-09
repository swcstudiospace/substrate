/**
 * Loopback fake RAGFlow for the rehearsal harness (D25-24): the endpoints
 * `RagflowClient` uses, against run-dir state, with scriptable failure modes.
 *
 * Two shapes share one handler:
 *
 * - unit tests import `startFakeRagflow` and drive it in-process, flipping
 *   modes through the returned handle without a restart;
 * - `bun run rehearsal up --ragflow-fixture` spawns this file as a detached
 *   process (`--serve --run-dir <dir> --port <N>`), and the smoke scripts the
 *   modes by writing `<runDir>/ragflow-fixture/mode.json` — no restart, no
 *   real RAGFlow anywhere.
 *
 * Endpoints (exactly what `docs/ragflow.ts` calls, nothing more):
 *
 *   POST /api/v1/retrieval                        -> {code:0,data:{chunks}}
 *   GET  /api/v1/datasets?page=&page_size=        -> {code:0,data:{datasets}}
 *   POST /api/v1/datasets                         -> {code:0,data:{id}}
 *   PUT  /api/v1/datasets/:id                     -> {code:0,data:{}}
 *   GET  /api/v1/datasets/:id/documents?...      -> {code:0,data:{docs}}
 *   POST /api/v1/datasets/:id/documents           -> {code:0,data:{documents}}
 *   PUT  /api/v1/datasets/:id/documents/:doc      -> {code:0,data:{}}
 *   DELETE /api/v1/datasets/:id/documents         -> {code:0,data:{}}
 *   POST /api/v1/datasets/:id/chunks              -> {code:0,data:{}}
 *
 * Modes (`mode.json`, or `handle.setMode` in-process):
 *
 *   normal      answer from state;
 *   timeout     sleep past the client's budget, then answer (proves
 *               `ragflow-timeout` without touching the clock);
 *   error       answer `{code:<n>,message}` with 200 (proves `ragflow-error`);
 *   malformed   answer 200 with a non-JSON body (proves `ragflow-bad-response`);
 *   http-error  answer a non-2xx status (proves `ragflow-error` on the status path).
 *
 * Every mutation is persisted to `<runDir>/ragflow-fixture/state.json`
 * (atomic temp-file plus rename), so `scripts/docs-smoke.ts` can assert what
 * the fake received — images stripped, secrets absent, upload counts — by
 * reading a file, never by querying a second door. The server binds
 * 127.0.0.1 only and holds no credential: the harness's `RAGFLOW_API_KEY`
 * is accepted and ignored, as a key the fake never checks.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeRagflowMode = "normal" | "timeout" | "error" | "malformed" | "http-error";

export interface FakeRagflowModeFile {
	mode?: FakeRagflowMode;
	/** Milliseconds `timeout` sleeps before answering; default 8000. */
	sleepMs?: number;
	/** Non-zero `code` the `error` mode answers; default 102. */
	code?: number;
	/** Message the `error` mode carries; default "fixture error". */
	message?: string;
	/** Status the `http-error` mode answers; default 500. */
	status?: number;
}

export interface FakeRagflowDoc {
	id: string;
	name: string;
	run: string;
	metaFields: Record<string, unknown>;
	content: string;
}

export interface FakeRagflowDataset {
	id: string;
	name: string;
	embeddingModel?: string;
	docs: Record<string, FakeRagflowDoc>;
}

export interface FakeRagflowState {
	datasets: Record<string, FakeRagflowDataset>;
	calls: { retrieval: number; uploads: number; parses: number; lists: number; writes: number; deletes: number };
	seq: number;
}

export function emptyFakeState(): FakeRagflowState {
	return { datasets: {}, calls: { retrieval: 0, uploads: 0, parses: 0, lists: 0, writes: 0, deletes: 0 }, seq: 0 };
}

/** Read the scriptable mode: the in-process override wins, else `mode.json`, else normal. Never throws. */
export function readRagflowMode(
	modeFile: string | null,
	override: FakeRagflowModeFile | null,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Required<Pick<FakeRagflowModeFile, "mode">> & FakeRagflowModeFile {
	const fallback: Required<Pick<FakeRagflowModeFile, "mode">> &
		FakeRagflowModeFile = { mode: "normal", sleepMs: 8000, code: 102, message: "fixture error", status: 500 };
	if (override) return { ...fallback, ...override };
	if (!modeFile) return fallback;
	try {
		const parsed = JSON.parse(readFile(modeFile)) as unknown;
		if (typeof parsed !== "object" || parsed === null) return fallback;
		return { ...fallback, ...(parsed as FakeRagflowModeFile) };
	} catch {
		return fallback;
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function datasetOf(state: FakeRagflowState, id: string): FakeRagflowDataset {
	let found = Object.values(state.datasets).find((row) => row.id === id);
	if (!found) {
		found = { id, name: id, docs: {} };
		state.datasets[id] = found;
	}
	return found;
}

/** Score a stored document against the question: word overlap, so a smoke marker ranks first. */
function scoreDoc(question: string, doc: FakeRagflowDoc): number {
	const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
	if (words.length === 0) return 0.1;
	const hay = doc.content.toLowerCase();
	let hits = 0;
	for (const word of words) if (hay.includes(word)) hits += 1;
	return hits > 0 ? hits / words.length : 0;
}

export interface FakeRagflowHandle {
	url: string;
	state: FakeRagflowState;
	setMode(mode: FakeRagflowModeFile | null): void;
	persist(): void;
	close(): void;
}

export interface StartFakeRagflowOptions {
	/** Run directory the state file lives in; null keeps state in memory (unit tests). */
	runDir?: string | null;
	/** Port to bind; 0 picks a free loopback port. */
	port?: number;
	/** Starting mode for in-process use; the serve process reads `mode.json` instead. */
	mode?: FakeRagflowModeFile | null;
	/** Starting state; a fresh one when absent. */
	state?: FakeRagflowState;
}

/**
 * Start the fake on 127.0.0.1. The handler reads the mode on every request,
 * so a test or the smoke flips behaviour without a restart. Mutations persist
 * to `<runDir>/ragflow-fixture/state.json` when `runDir` is set.
 */
export function startFakeRagflow(options: StartFakeRagflowOptions = {}): FakeRagflowHandle {
	const runDir = options.runDir ?? null;
	const dir = runDir ? join(runDir, "ragflow-fixture") : null;
	const stateFile = dir ? join(dir, "state.json") : null;
	const modeFile = dir ? join(dir, "mode.json") : null;
	if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const state: FakeRagflowState = options.state ?? emptyFakeState();
	let override: FakeRagflowModeFile | null = options.mode ?? null;

	function persist(): void {
		if (!stateFile) return;
		const tmp = `${stateFile}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		try {
			rmSync(stateFile, { force: true });
		} catch {
			// A missing file removes nothing; the rename below still lands.
		}
		renameSync(tmp, stateFile);
	}

	async function handler(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const mode = readRagflowMode(modeFile, override);
		if (mode.mode === "timeout") await Bun.sleep(mode.sleepMs ?? 8000);
		if (mode.mode === "malformed") return new Response("this is not json{", { status: 200 });
		if (mode.mode === "http-error") {
			return json({ code: mode.status ?? 500, message: mode.message ?? "fixture error" }, mode.status ?? 500);
		}
		if (mode.mode === "error") return json({ code: mode.code ?? 102, message: mode.message ?? "fixture error" });
		const path = url.pathname;

		if (req.method === "POST" && path === "/api/v1/retrieval") {
			state.calls.retrieval += 1;
			let body: { question?: unknown; dataset_ids?: unknown; page_size?: unknown } = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return json({ code: 0, data: { chunks: [] } });
			}
			const question = typeof body.question === "string" ? body.question : "";
			const ids = Array.isArray(body.dataset_ids) ? body.dataset_ids.filter((id): id is string => typeof id === "string") : [];
			const pageSize = typeof body.page_size === "number" && body.page_size > 0 ? Math.floor(body.page_size) : 10;
			const scored: Array<{ score: number; doc: FakeRagflowDoc; datasetId: string }> = [];
			for (const dataset of Object.values(state.datasets)) {
				if (!ids.includes(dataset.id)) continue;
				for (const doc of Object.values(dataset.docs)) scored.push({ score: scoreDoc(question, doc), doc, datasetId: dataset.id });
			}
			scored.sort((a, b) => b.score - a.score);
			const chunks = scored.slice(0, pageSize).map(({ score, doc, datasetId }) => ({
				id: `chunk-${doc.id}-0`,
				content: doc.content,
				document_id: doc.id,
				dataset_id: datasetId,
				similarity: score,
				document_keyword: doc.name,
			}));
			return json({ code: 0, data: { chunks } });
		}

		if (req.method === "GET" && path === "/api/v1/datasets") {
			state.calls.lists += 1;
			return json({
				code: 0,
				data: {
					datasets: Object.values(state.datasets).map((dataset) => ({
						id: dataset.id,
						name: dataset.name,
						...(dataset.embeddingModel === undefined ? {} : { embedding_model: dataset.embeddingModel }),
					})),
				},
			});
		}

		if (req.method === "POST" && path === "/api/v1/datasets") {
			state.calls.writes += 1;
			const body = (await req.json().catch(() => ({}))) as { name?: unknown; embedding_model?: unknown };
			const name = typeof body.name === "string" && body.name.length > 0 ? body.name : `dataset-${state.seq + 1}`;
			state.seq += 1;
			const id = `ds-${state.seq}`;
			state.datasets[id] = { id, name, docs: {} };
			persist();
			return json({ code: 0, data: { id, name } });
		}

		const datasetPut = path.match(/^\/api\/v1\/datasets\/([^/]+)$/);
		if (req.method === "PUT" && datasetPut) {
			state.calls.writes += 1;
			const dataset = datasetOf(state, decodeURIComponent(datasetPut[1] ?? ""));
			const body = (await req.json().catch(() => ({}))) as { embedding_model?: unknown };
			if (typeof body.embedding_model === "string") dataset.embeddingModel = body.embedding_model;
			persist();
			return json({ code: 0, data: {} });
		}

		const docsList = path.match(/^\/api\/v1\/datasets\/([^/]+)\/documents$/);
		if (docsList) {
			const datasetId = decodeURIComponent(docsList[1] ?? "");
			if (req.method === "GET") {
				state.calls.lists += 1;
				const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
				const pageSize = Math.max(1, Number(url.searchParams.get("page_size")) || 100);
				const docs = Object.values(state.datasets[datasetId]?.docs ?? {});
				return json({
					code: 0,
					data: {
						docs: docs.slice((page - 1) * pageSize, page * pageSize).map((doc) => ({
							id: doc.id,
							name: doc.name,
							run: doc.run,
							meta_fields: { ...doc.metaFields },
						})),
					},
				});
			}
			if (req.method === "POST") {
				state.calls.uploads += 1;
				const dataset = datasetOf(state, datasetId);
				const form = await req.formData().catch((): null => null);
				if (form === null) {
					return json({ code: 400, message: "fixture needs multipart file fields" }, 400);
				}
				const created: Array<{ id: string; name: string }> = [];
				for (const value of form.getAll("file")) {
					if (typeof value === "string") continue;
					const file = value as File;
					state.seq += 1;
					const id = `doc-${state.seq}`;
					const content = await file.text();
					dataset.docs[id] = { id, name: file.name || `${id}.md`, run: "UNSTART", metaFields: {}, content };
					created.push({ id, name: file.name || `${id}.md` });
				}
				persist();
				return json({ code: 0, data: { documents: created } });
			}
			if (req.method === "DELETE") {
				state.calls.deletes += 1;
				const dataset = state.datasets[datasetId];
				const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
				const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
				for (const id of ids) delete dataset?.docs[id];
				persist();
				return json({ code: 0, data: {} });
			}
		}

		const chunksPost = path.match(/^\/api\/v1\/datasets\/([^/]+)\/chunks$/);
		if (req.method === "POST" && chunksPost) {
			state.calls.parses += 1;
			const dataset = state.datasets[decodeURIComponent(chunksPost[1] ?? "")];
			const body = (await req.json().catch(() => ({}))) as { document_ids?: unknown };
			const ids = Array.isArray(body.document_ids)
				? body.document_ids.filter((id): id is string => typeof id === "string")
				: [];
			for (const id of ids) {
				const doc = dataset?.docs[id];
				if (doc) doc.run = "DONE";
			}
			persist();
			return json({ code: 0, data: {} });
		}

		const docPut = path.match(/^\/api\/v1\/datasets\/([^/]+)\/documents\/([^/]+)$/);
		if (req.method === "PUT" && docPut) {
			state.calls.writes += 1;
			const dataset = state.datasets[decodeURIComponent(docPut[1] ?? "")];
			const doc = dataset?.docs[decodeURIComponent(docPut[2] ?? "")];
			if (!doc) return json({ code: 102, message: "no such document" });
			const body = (await req.json().catch(() => ({}))) as { name?: unknown; meta_fields?: unknown };
			if (typeof body.name === "string") doc.name = body.name;
			if (typeof body.meta_fields === "object" && body.meta_fields !== null) {
				doc.metaFields = { ...(body.meta_fields as Record<string, unknown>) };
			}
			persist();
			return json({ code: 0, data: {} });
		}

		return json({ code: 404, message: `fixture has no ${req.method} ${path}` }, 404);
	}

	const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, fetch: handler });
	return {
		url: `http://127.0.0.1:${server.port}`,
		state,
		setMode: (mode: FakeRagflowModeFile | null) => {
			override = mode;
		},
		persist,
		close: () => server.stop(true),
	};
}

// ── serve mode: `bun rehearsal-fake-ragflow.ts --serve --run-dir <dir> --port <N>` ──

if (import.meta.main && process.argv.includes("--serve")) {
	const after = (name: string): string | undefined => process.argv[process.argv.indexOf(name) + 1];
	const rawDir = after("--run-dir");
	const rawPort = after("--port");
	// A following flag is a missing value, never a value: `--run-dir --port 1` refuses.
	const runDir = rawDir === undefined || rawDir.startsWith("--") ? undefined : rawDir;
	const portRaw = rawPort === undefined || rawPort.startsWith("--") ? undefined : rawPort;
	if (!runDir) {
		process.stderr.write("[fake-ragflow] --run-dir <dir> is required\n");
		process.exit(2);
	}
	const port = Number(portRaw ?? "0");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		process.stderr.write("[fake-ragflow] --port must be 0-65535\n");
		process.exit(2);
	}
	const dir = join(runDir, "ragflow-fixture");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let state = emptyFakeState();
	try {
		const raw = readFileSync(join(dir, "state.json"), "utf8");
		const parsed = JSON.parse(raw) as FakeRagflowState;
		if (parsed && typeof parsed === "object" && parsed.datasets && parsed.calls) state = parsed;
	} catch {
		// First start: state begins empty and persists on the first mutation.
	}
	const handle = startFakeRagflow({ runDir, port, state });
	process.stdout.write(`[fake-ragflow] up ${handle.url}\n`);
	const stop = (): void => {
		handle.persist();
		handle.close();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	// Detached under the harness: the event loop outlives this line.
	const { promise } = Promise.withResolvers<void>();
	await promise;
}
