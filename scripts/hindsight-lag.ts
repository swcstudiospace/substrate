#!/usr/bin/env bun
/**
 * Hindsight lag watcher: is the pinned Hindsight falling behind upstream?
 *
 *   bun scripts/hindsight-lag.ts --repo <owner/name> --token-env <NAME> [--pin <file>]
 *   bun scripts/hindsight-lag.ts --dry-run [--pin <file>]
 *   bun scripts/hindsight-lag.ts --report-failure --repo <owner/name> --token-env <NAME> --run-url <https url>
 *
 * `.github/hindsight-pin.json` declares the version the three Railway services are pinned to. This
 * script reads it, compares it with the stable releases of `vectorize-io/hindsight` (prereleases
 * and drafts are ignored), and decides: alert when a newer stable release has existed for at
 * least `lag_alert_days`. It keeps exactly ONE open issue labelled `hindsight-lag` in this
 * repository: created when the decision is to alert, updated while it stays so, closed when it no
 * longer is. It opens no pull request and touches nothing on Railway; an upgrade is a manual,
 * operator-only act (docs/runbooks/hindsight-upgrade.md).
 *
 * The token is read from the environment variable NAMED by `--token-env`; its value is never
 * printed. `--report-failure` is the workflow's last-resort step: it opens or updates one issue
 * labelled `hindsight-lag-failed` so a broken watcher is itself visible; a later successful run
 * closes it.
 *
 * Exit 0 when the run finished, 1 when a GitHub API call failed, 2 on a usage or input error
 * (including a malformed pin file). Pure functions are exported; `main` takes its fetch, clock,
 * file reader, environment and output as parameters, so tests need no network and no real time.
 */
import { join } from "node:path";

export const UPSTREAM_REPO = "vectorize-io/hindsight";
export const PIN_PATH = ".github/hindsight-pin.json";
export const RUNBOOK_PATH = "docs/runbooks/hindsight-upgrade.md";
export const LAG_LABEL = "hindsight-lag";
export const FAILURE_LABEL = "hindsight-lag-failed";
export const FAILURE_TITLE = "Hindsight lag watcher failed";

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 5;
const DAY_MS = 86_400_000;
const ERROR_BODY_CHARS = 200;

/** A usage or input problem: bad flags, a missing token variable, a malformed pin file. Exit 2. */
export class LagInputError extends Error {}

/** A GitHub API call failed or answered something that is not the documented shape. Exit 1. */
export class GitHubApiError extends Error {}

// ── semver ────────────────────────────────────────────────────────────────

export interface Semver {
	major: number;
	minor: number;
	patch: number;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Strict `MAJOR.MINOR.PATCH`: no `v`, no suffix, no leading zeros, no spaces. Null otherwise. */
export function parseSemver(text: string): Semver | null {
	const match = SEMVER.exec(text);
	if (match === null) return null;
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (![major, minor, patch].every(Number.isSafeInteger)) return null;
	return { major, minor, patch };
}

/** A release tag: one optional leading `v`, then a strict version. Null for `v1.0.0-rc1`, `nightly` and the like. */
export function parseTag(tag: string): Semver | null {
	return parseSemver(tag.startsWith("v") ? tag.slice(1) : tag);
}

export function formatSemver(version: Semver): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	return 0;
}

// ── the pin file ──────────────────────────────────────────────────────────

export interface BlockedBy {
	repo: string;
	issue: number;
	reason: string;
}

export interface HindsightPin {
	pinned: string;
	pinned_since: string;
	tested_against: string;
	images: string[];
	blocked_by: BlockedBy[];
	lag_alert_days: number;
	notes: string;
}

const PIN_KEYS = ["pinned", "pinned_since", "tested_against", "images", "blocked_by", "lag_alert_days", "notes"] as const;
const BLOCKER_KEYS = ["repo", "issue", "reason"] as const;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_LAG_ALERT_DAYS = 365;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealDate(text: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
	const parsed = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of allowed) {
		if (!(key in record)) throw new LagInputError(`${where}: missing "${key}"`);
	}
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new LagInputError(`${where}: unknown key "${key}"`);
	}
}

function nonEmptyString(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new LagInputError(`${where} must be a non-empty string`);
	return value;
}

