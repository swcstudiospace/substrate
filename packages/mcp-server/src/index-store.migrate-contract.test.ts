/**
 * The migration contract (phase 55): what every `MIGRATION_STEPS` entry, present and future, must satisfy so the index
 * schema can evolve by expand-then-contract without a surprise on a database that already holds data. Offline: no
 * database, no network.
 *
 *   (a) every statement is idempotent (`… if not exists` / `drop … if exists`),
 *   (b) no destructive statement (DROP TABLE, DROP COLUMN, RENAME, ALTER COLUMN … TYPE, TRUNCATE, DELETE FROM),
 *   (c) the text of an applied step never changes: its digest is pinned in `index-store.migrations.digests.json`,
 *   (d) every table a step creates is archived (`ARCHIVE_TABLES`) or allowlisted with a reason,
 *   (e) a step from `FIRST_REVERSIBLE_VERSION` on declares `down` and `phase`, and its `down` only undoes what its own
 *       `up` creates.
 *
 * The rules are `checkMigrationSteps` and `digestViolations`, pure functions fed below with the real steps and with
 * synthetic good and bad lists, so each rule is shown to fire. A rule is never weakened to let a step pass: an exception
 * goes in an allowlist with its reason, and `checkMigrationSteps` rejects an allowlist entry that has none.
 *
 * Versions being 1..N contiguous and names being unique is `index-store.migrate.test.ts`'s check; it is not repeated here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	createdObjects,
	isAdditiveStatement,
	migrationDigests,
	normalizedStatements,
	stripSqlComments,
	stepDigest,
} from "../../../scripts/migration-digests.ts";
import { ARCHIVE_TABLES } from "./index-archive-spec.ts";
import { FIRST_REVERSIBLE_VERSION, MIGRATION_STEPS, type MigrationStep } from "./index-store.ts";

/** Reasons an exception to a rule is allowed, keyed by what the exception is for. Every value must be a non-empty sentence. */
export interface ContractAllowlists {
	/** Version -> why a non-idempotent statement is acceptable in that step. */
	idempotence: Readonly<Record<number, string>>;
	/** Version -> why a destructive statement is acceptable in that step. */
	destructive: Readonly<Record<number, string>>;
	/** Table name -> why it is not in `ARCHIVE_TABLES`. */
	tables: Readonly<Record<string, string>>;
}

/**
 * The exceptions for the real steps.
 *
 * - `idempotence`: none. Steps 1..33 are all `create … if not exists` or `add column if not exists`.
 * - `destructive`: none. The one destructive statement in the migrator, `drop index if exists memory_reviews_hash_idx`,
 *   lives in `IndexStore.migrate()` itself and is deliberately not a ledgered step.
 * - `tables`: `schema_migrations` is the ledger `migrate()` creates for itself (it is not a step, listed so a step that
 *   ever creates it is not flagged), `skills_registry` (step 17) is not in the index archive's closed table list
 *   (`index-archive-spec.ts`); archiving it is a separate change, and `planning_steering_audit` (step 33) is an opt-in,
 *   append-only audit table that is likewise not in that closed list. `worktrees` (step 36) is the worktree registry, which each
 *   host's next report rebuilds, so an archive of it would only restore stale paths.
 */
export const REAL_ALLOWLISTS: ContractAllowlists = {
	idempotence: {},
	destructive: {},
	tables: {
		schema_migrations: "the migration ledger that IndexStore.migrate() creates itself; it is not archive data",
		skills_registry: "step 17 predates the archive's closed table list and is not part of it; archiving it is a separate change",
		planning_steering_audit: "step 33 is an opt-in (steering-audit), append-only steering audit table; it is not part of the archive's closed table list and archiving it is a separate change",
		corpus_documents: "step 35 is the corpus manifest, rebuilt by re-running the corpus scan and ingest; it is not part of the archive's closed table list and archiving it is a separate change",
		worktrees: "step 36 is the worktree registry, rebuilt by the next report from each host; archiving stale paths would only restore them, and the closed table list stays as it is",
		planning_page_hashes: "step 39 holds the planning refresh's page hashes, rebuilt by the next planning scan (a missing row only re-ingests that page); it is not part of the archive's closed table list and archiving it is a separate change",
	},
};

