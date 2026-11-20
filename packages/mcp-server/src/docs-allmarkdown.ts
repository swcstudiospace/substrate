/**
 * The all-markdown docs ingest: an operator job that reads every `.md` file under the repo checkouts and worktrees
 * on this machine, runs each page through the same secret gate the guarded ingest uses, and sends the pages that
 * pass to `ingestDocs`, one LightRAG dataset per repo.
 *
 * Selection (the dry run's method): the children of each root are units. A child of the repos root is a repo
 * checkout. Any other child is a worktree, attributed to its repo through its `.git` file, or else a standalone
 * group of its own. Only `*.md` regular files are read. Symlinks are skipped and counted. `node_modules`, `.git`,
 * `dist`, `build` and the other excluded directory names are pruned. A directory whose name starts with `.` is not a
 * repo or a worktree: discovery skips it at both levels and counts it. Paths under `/.planning/milestones/` are
 * counted and never read. A file over {@link INGEST_PAGE_MAX_BYTES} is counted from its stat and never read.
 *
 * Dedup is by raw-byte sha256 within one group, so a repo and its worktrees share one copy: the first copy in unit
 * order (the checkout, then worktrees by name) is kept.
 *
 * Gate: each candidate is composed as `checkIngestPage` composes it (stripped body, file:// source URL, commit,
 * empty heading, planning-graph strings) and run through `findingRules`. A refused page is never sent. It is
 * written to the leave-out file with its path, rule names and content hash only, and no matched text or secret value
 * is written anywhere.
 *
 * `planAllMarkdown` does the selection and gate and returns the plan. It touches nothing outside the injected
 * filesystem port. `runAllMarkdownIngest` writes `report.json`, `summary.md` and `leave-out.json` into the state
 * directory. It calls the ingest only with `apply`, so a dry run never does.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { stripRemoteImages } from "@substrate/corpus";
import {
	batchPagesForIngest,
	extractPlanningGraphHint,
	findingRules,
	INGEST_PAGE_MAX_BYTES,
	isPlanningPage,
	type IngestInput,
	type IngestOutcome,
	type IngestPage,
} from "./docs-ingest.ts";
import { planningSessionId } from "./planning/checkout.ts";
import { nodePlanningFs } from "./planning/fs.ts";
import type { PlanningGraphHint } from "./types.ts";

/** Directory names pruned from every walk, as the dry run prunes them. */
export const ALL_MARKDOWN_EXCLUDED_DIRS: readonly string[] = [
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo",
	".parcel-cache", "coverage", "target", ".cache", "__pycache__", ".venv", "venv",
];

const EXCLUDED = new Set(ALL_MARKDOWN_EXCLUDED_DIRS);
const MILESTONE_SEGMENT = "/.planning/milestones/";
const MARKDOWN_NAME = /\.md$/i;
const PAGE_CONCURRENCY = 16;

export type EntryKind = "file" | "dir" | "symlink" | "other";

/**
 * The filesystem and git calls the job makes, injectable so the tests run on fakes. `list` and `read` throw on
 * failure; `kindOf` answers null for an absent path.
 */
export interface MarkdownFs {
	/** The entries of a directory, not following links. Throws when it cannot be listed. */
	list(dir: string): Promise<Array<{ name: string; kind: EntryKind }>>;
	/** Whether `path` is a directory, following links. False when absent. */
	isDirectory(path: string): Promise<boolean>;
	/** The kind of `path`, not following links; null when absent. */
	kindOf(path: string): Promise<EntryKind | null>;
	/** The size in bytes of a file. Throws when it cannot be stat'ed. */
	size(path: string): Promise<number>;
	/** The raw bytes of a file. Throws when it cannot be read. */
	read(path: string): Promise<Uint8Array>;
	/** The UTF-8 text of a small file. Throws when it cannot be read. */
	readText(path: string): Promise<string>;
	/** The HEAD commit of the checkout at `root`, or undefined when it has none. */
	headCommit(root: string): Promise<string | undefined>;
	/** The checkout key the planning plane names a checkout by (`planningSessionId`). */
	checkoutKey(root: string): string;
}

