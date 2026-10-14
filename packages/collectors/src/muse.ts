#!/usr/bin/env bun
/**
 * Muse brief writer (D19-14 .. D19-17).
 *
 * Muse has no prompt-submission hook, so the brief is a file. Each pass
 * POSTs `/brief` for the origin slug of every named repo, writes the redacted
 * body to `<repo>/.substrate/BRIEF.md`, and keeps one pointer block in
 * `AGENTS.md`. The writer emits no event: `muse.brief_writer` is silent.
 *
 *   SUBSTRATE_MUSE_REPOS=/a:/b bun packages/collectors/src/muse.ts --once
 *   SUBSTRATE_MUSE_REPOS=/a:/b bun packages/collectors/src/muse.ts --watch
 *
 * `SUBSTRATE_MUSE_REPOS` is required — a colon-separated list of absolute
 * roots. There is no inferred default. The operator names the blast radius.
 *
 * `/brief` can still return 200 after `/healthz` reported the ledger up, if
 * the ledger drops between the check and the fetch. This writer cannot see
 * that race; a degraded 200 is written like any other brief. The gap is
 * recorded in `docs/collectors.md`.
 *
 * Since uplift-2 R1 the server answers with an `ETag`; the writer keeps the
 * last one per repo in its state file, sends it back as `If-None-Match`, and a
 * 304 leaves `BRIEF.md` alone (counted `unchanged`) instead of fetching and
 * rewriting the same text every pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import { branchFor, repoSlug } from "./git-context.ts";

/** Briefs move slowly. `--watch` sleeps this long between passes. */
export const POLL_MS = 300_000;

export const MARKER_START = "<!-- substrate-brief:start -->";
export const MARKER_END = "<!-- substrate-brief:end -->";

const DEFAULT_STATE_DIR = "/var/lib/substrate";
const STATE_NAME = "muse-offsets.json";
const FETCH_TIMEOUT_MS = 3_000;

export interface MuseCounters {
	stored: number;
	refused: number;
	failed: number;
	fetch_failed: number;
	no_slug: number;
	orphan_pointer: number;
	/** Passes answered 304: the brief the file holds is still current. */
	unchanged: number;
}

export interface RepoRecord {
	last_success?: string;
	last_failure?: string;
	/** The `ETag` of the last 200, sent as `If-None-Match` on the next fetch. */
	etag?: string;
}

export interface MuseState {
	counters: MuseCounters;
	repos: Record<string, RepoRecord>;
}

export function emptyState(): MuseState {
	return {
		counters: { stored: 0, refused: 0, failed: 0, fetch_failed: 0, no_slug: 0, orphan_pointer: 0, unchanged: 0 },
		repos: {},
	};
}

/** Where per-repo timestamps and counters live. `SUBSTRATE_COLLECTOR_STATE` overrides the file. */
export function stateFile(): string {
	const override = process.env.SUBSTRATE_COLLECTOR_STATE?.trim();
	if (override) return override;
	const dir = process.env.SUBSTRATE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
	return join(dir, STATE_NAME);
}

export function loadState(path = stateFile()): MuseState {
	const state = emptyState();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { counters?: Record<string, unknown>; repos?: Record<string, unknown> };
		if (raw.counters && typeof raw.counters === "object") {
			for (const key of Object.keys(state.counters) as Array<keyof MuseCounters>) {
				const value = raw.counters[key];
				if (typeof value === "number" && Number.isFinite(value)) state.counters[key] = value;
			}
		}
		if (raw.repos && typeof raw.repos === "object") {
			for (const [repo, record] of Object.entries(raw.repos)) {
				if (record === null || typeof record !== "object") continue;
				const entry = record as Record<string, unknown>;
				const next: RepoRecord = {};
				if (typeof entry.last_success === "string") next.last_success = entry.last_success;
				if (typeof entry.last_failure === "string") next.last_failure = entry.last_failure;
				if (typeof entry.etag === "string" && entry.etag.length > 0 && entry.etag.length <= 256) next.etag = entry.etag;
				state.repos[repo] = next;
			}
		}
	} catch {
		return emptyState();
	}
	return state;
}

