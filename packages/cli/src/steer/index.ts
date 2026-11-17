/**
 * `substrate steer open|heartbeat|close|forget|sessions|status|queue|ack|list|listen|context`: Live Steering from a terminal.
 *
 * The commands are thin: they call the REST routes the server mounts for the steering MCP tools and print what comes
 * back. The server decides who may queue and acknowledge (operators on the allow-listed principals); an agent's token
 * is refused there, and this client does not try to second-guess it. A wrong flag is refused BEFORE anything is sent.
 *
 * Exit codes: 0 done, 1 failed (the server was not reached, answered with an error or with a body that is not a reply),
 * 2 usage, 3 refused (the server understood and said no, or is not set up for steering: not an operator, a rate limit, a bad
 * bearer, a typed session/not-configured refusal, or a route missing because steering is off).
 *
 * `listen` is the one long-running command. It long-polls `/steering/wait`, prints each directive as it arrives,
 * remembers the last id (sent as `after`) and every id it already printed (so a server that restarted and replays an
 * earlier queued directive does not print it twice), backs off after a transport error, and stops on an interrupt,
 * after `--once` has seen a directive, or when `--max-wait-ms` has passed. `--max-wait-ms` is one budget for the whole
 * command: every request is cut at its end and no pause runs past it. Its clock, sleep and fetch are injected, so
 * the whole loop is testable without waiting; every pause is abortable, so an interrupt ends it at once.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	DIRECTIVE_STATUS_FILTERS,
	STEER_ACTIONS,
	STEER_PRIORITIES,
	type DirectiveStatusFilter,
	type SteerAction,
	type SteerClient,
	type SteerFailure,
	type SteerDirective,
	type SteerFetch,
	type SteerPriority,
	type SteerResult,
	type WriteReply,
	DIGEST_LISTS,
	DIRECTIVE_ID_PATTERN,
	SESSION_ID_PATTERN,
	STEER_LIMIT_MAX,
	WAIT_MARGIN_MS,
	createSteerClient,
} from "./client.ts";
import { plain } from "./plain.ts";
import { renderDigest, renderDirectiveLine, renderDirectives, renderSessions, renderWriteReply } from "./render.ts";
import { BindingRecordError, LIVE_SESSION_ID_PATTERN, MAX_BINDING_RECORDS, bindingRecordPath, loadBindingRecord, reclaimDeadBindingRecords, saveBindingRecord, serverIdentity, updateBindingExpiry, removeBindingRecord, type BindingRecordOptions, type LiveSessionBindingRecord } from "./binding-record.ts";

export const EXIT_DONE = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export const STEER_USAGE =
	"usage: substrate steer open [--repo R] [--binding-file PATH] [--json]\n" +
	"       substrate steer heartbeat|close --session ID [--binding-file PATH] [--json]\n" +
	"       substrate steer forget HANDLE [--binding-file PATH] [--surface S] [--json]   (removes the local record only; the server is not contacted)\n" +
	"       substrate steer sessions [--repo R] [--limit N] [--json]\n" +
	"       substrate steer status [--repo R] [--session ID [--binding-file PATH]] [--json]\n" +
	"       substrate steer queue --session ID --action pause|redirect|annotate --body TEXT [--priority low|normal|high] [--conflicts] [--json]   (operators only)\n" +
	"       substrate steer ack DIRECTIVE (--applied | --declined) [--confirm] [--json]   (operators only)\n" +
	"       substrate steer list --session ID [--binding-file PATH] [--status queued|acknowledged|all] [--json]\n" +
	"       substrate steer listen --session ID [--binding-file PATH] [--once] [--max-wait-ms N] [--after DIRECTIVE] [--json]\n" +
	"       substrate steer context [--repo R] [--session ID] [--limit N] [--format text|json]\n" +
	"every command takes --surface S (the token's surface; default claude-code)\n" +
	"exit: 0 done, 1 failed, 2 usage, 3 refused by the server (not an operator, rate limited, bad token, steering off or not configured)\n";

/** One poll asks for this long; the server clamps it to its own ceiling (`SUBSTRATE_STEERING_WAIT_MAX_MS`) and says what it applied, which the loop then uses. */
export const LISTEN_POLL_MS = 25_000;
export const LISTEN_BACKOFF_BASE_MS = 1_000;
export const LISTEN_BACKOFF_MAX_MS = 30_000;
/** An answer to a long poll that came back sooner than this is not a long poll; the loop pauses so a misbehaving server cannot spin it. */
export const LISTEN_MIN_POLL_GAP_MS = 200;
export const LISTEN_MAX_WAIT_MS_LIMIT = 24 * 3_600_000;
/** A listener remembers at most this many printed directive ids, oldest dropped first. */
export const LISTEN_PRINTED_MAX = 1_000;
const DEFAULT_SURFACE = "claude-code";
const DIRECTIVE_ID_HINT = "a directive id (letters, digits, . _ : -; at most 128 characters)";
const MAX_BODY_CHARS = 4_096;

