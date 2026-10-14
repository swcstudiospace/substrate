#!/usr/bin/env bun
/**
 * Cursor `stop` hook: keep a redacted transcript copy and emit session.end (D19-21).
 *
 *   <stop envelope on stdin> | bun packages/collectors/src/cursor-stop.ts
 *
 * Cursor pipes `{ conversation_id, transcript_path, status, … }` when an agent
 * turn ends. When `transcript_path` is a regular file whose realpath lies under
 * the Cursor root and the conversation id is a plain token, the transcript is
 * copied through `redact()` to the transcripts directory (file 0600, dir 0700,
 * tmp + rename, at most 20 MB). The copy is opened with `O_NOFOLLOW` and checked
 * with `fstat`, so a symlink swapped in after the realpath check is not followed.
 *
 * Fails open: the hook never fails a Cursor turn and prints nothing on stdout,
 * because Cursor auto-submits a followup found there. The process always exits 0.
 * The lesson flush and `session.end` share one hook budget, so a slow bank cannot
 * add a second full timeout before the event. The event is posted with the time
 * still left, and the hook waits for that post to park a failure before it
 * exits. A 4xx is counted as refused.
 * `SUBSTRATE_CURSOR_ROOT` and `SUBSTRATE_TRANSCRIPTS_DIR` override the defaults,
 * and are read when the hook runs, not when the module loads.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { extractDurableFacts, flushSessionLesson } from "../../cli/src/lessons.ts";
import { resolveBearer } from "../../cli/src/token.ts";
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";
import { HOOK_TIMEOUT_MS, postEvent } from "./emit.ts";

export const TRANSCRIPTS_DIR = "/var/lib/substrate/transcripts/cursor";
export const CURSOR_ROOT = "/root/.cursor";
export const MAX_TRANSCRIPT_BYTES = 20_000_000;

const STDIN_TIMEOUT_MS = 5000;
const CONVERSATION_ID = /^[A-Za-z0-9-]{8,128}$/;

/** The fields of Cursor's stop envelope this hook reads; the rest pass through untouched. */
export interface StopInput {
	conversation_id?: unknown;
	transcript_path?: unknown;
	status?: unknown;
	[key: string]: unknown;
}

/** Result of a copy attempt: the destination path, or null and why. */
export interface CopyResult {
	ref: string | null;
	reason?: string;
}

/** Facts already extracted from a copied transcript, capped so the lesson is not the raw log. */
export function sessionLessonText(transcript: string, limit = 3000): string {
	let body = "";
	for (const fact of extractDurableFacts(transcript).facts) {
		const next = body ? `${body}\n${fact}` : fact;
		if (next.length > limit) continue;
		body = next;
	}
	return body;
}

export interface StopDeps {
	/** Post `session.end`. `timeoutMs` is the fetch bound still left in the hook. The promise includes the spool park after a timeout, and the hook awaits it. */
	emit: (event: EventInput, timeoutMs: number) => Promise<unknown>;
	/** Transcripts outside this directory (after realpath) are refused. */
	root?: string;
	destDir?: string;
	maxBytes?: number;
	/**
	 * Writes the lesson for a copied transcript that contains durable facts.
	 * The hook awaits it and then still exits 0: a lesson failure must not fail
	 * the Cursor turn. Absent in tests that only assert the event.
	 */
	flushLesson?: (lesson: { sessionId: string; text: string }) => Promise<void>;
	/**
	 * Wall-clock budget shared by the lesson flush and `session.end`.
	 * Defaults to the hook timeout. The flush keeps all but a reserve (at most
	 * 400 ms, and at most half), and the event is posted with whatever remains.
	 */
	budgetMs?: number;
}

/** Roots read at call time so a long-lived process and tests see the live environment. */
export function hookPaths(): { root: string; destDir: string } {
	return {
		root: process.env.SUBSTRATE_CURSOR_ROOT?.trim() || CURSOR_ROOT,
		destDir: process.env.SUBSTRATE_TRANSCRIPTS_DIR?.trim() || TRANSCRIPTS_DIR,
	};
}

/** Parse the stop envelope (a leading BOM is stripped). Null for anything that is not a JSON object. */
export function parseStopInput(raw: string): StopInput | null {
	try {
		const value: unknown = JSON.parse(raw.replace(/^\ufeff/, ""));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as StopInput) : null;
	} catch {
		return null;
	}
}

