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
	readonly datasets: FakeDataset[] = [
		{ id: BERLIN_ID, name: "agent-substrate", embedding_model: "tei-bge-small" },
		{ id: HAMM_ID, name: "programming-desk", embedding_model: "tei-bge-small" },
		{ id: LEIPZIG_ID, name: "agent-skills", embedding_model: "tei-bge-small" },
	];
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
}