/** Parses and checks the pin file. Throws `LagInputError` naming the first problem; unknown keys are refused. */
export function parsePin(text: string): HindsightPin {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new LagInputError(`${PIN_PATH} is not valid JSON`);
	}
	if (!isRecord(data)) throw new LagInputError(`${PIN_PATH} must be a JSON object`);
	onlyKeys(data, PIN_KEYS, PIN_PATH);

	const pinned = nonEmptyString(data.pinned, `${PIN_PATH}: pinned`);
	if (parseSemver(pinned) === null) throw new LagInputError(`${PIN_PATH}: pinned must be MAJOR.MINOR.PATCH without a prefix or suffix (got "${pinned}")`);
	const testedAgainst = nonEmptyString(data.tested_against, `${PIN_PATH}: tested_against`);
	if (parseSemver(testedAgainst) === null) {
		throw new LagInputError(`${PIN_PATH}: tested_against must be MAJOR.MINOR.PATCH without a prefix or suffix (got "${testedAgainst}")`);
	}
	const pinnedSince = nonEmptyString(data.pinned_since, `${PIN_PATH}: pinned_since`);
	if (!isRealDate(pinnedSince)) throw new LagInputError(`${PIN_PATH}: pinned_since must be a real YYYY-MM-DD date (got "${pinnedSince}")`);

	const images = data.images;
	if (!Array.isArray(images) || images.length === 0) throw new LagInputError(`${PIN_PATH}: images must be a non-empty array`);
	for (const image of images) {
		if (typeof image !== "string" || !IMAGE_NAME.test(image)) throw new LagInputError(`${PIN_PATH}: images entries must be lower-case image names`);
	}
	if (new Set(images).size !== images.length) throw new LagInputError(`${PIN_PATH}: images lists a name twice`);

	const blockedBy = data.blocked_by;
	if (!Array.isArray(blockedBy)) throw new LagInputError(`${PIN_PATH}: blocked_by must be an array (empty when nothing blocks)`);
	const blockers = blockedBy.map((entry, index): BlockedBy => {
		const where = `${PIN_PATH}: blocked_by[${index}]`;
		if (!isRecord(entry)) throw new LagInputError(`${where} must be an object`);
		onlyKeys(entry, BLOCKER_KEYS, where);
		const repo = nonEmptyString(entry.repo, `${where}.repo`);
		if (!REPO_NAME.test(repo)) throw new LagInputError(`${where}.repo must be owner/name (got "${repo}")`);
		const issue = entry.issue;
		if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) throw new LagInputError(`${where}.issue must be a positive integer`);
		return { repo, issue, reason: nonEmptyString(entry.reason, `${where}.reason`) };
	});

	const lagAlertDays = data.lag_alert_days;
	if (typeof lagAlertDays !== "number" || !Number.isSafeInteger(lagAlertDays) || lagAlertDays < 1 || lagAlertDays > MAX_LAG_ALERT_DAYS) {
		throw new LagInputError(`${PIN_PATH}: lag_alert_days must be an integer from 1 to ${MAX_LAG_ALERT_DAYS}`);
	}

	return {
		pinned,
		pinned_since: pinnedSince,
		tested_against: testedAgainst,
		images: images as string[],
		blocked_by: blockers,
		lag_alert_days: lagAlertDays,
		notes: nonEmptyString(data.notes, `${PIN_PATH}: notes`),
	};
}

// ── upstream releases ─────────────────────────────────────────────────────

export interface Release {
	tag: string;
	version: Semver;
	publishedAt: string;
	url: string;
	body: string;
}

/**
 * The stable releases in a GitHub releases page, one per version (the earliest publication wins when
 * two tags carry the same version). Drafts, prereleases and tags that are not a strict version are
 * left out on purpose: they are not something to pin. A stable release without a usable shape is an
 * error, not a skip, so a changed API shows up as a failed run.
 */