/** True for an id that is safe to use as a file name: [A-Za-z0-9-], 8 to 128 characters. */
export function safeConversationId(id: unknown): id is string {
	return typeof id === "string" && CONVERSATION_ID.test(id);
}

/** Open `real` without following a final symlink, and require a regular file. The caller closes `fd`. */
function openRegularFile(real: string): { fd: number; size: number } | { reason: string } {
	let fd: number | undefined;
	try {
		fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			closeSync(fd);
			return { reason: "transcript not a regular file" };
		}
		return { fd, size: stat.size };
	} catch {
		if (fd !== undefined) closeSync(fd);
		return { reason: "transcript not found" };
	}
}

function readFd(fd: number, size: number): Buffer {
	const data = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const n = readSync(fd, data, offset, size - offset, offset);
		if (n <= 0) break;
		offset += n;
	}
	return data.subarray(0, offset);
}

/** Resolve a transcript path to its realpath, or explain why it is refused. */
function resolveTranscript(path: unknown, root: string): { src: string } | { reason: string } {
	if (typeof path !== "string" || path.length === 0) return { reason: "no transcript_path" };
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return { reason: "transcript not found" };
	}
	let rootReal = root;
	try {
		rootReal = realpathSync(root);
	} catch {
		// A root that does not resolve is compared as written.
	}
	rootReal = rootReal.replace(/\/+$/, "");
	if (!real.startsWith(`${rootReal}/`)) return { reason: `transcript outside ${root}` };
	const opened = openRegularFile(real);
	if ("reason" in opened) return opened;
	closeSync(opened.fd);
	return { src: real };
}

/**
 * The realpath of `path` when it is a regular file under `root` (symlinks are
 * followed before the check, so a link under root pointing outside is refused).
 */
export function transcriptSource(path: unknown, root: string = CURSOR_ROOT): string | null {
	const resolved = resolveTranscript(path, root);
	return "src" in resolved ? resolved.src : null;
}

/** Copy `src` through `redact()` to `<destDir>/<id>.jsonl` (0600; dir 0700; tmp + rename). */
export function copyTranscript(
	src: string,
	id: string,
	destDir: string = TRANSCRIPTS_DIR,
	maxBytes: number = MAX_TRANSCRIPT_BYTES,
): CopyResult {
	if (!safeConversationId(id)) return { ref: null, reason: "invalid conversation_id" };
	const opened = openRegularFile(src);
	if ("reason" in opened) return { ref: null, reason: opened.reason };
	let tmp: string | undefined;
	try {
		if (opened.size > maxBytes) return { ref: null, reason: "too large" };
		const data = readFd(opened.fd, opened.size);
		if (data.length > maxBytes) return { ref: null, reason: "too large" };
		const text = redact(data.toString("utf8"));

		mkdirSync(destDir, { recursive: true, mode: 0o700 });
		chmodSync(destDir, 0o700);
		const dest = join(destDir, `${id}.jsonl`);
		tmp = `${dest}.tmp-${process.pid}`;
		const tmpFd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			const encoded = Buffer.from(text);
			let offset = 0;
			while (offset < encoded.length) {
				offset += writeSync(tmpFd, encoded, offset, encoded.length - offset);
			}
		} finally {
			closeSync(tmpFd);
		}
		chmodSync(tmp, 0o600);
		renameSync(tmp, dest);
		return { ref: dest };
	} catch {
		if (tmp) rmSync(tmp, { force: true });
		return { ref: null, reason: "copy failed" };
	} finally {
		closeSync(opened.fd);
	}
}

/**
 * Handle one stop envelope: copy the transcript when it is safe to, then emit
 * `session.end`. Never throws and never writes to stdout.
 */
