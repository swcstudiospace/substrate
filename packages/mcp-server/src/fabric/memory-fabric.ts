/**
 * E3 unified memory fabric (phase 84): one routing seam over the two planes.
 *
 * Hindsight is the bank owner — every write lands there (`remember` →
 * Hindsight retain, `forget` → Hindsight forget). LightRAG is provenance-only:
 * the fabric reads its chunks as metadata (`ProvenanceChunk`) and never
 * accepts a content write through this seam. Any attempt to write content to
 * LightRAG through the fabric is rejected with one audit event and never
 * reaches a LightRAG write call — the `LightragPort` has no write method, so
 * the rejection is structural, not just a checked gate.
 *
 * Pure routing over injected ports: the plane clients live in the adapter
 * (`productionPorts`) and in the tests' fakes. No method throws for a plane
 * failure — a down plane degrades its leg and names the reason.
 */
import type { LightragConfig } from "../config.ts";
import { lightragFromEnv } from "../config.ts";
import {
	deleteDocument,
	hindsightFromEnv,
	recallBank,
	retainMemories,
	type HindsightResult,
	type RecallHit,
	type RetainItem,
} from "../planes/hindsight.ts";
import { queryWithGraph } from "../planes/lightrag.ts";

/** LightRAG provenance metadata. `content` never crosses the fabric: a chunk is its identity and score, nothing else. */
export interface ProvenanceChunk {
	document_id: string;
	document_name: string;
	score?: number;
	heading_path?: string;
	source_url?: string;
}

/** The LightRAG read the fabric needs: provenance metadata for a query, never content writes. */
export interface LightragPort {
	provenance(query: string): Promise<{ ok: true; chunks: ProvenanceChunk[] } | { ok: false; reason: string }>;
}

/** The Hindsight write/read surface the fabric routes to. */
export interface HindsightPort {
	retain(bank: string, items: RetainItem[]): Promise<HindsightResult<{ items_count: number }>>;
	recall(bank: string, query: string): Promise<HindsightResult<RecallHit[]>>;
	forget(bank: string, documentId: string): Promise<HindsightResult<boolean>>;
}

/** The one audit sink: the LightRAG-write rejection trails here, beside `auditMemoryWrite` in `service.ts`. */
export interface LedgerAuditPort {
	audit(summary: string, payload: Record<string, unknown>): Promise<void>;
}

export interface RememberInput {
	bank: string;
	content: string;
	document_id: string;
	tags?: readonly string[];
	metadata?: Record<string, string>;
}

export interface FabricHit {
	id: string;
	/** Hindsight text; null for a LightRAG-only provenance row. */
	text: string | null;
	document_id?: string;
	provenance?: ProvenanceChunk;
	hindsight: boolean;
	lightrag: boolean;
}

export type RememberResult = { ok: true; items_count: number } | { ok: false; reason: string };
export type ForgetResult = { ok: true } | { ok: false; reason: string };
export interface RecallResult {
	hits: FabricHit[];
	degraded: boolean;
	reasons: string[];
}

/** The refusal a LightRAG content write through the fabric gets. */
export const LIGHTRAG_WRITE_FORBIDDEN = "lightrag-write-forbidden";

function provenanceOf(chunk: { document_id?: string; document_name: string; score?: number; heading_path?: string; source_url?: string }): ProvenanceChunk {
	return {
		document_id: chunk.document_id ?? chunk.document_name,
		document_name: chunk.document_name,
		...(chunk.score !== undefined ? { score: chunk.score } : {}),
		...(chunk.heading_path !== undefined ? { heading_path: chunk.heading_path } : {}),
		...(chunk.source_url !== undefined ? { source_url: chunk.source_url } : {}),
	};
}

export class MemoryFabric {
	private readonly hindsight: HindsightPort | null;
	private readonly lightrag: LightragPort | null;
	private readonly audit: LedgerAuditPort | null;

	constructor(deps: { hindsight?: HindsightPort | null; lightrag?: LightragPort | null; audit?: LedgerAuditPort | null } = {}) {
		this.hindsight = deps.hindsight ?? null;
		this.lightrag = deps.lightrag ?? null;
		this.audit = deps.audit ?? null;
	}

	/** `remember` → Hindsight only. An empty content or document id is a programmer error, never a silent success. */
	async remember(input: RememberInput): Promise<RememberResult> {
		if (!input.content) throw new Error("remember needs content; remembering nothing is forbidden");
		if (!input.document_id) throw new Error("remember needs a document_id; unkeyed retain is forbidden");
		if (this.hindsight === null) return { ok: false, reason: "hindsight-unconfigured" };
		const item: RetainItem = {
			content: input.content,
			tags: [...(input.tags ?? [])],
			document_id: input.document_id,
			...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		};
		const result = await this.hindsight.retain(input.bank, [item]);
		return result.ok ? { ok: true, items_count: result.value.items_count } : { ok: false, reason: `hindsight-retain:${result.error.kind}` };
	}

