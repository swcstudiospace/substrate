/**
 * The recording RAGFlow fake for rehearsal (D25-10).
 *
 * Serves the repo-attested retrieval skeleton plus dataset discovery over an
 * injected `fetch`, and records every request it receives. Tests prove the
 * client against it instead of the deployment; the G1 live probe confirms
 * the deployment speaks the same shapes.
 *
 * Anti-pattern gate: any retrieval missing `dataset_ids` fails, so a test
 * suite passing against this fake proves no unscoped retrieval exists.
 */
import type { RagflowChunk } from "./planes/ragflow.ts";

export interface FakeDataset {
	id: string;
	name: string;
	embedding_model: string;
}

export interface RecordedRequest {
	method: string;
	path: string;
	body: unknown;
}

export type FakeChunkShape = "full" | "minimal";

/** A chunk the fake serves, with the ingest metadata the phase sends (U-03). */
export interface FakeChunk extends RagflowChunk {
	source_url: string;
}

const BERLIN_ID = "ds-berlin-agent-substrate";
const HAMM_ID = "ds-hamm-programming-desk";
const LEIPZIG_ID = "ds-leipzig-agent-skills";

function seedChunks(datasetId: string, sourceUrl: string): FakeChunk[] {
	return [
		{
			content: "The substrate is the only door to the data planes.",
			document_name: "data-planes.md",
			document_id: `doc-${datasetId}-1`,
			chunk_id: `chunk-${datasetId}-1`,
			heading_path: "Access path",
			source_url: sourceUrl,
			score: 0.91,
		},
		{
			content: "Callers cite the source, not the chunk.",
			document_name: "data-planes.md",
			document_id: `doc-${datasetId}-2`,
			chunk_id: `chunk-${datasetId}-2`,
			heading_path: "RAGFlow datasets",
			source_url: sourceUrl,
			score: 0.83,
		},
	];
}

export class RagflowFake {
	readonly requests: RecordedRequest[] = [];
	/** Flip to serve the minimal shape (no ids, no heading path) — the U-01 version-swap arm. */
	chunkShape: FakeChunkShape = "full";
	/** When set, the next retrieval answers with this status instead. */
	failRetrievalWith: number | null = null;
	/**
	 * Serve retrieval from the uploaded documents instead of the seed
	 * skeleton, so a pin over real uploads matches served chunks. Off by
	 * default; the seed corpus keeps every existing redaction proof.
	 */
	serveUploadsAsChunks = false;
	readonly datasets: FakeDataset[] = [
		{ id: BERLIN_ID, name: "agent-substrate", embedding_model: "tei-bge-small" },
		{ id: HAMM_ID, name: "programming-desk", embedding_model: "tei-bge-small" },
		{ id: LEIPZIG_ID, name: "agent-skills", embedding_model: "tei-bge-small" },
	];
	/** Every uploaded document, in order, with the id the plane assigned. */
	readonly uploads: Array<{ dataset_id: string; document_id: string; content: string; metadata: Record<string, string> }> = [];
	/**
	 * Proof-control seeded chunks, in call order. Served after uploads when
	 * `serveUploadsAsChunks` is on; never counted as uploads or documents.
	 * Cleared by the fixture reset alongside uploads.
	 */
	readonly seeds: Array<{ dataset_id: string; document_id: string; content: string; source_url: string; heading_path: string; score: number }> = [];
	/** `done` parses after two polls; `never` stays parsing so timeout logic is provable. */
	parseBehavior: "done" | "never" = "done";
	private parsePolls: Record<string, number> = {};
	private nextDoc = 1;
	/** A dataset's served chunks, by dataset id. Tests replace entries for redaction proofs. */
	readonly chunks: Record<string, FakeChunk[]> = {
		[BERLIN_ID]: seedChunks(BERLIN_ID, "https://example.com/agent-substrate/data-planes"),
		[HAMM_ID]: seedChunks(HAMM_ID, "https://example.com/programming-desk/architecture"),
		[LEIPZIG_ID]: seedChunks(LEIPZIG_ID, "https://example.com/agent-skills/review"),
	};

	/** A `fetch` over this fake, for injection into the plane client. */
	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		let body: unknown = null;
		if (typeof init?.body === "string" && init.body.length > 0) {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		this.requests.push({ method, path: url.pathname, body });
		if (method === "POST" && url.pathname === "/api/v1/retrieval") return this.retrieval(body);
		if (method === "GET" && url.pathname === "/api/v1/datasets") return this.datasetList();
		if (method === "POST" && url.pathname === "/api/v1/datasets") return this.createDataset(body);
		if (method === "POST" && url.pathname.startsWith("/api/v1/datasets/") && url.pathname.endsWith("/documents")) {
			return this.upload(url.pathname.split("/")[4] ?? "", body);
		}
		if (method === "GET" && url.pathname.startsWith("/api/v1/documents/") && url.pathname.endsWith("/parse")) {
			return this.parse(url.pathname.split("/")[4] ?? "");
		}
		return Response.json({ error: `fake has no route for ${method} ${url.pathname}` }, { status: 404 });
	};

