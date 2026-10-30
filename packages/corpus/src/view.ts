/**
 * The one view of a repository's documentation a sync reads (v1.7 phase 65, decision D65-4).
 *
 * The mirror's default-branch tree is the base. The checkout's own documentation changes are laid over it path by path: a
 * path whose working-tree content differs from the merge base of the checkout's HEAD and the mirror's tip (committed beyond
 * it, uncommitted, or untracked) takes the working-tree bytes, a path deleted locally is removed, and every other path takes
 * the mirror's content. So a local edit never hides an unrelated push made elsewhere, a push never overwrites a local edit,
 * and the view is a pure function of git state: reading it twice, or alternating between a local edit and a remote push
 * without pulling, never changes the content of a path that did not change. There are never two competing views of one
 * `(repo, path)`.
 *
 * Reads in the user's repository are `git` commands that write nothing (`GIT_OPTIONAL_LOCKS=0`, no lazy fetch, no fsmonitor).
 * The mirror's objects reach those commands through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, an environment variable of the child
 * process, so the merge base can be computed without copying a single object into the user's repository.
 *
 * Every entry passes the rules of a plain scan (tier, path, size, symlink, NUL byte, UTF-8 with the byte-order mark kept, and
 * the sha256 of the raw bytes), so an entry is identical in shape whichever side supplied it.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classify } from "./classify.ts";
import { type GitBytesRunner, type GitOutput, outputText } from "./gitio.ts";
import { isValidPath } from "./names.ts";
import { type CorpusEntry, type DocTier, documentKey } from "./protocol.ts";
import { entrySupersededBy } from "./supersession.ts";
import {
	type CheckoutRead,
	compareEntries,
	defaultLstat,
	type FileIo,
	type FileStat,
	inspectBytes,
	loadDocument,
	type SkipReason,
	SkipLog,
} from "./scan.ts";

/** Blobs read per `git cat-file --batch` call, by count and by the bytes they add up to. */
export const VIEW_BATCH_OBJECTS = 500;
export const VIEW_BATCH_BYTES = 64 * 1024 * 1024;
/** Object ids asked of the origin in one fetch when a blobless mirror lacks documentation blobs. */
const PREFETCH_BATCH = 1000;
/** A read of a large tree takes seconds; the bound only stops a wedged process. */
const READ_TIMEOUT_MS = 300_000;
/** The most problems kept in a result; any problem at all leaves the repository out of the coverage. */
const MAX_PROBLEMS = 50;

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TREE_ROW = /^(\d+) (\w+) ([0-9a-f]+)(?: +(\d+|-))?$/;

export interface ViewOptions {
	/** The repository label the entries carry. */
	repo: string;
	repoDir: string;
	mirrorDir: string;
	maxTier: DocTier;
	maxBytes: number;
	runner: GitBytesRunner;
	readFile?: ((path: string) => Uint8Array) | undefined;
	lstat?: ((path: string) => FileStat | null) | undefined;
}

export interface ViewResult extends CheckoutRead {
	/** The mirror's default-branch commit the base was read at. */
	tip: string;
	/** The commit the working-tree overlay is measured from; null when the checkout shares no history with the mirror. */
	mergeBase: string | null;
	fromMirror: number;
	fromWorkingTree: number;
}

export const GIT_BLOB_SCHEME = "git-blob:";

/** Where the bytes of a mirror entry live: a git object of the mirror, resolved by {@link readLocation}. */
export function blobLocation(mirrorDir: string, oid: string): string {
	return `${GIT_BLOB_SCHEME}${oid}@${mirrorDir}`;
}