/** What `ARCHIVE_TABLES` holds, by name. */
const ARCHIVE_TABLE_NAMES: readonly string[] = ARCHIVE_TABLES.map((spec) => spec.name);

const DESTRUCTIVE: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{ label: "DROP TABLE", pattern: /\bdrop table\b/ },
	{ label: "DROP COLUMN", pattern: /\bdrop column\b/ },
	{ label: "RENAME", pattern: /\brename\b/ },
	{ label: "ALTER COLUMN TYPE", pattern: /\balter column [\w.]+ (?:set data )?type\b/ },
	{ label: "TRUNCATE", pattern: /\btruncate\b/ },
	{ label: "DELETE FROM", pattern: /\bdelete from\b/ },
];

const IDEMPOTENT_OTHER =
	/^(?:create (?:extension|schema|sequence) if not exists [\w.]+|drop (?:table|index|view|sequence) if exists [\w.]+|alter table [\w.]+ drop column if exists [\w.]+)$/;

const DROP_TABLE = /^drop table if exists ([\w.]+)$/;
const DROP_INDEX = /^drop index if exists ([\w.]+)$/;
const DROP_COLUMN = /^alter table ([\w.]+) drop column if exists ([\w.]+)$/;

function snippet(statement: string): string {
	return statement.length > 80 ? `${statement.slice(0, 80)}…` : statement;
}

/** `create … if not exists`, `add column if not exists`, or `drop … if exists`: running it twice leaves the schema as running it once. */
function isIdempotentStatement(statement: string): boolean {
	return isAdditiveStatement(statement) || IDEMPOTENT_OTHER.test(statement);
}

/**
 * Every rule violation in `steps`, each one line `step <n> (<name>): <what>`, in step order then rule order (a, b, d, e).
 * Pure: it reads nothing but its arguments, and the empty list means the steps satisfy the contract.
 */
