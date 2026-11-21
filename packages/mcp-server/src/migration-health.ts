/**
 * `migration_health` — read-only health of the index's boot migrations.
 *
 * Two independent records say what the schema should be:
 *
 *   1. **the pinned digests** — `index-store.migrations.digests.json`, the SHA-256 of
 *      every `MIGRATION_STEPS` entry's statements as they were committed
 *      (`scripts/migration-digests.ts`, the one algorithm);
 *   2. **the ledger** — `schema_migrations`, the versions `IndexStore.migrate()`
 *      recorded after each step committed.
 *
 * What the code says now (the steps' current text) can also be digested. So this
 * reports the three disagreements among them:
 *
 *   - **digest drift** — a step whose digest now differs from the pinned one (its
 *     applied text was edited), a step with no pinned digest (the fixture was not
 *     regenerated when the step landed), and a pinned digest whose step no longer
 *     exists (an applied migration was removed). Each is reported per fixture key
 *     with `key`, `expected` and `actual`;
 *   - **pending migrations** — applicable steps the ledger has not recorded yet,
 *     in application (version) order;
 *   - **unknown applied versions** — ledger rows no current step names, which
 *     `migrate()` will never run again because there is no step to run.
 *
 * This does not fix anything and does not run anything: it gathers the fixture,
 * the steps and the ledger rows, compares them, and names each disagreement.
 * The analysis here is pure — the gathering (the file read and the one `select`)
 * is `Substrate.migrationHealth`'s job — which is what lets the comparisons be
 * tested against constructed disagreements rather than against a database.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationOptIns, MigrationStep } from "./index-store.ts";

/** One digest disagreement, reported per fixture `key` (the step's version as a string). */
export interface MigrationDrift {
	key: string;
	/** The step's name, or `null` for a pinned digest whose step no longer exists. */
	name: string | null;
	/** The pinned digest from the fixture, or `null` when the step has none. */
	expected: string | null;
	/** The digest of the step's current text, or `null` when the step no longer exists. */
	actual: string | null;
	kind: "edited" | "missing_fixture_digest" | "unknown_step";
}

/** One applicable step the ledger has not recorded yet. */
export interface PendingMigration {
	version: number;
	name: string;
}

export interface MigrationHealthReport {
	/** True when no digest drifts and no applied version is unknown. Pending migrations do not affect this. */
	healthy: boolean;
	/** Every digest disagreement, ordered by numeric key. Empty with `unavailable` naming why the fixture was not read. */
	drift: MigrationDrift[];
	/** Applicable steps not yet in the ledger, in version (application) order. Empty when the ledger could not be read. */
	pending: PendingMigration[];
	/** Ledger versions no current step names, ascending. */
	unknown_applied: number[];
	/** Ledger versions, ascending. */
	applied_versions: number[];
	step_count: number;
	applied_count: number;
	pending_count: number;
	drift_count: number;
	/** Records that could not be read, so an empty `drift` is not mistaken for agreement. */
	unavailable: string[];
}

export interface MigrationHealthInputs {
	/** All steps, in application order; defaults to `MIGRATION_STEPS`. */
	steps?: ReadonlyArray<MigrationStep>;
	/** Pinned digests from `parseMigrationDigests`/`readMigrationDigests`; `null` when the fixture could not be read. */
	fixture: Readonly<Record<string, string>> | null;
	/** Ledger versions, or `null` when they could not be read. */
	appliedVersions: ReadonlyArray<number> | null;
	/** Which opt-in migrations are applicable; absent means every step is applicable. */
	optIns?: MigrationOptIns;
	/** Already-known unreadable records, kept on the report. */
	unavailable?: readonly string[];
}

/**
 * SHA-256 hex of a step's statements joined by a single newline. This is the same
 * definition as `stepDigest` in `scripts/migration-digests.ts` (split on `;`, each
 * trimmed, empty ones dropped — comments are NOT stripped, so any edit to an
 * applied step's text, whitespace included, changes its digest), re-declared here
 * because the server runs from this package and the script lives at the repo root.
 * `migration-health.test.ts` pins the two equal over every real step, so a change
 * to either fails loudly instead of silently reporting the wrong drift.
 */
export function migrationStepDigest(step: Pick<MigrationStep, "sql">): string {
	const statements = step.sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
	return createHash("sha256").update(statements.join("\n")).digest("hex");
}

