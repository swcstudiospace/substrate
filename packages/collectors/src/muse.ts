#!/usr/bin/env bun
/**
 * Muse Code brief writer.
 *
 * Muse is a closed binary. Its hook event set has no prompt-submission hook,
 * so there is no live way to inject a brief into a turn. The reachable design
 * is a static file: this collector POSTs `/brief` for each named repo, writes
 * the (redacted) result to `<repo>/.substrate/BRIEF.md`, and makes sure that
 * repo's `AGENTS.md` points a Muse session at it.
 *
 *   SUBSTRATE_MUSE_REPOS=/a:/b bun packages/collectors/src/muse.ts --once
 *   SUBSTRATE_MUSE_REPOS=/a:/b bun packages/collectors/src/muse.ts --watch
 *
 * `SUBSTRATE_MUSE_REPOS` is required — a colon-separated list of absolute
 * repo roots. There is no inferred default: this host's repo tree holds other
 * sessions' uncommitted work, and a collector that guesses which repos to
 * write into is exactly the failure this project already recorded a lesson
 * about. The operator names the blast radius.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

const SUBSTRATE_URL = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
// Briefs move slowly compared to tool calls; there is no reason to hammer /brief.
const POLL_MS = 5 * 60 * 1000;

export const MARKER_START = "<!-- substrate-brief:start -->";
export const MARKER_END = "<!-- substrate-brief:end -->";

function pointerBlock(): string {
	return [
		MARKER_START,
		"Read `.substrate/BRIEF.md` at the start of your work in this repo. It is",
		"the current substrate brief — a record of what other agents did here.",
		"Substrate writes this file on a schedule; do not edit it by hand.",
		MARKER_END,
	].join("\n");
}

/** Current branch for a repo, or undefined when it cannot be resolved. */
export function branchFor(repo: string): string | undefined {
	const result = spawnSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/** Fetch the brief for a repo. Returns null on any failure or an empty body. */
export async function fetchBrief(repo: string, branch: string | undefined): Promise<string | null> {
	try {
		const response = await fetch(`${SUBSTRATE_URL}/brief`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUBSTRATE_TOKEN ? { authorization: `Bearer ${process.env.SUBSTRATE_TOKEN}` } : {}),
			},
			body: JSON.stringify({ repo, branch, surface: "muse" }),
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) return null;
		const text = await response.text();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

async function emit(event: EventInput): Promise<boolean> {
	try {
		const response = await fetch(`${SUBSTRATE_URL}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUBSTRATE_TOKEN ? { authorization: `Bearer ${process.env.SUBSTRATE_TOKEN}` } : {}),
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Write `text` to `<repo>/.substrate/BRIEF.md`. Never throws: a filesystem
 * failure logs to stderr and returns null so the caller can skip the event.
 */
export function writeBrief(repo: string, text: string): number | null {
	const briefPath = join(repo, ".substrate", "BRIEF.md");
	try {
		mkdirSync(dirname(briefPath), { recursive: true });
		writeFileSync(briefPath, text);
		return Buffer.byteLength(text);
	} catch (cause) {
		process.stderr.write(`[muse-collector] cannot write ${briefPath}: ${String(cause)}\n`);
		return null;
	}
}

/**
 * Ensure `<repo>/AGENTS.md` carries the substrate-brief pointer block.
 * Rewrites only the content between the markers; a byte outside them is
 * never touched, and a missing file is created.
 */
export function ensurePointer(repo: string): void {
	const agentsPath = join(repo, "AGENTS.md");
	const block = pointerBlock();

	let existing = "";
	if (existsSync(agentsPath)) {
		try {
			existing = readFileSync(agentsPath, "utf8");
		} catch {
			existing = "";
		}
	}

	const startIdx = existing.indexOf(MARKER_START);
	const endIdx = existing.indexOf(MARKER_END);

	let next: string;
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const before = existing.slice(0, startIdx);
		const after = existing.slice(endIdx + MARKER_END.length);
		next = `${before}${block}${after}`;
	} else {
		const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${sep}${block}\n`;
	}

	try {
		mkdirSync(dirname(agentsPath), { recursive: true });
		writeFileSync(agentsPath, next);
	} catch (cause) {
		process.stderr.write(`[muse-collector] cannot write ${agentsPath}: ${String(cause)}\n`);
	}
}

/** Deliver a current brief to one repo: fetch, redact, write, point, emit. */
export async function deliverTo(repo: string): Promise<void> {
	const branch = branchFor(repo);
	const brief = await fetchBrief(repo, branch);

	if (brief !== null) {
		const redacted = redact(brief);
		const bytes = writeBrief(repo, redacted);
		ensurePointer(repo);
		if (bytes !== null) {
			await emit({
				surface: "muse",
				kind: "brief.delivered",
				summary: `delivered brief to ${repo}`,
				repo,
				branch,
				payload: { bytes },
			});
		}
	} else {
		// A failed or empty fetch leaves any existing BRIEF.md exactly as it is —
		// a stale brief is strictly better than an empty one. The pointer is
		// still ensured, since it is valid whether or not this pass refreshed it.
		ensurePointer(repo);
	}
}

function usage(): never {
	process.stderr.write(
		"[muse-collector] SUBSTRATE_MUSE_REPOS is required: a colon-separated list of absolute repo roots.\n" +
			"  usage: SUBSTRATE_MUSE_REPOS=/path/to/repo[:/path/to/other] bun packages/collectors/src/muse.ts --once\n",
	);
	process.exit(1);
}

async function pass(repos: string[]): Promise<void> {
	for (const repo of repos) await deliverTo(repo);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const watch = args.includes("--watch");

	const raw = process.env.SUBSTRATE_MUSE_REPOS;
	const repos = raw ? raw.split(":").filter((r) => r.length > 0) : [];
	if (repos.length === 0) usage();

	await pass(repos);
	process.stdout.write(`[muse-collector] delivered briefs to ${repos.length} repo(s)\n`);

	if (watch) {
		process.stdout.write(`[muse-collector] watching ${repos.length} repo(s) every ${POLL_MS}ms\n`);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			await pass(repos);
		}
	}
}