export function checkMigrationSteps(
	steps: ReadonlyArray<MigrationStep>,
	allow: ContractAllowlists = REAL_ALLOWLISTS,
	archiveTables: readonly string[] = ARCHIVE_TABLE_NAMES,
): string[] {
	const violations: string[] = [];
	for (const [kind, entries] of Object.entries(allow) as Array<[string, Readonly<Record<string, string>>]>) {
		for (const [key, reason] of Object.entries(entries)) {
			if (reason.trim().length === 0) violations.push(`allowlist entry ${kind} ${key} has no reason`);
		}
	}
	for (const step of steps) {
		const at = `step ${step.version} (${step.name})`;
		const upStatements = normalizedStatements(step.sql);
		if (upStatements.length === 0) violations.push(`${at}: has no statements`);

		// (a) idempotence
		if (allow.idempotence[step.version] === undefined) {
			for (const statement of upStatements) {
				if (!isIdempotentStatement(statement)) violations.push(`${at}: statement is not idempotent: ${snippet(statement)}`);
			}
		}

		// (b) destructive statements
		if (allow.destructive[step.version] === undefined) {
			for (const { label, pattern } of DESTRUCTIVE) {
				if (upStatements.some((statement) => pattern.test(statement))) violations.push(`${at}: destructive ${label} is not allowlisted`);
			}
		}

		// (d) every created table is archived or allowlisted
		const created = { tables: [] as string[], indexes: [] as string[], columns: [] as string[] };
		for (const statement of upStatements) {
			const objects = createdObjects(statement);
			created.tables.push(...objects.tables);
			created.indexes.push(...objects.indexes);
			created.columns.push(...objects.columns);
		}
		for (const table of created.tables) {
			if (!archiveTables.includes(table) && allow.tables[table] === undefined) {
				violations.push(`${at}: creates table ${table}, which is neither in ARCHIVE_TABLES nor allowlisted`);
			}
		}

		// (e) reversible-step convention
		const reversible = step.version >= FIRST_REVERSIBLE_VERSION;
		if (reversible && step.down === undefined) violations.push(`${at}: version ${step.version} is at or above ${FIRST_REVERSIBLE_VERSION}, so it must declare down`);
		if (reversible && step.phase === undefined) violations.push(`${at}: version ${step.version} is at or above ${FIRST_REVERSIBLE_VERSION}, so it must declare phase`);
		if (step.phase !== undefined && step.phase !== "expand" && step.phase !== "contract") {
			violations.push(`${at}: phase must be "expand" or "contract", got ${JSON.stringify(step.phase)}`);
		}
		if (step.down !== undefined) {
			const downStatements = normalizedStatements(step.down);
			if (downStatements.length === 0) violations.push(`${at}: down has no statements`);
			for (const statement of downStatements) {
				if (step.phase === "contract") {
					// A contract step removes something its `up` drops, so its down can only put it back.
					if (!isAdditiveStatement(statement)) violations.push(`${at}: a contract step's down must only restore (create … if not exists): ${snippet(statement)}`);
					continue;
				}
				const table = DROP_TABLE.exec(statement);
				const index = DROP_INDEX.exec(statement);
				const column = DROP_COLUMN.exec(statement);
				if (table) {
					if (!created.tables.includes(table[1] ?? "")) violations.push(`${at}: down drops ${table[1]}, which this step's up does not create`);
				} else if (index) {
					if (!created.indexes.includes(index[1] ?? "")) violations.push(`${at}: down drops ${index[1]}, which this step's up does not create`);
				} else if (column) {
					const name = `${column[1]}.${column[2]}`;
					if (!created.columns.includes(name)) violations.push(`${at}: down drops ${name}, which this step's up does not create`);
				} else {
					violations.push(`${at}: down is not a drop of an object this step creates: ${snippet(statement)}`);
				}
			}
		}
	}
	return violations;
}

/**
 * Where `steps` and the committed `fixture` of digests disagree. A step with no digest is reported like an edited one: a
 * new step lands together with the regenerated fixture (`bun scripts/migration-digests.ts`), so an empty or stale fixture
 * fails here. A digest for a step that no longer exists is reported too, since removing an applied step is also an edit.
 */
export function digestViolations(steps: ReadonlyArray<Pick<MigrationStep, "version" | "sql">>, fixture: Readonly<Record<string, string>>): string[] {
	const violations: string[] = [];
	for (const step of steps) {
		if (fixture[String(step.version)] !== stepDigest(step)) violations.push(`an applied migration is immutable: add a new step instead of editing step ${step.version}`);
	}
	const versions = new Set(steps.map((step) => String(step.version)));
	for (const key of Object.keys(fixture)) {
		if (!versions.has(key)) violations.push(`the digest fixture lists step ${key}, which is not in MIGRATION_STEPS: an applied migration is immutable`);
	}
	return violations;
}

/** The committed fixture, parsed and shape-checked: an object of version -> 64 hex characters. */
function loadFixture(): Record<string, string> {
	const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dir, "index-store.migrations.digests.json"), "utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("index-store.migrations.digests.json must be a JSON object");
	const fixture: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!/^\d+$/.test(key) || typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
			throw new Error(`index-store.migrations.digests.json: step ${key} must map to a lowercase sha256 hex string`);
		}
		fixture[key] = value;
	}
	return fixture;
}

function step(version: number, sql: string, extra: Partial<MigrationStep> = {}): MigrationStep {
	return { version, name: `s${version}`, sql, ...extra };
}

/** Allowlists for the synthetic lists: the given tables are exempt from the archive rule, nothing else is. */
function allowTables(...tables: string[]): ContractAllowlists {
	return { idempotence: {}, destructive: {}, tables: Object.fromEntries(tables.map((table) => [table, "synthetic test table"])) };
}