/** The bytes at a location of `ViewResult.paths`: a mirror blob through git, anything else through `readFile`. Throws when unreadable. */
export function readLocation(location: string, run: GitBytesRunner, readFile: (path: string) => Uint8Array): Uint8Array {
	if (!location.startsWith(GIT_BLOB_SCHEME)) return readFile(location);
	const rest = location.slice(GIT_BLOB_SCHEME.length);
	const at = rest.indexOf("@");
	const oid = at === -1 ? "" : rest.slice(0, at);
	if (!OBJECT_ID.test(oid)) throw new Error("not a git object location");
	const result = run({ args: ["cat-file", "blob", oid], cwd: rest.slice(at + 1), timeoutMs: READ_TIMEOUT_MS });
	if (result.code !== 0) throw new Error("git could not read the object");
	return result.stdout;
}

type Verdict = { ok: true; sha256: string; bytes: number; text: string } | { ok: false; reason: SkipReason; problem?: string };

/** Asks the origin, in batches, for the blobs a blobless mirror does not hold yet. A failure is not an error: the read that follows fetches what is left one object at a time. */
function prefetchMissing(mirrorDir: string, oids: readonly string[], run: GitBytesRunner): void {
	if (oids.length === 0) return;
	const present = localSizes(mirrorDir, oids, run);
	const missing = oids.filter((oid) => !present.has(oid));
	for (let start = 0; start < missing.length; start += PREFETCH_BATCH) {
		run({
			args: [
				"-c",
				"fetch.negotiationAlgorithm=noop",
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				"--recurse-submodules=no",
				"--filter=blob:none",
				"--stdin",
				"origin",
			],
			cwd: mirrorDir,
			input: `${missing.slice(start, start + PREFETCH_BATCH).join("\n")}\n`,
			timeoutMs: READ_TIMEOUT_MS,
		});
	}
}

/** Hashes and checks every distinct blob once, a bounded batch at a time; only the verdicts are kept, never the bodies. */
function readVerdicts(mirrorDir: string, items: ReadonlyArray<{ oid: string; size: number }>, maxBytes: number, run: GitBytesRunner): Map<string, Verdict> {
	const sizes = new Map<string, number>();
	for (const item of items) sizes.set(item.oid, item.size);
	const verdicts = new Map<string, Verdict>();
	const unique = [...sizes.keys()];
	if (unique.length === 0) return verdicts;
	prefetchMissing(mirrorDir, unique, run);

	const chunks: string[][] = [];
	let chunk: string[] = [];
	let chunkBytes = 0;
	for (const oid of unique) {
		const size = sizes.get(oid) ?? 0;
		if (chunk.length > 0 && (chunk.length >= VIEW_BATCH_OBJECTS || chunkBytes + size > VIEW_BATCH_BYTES)) {
			chunks.push(chunk);
			chunk = [];
			chunkBytes = 0;
		}
		chunk.push(oid);
		chunkBytes += size;
	}
	if (chunk.length > 0) chunks.push(chunk);

	for (const oids of chunks) {
		const output = run({ args: ["cat-file", "--batch"], cwd: mirrorDir, input: `${oids.join("\n")}\n`, timeoutMs: READ_TIMEOUT_MS });
		const buffer = Buffer.from(output.stdout.buffer, output.stdout.byteOffset, output.stdout.byteLength);
		let position = 0;
		for (const oid of oids) {
			const newline = buffer.indexOf(0x0a, position);
			if (newline === -1) break;
			const header = buffer.toString("utf8", position, newline).split(" ");
			position = newline + 1;
			const type = header[1];
			const size = Number(header[2]);
			if (header.length < 3 || !Number.isSafeInteger(size)) {
				verdicts.set(oid, { ok: false, reason: "unreadable", problem: "the object is missing from the mirror" });
				continue;
			}
			if (position + size > buffer.length) break;
			const data = buffer.subarray(position, position + size);
			position += size + 1;
			if (type !== "blob") {
				verdicts.set(oid, { ok: false, reason: "not-a-file" });
				continue;
			}
			const inspected = inspectBytes(data, maxBytes);
			verdicts.set(oid, inspected.ok ? { ok: true, sha256: inspected.sha256, bytes: inspected.bytes, text: inspected.text } : { ok: false, reason: inspected.reason });
		}
		for (const oid of oids) {
			if (!verdicts.has(oid)) verdicts.set(oid, { ok: false, reason: "unreadable", problem: "git cat-file returned no complete answer" });
		}
	}
	return verdicts;
}

