#!/usr/bin/env bun
/**
 * Hindsight canary contract runner: proves a CANDIDATE Hindsight still honours
 * the contract our client (`planes/hindsight.ts`) depends on, before an
 * operator moves the pin. Operator-run, never against production.
 *
 *   bun packages/mcp-server/src/hindsight-canary-run.ts --confirm-throwaway [--json] [--mental-model-refresh]
 *
 * Reach comes from `hindsightFromEnv` (HINDSIGHT_URL, HINDSIGHT_API_KEY, the
 * bank prefix): no new env var. The run touches ONE bank it creates, named
 * `<prefix>canary-<random>`, and deletes it at the end even after a failure.
 * The recall check uses the client's own budget: HINDSIGHT_RECALL_BUDGET_MS when
 * set to a positive integer, else the 4000 ms default.
 *
 * Exit codes: 0 every check passed (skips allowed), 1 a check failed,
 * 2 usage or configuration refused, 3 the candidate was unreachable.
 *
 * Output never carries the URL, the key, or retained content beyond the
 * marker: reasons are redacted and capped.
 */
import {
	type FetchLike,
	type HindsightConfig,
	type HindsightResult,
	bankConfig,
	bankStats,
	deleteBank,
	deleteDocument,
	ensureBank,
	getDocument,
	hindsightFromEnv,
	listBanks,
	patchDocumentTags,
	probeHealth,
	probeVersion,
	recallBank,
	retainMemories,
	send,
} from "./planes/hindsight.ts";
import { DEFAULT_RECALL_BUDGET_MS } from "./memory-recall.ts";

export const CANARY_USAGE = `usage: bun packages/mcp-server/src/hindsight-canary-run.ts --confirm-throwaway [--json] [--mental-model-refresh]
  --confirm-throwaway      REQUIRED: the configured Hindsight is a candidate, never production
  --json                   print {schema, version, checks, ok} instead of the summary
  --mental-model-refresh   also probe POST mental-models/{id}/refresh (response shape recorded)
env: HINDSIGHT_URL, HINDSIGHT_API_KEY and the bank prefix point at the CANDIDATE
exit: 0 pass, 1 a check failed, 2 usage or config refused, 3 candidate unreachable
`;

export class CanaryUsageError extends Error {
	override readonly name = "CanaryUsageError";
}

export interface CanaryArgs {
	confirmThrowaway: boolean;
	json: boolean;
	mentalModelRefresh: boolean;
}

/** Strict grammar: three known flags, no values, no positionals, no repeats. */
export function parseCanaryArgs(argv: readonly string[]): CanaryArgs {
	const args: CanaryArgs = { confirmThrowaway: false, json: false, mentalModelRefresh: false };
	const seen = new Set<string>();
	for (const arg of argv) {
		if (seen.has(arg)) throw new CanaryUsageError(`${arg} given twice`);
		seen.add(arg);
		if (arg === "--confirm-throwaway") args.confirmThrowaway = true;
		else if (arg === "--json") args.json = true;
		else if (arg === "--mental-model-refresh") args.mentalModelRefresh = true;
		else throw new CanaryUsageError(`unknown argument ${arg.slice(0, 40)}`);
	}
	return args;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
	id: string;
	status: CheckStatus;
	ms: number;
	reason?: string;
}

export interface CanaryReport {
	schema: 1;
	version: string | null;
	checks: CheckResult[];
	ok: boolean;
}

export interface CanaryTimer {
	promise: Promise<void>;
	cancel: () => void;
}

export interface CanaryLimits {
	/** One request's timeout. */
	callTimeoutMs: number;
	/** The recall's own budget: a longer wait is the 0.10.x hang, a FAIL. */
	recallBudgetMs: number;
	/** Whole-run deadline: checks past it fail, cleanup still runs. */
	deadlineMs: number;
	/** Cleanup waits at most this long for calls whose timer already won (a late create must not outlive the bank delete). */
	drainMs: number;
}

export const DEFAULT_CANARY_LIMITS: CanaryLimits = { callTimeoutMs: 8000, recallBudgetMs: DEFAULT_RECALL_BUDGET_MS, deadlineMs: 120_000, drainMs: 2000 };