/** The real filesystem and git, read-only. */
export function nodeMarkdownFs(): MarkdownFs {
	const planning = nodePlanningFs();
	return {
		async list(dir) {
			const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, kind: direntKind(entry) }));
		},
		async isDirectory(path) {
			return stat(path).then(
				(found) => found.isDirectory(),
				() => false,
			);
		},
		async kindOf(path) {
			try {
				return statKind(await lstat(path));
			} catch (cause) {
				if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return null;
				throw cause;
			}
		},
		async size(path) {
			return (await stat(path)).size;
		},
		async read(path) {
			return readFile(path);
		},
		async readText(path) {
			return readFile(path, "utf8");
		},
		async headCommit(root) {
			try {
				const sha = execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
			} catch {
				return undefined;
			}
		},
		checkoutKey(root) {
			return planningSessionId(planning, root);
		},
	};
}

function direntKind(entry: Dirent): EntryKind {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "dir";
	if (entry.isFile()) return "file";
	return "other";
}

function statKind(found: Stats): EntryKind {
	if (found.isSymbolicLink()) return "symlink";
	if (found.isDirectory()) return "dir";
	if (found.isFile()) return "file";
	return "other";
}

export interface AllMarkdownError {
	path: string;
	op: string;
	code: string;
}

function errorOf(path: string, op: string, cause: unknown): AllMarkdownError {
	const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "UNKNOWN";
	return { path, op, code };
}

export interface AllMarkdownUnit {
	kind: "checkout" | "worktree";
	name: string;
	path: string;
	/** How a worktree was attributed: `repo:<name>`, `standalone-clone`, `external:<dir>` and so on. A checkout reads `checkout`. */
	attribution: string;
}

export interface AllMarkdownGroup {
	/** The repo name for a repo group; the checkout key (`planningSessionId`) for a standalone worktree. */
	key: string;
	kind: "repo" | "worktree-standalone";
	/** The checkout first, then worktrees by name. The first unit is the primary one. */
	units: AllMarkdownUnit[];
	/** The HEAD commit of the primary unit, when it has one. */
	commit: string | undefined;
}

export interface DiscoveredGroups {
	groups: AllMarkdownGroup[];
	errors: AllMarkdownError[];
	/** Directory names under a root that the excluded list pruned. */
	excluded_root_entries: string[];
	/** Dot-named directories skipped at discovery under the repos root or a root: never a repo, never a worktree. */
	dot_dirs_skipped: number;
}

/** What discovery set aside: excluded directory names by name, and dot-named directories by count. */
interface DiscoverySkips {
	excluded: string[];
	dot_dirs: number;
}

interface Attribution {
	attribution: string;
	repo?: string;
}

/**
 * The groups under `roots`. The children of `reposRoot` are repo checkouts. The children of every other root are
 * worktrees, attributed through their `.git` file to a repo checkout, or else standalone. A root that is the repos
 * root is not walked twice.
 */
export async function discoverGroups(fs: MarkdownFs, options: { roots: readonly string[]; reposRoot: string }): Promise<DiscoveredGroups> {
	const errors: AllMarkdownError[] = [];
	const skipped: DiscoverySkips = { excluded: [], dot_dirs: 0 };
	const repoRoot = resolvePath(options.reposRoot);
	const repoNames = new Set<string>();
	const groups = new Map<string, AllMarkdownGroup>();
	const seenPaths = new Set<string>();
	for (const name of await childDirectories(fs, repoRoot, errors, skipped)) {
		const path = join(repoRoot, name);
		repoNames.add(name);
		seenPaths.add(path);
		groups.set(name, { key: name, kind: "repo", units: [{ kind: "checkout", name, path, attribution: "checkout" }], commit: undefined });
	}
	for (const root of options.roots.map((entry) => resolvePath(entry))) {
		if (root === repoRoot) continue;
		for (const name of await childDirectories(fs, root, errors, skipped)) {
			const path = join(root, name);
			if (seenPaths.has(path)) continue;
			seenPaths.add(path);
			const attributed = await attribute(fs, path, repoRoot, repoNames, errors);
			const unit: AllMarkdownUnit = { kind: "worktree", name, path, attribution: attributed.attribution };
			if (attributed.repo !== undefined) {
				groups.get(attributed.repo)?.units.push(unit);
			} else {
				const key = fs.checkoutKey(path);
				groups.set(key, { key, kind: "worktree-standalone", units: [unit], commit: undefined });
			}
		}
	}
	const list = [...groups.values()].sort((a, b) => compare(a.key, b.key));
	for (const group of list) {
		group.units.sort((a, b) => (a.kind === b.kind ? compare(a.name, b.name) : a.kind === "checkout" ? -1 : 1));
		const primary = group.units[0];
		group.commit = primary === undefined ? undefined : await fs.headCommit(primary.path);
	}
	return { groups: list, errors, excluded_root_entries: skipped.excluded.sort(), dot_dirs_skipped: skipped.dot_dirs };
}