export function saveState(state: MuseState, path = stateFile()): void {
	const temporary = `${path}.tmp`;
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} catch (cause) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary file was never created.
		}
		journal(`cannot persist state: ${String(cause)}`);
	}
}

function journal(message: string): void {
	try {
		process.stderr.write(`[muse-collector] ${message}\n`);
	} catch {
		// A closed stderr must not fail the pass.
	}
}

function substrateUrl(): string {
	return (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
}

function bearer(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN;
	return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Absolute roots from `SUBSTRATE_MUSE_REPOS`. Relative entries are refused.
 * An empty or missing value is refused. There is no default list.
 */
export function repoList(raw: string | undefined): string[] {
	const repos = (raw ?? "").split(":").filter((entry) => entry.length > 0);
	if (repos.length === 0) {
		throw new Error(
			"SUBSTRATE_MUSE_REPOS is required: a colon-separated list of absolute repo roots.\n" +
				"  usage: SUBSTRATE_MUSE_REPOS=/path/to/repo[:/path/to/other] bun packages/collectors/src/muse.ts --once",
		);
	}
	for (const repo of repos) {
		if (!isAbsolute(repo)) throw new Error(`SUBSTRATE_MUSE_REPOS entry ${JSON.stringify(repo)} is not an absolute path`);
	}
	return repos;
}

export function pointerBlock(): string {
	return [
		MARKER_START,
		"Read `.substrate/BRIEF.md` at the start of your work in this repo. It is",
		"the current substrate brief — a record of what other agents did here.",
		"Substrate writes this file on a schedule; do not edit it by hand.",
		MARKER_END,
	].join("\n");
}

/** One `GET /healthz` per pass, with the same bearer the brief fetch uses. The ledger is usable only when `greptime` is true. */
export async function ledgerAvailable(): Promise<boolean> {
	try {
		const response = await fetch(`${substrateUrl()}/healthz`, {
			headers: { ...bearer() },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return false;
		const body = (await response.json()) as { greptime?: unknown };
		return body.greptime === true;
	} catch {
		return false;
	}
}

/** What one `POST /brief` came back as. `unchanged` is a 304 against the tag we sent. */
export type FetchedBrief =
	| { ok: true; unchanged: false; text: string; etag: string | null }
	| { ok: true; unchanged: true; etag: string }
	| { ok: false; reason: string };

/**
 * A good brief is 2xx with a non-empty body, or a 304 when `etag` was sent and
 * still matches. Anything else is a failed fetch. A 304 without a tag sent is
 * a server fault and counts as `http_304`.
 */
export async function fetchBrief(slug: string, branch: string | undefined, etag: string | null = null): Promise<FetchedBrief> {
	try {
		const response = await fetch(`${substrateUrl()}/brief`, {
			method: "POST",
			headers: { "content-type": "application/json", ...bearer(), ...(etag ? { "if-none-match": etag } : {}) },
			body: JSON.stringify({ repo: slug, branch: branch ?? null, surface: "muse" }),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.status === 304 && etag) return { ok: true, unchanged: true, etag };
		if (!response.ok) return { ok: false, reason: `http_${response.status}` };
		const text = await response.text();
		if (text.length === 0) return { ok: false, reason: "empty" };
		return { ok: true, unchanged: false, text, etag: response.headers.get("etag") };
	} catch {
		return { ok: false, reason: "network" };
	}
}

/** Write `text` by tmp + rename. Returns false when the bytes are already current. */
export function writeIfChanged(path: string, text: string): boolean {
	try {
		if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
	} catch {
		// Unreadable means we try to replace it.
	}
	const temporary = `${path}.${process.pid}.tmp`;
	mkdirSync(join(path, ".."), { recursive: true });
	try {
		writeFileSync(temporary, text);
		renameSync(temporary, path);
	} catch (cause) {
		try {
			unlinkSync(temporary);
		} catch {
			// Nothing to clean up.
		}
		throw cause;
	}
	return true;
}

interface MarkerSpan {
	start: number;
	end: number;
}

/** Complete marker pairs, or null when a start has no end (the file must not be touched). */
function markerSpans(text: string): MarkerSpan[] | null {
	const spans: MarkerSpan[] = [];
	let from = 0;
	while (from < text.length) {
		const start = text.indexOf(MARKER_START, from);
		if (start === -1) return spans;
		const endAt = text.indexOf(MARKER_END, start + MARKER_START.length);
		if (endAt === -1) return null;
		const end = endAt + MARKER_END.length;
		spans.push({ start, end });
		from = end;
	}
	return spans;
}

/**
 * Keep exactly one pointer block. Returns `orphan` when a start marker has no
 * end — the file is left as it was. Returns `unchanged` when no write is needed.
 */
export function ensurePointer(repo: string, counters: MuseCounters): "written" | "unchanged" | "orphan" {
	const agentsPath = join(repo, "AGENTS.md");
	let existing = "";
	if (existsSync(agentsPath)) {
		try {
			existing = readFileSync(agentsPath, "utf8");
		} catch (cause) {
			journal(`cannot read ${agentsPath}: ${String(cause)}; left untouched`);
			return "unchanged";
		}
	}
	const spans = markerSpans(existing);
	if (spans === null) {
		counters.orphan_pointer += 1;
		journal(`${repo}: AGENTS.md has an orphan brief marker; left untouched`);
		return "orphan";
	}
	const block = pointerBlock();
	let next: string;
	if (spans.length === 0) {
		const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${sep}${block}\n`;
	} else {
		let out = "";
		let cursor = 0;
		for (const [index, span] of spans.entries()) {
			out += existing.slice(cursor, span.start);
			if (index === 0) out += block;
			cursor = span.end;
		}
		out += existing.slice(cursor);
		next = out;
	}
	try {
		if (!writeIfChanged(agentsPath, next)) return "unchanged";
	} catch (cause) {
		journal(`cannot write ${agentsPath}: ${String(cause)}`);
		return "unchanged";
	}
	return "written";
}

/**
 * If `.substrate` exists and is not ignored, add it to the exclude file
 * `git rev-parse --git-path info/exclude` names. Local only; never committed.
 * In a worktree that path is the worktree git dir, not the main repo's.
 */
export function ensureExclude(repo: string): void {
	const relative = ".substrate";
	if (!existsSync(join(repo, relative))) return;
	const ignored = spawnSync("git", ["-C", repo, "check-ignore", "-q", relative], { encoding: "utf8" });
	if (ignored.status === 0) return;
	const located = spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
	if (located.status !== 0) return;
	const reported = located.stdout.trim();
	if (!reported) return;
	const excludePath = isAbsolute(reported) ? reported : join(repo, reported);
	let current = "";
	try {
		current = readFileSync(excludePath, "utf8");
	} catch {
		current = "";
	}
	const lines = current.split("\n").map((line) => line.trim());
	if (lines.includes(".substrate") || lines.includes(".substrate/")) return;
	const line = ".substrate/";
	const next = current.length === 0 ? `${line}\n` : current.endsWith("\n") ? `${current}${line}\n` : `${current}\n${line}\n`;
	try {
		mkdirSync(join(excludePath, ".."), { recursive: true });
		writeIfChanged(excludePath, next);
	} catch (cause) {
		journal(`cannot update exclude for ${repo}: ${String(cause)}`);
	}
}

function noteFailure(state: MuseState, repo: string, reason: string, now: string): void {
	state.counters.fetch_failed += 1;
	const record = state.repos[repo] ?? {};
	record.last_failure = now;
	state.repos[repo] = record;
	journal(`${repo}: fetch failed (${reason})`);
}

/**
 * The `BRIEF.md` path when `<repo>/.substrate` is a real directory inside the
 * repo. Null when the component is a symlink or resolves outside the repo —
 * the writer follows neither, so a linked `.substrate` can never redirect the
 * brief into another directory. The repo root itself is resolved first, so a
 * checkout named through a directory link still refreshes its brief.
 */
export function briefPathFor(repo: string): string | null {
	const dir = join(repo, ".substrate");
	try {
		if (lstatSync(dir).isSymbolicLink()) return null;
	} catch {
		// Absent: resolved below after creation. Anything else is refused.
		if (existsSync(dir)) return null;
	}
	const root = repo.replace(/\/+$/, "");
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		realRoot = root;
	}
	let realDir: string;
	try {
		realDir = realpathSync(dir);
	} catch {
		// Absent: creation lands `<realRoot>/.substrate`, so compare that.
		realDir = join(realRoot, ".substrate");
	}
	if (realDir !== realRoot && !realDir.startsWith(`${realRoot}/`)) return null;
	return join(dir, "BRIEF.md");
}

/**
 * One pass over the named roots. Never calls `/events`.
 *
 * A ledger that is down counts `fetch_failed` (`ledger_unavailable`) for every
 * repo and still ensures the pointer. A repo with no origin slug is skipped
 * and counted `no_slug`. A failed brief leaves `BRIEF.md` byte-identical. A
 * 304 against the stored tag counts `unchanged` and leaves it byte-identical
 * too; the tag is only sent while the file it describes still exists, so a
 * deleted `BRIEF.md` is fetched in full and rewritten.
 */
export async function pass(repos: string[], state: MuseState, now: string = new Date().toISOString()): Promise<void> {
	const ready = await ledgerAvailable();
	for (const repo of repos) {
		if (!ready) {
			noteFailure(state, repo, "ledger_unavailable", now);
			ensurePointer(repo, state.counters);
			continue;
		}
		const slug = repoSlug(repo);
		if (!slug) {
			state.counters.no_slug += 1;
			journal(`${repo}: no origin slug; skipped`);
			continue;
		}
		const record = state.repos[repo] ?? {};
		const briefPath = briefPathFor(repo);
		const known = record.etag && briefPath && existsSync(briefPath) ? record.etag : null;
		const fetched = await fetchBrief(slug, branchFor(repo), known);
		if (!fetched.ok) {
			noteFailure(state, repo, fetched.reason, now);
			ensurePointer(repo, state.counters);
			ensureExclude(repo);
			continue;
		}
		if (!briefPath) {
			noteFailure(state, repo, "brief_dir_outside_repo", now);
			ensurePointer(repo, state.counters);
			continue;
		}
		if (fetched.unchanged) {
			state.counters.unchanged += 1;
		} else {
			try {
				writeIfChanged(briefPath, redact(fetched.text));
			} catch (cause) {
				noteFailure(state, repo, "write", now);
				journal(`cannot write brief for ${repo}: ${String(cause)}`);
				ensurePointer(repo, state.counters);
				continue;
			}
			if (fetched.etag) record.etag = fetched.etag;
			else delete record.etag;
		}
		ensureExclude(repo);
		ensurePointer(repo, state.counters);
		record.last_success = now;
		state.repos[repo] = record;
	}
	saveState(state);
}

if (import.meta.main) {
	let repos: string[];
	try {
		repos = repoList(process.env.SUBSTRATE_MUSE_REPOS);
	} catch (cause) {
		process.stderr.write(`[muse-collector] ${(cause as Error).message}\n`);
		process.exit(1);
	}
	const watch = process.argv.includes("--watch");
	const state = loadState();
	await pass(repos, state);
	process.stdout.write(`[muse-collector] delivered briefs for ${repos.length} repo(s)\n`);
	if (watch) {
		process.stdout.write(`[muse-collector] watching ${repos.length} repo(s) every ${POLL_MS}ms\n`);
		for (;;) {
			await Bun.sleep(POLL_MS);
			await pass(repos, loadState());
		}
	}
}
