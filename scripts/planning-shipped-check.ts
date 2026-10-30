#!/usr/bin/env bun
/**
 * Shipped-but-Planned check (`bun scripts/planning-shipped-check.ts [--strict]`).
 *
 * A roadmap phase whose progress row still says `Planned` or `Not started` is flagged when a merged pull request names it:
 * the pull request's title or head branch holds one of the phase's requirement IDs as a whole token (`WATCH-01`; a range
 * such as `WATCH-01..05` names each ID in it), or the phrase `phase N` or `pN` as a whole token (`6` does not match `63`).
 * Each field is matched on its own. The requirement IDs come from each phase's `**Requirements**` line in ROADMAP.md. The
 * merged pull requests come from `gh pr list --state merged`, run with a fixed argv and no shell.
 *
 * The check prints one line per flagged phase. It exits 0 unless `--strict` is given, then 1 when anything is flagged.
 * It exits 2 when the roadmap or `gh` cannot be read, or when the merged list reaches its limit and so may be incomplete:
 * a failed or partial lookup is not evidence that nothing shipped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RoadmapTableRow, isDoneStatus, parseRoadmapPart } from "../packages/mcp-server/src/planning/position.ts";

/** A merged pull request as the check reads it: its title and its head branch. */
export interface MergedPull {
	branch: string;
	title: string;
}