export interface SteerDeps {
	url: string;
	tokenFor: (surface: string) => string | undefined;
	timeoutMs: number;
	now: () => Date;
	/** The `owner/name` of the working directory's origin remote; undefined outside a clone. Called only when a command needs it. */
	repo: () => string | undefined;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seams. */
	fetch?: SteerFetch;
	signalFor?: (timeoutMs: number) => AbortSignal;
	/** Resolves after `ms`, or at once when `signal` aborts; default a timer. `listen` sleeps only to back off or to space out instant answers. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Aborted by the entry point on SIGINT: `listen` stops at once and exits 0. */
	interrupt?: AbortSignal;
	/** Isolated private state directory; production uses the standard per-user directory. */
	bindingDirectory?: string;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

type Sub = "open" | "heartbeat" | "close" | "forget" | "sessions" | "status" | "queue" | "ack" | "list" | "listen" | "context";

const SUBCOMMANDS: readonly Sub[] = ["open", "heartbeat", "close", "forget", "sessions", "status", "queue", "ack", "list", "listen", "context"];
const VALUE_FLAGS: readonly string[] = ["repo", "limit", "session", "binding-file", "action", "body", "priority", "status", "max-wait-ms", "after", "format", "surface"];
const ALLOWED: Record<Sub, readonly string[]> = {
	open: ["repo", "binding-file", "json", "surface"],
	heartbeat: ["session", "binding-file", "json", "surface"],
	close: ["session", "binding-file", "json", "surface"],
	forget: ["binding-file", "json", "surface"],
	sessions: ["repo", "limit", "json", "surface"],
	status: ["repo", "session", "binding-file", "json", "surface"],
	queue: ["session", "action", "body", "priority", "conflicts", "json", "surface"],
	ack: ["applied", "declined", "confirm", "json", "surface"],
	list: ["session", "binding-file", "status", "json", "surface"],
	listen: ["session", "binding-file", "once", "max-wait-ms", "after", "json", "surface"],
	context: ["repo", "session", "limit", "format", "surface"],
};

export interface ParsedSteer {
	sub: Sub;
	flags: Map<string, string | true>;
	positional: string[];
}

const flag = (parsed: ParsedSteer, name: string): string | undefined => {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
};

function positiveInt(raw: string, max: number): number | undefined {
	if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value <= max ? value : undefined;
}

/** Parse `argv` strictly. The result is the reason when the command line is refused. */
export function parseSteerArgs(argv: readonly string[]): ParsedSteer | string {
	const sub = argv[0];
	if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) return "expected a subcommand";
	const allowed = ALLOWED[sub as Sub];
	const flags = new Map<string, string | true>();
	const positional: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] as string;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		if (!allowed.includes(name)) return `unknown flag for \`steer ${sub}\``;
		if (flags.has(name)) return `${token} given more than once`;
		if (VALUE_FLAGS.includes(name)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) return `${token} needs a value`;
			flags.set(name, value);
			i++;
		} else {
			flags.set(name, true);
		}
	}
	const parsed: ParsedSteer = { sub: sub as Sub, flags, positional };
	return validate(parsed) ?? parsed;
}