/** The sorted names of the directories directly under `dir`, following links. Excluded and dot-named names are set aside and counted. */
async function childDirectories(fs: MarkdownFs, dir: string, errors: AllMarkdownError[], skipped: DiscoverySkips): Promise<string[]> {
	let entries: Array<{ name: string; kind: EntryKind }>;
	try {
		entries = await fs.list(dir);
	} catch (cause) {
		errors.push(errorOf(dir, "readdir", cause));
		return [];
	}
	const names: string[] = [];
	for (const entry of entries) {
		const isDir = entry.kind === "dir" || (entry.kind === "symlink" && (await fs.isDirectory(join(dir, entry.name))));
		if (!isDir) continue;
		// A dot-named directory is neither a repo checkout nor a worktree (`.bg-shell`, `.gsd`, `.pytest_cache`).
		if (entry.name.startsWith(".")) {
			skipped.dot_dirs++;
			continue;
		}
		if (EXCLUDED.has(entry.name)) {
			skipped.excluded.push(entry.name);
			continue;
		}
		names.push(entry.name);
	}
	return names.sort(compare);
}

/** Attributes a worktree to its repo by the `gitdir:` line of its `.git` file, the way the dry run does. */
async function attribute(fs: MarkdownFs, path: string, repoRoot: string, repoNames: ReadonlySet<string>, errors: AllMarkdownError[]): Promise<Attribution> {
	const gitPath = join(path, ".git");
	let kind: EntryKind | null;
	try {
		kind = await fs.kindOf(gitPath);
	} catch (cause) {
		errors.push(errorOf(gitPath, "lstat", cause));
		return { attribution: "unparsed" };
	}
	if (kind === null) return { attribution: "no-git-entry" };
	if (kind === "dir") return { attribution: "standalone-clone" };
	if (kind !== "file") return { attribution: "unparsed" };
	let text: string;
	try {
		text = await fs.readText(gitPath);
	} catch (cause) {
		errors.push(errorOf(gitPath, "read", cause));
		return { attribution: "unparsed" };
	}
	const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
	const at = gitdir?.indexOf("/.git/worktrees/") ?? -1;
	if (gitdir === undefined || at < 0) return { attribution: "unparsed" };
	const common = gitdir.slice(0, at);
	if (common.startsWith(`${repoRoot}/`)) {
		const name = common.slice(repoRoot.length + 1);
		if (repoNames.has(name)) return { attribution: `repo:${name}`, repo: name };
		return { attribution: `missing-repo:${name}` };
	}
	return { attribution: `external:${common}` };
}

interface Candidate {
	unit: AllMarkdownUnit;
	/** The path inside the unit, `/`-separated. This is the path the page is posted under. */
	rel: string;
	abs: string;
}

interface WalkResult {
	candidates: Candidate[];
	milestone_md_excluded: number;
	symlinks_skipped: number;
	excluded_dirs: Record<string, number>;
	errors: AllMarkdownError[];
}

/** Every candidate `.md` file under one unit, in sorted order. */
async function walkUnit(fs: MarkdownFs, unit: AllMarkdownUnit): Promise<WalkResult> {
	const result: WalkResult = { candidates: [], milestone_md_excluded: 0, symlinks_skipped: 0, excluded_dirs: {}, errors: [] };
	await walkDir(fs, unit, unit.path, "", result);
	return result;
}

