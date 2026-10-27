#!/usr/bin/env bun
/**
 * Digests of the index's boot migration steps, and the small SQL readers the migration contract shares.
 *
 *   bun scripts/migration-digests.ts > packages/mcp-server/src/index-store.migrations.digests.json
 *
 * Prints one JSON object on stdout: `{"<version>": "<sha256 hex>"}` for every step in `MIGRATION_STEPS`, where the digest is
 * the SHA-256 of the step's statements joined by a single newline (`stepDigest`). It reads no database, no environment
 * and no file: the output is a pure function of the step list, so it is deterministic.
 *
 * Why it exists: a database stamps a version in `schema_migrations` only after that step's statements commit, so a step that
 * was applied is never run again. Editing its text changes nothing on a database that has it and a different schema on a
 * fresh one. `index-store.migrate-contract.test.ts` compares these digests with the committed fixture
 * `packages/mcp-server/src/index-store.migrations.digests.json` and fails when an applied step was edited, or when a new
 * step has no digest yet. Adding a step is therefore two edits in one commit: the step, and the regenerated fixture.
 */
import { createHash } from "node:crypto";
import { MIGRATION_STEPS, type MigrationStep } from "../packages/mcp-server/src/index-store.ts";

/**
 * The statements of one step as the digest sees them: split on `;`, each trimmed, empty ones dropped. Comments are NOT
 * stripped, so any edit to an applied step's text, whitespace included, changes its digest.
 */
export function statementsOf(sql: string): string[] {
	return sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/** SHA-256 hex of the step's statements joined by a single newline. The one definition; the script and the test both call it. */
export function stepDigest(step: Pick<MigrationStep, "sql">): string {
	return createHash("sha256").update(statementsOf(step.sql).join("\n")).digest("hex");
}

/** Every step's digest keyed by version. Integer-like keys serialise in ascending order. */
export function migrationDigests(steps: ReadonlyArray<Pick<MigrationStep, "version" | "sql">>): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const step of steps) digests[String(step.version)] = stepDigest(step);
	return digests;
}

/**
 * `sql` without `--` line comments and C-style block comments, each replaced by one space. Comment markers inside a
 * single-quoted string (`''` is an escaped quote; `\` escapes in an `E'…'` string), a double-quoted identifier or a
 * dollar-quoted body (`$$…$$`, `$tag$…$tag$`) are text, not comments, and a quote inside a comment opens nothing. An
 * unterminated string, quoted identifier or block comment is kept verbatim to the end, so the analysis sees all of it. The
 * digest (`statementsOf`) does not call this, so it cannot change any step's digest.
 */
export function stripSqlComments(sql: string): string {
	const isIdent = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const char = sql[i] as string;
		const next = sql[i + 1];
		if (char === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			out += " ";
			i = end === -1 ? sql.length : end;
		} else if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end === -1) {
				out += sql.slice(i);
				i = sql.length;
			} else {
				out += " ";
				i = end + 2;
			}
		} else if (char === "'" || char === '"') {
			const backslashEscapes = char === "'" && (sql[i - 1] === "E" || sql[i - 1] === "e") && !isIdent(sql[i - 2]);
			let j = i + 1;
			while (j < sql.length) {
				if (backslashEscapes && sql[j] === "\\") j += 2;
				else if (sql[j] === char && sql[j + 1] === char) j += 2;
				else if (sql[j] === char) break;
				else j += 1;
			}
			const stop = Math.min(j + 1, sql.length);
			out += sql.slice(i, stop);
			i = stop;
		} else if (char === "$" && !isIdent(sql[i - 1])) {
			const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
			if (tag === undefined) {
				out += char;
				i += 1;
			} else {
				const end = sql.indexOf(tag, i + tag.length);
				const stop = end === -1 ? sql.length : end + tag.length;
				out += sql.slice(i, stop);
				i = stop;
			}
		} else {
			out += char;
			i += 1;
		}
	}
	return out;
}

/** The statements of `sql` for analysis: comments removed, whitespace collapsed, lower-cased, no trailing `;`. */
export function normalizedStatements(sql: string): string[] {
	return statementsOf(stripSqlComments(sql)).map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase());
}

/** Splits at commas that are not inside parentheses: the clauses of one `alter table`. */
export function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (char === "(") depth += 1;
		else if (char === ")") depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts.filter((part) => part.length > 0);
}

const CREATE_TABLE = /^create table if not exists ([\w.]+) \(/;
const CREATE_INDEX = /^create (?:unique )?index if not exists ([\w.]+) on ([\w.]+)/;
const ALTER_TABLE = /^alter table ([\w.]+) (.+)$/;
const ADD_COLUMN = /^add column if not exists ([\w.]+) /;

/** What a normalised `alter table … add column if not exists …` adds, or `null` when any clause is not exactly that. */
export function addedColumns(statement: string): { table: string; columns: string[] } | null {
	const match = ALTER_TABLE.exec(statement);
	if (!match) return null;
	const columns: string[] = [];
	for (const clause of splitTopLevel(match[2] ?? "")) {
		const column = ADD_COLUMN.exec(`${clause} `);
		if (!column) return null;
		// A NOT NULL column without a default fails every insert an older release makes, which is not additive.
		if (/\bnot null\b/.test(clause) && !/\bdefault\b/.test(clause)) return null;
		columns.push(column[1] ?? "");
	}
	return { table: match[1] ?? "", columns };
}

/**
 * True for the only statements an older release survives: `create table if not exists`, `create [unique] index if not
 * exists`, and `alter table … add column if not exists` (a NOT NULL column carries a default). `statement` is one entry of
 * `normalizedStatements`.
 */
export function isAdditiveStatement(statement: string): boolean {
	return CREATE_TABLE.test(statement) || CREATE_INDEX.test(statement) || addedColumns(statement) !== null;
}

/** The tables, indexes and `table.column` pairs a normalised statement creates. */
export function createdObjects(statement: string): { tables: string[]; indexes: string[]; columns: string[] } {
	const created = { tables: [] as string[], indexes: [] as string[], columns: [] as string[] };
	const table = CREATE_TABLE.exec(statement);
	if (table) created.tables.push(table[1] ?? "");
	const index = CREATE_INDEX.exec(statement);
	if (index) created.indexes.push(index[1] ?? "");
	const added = addedColumns(statement);
	if (added) for (const column of added.columns) created.columns.push(`${added.table}.${column}`);
	return created;
}

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(migrationDigests(MIGRATION_STEPS), null, "\t")}\n`);
}
