#!/usr/bin/env bun
/**
 * The LightRAG live smoke runner: operator-run proof that a deployed LightRAG
 * server works and is not wide open (`index-sweep-run.ts` / `ledger-run.ts`
 * precedent).
 *
 *   bun packages/mcp-server/src/lightrag-smoke-run.ts --confirm-live [--no-auth-expected] [--json]
 *
 * It writes ONE synthetic document to the live server and deletes it again, so
 * it refuses without `--confirm-live` (exit 2). The server is reached through
 * `loadConfig` (`LIGHTRAG_URL`, `LIGHTRAG_API_KEY`) and the plane client
 * (`planes/lightrag.ts`); this file reads no env var of its own and never
 * deploys anything.
 *
 * Checks, in order. Each is pass, fail or skip with a short redacted reason and
 * a duration:
 *   1. health: `GET /health` is healthy; the core version is recorded.
 *   2. auth-negative: a protected route (`GET /documents/pipeline_status`)
 *      called with NO credentials must be refused (401 or 403). An accepted
 *      anonymous call is a FAIL named `unauthenticated-access-allowed`: a
 *      deployment without an API key never passes. Only `--no-auth-expected`
 *      skips it, and the skip says so loudly.
 *   3. ingest: one synthetic text document carrying a unique marker goes in
 *      through the client, its document id resolves through `track_status`,
 *      the pipeline goes idle within the deadline (`recovery_required` is a
 *      FAIL) and the document reads `processed`.
 *   4. query: the marker comes back in a returned chunk (`only_need_context`,
 *      the client's default mode).
 *   5. delete: ONLY the document id this run created is removed through the
 *      per-document route, and it no longer appears. It runs in a `finally`
 *      block, so a failed ingest or query still cleans up (within its own
 *      budget, `cleanupBudgetMs`, which is not part of the total deadline).
 *   6. clear-all-guard: the client's own denylist refuses `DELETE /documents`
 *      locally, with no network call (a regression guard).
 *
 * Output: a human summary, or with `--json` one object
 * `{ schema: 1, version, checks: [{ name, status, reason, durationMs }], ok }`
 * (`version` is the server's core version, or null). The URL, the key and the
 * document content are never printed; only the marker is.
 *
 * Exit codes: 0 every check passed or was skipped, 1 a check failed, 2 usage or
 * config (no `--confirm-live`, an unknown argument, no `LIGHTRAG_URL`, an
 * unusable URL), 3 the server was unreachable.
 */
import { ConfigError, loadConfig, type LightragConfig } from "./config.ts";
import {
	deleteDocuments,
	isClearAllRequest,
	LIGHTRAG_CLEAR_ALL_REFUSED,
	lightragCall,
	pollParseStatus,
	probeLightrag,
	queryWithGraph,
	resolveDocumentIds,
	uploadDocument,
	type FetchLike,
} from "./planes/lightrag.ts";
import { redact, redactKnown } from "./redact.ts";

export const SMOKE_SCHEMA = 1;

export const SMOKE_USAGE =
	"usage: lightrag-smoke-run.ts --confirm-live [--no-auth-expected] [--json]\n" +
	"  --confirm-live      required: the run uploads one synthetic document to the live server and deletes it\n" +
	"  --no-auth-expected  skip the anonymous-access check for a deployment that is deliberately keyless\n" +
	"  --json              print one JSON object instead of the summary\n" +
	"  LIGHTRAG_URL (required) and LIGHTRAG_API_KEY name the server; exit 0 ok, 1 a check failed, 2 usage or config, 3 unreachable\n";

export type SmokeCheckName = "health" | "auth-negative" | "ingest" | "query" | "delete" | "clear-all-guard";
export type SmokeCheckStatus = "pass" | "fail" | "skip";

export interface SmokeCheck {
	name: SmokeCheckName;
	status: SmokeCheckStatus;
	/** Short and redacted: never the URL, the key or any document content. */
	reason: string;
	durationMs: number;
}

export interface SmokeReport {
	schema: typeof SMOKE_SCHEMA;
	/** The server's core version as `/health` reported it, or null. */
	version: string | null;
	checks: SmokeCheck[];
	ok: boolean;
}

export type SmokeExitCode = 0 | 1 | 3;

export interface SmokeResult {
	report: SmokeReport;
	exitCode: SmokeExitCode;
	/** Set when the auth-negative check was skipped by `--no-auth-expected`: the summary prints a warning for it. */
	noAuthExpected: boolean;
}