async function walkDir(fs: MarkdownFs, unit: AllMarkdownUnit, dir: string, rel: string, out: WalkResult): Promise<void> {
	let entries: Array<{ name: string; kind: EntryKind }>;
	try {
		entries = (await fs.list(dir)).sort((a, b) => compare(a.name, b.name));
	} catch (cause) {
		out.errors.push(errorOf(dir, "readdir", cause));
		return;
	}
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.kind === "symlink") {
			if (MARKDOWN_NAME.test(entry.name)) out.symlinks_skipped++;
			continue;
		}
		if (entry.kind === "dir") {
			if (EXCLUDED.has(entry.name)) {
				out.excluded_dirs[entry.name] = (out.excluded_dirs[entry.name] ?? 0) + 1;
				continue;
			}
			if (`${abs}/`.includes(MILESTONE_SEGMENT)) {
				out.milestone_md_excluded += await countMarkdown(fs, abs, out.errors);
				continue;
			}
			await walkDir(fs, unit, abs, path, out);
			continue;
		}
		if (entry.kind === "file" && MARKDOWN_NAME.test(entry.name)) out.candidates.push({ unit, rel: path, abs });
	}
}

/** The `.md` files under a directory that is counted and never read (milestone archives). */
async function countMarkdown(fs: MarkdownFs, dir: string, errors: AllMarkdownError[]): Promise<number> {
	let entries: Array<{ name: string; kind: EntryKind }>;
	try {
		entries = await fs.list(dir);
	} catch (cause) {
		errors.push(errorOf(dir, "readdir", cause));
		return 0;
	}
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "dir" && !EXCLUDED.has(entry.name)) count += await countMarkdown(fs, join(dir, entry.name), errors);
		else if (entry.kind === "file" && MARKDOWN_NAME.test(entry.name)) count++;
	}
	return count;
}

type PageState = "clean" | "refused" | "over-cap" | "page-too-large" | "unreadable";

/** One candidate after its gates. `page` is set for a clean page only. */
interface Gated {
	abs: string;
	state: PageState;
	size: number;
	sha: string;
	rules: string[];
	page?: IngestPage;
}

interface Inspected extends Gated {
	/** Whether the file sits under `.planning/` in its unit. */
	planning: boolean;
}

/**
 * One candidate's gates, in the order the ingest applies them: the raw size cap (a stat, before any read), the read,
 * the stripped-size cap, then the secret gate over the composed text.
 */
async function inspectCandidate(fs: MarkdownFs, group: AllMarkdownGroup, candidate: Candidate, errors: AllMarkdownError[]): Promise<Gated> {
	const { abs } = candidate;
	let size: number;
	try {
		size = await fs.size(abs);
	} catch (cause) {
		errors.push(errorOf(abs, "stat", cause));
		return { abs, state: "unreadable", size: 0, sha: "", rules: [] };
	}
	if (size > INGEST_PAGE_MAX_BYTES) return { abs, state: "over-cap", size, sha: "", rules: [] };
	let bytes: Uint8Array;
	try {
		bytes = await fs.read(abs);
	} catch (cause) {
		errors.push(errorOf(abs, "read", cause));
		return { abs, state: "unreadable", size, sha: "", rules: [] };
	}
	const sha = createHash("sha256").update(bytes).digest("hex");
	const raw = Buffer.from(bytes).toString("utf8");
	let body: string;
	let rules: string[];
	const sourceUrl = pathToFileURL(abs).href;
	const planning = isPlanningPage(candidate.rel);
	const graph = planning ? extractPlanningGraphHint(candidate.rel, raw) : undefined;
	try {
		body = stripRemoteImages(raw).body;
	} catch (cause) {
		errors.push(errorOf(abs, "strip", cause));
		return { abs, state: "unreadable", size, sha, rules: [] };
	}
	if (Buffer.byteLength(body, "utf8") > INGEST_PAGE_MAX_BYTES) return { abs, state: "page-too-large", size, sha, rules: [] };
	try {
		// The ingest's composition: body, source URL, commit, heading (empty for a sweep page), graph strings.
		rules = findingRules(`${body}\n${sourceUrl}\n${group.commit ?? ""}\n\n${graphText(graph)}`);
	} catch (cause) {
		errors.push(errorOf(abs, "gate", cause));
		return { abs, state: "unreadable", size, sha, rules: [] };
	}
	if (rules.length > 0) return { abs, state: "refused", size, sha, rules };
	return {
		abs,
		state: "clean",
		size,
		sha,
		rules: [],
		// A planning page carries the key of the checkout it was read from, which the ingest requires. The key names the
		// unit the file sits in (the checkout, or the worktree), so one path in two checkouts never shares a name.
		page: {
			path: candidate.rel,
			source_url: sourceUrl,
			body: raw,
			...(graph !== undefined ? { graph } : {}),
			...(planning ? { checkout: fs.checkoutKey(candidate.unit.path) } : {}),
		},
	};
}