/** The reason a parsed command line is refused, or undefined. */
function validate(parsed: ParsedSteer): string | undefined {
	const { sub, flags, positional } = parsed;
	if (sub === "ack") {
		if (positional.length !== 1) return "ack takes exactly one directive id";
		if (!DIRECTIVE_ID_PATTERN.test(positional[0] as string)) return `the directive id must be ${DIRECTIVE_ID_HINT}`;
		if (flags.has("applied") === flags.has("declined")) return "ack needs exactly one of --applied or --declined";
		if (flags.has("confirm") && !flags.has("applied")) return "--confirm only goes with --applied";
	} else if (sub === "forget") {
		if (positional.length !== 1) return "forget takes exactly one session handle";
		if (!LIVE_SESSION_ID_PATTERN.test(positional[0] as string)) return "forget needs a server-issued live handle (ls_ followed by 64 lowercase hexadecimal characters)";
	} else if (positional.length > 0) {
		return `\`steer ${sub}\` takes no positional argument`;
	}

	const session = flag(parsed, "session");
	if (session !== undefined && !SESSION_ID_PATTERN.test(session)) return "--session must be a session id (letters, digits, . _ : -; at most 128 characters)";
	if (["queue", "list", "listen", "heartbeat", "close"].includes(sub) && session === undefined) return `${sub} needs --session ID`;
	if (sub === "status" && flags.has("binding-file") && session === undefined) return "--binding-file needs --session ID";
	if (session !== undefined && ["list", "listen", "status", "heartbeat", "close"].includes(sub) && !LIVE_SESSION_ID_PATTERN.test(session)) return "--session must be a server-issued live handle (ls_ followed by 64 lowercase hexadecimal characters)";

	if (sub === "queue") {
		const action = flag(parsed, "action");
		if (action === undefined || !(STEER_ACTIONS as readonly string[]).includes(action)) return `queue needs --action ${STEER_ACTIONS.join("|")}`;
		const body = flag(parsed, "body");
		if (body === undefined || body.trim().length === 0) return "queue needs --body TEXT";
		if (body.length > MAX_BODY_CHARS) return `--body is at most ${MAX_BODY_CHARS} characters`;
		const priority = flag(parsed, "priority");
		if (priority !== undefined && !(STEER_PRIORITIES as readonly string[]).includes(priority)) return `--priority is ${STEER_PRIORITIES.join(", ")}`;
	}
	const status = flag(parsed, "status");
	if (status !== undefined && !(DIRECTIVE_STATUS_FILTERS as readonly string[]).includes(status)) return `--status is ${DIRECTIVE_STATUS_FILTERS.join(", ")}`;
	const limit = flag(parsed, "limit");
	if (limit !== undefined && positiveInt(limit, STEER_LIMIT_MAX) === undefined) return `--limit is a whole number from 1 to ${STEER_LIMIT_MAX}`;
	const wait = flag(parsed, "max-wait-ms");
	if (wait !== undefined && positiveInt(wait, LISTEN_MAX_WAIT_MS_LIMIT) === undefined) return `--max-wait-ms is a whole number of milliseconds from 1 to ${LISTEN_MAX_WAIT_MS_LIMIT}`;
	const format = flag(parsed, "format");
	if (format !== undefined && format !== "text" && format !== "json") return "--format is text or json";
	const after = flag(parsed, "after");
	if (after !== undefined && !DIRECTIVE_ID_PATTERN.test(after)) return `--after must be ${DIRECTIVE_ID_HINT}`;
	const surface = flag(parsed, "surface");
	if (surface !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(surface)) return "--surface must be a surface name";
	return undefined;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** A pause that an abort ends at once; its timer is cleared either way, so nothing is left pending. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const finish = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", finish);
		resolve();
	};
	const timer = setTimeout(finish, ms);
	signal?.addEventListener("abort", finish, { once: true });
	return promise;
}

