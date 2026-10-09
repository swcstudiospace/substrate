#!/usr/bin/env bun
/**
 * Phase-close gate for Phase 17 (event vocabulary and audit policy).
 *
 * Run as `bun run check:phase-close` (or `bun scripts/phase-close-check.ts`).
 * It proves `EVENT_KINDS` is unchanged against the v1.2 baseline and
 * `SURFACES` equals the baseline plus the one reviewed host-job surface
 * `substrate`, so every later phase can re-run it to catch a vocabulary
 * change in plain verification.
 *
 * Steps: run the four lock tests, read the `EVENT_KINDS`/`SURFACES` blocks
 * from `git show <BASELINE>:packages/mcp-server/src/types.ts` and diff them
 * against the imported values. Git is read-only: fixed argv
 * `git --no-optional-locks show` with `GIT_OPTIONAL_LOCKS=0`, dropped
 * `GIT_DIR`/`GIT_WORK_TREE`, and a timeout; it never fetches, checks out,
 * or refreshes the index.
 *
 * Exit codes: 0 pass, 1 check failed (a lock test failed or a diff is
 * non-empty), 2 precondition refused (a lock file is missing or the baseline
 * object is absent, e.g. in a shallow clone).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KINDS, SURFACES } from "../packages/mcp-server/src/types.ts";

/** The v1.2 baseline commit `EVENT_KINDS` is diffed against. */
export const BASELINE = "ab62c91";

/** Lock tests the gate runs; `store-lock.test.ts` covers this script itself. */
export const LOCK_TESTS = [
	"packages/mcp-server/src/store-lock.test.ts",
	"packages/mcp-server/src/vocabulary-lock.test.ts",
	"packages/mcp-server/src/event-sources.test.ts",
	"packages/audit/src/policy.test.ts",
] as const;

const ROOT = join(import.meta.dir, "..");
const TYPES_PATH = "packages/mcp-server/src/types.ts";
const GIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 120_000;

/**
 * Extract the quoted kinds from an `EVENT_KINDS = [ ... ]` block in file
 * text. Returns the kinds in order, or null when the block is absent.
 */
export function parseEventKinds(text: string): string[] | null {
	const block = text.match(/(?<![A-Z_])EVENT_KINDS\s*=\s*\[(.*?)\]/s);
	if (!block) return null;
	const body = block[1] ?? "";
	const kinds: string[] = [];
	for (const match of body.matchAll(/"([^"]+)"/g)) kinds.push(match[1] as string);
	return kinds;
}
/**
 * Extract the quoted surfaces from a `SURFACES = [ ... ]` block in file
 * text, expanding the `...SWARM_SURFACES` spread from the `SWARM_SURFACES`
 * block in the same text. Returns the surfaces in order, or null when the
 * `SURFACES` block is absent.
 */
export function parseSurfaces(text: string): string[] | null {
	const block = text.match(/(?<![A-Z_])SURFACES\s*=\s*\[(.*?)\]/s);
	if (!block || block[1] === undefined) return null;
	const body = block[1];
	const swarm = text.match(/SWARM_SURFACES\s*=\s*\[(.*?)\]/s);
	const swarmSurfaces: string[] = [];
	if (swarm && swarm[1] !== undefined) {
		for (const match of swarm[1].matchAll(/"([^"]+)"/g)) swarmSurfaces.push(match[1] as string);
	}
	const surfaces: string[] = [];
	for (const match of body.matchAll(/\.\.\.\s*SWARM_SURFACES|"([^"]+)"/g)) {
		if (match[0].startsWith("...")) surfaces.push(...swarmSurfaces);
		else if (match[1] !== undefined) surfaces.push(match[1]);
	}
	return surfaces;
}

/**
 * Index-level diff of baseline kinds against current kinds: one line per
 * changed, added, or removed index. Empty when the two lists are equal.
 */