/** The graph strings the ingest composes into the gate: the phase, entities, and each relation's endpoints and kind. */
function graphText(hint: PlanningGraphHint | undefined): string {
	if (hint === undefined) return "";
	return [hint.phase, ...hint.entities, ...hint.relations.flatMap((relation) => [relation.source, relation.target, relation.kind])].join("\n");
}

export interface GroupPlan {
	group: string;
	kind: AllMarkdownGroup["kind"];
	dataset: string | null;
	dataset_known: boolean;
	commit: string | null;
	checkout: string;
	worktrees: string[];
	status: "send" | "skipped-unknown-dataset" | "nothing-to-send";
	md_files: number;
	md_bytes: number;
	planning_files: number;
	milestone_md_excluded: number;
	symlinks_skipped: number;
	excluded_dirs: Record<string, number>;
	over_cap_files: number;
	over_cap_bytes: number;
	over_cap_after_strip_files: number;
	unreadable_files: number;
	gate_checked_files: number;
	gate_refused_files: number;
	duplicate_files: number;
	duplicate_bytes: number;
	unique_clean_files: number;
	send_files: number;
	send_bytes: number;
	send_batches: number;
	errors: number;
}

export interface LeaveOutGroup {
	group: string;
	dataset: string | null;
	/** Only the path, the rule names and the content hash. Never a matched value or any page text. */
	refused: Array<{ path: string; rules: string[]; sha256: string }>;
}

export interface AllMarkdownPlan {
	generated_at: string;
	scope: {
		roots: string[];
		repos_root: string;
		excluded_dir_names: readonly string[];
		page_cap_bytes: number;
		selection: string;
		gate: string;
		dedup: string;
	};
	groups: GroupPlan[];
	leave_out: LeaveOutGroup[];
	errors: Array<AllMarkdownError & { group: string }>;
	excluded_root_entries: string[];
	/** Dot-named directories skipped at discovery, counted for the report. */
	dot_dirs_skipped: number;
	/** The batches each sending group posts, in order. Not written to the report. */
	batches: Map<string, IngestPage[][]>;
}

export interface PlanInput {
	fs: MarkdownFs;
	discovered: DiscoveredGroups;
	/** The dataset each group is filed under: the planning registry's name for the group's primary checkout. */
	datasets: ReadonlyMap<string, string>;
	/** Every dataset the guarded ingest accepts. A group filed under another is reported and never sent. */
	known: ReadonlySet<string>;
	roots: readonly string[];
	reposRoot: string;
	generatedAt: string;
}