interface TreeItem {
	oid: string;
	size: number;
	mode: string;
	type: string;
}

function parseTree(text: string): Map<string, TreeItem> {
	const items = new Map<string, TreeItem>();
	for (const row of text.split("\0")) {
		const tab = row.indexOf("\t");
		if (tab === -1) continue;
		const match = TREE_ROW.exec(row.slice(0, tab));
		const mode = match?.[1];
		const type = match?.[2];
		const oid = match?.[3];
		const size = match?.[4];
		if (mode === undefined || type === undefined || oid === undefined) continue;
		items.set(row.slice(tab + 1), { oid, size: size === undefined || size === "-" ? -1 : Number(size), mode, type });
	}
	return items;
}

/**
 * Sizes already in the mirror, without asking the origin. A missing blob stays unknown: knowing its size would fetch it.
 * `cat-file --batch-check` with lazy fetch disabled exits non-zero at the first missing promisor object, after printing
 * the objects it did have. Those lines are still sizes; the batch resumes after the object that stopped it.
 */
function localSizes(mirrorDir: string, oids: readonly string[], run: GitBytesRunner): Map<string, number> {
	const sizes = new Map<string, number>();
	let rest = [...oids];
	while (rest.length > 0) {
		const check = run({
			args: ["cat-file", "--batch-check"],
			cwd: mirrorDir,
			input: `${rest.join("\n")}\n`,
			env: { GIT_NO_LAZY_FETCH: "1" },
			timeoutMs: READ_TIMEOUT_MS,
		});
		const printed = new Set<string>();
		for (const line of outputText(check).split("\n")) {
			const parts = line.split(" ");
			const oid = parts[0];
			const size = Number(parts[2]);
			if (oid === undefined || parts[1] !== "blob" || !OBJECT_ID.test(oid) || !Number.isSafeInteger(size) || size < 0) continue;
			sizes.set(oid, size);
			printed.add(oid);
		}
		if (check.code === 0) break;
		const stopped = rest.findIndex((oid) => !printed.has(oid));
		if (stopped === -1) break;
		rest = rest.slice(stopped + 1);
	}
	return sizes;
}

/** Splits `git diff --name-status -z` output into path and whether the path is gone from the working tree. */
function parseNameStatus(text: string): Map<string, "deleted" | "present"> {
	const changes = new Map<string, "deleted" | "present">();
	const tokens = text.split("\0");
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const status = tokens[index] ?? "";
		const path = tokens[index + 1] ?? "";
		if (status !== "" && path !== "") changes.set(path, status.startsWith("D") ? "deleted" : "present");
	}
	return changes;
}

function pathsOf(text: string): string[] {
	return text.split("\0").filter((path) => path !== "");
}

/**
 * The repository's documentation as one view over the mirror and the checkout; see the module comment. Returns null when the
 * mirror holds no commit (an origin nobody has pushed to), so the checkout is read from its working tree alone. Any other
 * failure comes back as `problems`, which leaves the repository out of the plan's coverage: nothing is judged removed on
 * evidence the read did not complete.
 */