/** Failures that mean "the server said no" rather than "it could not answer". */
const REFUSAL_CODES: Record<string, true> = { unauthorized: true, refused: true, "not-found": true, "session-not-found": true, "session-unavailable": true };

/** A liveness check the server did not answer as live or dead: the sweep stops and `open` reports the server's own failure. */
class LivenessFailure extends Error {
	constructor(readonly failure: SteerFailure) { super(failure.message); }
}

/** The refusal when a directory stays full, and the message for a save that fails after issuance; the same text either way. */
const PERSISTENCE_FAILED = "substrate steer open: private binding persistence failed; the unused issued identity expires, and its lost credential cannot be recovered or reset\n";

/** Any well-formed handle names a file in the directory, so it locates the directory before any real session exists. */
const DIRECTORY_PROBE_SESSION = `ls_${"0".repeat(64)}`;

/**
 * Before `open` issues anything: a directory at capacity is swept for this server's and surface's records the server has
 * confirmed dead. Only a `session-not-found` answer to a record's own proof marks it dead; a live answer keeps it, and
 * every other failure throws a `LivenessFailure`. Records for another server or surface are never sent this client's
 * bearer and are never removed. Returns whether the directory has room afterwards.
 */
async function makeRoom(client: SteerClient, directory: string, identity: string, surface: string): Promise<boolean> {
	const held = existsSync(directory) ? readdirSync(directory).filter((name) => name !== ".directory.lock").length : 0;
	if (held < MAX_BINDING_RECORDS) return true;
	const cleared = await reclaimDeadBindingRecords(directory, async (record) => {
		if (record.server_identity !== identity || record.surface !== surface) return false;
		const answer = await client.directives({ sessionId: record.session_id, status: "all", sessionBinding: record.session_binding });
		if (answer.ok) return false;
		if (answer.code === "session-not-found") return true;
		throw new LivenessFailure(answer);
	});
	return held - cleared < MAX_BINDING_RECORDS;
}