export function parseReleases(json: unknown): Release[] {
	if (!Array.isArray(json)) throw new GitHubApiError("releases: expected an array");
	const found = new Map<string, Release>();
	for (const [index, entry] of json.entries()) {
		if (!isRecord(entry)) throw new GitHubApiError(`releases[${index}]: expected an object`);
		if (entry.draft === true || entry.prerelease === true) continue;
		const tag = entry.tag_name;
		if (typeof tag !== "string") throw new GitHubApiError(`releases[${index}]: tag_name is not a string`);
		const version = parseTag(tag);
		if (version === null) continue;
		const publishedAt = entry.published_at;
		if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) {
			throw new GitHubApiError(`releases[${index}] (${tag}): published_at is not a date`);
		}
		const url = entry.html_url;
		if (typeof url !== "string" || url === "") throw new GitHubApiError(`releases[${index}] (${tag}): html_url is not a string`);
		const body = entry.body;
		if (body !== null && body !== undefined && typeof body !== "string") throw new GitHubApiError(`releases[${index}] (${tag}): body is not a string`);
		const release: Release = { tag, version, publishedAt, url, body: body ?? "" };
		const key = formatSemver(version);
		const earlier = found.get(key);
		if (earlier === undefined || Date.parse(publishedAt) < Date.parse(earlier.publishedAt)) found.set(key, release);
	}
	return [...found.values()].sort((a, b) => compareSemver(a.version, b.version));
}

const BREAKING_HEADING = /^#{1,6}[ \t]+.*breaking[ \t-]+changes?\b/im;
const BREAKING_WORD = /\bBREAKING\b/;

/**
 * True when release notes carry a Breaking Changes heading or the word BREAKING (upper case, as in
 * `BREAKING CHANGE:`). Conservative on purpose: a heading that says "none" still counts, and the
 * runbook has the operator read the notes either way.
 */
export function mentionsBreaking(body: string): boolean {
	return BREAKING_HEADING.test(body) || BREAKING_WORD.test(body);
}

// ── blockers ──────────────────────────────────────────────────────────────

export interface BlockerStatus {
	repo: string;
	issue: number;
	reason: string;
	state: "open" | "closed";
	closedAt: string | null;
	url: string;
}

/** One upstream issue from the issues API, checked at the edge. */
export function parseBlocker(json: unknown, blocker: BlockedBy): BlockerStatus {
	const where = `${blocker.repo}#${blocker.issue}`;
	if (!isRecord(json)) throw new GitHubApiError(`${where}: expected an issue object`);
	if (json.state !== "open" && json.state !== "closed") throw new GitHubApiError(`${where}: state is neither open nor closed`);
	const closedAt = json.closed_at;
	if (closedAt !== null && closedAt !== undefined && typeof closedAt !== "string") throw new GitHubApiError(`${where}: closed_at is not a string`);
	const url = typeof json.html_url === "string" ? json.html_url : `https://github.com/${blocker.repo}/issues/${blocker.issue}`;
	return { repo: blocker.repo, issue: blocker.issue, reason: blocker.reason, state: json.state, closedAt: closedAt ?? null, url };
}

// ── analysis ──────────────────────────────────────────────────────────────

export type LagState = "current" | "newer-patch" | "newer-minor" | "newer-major";

export interface NewerRelease {
	version: string;
	tag: string;
	publishedAt: string;
	url: string;
	breaking: boolean;
}

export interface LagReport {
	/** The clock reading the ages were computed from. */
	checkedAt: string;
	pin: HindsightPin;
	/** The highest stable release upstream, whether or not it is newer than the pin. */
	latest: { version: string; tag: string; publishedAt: string; url: string } | null;
	state: LagState;
	/** Stable releases newer than the pin, oldest version first. */
	newer: NewerRelease[];
	/** Whole days since the earliest-published newer release; null when the pin is current. */
	ageDays: number | null;
	/** Whether any newer release's notes mention a breaking change. */
	breaking: boolean;
	blockers: BlockerStatus[];
	alert: boolean;
}

