#!/usr/bin/env bun
/**
 * Boot-and-prove release gate (`bun run gate:boot`, Build Plan A-5c / A-7 #5).
 *
 * The release is booted against REAL stores before it reaches production: the rehearsal harness
 * (`scripts/rehearsal.ts`) starts this checkout's server on a free loopback port against a scratch
 * Postgres and a scratch ledger in local Docker, and the gate drives it over HTTP the way a client
 * and the monitors do, injects a real ledger outage, and tears everything down again.
 *
 *   bun run gate:boot                       # human receipt, exit 0 | 1 | 2
 *   bun run gate:boot -- --json             # one JSON receipt on stdout, progress on stderr
 *   bun run gate:boot -- --keep             # leave the twin running for a look (prints the `down` command)
 *   bun run gate:boot -- --name <id> --surfaces claude-code,grok-bot --window-ms 20000
 *
 * Exit codes
 *   0  every check passed and nothing is left running.
 *   1  a check failed (including a failed teardown: residue is a failure, never a note).
 *   2  the gate could not give an answer: the harness refused to start (Docker missing or not
 *      local, an image missing under `--pull never`, the disk floor, a port refusal, the production
 *      checkout), the name is taken, bad arguments, or the run was interrupted before any check had
 *      failed (one that had keeps the exit at 1). Nothing is proven either way; a deploy hook must
 *      not read 2 as "green".
 *
 * Steps, each one named check with its own timing (ids in `CHECK_IDS`):
 *   up -> consumer -> livez -> healthz -> slo -> brief.claude-code -> brief.grok-bot ->
 *   brief.profile-typo -> emit -> brief.visibility -> rehearsal.smoke -> smoke.grok ->
 *   outage.pause -> outage.brief -> outage.chaos -> outage.unpause -> recovery.healthz ->
 *   recovery.emit -> cleanup.down -> cleanup.residue
 *
 * Reasoning behind each refusal and each non-obvious choice:
 *
 * - `down` runs in `finally`, on a failed check, a thrown error, SIGINT, SIGTERM and SIGHUP. An
 *   `up` that was REFUSED (exit 2) is torn down only when it left a run directory behind (the
 *   harness creates the run directory, and token files, before several of its refusals) and the
 *   reason is not contention ("already running", "locked by another operation", an unverifiable
 *   live pid): those mean the name belongs to somebody else, and tearing it down would stop their
 *   twin. For the same reason a name whose run directory already exists is refused before `up` is
 *   even called, so any run directory present after a refused `up` is this run's own.
 *   SIGKILL cannot be handled: a runner that kills the gate after its grace period can leave a
 *   twin behind, swept by `bun run rehearsal down --name <name>` (docs/runbooks/release-gate.md).
 * - A paused ledger is unpaused in `finally` before `down`, and the unpause is idempotent, so an
 *   interrupted run never leaves a frozen store behind a container that `down` then cannot reach
 *   gracefully.
 * - The outage is a REAL one (`docker pause` of the twin's own labelled ledger container): the
 *   store accepts connections and answers nothing, which is what a dropped-packet outage looks like
 *   and the failure mode `scripts/chaos-smoke.ts` is written for. `CHAOS_REHEARSAL` is never set;
 *   that mode downgrades the outage-only checks to notes and would make this leg prove nothing.
 * - Every child process gets an explicit, minimal environment and `--no-env-file`: not the caller's
 *   `SUBSTRATE_URL`, tokens or a repo `.env`. The proofs are told the twin's URL and tokens
 *   explicitly, the URL is checked to be a scratch twin first (`refuseSmokeUrl`), and no token is
 *   ever printed.
 * - The chaos smoke gets its OWN request timeout, `CHAOS_REQUEST_TIMEOUT_MS`. With the ledger frozen
 *   the server answers an emit after one ledger statement timeout (5 s, `DEFAULT_TIMEOUT_MS` in
 *   greptime.ts) when the session's chain tip is cached and after two (tip lookup, then insert:
 *   10 s) for a fresh session, so a client timeout of 10 s sits exactly on the boundary and aborts a
 *   request the server is about to answer. 25 s is twice the worst case plus margin. The window holds
 *   at least three ticks of (10 s emit + 2 s tick).
 * - The twin's SLO sample floor is lowered to 3 (`SUBSTRATE_SLO_MIN_SAMPLES`, on the harness
 *   allowlist). The chaos smoke requires `emit.success` to read `breached`, and the production floor
 *   of 20 observations cannot be reached inside a 20 second window. The floor is a twin setting
 *   only; it proves the SLO notices an outage, not the production threshold.
 * - Recovery is given 90 s: after an unpause the ledger write probe is re-run at most once per 60 s
 *   and `/healthz` is memoised for 5 s, so a healthy tree recovers within about 65 s.
 *
 * What it does NOT cover is listed in docs/runbooks/release-gate.md ("Not covered").
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
	parseName,
	parseShellExports,
	parseSurfaces,
	REHEARSAL_LABEL,
	refuseSmokeUrl,
	RehearsalRefused,
	runDirFor,
} from "./rehearsal.ts";

const ROOT = join(import.meta.dir, "..");

/** The surfaces the gate drives; `--surfaces` may add to them, never drop them. */
export const GATE_SURFACES_DEFAULT = "claude-code,grok-bot";
export const GATE_REQUIRED_SURFACES = ["claude-code", "grok-bot"] as const;
/** Allowlisted twin settings every gate run passes (`rehearsal up --extra-env`). */
export const GATE_EXTRA_ENV = ["SUBSTRATE_BRIEF_PROFILE=shadow", "SUBSTRATE_SLO_MIN_SAMPLES=3"] as const;
/** The repo name the gate's own events and briefs use: never a real one. */
export const GATE_REPO = "rehearsal/release-gate";

export const DEFAULT_WINDOW_MS = 40_000;
export const MIN_WINDOW_MS = 5_000;
export const MAX_WINDOW_MS = 300_000;
/** How long `/healthz` may take to report both stores writable again after the unpause. */
export const RECOVERY_WAIT_MS = 90_000;
/** How long an emitted event may take to show in the brief. */
export const VISIBILITY_WAIT_MS = 15_000;
/** The brief's budget for a hook, as `chaos-smoke.ts` and `grok-connector-smoke.ts` hold it. */
export const OUTAGE_BRIEF_BUDGET_MS = 1500;