/**
 * The client's own recall budget (`HINDSIGHT_RECALL_BUDGET_MS`): a positive decimal integer, else the default. Same parse as
 * `positiveIntOr` in config.ts (not imported: config.ts pulls the whole service config), same default as `memory_recall`.
 */
function envRecallBudgetMs(raw: string | undefined): number {
	const trimmed = raw?.trim() ?? "";
	if (!/^\d+$/.test(trimmed)) return DEFAULT_RECALL_BUDGET_MS;
	const value = Number(trimmed);
	return value > 0 ? value : DEFAULT_RECALL_BUDGET_MS;
}

export interface CanaryDeps {
	args: CanaryArgs;
	env: Record<string, string | undefined>;
	fetch: FetchLike;
	now: () => number;
	/** The random bank suffix generator: lowercase alphanumerics, 4 to 32 chars. */
	random: () => string;
	delay: (ms: number) => CanaryTimer;
	out: (text: string) => void;
	err: (text: string) => void;
	limits?: Partial<CanaryLimits>;
}

export interface CanaryOutcome {
	code: 0 | 1 | 2 | 3;
	report: CanaryReport | null;
}

const SUFFIX = /^[a-z0-9]{4,32}$/;
const MAX_REASON = 160;

type StepResult = { status: CheckStatus; reason?: string };

function realDelay(ms: number): CanaryTimer {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	return { promise, cancel: () => clearTimeout(timer) };
}

/** The real-world deps for the entry point. */
export function realCanaryDeps(args: CanaryArgs): CanaryDeps {
	return {
		args,
		env: process.env,
		fetch,
		now: () => Date.now(),
		random: () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
		delay: realDelay,
		out: (text) => void process.stdout.write(text),
		err: (text) => void process.stderr.write(text),
	};
}

function pass(reason?: string): StepResult {
	return reason === undefined ? { status: "pass" } : { status: "pass", reason };
}

function failed(reason: string): StepResult {
	return { status: "fail", reason };
}