/** The selection and gate, group by group. Reads files; sends nothing. */
export async function planAllMarkdown(input: PlanInput): Promise<AllMarkdownPlan> {
	const { fs } = input;
	const groups: GroupPlan[] = [];
	const leaveOut: LeaveOutGroup[] = [];
	const errors: Array<AllMarkdownError & { group: string }> = input.discovered.errors.map((error) => ({ ...error, group: "(discovery)" }));
	const batches = new Map<string, IngestPage[][]>();
	for (const group of input.discovered.groups) {
		const dataset = input.datasets.get(group.key) ?? null;
		const datasetKnown = dataset !== null && input.known.has(dataset);
		const groupErrors: AllMarkdownError[] = [];
		const inspected: Inspected[] = [];
		const plan: GroupPlan = {
			group: group.key,
			kind: group.kind,
			dataset,
			dataset_known: datasetKnown,
			commit: group.commit ?? null,
			checkout: group.units[0]?.path ?? "",
			worktrees: group.units.filter((unit) => unit.kind === "worktree").map((unit) => unit.name),
			status: "nothing-to-send",
			md_files: 0,
			md_bytes: 0,
			planning_files: 0,
			milestone_md_excluded: 0,
			symlinks_skipped: 0,
			excluded_dirs: {},
			over_cap_files: 0,
			over_cap_bytes: 0,
			over_cap_after_strip_files: 0,
			unreadable_files: 0,
			gate_checked_files: 0,
			gate_refused_files: 0,
			duplicate_files: 0,
			duplicate_bytes: 0,
			unique_clean_files: 0,
			send_files: 0,
			send_bytes: 0,
			send_batches: 0,
			errors: 0,
		};
		const leave: LeaveOutGroup = { group: group.key, dataset, refused: [] };
		for (const unit of group.units) {
			const walked = await walkUnit(fs, unit);
			groupErrors.push(...walked.errors);
			plan.milestone_md_excluded += walked.milestone_md_excluded;
			plan.symlinks_skipped += walked.symlinks_skipped;
			for (const [name, count] of Object.entries(walked.excluded_dirs)) plan.excluded_dirs[name] = (plan.excluded_dirs[name] ?? 0) + count;
			const gated = await mapLimit(walked.candidates, PAGE_CONCURRENCY, async (candidate) => ({
				...(await inspectCandidate(fs, group, candidate, groupErrors)),
				planning: candidate.rel.startsWith(".planning/"),
			}));
			inspected.push(...gated);
		}
		const seen = new Set<string>();
		const unique: IngestPage[] = [];
		let uniqueBytes = 0;
		for (const item of inspected) {
			plan.md_files++;
			if (item.planning) plan.planning_files++;
			if (item.state !== "unreadable") plan.md_bytes += item.size;
			switch (item.state) {
				case "over-cap":
					plan.over_cap_files++;
					plan.over_cap_bytes += item.size;
					break;
				case "page-too-large":
					plan.over_cap_after_strip_files++;
					break;
				case "unreadable":
					plan.unreadable_files++;
					break;
				case "refused":
					plan.gate_checked_files++;
					plan.gate_refused_files++;
					leave.refused.push({ path: item.abs, rules: item.rules, sha256: item.sha });
					break;
				case "clean": {
					plan.gate_checked_files++;
					if (seen.has(item.sha)) {
						plan.duplicate_files++;
						plan.duplicate_bytes += item.size;
						break;
					}
					seen.add(item.sha);
					if (item.page !== undefined) {
						unique.push(item.page);
						uniqueBytes += item.size;
					}
					break;
				}
			}
		}
		plan.unique_clean_files = unique.length;
		plan.errors = groupErrors.length;
		for (const error of groupErrors) errors.push({ ...error, group: group.key });
		if (!datasetKnown) {
			plan.status = "skipped-unknown-dataset";
		} else if (unique.length > 0) {
			const groupBatches = batchPagesForIngest(unique);
			batches.set(group.key, groupBatches);
			plan.status = "send";
			plan.send_files = unique.length;
			plan.send_bytes = uniqueBytes;
			plan.send_batches = groupBatches.length;
		}
		groups.push(plan);
		if (leave.refused.length > 0) leaveOut.push(leave);
	}
	return {
		generated_at: input.generatedAt,
		scope: {
			roots: [...input.roots],
			repos_root: resolvePath(input.reposRoot),
			excluded_dir_names: ALL_MARKDOWN_EXCLUDED_DIRS,
			page_cap_bytes: INGEST_PAGE_MAX_BYTES,
			selection:
				"*.md regular files under each root's children (repo checkouts under the repos root; worktrees elsewhere, attributed by .git); symlinks skipped and counted; excluded directory names pruned; dot-named directories skipped at discovery and counted; /.planning/milestones/ counted, never read; files over the page cap counted from stat, never read",
			gate: "findingRules over stripped body, file:// source URL, commit, empty heading and planning-graph strings, the ingest's composition; refused pages are never sent",
			dedup: "raw-byte sha256 within one group (checkout plus its worktrees); the first copy in unit order is sent",
		},
		groups,
		leave_out: leaveOut,
		errors,
		excluded_root_entries: input.discovered.excluded_root_entries,
		dot_dirs_skipped: input.discovered.dot_dirs_skipped,
		batches,
	};
}

export type IngestCall = (input: IngestInput, roots: readonly string[]) => Promise<IngestOutcome>;

export interface GroupApply {
	group: string;
	dataset: string;
	batches_sent: number;
	batches_refused: number;
	ingested: number;
	replaced: number;
	unchanged: number;
	failed: number;
	refusal?: string;
	/** The first failed page and its recorded error, so a group's cause is not lost to the count. */
	first_failure?: string;
}