export async function runSteer(argv: readonly string[], deps: SteerDeps): Promise<number> {
	if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		(argv.length === 0 ? deps.err : deps.out)(STEER_USAGE);
		return argv.length === 0 ? EXIT_USAGE : EXIT_DONE;
	}
	const parsed = parseSteerArgs(argv);
	if (typeof parsed === "string") {
		deps.err(`${parsed}\n${STEER_USAGE}`);
		return EXIT_USAGE;
	}
	const surface = flag(parsed, "surface") ?? DEFAULT_SURFACE;
	const token = deps.tokenFor(surface);
	const client = createSteerClient({
		url: deps.url,
		...(token === undefined ? {} : { token }),
		timeoutMs: deps.timeoutMs,
		...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
		...(deps.signalFor === undefined ? {} : { signalFor: deps.signalFor }),
	});
	const json = parsed.flags.has("json");
	const failed = (failure: SteerFailure): number => {
		deps.err(`substrate steer ${parsed.sub}: ${failure.message}\n`);
		return Object.hasOwn(REFUSAL_CODES, failure.code) ? EXIT_REFUSED : EXIT_FAILED;
	};
	const jsonLine = (value: unknown): void => deps.out(`${JSON.stringify(value)}\n`);
	const lines = (text: readonly string[]): void => deps.out(`${text.join("\n")}\n`);
	let selected: { path: string; record: LiveSessionBindingRecord } | undefined;
	const selectedSession = flag(parsed, "session");
	if (selectedSession !== undefined && ["list", "listen", "status", "heartbeat", "close"].includes(parsed.sub)) {
		try {
			const identity = serverIdentity(deps.url);
			const path = bindingRecordPath(identity, surface, selectedSession, { ...(deps.bindingDirectory === undefined ? {} : { directory: deps.bindingDirectory }), ...(flag(parsed, "binding-file") === undefined ? {} : { path: flag(parsed, "binding-file") as string }) });
			selected = { path, record: loadBindingRecord(path, { server_identity: identity, surface, session_id: selectedSession }) };
		} catch (error) {
			if (!(error instanceof BindingRecordError && error.code === "missing" && flag(parsed, "binding-file") === undefined && parsed.sub !== "heartbeat")) {
				deps.err("substrate steer: the selected private binding record is missing, unsafe or mismatched; no credential was reset\n");
				return EXIT_FAILED;
			}
		}
	}
	const sessionBinding = selected?.record.session_binding;

	switch (parsed.sub) {
		case "open": {
			const repoId = flag(parsed, "repo") ?? deps.repo();
			if (repoId === undefined || repoId.trim().length === 0) { deps.err("substrate steer open: supply --repo R or use a repository with an origin\n"); return EXIT_USAGE; }
			try { serverIdentity(deps.url); } catch { deps.err("substrate steer open: invalid configured server URL\n"); return EXIT_FAILED; }
			const bindingOptions: BindingRecordOptions = {
				...(deps.bindingDirectory === undefined ? {} : { directory: deps.bindingDirectory }),
				...(flag(parsed, "binding-file") === undefined ? {} : { path: flag(parsed, "binding-file") as string }),
			};
			const identity = serverIdentity(deps.url);
			let room: boolean;
			try { room = await makeRoom(client, dirname(bindingRecordPath(identity, surface, DIRECTORY_PROBE_SESSION, bindingOptions)), identity, surface); }
			catch (error) {
				if (error instanceof LivenessFailure) return failed(error.failure);
				deps.err("substrate steer open: the private binding directory could not be checked; no identity was issued\n");
				return EXIT_FAILED;
			}
			if (!room) { deps.err(PERSISTENCE_FAILED); return EXIT_FAILED; }
			const result = await client.open({ repoId });
			if (!result.ok) return failed(result);
			try {
				const value = result.value;
				const path = saveBindingRecord({ version: 1, server_identity: serverIdentity(deps.url), surface, session_id: value.session_id, session_binding: value.session_binding, expires_at: value.expires_at }, bindingOptions);
				const publicResult = { status: value.status, session_id: value.session_id, repo_id: value.repo_id, state: value.state, updated_at: value.updated_at, expires_at: value.expires_at, binding_file: path };
				if (json) jsonLine(publicResult);
				else deps.out(`issued ${value.session_id}; expires ${value.expires_at}; binding file ${plain(path, 4096)}\n`);
				return EXIT_DONE;
			} catch {
				deps.err(PERSISTENCE_FAILED);
				return EXIT_FAILED;
			}
		}
		case "heartbeat": {
			if (selected === undefined) { deps.err("substrate steer heartbeat: a matching private binding record is required\n"); return EXIT_FAILED; }
			const result = await client.heartbeat({ sessionId: selected.record.session_id, sessionBinding });
			if (!result.ok) return failed(result);
			try { updateBindingExpiry(selected.path, selected.record, result.value.expires_at); }
			catch { deps.err("substrate steer heartbeat: renewed on server, but local expiry could not be saved; credential unchanged\n"); return EXIT_FAILED; }
			if (json) jsonLine(result.value); else deps.out(`renewed ${result.value.session_id}; expires ${result.value.expires_at}\n`);
			return EXIT_DONE;
		}
		case "close": {
			const result = await client.close({ sessionId: selectedSession as string, sessionBinding });
			if (!result.ok) return failed(result);
			if (selected !== undefined) {
				try { removeBindingRecord(selected.path, selected.record); }
				catch { deps.err("substrate steer close: closed on server; the matching local record could not be removed\n"); return EXIT_FAILED; }
			}
			if (json) jsonLine(result.value); else deps.out(`closed ${result.value.session_id}; at ${result.value.closed_at}\n`);
			return EXIT_DONE;
		}
		case "forget": {
			const handle = parsed.positional[0] as string;
			const options: BindingRecordOptions = {
				...(deps.bindingDirectory === undefined ? {} : { directory: deps.bindingDirectory }),
				...(flag(parsed, "binding-file") === undefined ? {} : { path: flag(parsed, "binding-file") as string }),
			};
			let path: string;
			let record: LiveSessionBindingRecord;
			try {
				const identity = serverIdentity(deps.url);
				path = bindingRecordPath(identity, surface, handle, options);
				record = loadBindingRecord(path, { server_identity: identity, surface, session_id: handle });
			} catch {
				deps.err("substrate steer forget: the private binding record is missing, unsafe or mismatched; nothing was removed\n");
				return EXIT_FAILED;
			}
			try { removeBindingRecord(path, record); }
			catch { deps.err("substrate steer forget: the matching local record could not be removed\n"); return EXIT_FAILED; }
			if (json) jsonLine({ session_id: handle, forgotten: true });
			else deps.out(`forgot ${handle}; the local record was removed; the server was not contacted\n`);
			return EXIT_DONE;
		}
		case "sessions": {
			const limit = flag(parsed, "limit");
			const result = await client.sessions({ repoId: flag(parsed, "repo") ?? deps.repo(), ...(limit === undefined ? {} : { limit: Number(limit) }) });
			if (!result.ok) return failed(result);
			if (json) jsonLine(result.value);
			else lines(renderSessions(result.value, deps.now().getTime()));
			return EXIT_DONE;
		}
		case "status":
			return await commandStatus(parsed, deps, client, failed, sessionBinding);
		case "queue":
		case "ack":
			return await commandWrite(parsed, deps, client, failed);
		case "list": {
			const result = await client.directives({ sessionId: flag(parsed, "session") as string, status: (flag(parsed, "status") ?? "all") as DirectiveStatusFilter, sessionBinding });
			if (!result.ok) return failed(result);
			if (json) jsonLine(result.value);
			else lines(renderDirectives(result.value, deps.now().getTime()));
			return EXIT_DONE;
		}
		case "listen":
			return await commandListen(parsed, deps, client, failed, sessionBinding);
		default: {
			const limit = flag(parsed, "limit");
			const result = await client.context({
				repoId: flag(parsed, "repo") ?? deps.repo(),
				sessionId: flag(parsed, "session"),
				...(limit === undefined ? {} : { limit: Number(limit) }),
			});
			if (!result.ok) return failed(result);
			if (flag(parsed, "format") === "json") jsonLine(result.value);
			else deps.out(`${renderDigest(result.value)}\n`);
			return EXIT_DONE;
		}
	}
}