export function diffKinds(baseline: readonly string[], current: readonly string[]): string[] {
	const lines: string[] = [];
	const width = Math.max(baseline.length, current.length);
	for (let i = 0; i < width; i++) {
		const before = baseline[i];
		const after = current[i];
		if (before !== after) {
			lines.push(`kinds[${i}]: baseline ${JSON.stringify(before ?? null)} vs current ${JSON.stringify(after ?? null)}`);
		}
	}
	return lines;
}

/**
 * Diff of baseline surfaces against current surfaces. The only accepted
 * change is the appended reviewed host-job surface `substrate`: empty when
 * current equals baseline plus `substrate`, otherwise one line per
 * difference.
 */
export function diffSurfaces(baseline: readonly string[], current: readonly string[]): string[] {
	const expected = [...baseline, "substrate"];
	const lines: string[] = [];
	const width = Math.max(expected.length, current.length);
	for (let i = 0; i < width; i++) {
		const want = expected[i];
		const got = current[i];
		if (want !== got) {
			lines.push(`surfaces[${i}]: expected ${JSON.stringify(want ?? null)} vs current ${JSON.stringify(got ?? null)}`);
		}
	}
	return lines;
}

/** Lock files missing under root. Checked before the test spawn because Bun exits 0 when one listed file is missing but another matches. */
export function missingFiles(root: string, files: readonly string[]): string[] {
	return files.filter((file) => !existsSync(join(root, file)));
}

function showBaseline(): string | null {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "GIT_DIR" && key !== "GIT_WORK_TREE") env[key] = value;
	}
	env["GIT_OPTIONAL_LOCKS"] = "0";
	const run = Bun.spawnSync(["git", "--no-optional-locks", "-C", ROOT, "show", `${BASELINE}:${TYPES_PATH}`], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
		env,
	});
	if (run.exitCode !== 0) return null;
	const out = run.stdout.toString();
	return out.length > 0 ? out : null;
}

function runLockTests(): number {
	const run = Bun.spawnSync([process.execPath, "test", ...LOCK_TESTS.map((file) => `./${file}`)], {
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
		timeout: TEST_TIMEOUT_MS,
	});
	return run.exitCode ?? 1;
}

export function main(): number {
	const missing = missingFiles(ROOT, LOCK_TESTS);
	if (missing.length > 0) {
		for (const file of missing) process.stderr.write(`[phase-close] missing lock file: ${file}\n`);
		return 2;
	}
	const tests = runLockTests();
	if (tests !== 0) {
		process.stderr.write("[phase-close] lock tests failed.\n");
		return 1;
	}
	const baselineText = showBaseline();
	if (baselineText === null) {
		process.stderr.write(`[phase-close] baseline object absent: ${BASELINE}:${TYPES_PATH} unreadable (shallow clone?).\n`);
		return 2;
	}
	const baselineKinds = parseEventKinds(baselineText);
	if (baselineKinds === null) {
		process.stderr.write("[phase-close] baseline EVENT_KINDS block not found.\n");
		return 2;
	}
	const kindDiff = diffKinds(baselineKinds, [...EVENT_KINDS]);
	if (kindDiff.length > 0) {
		for (const line of kindDiff) process.stdout.write(`[phase-close] ${line}\n`);
		return 1;
	}
	const baselineSurfaces = parseSurfaces(baselineText);
	if (baselineSurfaces === null) {
		process.stderr.write("[phase-close] baseline SURFACES block not found.\n");
		return 2;
	}
	const surfaceDiff = diffSurfaces(baselineSurfaces, [...SURFACES]);
	if (surfaceDiff.length > 0) {
		for (const line of surfaceDiff) process.stdout.write(`[phase-close] ${line}\n`);
		return 1;
	}
	process.stdout.write(
		`[phase-close] pass: ${LOCK_TESTS.length} lock files green (${LOCK_TESTS.join(", ")}); ` +
			`EVENT_KINDS unchanged at ${EVENT_KINDS.length} against ${BASELINE}; ` +
			`SURFACES equals baseline plus substrate at ${SURFACES.length}.\n`,
	);
	return 0;
}

if (import.meta.main) process.exit(main());