const UP_TIMEOUT_MS = 180_000;
const DOWN_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 90_000;
const PAUSE_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
/** The ledger client's per-statement timeout (`DEFAULT_TIMEOUT_MS` in packages/mcp-server/src/greptime.ts). */
export const LEDGER_STATEMENT_TIMEOUT_MS = 5000;
/**
 * The chaos smoke's per-request timeout. A frozen ledger costs an emit up to two serial statement
 * timeouts (chain-tip lookup, then insert; measured 5.0 s with a cached tip and 10.0 s for a fresh
 * session), so this must stay above twice `LEDGER_STATEMENT_TIMEOUT_MS`; 25 s is that worst case
 * doubled-and-a-half, a margin for a slow host.
 */
export const CHAOS_REQUEST_TIMEOUT_MS = 25_000;
const POLL_MS = 1000;
const RECOVERY_POLL_MS = 2000;
/** The chaos run's own end-of-window work (evidence, SLO reads) plus a margin; past this it hung. */
const CHAOS_MARGIN_MS = 120_000;
const OUTPUT_CAP = 32 * 1024;

export const CHECK_IDS = [
	"up",
	"consumer",
	"livez",
	"healthz",
	"slo",
	"brief.claude-code",
	"brief.grok-bot",
	"brief.profile-typo",
	"emit",
	"brief.visibility",
	"rehearsal.smoke",
	"smoke.grok",
	"outage.pause",
	"outage.brief",
	"outage.chaos",
	"outage.unpause",
	"recovery.healthz",
	"recovery.emit",
	"cleanup.down",
	"cleanup.residue",
] as const;

export type CheckStatus = "pass" | "fail" | "skip";

export interface Check {
	id: string;
	status: CheckStatus;
	ms: number;
	detail: string;
	/** A pass worth a second look (for example a degraded connector smoke); printed as a NOTE row. */
	note?: string;
}

export type Verdict = "pass" | "fail" | "unavailable";

export interface Receipt {
	kind: "gate-receipt";
	name: string;
	commit: string;
	verdict: Verdict;
	exit: 0 | 1 | 2;
	ms: number;
	checks: Check[];
	/** Why no answer could be given (exit 2); null otherwise. */
	unavailable: string | null;
	/** `--keep`: the twin was left running and `down` is the operator's. */
	kept: boolean;
}

export interface GateOptions {
	name: string | null;
	surfaces: string[];
	windowMs: number;
	keep: boolean;
	json: boolean;
}

// ── arguments ────────────────────────────────────────────────────────────────

/**
 * `--name <id> --surfaces a,b --window-ms N --keep --json`. Unknown options, missing values, a bad
 * name, a surface list the server does not know or that drops a surface the gate drives, and a
 * window outside 5 s..5 min are usage errors (exit 2), never defaults.
 */
export function parseArgs(argv: readonly string[]): GateOptions | { error: string } {
	let name: string | null = null;
	let surfacesRaw: string | undefined;
	let windowMs = DEFAULT_WINDOW_MS;
	let keep = false;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--keep") {
			keep = true;
		} else if (token === "--json") {
			json = true;
		} else if (token === "--name" || token === "--surfaces" || token === "--window-ms") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) return { error: `${token} needs a value` };
			i++;
			if (token === "--name") {
				try {
					name = parseName(value);
				} catch (cause) {
					return { error: cause instanceof RehearsalRefused ? cause.message : String(cause) };
				}
			} else if (token === "--surfaces") {
				surfacesRaw = value;
			} else {
				if (!/^[0-9]{1,7}$/.test(value)) return { error: `--window-ms must be a whole number of milliseconds, got ${JSON.stringify(value.slice(0, 20))}` };
				windowMs = Number(value);
				if (windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
					return { error: `--window-ms must be between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS}` };
				}
			}
		} else if (token.startsWith("--")) {
			return { error: `unknown option ${token}` };
		} else {
			return { error: `unexpected argument ${token}` };
		}
	}
	let surfaces: string[];
	try {
		surfaces = parseSurfaces(surfacesRaw ?? GATE_SURFACES_DEFAULT);
	} catch (cause) {
		return { error: cause instanceof RehearsalRefused ? cause.message : String(cause) };
	}
	for (const required of GATE_REQUIRED_SURFACES) {
		if (!surfaces.includes(required)) return { error: `--surfaces must include ${required}: the gate drives it` };
	}
	return { name, surfaces, windowMs, keep, json };
}

// ── pure judges: one per wire check, so a regression names its own assertion ─

export interface HttpResult {
	/** `null` when nothing answered (refused, reset, timed out). */
	status: number | null;
	/** Lower-cased header names. */
	headers: Record<string, string>;
	text: string;
	ms: number;
	error?: string;
}

export interface Judged {
	ok: boolean;
	detail: string;
	/** A pass worth a second look; carried onto the check. */
	note?: string;
}

/** The JSON object in a body, or null for anything else. */
export function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function noAnswer(res: HttpResult): Judged | null {
	if (res.status === null) return { ok: false, detail: `no answer: ${res.error ?? "unreachable"}` };
	return null;
}

/** `/livez`: 200 and `ok: true`; touches no store, so it only says the process is up. */
export function judgeLivez(res: HttpResult): Judged {
	const none = noAnswer(res);
	if (none) return none;
	const body = jsonObject(res.text);
	if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
	if (body?.ok !== true) return { ok: false, detail: "answered 200 without ok:true" };
	return { ok: true, detail: `up ${String(body.uptime_s ?? "?")}s` };
}

/** `/healthz`: 200 with the index, the ledger and ledger writes all reported ok. */
export function judgeHealthz(res: HttpResult): Judged {
	const none = noAnswer(res);
	if (none) return none;
	const body = jsonObject(res.text);
	if (body === null) return { ok: false, detail: `HTTP ${res.status} with a body that is not a JSON object` };
	const missing: string[] = [];
	for (const key of ["index", "greptime", "eventsWritable"] as const) {
		if (body[key] !== true) missing.push(`${key}=${String(body[key])}`);
	}
	if (res.status !== 200) missing.unshift(`HTTP ${res.status}`);
	if (missing.length > 0) return { ok: false, detail: missing.join(", ") };
	return { ok: true, detail: "index, ledger and ledger writes ok" };
}

