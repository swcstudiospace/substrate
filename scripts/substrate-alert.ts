#!/usr/bin/env bun
/**
 * Failure alert for a substrate unit (uplift-4 S3):
 *
 *   bun scripts/substrate-alert.ts <unit>[:<result>] [<result>]   # systemd runs it as substrate-alert@<unit>[:<result>].service
 *
 * Posts ONE `warning` event, `payload: { action, runtime, unit, result }`, to
 * `SUBSTRATE_URL/events` through the runtime doctor's emit path (`doctorBearer`,
 * `postEvent`), so the bearer is resolved the way the doctor resolves it: the
 * first entry of a rotated `SUBSTRATE_TOKEN_SUBSTRATE` list, never the whole
 * list. The payload carries the unit name and systemd's Result word, never a log
 * line, an environment value or a path.
 *
 * Always exits 0. An alert that fails must not become a second failed unit, and
 * the unit it reports on is usually mid-restart, so the one POST is preceded by
 * a bounded wait on the server's loopback `/livez` (a GET, safe to repeat; the
 * POST is not retried: a lost response could have stored the event, and a
 * duplicate is worse than a miss that the journal line already records).
 *
 * The Result comes from, in order: a second argument or a `:<result>` suffix on the unit
 * (what systemd's `$SERVICE_RESULT` is passed as by the example drop-in's ExecStopPost, so it
 * is the value at the moment the unit stopped), `MONITOR_SERVICE_RESULT` (set by systemd for
 * units started by OnFailure=), `SERVICE_RESULT`, and last one `systemctl show -p Result`,
 * a fallback for a manual run only: read after the unit restarted it can describe the new
 * process. Exactly `success` posts nothing: a deploy restart is not a failure. Any other
 * string is reported as `unknown`.
 *
 * Environment: `SUBSTRATE_URL` (default http://127.0.0.1:7410),
 * `SUBSTRATE_ALERT_WAIT_S` (default 60, 0-60; 0 posts immediately), plus
 * whatever `doctorBearer` reads.
 */
import { doctorBearer, postEvent } from "./doctor-runtime.ts";

/** systemd's `Result=` words for a service. Anything else is reported as `unknown`. */
const RESULTS: Record<string, true> = {
	success: true,
	protocol: true,
	timeout: true,
	"exit-code": true,
	signal: true,
	"core-dump": true,
	watchdog: true,
	"start-limit-hit": true,
	resources: true,
	"oom-kill": true,
	"skip-condition": true,
};

export const DEFAULT_WAIT_S = 60;
/**
 * Cap of the `/livez` wait. The unit's TimeoutStartSec (substrate-alert@.service) must stay above
 * SHOW_TIMEOUT_MS + MAX_WAIT_S + PROBE_TIMEOUT_MS + POLL_MS + the doctor's request timeout, or
 * systemd kills the alert before it posts; substrate-alert.test.ts pins that sum to the unit file.
 */
export const MAX_WAIT_S = 60;
export const POLL_MS = 1000;
export const PROBE_TIMEOUT_MS = 2000;
/** The `systemctl show` fallback's own bound. */
export const SHOW_TIMEOUT_MS = 10_000;
const UNIT_NAME = /^[A-Za-z0-9:_.@-]{1,64}\.service$/;

export interface AlertEvent {
	surface: "substrate";
	kind: "warning";
	summary: string;
	session_id: string;
	payload: { action: "alert"; runtime: "alert"; unit: string; result: string };
}

export interface AlertIo {
	env: Record<string, string | undefined>;
	/** `systemctl show -p Result --value <unit>` stdout, or null when it could not be run. */
	showResult(unit: string): string | null;
	/** One GET of the server's `/livez`: true on HTTP 200. */
	probe(url: string): Promise<boolean>;
	post(url: string, body: AlertEvent, bearer: string): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	/** Monotonic milliseconds. */
	now(): number;
	stderr(text: string): void;
}

/** The unit name when it is a plain `.service` name of at most 64 safe characters, else null. */
export function normalizeUnit(raw: string | undefined): string | null {
	return raw !== undefined && UNIT_NAME.test(raw) ? raw : null;
}

/** A systemd Result word from the closed list, else `unknown`. Exact match: `success` is the only word that skips the alert, so no trimming here. The raw string is never kept. */
export function normalizeResult(raw: string | undefined | null): string {
	const word = raw ?? "";
	return Object.hasOwn(RESULTS, word) ? word : "unknown";
}

/** `SUBSTRATE_ALERT_WAIT_S` as milliseconds: a whole number 0-MAX_WAIT_S, else the default. */
function waitMs(raw: string | undefined): number {
	const text = raw?.trim() ?? "";
	const seconds = /^[0-9]{1,3}$/.test(text) && Number(text) <= MAX_WAIT_S ? Number(text) : DEFAULT_WAIT_S;
	return seconds * 1000;
}