type Failed = (failure: SteerFailure) => number;

/** Sessions, their pending directives and a digest summary in one view. */
async function commandStatus(parsed: ParsedSteer, deps: SteerDeps, client: SteerClient, failed: Failed, sessionBinding?: string): Promise<number> {
	const repoId = flag(parsed, "repo") ?? deps.repo();
	const only = flag(parsed, "session");
	const sessions = await client.sessions({ repoId });
	if (!sessions.ok) return failed(sessions);
	const shown = sessions.value.sessions.filter((session) => only === undefined || session.session_id === only).map((session) => only !== undefined ? session : ({
		session_id: session.session_id, surface: session.surface, repo_id: session.repo_id, state: session.state, updated_at: session.updated_at,
		...(session.expires_at === undefined ? {} : { expires_at: session.expires_at }),
	}));
	const nowMs = deps.now().getTime();

	// Untargeted discovery never fans out into private command histories or counts.
	const queued: Array<{ session_id: string; directives: SteerResult<SteerDirective[]> }> = [];
	if (only !== undefined) {
		const directives = await client.directives({ sessionId: only, status: "queued", sessionBinding });
		if (!directives.ok) return failed(directives);
		queued.push({ session_id: only, directives });
	}

	// The digest is context: a server without it still gives a useful status.
	const context = await client.context({ repoId, sessionId: only });

	if (parsed.flags.has("json")) {
		deps.out(
			`${JSON.stringify({
				sessions: shown,
				truncated: sessions.value.truncated,
				directives: queued.map((entry) => ({ session_id: entry.session_id, ...(entry.directives.ok ? { directives: entry.directives.value } : { error: entry.directives.message }) })),
				context: context.ok
					? { generated_at: context.value.generated_at, counts: Object.fromEntries(DIGEST_LISTS.map((name) => [name, context.value.lists[name].length])), truncated: context.value.truncated, notes: context.value.notes }
					: { error: context.message },
			})}\n`,
		);
		return EXIT_DONE;
	}

	const out: string[] = [`sessions (${shown.length}):`];
	out.push(...renderSessions({ sessions: shown, truncated: sessions.value.truncated }, nowMs).map((line) => `  ${line}`));
	if (queued.length > 0) out.push("pending directives:");
	for (const entry of queued) {
		out.push(`  ${plain(entry.session_id, 64)}:`);
		if (!entry.directives.ok) out.push(`    unavailable: ${plain(entry.directives.message, 300)}`);
		else out.push(...renderDirectives(entry.directives.value, nowMs).map((line) => `    ${line.split("\n").join("\n    ")}`));
	}
	if (context.ok) {
		const counts = DIGEST_LISTS.map((name) => `${name} ${context.value.lists[name].length}`).join(", ");
		out.push(`context digest (generated ${plain(String(context.value.generated_at), 40)}): ${counts}${context.value.truncated.length > 0 ? `; cut: ${context.value.truncated.map((name) => plain(name, 24)).join(", ")}` : ""}`);
		out.push("  `substrate steer context` prints it");
	} else {
		out.push(`context digest unavailable: ${plain(context.message, 300)}`);
	}
	deps.out(`${out.join("\n")}\n`);
	return EXIT_DONE;
}