	/** Every retrieval request body received, in order. */
	retrievals(): unknown[] {
		return this.requests.filter((request) => request.path === "/api/v1/retrieval").map((request) => request.body);
	}

	private retrieval(body: unknown): Response {
		if (this.failRetrievalWith !== null) {
			return Response.json({ error: "injected failure" }, { status: this.failRetrievalWith });
		}
		if (body === null || typeof body !== "object" || !("dataset_ids" in body) || !Array.isArray(body.dataset_ids) || body.dataset_ids.length === 0) {
			return Response.json({ error: "dataset_ids required" }, { status: 400 });
		}
		const pageSize = "page_size" in body && typeof body.page_size === "number" ? body.page_size : 10;
		const out: Record<string, unknown>[] = [];
		for (const id of body.dataset_ids) {
			if (typeof id !== "string") continue;
			if (this.serveUploadsAsChunks) {
				for (const upload of this.uploads.filter((entry) => entry.dataset_id === id)) {
					const name = upload.metadata["source_url"]?.split("/").pop() || "uploaded.md";
					if (this.chunkShape === "minimal") {
						out.push({ content: upload.content, document_name: name });
					} else {
						out.push({
							content: upload.content,
							document_name: name,
							document_id: upload.document_id,
							chunk_id: `${upload.document_id}-c1`,
							heading_path: upload.metadata["heading_path"] ?? "",
							source_url: upload.metadata["source_url"] ?? "",
							score: 0.9,
						});
					}
				}
				for (const seed of this.seeds.filter((entry) => entry.dataset_id === id)) {
					const name = seed.source_url.split("/").pop() || "seeded.md";
					if (this.chunkShape === "minimal") {
						out.push({ content: seed.content, document_name: name });
					} else {
						out.push({
							content: seed.content,
							document_name: name,
							document_id: seed.document_id,
							chunk_id: `${seed.document_id}-seed`,
							heading_path: seed.heading_path,
							source_url: seed.source_url,
							score: seed.score,
						});
					}
				}
				continue;
			}
			for (const chunk of this.chunks[id] ?? []) {
				if (this.chunkShape === "minimal") {
					out.push({ content: chunk.content, document_name: chunk.document_name });
				} else {
					out.push({ ...chunk });
				}
			}
		}
		return Response.json({ data: { chunks: out.slice(0, Math.max(0, pageSize)) } });
	}

	private datasetList(): Response {
		return Response.json({
			data: this.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })),
		});
	}

	private createDataset(body: unknown): Response {
		const name = body !== null && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "";
		if (!name) return Response.json({ error: "name required" }, { status: 400 });
		const existing = this.datasets.find((dataset) => dataset.name === name);
		if (existing) return Response.json({ data: { id: existing.id, name: existing.name } });
		const created: FakeDataset = { id: `ds-created-${this.datasets.length + 1}-${name}`, name, embedding_model: "tei-bge-small" };
		this.datasets.push(created);
		this.chunks[created.id] = [];
		return Response.json({ data: { id: created.id, name: created.name } });
	}

	private upload(datasetId: string, body: unknown): Response {
		if (!this.datasets.some((dataset) => dataset.id === datasetId)) {
			return Response.json({ error: "unknown dataset" }, { status: 404 });
		}
		if (body === null || typeof body !== "object" || !("content" in body) || typeof body.content !== "string") {
			return Response.json({ error: "content required" }, { status: 400 });
		}
		const metadata: Record<string, string> = {};
		if ("metadata" in body && body.metadata !== null && typeof body.metadata === "object") {
			for (const [key, value] of Object.entries(body.metadata)) {
				if (typeof value === "string") metadata[key] = value;
			}
		}
		const documentId = `doc-upload-${this.nextDoc}`;
		this.nextDoc += 1;
		this.uploads.push({ dataset_id: datasetId, document_id: documentId, content: body.content, metadata });
		this.parsePolls[documentId] = 0;
		return Response.json({ data: { document_id: documentId, status: "parsing" } });
	}

	private parse(documentId: string): Response {
		if (!(documentId in this.parsePolls)) return Response.json({ error: "unknown document" }, { status: 404 });
		this.parsePolls[documentId] = (this.parsePolls[documentId] ?? 0) + 1;
		const status = this.parseBehavior === "done" && (this.parsePolls[documentId] ?? 0) >= 2 ? "done" : "parsing";
		return Response.json({ data: { document_id: documentId, status } });
	}
}
