/**
 * Human output of `substrate steer` and the `context` hook trigger: compact lines, each saying where an item came
 * from and how old it is. Pure: the caller passes the clock, so every line is testable.
 *
 * Text that came from the server (a directive body, a session id, a digest field) can carry control characters from an
 * agent's output, so every such string goes through `plain` before it reaches a terminal or a model's context.
 */
import type { ContextDigest, DigestItem, SteerDirective, SteerSession, SteerSessions, Timestamp, WriteReply } from "./client.ts";
import { DIGEST_LISTS } from "./client.ts";
import { plain } from "./plain.ts";

/** The `context` hook trigger prints at most this many characters. */
export const MAX_DIGEST_CHARS = 4_000;
const MAX_FIELD_CHARS = 80;
const MAX_BODY_CHARS = 400;
const MAX_FIELDS_PER_ITEM = 6;
const MAX_NOTES_SHOWN = 5;
const HASH_SHOWN_CHARS = 8;
/** A server-issued live handle: `ls_` then 64 lowercase hexadecimal characters, the shape `LIVE_SESSION_ID_PATTERN` accepts. */
export const LIVE_SESSION_ID_CHARS = "ls_".length + 64;
/** The longest directive id the server accepts: `DIRECTIVE_ID_RE` in the planning steering module allows 128 characters. */
const DIRECTIVE_ID_CHARS = 128;
/** Room kept for the "N more lines cut" line when a text is bounded. */
const CUT_LINE_RESERVE = 40;

/** The fields a digest item is described by, first: the rest follow in the server's order. */
const PRIORITY_FIELDS: readonly string[] = ["session_id", "surface", "worktree", "branch", "state", "kind", "summary", "title", "node_id", "holder", "to", "goal", "path"];