/**
 * The unit and, when given, the result the caller already knows. Two spellings carry it:
 * a second argument (`substrate-alert.ts substrate-mcp.service watchdog`), or a suffix on the
 * first (`substrate-mcp.service:watchdog`), which is how the template unit receives it, since
 * its single `%i` is the whole instance string. An empty result means none was passed.
 */
export function parseTarget(argv: readonly string[]): { unit: string; result: string | undefined } | null {
	const first = argv[0];
	if (first === undefined) return null;
	const m = /^(.+\.service)(?::([A-Za-z-]*))?$/.exec(first);
	const unit = m?.[1] ?? first;
	const fromSuffix = m?.[2] === undefined || m[2] === "" ? undefined : m[2];
	const second = argv[1] === undefined || argv[1] === "" ? undefined : argv[1];
	return { unit, result: second ?? fromSuffix };
}

/**
 * The whole job. Order: refuse a bad unit name, settle the result, skip a
 * success, resolve the bearer (all before any request), wait for `/livez`,
 * then one POST. Every outcome returns 0.
 */
export async function runAlert(argv: readonly string[], io: AlertIo, stampedAt: string = new Date().toISOString()): Promise<0> {
	const target = parseTarget(argv);
	const unit = target === null ? null : normalizeUnit(target.unit);
	if (target === null || unit === null) {
		io.stderr("substrate-alert: refused, the argument is not a plain .service unit name\n");
		return 0;
	}
	// The result the caller passed is authoritative: systemd hands $SERVICE_RESULT to ExecStopPost
	// at the moment the unit stopped, while `systemctl show` read afterwards can already describe
	// the restarted unit. Order: argument, MONITOR_SERVICE_RESULT (OnFailure=), SERVICE_RESULT,
	// then `systemctl show` as the fallback for a manual run.
	const fromEnv = io.env.MONITOR_SERVICE_RESULT?.trim() || io.env.SERVICE_RESULT?.trim();
	const raw = target.result ?? (fromEnv || io.showResult(unit)?.trim());
	const result = normalizeResult(raw);
	if (result === "success") {
		io.stderr(`substrate-alert: ${unit} stopped with result success; nothing to report\n`);
		return 0;
	}
	const bearer = doctorBearer(io.env);
	if (bearer === null) {
		io.stderr("substrate-alert: skipped, no bearer (SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_SUBSTRATE, SUBSTRATE_TOKEN_FILE or SUBSTRATE_TOKENS_DIR)\n");
		return 0;
	}
	const base = (io.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const started = io.now();
	const limit = waitMs(io.env.SUBSTRATE_ALERT_WAIT_S);
	let up = false;
	while (limit > 0) {
		try {
			up = await io.probe(`${base}/livez`);
		} catch {
			up = false;
		}
		if (up || io.now() - started >= limit) break;
		await io.sleep(POLL_MS);
	}
	if (limit > 0 && !up) io.stderr("substrate-alert: the server did not answer /livez within the wait; posting anyway\n");
	const event: AlertEvent = {
		surface: "substrate",
		kind: "warning",
		summary: `unit failed: ${unit} (${result})`,
		session_id: `alert:${stampedAt}`,
		payload: { action: "alert", runtime: "alert", unit, result },
	};
	let stored = false;
	try {
		stored = await io.post(`${base}/events`, event, bearer);
	} catch {
		// The journal line below is the record; the alert never turns into a failure.
	}
	io.stderr(stored ? `substrate-alert: posted one warning for ${unit} (${result})\n` : `substrate-alert: the warning for ${unit} was not stored; the journal line is the only record\n`);
	return 0;
}

const realIo: AlertIo = {
	env: process.env,
	showResult(unit) {
		try {
			const result = Bun.spawnSync(["systemctl", "show", "-p", "Result", "--value", unit], { stdout: "pipe", stderr: "ignore", timeout: SHOW_TIMEOUT_MS });
			return result.exitCode === 0 ? result.stdout.toString() : null;
		} catch {
			return null;
		}
	},
	async probe(url) {
		const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		await res.text();
		return res.status === 200;
	},
	post: postEvent,
	sleep: (ms) => Bun.sleep(ms),
	now: () => performance.now(),
	stderr: (text) => process.stderr.write(text),
};

if (import.meta.main) {
	try {
		await runAlert(process.argv.slice(2), realIo);
	} catch {
		process.stderr.write("substrate-alert: failed unexpectedly; nothing was posted\n");
	}
	process.exit(0);
}
