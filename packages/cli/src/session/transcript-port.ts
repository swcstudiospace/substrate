/**
 * The transcript half of a rollback, per surface (v1.6, phase 61).
 *
 * `createTranscriptPort` is the `TranscriptPort` `rollback()` calls after the files are restored. It NEVER
 * rewrites, truncates or deletes a transcript. What it does, by surface:
 *
 *  - `omp`: finds the ORIGINAL session file the checkpoint's `transcript_ref.session_locator` names, forks it at
 *    the ref's `entry_id` with `forkOmpSession` (the ref's `prefix_sha256` is the guard), and writes the fork as a
 *    NEW file next to the original (exclusive create, mode 0600). Outcome `moved-leaf`; the detail names the new
 *    file and the one line the operator runs. Whether the installed omp resumes a forked file is UNVERIFIED:
 *    the detail says so. A changed transcript (a prefix mismatch, or an entry that is no longer there, for
 *    instance after a compaction) is `stale` and nothing is written. A file that cannot be found or read, or a
 *    ref that cannot be acted on, is `unsupported` with the reason.
 *  - every other surface: `marker-only`. The `session.rollback` ledger note is the marker; no transcript is touched.
 *  - no `transcript_ref` on the checkpoint: `unsupported`.
 *
 * Every file operation is injected, so the module has no filesystem, clock or randomness of its own.
 *
 * Locating the original: `ompSessionsDir` is the omp sessions BUCKET for the current working directory
 * (`ompBucketDir` computes it from omp://session.md's encoding rules). The search is by file NAME only: one
 * directory listing, capped at `MAX_LISTED_FILES` names, and an exact match on the locator (a file name with or
 * without `.jsonl`, or the session id after the timestamp). No file content is read to find a file. The locator
 * is an opaque id, never a path, so it cannot name a file outside the bucket.
 */
import { join } from "node:path";
import type { TranscriptPort, TranscriptRewindRequest, TranscriptRewindResult } from "./rollback.ts";
import { forkOmpSession, OMP_SESSION_MAX_BYTES } from "./omp-fork.ts";

/** The most directory entries one search looks at. A bucket with more is reported, not scanned. */
export const MAX_LISTED_FILES = 20_000;
/** The longest detail the port returns. */
const MAX_DETAIL_CHARS = 600;

export interface TranscriptPortFs {
	/** The names (not paths) in `dir`. Throws when the directory cannot be read. */
	listDir(dir: string): Promise<string[]>;
	/** The whole file as UTF-8 text. Throws when it cannot be read or is larger than `maxBytes` (the port passes the omp fork cap). */
	readFile(path: string, maxBytes: number): Promise<string>;
	/**
	 * Create a NEW file. `flag: "wx"` means it must fail (EEXIST) when the path exists; `mode` is the file mode.
	 * The port never asks for any other flag.
	 */
	writeFile(path: string, text: string, options: { flag: "wx"; mode: number }): Promise<void>;
}

interface TranscriptPortOptions extends TranscriptPortFs {
	/** The surface this invocation acts as. A rewind for another surface is `unsupported`: the wiring is wrong. */
	surface: string;
	/** The omp sessions bucket for the working directory. Absent: an omp rewind is `unsupported`. */
	ompSessionsDir?: string;
	/** The injected clock: the fork's timestamp and file name. */
	now: () => Date;
	/** A fresh omp session id for the fork. */
	newSessionId: () => string;
}

/** The file mode of a fork: private to the owner. */
const FORK_FILE_MODE = 0o600;

/** How to resume the fork. UNVERIFIED for the installed omp version; the detail says so. */
export function ompResumeCommand(newSessionId: string): string {
	return `omp --resume ${newSessionId}`;
}