/** Pure: the pin, the stable releases, the blocker states and the clock in; the report and the alert decision out. */
export function analyze(pin: HindsightPin, releases: readonly Release[], blockers: readonly BlockerStatus[], now: Date): LagReport {
	const pinned = parseSemver(pin.pinned);
	if (pinned === null) throw new LagInputError(`pinned version "${pin.pinned}" is not a strict version`);
	const sorted = [...releases].sort((a, b) => compareSemver(a.version, b.version));
	const top = sorted.at(-1);
	const newerReleases = sorted.filter((release) => compareSemver(release.version, pinned) > 0);
	const newer: NewerRelease[] = newerReleases.map((release) => ({
		version: formatSemver(release.version),
		tag: release.tag,
		publishedAt: release.publishedAt,
		url: release.url,
		breaking: mentionsBreaking(release.body),
	}));

	let state: LagState = "current";
	let ageDays: number | null = null;
	const highest = newerReleases.at(-1);
	if (highest !== undefined) {
		state = highest.version.major !== pinned.major ? "newer-major" : highest.version.minor !== pinned.minor ? "newer-minor" : "newer-patch";
		const firstPublished = Math.min(...newerReleases.map((release) => Date.parse(release.publishedAt)));
		ageDays = Math.max(0, Math.floor((now.getTime() - firstPublished) / DAY_MS));
	}

	return {
		checkedAt: now.toISOString(),
		pin,
		latest: top === undefined ? null : { version: formatSemver(top.version), tag: top.tag, publishedAt: top.publishedAt, url: top.url },
		state,
		newer,
		ageDays,
		breaking: newer.some((release) => release.breaking),
		blockers: [...blockers],
		alert: ageDays !== null && ageDays >= pin.lag_alert_days,
	};
}

function blockerLine(blocker: BlockerStatus): string {
	const status = blocker.state === "open" ? "open" : `closed${blocker.closedAt === null ? "" : ` ${blocker.closedAt.slice(0, 10)}`}`;
	return `${blocker.repo}#${blocker.issue} ${status}: ${blocker.reason}`;
}

/** The deterministic text report the script prints. */
export function formatReport(report: LagReport): string {
	const { pin } = report;
	const lines = [
		`hindsight lag: pinned ${pin.pinned} (since ${pin.pinned_since}, tested against ${pin.tested_against}; images ${pin.images.join(", ")})`,
		report.latest === null
			? "latest stable upstream: none found"
			: `latest stable upstream: ${report.latest.version} (published ${report.latest.publishedAt})`,
		`state: ${report.state}`,
		`newer stable releases: ${report.newer.length === 0 ? "none" : report.newer.map((release) => release.version).join(", ")}`,
	];
	if (report.ageDays !== null) lines.push(`age: ${report.ageDays} days since the first newer release (alert from ${pin.lag_alert_days} days)`);
	const breaking = report.newer.filter((release) => release.breaking).map((release) => release.version);
	lines.push(`breaking change mentioned: ${breaking.length === 0 ? "no" : `yes (${breaking.join(", ")})`}`);
	if (report.blockers.length === 0) lines.push("blockers: none declared");
	for (const blocker of report.blockers) lines.push(`blocker ${blockerLine(blocker)}`);
	lines.push(`decision: ${report.alert ? "alert" : "no alert"}`);
	return `${lines.join("\n")}\n`;
}

// ── the issue ─────────────────────────────────────────────────────────────

export function issueTitle(report: LagReport): string {
	if (report.state === "current" || report.latest === null) return `Hindsight pin ${report.pin.pinned} is current`;
	if (!report.alert) return `Hindsight pin ${report.pin.pinned}: newer upstream ${report.latest.version} is under the alert threshold`;
	return `Hindsight pin ${report.pin.pinned} is behind upstream ${report.latest.version}`;
}