export interface RunOptions {
	plan: AllMarkdownPlan;
	apply: boolean;
	stateDir: string;
	/** Required with `apply`; never called without it. */
	ingest?: IngestCall;
	sessionId: string;
	out: (text: string) => void;
	err: (text: string) => void;
}

/**
 * Writes the report and the leave-out file, then, only with `apply`, sends each sending group's batches through the
 * ingest. A refused batch stops its group, and the other groups still run. Returns 0 when everything sent cleanly
 * (or on a dry run), 1 when a batch was refused or a page failed.
 */
export async function runAllMarkdownIngest(options: RunOptions): Promise<number> {
	const { plan, stateDir } = options;
	if (options.apply && options.ingest === undefined) throw new Error("runAllMarkdownIngest: apply needs an ingest call");
	await writeOutputs(stateDir, plan, null);
	if (!options.apply) {
		options.out(`dry run: nothing sent. report.json, summary.md and leave-out.json written to ${stateDir}\n`);
		return 0;
	}
	const ingest = options.ingest as IngestCall;
	const applied: GroupApply[] = [];
	for (const group of plan.groups) {
		if (group.status !== "send" || group.dataset === null) continue;
		const row: GroupApply = { group: group.group, dataset: group.dataset, batches_sent: 0, batches_refused: 0, ingested: 0, replaced: 0, unchanged: 0, failed: 0 };
		for (const batch of plan.batches.get(group.group) ?? []) {
			const outcome = await ingest(
				{
					dataset: group.dataset,
					...(group.commit !== null ? { commit: group.commit } : {}),
					pages: batch,
					session_id: options.sessionId,
				},
				batch.map((page) => page.path),
			);
			if (!outcome.ok) {
				row.batches_refused++;
				row.refusal = outcome.reason;
				break;
			}
			row.batches_sent++;
			for (const result of outcome.results) {
				if (result.status === "ingested") row.ingested++;
				else if (result.status === "replaced") row.replaced++;
				else if (result.status === "unchanged") row.unchanged++;
				else {
					row.failed++;
					// The first failure's page and recorded error (already redacted and capped by the ingest) says why a group failed.
					if (row.first_failure === undefined) row.first_failure = `${result.path}: ${result.error ?? result.status}`;
				}
			}
		}
		applied.push(row);
		options.out(`${group.group} -> ${group.dataset}: ${row.batches_sent} batch(es) sent${row.refusal !== undefined ? `, refused: ${row.refusal}` : ""}\n`);
		if (row.first_failure !== undefined) options.out(`${group.group}: ${row.failed} page(s) failed; first: ${row.first_failure}\n`);
	}
	await writeOutputs(stateDir, plan, applied);
	const failed = applied.some((row) => row.batches_refused > 0 || row.failed > 0);
	options.out(`apply: ${applied.length} group(s) ran; report.json and summary.md updated in ${stateDir}\n`);
	return failed ? 1 : 0;
}

const COUNT_KEYS = [
	"md_files", "md_bytes", "planning_files", "milestone_md_excluded", "symlinks_skipped", "over_cap_files", "over_cap_bytes",
	"over_cap_after_strip_files", "unreadable_files", "gate_checked_files", "gate_refused_files", "duplicate_files", "duplicate_bytes",
	"unique_clean_files", "send_files", "send_bytes", "send_batches", "errors",
] as const;

function totalsOf(groups: readonly GroupPlan[]): Record<(typeof COUNT_KEYS)[number], number> {
	const totals = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Record<(typeof COUNT_KEYS)[number], number>;
	for (const group of groups) for (const key of COUNT_KEYS) totals[key] += group[key];
	return totals;
}