/** `5s`, `3m`, `2h`, `4d`. */
export function ageText(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

/** Seconds between a server timestamp and `nowMs`, or undefined when the timestamp is not a date. */
export function ageOf(timestamp: Timestamp, nowMs: number): number | undefined {
	const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
	if (!Number.isFinite(ms)) return undefined;
	return Math.max(0, (nowMs - ms) / 1_000);
}

function agoText(timestamp: Timestamp, nowMs: number): string {
	const age = ageOf(timestamp, nowMs);
	return age === undefined ? plain(String(timestamp), MAX_FIELD_CHARS) : `${ageText(age)} ago`;
}

function stateOf(steering: unknown): string | undefined {
	if (typeof steering === "string") return plain(steering, MAX_FIELD_CHARS);
	if (typeof steering === "object" && steering !== null && "state" in steering && typeof steering.state === "string") return plain(steering.state, MAX_FIELD_CHARS);
	return undefined;
}

export function renderSessionLine(session: SteerSession, nowMs: number): string {
	const parts = [
		plain(session.session_id, LIVE_SESSION_ID_CHARS),
		`surface=${plain(session.surface, 32)}`,
		`state=${plain(session.state, 32)}`,
		`repo=${plain(session.repo_id, 64)}`,
		`updated ${agoText(session.updated_at, nowMs)}`,
	];
	if (session.pending_directives !== undefined) parts.push(`pending=${session.pending_directives}`);
	const steering = stateOf(session.steering);
	if (steering !== undefined) parts.push(`steering=${steering}`);
	if (session.planning_hash !== undefined && session.planning_hash !== null) parts.push(`planning=${plain(session.planning_hash.slice(0, HASH_SHOWN_CHARS), HASH_SHOWN_CHARS)}`);
	return parts.join("  ");
}

export function renderSessions(result: SteerSessions, nowMs: number): string[] {
	if (result.sessions.length === 0) return ["no sessions"];
	const lines = result.sessions.map((session) => renderSessionLine(session, nowMs));
	if (result.truncated) lines.push("(the list was cut at the server's limit; narrow it with --repo)");
	return lines;
}

export function renderDirectiveLine(directive: SteerDirective, nowMs: number): string {
	const parts = [
		plain(directive.id, DIRECTIVE_ID_CHARS),
		directive.status === "queued" ? "queued" : `acknowledged${directive.outcome === null ? "" : ` (${plain(directive.outcome, 16)})`}`,
		`${directive.action}/${directive.priority}`,
		`by ${plain(directive.author, 48)}`,
		agoText(directive.created_at, nowMs),
	];
	if (directive.checkpoint_hint !== null) parts.push(`checkpoint_hint=${plain(directive.checkpoint_hint.trigger, 24)}`);
	return `${parts.join("  ")}\n    ${plain(directive.body, MAX_BODY_CHARS)}`;
}

export function renderDirectives(directives: readonly SteerDirective[], nowMs: number): string[] {
	if (directives.length === 0) return ["no directives"];
	return directives.map((directive) => renderDirectiveLine(directive, nowMs));
}

/** What `steer queue` and `steer ack` print for a reply: the outcome, then what happened to the session. */
export function renderWriteReply(reply: WriteReply): string[] {
	const lines: string[] = [];
	if (reply.status === "queued") lines.push(`queued directive ${plain(reply.directive_id ?? "?", 128)}`);
	else if (reply.status === "acknowledged") lines.push(`acknowledged directive ${plain(reply.directive_id ?? "?", 128)}`);
	else lines.push(`${plain(reply.status, 32)}${reply.reason === undefined ? "" : `: ${plain(reply.reason, 100)}`}${reply.error_code === undefined ? "" : ` (${plain(reply.error_code, 64)})`}`);
	const state = reply.session_state;
	if (typeof state === "object" && state !== null && "status" in state && typeof state.status === "string") {
		lines.push(`session state: ${plain(state.status, 32)}${"state" in state && typeof state.state === "string" ? ` -> ${plain(state.state, 32)}` : ""}`);
	}
	if (reply.checkpoint_hint !== undefined) {
		lines.push(`checkpoint hint: the session's steering hook will take a ${plain(reply.checkpoint_hint.trigger, 32)} checkpoint for ${plain(reply.checkpoint_hint.directive_id, DIRECTIVE_ID_CHARS)}`);
	}
	return lines;
}

function describeItem(item: DigestItem): string {
	const keys = [...PRIORITY_FIELDS.filter((key) => key in item.fields), ...Object.keys(item.fields).filter((key) => !PRIORITY_FIELDS.includes(key))];
	const fields: string[] = [];
	for (const key of keys) {
		if (fields.length >= MAX_FIELDS_PER_ITEM) break;
		const value = item.fields[key];
		if (typeof value === "string") {
			const shown = plain(value, MAX_FIELD_CHARS);
			if (shown.length > 0) fields.push(`${plain(key, 24)}=${shown}`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			fields.push(`${plain(key, 24)}=${value}`);
		}
	}
	return `- [${plain(item.source, 32)}, ${ageText(item.age_s)} old] ${fields.join(" ")}`.trimEnd();
}

/** The digest as text. Every item names its source and age; the whole text is at most `maxChars` characters. */
export function renderDigest(digest: ContextDigest, maxChars: number = MAX_DIGEST_CHARS): string {
	const forSession = digest.for_session === null ? "" : ` (for session ${plain(digest.for_session, 64)})`;
	const lines: string[] = [`Live context for ${plain(digest.repo_id, 96)}${forSession}, generated ${plain(String(digest.generated_at), 40)}`];
	for (const name of DIGEST_LISTS) {
		const items = digest.lists[name];
		if (items.length === 0) continue;
		lines.push(`${name}:`);
		for (const item of items) lines.push(describeItem(item));
	}
	if (digest.truncated.length > 0) lines.push(`(cut by the server: ${digest.truncated.map((name) => plain(name, 24)).join(", ")})`);
	for (const note of digest.notes.slice(0, MAX_NOTES_SHOWN)) lines.push(`note: ${plain(note, 160)}`);
	return boundLines(lines, maxChars);
}

/** Join `lines`, dropping whole lines from the end (and saying how many) rather than cutting one in half. */
export function boundLines(lines: readonly string[], maxChars: number): string {
	const full = lines.join("\n");
	if (full.length <= maxChars) return full;
	let kept = 0;
	let used = 0;
	for (const line of lines) {
		const cost = line.length + 1;
		if (used + cost + CUT_LINE_RESERVE > maxChars) break;
		used += cost;
		kept++;
	}
	const cut = lines.length - kept;
	const tail = `(… ${cut} more line${cut === 1 ? "" : "s"} cut)`;
	if (kept === 0) return tail.slice(0, maxChars);
	return `${lines.slice(0, kept).join("\n")}\n${tail}`;
}