/** `queue` and `ack`: one POST, then the server's reply. Only `queued` and `acknowledged` are a success. */
async function commandWrite(parsed: ParsedSteer, deps: SteerDeps, client: SteerClient, failed: Failed): Promise<number> {
	let reply: WriteReply;
	if (parsed.sub === "queue") {
		const priority = flag(parsed, "priority") as SteerPriority | undefined;
		const result = await client.queue({
			sessionId: flag(parsed, "session") as string,
			action: flag(parsed, "action") as SteerAction,
			body: flag(parsed, "body") as string,
			...(priority === undefined ? {} : { priority }),
			...(parsed.flags.has("conflicts") ? { conflictsWithActivePlan: true } : {}),
		});
		if (!result.ok) return failed(result);
		reply = result.value;
	} else {
		const result = await client.acknowledge({
			directiveId: parsed.positional[0] as string,
			outcome: parsed.flags.has("applied") ? "applied" : "declined",
			...(parsed.flags.has("confirm") ? { confirm: true } : {}),
		});
		if (!result.ok) return failed(result);
		reply = result.value;
	}
	// Only the success status of the command is a success; every other status is the server saying no.
	const done = reply.status === (parsed.sub === "queue" ? "queued" : "acknowledged");
	if (parsed.flags.has("json")) deps.out(`${JSON.stringify(reply.raw)}\n`);
	else if (done) deps.out(`${renderWriteReply(reply).join("\n")}\n`);
	else deps.err(`substrate steer ${parsed.sub}: ${renderWriteReply(reply).join("\n")}\n`);
	return done ? EXIT_DONE : EXIT_REFUSED;
}

/** Whether a failure is the kind a reconnect can fix. */
const isTransient = (failure: SteerFailure): boolean => failure.code === "unreachable" || failure.code === "timeout" || failure.code === "server-error";

