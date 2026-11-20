/**
 * Shared docs-plane wire types. These shapes are what search and ingest exchange with the LightRAG backend.
 */
export interface DocsChunk {
	content: string;
	document_name: string;
	document_id?: string;
	chunk_id?: string;
	heading_path?: string;
	source_url?: string;
	score?: number;
}

export interface RetrievalKnobs {
	similarityThreshold: number;
	vectorSimilarityWeight: number;
	topK: number;
	/** Absent means no reranker field is configured. */
	rerankId?: string;
}

export const DEFAULT_RETRIEVAL_KNOBS: Readonly<RetrievalKnobs> = { similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, topK: 1024 };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DocsDataset {
	id: string;
	name: string;
}

export type DatasetListOutcome = { ok: true; datasets: DocsDataset[] } | { ok: false; reason: string };

export type RetrievalOutcome = { ok: true; chunks: DocsChunk[] } | { ok: false; reason: string };