describe("the real MIGRATION_STEPS satisfy the contract", () => {
	test("idempotent, non-destructive, archived tables, and the reversible convention", () => {
		expect(checkMigrationSteps(MIGRATION_STEPS).join("\n")).toBe("");
	});

	test("every real step at or above the first reversible version (33, 34) declares down and phase, and the convention is also enforced through the synthetic lists below", () => {
		expect(FIRST_REVERSIBLE_VERSION).toBe(33);
		expect(MIGRATION_STEPS.filter((candidate) => candidate.version >= FIRST_REVERSIBLE_VERSION).every((candidate) => candidate.down !== undefined && candidate.phase !== undefined)).toBe(true);
	});

	test("the applied text of every step matches the committed digest fixture", () => {
		expect(digestViolations(MIGRATION_STEPS, loadFixture()).join("\n")).toBe("");
	});

	test("scripts/migration-digests.ts prints exactly the in-process digests, deterministically", () => {
		const script = join(import.meta.dir, "../../../scripts/migration-digests.ts");
		const first = Bun.spawnSync([process.execPath, script]);
		const second = Bun.spawnSync([process.execPath, script]);
		expect(first.exitCode).toBe(0);
		expect(first.stdout.toString()).toBe(second.stdout.toString());
		expect(JSON.parse(first.stdout.toString())).toEqual(migrationDigests(MIGRATION_STEPS));
	});
});

describe("digest rule", () => {
	const steps = [step(1, "create table if not exists a (id int)"), step(2, "create index if not exists a_idx on a (id)")];
	const fixture = migrationDigests(steps);

	test("a digest is sha256 of the statements joined by one newline, whitespace around a statement ignored", () => {
		expect(stepDigest(step(1, "  create table if not exists a (id int);  create index if not exists a_idx on a (id) ;"))).toBe(
			new Bun.CryptoHasher("sha256").update("create table if not exists a (id int)\ncreate index if not exists a_idx on a (id)").digest("hex"),
		);
	});

	test("matching fixture: no violation", () => {
		expect(digestViolations(steps, fixture)).toEqual([]);
	});

	test("an empty fixture fails for every step with the immutable-migration message", () => {
		expect(digestViolations(steps, {})).toEqual([
			"an applied migration is immutable: add a new step instead of editing step 1",
			"an applied migration is immutable: add a new step instead of editing step 2",
		]);
	});

	test("a fixture that lacks one version fails for that version only", () => {
		const { "2": _dropped, ...partial } = fixture;
		expect(digestViolations(steps, partial)).toEqual(["an applied migration is immutable: add a new step instead of editing step 2"]);
	});

	test("an edited applied step fails", () => {
		const edited = [step(1, "create table if not exists a (id bigint)"), steps[1] as MigrationStep];
		expect(digestViolations(edited, fixture)).toEqual(["an applied migration is immutable: add a new step instead of editing step 1"]);
	});

	test("a removed step still has a digest in the fixture and fails", () => {
		expect(digestViolations([steps[0] as MigrationStep], fixture)).toEqual([
			"the digest fixture lists step 2, which is not in MIGRATION_STEPS: an applied migration is immutable",
		]);
	});
});