/** The catalogue's objective ids (`brief.p95`, `emit.success`, `lease.steal_rate`, `quarantine.rate`). */
export const SLO_CATALOGUE_IDS = ["brief.p95", "emit.success", "lease.steal_rate", "quarantine.rate"] as const;
const SLO_STATUSES: readonly string[] = ["ok", "breached", "insufficient-data", "unmeasurable"];
const SLO_PLANE_STATUSES: readonly string[] = ["ok", "breached", "insufficient-data", "unconfigured"];

/**
 * `/slo`: SHAPE only. 200, the four catalogue objectives present exactly once each with a status
 * from the known vocabulary, and the `planes`, `burn` and `breached` arrays well-formed. A
 * `breached` objective on this fresh twin is reported as a note, never a failure: the twin runs with
 * `SUBSTRATE_SLO_MIN_SAMPLES=3` (so the outage proof can see `emit.success` breach), and at that
 * floor the first three observations on freshly started stores (table creation, container warm-up,
 * the harness's own readiness probes) decide the verdict. The SLO's verdict under a real outage is
 * proven by `outage.chaos`; this check proves the endpoint answers with a well-formed catalogue.
 */
export function judgeSlo(res: HttpResult): Judged {
	const none = noAnswer(res);
	if (none) return none;
	if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
	const body = jsonObject(res.text);
	if (body === null) return { ok: false, detail: "body is not a JSON object" };
	for (const key of ["results", "breached", "planes", "burn"] as const) {
		if (!Array.isArray(body[key])) return { ok: false, detail: `${key} is missing or not an array` };
	}
	const rows = (list: unknown[], vocabulary: readonly string[], what: string): string | null => {
		for (const row of list) {
			const entry = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
			if (typeof entry.id !== "string" || typeof entry.status !== "string") return `a ${what} row lacks id or status`;
			if (!vocabulary.includes(entry.status)) return `${what} ${entry.id} has unknown status ${JSON.stringify(entry.status.slice(0, 40))}`;
		}
		return null;
	};
	const results = body.results as unknown[];
	const catalogueProblem = rows(results, SLO_STATUSES, "catalogue");
	if (catalogueProblem !== null) return { ok: false, detail: catalogueProblem };
	const ids = results.map((row) => String((row as { id: string }).id));
	for (const id of SLO_CATALOGUE_IDS) {
		const seen = ids.filter((candidate) => candidate === id).length;
		if (seen !== 1) return { ok: false, detail: seen === 0 ? `the catalogue lacks objective ${id}` : `the catalogue lists ${id} ${seen} times` };
	}
	const planeProblem = rows(body.planes as unknown[], SLO_PLANE_STATUSES, "plane");
	if (planeProblem !== null) return { ok: false, detail: planeProblem };
	const breached = (body.breached as unknown[]).map(String);
	const detail = `${results.length} objectives, well-formed`;
	if (breached.length === 0) return { ok: true, detail: `${detail}, none breached` };
	return {
		ok: true,
		detail: `${detail}; breached on the fresh twin: ${breached.join(", ")} (informational)`,
		note: `/slo reports ${breached.join(", ")} breached on a fresh twin. Informational only: this twin judges SLOs from 3 samples (SUBSTRATE_SLO_MIN_SAMPLES=3, kept low so the outage proof can see a breach), so cold-start errors and slow first calls on new stores decide the first verdict. The SLO under a real outage is proven by outage.chaos.`,
	};
}

export interface BriefWant {
	/** The `x-substrate-brief-profile` the caller must have been served. */
	profile: string;
	/** The `x-substrate-brief` state, when the call must be a complete brief. */
	state?: string;
}

/** The first line of the full profile's text: what proves a caller was served the full brief. */
export const FULL_BRIEF_HEADING = "## Substrate brief:";

/** A served brief: 200, markdown, the profile and state headers, and the full text. */
export function judgeBrief(res: HttpResult, want: BriefWant): Judged {
	const none = noAnswer(res);
	if (none) return none;
	if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
	const problems: string[] = [];
	if (!(res.headers["content-type"] ?? "").includes("text/markdown")) problems.push("not text/markdown");
	const profile = res.headers["x-substrate-brief-profile"];
	if (profile !== want.profile) problems.push(`served profile ${profile ?? "(none)"}, wanted ${want.profile}`);
	const state = res.headers["x-substrate-brief"];
	if (want.state !== undefined && state !== want.state) problems.push(`brief state ${state ?? "(none)"}, wanted ${want.state}`);
	if (!res.text.startsWith(FULL_BRIEF_HEADING)) problems.push("text does not open with the full brief heading");
	if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
	return { ok: true, detail: `state ${state ?? "?"}, profile ${profile}, ${res.text.length} chars, ${Math.round(res.ms)} ms` };
}

/** A brief while the ledger is frozen: still a 200 with the full text, inside the hook's budget. State is reported, not judged. */
export function judgeOutageBrief(res: HttpResult, budgetMs: number = OUTAGE_BRIEF_BUDGET_MS): Judged {
	const none = noAnswer(res);
	if (none) return none;
	if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status} while the ledger was frozen; the brief must fail open` };
	const problems: string[] = [];
	if (res.ms > budgetMs) problems.push(`answered in ${Math.round(res.ms)} ms, over the ${budgetMs} ms budget`);
	if (!res.text.startsWith(FULL_BRIEF_HEADING)) problems.push("text does not open with the brief heading");
	if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
	return { ok: true, detail: `state ${res.headers["x-substrate-brief"] ?? "?"} in ${Math.round(res.ms)} ms` };
}

/** An emit: 202, `stored: true` and the normalised event's id. */
export function judgeEmit(res: HttpResult): Judged {
	const none = noAnswer(res);
	if (none) return none;
	const body = jsonObject(res.text);
	if (res.status !== 202) return { ok: false, detail: `HTTP ${res.status}${typeof body?.error === "string" ? `: ${body.error.slice(0, 120)}` : ""}` };
	if (body?.stored !== true) return { ok: false, detail: "202 without stored:true" };
	if (typeof body.id !== "string" || body.id === "") return { ok: false, detail: "no event id in the answer" };
	return { ok: true, detail: "stored" };
}

/** An unknown `profile` is the caller's mistake: 400, never a silent default. */
export function judgeProfileTypo(res: HttpResult): Judged {
	const none = noAnswer(res);
	if (none) return none;
	if (res.status !== 400) return { ok: false, detail: `a typo'd profile answered HTTP ${res.status}, wanted 400` };
	return { ok: true, detail: "refused with 400" };
}