export function buildView(opts: ViewOptions): ViewResult | null {
	const { repo, repoDir, mirrorDir, maxTier, maxBytes, runner } = opts;
	const problems: string[] = [];
	const problem = (text: string): void => {
		if (problems.length < MAX_PROBLEMS) problems.push(text);
	};
	const skips = new SkipLog();
	const entries: CorpusEntry[] = [];
	const paths = new Map<string, string>();
	const empty = (tip: string | null, why: string): ViewResult => ({ entries, paths, skips, problems: [why], tip: tip ?? "", mergeBase: null, fromMirror: 0, fromWorkingTree: 0 });

	const inMirror = (args: string[], input?: string): GitOutput =>
		runner({ args, cwd: mirrorDir, ...(input === undefined ? {} : { input }), timeoutMs: READ_TIMEOUT_MS });
	if (outputText(inMirror(["rev-parse", "--is-bare-repository"])).trim() !== "true") return empty(null, "the mirror is not a readable repository");
	const tipOut = inMirror(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	if (tipOut.code !== 0) {
		// An origin nobody has pushed to has no branch. A HEAD that names a missing branch while other branches exist
		// is an incomplete read: falling back to the checkout would call that older tree a complete origin.
		const branches = inMirror(["for-each-ref", "--format=%(objectname)", "refs/heads"]);
		if (branches.code !== 0 || outputText(branches).trim() !== "") return empty(null, "the mirror's default branch did not resolve to a commit");
		return null;
	}
	const tip = outputText(tipOut).trim();
	if (!OBJECT_ID.test(tip)) return empty(null, "the mirror's default branch did not resolve to a commit");

	// Paths only. `ls-tree -l` looks up every blob to report its size, and a blobless mirror fetches each missing one
	// before any documentation filter can refuse it.
	const tree = inMirror(["ls-tree", "-r", "-z", tip]);
	if (tree.code !== 0) return empty(tip, "git ls-tree failed in the mirror");
	const base = parseTree(outputText(tree));

	// The checkout's side. Every command is read-only; the mirror's objects are visible through an alternates variable.
	const alternates = mirrorDir.includes(":") ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(resolve(mirrorDir), "objects") };
	const inRepo = (args: string[]): GitOutput =>
		runner({ args: ["-c", "core.fsmonitor=false", ...args], cwd: repoDir, env: { GIT_NO_LAZY_FETCH: "1", ...alternates }, timeoutMs: READ_TIMEOUT_MS });
	const headOut = inRepo(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	const head = headOut.code === 0 ? outputText(headOut).trim() : null;
	let mergeBase: string | null = null;
	if (head !== null) {
		const found = inRepo(["merge-base", head, tip]);
		const text = outputText(found).trim();
		if (found.code === 0 && OBJECT_ID.test(text)) mergeBase = text;
	}

	// What the checkout changed since the merge base. Without a merge base every local document counts as changed, so the
	// checkout's own text wins and the mirror still supplies the paths the checkout does not have; that read is incomplete.
	let changed = new Map<string, "deleted" | "present">();
	if (mergeBase !== null) {
		const diff = inRepo(["diff", "--name-status", "--no-renames", "--ignore-submodules=all", "-z", mergeBase, "--"]);
		if (diff.code === 0) changed = parseNameStatus(outputText(diff));
		else problem("git diff failed in the checkout");
	} else {
		problem("the checkout shares no history with the mirror's default branch");
		const tracked = inRepo(["ls-files", "-z"]);
		if (tracked.code === 0) for (const path of pathsOf(outputText(tracked))) changed.set(path, "present");
		else problem("git ls-files failed in the checkout");
	}
	const untracked = inRepo(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked.code === 0) {
		for (const path of pathsOf(outputText(untracked))) if (!changed.has(path)) changed.set(path, "present");
	} else {
		problem("git ls-files --others failed in the checkout");
	}

	// The mirror's part: every eligible document the checkout did not change. Size is inspected only after the
	// documentation filter, and a blob is fetched only when that size is not already local.
	const candidates: Array<{ path: string; kind: CorpusEntry["kind"]; tier: DocTier; item: TreeItem }> = [];
	for (const [path, item] of base) {
		if (changed.has(path)) continue;
		const found = classify(path);
		if (found === null || found.tier > maxTier) continue;
		if (!isValidPath(path)) {
			skips.add({ repo, path, reason: "bad-path" });
			continue;
		}
		if (item.mode === "120000") skips.add({ repo, path, reason: "symlink" });
		else if (item.type !== "blob") skips.add({ repo, path, reason: "not-a-file" });
		else candidates.push({ path, kind: found.kind, tier: found.tier, item });
	}
	const known = localSizes(mirrorDir, candidates.map((row) => row.item.oid), runner);
	const queued: Array<{ path: string; kind: CorpusEntry["kind"]; tier: DocTier; item: TreeItem }> = [];
	const needSize: string[] = [];
	for (const row of candidates) {
		const size = known.get(row.item.oid);
		if (size === 0) skips.add({ repo, path: row.path, reason: "empty" });
		else if (size !== undefined && size > maxBytes) skips.add({ repo, path: row.path, reason: "too-large" });
		else if (size === undefined) needSize.push(row.item.oid);
		else queued.push({ path: row.path, kind: row.kind, tier: row.tier, item: { ...row.item, size } });
	}
	if (needSize.length > 0) prefetchMissing(mirrorDir, needSize, runner);
	const fetched = localSizes(mirrorDir, needSize, runner);
	for (const row of candidates) {
		if (known.has(row.item.oid)) continue;
		const size = fetched.get(row.item.oid);
		if (size === undefined) {
			skips.add({ repo, path: row.path, reason: "unreadable" });
			problem(`${row.path}: the mirror has no size for this document and the fetch did not supply one`);
		} else if (size === 0) skips.add({ repo, path: row.path, reason: "empty" });
		else if (size > maxBytes) skips.add({ repo, path: row.path, reason: "too-large" });
		else queued.push({ path: row.path, kind: row.kind, tier: row.tier, item: { ...row.item, size } });
	}
	const verdicts = readVerdicts(mirrorDir, queued.map((row) => row.item), maxBytes, runner);
	for (const row of queued) {
		const verdict = verdicts.get(row.item.oid);
		if (verdict?.ok === true) {
			const supersededBy = entrySupersededBy(row.tier, verdict.text);
			entries.push({
				repo,
				path: row.path,
				kind: row.kind,
				tier: row.tier,
				sha256: verdict.sha256,
				bytes: verdict.bytes,
				source: "fs",
				commit: tip,
				...(supersededBy === undefined ? {} : { supersededBy }),
			});
			paths.set(documentKey(repo, row.path), blobLocation(mirrorDir, row.item.oid));
			continue;
		}
		const reason = verdict?.ok === false ? verdict.reason : "unreadable";
		skips.add({ repo, path: row.path, reason });
		if (verdict?.ok === false && verdict.problem !== undefined) problem(`${row.path}: ${verdict.problem}`);
	}
	const fromMirror = entries.length;

	// The checkout's part: the paths it changed, read from the working tree under the scanner's rules.
	const io: FileIo = { maxBytes, readFile: opts.readFile ?? ((path) => readFileSync(path)), lstat: opts.lstat ?? defaultLstat };
	for (const [path, state] of changed) {
		if (state === "deleted") continue;
		const found = classify(path);
		if (found === null || found.tier > maxTier) continue;
		if (!isValidPath(path)) {
			skips.add({ repo, path, reason: "bad-path" });
			continue;
		}
		const abs = join(repoDir, path);
		const loaded = loadDocument(abs, io);
		if (!loaded.ok) {
			skips.add({ repo, path, reason: loaded.reason });
			if (loaded.problem !== undefined) problem(`${path}: ${loaded.problem}`);
			continue;
		}
		const supersededBy = entrySupersededBy(found.tier, loaded.text);
		entries.push({
			repo,
			path,
			kind: found.kind,
			tier: found.tier,
			sha256: loaded.sha256,
			bytes: loaded.bytes,
			source: "fs",
			...(head === null ? {} : { commit: head }),
			...(supersededBy === undefined ? {} : { supersededBy }),
		});
		paths.set(documentKey(repo, path), abs);
	}
	entries.sort(compareEntries);
	return { entries, paths, skips, problems, tip, mergeBase, fromMirror, fromWorkingTree: entries.length - fromMirror };
}
