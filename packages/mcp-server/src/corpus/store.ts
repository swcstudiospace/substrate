/**
 * The corpus manifest (v1.7 phase 63): one Postgres row per `(repo, path)` the bulk ingest has seen, behind an interface so
 * the planner and the ingest run against a fake in tests.
 *
 * A row says which version of a document the docs plane holds (`sha256`) and under which plane document id. `manifest_seq`
 * comes from the table's own identity sequence and every write that changes a row takes the next value, so
 * `manifestVersion()` (the maximum) only grows; nothing deletes a row, a removal is a `tombstoned` state.
 */
import type { SQL } from "bun";
import { isCorpusSource, isDocKind, isDocTier, type CorpusScope, type CorpusSource, type CorpusStatusResponse, type DocKind, type DocTier } from "@substrate/corpus";

export type ManifestState = "active" | "tombstoned";

export interface ManifestRow {
	repo: string;
	path: string;
	kind: DocKind;
	tier: DocTier;
	sha256: string;
	bytes: number;
	source: CorpusSource;
	commit: string | null;
	state: ManifestState;
	/** The docs-plane document this row's active content lives in; null for a row that never reached the plane. */
	documentId: string | null;
	manifestSeq: number;
}

/** What `recordIngested` writes: the document as the plane now holds it. */
export interface RecordedDocument {
	repo: string;
	path: string;
	kind: DocKind;
	tier: DocTier;
	sha256: string;
	bytes: number;
	source: CorpusSource;
	commit?: string | undefined;
	documentId: string;
}

/** `status()` without the protocol member the route adds. */
export type CorpusStatusSummary = Omit<CorpusStatusResponse, "protocol">;

export interface CorpusStore {
	/** Every row, any state, whose repo is in `scope.repos`. The planner applies the tier and source limits itself. */
	rowsInScope(scope: CorpusScope): Promise<ManifestRow[]>;
	rowFor(repo: string, path: string): Promise<ManifestRow | null>;
	/** Upserts the row as `active` under the given plane document id and takes the next `manifest_seq`. */
	recordIngested(row: RecordedDocument): Promise<void>;
	/** Marks an active row `tombstoned`; false when there was no active row, so a repeat is a no-op. */
	markTombstoned(repo: string, path: string): Promise<boolean>;
	/** How many ACTIVE rows hold this plane document id. */
	activeReferences(documentId: string): Promise<number>;
	status(): Promise<CorpusStatusSummary>;
	manifestVersion(): Promise<number>;
}

/** The most repositories `status()` lists, ordered by name, so a reply stays bounded. */
export const STATUS_MAX_REPOS = 1000;

function numberOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** A row from the database, or null when a column holds something the closed lists do not allow. */
export function toManifestRow(record: Record<string, unknown>): ManifestRow | null {
	const { repo, path, kind, tier, sha256, source, state } = record;
	const tierNumber = numberOf(tier);
	if (typeof repo !== "string" || typeof path !== "string" || typeof sha256 !== "string") return null;
	if (!isDocKind(kind) || !isDocTier(tierNumber) || !isCorpusSource(source)) return null;
	if (state !== "active" && state !== "tombstoned") return null;
	return {
		repo,
		path,
		kind,
		tier: tierNumber,
		sha256,
		bytes: numberOf(record.bytes),
		source,
		commit: typeof record.commit_sha === "string" ? record.commit_sha : null,
		state,
		documentId: typeof record.docs_document_id === "string" ? record.docs_document_id : null,
		manifestSeq: numberOf(record.manifest_seq),
	};
}

