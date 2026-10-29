/**
 * Read an exported Greptile knowledge base (v1.7 phase 63).
 *
 * The export is a directory laid out as `<dir>/<owner>/<repo>/<relative path>.md`, one markdown file per knowledge-base
 * document. Entries have `repo: owner/repo`, `kind: "greptile-kb"`, tier 2 and `source: "greptile"`, and follow the same
 * size and UTF-8 rules as a filesystem scan. They carry no commit: the export is a synthesis, not a checkout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DirEntry, readEntries } from "../discover.ts";
import { isValidPath } from "../names.ts";
import { type CorpusEntry, documentKey, type DocTier } from "../protocol.ts";
import {
	type AdapterResult,
	compareEntries,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TIER,
	defaultLstat,
	type FileStat,
	loadDocument,
	type RepoReport,
	SkipLog,
} from "../scan.ts";

/** The tier of every Greptile knowledge-base document. */
export const GREPTILE_TIER: DocTier = 2;

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;

export interface GreptileScanOptions {
	maxTier?: DocTier | undefined;
	maxBytes?: number | undefined;
	/** Only the first `maxRepos` repositories (sorted by `owner/repo`) are read. Default: all. */
	maxRepos?: number | undefined;
	readFile?: ((path: string) => Uint8Array) | undefined;
	lstat?: ((path: string) => FileStat | null) | undefined;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export async function scanGreptileExport(dir: string, opts: GreptileScanOptions = {}): Promise<AdapterResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const readFile = opts.readFile ?? ((path: string) => readFileSync(path));
	const lstat = opts.lstat ?? defaultLstat;
	const skips = new SkipLog();
	const entries: CorpusEntry[] = [];
	const paths = new Map<string, string>();
	const repos: RepoReport[] = [];
	const notes: string[] = [];
	const result = (): AdapterResult => ({
		entries: entries.sort(compareEntries),
		repos: repos.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)),
		skipped: skips.listed,
		skippedByReason: skips.byReason,
		notes,
		paths,
	});

	if ((opts.maxTier ?? DEFAULT_MAX_TIER) < GREPTILE_TIER) {
		notes.push(`greptile export not read: its documents are tier ${GREPTILE_TIER}, above the requested tier`);
		return result();
	}

	let owners: DirEntry[];
	try {
		owners = readEntries(dir);
	} catch (cause) {
		notes.push(`cannot read the greptile export ${dir}: ${message(cause)}`);
		return result();
	}

	const candidates: Array<{ repo: string; dir: string }> = [];
	for (const owner of owners) {
		if (owner.kind !== "dir" || !OWNER_OR_REPO.test(owner.name)) continue;
		let children: DirEntry[];
		try {
			children = readEntries(join(dir, owner.name));
		} catch (cause) {
			notes.push(`cannot read ${owner.name}: ${message(cause)}`);
			continue;
		}
		for (const child of children) {
			if (child.kind === "dir" && OWNER_OR_REPO.test(child.name)) {
				candidates.push({ repo: `${owner.name}/${child.name}`, dir: join(dir, owner.name, child.name) });
			}
		}
	}
	candidates.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
	const limit = opts.maxRepos === undefined ? candidates.length : Math.max(0, Math.floor(opts.maxRepos));
	if (candidates.length > limit) notes.push(`${candidates.length - limit} greptile repositories left unread by the repository cap`);

	for (const candidate of candidates.slice(0, limit)) {
		const problems: string[] = [];
		let files = 0;
		let bytes = 0;
		const walk = (current: string, prefix: string): void => {
			let children: DirEntry[];
			try {
				children = readEntries(current);
			} catch (cause) {
				problems.push(`cannot read directory ${prefix === "" ? "." : prefix}: ${message(cause)}`);
				return;
			}
			for (const child of children) {
				const rel = prefix === "" ? child.name : `${prefix}/${child.name}`;
				const abs = join(current, child.name);
				if (child.kind === "dir") {
					walk(abs, rel);
					continue;
				}
				if ((child.kind !== "file" && child.kind !== "symlink") || !child.name.toLowerCase().endsWith(".md")) continue;
				// The server refuses a whole plan for one path that breaks its rules; such a file is skipped here, before anything else sees it.
				if (!isValidPath(rel)) {
					skips.add({ repo: candidate.repo, path: rel, reason: "bad-path" });
					continue;
				}
				const loaded = loadDocument(abs, { maxBytes, readFile, lstat });
				if (!loaded.ok) {
					skips.add({ repo: candidate.repo, path: rel, reason: loaded.reason });
					if (loaded.problem !== undefined) problems.push(`${rel}: ${loaded.problem}`);
					continue;
				}
				entries.push({
					repo: candidate.repo,
					path: rel,
					kind: "greptile-kb",
					tier: GREPTILE_TIER,
					sha256: loaded.sha256,
					bytes: loaded.bytes,
					source: "greptile",
				});
				paths.set(documentKey(candidate.repo, rel), abs);
				files += 1;
				bytes += loaded.bytes;
			}
		};
		walk(candidate.dir, "");
		repos.push({
			repo: candidate.repo,
			dir: candidate.dir,
			source: "greptile",
			files,
			bytes,
			complete: problems.length === 0,
			...(problems.length === 0 ? {} : { incomplete: problems.slice(0, 3).join("; ") }),
		});
	}
	return result();
}