const REPO_ROOT = join(import.meta.dir, "..");
const ROADMAP_PATH = join(REPO_ROOT, ".planning", "ROADMAP.md");
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
/** The most merged pull requests the check asks `gh` for. A list that reaches it may be cut short, so it is an error. */
const MERGED_PULL_LIMIT = 5000;
/** The widest range the check expands. A wider one is left as written, so a typo cannot build a huge list. */
const MAX_RANGE_SPAN = 100;

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const PHASE_TITLE = /^Phase[ \t]+(\d+(?:\.\d+)?)[ \t]*[:\-\u2013\u2014]/i;
const REQUIREMENTS_LINE = /^[ \t]*(?:[-*+][ \t]+)?\*\*Requirements\*\*[ \t]*:[ \t]*(.*)$/i;
/** A line that opens a fenced code block: three or more backticks or tildes, then an optional info string. */
const OPENING_FENCE = /^[ \t]*(`{3,}|~{3,})/;
/** A line that closes a fenced code block: the same kind of run, alone on its line. */
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
/** A requirement ID as the roadmap writes it: upper-case segments joined by hyphens, such as `WATCH-01` or `A-D1`. */
const REQUIREMENT_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
/** `WATCH-01..05`, `WATCH-01..WATCH-05` or `WATCH-01\u201305`: the prefix, then the first and last number. */
const ID_RANGE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-(\d+)(?:\.{2,}|[\u2013\u2014])(?:\1-)?(\d+)(?![0-9A-Za-z])/g;
/** The regular-expression metacharacters, escaped before a phase number or a requirement ID goes into a pattern. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * The text with each range of requirement IDs replaced by the IDs it names. A range whose ends are not safe integers, that runs
 * backwards, or that is wider than `MAX_RANGE_SPAN` is left as written.
 */
export function expandRanges(text: string): string {
	return text.replace(ID_RANGE, (whole: string, prefix: string, first: string, last: string) => {
		const from = Number(first);
		const to = Number(last);
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from > MAX_RANGE_SPAN) return whole;
		const ids: string[] = [];
		for (let offset = 0; offset <= to - from; offset++) ids.push(`${prefix}-${String(from + offset).padStart(first.length, "0")}`);
		return ` ${ids.join(" ")} `;
	});
}

/** The requirement IDs a `**Requirements**` value names, ranges expanded. `[WATCH-01..05]` gives five IDs; prose names none. */
function idsIn(value: string): string[] {
	const ids = expandRanges(value)
		.split(/[^A-Za-z0-9-]+/)
		.filter((token) => REQUIREMENT_ID.test(token));
	return [...new Set(ids)];
}

/**
 * Each phase's requirement IDs, read from the first `**Requirements**` line under its `Phase N:` heading, up to the next
 * heading of the same or a higher level. Fenced code is skipped: a block closes only with a run of the character that opened it
 * and at least as many of them, so a tilde line inside a backtick block does not end it. A phase with no such line has no entry.
 */
export function requirementsOfRoadmap(text: string): Map<string, string[]> {
	const byPhase = new Map<string, string[]>();
	let phase: string | null = null;
	let phaseLevel = 0;
	let openFence: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (openFence !== null) {
			const closing = CLOSING_FENCE.exec(line)?.[1] ?? "";
			if (closing !== "" && closing[0] === openFence[0] && closing.length >= openFence.length) openFence = null;
			continue;
		}
		const opening = OPENING_FENCE.exec(line)?.[1];
		if (opening !== undefined) {
			openFence = opening;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			const level = (heading[1] ?? "").length;
			const phaseTitle = PHASE_TITLE.exec(heading[2] ?? "");
			if (phaseTitle !== null) {
				// A phase number without leading zeros, as the progress table writes it: `08` is `8`, `08.1` is `8.1`.
				phase = (phaseTitle[1] ?? "").replace(/^0+(?=\d)/, "");
				phaseLevel = level;
			} else if (phase !== null && level <= phaseLevel) {
				phase = null;
			}
			continue;
		}
		const requirements = REQUIREMENTS_LINE.exec(line);
		if (phase !== null && requirements !== null && !byPhase.has(phase)) byPhase.set(phase, idsIn(requirements[1] ?? ""));
	}
	return byPhase;
}

/**
 * One finding per roadmap row that is still `Planned` or `Not started` while a merged pull request names its phase or one of
 * its requirements. Pure: the rows, the requirements and the merged pull requests are the whole input, and nothing is read.
 */
export function checkPlannedPhaseMerged(rows: readonly RoadmapTableRow[], phaseRequirements: ReadonlyMap<string, readonly string[]>, merged: readonly MergedPull[]): string[] {
	// Each field is matched on its own: a title and a branch joined by a space would let `phase` in one and `6` in the other read as `phase 6`.
	const evidence = merged.map((pull) => [pull.title, pull.branch].map(expandRanges));
	const findings: string[] = [];
	for (const row of rows) {
		if (isDoneStatus(row.status) || !/^(?:planned|not started)/i.test(row.status.trim())) continue;
		// `phase N` or `pN` as a whole token: `6` does not match `63`, `6.1` or `6x`.
		const phase = new RegExp(`(?<![A-Za-z0-9])(?:phase[\\s_-]*|p)${row.number.replace(REGEX_METACHARACTERS, "\\$&")}(?![0-9A-Za-z]|\\.[0-9])`, "i");
		// A requirement ID as a whole token, in its exact case; a hyphen beside it does not join it.
		const requirementTokens = (phaseRequirements.get(row.number) ?? []).map((id) => new RegExp(`(?<![A-Za-z0-9])${id.replace(REGEX_METACHARACTERS, "\\$&")}(?![A-Za-z0-9])`));
		const index = evidence.findIndex((fields) => fields.some((text) => phase.test(text) || requirementTokens.some((token) => token.test(text))));
		const pull = merged[index];
		if (index === -1 || pull === undefined) continue;
		findings.push(`phase ${row.number} (${row.name}) is recorded as "${row.status}" but merged pull request "${pull.title}" names it`);
	}
	return findings;
}

function stringField(item: unknown, key: string): string {
	if (typeof item !== "object" || item === null || !(key in item)) return "";
	const value: unknown = Reflect.get(item, key);
	return typeof value === "string" ? value : "";
}

/** The pull requests of `gh pr list --json title,headRefName`. A string names why the output is not a list of them. */
export function parsePulls(json: string): MergedPull[] | string {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return "gh pr list printed output that is not JSON";
	}
	if (!Array.isArray(data)) return "gh pr list did not print a JSON array";
	const items: unknown[] = data;
	return items.map((item) => ({ title: stringField(item, "title"), branch: stringField(item, "headRefName") }));
}

/**
 * The merged pull requests from `gh pr list` output asked for with `limit`. A list that reaches `limit` may have been cut short,
 * so it is an error: the check never passes on evidence it could not see.
 */
export function completeMergedPulls(json: string, limit: number): MergedPull[] | string {
	const pulls = parsePulls(json);
	if (typeof pulls === "string") return pulls;
	if (pulls.length >= limit) return `merged pull requests reached the limit of ${limit}; the check is incomplete`;
	return pulls;
}

/** The merged pull requests of the repository, through `gh`. A string names why they could not be listed completely. */
function mergedPulls(): MergedPull[] | string {
	const run = spawnSync("gh", ["pr", "list", "--state", "merged", "--limit", String(MERGED_PULL_LIMIT), "--json", "title,headRefName"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GH_TIMEOUT_MS,
		maxBuffer: GH_MAX_BUFFER,
	});
	if (run.error !== undefined) return `gh could not run: ${run.error.message}`;
	if (run.status !== 0) return `gh pr list exited ${run.status ?? "on a signal"}: ${(run.stderr.trim().split("\n")[0] ?? "").slice(0, 200)}`;
	return completeMergedPulls(run.stdout, MERGED_PULL_LIMIT);
}

function main(argv: readonly string[]): number {
	if (argv.some((arg) => arg !== "--strict")) {
		process.stderr.write("usage: bun scripts/planning-shipped-check.ts [--strict]\n");
		return 2;
	}
	let text: string;
	try {
		text = readFileSync(ROADMAP_PATH, "utf8");
	} catch {
		process.stderr.write("planned-shipped check: ROADMAP.md could not be read\n");
		return 2;
	}
	const roadmap = parseRoadmapPart(text);
	if (!roadmap.ok) {
		process.stderr.write("planned-shipped check: the planning reader could not parse ROADMAP.md\n");
		return 2;
	}
	if (roadmap.part.truncated) process.stderr.write("planned-shipped check: ROADMAP.md is longer than the planning reader keeps; some rows may be missing\n");
	const merged = mergedPulls();
	if (typeof merged === "string") {
		process.stderr.write(`planned-shipped check: ${merged}\n`);
		return 2;
	}
	const findings = checkPlannedPhaseMerged(roadmap.part.rows, requirementsOfRoadmap(text), merged);
	for (const finding of findings) process.stdout.write(`${finding}\n`);
	return argv.includes("--strict") && findings.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