/** The ONE issue body, markdown. `repo` only builds the runbook link. */
export function renderIssueBody(report: LagReport, repo: string): string {
	const { pin } = report;
	const breaking = report.newer.filter((release) => release.breaking).map((release) => `${release.tag}`);
	const rows: string[] = [
		"| | |",
		"| --- | --- |",
		`| Pinned | \`${pin.pinned}\` since ${pin.pinned_since} (tested against \`${pin.tested_against}\`) |`,
		`| Images | ${pin.images.map((image) => `\`${image}\``).join(", ")} |`,
		`| Latest stable upstream | ${report.latest === null ? "none found" : `[${report.latest.tag}](${report.latest.url}), published ${report.latest.publishedAt.slice(0, 10)}`} |`,
		`| State | \`${report.state}\` |`,
		`| Newer stable releases | ${report.newer.length === 0 ? "none" : report.newer.map((release) => `[${release.tag}](${release.url})`).join(", ")} |`,
		`| Age | ${report.ageDays === null ? "n/a" : `${report.ageDays} days since the first newer release (alert from ${pin.lag_alert_days} days)`} |`,
		`| Release notes mention a breaking change | ${breaking.length === 0 ? "no" : `**yes**: ${breaking.join(", ")}`} |`,
	];
	const blockerLines =
		report.blockers.length === 0
			? ["- None declared in `.github/hindsight-pin.json`."]
			: report.blockers.map((blocker) => `- [${blocker.repo}#${blocker.issue}](${blocker.url}): **${blocker.state}**${blocker.closedAt === null ? "" : ` (${blocker.closedAt.slice(0, 10)})`}, ${blocker.reason}`);
	const runbook = `https://github.com/${repo}/blob/main/${RUNBOOK_PATH}`;
	const lines = [
		report.state === "current"
			? "The pinned Hindsight matches the latest stable upstream release. This issue is closed by the watcher."
			: `A newer stable Hindsight release has existed for ${report.ageDays} day(s) and the pin has not moved.`,
		"",
		...rows,
		"",
		"### Blockers",
		"",
		...blockerLines,
		"",
		"A closed blocker is not proof that a release carries the fix: check the release notes before relying on it.",
	];
	if (report.state !== "current") {
		lines.push(
			"",
			"### Next steps",
			"",
			"1. Read the release notes of every newer release (links above) for breaking changes and migration notes.",
			"2. Check the blockers above. While one is open, do not upgrade; record the decision in a comment here.",
			`3. Follow [\`${RUNBOOK_PATH}\`](${runbook}): back up, stand up a candidate, run the canary, then the operator edits the image tags. Every step on Railway is operator only.`,
			"4. After the upgrade (or a rollback), update `.github/hindsight-pin.json` in a pull request. The next watcher run closes this issue once the pin is current.",
		);
	}
	lines.push("", "_Opened and updated by the `hindsight-lag` workflow (`scripts/hindsight-lag.ts`). It never opens a pull request and never touches Railway._", "");
	return lines.join("\n");
}

export function failureBody(runUrl: string): string {
	return [
		"The weekly Hindsight lag watcher failed, so the pin is not being compared with upstream right now.",
		"",
		`Failed run: ${runUrl}`,
		"",
		"Read the run log for the cause: a malformed `.github/hindsight-pin.json` (exit 2), a GitHub API failure (exit 1), or the runner itself. Fix it and re-run the workflow with `workflow_dispatch`; the next successful run closes this issue.",
		"",
	].join("\n");
}

export interface DesiredIssue {
	title: string;
	body: string;
	/** True: one open issue must exist. False: no open issue may remain (a final body is still written). */
	open: boolean;
}

export interface OpenIssue {
	number: number;
	title: string;
}

export type IssueAction =
	| { kind: "none" }
	| { kind: "create"; title: string; body: string }
	/** Update the lowest-numbered open issue; `close` also closes it; `extras` are further open issues to close. */
	| { kind: "update"; number: number; title: string; body: string; close: boolean; extras: number[] };

/** Pure: never more than one open issue. Several open ones keep the lowest number and close the rest. */
export function planIssue(desired: DesiredIssue, existing: readonly OpenIssue[]): IssueAction {
	const numbers = existing.map((issue) => issue.number).sort((a, b) => a - b);
	const [keep, ...extras] = numbers;
	if (keep === undefined) return desired.open ? { kind: "create", title: desired.title, body: desired.body } : { kind: "none" };
	return { kind: "update", number: keep, title: desired.title, body: desired.body, close: !desired.open, extras };
}

// ── GitHub ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHub {
	request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown>;
}

export interface GitHubOptions {
	fetch: FetchLike;
	/** Null for an unauthenticated read (a dry run). */
	token: string | null;
	base?: string;
	timeoutMs?: number;
}