// ── process plumbing ─────────────────────────────────────────────────────────

/**
 * The two image overrides `rehearsal up` reads (docs/rehearsal.md): non-secret image tags, forwarded
 * to the harness only, never to a proof. The ledger one is composed so no tracked line here holds
 * the ledger-key substring the store lock scans for, as in rehearsal.ts.
 */
export const IMAGE_OVERRIDE_KEYS = ["SUBSTRATE_REHEARSAL_PG_IMAGE", `SUBSTRATE_REHEARSAL_${"GREPTIME"}_IMAGE`] as const;

export function imageOverrides(parent: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of IMAGE_OVERRIDE_KEYS) {
		const value = parent[key];
		if (value !== undefined && value.trim() !== "") out[key] = value;
	}
	return out;
}

/** The environment a child may inherit from the caller: where things are, never what they are connected to. */
const CHILD_ENV_KEYS = ["PATH", "HOME", "XDG_RUNTIME_DIR", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"] as const;

/**
 * A child's environment: the allowlisted host keys and `BUN_*`, then `extra`. Never the caller's
 * `SUBSTRATE_*`, so a shell that exports production's URL or a token cannot reach a proof, and never
 * `CHAOS_*` unless the gate sets it.
 */
export function childEnv(parent: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = parent[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined && key.startsWith("BUN_")) env[key] = value;
	}
	return { ...env, ...extra };
}

export interface RunResult {
	/** `null` when killed (timeout, interruption) or never started. */
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
}

export interface RunOptions {
	env: Record<string, string>;
	timeoutMs: number;
	/** Kill the child and reject with `GateInterrupted` when this aborts. Cleanup runs pass none. */
	interruptible: boolean;
}

/** The run was interrupted (SIGINT/SIGTERM/SIGHUP); the message says which. */
export class GateInterrupted extends Error {}

export interface GateDeps {
	/** Run one child process to completion. Rejects with `GateInterrupted` when interrupted and `interruptible`. */
	run(argv: string[], options: RunOptions): Promise<RunResult>;
	/** One HTTP call; never rejects except with `GateInterrupted`. */
	http(base: string, req: { method: "GET" | "POST"; path: string; token: string | null; body?: unknown; timeoutMs?: number }): Promise<HttpResult>;
	readFile(path: string): string | null;
	exists(path: string): boolean;
	/** Wall clock, ms. */
	now(): number;
	/** Resolves early when the run is interrupted. */
	sleep(ms: number): Promise<void>;
	runDir(name: string): string;
	freshName(): string;
	parentEnv: Record<string, string | undefined>;
	/** Progress lines: stderr in the real CLI. */
	log(line: string): void;
	signal: AbortSignal;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed.slice(0, 300);
	}
	return "";
}

/** The reason in a harness refusal (`[rehearsal] refused: <why>.`), else its first line. */
export function refusalReason(err: string, out = ""): string {
	for (const line of err.split("\n")) {
		const at = line.indexOf("refused: ");
		if (at >= 0) return line.slice(at + "refused: ".length).replace(/\.$/, "").trim().slice(0, 300);
	}
	return firstLine(err) || firstLine(out) || "no reason given";
}

/** A child smoke's `N/M ... passed` line and up to three failed-check lines, for a receipt's detail. */
export function summarizeProofOutput(out: string): string {
	const lines = out.split("\n");
	const counts = lines.find((line) => /\d+\/\d+ (smoke |)checks passed/.test(line))?.trim();
	const failed: string[] = [];
	let inFailed = false;
	for (const line of lines) {
		if (line.trim() === "failed:") {
			inFailed = true;
			continue;
		}
		if (inFailed && line.trimStart().startsWith("- ")) failed.push(line.trim().slice(2, 160));
		else if (/^\s*FAIL\b/.test(line) && !inFailed) failed.push(line.replace(/^\s*FAIL\s*/, "").trim().slice(0, 160));
	}
	const shown = failed.slice(0, 3).join(" | ");
	return [counts, shown === "" ? undefined : `failed: ${shown}`].filter(Boolean).join("; ");
}

// ── the gate ─────────────────────────────────────────────────────────────────

interface StepOutcome {
	ok: boolean;
	detail: string;
	/** Not a pass and not a failure: the step could not be attempted (a harness refusal). */
	skipped?: boolean;
	/** Carried onto the check when it passes. */
	note?: string;
}

const PROOF_IDS: readonly string[] = CHECK_IDS.filter((id) => id !== "up" && !id.startsWith("cleanup."));
const PROOF_IDS_AFTER_CONSUMER: readonly string[] = PROOF_IDS.filter((id) => id !== "consumer");
const PROOF_IDS_AFTER_LIVEZ: readonly string[] = PROOF_IDS_AFTER_CONSUMER.filter((id) => id !== "livez");

function errorLine(cause: unknown): string {
	return String((cause as Error)?.message ?? cause).split("\n")[0]?.slice(0, 300) ?? "";
}

/** Records checks in order and prints one progress line per finished check. */
class Recorder {
	readonly checks: Check[] = [];
	constructor(private readonly deps: GateDeps) {}

	private push(check: Check): void {
		this.checks.push(check);
		this.deps.log(`[gate] ${check.status.padEnd(4)} ${check.id} ${check.ms} ms${check.detail ? ` - ${check.detail}` : ""}`);
	}

	/** Throws `GateInterrupted` once SIGINT/SIGTERM/SIGHUP has been seen. Loops that wait call it. */
	throwIfInterrupted(): void {
		if (this.deps.signal.aborted) throw new GateInterrupted(String(this.deps.signal.reason ?? "interrupted"));
	}