function cap(text: string): string {
	return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * The files in `names` that `locator` names: the whole file name, the file name without `.jsonl`, or the session
 * id after the `<timestamp>_` part. Only `.jsonl` files count.
 */
export function matchOmpSessionFiles(names: readonly string[], locator: string): string[] {
	const wanted = locator.endsWith(".jsonl") ? locator : `${locator}.jsonl`;
	return names.filter((name) => {
		if (!name.endsWith(".jsonl")) return false;
		if (name === wanted) return true;
		const underscore = name.indexOf("_");
		return underscore > 0 && `${name.slice(underscore + 1, -".jsonl".length)}.jsonl` === wanted;
	});
}

/**
 * The omp sessions bucket directory name for a CANONICAL (symlinks resolved) working directory, from
 * omp://session.md: `-<relative>` under the home directory, `-tmp-<relative>` under the temp root, otherwise
 * `--<encoded absolute>--`, with path separators replaced by `-`. The caller resolves symlinks and passes the
 * home and temp roots. The last form (outside home and temp) is UNVERIFIED against a real directory: the
 * document gives the rule, not an example.
 */
export function ompBucketName(canonicalCwd: string, homeDir: string, tmpRoot: string): string {
	const under = (root: string): string | null => {
		const clean = root.replace(/[\\/]+$/, "");
		if (clean.length === 0) return null;
		if (canonicalCwd === clean) return "";
		return canonicalCwd.startsWith(`${clean}/`) ? canonicalCwd.slice(clean.length + 1) : null;
	};
	const dashed = (path: string): string => path.replace(/[\\/]+/g, "-");
	const relativeHome = under(homeDir);
	if (relativeHome !== null) return relativeHome === "" ? "-" : `-${dashed(relativeHome)}`;
	const relativeTmp = under(tmpRoot);
	if (relativeTmp !== null) return relativeTmp === "" ? "-tmp" : `-tmp-${dashed(relativeTmp)}`;
	return `--${dashed(canonicalCwd.replace(/^[\\/]+/, ""))}--`;
}

interface OmpBucketLookup {
	/** Directories omp may have been started in, most likely first: the working directory, then the git top level. */
	candidates: readonly string[];
	homeDir: string;
	tmpRoot: string;
	/** omp's sessions root, `<agent dir>/sessions` (default `~/.omp/agent/sessions`; a `--profile` or custom agent dir moves it). */
	sessionsRoot: string;
	/** The canonical path; throws when the path does not exist. */
	realpath(path: string): string;
	isDirectory(path: string): boolean;
}

/**
 * The omp sessions bucket of the first candidate directory whose bucket exists, or `undefined`. A candidate that
 * cannot be resolved is skipped: the answer is then "no bucket", which the port reports as `unsupported`.
 */
export function resolveOmpSessionsDir(lookup: OmpBucketLookup): string | undefined {
	const canonical = (path: string): string => {
		try {
			return lookup.realpath(path);
		} catch {
			// A root that cannot be resolved is compared as given; the bucket check below decides whether it matters.
			return path;
		}
	};
	const home = canonical(lookup.homeDir);
	const tmp = canonical(lookup.tmpRoot);
	for (const candidate of lookup.candidates) {
		if (candidate.length === 0) continue;
		let resolved: string;
		try {
			resolved = lookup.realpath(candidate);
		} catch {
			// This candidate does not exist (a stale working directory); the next one may.
			continue;
		}
		const bucket = join(lookup.sessionsRoot, ompBucketName(resolved, home, tmp));
		if (lookup.isDirectory(bucket)) return bucket;
	}
	return undefined;
}

/** The result for an outcome that is not a fork. */
function done(outcome: TranscriptRewindResult["outcome"], detail: string): TranscriptRewindResult {
	return { outcome, detail: cap(detail) };
}

async function rewindOmp(options: TranscriptPortOptions, request: TranscriptRewindRequest): Promise<TranscriptRewindResult> {
	const ref = request.transcriptRef;
	if (ref === undefined) return done("unsupported", "the checkpoint recorded no transcript pointer");
	if (ref.surface !== "omp") return done("unsupported", `the checkpoint's transcript pointer is for surface ${ref.surface}, not omp`);
	if (ref.entry_id === undefined) return done("unsupported", "the checkpoint's transcript pointer has no entry id to fork at");
	if (ref.prefix_sha256 === undefined) {
		return done("unsupported", "the checkpoint's transcript pointer has no prefix digest, so a changed transcript could not be detected; nothing was forked");
	}
	const dir = options.ompSessionsDir;
	if (dir === undefined || dir.length === 0) return done("unsupported", "the omp sessions directory for this working directory is not known");

	let names: string[];
	try {
		names = await options.listDir(dir);
	} catch (error) {
		return done("unsupported", `the omp sessions directory could not be listed (${codeOf(error) ?? messageOf(error).slice(0, 80)})`);
	}
	if (names.length > MAX_LISTED_FILES) {
		return done("unsupported", `the omp sessions directory holds more than ${MAX_LISTED_FILES} entries; the search is bounded and stopped`);
	}
	const matches = matchOmpSessionFiles(names, ref.session_locator);
	if (matches.length === 0) return done("unsupported", `the original omp session ${ref.session_locator} was not found in this directory's omp bucket`);
	if (matches.length > 1) return done("unsupported", `${matches.length} omp session files match ${ref.session_locator}; nothing was forked`);
	const originalName = matches[0] as string;

	let text: string;
	try {
		text = await options.readFile(join(dir, originalName), OMP_SESSION_MAX_BYTES);
	} catch (error) {
		return done("unsupported", `the original omp session could not be read (${codeOf(error) ?? messageOf(error).slice(0, 80)})`);
	}

	const newSessionId = options.newSessionId();
	const fork = forkOmpSession({
		sessionFileText: text,
		entryId: ref.entry_id,
		expectedPrefixSha256: ref.prefix_sha256,
		newSessionId,
		now: options.now,
		parentSessionLocator: originalName,
		maxBytes: OMP_SESSION_MAX_BYTES,
	});
	if (!fork.ok) {
		if (fork.code === "prefix-mismatch") {
			return done("stale", "the omp transcript no longer matches the checkpoint (it was changed after the checkpoint, for example by compaction); no file was written");
		}
		if (fork.code === "entry-not-found" || fork.code === "chain-broken") {
			return done("stale", `the checkpoint's entry is no longer on a complete path in the omp transcript (${fork.code}); no file was written`);
		}
		return done("unsupported", `the omp transcript could not be forked (${fork.code}${fork.line === undefined ? "" : `, line ${fork.line}`}); no file was written`);
	}

	try {
		await options.writeFile(join(dir, fork.file_name), fork.text, { flag: "wx", mode: FORK_FILE_MODE });
	} catch (error) {
		return done("unsupported", `the forked omp session could not be written (${codeOf(error) ?? messageOf(error).slice(0, 80)}); the original is untouched`);
	}
	return done(
		"moved-leaf",
		`forked omp session written as ${fork.file_name} (${fork.entries} entries up to the checkpoint); the original is untouched. ` +
			`Resume it from this directory with: ${ompResumeCommand(newSessionId)}. Whether the installed omp resumes a forked file is UNVERIFIED.`,
	);
}

/** The port for one invocation. Throws nothing: every failure is an outcome. */
export function createTranscriptPort(options: TranscriptPortOptions): TranscriptPort {
	return {
		async rewind(request: TranscriptRewindRequest): Promise<TranscriptRewindResult> {
			if (request.surface !== options.surface) {
				return done("unsupported", `the transcript adapter was wired for surface ${options.surface}, but the rollback is for ${request.surface}`);
			}
			if (request.transcriptRef === undefined) return done("unsupported", "the checkpoint recorded no transcript pointer");
			if (request.surface === "omp") return rewindOmp(options, request);
			return done("marker-only", "no transcript was touched; the session.rollback ledger note is the marker for this surface");
		},
	};
}