/** A refusal the operator can fix: bad arguments or config. Exit 2. */
export class SmokeUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SmokeUsageError";
	}
}

export interface SmokeArgs {
	json: boolean;
	noAuthExpected: boolean;
}

const KNOWN_FLAGS = ["--confirm-live", "--json", "--no-auth-expected"];

/**
 * Strict argv grammar: exactly the three flags, each at most once, no
 * positionals, no `--flag=value` forms. An unknown argument is not echoed (a
 * pasted key would land in a log). `--confirm-live` is mandatory.
 */
export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
	const seen = new Set<string>();
	argv.forEach((arg, index) => {
		if (!KNOWN_FLAGS.includes(arg)) throw new SmokeUsageError(`unknown argument at position ${index + 1}`);
		if (seen.has(arg)) throw new SmokeUsageError(`${arg} given twice`);
		seen.add(arg);
	});
	if (!seen.has("--confirm-live")) {
		throw new SmokeUsageError(
			"refused: --confirm-live is required; this run uploads one synthetic document to the live LightRAG server and deletes it",
		);
	}
	return { json: seen.has("--json"), noAuthExpected: seen.has("--no-auth-expected") };
}

/** What the unique marker must look like: lowercase, URL- and prompt-safe, never a secret shape. */
const MARKER_SHAPE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/** The default marker: random and unique per run, with no meaning beyond this run. */
export function defaultMarker(): string {
	return `lrsmoke${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export interface SmokeDeps {
	config: LightragConfig;
	/** The transport; production hands in the global `fetch`. */
	fetchImpl?: FetchLike;
	/** The clock; injected so deadlines are deterministic. */
	now?: () => number;
	/** Waits between polls; injected so tests never really wait. */
	sleep?: (ms: number) => Promise<void>;
	/** The unique marker generator; injected so tests are deterministic. */
	newMarker?: () => string;
	/** The deployment is deliberately keyless: skip the anonymous-access check, loudly. */
	noAuthExpected?: boolean;
	/** The budget for health, auth, ingest and query together. Default 120 s. */
	totalDeadlineMs?: number;
	/** The budget for the delete check, which runs even after a failure. Default 30 s. */
	cleanupBudgetMs?: number;
	/** The timeout of one call. Default 10 s. */
	callTimeoutMs?: number;
	/** The timeout of the query call (LLM keyword extraction can be slow). Default 30 s. */
	queryTimeoutMs?: number;
	/** The wait between polls. Default 1 s. */
	pollIntervalMs?: number;
	/** The client's request choke point; overridable only so a test can prove the guard check would catch a regression. */
	guardCall?: typeof lightragCall;
}

export interface Outcome {
	status: SmokeCheckStatus;
	reason: string;
}

const pass = (reason: string): Outcome => ({ status: "pass", reason });
const fail = (reason: string): Outcome => ({ status: "fail", reason });
const skip = (reason: string): Outcome => ({ status: "skip", reason });

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** The anonymous-access reasons that mean the server ANSWERED the call (any 2xx body), as opposed to refusing it. */
function answeredAnonymously(reason: string): boolean {
	return (
		reason === "parse-timeout" ||
		reason.startsWith("parse-failed") ||
		reason.startsWith("lightrag recovery required") ||
		reason === "lightrag: unexpected pipeline shape"
	);
}

const CLEAR_ALL_SPELLINGS = ["/documents", "/documents/", "/documents?force=1", "/Documents", "/documents/../documents"];

/**
 * The regression guard: the client's choke point must refuse every spelling of
 * the clear-all route locally. The fetch handed to it is a tripwire, so any
 * request that reaches the network is a failure, and the per-document route
 * must NOT be mistaken for clear-all.
 */
export async function checkClearAllGuard(url: string, guardCall: typeof lightragCall = lightragCall): Promise<Outcome> {
	let networkCalls = 0;
	const tripwire: FetchLike = async () => {
		networkCalls += 1;
		throw new Error("the guard check must never reach the network");
	};
	// Keyless on purpose: nothing may go out, so there is nothing to authenticate.
	const config: LightragConfig = { url };
	for (const path of CLEAR_ALL_SPELLINGS) {
		const refused = await guardCall(config, tripwire, path, {
			method: "DELETE",
			json: true,
			body: JSON.stringify({ doc_ids: [] }),
			timeoutMs: 100,
		});
		if (refused.ok || refused.reason !== LIGHTRAG_CLEAR_ALL_REFUSED) {
			return fail(`clear-all guard regression: DELETE ${path} was not refused locally`);
		}
	}
	if (networkCalls > 0) return fail(`clear-all guard regression: ${networkCalls} request(s) reached the network`);
	if (isClearAllRequest("DELETE", "/documents/delete_document")) {
		return fail("clear-all guard regression: the per-document delete route is classified as clear-all");
	}
	return pass(`refused ${CLEAR_ALL_SPELLINGS.length} spellings of DELETE /documents locally, no network call`);
}

/**
 * Run the six checks against one server. Never throws: an unexpected error
 * inside a check is that check's failure. Never prints.
 */
export async function runSmoke(deps: SmokeDeps): Promise<SmokeResult> {
	const { config } = deps;
	const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const newMarker = deps.newMarker ?? defaultMarker;
	const noAuthExpected = deps.noAuthExpected === true;
	const callTimeoutMs = deps.callTimeoutMs ?? 10_000;
	const queryTimeoutMs = deps.queryTimeoutMs ?? 30_000;
	const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? 1000);
	const cleanupBudgetMs = deps.cleanupBudgetMs ?? 30_000;
	const deadline = now() + (deps.totalDeadlineMs ?? 120_000);

	// The URL and the key never reach a reason: exact-match scrub first, then the shape rules.
	const needles: string[] = [config.url];
	try {
		needles.push(new URL(config.url).host);
	} catch {
		// An unparseable URL has no host to scrub; the whole URL is already a needle and every call will fail as unreachable.
	}
	if (config.apiKey) needles.push(config.apiKey);
	const scrub = (text: string): string => redact(redactKnown(text, needles)).replace(/\s+/g, " ").slice(0, 200);

	const run = async (name: SmokeCheckName, body: () => Promise<Outcome>): Promise<SmokeCheck> => {
		const started = now();
		let outcome: Outcome;
		try {
			outcome = await body();
		} catch (cause) {
			outcome = fail(`unexpected error: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		return { name, status: outcome.status, reason: scrub(outcome.reason), durationMs: Math.max(0, Math.round(now() - started)) };
	};

	const state = {
		version: null as string | null,
		unreachable: false,
		marker: null as string | null,
		trackId: null as string | null,
		docIds: [] as string[],
		ingested: false,
	};
	const checks: SmokeCheck[] = [];

	/** Wait for the pipeline to go idle, by polling single reads against the injected clock. */
	const waitIdle = async (until: number): Promise<{ ok: true } | { ok: false; reason: string }> => {
		for (;;) {
			const read = await pollParseStatus(config, { dataset_id: "", document_id: "" }, fetchImpl, {
				maxPolls: 1,
				intervalMs: 0,
				timeoutMs: callTimeoutMs,
			});
			if (read.ok) return { ok: true };
			if (read.reason.startsWith("lightrag recovery required")) {
				return { ok: false, reason: `recovery_required: ${read.reason.slice("lightrag recovery required".length).replace(/^:\s*/, "") || "the workspace is fenced"}` };
			}
			if (read.reason !== "parse-timeout") return { ok: false, reason: `pipeline status failed: ${read.reason}` };
			if (now() >= until) return { ok: false, reason: "pipeline did not go idle before the deadline" };
			await sleep(Math.max(1, Math.min(pollIntervalMs, until - now())));
		}
	};

	// 1. health
	checks.push(
		await run("health", async () => {
			const probe = await probeLightrag(config, fetchImpl, callTimeoutMs);
			if (!probe.ok) {
				const reason = probe.reason ?? "unhealthy";
				if (reason.startsWith("lightrag unreachable") || reason === "lightrag circuit open") state.unreachable = true;
				return fail(reason);
			}
			state.version = probe.version ?? null;
			return pass(`healthy, ${probe.version !== undefined ? `core ${probe.version}` : "core version not reported"}`);
		}),
	);

	if (state.unreachable) {
		for (const name of ["auth-negative", "ingest", "query", "delete"] as const) {
			checks.push({ name, status: "skip", reason: "server unreachable", durationMs: 0 });
		}
	} else {
		try {
			// 2. auth-negative
			checks.push(
				await run("auth-negative", async () => {
					if (noAuthExpected) {
						return skip(
							"NO-AUTH-EXPECTED: anonymous access was NOT verified; this deployment is assumed to run without an API key and anyone who can reach it can read and write",
						);
					}
					// The same client with no key: no X-API-Key header, a read-only protected route.
					const anonymous = await pollParseStatus({ url: config.url }, { dataset_id: "", document_id: "" }, fetchImpl, {
						maxPolls: 1,
						intervalMs: 0,
						timeoutMs: callTimeoutMs,
					});
					if (!anonymous.ok && /^lightrag (401|403)$/.test(anonymous.reason)) {
						return pass(`anonymous request refused (${anonymous.reason.slice("lightrag ".length)})`);
					}
					if (anonymous.ok || answeredAnonymously(anonymous.reason)) {
						return fail("unauthenticated-access-allowed: a request with no credentials was answered; set LIGHTRAG_API_KEY on the server");
					}
					return fail(`auth-negative inconclusive: ${anonymous.reason}`);
				}),
			);

			// 3. ingest
			checks.push(
				await run("ingest", async () => {
					const marker = newMarker();
					if (!MARKER_SHAPE.test(marker)) return fail("the marker generator returned an invalid marker");
					state.marker = marker;
					const uploaded = await uploadDocument(
						config,
						{
							name: `lightrag-smoke-${marker}.md`,
							content: `# LightRAG smoke document\n\nSynthetic text for the substrate smoke run. Marker: ${marker}. Safe to delete.\n`,
							metadata: { source_url: `lightrag-smoke:${marker}`, commit: "smoke", heading_path: "smoke" },
						},
						fetchImpl,
						callTimeoutMs,
					);
					if (!uploaded.ok) return fail(`upload failed: ${uploaded.reason}`);
					state.trackId = uploaded.track_id;
					const left = Math.max(0, deadline - now());
					const resolved = await resolveDocumentIds(config, uploaded.track_id, fetchImpl, {
						maxPolls: Math.max(1, Math.ceil(left / pollIntervalMs) + 1),
						intervalMs: pollIntervalMs,
						timeoutMs: callTimeoutMs,
						deadlineMs: left,
						sleep,
						now,
					});
					if (!resolved.ok) return fail(`document id not resolved: ${resolved.reason}`);
					state.docIds = resolved.ids;
					const idle = await waitIdle(deadline);
					if (!idle.ok) return fail(idle.reason);
					const settled = await resolveDocumentIds(config, uploaded.track_id, fetchImpl, { maxPolls: 1, timeoutMs: callTimeoutMs, now });
					if (!settled.ok) return fail(`document status unreadable after the pipeline went idle: ${settled.reason}`);
					const unprocessed = settled.documents.find((document) => document.status?.toLowerCase() !== "processed");
					if (unprocessed !== undefined) {
						const detail = unprocessed.error_msg ? `: ${unprocessed.error_msg}` : "";
						return fail(`document ended ${unprocessed.status ?? "without a status"}, not processed${detail}`);
					}
					state.ingested = true;
					return pass(`ingested marker ${marker}; pipeline idle; document processed`);
				}),
			);

			// 4. query
			checks.push(
				await run("query", async () => {
					const marker = state.marker;
					if (!state.ingested || marker === null) return skip("ingest did not complete");
					// `queryWithGraph` is the request path `queryForTool` wraps (same body, mode default and `only_need_context`);
					// `queryForTool` additionally caps each snippet at 1200 chars, which can cut the marker out of a long context string.
					const answered = await queryWithGraph(config, `Which document mentions ${marker}?`, fetchImpl, { timeoutMs: queryTimeoutMs });
					if (!answered.ok) return fail(`query failed: ${answered.reason}`);
					if (!answered.chunks.some((chunk) => chunk.content.includes(marker))) {
						return fail(`query returned ${answered.chunks.length} chunk(s), none containing the marker`);
					}
					return pass(`marker found in a returned chunk (mode ${answered.detail.mode})`);
				}),
			);
		} finally {
			// 5. delete: always, even after a failure above.
			checks.push(
				await run("delete", async () => {
					const trackId = state.trackId;
					if (trackId === null) return skip("nothing was uploaded");
					const until = now() + cleanupBudgetMs;
					let ids = state.docIds;
					if (ids.length === 0) {
						const found = await resolveDocumentIds(config, trackId, fetchImpl, { maxPolls: 1, timeoutMs: callTimeoutMs, now });
						if (!found.ok) {
							return fail(`cleanup could not resolve the created document id (${found.reason}); delete the marker ${state.marker ?? "document"} by hand`);
						}
						ids = found.ids;
					}
					for (;;) {
						const deleted = await deleteDocuments(config, "", ids, fetchImpl, callTimeoutMs);
						if (deleted.ok) break;
						if (deleted.retryable !== true || now() >= until) return fail(`delete failed: ${deleted.reason}`);
						await sleep(Math.max(1, Math.min(pollIntervalMs, until - now())));
					}
					const idle = await waitIdle(until);
					if (!idle.ok) return fail(`delete did not complete: ${idle.reason}`);
					for (;;) {
						const listed = await resolveDocumentIds(config, trackId, fetchImpl, { maxPolls: 1, timeoutMs: callTimeoutMs, now });
						if (!listed.ok) {
							// The track listing is empty once the document is gone; any other failure is a real one.
							if (listed.reason === "lightrag: track_status listed no documents" || listed.reason === "lightrag: track_status deadline exceeded with no documents") break;
							return fail(`delete verification failed: ${listed.reason}`);
						}
						if (!listed.ids.some((id) => ids.includes(id))) break;
						if (now() >= until) return fail("the created document is still listed after the delete");
						await sleep(Math.max(1, Math.min(pollIntervalMs, until - now())));
					}
					return pass(`deleted ${ids.length} document(s): only the one this run created; no longer listed`);
				}),
			);
		}
	}

	// 6. clear-all guard: local only, so it runs whatever happened above.
	checks.push(await run("clear-all-guard", () => checkClearAllGuard(config.url, deps.guardCall)));

	const failed = checks.some((check) => check.status === "fail");
	const exitCode: SmokeExitCode = state.unreachable ? 3 : failed ? 1 : 0;
	return {
		report: { schema: SMOKE_SCHEMA, version: state.version, checks, ok: !failed },
		exitCode,
		noAuthExpected,
	};
}