export function createGitHub(options: GitHubOptions): GitHub {
	const base = options.base ?? GITHUB_API;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	return {
		async request(method, path, body) {
			const headers: Record<string, string> = {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": "agent-substrate-hindsight-lag",
			};
			if (options.token !== null) headers.authorization = `Bearer ${options.token}`;
			if (body !== undefined) headers["content-type"] = "application/json";
			// One abort budget covers the connect and the body read; the timer is always cleared so it never holds the process open.
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				let response: Response;
				try {
					response = await options.fetch(`${base}${path}`, {
						method,
						headers,
						body: body === undefined ? undefined : JSON.stringify(body),
						signal: controller.signal,
					});
				} catch (cause) {
					throw new GitHubApiError(`${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new GitHubApiError(`${method} ${path}: HTTP ${response.status}${text === "" ? "" : ` ${text.slice(0, ERROR_BODY_CHARS)}`}`);
				}
				try {
					return await response.json();
				} catch {
					throw new GitHubApiError(`${method} ${path}: the answer is not JSON`);
				}
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** Every stable page of the upstream releases, newest first, up to `MAX_RELEASE_PAGES` pages. */
export async function fetchReleases(gh: GitHub): Promise<Release[]> {
	const pages: unknown[] = [];
	for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
		const json = await gh.request("GET", `/repos/${UPSTREAM_REPO}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`);
		if (!Array.isArray(json)) throw new GitHubApiError("releases: expected an array");
		pages.push(...json);
		if (json.length < RELEASES_PER_PAGE) break;
	}
	return parseReleases(pages);
}

export async function fetchBlockers(gh: GitHub, blockers: readonly BlockedBy[]): Promise<BlockerStatus[]> {
	const statuses: BlockerStatus[] = [];
	for (const blocker of blockers) {
		statuses.push(parseBlocker(await gh.request("GET", `/repos/${blocker.repo}/issues/${blocker.issue}`), blocker));
	}
	return statuses;
}

/** The open issues carrying `label` in `repo`, pull requests excluded (the issues API lists both). */
export async function listOpenIssues(gh: GitHub, repo: string, label: string): Promise<OpenIssue[]> {
	const json = await gh.request("GET", `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`);
	if (!Array.isArray(json)) throw new GitHubApiError("issues: expected an array");
	const issues: OpenIssue[] = [];
	for (const [index, entry] of json.entries()) {
		if (!isRecord(entry) || typeof entry.number !== "number" || !Number.isSafeInteger(entry.number)) {
			throw new GitHubApiError(`issues[${index}]: no issue number`);
		}
		if ("pull_request" in entry) continue;
		issues.push({ number: entry.number, title: typeof entry.title === "string" ? entry.title : "" });
	}
	return issues;
}

/** Applies the plan; returns one line per write for the log. */
export async function applyIssue(gh: GitHub, repo: string, label: string, action: IssueAction): Promise<string[]> {
	if (action.kind === "none") return ["issue: nothing to do"];
	if (action.kind === "create") {
		const created = await gh.request("POST", `/repos/${repo}/issues`, { title: action.title, body: action.body, labels: [label] });
		return [`issue: opened #${isRecord(created) ? String(created.number) : "?"} (${label})`];
	}
	const done: string[] = [];
	await gh.request("PATCH", `/repos/${repo}/issues/${action.number}`, {
		title: action.title,
		body: action.body,
		...(action.close ? { state: "closed", state_reason: "completed" } : {}),
	});
	done.push(`issue: ${action.close ? "closed" : "updated"} #${action.number} (${label})`);
	for (const extra of action.extras) {
		await gh.request("PATCH", `/repos/${repo}/issues/${extra}`, { state: "closed", state_reason: "not_planned" });
		done.push(`issue: closed duplicate #${extra} (${label})`);
	}
	return done;
}

async function syncIssue(gh: GitHub, repo: string, label: string, desired: DesiredIssue): Promise<string[]> {
	return applyIssue(gh, repo, label, planIssue(desired, await listOpenIssues(gh, repo, label)));
}

// ── the command line ──────────────────────────────────────────────────────

interface Args {
	repo: string | null;
	tokenEnv: string | null;
	pin: string | null;
	runUrl: string | null;
	dryRun: boolean;
	reportFailure: boolean;
}

const USAGE = [
	"usage: bun scripts/hindsight-lag.ts --repo <owner/name> --token-env <NAME> [--pin <file>]",
	"       bun scripts/hindsight-lag.ts --dry-run [--pin <file>]",
	"       bun scripts/hindsight-lag.ts --report-failure --repo <owner/name> --token-env <NAME> --run-url <https url>",
].join("\n");

export function parseArgs(argv: readonly string[]): Args {
	const args: Args = { repo: null, tokenEnv: null, pin: null, runUrl: null, dryRun: false, reportFailure: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index] as string;
		if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--report-failure") args.reportFailure = true;
		else if (flag === "--repo" || flag === "--token-env" || flag === "--pin" || flag === "--run-url") {
			const value = argv[++index];
			if (value === undefined || value === "" || value.startsWith("--")) throw new LagInputError(`${flag} needs a value\n${USAGE}`);
			if (flag === "--repo") args.repo = value;
			else if (flag === "--token-env") args.tokenEnv = value;
			else if (flag === "--pin") args.pin = value;
			else args.runUrl = value;
		} else throw new LagInputError(`unknown argument ${flag}\n${USAGE}`);
	}
	if (args.repo !== null && !REPO_NAME.test(args.repo)) throw new LagInputError(`--repo must be owner/name (got "${args.repo}")`);
	if (args.tokenEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.tokenEnv)) throw new LagInputError("--token-env must name an environment variable");
	if (args.runUrl !== null) {
		let parsed: URL | null = null;
		try {
			parsed = new URL(args.runUrl);
		} catch {
			parsed = null;
		}
		if (parsed === null || parsed.protocol !== "https:") throw new LagInputError("--run-url must be an https URL");
	}
	if (args.dryRun && args.reportFailure) throw new LagInputError(`--dry-run and --report-failure cannot be combined\n${USAGE}`);
	if (!args.dryRun && (args.repo === null || args.tokenEnv === null)) throw new LagInputError(`--repo and --token-env are required\n${USAGE}`);
	if (args.reportFailure && args.runUrl === null) throw new LagInputError(`--report-failure needs --run-url\n${USAGE}`);
	if (!args.reportFailure && args.runUrl !== null) throw new LagInputError("--run-url belongs to --report-failure");
	return args;
}

export interface Deps {
	fetch: FetchLike;
	now: () => Date;
	readFile: (path: string) => Promise<string>;
	env: Readonly<Record<string, string | undefined>>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** The repository root the pin path is resolved against. */
	root: string;
}

export function defaultDeps(): Deps {
	return {
		fetch: (url, init) => fetch(url, init),
		now: () => new Date(),
		readFile: (path) => Bun.file(path).text(),
		env: process.env,
		stdout: (text) => void process.stdout.write(text),
		stderr: (text) => void process.stderr.write(text),
		root: join(import.meta.dir, ".."),
	};
}

function tokenFrom(args: Args, deps: Deps): string | null {
	if (args.tokenEnv === null) return null;
	// The variable is named on the command line, so its value is looked up by that name and never echoed.
	const token = deps.env[args.tokenEnv];
	if (token === undefined || token.trim() === "") throw new LagInputError(`environment variable ${args.tokenEnv} is empty or unset`);
	return token;
}

export async function main(argv: readonly string[], deps: Deps = defaultDeps()): Promise<number> {
	try {
		const args = parseArgs(argv);
		const token = tokenFrom(args, deps);
		const gh = createGitHub({ fetch: deps.fetch, token });

		if (args.reportFailure) {
			const lines = await syncIssue(gh, args.repo as string, FAILURE_LABEL, {
				title: FAILURE_TITLE,
				body: failureBody(args.runUrl as string),
				open: true,
			});
			deps.stdout(`${lines.join("\n")}\n`);
			return 0;
		}

		const pin = parsePin(await deps.readFile(args.pin ?? join(deps.root, PIN_PATH)));
		const report = analyze(pin, await fetchReleases(gh), await fetchBlockers(gh, pin.blocked_by), deps.now());
		deps.stdout(formatReport(report));

		if (args.dryRun) {
			deps.stdout(`dry run: no issue written\n${report.alert ? `\n--- issue: ${issueTitle(report)}\n${renderIssueBody(report, UPSTREAM_REPO)}` : ""}`);
			return 0;
		}

		const repo = args.repo as string;
		const lag = await syncIssue(gh, repo, LAG_LABEL, { title: issueTitle(report), body: renderIssueBody(report, repo), open: report.alert });
		// A run that got this far means the watcher works again: close any open failure issue.
		const failure = await syncIssue(gh, repo, FAILURE_LABEL, {
			title: FAILURE_TITLE,
			body: `Resolved: the watcher ran successfully on ${report.checkedAt.slice(0, 10)}.\n`,
			open: false,
		});
		deps.stdout(`${[...lag, ...failure.filter((line) => !line.endsWith("nothing to do"))].join("\n")}\n`);
		return 0;
	} catch (error) {
		if (error instanceof LagInputError) {
			deps.stderr(`hindsight-lag: ${error.message}\n`);
			return 2;
		}
		if (error instanceof GitHubApiError) {
			deps.stderr(`hindsight-lag: GitHub API failure: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