/** The committed fixture, parsed and shape-checked: an object of version -> 64 hex characters. */
export function parseMigrationDigests(raw: unknown): Record<string, string> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("index-store.migrations.digests.json must be a JSON object");
	const fixture: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!/^\d+$/.test(key) || typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
			throw new Error(`index-store.migrations.digests.json: step ${key} must map to a lowercase sha256 hex string`);
		}
		fixture[key] = value;
	}
	return fixture;
}

/** The committed fixture, read from beside this module and shape-checked. Throws when it cannot be read. */
export function readMigrationDigests(): Record<string, string> {
	return parseMigrationDigests(JSON.parse(readFileSync(join(import.meta.dir, "index-store.migrations.digests.json"), "utf8")));
}

/**
 * Compare the steps, the pinned digests and the ledger rows. Pure: it reads
 * nothing but its arguments. A `null` fixture or ledger means that record could
 * not be read — the comparison it would have made is skipped and the gap is on
 * `unavailable`, never reported as agreement.
 */
export function analyzeMigrationHealth(inputs: MigrationHealthInputs): MigrationHealthReport {
	const steps = inputs.steps ?? [];
	const unavailable = [...(inputs.unavailable ?? [])];

	const drift: MigrationDrift[] = [];
	if (inputs.fixture === null) {
		unavailable.push("fixture: index-store.migrations.digests.json could not be read");
	} else {
		const seen = new Set<string>();
		for (const step of steps) {
			const key = String(step.version);
			seen.add(key);
			const expected = inputs.fixture[key] ?? null;
			const actual = migrationStepDigest(step);
			if (expected === null) drift.push({ key, name: step.name, expected: null, actual, kind: "missing_fixture_digest" });
			else if (expected !== actual) drift.push({ key, name: step.name, expected, actual, kind: "edited" });
		}
		for (const key of Object.keys(inputs.fixture)) {
			if (seen.has(key)) continue;
			drift.push({ key, name: null, expected: inputs.fixture[key] ?? null, actual: null, kind: "unknown_step" });
		}
		drift.sort((a, b) => Number(a.key) - Number(b.key));
	}

	const applied = inputs.appliedVersions === null ? null : [...new Set(inputs.appliedVersions.map(Number))].sort((a, b) => a - b);
	if (applied === null && !unavailable.some((entry) => entry.startsWith("index:"))) unavailable.push("index: schema_migrations could not be read");

	const stepVersions = new Set(steps.map((step) => step.version));
	const unknown_applied = applied === null ? [] : applied.filter((version) => !stepVersions.has(version));

	const pending: PendingMigration[] = [];
	if (applied !== null) {
		const appliedSet = new Set(applied);
		const optIns = inputs.optIns;
		const applicable = optIns === undefined ? steps : steps.filter((candidate) => candidate.optIn === undefined || optIns[candidate.optIn]);
		for (const step of [...applicable].sort((a, b) => a.version - b.version)) {
			if (!appliedSet.has(step.version)) pending.push({ version: step.version, name: step.name });
		}
	}

	return {
		healthy: drift.length === 0 && unknown_applied.length === 0,
		drift,
		pending,
		unknown_applied,
		applied_versions: applied ?? [],
		step_count: steps.length,
		applied_count: applied === null ? 0 : applied.length,
		pending_count: pending.length,
		drift_count: drift.length,
		unavailable,
	};
}

/** The report as a few lines of text, for the CLI and for a brief. */
export function formatMigrationHealth(report: MigrationHealthReport): string {
	const lines: string[] = [];
	lines.push(
		`migration health — ${report.healthy ? "healthy" : "unhealthy"}, ` +
			`${report.drift.length} digest drift, ${report.pending.length} pending, ${report.applied_versions.length} applied of ${report.step_count} steps`,
	);
	for (const entry of report.drift) {
		lines.push(
			`- [drift] key ${entry.key}${entry.name !== null ? ` (${entry.name})` : ""}: ${entry.kind} ` +
				`expected ${entry.expected ?? "none"}, actual ${entry.actual ?? "none"}`,
		);
	}
	for (const entry of report.pending) lines.push(`- [pending] step ${entry.version} (${entry.name})`);
	for (const version of report.unknown_applied) lines.push(`- [unknown-applied] version ${version} has no current step`);
	for (const missing of report.unavailable) lines.push(`- [info] not compared — ${missing}`);
	return lines.join("\n");
}