/** The Bun SQL adapter over `corpus_documents` (migration step 35). */
export function bunCorpusStore(sql: SQL): CorpusStore {
	async function manifestVersion(): Promise<number> {
		const rows = await sql`select coalesce(max(manifest_seq), 0)::text as version from corpus_documents`;
		return numberOf(rows[0]?.version);
	}
	return {
		async rowsInScope(scope: CorpusScope): Promise<ManifestRow[]> {
			if (scope.repos.length === 0) return [];
			// `in ${sql(array)}` is the form Bun's SQL expands to a value list; an array passed to `any()` is malformed.
			const rows: Array<Record<string, unknown>> = await sql`select * from corpus_documents where repo in ${sql(scope.repos)} order by repo, path`;
			return rows.flatMap((row) => {
				const parsed = toManifestRow(row);
				return parsed === null ? [] : [parsed];
			});
		},
		async rowFor(repo: string, path: string): Promise<ManifestRow | null> {
			const rows: Array<Record<string, unknown>> = await sql`select * from corpus_documents where repo = ${repo} and path = ${path}`;
			const row = rows[0];
			return row === undefined ? null : toManifestRow(row);
		},
		async recordIngested(row: RecordedDocument): Promise<void> {
			await sql`
				insert into corpus_documents (repo, path, kind, tier, sha256, bytes, source, commit_sha, state, docs_document_id, ingested_at, tombstoned_at, updated_at)
				values (${row.repo}, ${row.path}, ${row.kind}, ${row.tier}, ${row.sha256}, ${row.bytes}, ${row.source}, ${row.commit ?? null}, 'active', ${row.documentId}, now(), null, now())
				on conflict (repo, path) do update set
					kind = excluded.kind,
					tier = excluded.tier,
					sha256 = excluded.sha256,
					bytes = excluded.bytes,
					source = excluded.source,
					commit_sha = excluded.commit_sha,
					state = 'active',
					docs_document_id = excluded.docs_document_id,
					ingested_at = now(),
					tombstoned_at = null,
					updated_at = now(),
					manifest_seq = nextval(pg_get_serial_sequence('corpus_documents', 'manifest_seq'))`;
		},
		async markTombstoned(repo: string, path: string): Promise<boolean> {
			const rows = await sql`
				update corpus_documents
				set state = 'tombstoned',
					tombstoned_at = now(),
					updated_at = now(),
					manifest_seq = nextval(pg_get_serial_sequence('corpus_documents', 'manifest_seq'))
				where repo = ${repo} and path = ${path} and state = 'active'
				returning 1 as changed`;
			return rows.length === 1;
		},
		async activeReferences(documentId: string): Promise<number> {
			const rows = await sql`select count(*)::int as n from corpus_documents where docs_document_id = ${documentId} and state = 'active'`;
			return numberOf(rows[0]?.n);
		},
		manifestVersion,
		async status(): Promise<CorpusStatusSummary> {
			const [totals, byRepo, byKind, byTier, last, version] = await Promise.all([
				sql`select count(*) filter (where state = 'active')::int as active, count(*) filter (where state = 'tombstoned')::int as tombstoned from corpus_documents`,
				sql`
					select repo, count(*) filter (where state = 'active')::int as active, count(*) filter (where state = 'tombstoned')::int as tombstoned
					from corpus_documents group by repo order by repo limit ${STATUS_MAX_REPOS}`,
				sql`select kind, count(*)::int as n from corpus_documents where state = 'active' group by kind order by kind`,
				sql`select tier::int as tier, count(*)::int as n from corpus_documents where state = 'active' group by tier order by tier`,
				sql`select max(ingested_at) as last from corpus_documents`,
				manifestVersion(),
			]);
			const active = numberOf(totals[0]?.active);
			const tombstoned = numberOf(totals[0]?.tombstoned);
			const lastIngest: unknown = last[0]?.last;
			return {
				total: active + tombstoned,
				active,
				tombstoned,
				byRepo: byRepo.flatMap((row: Record<string, unknown>) => (typeof row.repo === "string" ? [{ repo: row.repo, active: numberOf(row.active), tombstoned: numberOf(row.tombstoned) }] : [])),
				byKind: byKind.flatMap((row: Record<string, unknown>) => (isDocKind(row.kind) ? [{ kind: row.kind, count: numberOf(row.n) }] : [])),
				byTier: byTier.flatMap((row: Record<string, unknown>) => {
					const tier = numberOf(row.tier);
					return isDocTier(tier) ? [{ tier, count: numberOf(row.n) }] : [];
				}),
				lastIngestAt: lastIngest instanceof Date ? lastIngest.toISOString() : typeof lastIngest === "string" ? new Date(lastIngest).toISOString() : null,
				manifestVersion: version,
			};
		},
	};
}