async function writeOutputs(stateDir: string, plan: AllMarkdownPlan, applied: GroupApply[] | null): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	await chmod(stateDir, 0o700);
	const totals = totalsOf(plan.groups);
	const statusCounts = {
		send: plan.groups.filter((group) => group.status === "send").length,
		skipped_unknown_dataset: plan.groups.filter((group) => group.status === "skipped-unknown-dataset").length,
		nothing_to_send: plan.groups.filter((group) => group.status === "nothing-to-send").length,
	};
	const report = {
		meta: { generated_at: plan.generated_at, mode: applied === null ? "dry-run" : "apply", read_only: applied === null },
		scope: plan.scope,
		totals: { groups: plan.groups.length, ...statusCounts, ...totals, dot_dirs_skipped: plan.dot_dirs_skipped, refused_pages: plan.leave_out.reduce((sum, group) => sum + group.refused.length, 0), errors: plan.errors.length },
		excluded_root_entries: plan.excluded_root_entries,
		groups: plan.groups,
		errors: plan.errors,
		applied,
	};
	const leaveOut = { generated_at: plan.generated_at, groups: plan.leave_out };
	await writeSecret(join(stateDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await writeSecret(join(stateDir, "leave-out.json"), `${JSON.stringify(leaveOut, null, 2)}\n`);
	await writeSecret(join(stateDir, "summary.md"), summaryMarkdown(plan, totals, applied));
}

async function writeSecret(path: string, text: string): Promise<void> {
	await writeFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600);
}

function summaryMarkdown(plan: AllMarkdownPlan, totals: Record<(typeof COUNT_KEYS)[number], number>, applied: GroupApply[] | null): string {
	const lines: string[] = [];
	const refused = plan.leave_out.reduce((sum, group) => sum + group.refused.length, 0);
	lines.push(`# All-markdown docs ingest (${applied === null ? "dry run, nothing sent" : "apply"})`, "");
	lines.push(`Generated ${plan.generated_at}. Page cap ${plan.scope.page_cap_bytes.toLocaleString("en-US")} bytes. Dedup is within a group only.`, "");
	lines.push("## Totals", "", "| metric | value |", "|---|---:|");
	const row = (metric: string, value: unknown) => lines.push(`| ${metric} | ${value} |`);
	row("groups", plan.groups.length);
	row("groups to send", plan.groups.filter((group) => group.status === "send").length);
	row("groups skipped (dataset not configured)", plan.groups.filter((group) => group.status === "skipped-unknown-dataset").length);
	row("markdown files", totals.md_files);
	row(".planning/ files", totals.planning_files);
	row("milestone files excluded", totals.milestone_md_excluded);
	row("symlinked markdown skipped", totals.symlinks_skipped);
	row("dot-named directories skipped at discovery", plan.dot_dirs_skipped);
	row("over page cap (not read)", `${totals.over_cap_files} (${totals.over_cap_bytes} bytes)`);
	row("over page cap after strip", totals.over_cap_after_strip_files);
	row("unreadable", totals.unreadable_files);
	row("gate checked", totals.gate_checked_files);
	row("gate refused (left out)", refused);
	row("duplicates within group", `${totals.duplicate_files} (${totals.duplicate_bytes} bytes)`);
	row("unique clean pages", totals.unique_clean_files);
	row("pages to send", `${totals.send_files} in ${totals.send_batches} batch(es), ${totals.send_bytes} bytes`);
	row("errors", plan.errors.length);
	lines.push("", "## Per group", "", "| group | dataset | status | md | planning | over cap | refused | dup | send | errors |", "|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const group of plan.groups) {
		lines.push(
			`| ${cell(group.group)} | ${cell(group.dataset ?? "-")} | ${group.status} | ${group.md_files} | ${group.planning_files} | ${group.over_cap_files} | ${group.gate_refused_files} | ${group.duplicate_files} | ${group.send_files} | ${group.errors} |`,
		);
	}
	if (applied !== null) {
		lines.push("", "## Apply", "", "| group | dataset | batches sent | batches refused | ingested | replaced | unchanged | failed | refusal |", "|---|---|---:|---:|---:|---:|---:|---:|---|");
		for (const entry of applied) {
			lines.push(
				`| ${cell(entry.group)} | ${cell(entry.dataset)} | ${entry.batches_sent} | ${entry.batches_refused} | ${entry.ingested} | ${entry.replaced} | ${entry.unchanged} | ${entry.failed} | ${cell(entry.refusal ?? "-")} |`,
			);
		}
	}
	lines.push("", "Refused pages are listed in leave-out.json with their path, rule names and content hash only.", "");
	return `${lines.join("\n")}\n`;
}

function cell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

/** `mapLimit` keeps input order in its output. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await fn(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return out;
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