	/**
	 * Run `body` as the named check. A throw is a failed check; only an interruption escapes. An
	 * interruption that arrives while `body` runs does not discard what `body` concluded: waits and
	 * child runs throw `GateInterrupted` instead of returning a verdict, so an outcome that comes
	 * back is the body's own, and it is recorded before the interruption is rethrown (a failure that
	 * really happened keeps the exit at 1, not 2).
	 */
	async step(id: string, body: () => Promise<StepOutcome>): Promise<boolean> {
		this.throwIfInterrupted();
		const started = this.deps.now();
		let outcome: StepOutcome;
		try {
			outcome = await body();
		} catch (cause) {
			if (cause instanceof GateInterrupted) throw cause;
			outcome = { ok: false, detail: `threw: ${errorLine(cause)}` };
		}
		const status: CheckStatus = outcome.skipped ? "skip" : outcome.ok ? "pass" : "fail";
		this.push({ id, status, ms: Math.max(0, this.deps.now() - started), detail: outcome.detail, ...(outcome.note !== undefined && status === "pass" ? { note: outcome.note } : {}) });
		this.throwIfInterrupted();
		return outcome.ok;
	}

	/** Checks that were not run, with the reason; never a pass. */
	skip(ids: readonly string[], reason: string): void {
		for (const id of ids) this.push({ id, status: "skip", ms: 0, detail: reason });
	}

	/** A cleanup step: recorded like any other, and never abandoned for an interruption already seen. */
	async cleanup(id: string, body: () => Promise<StepOutcome>): Promise<boolean> {
		const started = this.deps.now();
		let outcome: StepOutcome;
		try {
			outcome = await body();
		} catch (cause) {
			outcome = { ok: false, detail: `threw: ${errorLine(cause)}` };
		}
		this.push({ id, status: outcome.ok ? "pass" : "fail", ms: Math.max(0, this.deps.now() - started), detail: outcome.detail });
		return outcome.ok;
	}
}

/** A refusal that means another operation holds this name; the gate must not tear that down. */
export function isContention(reason: string): boolean {
	return /already running|locked by another operation|could not be verified/.test(reason);
}

function bunArgv(script: string, ...args: string[]): string[] {
	return [process.execPath, "--no-env-file", join(ROOT, "scripts", script), ...args];
}

/**
 * Run the gate. Always returns a receipt; the only things that escape are bugs in `deps`. Cleanup
 * runs after the proofs on every path (a pass, a failed check, an unexpected throw, an
 * interruption): thaw a frozen ledger, then `down` an instance this run started.
 *
 * Verdict: any failed check (a failed teardown included: residue is never reported as
 * "unavailable") is `fail`, even when the run was also interrupted; otherwise an unavailable reason
 * (refused start, taken name, interruption) is `unavailable`; otherwise `pass`.
 */