export async function runCanary(deps: CanaryDeps): Promise<CanaryOutcome> {
	const limits: CanaryLimits = { ...DEFAULT_CANARY_LIMITS, recallBudgetMs: envRecallBudgetMs(deps.env.HINDSIGHT_RECALL_BUDGET_MS), ...deps.limits };
	const refuse = (message: string): CanaryOutcome => {
		deps.err(`${message}\n${CANARY_USAGE}`);
		return { code: 2, report: null };
	};
	if (!deps.args.confirmThrowaway) {
		return refuse("refused: pass --confirm-throwaway to confirm the configured Hindsight is a candidate, not production");
	}
	const config: HindsightConfig | null = hindsightFromEnv(deps.env);
	if (!config) return refuse("refused: HINDSIGHT_URL and HINDSIGHT_API_KEY must both be set to the candidate");
	const suffix = deps.random();
	if (!SUFFIX.test(suffix)) return refuse("refused: the random suffix generator returned an unusable value");

	const secrets = [config.apiKey, config.url];
	try {
		secrets.push(new URL(config.url).host);
	} catch {
		return refuse("refused: HINDSIGHT_URL is not a valid URL");
	}
	const scrub = (text: string): string => {
		let clean = text;
		for (const secret of secrets) if (secret.length > 0) clean = clean.split(secret).join("[redacted]");
		clean = clean.replace(/https?:\/\/\S+/gi, "[redacted-url]");
		return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON)}...` : clean;
	};

	const bank = `${config.bankPrefix}canary-${suffix}`;
	const documentId = `canary-doc-${suffix}`;
	const marker = `canary-marker-${suffix}`;
	const started = deps.now();
	const checks: CheckResult[] = [];
	let version: string | null = null;
	let unreachable = false;
	let bankAttempted = false;
	let bankOwned = false;
	let bankReady = false;
	let docRetained = false;
	let docDeleted = false;

	// Calls still in flight when their timer won: cleanup waits for them to settle so a late create cannot outlive the bank delete.
	const pending = new Set<Promise<unknown>>();
	const guard = async <T>(op: Promise<HindsightResult<T>>, ms: number, label: string): Promise<HindsightResult<T>> => {
		const timer = deps.delay(ms);
		const timedOut: HindsightResult<T> = { ok: false, error: { kind: "timeout", message: `${label}: no answer within ${ms}ms` } };
		const tracked = op.then(
			() => undefined,
			() => undefined,
		);
		pending.add(tracked);
		void tracked.then(() => pending.delete(tracked));
		try {
			return await Promise.race([op, timer.promise.then(() => timedOut)]);
		} finally {
			timer.cancel();
		}
	};
	const call = <T>(label: string, op: (timeoutMs: number) => Promise<HindsightResult<T>>, ms = limits.callTimeoutMs) =>
		guard(op(ms), ms, label);
	const why = (label: string, error: { kind: string; message: string }): string => scrub(`${label}: ${error.kind}: ${error.message}`);

	const step = async (id: string, run: () => Promise<StepResult>, options: { ignoreDeadline?: boolean } = {}): Promise<void> => {
		const begun = deps.now();
		let result: StepResult;
		if (!options.ignoreDeadline && begun - started > limits.deadlineMs) {
			result = failed("total-deadline-exceeded");
		} else {
			try {
				result = await run();
			} catch (cause) {
				// A thrown error is recorded as this check's failure, not lost.
				result = failed(scrub(`unexpected error: ${cause instanceof Error ? cause.message : String(cause)}`));
			}
		}
		const check: CheckResult = { id, status: result.status, ms: Math.max(0, deps.now() - begun) };
		if (result.reason !== undefined) check.reason = result.reason;
		checks.push(check);
	};
	const skipStep = (id: string, reason: string): void => {
		checks.push({ id, status: "skip", ms: 0, reason });
	};
	const needsBank = (id: string, run: () => Promise<StepResult>): Promise<void> | void => {
		if (unreachable) return skipStep(id, "candidate unreachable");
		if (!bankReady) return skipStep(id, "skipped: no usable canary bank");
		return step(id, run);
	};
	const needsDoc = (id: string, run: () => Promise<StepResult>): Promise<void> | void => {
		if (unreachable) return skipStep(id, "candidate unreachable");
		if (!bankReady || !docRetained || docDeleted) return skipStep(id, "skipped: no retained canary document");
		return step(id, run);
	};

	// (1) liveness and version
	await step("health-version", async () => {
		const health = await call("GET /health", (ms) => probeHealth(config, deps.fetch, ms));
		if (!health.ok) {
			if (health.error.kind === "network" || health.error.kind === "timeout") unreachable = true;
			return failed(why("health", health.error));
		}
		const got = await call("GET /version", (ms) => probeVersion(config, deps.fetch, ms));
		if (!got.ok) return failed(why("version", got.error));
		version = /^[\w.+-]{1,40}$/.test(got.value.api_version) ? got.value.api_version : "unknown";
		return pass();
	});

	// (2) bank ensure in chunks mode, config readable
	if (unreachable) skipStep("bank-ensure", "candidate unreachable");
	else {
		await step("bank-ensure", async () => {
			bankAttempted = true;
			bankOwned = true;
			const ensured = await call("ensure bank", (ms) => ensureBank(config, bank, deps.fetch, ms));
			if (!ensured.ok) return failed(why("ensure", ensured.error));
			if (!ensured.value.created) {
				bankOwned = false;
				return failed("canary bank name already existed; refusing to use or delete it");
			}
			const read = await call("GET bank config", (ms) => bankConfig(config, bank, deps.fetch, { timeoutMs: ms }));
			if (!read.ok) return failed(why("config", read.error));
			if (read.value.retain_extraction_mode !== "chunks") {
				return failed(`bank config reports retain mode ${scrub(String(read.value.retain_extraction_mode))}, expected chunks`);
			}
			bankReady = true;
			return pass();
		});
	}

	// (2b) the inventory route: the canary bank must be listed (a truncated listing cannot prove absence, so it skips)
	await needsBank("bank-list", async () => {
		const listed = await call("GET banks", (ms) => listBanks(config, deps.fetch, { timeoutMs: ms }));
		if (!listed.ok) return failed(why("list banks", listed.error));
		if (listed.value.banks.some((entry) => entry.bank_id === bank)) return pass();
		if (listed.value.truncated) return { status: "skip", reason: "bank listing truncated; canary bank not seen in the first page set" };
		return failed("canary bank missing from the bank listing");
	});

	// (2c) the inventory's other route: the stats read must parse on the still-empty canary bank (a not-found right after create is a FAIL)
	await needsBank("bank-stats", async () => {
		const stats = await call("GET bank stats", (ms) => bankStats(config, bank, deps.fetch, { timeoutMs: ms }));
		return stats.ok ? pass() : failed(why("bank stats", stats.error));
	});

	// (3) retain one synthetic document
	await needsBank("retain", async () => {
		const retained = await call("retain", (ms) =>
			retainMemories(
				config,
				bank,
				[{ content: `Hindsight canary synthetic document ${marker}`, tags: ["canary"], document_id: documentId }],
				deps.fetch,
				ms,
			),
		);
		if (!retained.ok) return failed(why("retain", retained.error));
		docRetained = true;
		if (retained.value.items_count !== 1) return failed(`retain accepted ${retained.value.items_count} items, expected 1`);
		return pass();
	});

	// (4) recall finds the marker within the recall budget
	await needsDoc("recall", async () => {
		const recalled = await call(
			"recall",
			(ms) => recallBank(config, bank, { query: marker, keep: (hit) => hit.text.includes(marker) }, deps.fetch, ms),
			limits.recallBudgetMs,
		);
		if (!recalled.ok) {
			if (recalled.error.kind === "timeout") return failed(`recall-timeout: no answer within ${limits.recallBudgetMs}ms`);
			return failed(why("recall", recalled.error));
		}
		return recalled.value.length > 0 ? pass() : failed("recall answered but did not return the marker");
	});

	// (5) document get
	await needsDoc("document-get", async () => {
		const got = await call("GET document", (ms) => getDocument(config, bank, documentId, deps.fetch, ms));
		if (!got.ok) return failed(why("get", got.error));
		if (got.value === null) return failed("document not found after retain");
		if (got.value.text !== undefined && !got.value.text.includes(marker)) return failed("document text lost the marker");
		return pass();
	});

	// (6) tag patch round trip
	await needsDoc("tag-patch", async () => {
		const patched = await call("PATCH document tags", (ms) => patchDocumentTags(config, bank, documentId, ["canary", "canary-patched"], deps.fetch, ms));
		if (!patched.ok) return failed(why("patch", patched.error));
		const got = await call("GET document", (ms) => getDocument(config, bank, documentId, deps.fetch, ms));
		if (!got.ok) return failed(why("get", got.error));
		if (got.value === null) return failed("document vanished after tag patch");
		return got.value.tags.includes("canary-patched") ? pass() : failed("patched tag not visible on the document");
	});

	// (6b) retain again under the same document id: retainMemories always sends update_mode "replace", so the old body must be gone
	await needsDoc("document-replace", async () => {
		const replacedMarker = `canary-replaced-${suffix}`;
		const again = await call("retain replace", (ms) =>
			retainMemories(
				config,
				bank,
				[{ content: `Hindsight canary replacement document ${replacedMarker}`, tags: ["canary"], document_id: documentId }],
				deps.fetch,
				ms,
			),
		);
		if (!again.ok) return failed(why("retain replace", again.error));
		const got = await call("GET document", (ms) => getDocument(config, bank, documentId, deps.fetch, ms));
		if (!got.ok) return failed(why("get after replace", got.error));
		if (got.value === null) return failed("document vanished after replace");
		if (got.value.text === undefined) return { status: "skip", reason: "document text not exposed; replace not observable" };
		if (got.value.text.includes(marker)) return failed("replace kept the old document body");
		return got.value.text.includes(replacedMarker) ? pass() : failed("replaced body not readable");
	});

	// (7) delete, then delete again: a no-op or not-found success
	await needsDoc("document-delete", async () => {
		const first = await call("DELETE document", (ms) => deleteDocument(config, bank, documentId, deps.fetch, ms));
		if (!first.ok) return failed(why("delete", first.error));
		docDeleted = true;
		if (!first.value) return failed("first delete reported the document absent");
		const again = await call("DELETE document again", (ms) => deleteDocument(config, bank, documentId, deps.fetch, ms));
		if (!again.ok) return failed(why("second delete", again.error));
		const gone = await call("GET document", (ms) => getDocument(config, bank, documentId, deps.fetch, ms));
		if (!gone.ok) return failed(why("get after delete", gone.error));
		return gone.value === null ? pass() : failed("document still readable after delete");
	});

	// (8) mental-model refresh, opt in; shape unverified against 1.1.0
	if (!deps.args.mentalModelRefresh) skipStep("mental-model-refresh", "not requested (--mental-model-refresh)");
	else {
		await needsBank("mental-model-refresh", async () => {
			const path = `/v1/default/banks/${encodeURIComponent(bank)}/mental-models/${encodeURIComponent(`canary-${suffix}`)}/refresh`;
			const sent = await call("POST mental-model refresh", (ms) => send(config, "POST", path, {}, { fetchImpl: deps.fetch, timeoutMs: ms }));
			if (!sent.ok) return failed(why("refresh", sent.error));
			const { status, body } = sent.value;
			const keys = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 12).join(",") : typeof body;
			const shape = scrub(`status ${status}, keys [${keys}]`);
			if (status >= 200 && status < 300) return pass(shape);
			// No mental model exists on the throwaway bank, so a 404 cannot tell a missing route from a missing model.
			if (status === 404) return { status: "skip", reason: `${shape}; missing route and missing model are indistinguishable` };
			return failed(shape);
		});
	}

	// (9) bank delete (always, once a bank may exist) and a follow-up lookup
	// Wait (bounded) for any call whose timer already won, so a late create finishes before the bank delete.
	if (pending.size > 0) {
		const settle = deps.delay(limits.drainMs);
		await Promise.race([Promise.allSettled([...pending]), settle.promise]);
		settle.cancel();
	}

	if (!bankAttempted || !bankOwned) {
		skipStep("bank-delete", unreachable ? "candidate unreachable" : bankAttempted ? "bank not owned by this run; not deleted" : "no bank was created");
	} else {
		await step(
			"bank-delete",
			async () => {
				const removed = await call("DELETE bank", (ms) => deleteBank(config, bank, deps.fetch, ms));
				if (!removed.ok) return failed(why("delete bank", removed.error));
				const lookup = await call("GET bank config", (ms) => bankConfig(config, bank, deps.fetch, { timeoutMs: ms }));
				if (lookup.ok) return failed("bank still readable after delete");
				return lookup.error.kind === "not-found" ? pass() : failed(why("lookup", lookup.error));
			},
			{ ignoreDeadline: true },
		);
	}

	// (10) informational only: the probe never creates an underscore-prefixed bank.
	checks.push({
		id: "bank-id-validation",
		status: "skip",
		ms: 0,
		reason: "informational: 1.1.0 rejects bank ids starting with an underscore; not probed, nothing created",
	});

	const anyFail = checks.some((check) => check.status === "fail");
	const report: CanaryReport = { schema: 1, version, checks, ok: !anyFail && !unreachable };
	if (deps.args.json) deps.out(`${JSON.stringify(report)}\n`);
	else {
		const lines = [`hindsight canary: version ${version ?? "unknown"}, bank ${bank.slice(0, config.bankPrefix.length)}canary-*`];
		for (const check of checks) {
			lines.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.id} (${check.ms}ms)${check.reason ? ` - ${check.reason}` : ""}`);
		}
		lines.push(report.ok ? "result: ok" : "result: FAILED");
		deps.out(`${lines.join("\n")}\n`);
	}
	return { code: unreachable ? 3 : anyFail ? 1 : 0, report };
}

if (import.meta.main) {
	let args: CanaryArgs;
	try {
		args = parseCanaryArgs(process.argv.slice(2));
	} catch (cause) {
		process.stderr.write(`${cause instanceof CanaryUsageError ? cause.message : String(cause)}\n${CANARY_USAGE}`);
		process.exit(2);
	}
	const outcome = await runCanary(realCanaryDeps(args));
	process.exit(outcome.code);
}