	/**
	 * `recall` → Hindsight + LightRAG provenance join (metadata only). Hindsight
	 * hits keep their text; a LightRAG chunk on the same `document_id` adds its
	 * provenance beside them. A LightRAG-only chunk is a provenance row with
	 * `text: null` — its content is never read through the fabric.
	 */
	async recall(input: { bank: string; query: string }): Promise<RecallResult> {
		const reasons: string[] = [];
		const [hindsightRead, lightragRead] = await Promise.all([
			this.hindsight === null ? Promise.resolve(null) : this.hindsight.recall(input.bank, input.query).catch(() => null),
			this.lightrag === null ? Promise.resolve(null) : this.lightrag.provenance(input.query).catch(() => null),
		]);
		const hits: FabricHit[] = [];
		const byDocument = new Map<string, FabricHit>();
		if (hindsightRead === null) {
			reasons.push(this.hindsight === null ? "hindsight-unconfigured" : "hindsight-unreadable");
		} else if (!hindsightRead.ok) {
			reasons.push(`hindsight-recall:${hindsightRead.error.kind}`);
		} else {
			for (const hit of hindsightRead.value) {
				const row: FabricHit = {
					id: hit.id,
					text: hit.text,
					...(hit.document_id !== undefined ? { document_id: hit.document_id } : {}),
					hindsight: true,
					lightrag: false,
				};
				hits.push(row);
				if (hit.document_id !== undefined) byDocument.set(hit.document_id, row);
			}
		}
		if (lightragRead === null) {
			reasons.push(this.lightrag === null ? "lightrag-unconfigured" : "lightrag-unreadable");
		} else if (!lightragRead.ok) {
			reasons.push(`lightrag-provenance:${lightragRead.reason}`);
		} else {
			for (const chunk of lightragRead.chunks) {
				const provenance = provenanceOf(chunk);
				const joined = byDocument.get(chunk.document_id);
				if (joined !== undefined) {
					joined.provenance = provenance;
					joined.lightrag = true;
				} else {
					hits.push({ id: provenance.document_id, text: null, document_id: provenance.document_id, provenance, hindsight: false, lightrag: true });
				}
			}
		}
		return { hits, degraded: reasons.length > 0, reasons };
	}

	/** `forget` → Hindsight forget only. No LightRAG leg exists to forget through. */
	async forget(input: { bank: string; document_id: string }): Promise<ForgetResult> {
		if (!input.document_id) throw new Error("forget needs a document_id; unkeyed forget is forbidden");
		if (this.hindsight === null) return { ok: false, reason: "hindsight-unconfigured" };
		const result = await this.hindsight.forget(input.bank, input.document_id);
		return result.ok ? { ok: true } : { ok: false, reason: `hindsight-forget:${result.error.kind}` };
	}

	/**
	 * The one write the fabric refuses: content to LightRAG. Rejected always,
	 * audited once, and no LightRAG write is called — the port cannot write.
	 */
	async writeLightragContent(input: { content: string }): Promise<RememberResult> {
		void input;
		if (this.audit !== null) {
			await this.audit.audit("memory fabric rejected LightRAG content write", {
				outcome: "rejected",
				reason: LIGHTRAG_WRITE_FORBIDDEN,
			}).catch(() => undefined);
		}
		return { ok: false, reason: LIGHTRAG_WRITE_FORBIDDEN };
	}

	/** `remember` to a named plane: only `hindsight` lands; anything else is the LightRAG refusal. */
	async rememberTo(target: string, input: RememberInput): Promise<RememberResult> {
		if (target === "hindsight") return this.remember(input);
		return this.writeLightragContent({ content: input.content });
	}
}

/** Production ports from the environment readers. Tests inject fakes instead. */
export function productionPorts(fetchImpl: typeof fetch = fetch): { hindsight: HindsightPort | null; lightrag: LightragPort | null } {
	const hindsight = hindsightFromEnv();
	const lightrag: LightragConfig | null = lightragFromEnv();
	return {
		hindsight: hindsight === null ? null : {
			retain: (bank, items) => retainMemories(hindsight, bank, items, fetchImpl),
			recall: (bank, query) => recallBank(hindsight, bank, { query }, fetchImpl),
			forget: (bank, documentId) => deleteDocument(hindsight, bank, documentId, fetchImpl),
		},
		lightrag: lightrag === null ? null : {
			provenance: async (query) => {
				const outcome = await queryWithGraph(lightrag, query, fetchImpl);
				if (!outcome.ok) return { ok: false, reason: outcome.reason };
				return { ok: true, chunks: outcome.chunks.map((chunk) => provenanceOf(chunk)) };
			},
		},
	};
}