export async function runStop(raw: string, deps: StopDeps): Promise<CopyResult> {
	let result: CopyResult = { ref: null, reason: "hook error" };
	let left = (): number => deps.budgetMs ?? HOOK_TIMEOUT_MS;
	let event: EventInput = {
		surface: "cursor",
		kind: "session.end",
		actor: "human",
		summary: "cursor session ended",
		payload: { conversation_id: null, transcript_ref: null, status: null, reason: result.reason },
	};
	try {
		const input = parseStopInput(raw);
		const id = input && safeConversationId(input.conversation_id) ? input.conversation_id : null;
		const status = typeof input?.status === "string" ? input.status : null;

		if (!input) result = { ref: null, reason: "malformed envelope" };
		else if (!id) result = { ref: null, reason: "invalid conversation_id" };
		else {
			const resolved = resolveTranscript(input.transcript_path, deps.root ?? CURSOR_ROOT);
			result =
				"src" in resolved
					? copyTranscript(resolved.src, id, deps.destDir ?? TRANSCRIPTS_DIR, deps.maxBytes ?? MAX_TRANSCRIPT_BYTES)
					: { ref: null, reason: resolved.reason };
		}

		const budgetMs = deps.budgetMs ?? HOOK_TIMEOUT_MS;
		const reserveMs = Math.min(400, Math.floor(budgetMs / 2));
		const deadline = Date.now() + budgetMs;
		left = (): number => Math.max(0, deadline - Date.now());
		if (id && result.ref && deps.flushLesson) {
			try {
				const text = sessionLessonText(readFileSync(result.ref, "utf8"));
				const lessonMs = Math.min(left(), Math.max(0, budgetMs - reserveMs));
				if (text.length === 0) process.stderr.write(`[substrate] lesson ingest correlation=${id} outcome=nothing-durable\n`);
				else if (lessonMs > 0) await finishWithin(deps.flushLesson({ sessionId: id, text }), lessonMs);
				else process.stderr.write(`[substrate] lesson flush failed correlation=${id}\n`);
			} catch {
				process.stderr.write(`[substrate] lesson flush failed correlation=${id}\n`);
			}
		}

		event = {
			surface: "cursor",
			kind: "session.end",
			actor: "human",
			...(id ? { session_id: id } : {}),
			summary: "cursor session ended",
			payload: {
				conversation_id: id,
				transcript_ref: result.ref,
				status,
				...(result.reason ? { reason: result.reason } : {}),
			},
		};
	} catch {
		// Fall through with the "hook error" event.
	}
	try {
		// The post's own timeout is the time still left, and this wait includes
		// the spool park that follows a timeout. Abandoning the post at the same
		// instant the fetch aborts would exit before that park runs.
		await deps.emit(event, left());
	} catch {
		// An unreachable substrate must not fail the Cursor turn.
	}
	return result;
}

/** Await `work` until `ms` is gone. The timer is cleared either way. */
async function finishWithin<T>(work: Promise<T>, ms: number): Promise<T> {
	if (!(ms > 0)) throw new Error("hook budget spent");
	let rejectTimer: (error: Error) => void = () => {};
	const timeout = new Promise<T>((_, reject) => {
		rejectTimer = reject;
	});
	const timer = setTimeout(() => rejectTimer(new Error("hook budget spent")), ms);
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function readStdin(timeoutMs: number): Promise<string> {
	let resolveTimeout: (value: string) => void = () => {};
	const timeout = new Promise<string>((resolve) => {
		resolveTimeout = resolve;
	});
	const timer = setTimeout(() => resolveTimeout(""), timeoutMs);
	try {
		return await Promise.race([Bun.stdin.text(), timeout]);
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

function originRepo(): string | undefined {
	const named = process.env.SUBSTRATE_REPO?.trim();
	if (named) return named;
	const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return result.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

if (import.meta.main) {
	try {
		const raw = await readStdin(STDIN_TIMEOUT_MS);
		const paths = hookPaths();
		const repo = originRepo();
		await runStop(raw, {
			emit: (event, timeoutMs) => postEvent(event, { timeoutMs, collector: "cursor-stop", source: "cursor.stop" }),
			root: paths.root,
			destDir: paths.destDir,
			budgetMs: HOOK_TIMEOUT_MS,
			flushLesson: (lesson) =>
				flushSessionLesson({
					sessionId: lesson.sessionId,
					text: lesson.text,
					repo,
					url: (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, ""),
					token: resolveBearer("cursor", process.env) ?? undefined,
					timeoutMs: HOOK_TIMEOUT_MS - Math.min(400, Math.floor(HOOK_TIMEOUT_MS / 2)),
					root: process.cwd(),
					cwd: process.cwd(),
				}).then(() => undefined),
		});
	} catch {
		// Fail open.
	}
	process.exit(0);
}
