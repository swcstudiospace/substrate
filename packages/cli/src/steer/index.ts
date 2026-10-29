/**
 * `substrate steer sessions|status|queue|ack|list|listen|context` (v1.7, phase 67): Live Steering from a terminal.
 *
 * The commands are thin: they call the REST routes the server mounts for the steering MCP tools and print what comes
 * back. The server decides who may queue and acknowledge (operators on the allow-listed principals); an agent's token
 * is refused there, and this client does not try to second-guess it. A wrong flag is refused BEFORE anything is sent.
 *
 * Exit codes: 0 done, 1 failed (the server was not reached, answered with an error or with a body that is not a reply),
 * 2 usage, 3 refused (the server understood and said no: not an operator, a rate limit, a bad bearer, steering off).
 *
 * `listen` is the one long-running command. It long-polls `/steering/wait`, prints each directive as it arrives,
 * remembers the last id (sent as `after`) and every id it already printed (so a server that restarted and replays an
 * earlier queued directive does not print it twice), backs off after a transport error, and stops on an interrupt,
 * after `--once` has seen a directive, or when `--max-wait-ms` has passed. Its clock, sleep and fetch are injected, so
 * the whole loop is testable without waiting; every pause is abortable, so an interrupt ends it at once.
 */
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
	createSteerClient,
} from "./client.ts";
import { plain } from "./plain.ts";
import { renderDigest, renderDirectiveLine, renderDirectives, renderSessions, renderWriteReply } from "./render.ts";

export const EXIT_DONE = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export const STEER_USAGE =
	"usage: substrate steer sessions [--repo R] [--limit N] [--json]\n" +
	"       substrate steer status [--repo R] [--session ID] [--json]\n" +
	"       substrate steer queue --session ID --action pause|redirect|annotate --body TEXT [--priority low|normal|high] [--json]   (operators only)\n" +
	"       substrate steer ack DIRECTIVE (--applied | --declined) [--confirm] [--json]   (operators only)\n" +
	"       substrate steer list --session ID [--status queued|acknowledged|all] [--json]\n" +
	"       substrate steer listen --session ID [--once] [--max-wait-ms N] [--after DIRECTIVE] [--json]\n" +
	"       substrate steer context [--repo R] [--session ID] [--limit N] [--format text|json]\n" +
	"every command takes --surface S (the token's surface; default claude-code)\n" +
	"exit: 0 done, 1 failed, 2 usage, 3 refused by the server (not an operator, rate limited, bad token, steering off)\n";

/** One poll asks for this long; the server clamps it to its own ceiling (`SUBSTRATE_STEERING_WAIT_MAX_MS`) and says what it applied, which the loop then uses. */
export const LISTEN_POLL_MS = 25_000;
export const LISTEN_BACKOFF_BASE_MS = 1_000;
export const LISTEN_BACKOFF_MAX_MS = 30_000;
/** An answer to a long poll that came back sooner than this is not a long poll; the loop pauses so a misbehaving server cannot spin it. */
export const LISTEN_MIN_POLL_GAP_MS = 200;
export const LISTEN_MAX_WAIT_MS_LIMIT = 24 * 3_600_000;
/** A listener remembers at most this many printed directive ids, oldest dropped first. */
export const LISTEN_PRINTED_MAX = 1_000;
/** `status` lists the queued directives of at most this many sessions. */
const STATUS_MAX_DIRECTIVE_SESSIONS = 10;
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
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

type Sub = "sessions" | "status" | "queue" | "ack" | "list" | "listen" | "context";

