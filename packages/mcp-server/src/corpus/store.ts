/**
 * The corpus manifest (v1.7 phase 63): one Postgres row per `(repo, path)` the bulk ingest has seen, behind an interface so
 * the planner and the ingest run against a fake in tests.
 *
 * A row says which version of a document the docs plane holds (`sha256`) and under which plane document id. `manifest_seq`
 * comes from the table's own identity sequence and every write that changes a row takes the next value, so
 * `manifestVersion()` (the maximum) only grows; nothing deletes a row, a removal is a `tombstoned` state.
 */
import type { SQL } from "bun";
import { isCorpusSource, isDocKind, isDocTier, type CorpusSource, type CorpusStatusResponse, type DocKind, type DocTier } from "@substrate/corpus";

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
	/** The repo-relative path of the same repository that replaces this document, from its `superseded-by` marker; null when there is none. */
	supersededBy: string | null;
	/** ISO time the current content reached the plane (`ingested_at`, else `updated_at`): a metadata refresh does not move it. Null when the database gave neither. */
	ingestedAt: string | null;
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
	supersededBy?: string | undefined;
	documentId: string;
}

/** What `refreshMetadata` writes: the descriptive columns of a document whose bytes the manifest already holds. */
export interface RefreshedMetadata {
	repo: string;
	path: string;
	sha256: string;
	kind: DocKind;
	tier: DocTier;
	source: CorpusSource;
	commit?: string | undefined;
	supersededBy?: string | undefined;
}

/** What the Merkle root covers of one document. */
export interface ManifestLeaf {
	repo: string;
	path: string;
	sha256: string;
}

/** The ACTIVE rows' leaves and the manifest version they were read at, from one consistent read. */
export interface ActiveLeaves {
	manifestVersion: number;
	/** At most `limit` leaves, in no particular order. */
	leaves: ManifestLeaf[];
	/** True when more than `limit` rows are active: `leaves` is a prefix, so no root may be made from it. */
	truncated: boolean;
}

/** `status()` without the protocol member the route adds. */
export type CorpusStatusSummary = Omit<CorpusStatusResponse, "protocol">;

export interface CorpusStore {
	/** Every row, any state, whose repo is in `repos`. The planner applies the coverage and tier limits itself. */
	rowsForRepos(repos: readonly string[]): Promise<ManifestRow[]>;
	rowFor(repo: string, path: string): Promise<ManifestRow | null>;
	/** Upserts the row as `active` under the given plane document id and takes the next `manifest_seq`. */
	recordIngested(row: RecordedDocument): Promise<void>;
	/**
	 * Refreshes `kind`, `tier`, `source` and `commit` of the ACTIVE row at this sha256 and takes the next `manifest_seq`; the
	 * plane document is untouched. False when there is no active row at that sha256 (it changed or was removed meanwhile).
	 */
	refreshMetadata(row: RefreshedMetadata): Promise<boolean>;
	/** Marks an active row `tombstoned`; false when there was no active row, so a repeat is a no-op. */
	markTombstoned(repo: string, path: string): Promise<boolean>;
	/** How many ACTIVE rows hold this plane document id. */
	activeReferences(documentId: string): Promise<number>;
	/**
	 * Up to `limit` ACTIVE rows ordered by `(repo, path)`, for the supersession and authority index. A bound, not a page: the
	 * reader treats a document it never saw as unflagged, so a cap can only cost a flag, never invent one.
	 */
	activeRows(limit: number): Promise<ManifestRow[]>;
	/**
	 * The leaves of the ACTIVE rows (at most `limit`, `truncated` when there are more) and the manifest version of the very read
	 * that returned them, so a root made from them names the version it covers.
	 */
	activeLeaves(limit: number): Promise<ActiveLeaves>;
	status(): Promise<CorpusStatusSummary>;
	manifestVersion(): Promise<number>;
}

/** The most repositories `status()` lists, ordered by name, so a reply stays bounded. */
export const STATUS_MAX_REPOS = 1000;

function numberOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** An ISO time from a database timestamp (a Date or a string); null for anything else or an unparseable value. */
function isoOf(value: unknown): string | null {
	const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
	return at === null || Number.isNaN(at.getTime()) ? null : at.toISOString();
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
		supersededBy: typeof record.superseded_by === "string" && record.superseded_by.length > 0 ? record.superseded_by : null,
		ingestedAt: isoOf(record.ingested_at) ?? isoOf(record.updated_at),
	};
}

/** The Bun SQL adapter over `corpus_documents` (migration step 35). */
export function bunCorpusStore(sql: SQL): CorpusStore {
	async function manifestVersion(): Promise<number> {
		const rows = await sql`select coalesce(max(manifest_seq), 0)::text as version from corpus_documents`;
		return numberOf(rows[0]?.version);
	}
	return {
		async rowsForRepos(repos: readonly string[]): Promise<ManifestRow[]> {
			if (repos.length === 0) return [];
			// `in ${sql(array)}` is the form Bun's SQL expands to a value list; an array passed to `any()` is malformed.
			const rows: Array<Record<string, unknown>> = await sql`select * from corpus_documents where repo in ${sql([...repos])} order by repo, path`;
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
		async refreshMetadata(row: RefreshedMetadata): Promise<boolean> {
			const rows = await sql`
				update corpus_documents
				set kind = ${row.kind},
					tier = ${row.tier},
					source = ${row.source},
					commit_sha = ${row.commit ?? null},
					superseded_by = ${row.supersededBy ?? null},
					updated_at = now(),
					manifest_seq = nextval(pg_get_serial_sequence('corpus_documents', 'manifest_seq'))
				where repo = ${row.repo} and path = ${row.path} and state = 'active' and sha256 = ${row.sha256}
				returning 1 as changed`;
			return rows.length === 1;
		},
		async recordIngested(row: RecordedDocument): Promise<void> {
			await sql`
				insert into corpus_documents (repo, path, kind, tier, sha256, bytes, source, commit_sha, superseded_by, state, docs_document_id, ingested_at, tombstoned_at, updated_at)
				values (${row.repo}, ${row.path}, ${row.kind}, ${row.tier}, ${row.sha256}, ${row.bytes}, ${row.source}, ${row.commit ?? null}, ${row.supersededBy ?? null}, 'active', ${row.documentId}, now(), null, now())
				on conflict (repo, path) do update set
					kind = excluded.kind,
					tier = excluded.tier,
					sha256 = excluded.sha256,
					bytes = excluded.bytes,
					source = excluded.source,
					commit_sha = excluded.commit_sha,
					superseded_by = excluded.superseded_by,
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
		async activeRows(limit: number): Promise<ManifestRow[]> {
			const rows: Array<Record<string, unknown>> = await sql`select * from corpus_documents where state = 'active' order by repo, path limit ${limit}`;
			return rows.flatMap((row) => {
				const parsed = toManifestRow(row);
				return parsed === null ? [] : [parsed];
			});
		},
		manifestVersion,
		async activeLeaves(limit: number): Promise<ActiveLeaves> {
			// One statement, so the version and the rows come from one snapshot. The left join keeps the version when no row is active.
			const rows: Array<Record<string, unknown>> = await sql`
				select v.version::text as version, d.repo, d.path, d.sha256
				from (select coalesce(max(manifest_seq), 0) as version from corpus_documents) v
				left join (select repo, path, sha256 from corpus_documents where state = 'active' limit ${limit + 1}) d on true`;
			const manifestVersion = numberOf(rows[0]?.version);
			const leaves = rows.flatMap((row) => (typeof row.repo === "string" && typeof row.path === "string" && typeof row.sha256 === "string" ? [{ repo: row.repo, path: row.path, sha256: row.sha256 }] : []));
			return { manifestVersion, leaves: leaves.slice(0, limit), truncated: leaves.length > limit };
		},
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
