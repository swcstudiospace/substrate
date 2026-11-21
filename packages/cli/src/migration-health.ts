/**
 * `substrate index migrate-health [--json]` — the CLI mirror of the
 * `migration_health` MCP tool (see `packages/mcp-server/src/migration-health.ts`).
 *
 * Digest drift is computed offline from `MIGRATION_STEPS` and the committed
 * `index-store.migrations.digests.json`, so it always runs. Pending migrations
 * need the ledger, which is read read-only from `SUBSTRATE_PG_URL` (the env
 * name `loadConfig` reads the index URL from); without it the pending section
 * is reported as not compared rather than guessed.
 *
 * Every step is treated as applicable here: the CLI has no steering
 * opt-in config, so the server's `migration_health` (which knows
 * `migrationOptIns`) is the authority when an opt-in step matters.
 *
 * Exit codes: 0 no digest drift, 1 digest drift, 2 usage error.
 */
import { SQL } from "bun";
import { MIGRATION_STEPS } from "../../mcp-server/src/index-store.ts";
import { analyzeMigrationHealth, formatMigrationHealth, readMigrationDigests } from "../../mcp-server/src/migration-health.ts";

export const MIGRATION_HEALTH_USAGE =
	"usage: substrate index migrate-health [--json]\n" +
	"  read-only: digest drift per key plus the pending migrations in application order;\n" +
	"  pending is read read-only from SUBSTRATE_PG_URL when set\n" +
	"exit: 0 no digest drift, 1 digest drift, 2 usage\n";

export interface MigrationHealthDeps {
	env: Record<string, string | undefined>;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seam: supplies the ledger rows. Default opens `SUBSTRATE_PG_URL` directly. */
	readApplied?: () => Promise<number[] | null>;
	/** Test seam: supplies the pinned digests. Default reads the committed fixture. */
	readFixture?: () => Record<string, string>;
}

async function readAppliedFromUrl(url: string): Promise<number[] | null> {
	const sql = new SQL(url);
	try {
		const rows = (await sql`select version from schema_migrations order by version ascending`) as Array<{ version: number | string }>;
		return rows.map((row) => Number(row.version));
	} catch {
		return null;
	} finally {
		await sql.end().catch(() => undefined);
	}
}

export async function runMigrationHealth(argv: string[], deps: MigrationHealthDeps): Promise<number> {
	let json = false;
	for (const word of argv) {
		if (word === "--json") json = true;
		else {
			deps.err(`${MIGRATION_HEALTH_USAGE}unknown argument: ${word}\n`);
			return 2;
		}
	}

	const unavailable: string[] = [];
	let fixture: Record<string, string> | null = null;
	try {
		fixture = deps.readFixture !== undefined ? deps.readFixture() : readMigrationDigests();
	} catch {
		// `analyzeMigrationHealth` records the unreadable fixture on `unavailable`.
		fixture = null;
	}

	let applied: number[] | null = null;
	if (deps.readApplied !== undefined) {
		applied = await deps.readApplied();
	} else if (deps.env.SUBSTRATE_PG_URL?.trim()) {
		applied = await readAppliedFromUrl(deps.env.SUBSTRATE_PG_URL.trim());
	} else {
		unavailable.push("index: SUBSTRATE_PG_URL is unset");
	}

	const report = analyzeMigrationHealth({ steps: MIGRATION_STEPS, fixture, appliedVersions: applied, unavailable });
	const text = json ? JSON.stringify(report, null, 2) : formatMigrationHealth(report);
	deps.out(`${text}\n`);
	return report.drift.length > 0 ? 1 : 0;
}