/** The human summary. Never carries the URL or the key: only reasons already scrubbed by `runSmoke`. */
export function formatSmoke(result: SmokeResult): string {
	const { report } = result;
	const lines = [`[lightrag-smoke] ${report.ok ? "OK" : "FAILED"} (core ${report.version ?? "unknown"})`];
	for (const check of report.checks) {
		lines.push(`  [${check.status}] ${check.name} (${check.durationMs} ms) ${check.reason}`);
	}
	if (result.noAuthExpected) {
		lines.push("[lightrag-smoke] WARNING: --no-auth-expected: anonymous access was NOT checked. This server must be reachable only from a trusted network.");
	}
	return `${lines.join("\n")}\n`;
}

export interface SmokeMainIo {
	env?: Record<string, string | undefined>;
	fetchImpl?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	newMarker?: () => string;
	write?: (text: string) => void;
	writeErr?: (text: string) => void;
}

/** The CLI: parse, load config, run, print, and return the exit code. */
export async function main(argv: readonly string[], io: SmokeMainIo = {}): Promise<number> {
	const write = io.write ?? ((text: string) => void process.stdout.write(text));
	const writeErr = io.writeErr ?? ((text: string) => void process.stderr.write(text));
	const refuse = (message: string): number => {
		writeErr(`${redact(message).slice(0, 300)}\n${SMOKE_USAGE}`);
		return 2;
	};
	let args: SmokeArgs;
	try {
		args = parseSmokeArgs(argv);
	} catch (cause) {
		return refuse(cause instanceof SmokeUsageError ? cause.message : String(cause));
	}
	let lightrag: LightragConfig | null;
	try {
		lightrag = loadConfig(io.env ?? process.env).lightrag;
	} catch (cause) {
		if (cause instanceof ConfigError) return refuse(cause.message);
		throw cause;
	}
	if (lightrag === null) return refuse("LIGHTRAG_URL is not set");
	let parsed: URL;
	try {
		parsed = new URL(lightrag.url);
	} catch {
		return refuse("LIGHTRAG_URL is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return refuse("LIGHTRAG_URL must be an http or https URL");
	const result = await runSmoke({
		config: lightrag,
		noAuthExpected: args.noAuthExpected,
		...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
		...(io.now !== undefined ? { now: io.now } : {}),
		...(io.sleep !== undefined ? { sleep: io.sleep } : {}),
		...(io.newMarker !== undefined ? { newMarker: io.newMarker } : {}),
	});
	write(args.json ? `${JSON.stringify(result.report)}\n` : formatSmoke(result));
	return result.exitCode;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