describe("rule (a): idempotence", () => {
	test("the idempotent forms pass", () => {
		const good = [
			step(1, "create table if not exists a (id int)"),
			step(2, "create unique index if not exists a_idx on a (id)"),
			step(3, "alter table a add column if not exists b int not null default 0, add column if not exists c text"),
		];
		expect(checkMigrationSteps(good, allowTables("a"))).toEqual([]);
	});

	test("create table without if not exists is reported with its text", () => {
		expect(checkMigrationSteps([step(1, "create table a (id int)")], allowTables("a"))).toEqual(["step 1 (s1): statement is not idempotent: create table a (id int)"]);
	});

	test("add column without if not exists, and a NOT NULL column without a default, are reported", () => {
		expect(checkMigrationSteps([step(1, "alter table a add column b int")], allowTables("a"))).toEqual(["step 1 (s1): statement is not idempotent: alter table a add column b int"]);
		expect(checkMigrationSteps([step(2, "alter table a add column if not exists b int not null")], allowTables("a"))).toEqual([
			"step 2 (s2): statement is not idempotent: alter table a add column if not exists b int not null",
		]);
	});

	test("a comment's words do not count, a second non-idempotent statement does", () => {
		const sql = "-- create table a (id int);\ncreate table if not exists a (id int);\ncreate index a_idx on a (id)";
		expect(checkMigrationSteps([step(1, sql)], allowTables("a"))).toEqual(["step 1 (s1): statement is not idempotent: create index a_idx on a (id)"]);
	});

	test("an allowlisted version is exempt from this rule only", () => {
		const allow: ContractAllowlists = { idempotence: { 1: "one-off, reviewed" }, destructive: {}, tables: { a: "synthetic" } };
		expect(checkMigrationSteps([step(1, "create table a (id int)")], allow)).toEqual([]);
	});

	test("an allowlist entry without a reason is itself a violation", () => {
		const allow: ContractAllowlists = { idempotence: { 1: "  " }, destructive: {}, tables: {} };
		expect(checkMigrationSteps([], allow)).toEqual(["allowlist entry idempotence 1 has no reason"]);
	});
});

describe("rule (b): no destructive statement", () => {
	const cases: Array<[string, string, string[]]> = [
		["DROP TABLE", "drop table if exists a", ["step 1 (s1): destructive DROP TABLE is not allowlisted"]],
		["DROP COLUMN", "alter table a drop column if exists b", ["step 1 (s1): destructive DROP COLUMN is not allowlisted"]],
		["RENAME", "alter table a rename to b", ["step 1 (s1): statement is not idempotent: alter table a rename to b", "step 1 (s1): destructive RENAME is not allowlisted"]],
		[
			"ALTER COLUMN TYPE",
			"alter table a alter column b type text",
			["step 1 (s1): statement is not idempotent: alter table a alter column b type text", "step 1 (s1): destructive ALTER COLUMN TYPE is not allowlisted"],
		],
		["TRUNCATE", "truncate a", ["step 1 (s1): statement is not idempotent: truncate a", "step 1 (s1): destructive TRUNCATE is not allowlisted"]],
		["DELETE FROM", "delete from a", ["step 1 (s1): statement is not idempotent: delete from a", "step 1 (s1): destructive DELETE FROM is not allowlisted"]],
	];
	for (const [label, sql, expected] of cases) {
		test(`${label} is reported`, () => {
			expect(checkMigrationSteps([step(1, sql)], allowTables("a"))).toEqual(expected);
		});
	}

	test("a foreign key's ON DELETE CASCADE is not a DELETE FROM", () => {
		expect(checkMigrationSteps([step(1, "create table if not exists b (a_id int references a(id) on delete cascade)")], allowTables("b"))).toEqual([]);
	});

	test("an allowlisted version is exempt from this rule only", () => {
		const allow: ContractAllowlists = { idempotence: {}, destructive: { 1: "contract step reviewed in phase 99" }, tables: {} };
		expect(checkMigrationSteps([step(1, "drop table if exists a")], allow)).toEqual([]);
	});
});