const SUBCOMMANDS: readonly Sub[] = ["sessions", "status", "queue", "ack", "list", "listen", "context"];
const VALUE_FLAGS: readonly string[] = ["repo", "limit", "session", "action", "body", "priority", "status", "max-wait-ms", "after", "format", "surface"];
const ALLOWED: Record<Sub, readonly string[]> = {
	sessions: ["repo", "limit", "json", "surface"],
	status: ["repo", "session", "json", "surface"],
	queue: ["session", "action", "body", "priority", "json", "surface"],
	ack: ["applied", "declined", "confirm", "json", "surface"],
	list: ["session", "status", "json", "surface"],
	listen: ["session", "once", "max-wait-ms", "after", "json", "surface"],
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
		if (!allowed.includes(name)) return `unknown flag ${token} for \`steer ${sub}\``;
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
	} else if (positional.length > 0) {
		return `\`steer ${sub}\` takes no positional argument`;
	}

	const session = flag(parsed, "session");
	if (session !== undefined && !SESSION_ID_PATTERN.test(session)) return "--session must be a session id (letters, digits, . _ : -; at most 128 characters)";
	if ((sub === "queue" || sub === "list" || sub === "listen") && session === undefined) return `${sub} needs --session ID`;

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
const REFUSAL_CODES: Record<string, true> = { unauthorized: true, refused: true };

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

	switch (parsed.sub) {
		case "sessions": {
			const limit = flag(parsed, "limit");
			const result = await client.sessions({ repoId: flag(parsed, "repo") ?? deps.repo(), ...(limit === undefined ? {} : { limit: Number(limit) }) });
			if (!result.ok) return failed(result);
			if (json) jsonLine(result.value);
			else lines(renderSessions(result.value, deps.now().getTime()));
			return EXIT_DONE;
		}
		case "status":
			return await commandStatus(parsed, deps, client, failed);
		case "queue":
		case "ack":
			return await commandWrite(parsed, deps, client, failed);
		case "list": {
			const result = await client.directives({ sessionId: flag(parsed, "session") as string, status: (flag(parsed, "status") ?? "all") as DirectiveStatusFilter });
			if (!result.ok) return failed(result);
			if (json) jsonLine(result.value);
			else lines(renderDirectives(result.value, deps.now().getTime()));
			return EXIT_DONE;
		}
		case "listen":
			return await commandListen(parsed, deps, client, failed);
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
async function commandStatus(parsed: ParsedSteer, deps: SteerDeps, client: SteerClient, failed: Failed): Promise<number> {
	const repoId = flag(parsed, "repo") ?? deps.repo();
	const only = flag(parsed, "session");
	const sessions = await client.sessions({ repoId });
	if (!sessions.ok) return failed(sessions);
	const shown = sessions.value.sessions.filter((session) => only === undefined || session.session_id === only);
	const nowMs = deps.now().getTime();

	// Directives are read for the sessions that have some pending, or for the one the operator named.
	const wanted = (only === undefined ? shown.filter((session) => session.pending_directives > 0) : [{ session_id: only }]).slice(0, STATUS_MAX_DIRECTIVE_SESSIONS);
	const queued: Array<{ session_id: string; directives: SteerResult<SteerDirective[]> }> = [];
	for (const session of wanted) queued.push({ session_id: session.session_id, directives: await client.directives({ sessionId: session.session_id, status: "queued" }) });

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
async function commandListen(parsed: ParsedSteer, deps: SteerDeps, client: SteerClient, failed: Failed): Promise<number> {
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

	// An answer that came back sooner than a long poll is paced, so a misbehaving server cannot spin the loop.
	const pace = async (polledAt: number): Promise<void> => {
		if (deps.now().getTime() - polledAt < LISTEN_MIN_POLL_GAP_MS) await sleep(LISTEN_MIN_POLL_GAP_MS * 5, deps.interrupt);
	};

	for (;;) {
		if (interrupted()) return EXIT_DONE;
		const remaining = deadline === undefined ? LISTEN_POLL_MS : deadline - deps.now().getTime();
		if (remaining <= 0) break;
		const pollMs = Math.min(LISTEN_POLL_MS, serverWaitMs ?? LISTEN_POLL_MS, remaining);
		const polledAt = deps.now().getTime();
		const result = await client.wait({ sessionId, ...(after === undefined ? {} : { after }), timeoutMs: pollMs });
		// Read again after the await: the signal can fire while the poll is in flight.
		if (interrupted()) return EXIT_DONE;

		if (!result.ok) {
			// A refusal (a 400 with the server's words, a 403, a 429) is the server saying no: retrying would only repeat it.
			if (!isTransient(result)) return failed(result);
			const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - deps.now().getTime();
			if (left <= 0) break;
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
