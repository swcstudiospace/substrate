#!/usr/bin/env bun
/**
 * Cursor `stop` hook: keep a redacted transcript copy for the skill miner (D-15).
 *
 *   <stop envelope on stdin> | bun packages/collectors/src/cursor-stop.ts
 *
 * Cursor pipes `{ conversation_id, transcript_path, status, … }` on stdin when an
 * agent turn ends. When `transcript_path` is a regular file whose realpath lies
 * under /root/.cursor/ and the conversation id is a plain token, the transcript is
 * copied through `redact()` to /var/lib/substrate/transcripts/cursor/<id>.jsonl
 * (file 0600, dir 0700, tmp + rename, at most 20 MB), where the Hermes miner looks
 * for it. A `session.end` event names the copy, or says why there is none.
 *
 * Fails open in every case: this hook must never fail or stall a Cursor turn, and
 * it prints nothing on stdout, because Cursor auto-submits a `followup_message`
 * found there. The process always exits 0.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

export const TRANSCRIPTS_DIR = "/var/lib/substrate/transcripts/cursor";
export const CURSOR_ROOT = "/root/.cursor";
export const MAX_TRANSCRIPT_BYTES = 20_000_000;

const STDIN_TIMEOUT_MS = 5000;
const EMIT_TIMEOUT_MS = 1500;
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

export interface StopDeps {
	emit: (event: EventInput) => Promise<unknown>;
	/** Transcripts outside this directory (after realpath) are refused. */
	root?: string;
	destDir?: string;
	maxBytes?: number;
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
	try {
		// realpath resolved every link, so lstat sees the final object.
		if (!lstatSync(real).isFile()) return { reason: "transcript not a regular file" };
	} catch {
		return { reason: "transcript not found" };
	}
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
	let tmp: string | undefined;
	try {
		if (statSync(src).size > maxBytes) return { ref: null, reason: "too large" };
		const data = readFileSync(src);
		// The file may have grown between stat and read.
		if (data.length > maxBytes) return { ref: null, reason: "too large" };
		const text = redact(data.toString("utf8"));

		mkdirSync(destDir, { recursive: true, mode: 0o700 });
		chmodSync(destDir, 0o700);
		const dest = join(destDir, `${id}.jsonl`);
		tmp = `${dest}.tmp-${process.pid}`;
		writeFileSync(tmp, text, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, dest);
		return { ref: dest };
	} catch {
		if (tmp) rmSync(tmp, { force: true });
		return { ref: null, reason: "copy failed" };
	}
}

/**
 * Handle one stop envelope: copy the transcript when it is safe to, then emit
 * `session.end`. Never throws and never writes to stdout.
 */
export async function runStop(raw: string, deps: StopDeps): Promise<CopyResult> {
	let result: CopyResult = { ref: null, reason: "hook error" };
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
		await deps.emit(event);
	} catch {
		// An unreachable substrate must not fail the Cursor turn.
	}
	return result;
}

/** POST one event to the substrate, bounded like the CLI; errors are the caller's to swallow. */
async function postEvent(event: EventInput): Promise<void> {
	const base = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	await fetch(`${base}/events`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(event),
		signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
	});
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

if (import.meta.main) {
	try {
		const raw = await readStdin(STDIN_TIMEOUT_MS);
		await runStop(raw, { emit: postEvent });
	} catch {
		// Fail open.
	}
	process.exit(0);
}