describe("stripSqlComments is quote-aware", () => {
	test("comments are replaced by a space", () => {
		expect(stripSqlComments("a -- c\nb /* d */ e")).toBe("a  \nb   e");
	});

	test("a marker inside a single-quoted string is text", () => {
		expect(stripSqlComments("default '--' x")).toBe("default '--' x");
		expect(stripSqlComments("default '/* y */' x")).toBe("default '/* y */' x");
	});

	test("a doubled quote does not end the string", () => {
		expect(stripSqlComments("'it''s -- here' -- gone")).toBe("'it''s -- here'  ");
	});

	test("a backslash escapes only in an E string", () => {
		expect(stripSqlComments("E'a\\'--b' -- gone")).toBe("E'a\\'--b'  ");
		expect(stripSqlComments("'a\\' -- gone")).toBe("'a\\'  ");
	});

	test("a marker inside a double-quoted identifier is text", () => {
		expect(stripSqlComments('select "a--b", "c/*d" -- gone')).toBe('select "a--b", "c/*d"  ');
	});

	test("a marker inside a dollar-quoted body is text, for $$ and $tag$", () => {
		expect(stripSqlComments("do $$ -- keep\n$$ -- gone")).toBe("do $$ -- keep\n$$  ");
		expect(stripSqlComments("do $fn$ /* keep */ $$ $fn$ /* gone */")).toBe("do $fn$ /* keep */ $$ $fn$  ");
	});

	test("a positional parameter is not a dollar quote", () => {
		expect(stripSqlComments("select $1 -- gone\n, 'x'")).toBe("select $1  \n, 'x'");
	});

	test("a quote inside a comment opens no string", () => {
		expect(stripSqlComments("-- don't\nselect 1 /* it's */ ; select 2")).toBe(" \nselect 1   ; select 2");
	});

	test("an unterminated string or block comment is kept to the end", () => {
		expect(stripSqlComments("select 'a -- b")).toBe("select 'a -- b");
		expect(stripSqlComments("select 1 /* open ; delete from a")).toBe("select 1 /* open ; delete from a");
	});

	test("a quoted '--' no longer hides a following destructive statement (the real-world bypass)", () => {
		const sql = "alter table graph_index add column if not exists label text default '--'; delete from memory_entries";
		expect(normalizedStatements(sql)).toEqual([
			"alter table graph_index add column if not exists label text default ' '",
			"delete from memory_entries",
		]);
		const problems = checkMigrationSteps([step(1, sql)], allowTables("graph_index"));
		expect(problems).toContain("step 1 (s1): destructive DELETE FROM is not allowlisted");
	});

	test("a ';' inside a string default is not a statement boundary, and the statement stays additive", () => {
		const sql = "alter table graph_index add column if not exists label text default '--; pending'";
		expect(normalizedStatements(sql)).toEqual(["alter table graph_index add column if not exists label text default ' '"]);
		expect(checkMigrationSteps([step(1, sql)], allowTables("graph_index"))).toEqual([]);
	});

	test("a destructive word inside a string default is not a destructive statement", () => {
		const sql = "alter table graph_index add column if not exists label text default '-- rename', add column if not exists note text default 'drop table x; truncate y; delete from z'";
		expect(normalizedStatements(sql)).toHaveLength(1);
		expect(checkMigrationSteps([step(1, sql)], allowTables("graph_index"))).toEqual([]);
	});

	test("a ';' inside a dollar-quoted body does not split, and the body is still checked as code", () => {
		const sql = "do $$ begin delete from a; raise notice 'x'; end $$";
		expect(normalizedStatements(sql)).toEqual(["do $$ begin delete from a; raise notice 'x'; end $$"]);
		expect(checkMigrationSteps([step(1, sql)], allowTables("a"))).toContain("step 1 (s1): destructive DELETE FROM is not allowlisted");
	});

	test("a doubled quote and an E-string escape stay inside the literal when splitting", () => {
		expect(normalizedStatements("select 'it''s; fine'; select 2")).toEqual(["select ' '", "select 2"]);
		expect(normalizedStatements("select E'a\\';b'; select 2")).toEqual(["select e' '", "select 2"]);
	});

	test("an unterminated string is not masked, so the analysis sees the rest", () => {
		expect(normalizedStatements("select 'a; delete from t")).toEqual(["select 'a", "delete from t"]);
	});

	test("the digest still splits on every ';' and is unaffected by the analysis reader", () => {
		expect(stepDigest(step(1, "select '--; pending'"))).toBe(new Bun.CryptoHasher("sha256").update("select '--\npending'").digest("hex"));
	});
});