/** The long-poll loop. See the module comment for when it stops. */
async function commandListen(parsed: ParsedSteer, deps: SteerDeps, client: SteerClient, failed: Failed, sessionBinding?: string): Promise<number> {
	const sessionId = flag(parsed, "session") as string;
	const maxWait = flag(parsed, "max-wait-ms");
	const startedAt = deps.now().getTime();
	const deadline = maxWait === undefined ? undefined : startedAt + Number(maxWait);
	const sleep = deps.sleep ?? abortableSleep;
	// A function, not a property read: the loop reads it again after each await.
	const interrupted = (): boolean => deps.interrupt?.aborted === true;
	const once = parsed.flags.has("once");
	const json = parsed.flags.has("json");
	let after = flag(parsed, "after");
	let attempt = 0;
	let received = 0;
	// The long poll the server says it applies (it clamps an oversized request); the next poll asks for no more than that.
	let serverWaitMs: number | undefined;
	// Insertion order is age: the oldest id goes first when the set is full.
	const printed = new Set<string>();

	// The whole command has one budget (`--max-wait-ms`): what is left of it, or unbounded with no flag.
	const budgetLeft = (): number => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - deps.now().getTime());
	// A pause never runs past the end of the budget, so the command returns promptly once it is spent.
	const pause = async (wantedMs: number): Promise<void> => {
		const ms = Math.min(wantedMs, budgetLeft());
		if (ms > 0) await sleep(ms, deps.interrupt);
	};
	// An answer that came back sooner than a long poll is paced, so a misbehaving server cannot spin the loop.
	const pace = async (polledAt: number): Promise<void> => {
		if (deps.now().getTime() - polledAt < LISTEN_MIN_POLL_GAP_MS) await pause(LISTEN_MIN_POLL_GAP_MS * 5);
	};

	for (;;) {
		if (interrupted()) return EXIT_DONE;
		const remaining = budgetLeft();
		if (remaining <= 0) break;
		const pollMs = Math.min(LISTEN_POLL_MS, serverWaitMs ?? LISTEN_POLL_MS, remaining);
		const polledAt = deps.now().getTime();
		// With a budget the request itself is cut at its end: a stalled connection cannot hold the command past `--max-wait-ms`.
		const result = await client.wait({ sessionId, sessionBinding, ...(after === undefined ? {} : { after }), timeoutMs: pollMs, ...(deadline === undefined ? {} : { requestBudgetMs: remaining }) });
		// Read again after the await: the signal can fire while the poll is in flight.
		if (interrupted()) return EXIT_DONE;

		if (!result.ok) {
			// A refusal (a 400 with the server's words, a 403, a 429) is the server saying no: retrying would only repeat it.
			if (!isTransient(result)) return failed(result);
			const left = budgetLeft();
			if (left <= 0) break;
			// A request cut where the budget ends is the end of listening, not a fault to report and retry.
			if (result.code === "timeout" && deadline !== undefined && remaining <= pollMs + WAIT_MARGIN_MS) break;
			const delay = Math.min(LISTEN_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 10), LISTEN_BACKOFF_MAX_MS, left);
			attempt++;
			deps.err(`substrate steer listen: ${plain(result.message, 300)}; reconnecting in ${Math.ceil(delay / 1_000)}s\n`);
			await sleep(delay, deps.interrupt);
			continue;
		}
		attempt = 0;
		const { directive, waitMs } = result.value;
		if (waitMs !== undefined) serverWaitMs = waitMs;

		if (directive === null) {
			await pace(polledAt);
			continue;
		}

		// A reconnect to a server that restarted can answer with a directive already printed (the one it was acknowledged
		// after is gone from its queue, so `after` no longer places the poll): skip it, move the cursor on, and pace only
		// when the cursor did not move, so a server that keeps repeating one answer cannot spin the loop.
		const advanced = directive.id !== after;
		after = directive.id;
		if (printed.has(directive.id)) {
			if (!advanced) await pace(polledAt);
			continue;
		}
		if (printed.size >= LISTEN_PRINTED_MAX) {
			const oldest = printed.values().next().value;
			if (oldest !== undefined) printed.delete(oldest);
		}
		printed.add(directive.id);
		received++;
		deps.out(json ? `${JSON.stringify(directive)}\n` : `${renderDirectiveLine(directive, deps.now().getTime())}\n`);
		if (once) return EXIT_DONE;
	}
	if (!json) deps.err(`substrate steer listen: stopped after ${maxWait} ms with ${received} directive${received === 1 ? "" : "s"}\n`);
	return EXIT_DONE;
}