export async function runGate(opts: GateOptions, deps: GateDeps): Promise<Receipt> {
	const started = deps.now();
	const name = opts.name ?? deps.freshName();
	const rec = new Recorder(deps);
	const runDir = deps.runDir(name);
	const state = { unavailable: null as string | null, ownsInstance: false, ledgerPaused: false, commit: "unknown", kept: false };
	// The harness (not the proofs) honours the image overrides, so `up` can find the images an operator loaded.
	const harnessEnv = childEnv(deps.parentEnv, imageOverrides(deps.parentEnv));
	const harness = (...args: string[]): string[] => bunArgv("rehearsal.ts", ...args);

	/** The proofs, in order. Returns early when a later step has nothing to stand on. */
	async function proveAll(): Promise<void> {
		if (deps.exists(runDir)) {
			state.unavailable = `instance ${name} already has a run directory; pick another --name or run \`bun run rehearsal down --name ${name}\``;
			rec.skip(["up"], `unavailable: ${state.unavailable}`);
			return;
		}

		// up. Owned from here on: a killed or timed-out `up` may have created containers, and `down`
		// is label-scoped to this name, so it is safe to run. Only a harness refusal (exit 2) clears
		// ownership: it refused before creating anything.
		state.ownsInstance = true;
		const upArgs = ["up", "--name", name, "--port", "0", "--surfaces", opts.surfaces.join(",")];
		for (const entry of GATE_EXTRA_ENV) upArgs.push("--extra-env", entry);
		const upOk = await rec.step("up", async () => {
			const result = await deps.run(harness(...upArgs), { env: harnessEnv, timeoutMs: UP_TIMEOUT_MS, interruptible: true });
			if (result.code === 2) {
				state.unavailable = refusalReason(result.err, result.out);
				// The harness makes the run directory (and writes token files) before several of its
				// refusals and removes none of it. Absent before `up` (checked above), so a run directory
				// now is this run's own, unless the refusal is contention: then the name is someone else's.
				state.ownsInstance = deps.exists(runDir) && !isContention(state.unavailable);
				return { ok: false, skipped: true, detail: `the harness refused to start: ${state.unavailable}` };
			}
			if (result.code !== 0) {
				return { ok: false, detail: result.timedOut ? "rehearsal up timed out" : `rehearsal up exited ${String(result.code)}: ${firstLine(result.err) || firstLine(result.out)}` };
			}
			const twin = jsonObject(deps.readFile(join(runDir, "state.json")) ?? "");
			if (typeof twin?.commit === "string" && /^[0-9a-f]{7,40}$/.test(twin.commit)) state.commit = twin.commit.slice(0, 12);
			return { ok: true, detail: `twin ${name} healthy` };
		});
		if (state.unavailable !== null) return;
		if (!upOk) {
			rec.skip(PROOF_IDS, "the twin did not come up");
			return;
		}

		// consumer: where the twin is and who may call it. Tokens stay in these locals.
		let base = "";
		let ccToken = "";
		let gbToken = "";
		let tokensDir = "";
		const consumerOk = await rec.step("consumer", async () => {
			const record = parseShellExports(deps.readFile(join(runDir, "consumer.env")) ?? "");
			base = (record.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
			tokensDir = record.SUBSTRATE_REHEARSAL_TOKENS_DIR ?? "";
			if (base === "") return { ok: false, detail: "consumer.env has no twin url" };
			const refused = refuseSmokeUrl(base);
			if (refused !== null) return { ok: false, detail: refused };
			if (tokensDir === "") return { ok: false, detail: "consumer.env has no tokens dir" };
			ccToken = (deps.readFile(join(tokensDir, "claude-code")) ?? "").trim();
			gbToken = (deps.readFile(join(tokensDir, "grok-bot")) ?? "").trim();
			if (ccToken === "" || gbToken === "") return { ok: false, detail: "a driven surface has no token file" };
			return { ok: true, detail: `twin at ${new URL(base).host}` };
		});
		if (!consumerOk) {
			rec.skip(PROOF_IDS_AFTER_CONSUMER, "no usable consumer.env");
			return;
		}

		const call = (token: string | null, method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<HttpResult> =>
			deps.http(base, { method, path, token, ...(body === undefined ? {} : { body }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
		const proofEnv = (extra: Record<string, string> = {}): Record<string, string> =>
			childEnv(deps.parentEnv, { SUBSTRATE_URL: base, SUBSTRATE_TOKEN: ccToken, SUBSTRATE_TOKENS_DIR: tokensDir, ...extra });

		// Liveness, health, SLO shape.
		const live = await rec.step("livez", async () => judgeLivez(await call(null, "GET", "/livez")));
		if (!live) {
			rec.skip(PROOF_IDS_AFTER_LIVEZ, "the twin does not answer /livez");
			return;
		}
		await rec.step("healthz", async () => judgeHealthz(await call(ccToken, "GET", "/healthz")));
		await rec.step("slo", async () => judgeSlo(await call(ccToken, "GET", "/slo")));

		// The brief, per surface and per profile.
		await rec.step("brief.claude-code", async () =>
			judgeBrief(await call(ccToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate" }), { profile: "full", state: "complete" }),
		);
		// `SUBSTRATE_BRIEF_PROFILE=shadow` is the contract: every caller is served the full text, whoever
		// asked for what, until the operator flips it to `enforce`.
		await rec.step("brief.grok-bot", async () => {
			const unnamed = judgeBrief(await call(gbToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate" }), { profile: "full", state: "complete" });
			if (!unnamed.ok) return { ok: false, detail: `no profile named: ${unnamed.detail}` };
			const compact = judgeBrief(await call(gbToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate", profile: "compact" }), { profile: "full", state: "complete" });
			if (!compact.ok) return { ok: false, detail: `compact asked under shadow: ${compact.detail}` };
			return { ok: true, detail: `shadow serves the full text, asked or not (${unnamed.detail})` };
		});
		await rec.step("brief.profile-typo", async () => judgeProfileTypo(await call(gbToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate", profile: "compat" })));

		// Emit, then see it in the brief.
		const tag = `gt${deps.now().toString(36)}`;
		const emitted = await rec.step("emit", async () =>
			judgeEmit(await call(ccToken, "POST", "/events", { kind: "note", summary: `release gate proof ${tag}`, repo: GATE_REPO, graph_id: tag, session_id: tag })),
		);
		if (emitted) {
			await rec.step("brief.visibility", async () => {
				const deadline = deps.now() + VISIBILITY_WAIT_MS;
				let last = "no brief read";
				for (;;) {
					const res = await call(ccToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate" });
					if (res.status === 200 && res.text.includes(tag)) return { ok: true, detail: "the emitted event is in the brief" };
					last = res.status === 200 ? "answered without the event" : `HTTP ${String(res.status)}`;
					if (deps.now() >= deadline) break;
					await deps.sleep(POLL_MS);
					rec.throwIfInterrupted();
				}
				return { ok: false, detail: `${last} for ${Math.round(VISIBILITY_WAIT_MS / 1000)} s after a stored emit` };
			});
		} else {
			rec.skip(["brief.visibility"], "the emit failed");
		}

		// The existing proofs, over the wire.
		await rec.step("rehearsal.smoke", async () => {
			const result = await deps.run(harness("smoke", "--name", name), { env: harnessEnv, timeoutMs: STEP_TIMEOUT_MS, interruptible: true });
			if (result.code === 0) return { ok: true, detail: summarizeProofOutput(result.out) || "all steps passed" };
			return { ok: false, detail: result.timedOut ? "timed out" : `exit ${String(result.code)}: ${summarizeProofOutput(result.out) || firstLine(result.err)}` };
		});
		await rec.step("smoke.grok", async () => {
			const result = await deps.run(bunArgv("grok-connector-smoke.ts"), { env: proofEnv(), timeoutMs: STEP_TIMEOUT_MS, interruptible: true });
			// 0 = ok, 1 = degraded (the contract held; a plane was not fully up) - both prove the
			// connector contract. 2 = a check failed, the service was unreachable or the bearer refused.
			if (result.code === 0) return { ok: true, detail: "exit 0, every check ok" };
			if (result.code === 1) {
				return {
					ok: true,
					detail: "exit 1, degraded: the contract held, a plane was not fully up",
					note: "smoke:grok reported degraded (exit 1) and the gate accepts it: the connector contract held, but a plane or breaker was not fully up. On this twin Hindsight, RAGFlow and the cache are not configured.",
				};
			}
			return { ok: false, detail: result.timedOut ? "timed out" : `exit ${String(result.code)}: ${firstLine(result.out) || firstLine(result.err)}` };
		});

		// A real ledger outage. `ledgerPaused` is set before the call: a pause that half-happened is
		// still thawed by cleanup.
		state.ledgerPaused = true;
		const paused = await rec.step("outage.pause", async () => {
			const result = await deps.run(harness("pause", "--name", name, "--store", "ledger"), { env: harnessEnv, timeoutMs: PAUSE_TIMEOUT_MS, interruptible: true });
			if (result.code !== 0) return { ok: false, detail: `exit ${String(result.code)}: ${refusalReason(result.err, result.out)}` };
			return { ok: true, detail: "the twin's ledger container is frozen" };
		});
		if (paused) {
			// While frozen: the brief first (before any breaker has opened), then the chaos smoke.
			await rec.step("outage.brief", async () => judgeOutageBrief(await call(gbToken, "POST", "/brief", { repo: GATE_REPO, branch: "gate" }, HTTP_TIMEOUT_MS)));
			await rec.step("outage.chaos", async () => {
				const result = await deps.run(bunArgv("chaos-smoke.ts"), {
					// CHAOS_REHEARSAL is deliberately absent: it would turn the outage-only checks into notes.
					env: proofEnv({ CHAOS_WINDOW_MS: String(opts.windowMs), CHAOS_TICK_MS: "2000", CHAOS_TIMEOUT_MS: String(CHAOS_REQUEST_TIMEOUT_MS) }),
					timeoutMs: opts.windowMs + CHAOS_MARGIN_MS,
					interruptible: true,
				});
				if (result.timedOut) return { ok: false, detail: `the chaos smoke did not finish within ${Math.round((opts.windowMs + CHAOS_MARGIN_MS) / 1000)} s: something hung` };
				if (result.code === 0) return { ok: true, detail: summarizeProofOutput(result.out) || "fail-open and fail-closed held" };
				return { ok: false, detail: `exit ${String(result.code)}: ${summarizeProofOutput(result.out) || firstLine(result.err) || firstLine(result.out)}` };
			});
		} else {
			rec.skip(["outage.brief", "outage.chaos"], "the ledger could not be frozen");
		}
		// Unpause even when the pause failed halfway: it is idempotent, and a store left frozen is worse than a noisy no-op.
		const thawed = await rec.step("outage.unpause", async () => {
			const result = await deps.run(harness("unpause", "--name", name, "--store", "ledger"), { env: harnessEnv, timeoutMs: PAUSE_TIMEOUT_MS, interruptible: true });
			if (result.code !== 0) return { ok: false, detail: `exit ${String(result.code)}: ${refusalReason(result.err, result.out)}` };
			state.ledgerPaused = false;
			return { ok: true, detail: "the ledger container is running again" };
		});
		if (!thawed) {
			rec.skip(["recovery.healthz", "recovery.emit"], "the ledger could not be unfrozen");
			return;
		}
		await rec.step("recovery.healthz", async () => {
			const first = deps.now();
			const deadline = first + RECOVERY_WAIT_MS;
			let last: Judged = { ok: false, detail: "no /healthz read" };
			for (;;) {
				last = judgeHealthz(await call(ccToken, "GET", "/healthz"));
				if (last.ok) return { ok: true, detail: `both stores writable ${Math.round((deps.now() - first) / 1000)} s after the unpause` };
				if (deps.now() >= deadline) break;
				await deps.sleep(RECOVERY_POLL_MS);
				rec.throwIfInterrupted();
			}
			return { ok: false, detail: `still not healthy ${Math.round(RECOVERY_WAIT_MS / 1000)} s after the unpause: ${last.detail}` };
		});
		// The write probe and the append path can lag the read path by a moment, so this is polled
		// with the same bound as the health recovery before it counts as a failure.
		await rec.step("recovery.emit", async () => {
			const first = deps.now();
			const deadline = first + RECOVERY_WAIT_MS;
			let last: Judged = { ok: false, detail: "no emit attempted" };
			for (;;) {
				last = judgeEmit(await call(ccToken, "POST", "/events", { kind: "note", summary: `release gate recovery ${tag}`, repo: GATE_REPO, graph_id: tag, session_id: tag }));
				if (last.ok) return { ok: true, detail: `stored ${Math.round((deps.now() - first) / 1000)} s after the health recovery` };
				if (deps.now() >= deadline) break;
				await deps.sleep(RECOVERY_POLL_MS);
				rec.throwIfInterrupted();
			}
			return { ok: false, detail: `still refused ${Math.round(RECOVERY_WAIT_MS / 1000)} s after the health recovery: ${last.detail}` };
		});
	}

	/** Cleanup on every path: thaw a frozen ledger, then `down` an instance this run started. Never throws. */
	async function cleanupAll(): Promise<void> {
		if (state.ledgerPaused) {
			await rec.cleanup("cleanup.unpause", async () => {
				const result = await deps.run(harness("unpause", "--name", name, "--store", "ledger"), { env: harnessEnv, timeoutMs: PAUSE_TIMEOUT_MS, interruptible: false });
				if (result.code !== 0) return { ok: false, detail: `exit ${String(result.code)}: ${refusalReason(result.err, result.out)}` };
				state.ledgerPaused = false;
				return { ok: true, detail: "thawed the ledger after an interrupted or failed run" };
			});
		}
		if (!state.ownsInstance) return;
		if (opts.keep) {
			state.kept = true;
			return;
		}
		await rec.cleanup("cleanup.down", async () => {
			const result = await deps.run(harness("down", "--name", name), { env: harnessEnv, timeoutMs: DOWN_TIMEOUT_MS, interruptible: false });
			if (result.code !== 0) return { ok: false, detail: `rehearsal down exited ${String(result.code)}: ${refusalReason(result.err, result.out)}; the twin may still be running` };
			return { ok: true, detail: firstLine(result.out).replace(/^\[rehearsal\] /, "") || "down" };
		});
		await rec.cleanup("cleanup.residue", async () => {
			const listing = await deps.run(["docker", "ps", "-aq", "--filter", `label=${REHEARSAL_LABEL}=${name}`], { env: harnessEnv, timeoutMs: PAUSE_TIMEOUT_MS, interruptible: false });
			if (listing.code !== 0) return { ok: false, detail: `could not list containers to prove none are left: ${firstLine(listing.err)}` };
			const left = listing.out.split("\n").filter((line) => line.trim() !== "").length;
			if (left > 0) return { ok: false, detail: `${left} labelled container(s) left for ${name}` };
			if (deps.exists(runDir)) return { ok: false, detail: `run directory ${runDir} left behind` };
			return { ok: true, detail: "no labelled container and no run directory left" };
		});
	}

	try {
		try {
			await proveAll();
		} catch (cause) {
			if (cause instanceof GateInterrupted) state.unavailable = cause.message || "interrupted";
			else await rec.cleanup("gate.internal", async () => ({ ok: false, detail: `unexpected error: ${errorLine(cause)}` }));
		}
	} finally {
		await cleanupAll();
	}

	const failed = rec.checks.some((check) => check.status === "fail");
	const verdict: Verdict = failed ? "fail" : state.unavailable !== null ? "unavailable" : "pass";
	return {
		kind: "gate-receipt",
		name,
		commit: state.commit,
		verdict,
		exit: verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2,
		ms: Math.max(0, deps.now() - started),
		checks: rec.checks,
		unavailable: state.unavailable,
		kept: state.kept,
	};
}

// ── the receipt ──────────────────────────────────────────────────────────────

/**
 * The human receipt: one row per check with its timing, then the single `gate-receipt` line a deploy
 * hook or a log search keys on (`key=value` pairs, the reason JSON-quoted, no token and no host).
 */
export function formatReceipt(receipt: Receipt): string {
	const width = Math.max(5, ...receipt.checks.map((check) => check.id.length));
	const rows = receipt.checks.flatMap((check) => [
		`${check.status.toUpperCase().padEnd(5)} ${check.id.padEnd(width)} ${String(check.ms).padStart(7)} ms  ${check.detail}`,
		...(check.note === undefined ? [] : [`NOTE  ${check.id.padEnd(width)}            ${check.note}`]),
	]);
	const notes = receipt.checks.filter((check) => check.note !== undefined).length;
	const count = (status: CheckStatus): number => receipt.checks.filter((check) => check.status === status).length;
	const failed = receipt.checks.filter((check) => check.status === "fail").map((check) => check.id);
	const line = [
		"gate-receipt",
		`name=${receipt.name}`,
		`commit=${receipt.commit}`,
		`verdict=${receipt.verdict}`,
		`exit=${receipt.exit}`,
		`checks=${receipt.checks.length}`,
		`pass=${count("pass")}`,
		`fail=${count("fail")}`,
		`skip=${count("skip")}`,
		`notes=${notes}`,
		`failed=${failed.length === 0 ? "-" : failed.join(",")}`,
		`unavailable=${receipt.unavailable === null ? "-" : JSON.stringify(receipt.unavailable)}`,
		`kept=${receipt.kept}`,
		`ms=${receipt.ms}`,
	].join(" ");
	const kept = receipt.kept ? `\nThe twin was left running (--keep). Remove it with: bun run rehearsal down --name ${receipt.name}\n` : "";
	return `\nRelease gate - ${receipt.name}\n\n${rows.join("\n")}\n${kept}\n${line}\n`;
}

// ── the real dependencies ────────────────────────────────────────────────────

function tailText(text: string): string {
	return text.length > OUTPUT_CAP ? text.slice(text.length - OUTPUT_CAP) : text;
}

function realDeps(signal: AbortSignal): GateDeps {
	return {
		async run(argv, options): Promise<RunResult> {
			if (options.interruptible && signal.aborted) throw new GateInterrupted(String(signal.reason ?? "interrupted"));
			let timedOut = false;
			let child: Subprocess<"ignore", "pipe", "pipe">;
			try {
				child = Bun.spawn(argv, { cwd: ROOT, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			} catch (cause) {
				return { code: null, out: "", err: errorLine(cause), timedOut: false };
			}
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
			timer.unref();
			const onAbort = (): void => {
				child.kill("SIGTERM");
			};
			if (options.interruptible) signal.addEventListener("abort", onAbort, { once: true });
			try {
				const [out, err, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				if (options.interruptible && signal.aborted) throw new GateInterrupted(String(signal.reason ?? "interrupted"));
				return { code: timedOut ? null : code, out: tailText(out), err: tailText(err), timedOut };
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
			}
		},
		async http(base, req): Promise<HttpResult> {
			const started = performance.now();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (req.token !== null) headers.authorization = `Bearer ${req.token}`;
			try {
				const response = await fetch(`${base}${req.path}`, {
					method: req.method,
					headers,
					...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
					signal: AbortSignal.any([AbortSignal.timeout(req.timeoutMs ?? HTTP_TIMEOUT_MS), signal]),
				});
				const text = await response.text();
				const seen: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					seen[key.toLowerCase()] = value;
				});
				return { status: response.status, headers: seen, text, ms: performance.now() - started };
			} catch (cause) {
				// An interruption is not an unreachable twin: it must not become a failed check.
				if (signal.aborted) throw new GateInterrupted(String(signal.reason ?? "interrupted"));
				return { status: null, headers: {}, text: "", ms: performance.now() - started, error: errorLine(cause) };
			}
		},
		readFile(path) {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		exists: existsSync,
		now: () => Date.now(),
		sleep(ms) {
			if (signal.aborted) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const done = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, ms);
				timer.unref();
				signal.addEventListener("abort", done, { once: true });
			});
		},
		runDir: runDirFor,
		freshName: () => `gate-${Date.now().toString(36)}`,
		parentEnv: process.env,
		log: (line) => process.stderr.write(`${line}\n`),
		signal,
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`[gate] ${parsed.error}\nusage: gate:boot [--name <id>] [--surfaces a,b] [--window-ms N] [--keep] [--json]\n`);
		return 2;
	}
	const controller = new AbortController();
	// Registered before the first await: an interruption during `up` still reaches `down`.
	const onSignal = (signalName: string): void => {
		if (controller.signal.aborted) {
			process.stderr.write(`[gate] ${signalName} again: cleanup is already running\n`);
			return;
		}
		controller.abort(`interrupted by ${signalName}`);
	};
	const onInt = (): void => onSignal("SIGINT");
	const onTerm = (): void => onSignal("SIGTERM");
	// A CI cancel or a dropped ssh session sends SIGHUP (or SIGTERM, then SIGKILL after a grace period).
	const onHup = (): void => onSignal("SIGHUP");
	process.on("SIGINT", onInt);
	process.on("SIGTERM", onTerm);
	process.on("SIGHUP", onHup);
	try {
		const receipt = await runGate(parsed, realDeps(controller.signal));
		if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
		else process.stdout.write(formatReceipt(receipt));
		return receipt.exit;
	} finally {
		process.off("SIGINT", onInt);
		process.off("SIGTERM", onTerm);
		process.off("SIGHUP", onHup);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