describe("rule (d): created tables are archived or allowlisted", () => {
	test("an unarchived, unlisted table is reported", () => {
		expect(checkMigrationSteps([step(1, "create table if not exists rogue (id int)")])).toEqual([
			"step 1 (s1): creates table rogue, which is neither in ARCHIVE_TABLES nor allowlisted",
		]);
	});

	test("an ARCHIVE_TABLES table and an allowlisted table pass", () => {
		expect(checkMigrationSteps([step(1, "create table if not exists graph_index (id int)"), step(2, "create table if not exists skills_registry (id int)")])).toEqual([]);
	});

	test("the real allowlist names no table that the archive already covers", () => {
		for (const table of Object.keys(REAL_ALLOWLISTS.tables)) expect(ARCHIVE_TABLE_NAMES).not.toContain(table);
	});
});

describe("rule (e): the reversible-step convention", () => {
	const good = step(33, "create table if not exists t (id int); create index if not exists t_idx on t (id); alter table graph_index add column if not exists x int", {
		phase: "expand",
		down: "alter table graph_index drop column if exists x; drop index if exists t_idx; drop table if exists t",
	});

	test("a step at the first reversible version with both fields and a matching down passes", () => {
		expect(checkMigrationSteps([good], allowTables("t"))).toEqual([]);
	});

	test("a step below the first reversible version needs neither field", () => {
		expect(checkMigrationSteps([step(32, "create index if not exists i on graph_index (repo)")])).toEqual([]);
	});

	test("a step at the first reversible version without down and phase is reported for both", () => {
		expect(checkMigrationSteps([step(33, "create index if not exists i on graph_index (repo)")])).toEqual([
			"step 33 (s33): version 33 is at or above 33, so it must declare down",
			"step 33 (s33): version 33 is at or above 33, so it must declare phase",
		]);
	});

	test("an unknown phase is reported", () => {
		const bad = { ...good, phase: "later" } as unknown as MigrationStep;
		expect(checkMigrationSteps([bad], allowTables("t"))).toEqual(['step 33 (s33): phase must be "expand" or "contract", got "later"']);
	});

	test("a down that drops an object the up does not create is reported, for a table, an index and a column", () => {
		const down = "drop table if exists other; drop index if exists other_idx; alter table graph_index drop column if exists y";
		expect(checkMigrationSteps([{ ...good, down }], allowTables("t"))).toEqual([
			"step 33 (s33): down drops other, which this step's up does not create",
			"step 33 (s33): down drops other_idx, which this step's up does not create",
			"step 33 (s33): down drops graph_index.y, which this step's up does not create",
		]);
	});

	test("a down that is not a drop is reported, and cascade is not accepted", () => {
		expect(checkMigrationSteps([{ ...good, down: "delete from t" }], allowTables("t"))).toEqual(["step 33 (s33): down is not a drop of an object this step creates: delete from t"]);
		expect(checkMigrationSteps([{ ...good, down: "drop table if exists t cascade" }], allowTables("t"))).toEqual([
			"step 33 (s33): down is not a drop of an object this step creates: drop table if exists t cascade",
		]);
	});

	test("a down on a step below the first reversible version is checked too", () => {
		expect(checkMigrationSteps([step(5, "create index if not exists i on graph_index (repo)", { down: "drop index if exists j" })])).toEqual([
			"step 5 (s5): down drops j, which this step's up does not create",
		]);
	});

	test("a contract step is allowed destructive statements only when allowlisted, and its down must only restore", () => {
		const contract = step(34, "drop table if exists t", { phase: "contract", down: "create table if not exists t (id int)" });
		expect(checkMigrationSteps([contract], allowTables("t"))).toEqual(["step 34 (s34): destructive DROP TABLE is not allowlisted"]);
		const allow: ContractAllowlists = { idempotence: {}, destructive: { 34: "t is unused since the previous release" }, tables: { t: "synthetic" } };
		expect(checkMigrationSteps([contract], allow)).toEqual([]);
		expect(checkMigrationSteps([{ ...contract, down: "drop table if exists t" }], allow)).toEqual([
			"step 34 (s34): a contract step's down must only restore (create … if not exists): drop table if exists t",
		]);
	});
});
