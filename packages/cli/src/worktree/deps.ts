/**
 * The worktree command's dependencies, wired to this host: the git and gh runners, the free-space probe, the event path and
 * the HTTP routes at `SUBSTRATE_URL`. The CLI entry and the scheduled report (`scripts/worktree-report.ts`) both build them
 * here, so a timer and a person at a shell make the same calls with the same token and budgets.
 */
import { postEvent } from "../../../collectors/src/emit.ts";
import { freeBytes, spawnGh, spawnGit } from "../../../fleet/src/index.ts";
import { resolveBearer } from "../token.ts";
import { httpClaimsLookup, httpRegistryLister, httpReportPoster, type WorktreeDeps } from "./command.ts";

export const DEFAULT_URL = "http://127.0.0.1:7410";
export const DEFAULT_TIMEOUT_MS = 1500;
/** A worktree report holds up to 500 rows per request, so it gets more time than a hook-sized call. */
const WORKTREE_REPORT_TIMEOUT_MS = 10_000;
/** A claims lookup answers from one index read, but prune waits on it before every removal, so it gets more than a hook's budget. */
const WORKTREE_CLAIMS_TIMEOUT_MS = 5_000;
/** A registry listing is one index read of at most 500 rows. */
const WORKTREE_LISTING_TIMEOUT_MS = 5_000;

/** `SUBSTRATE_URL` without a trailing slash, else the local server. */
export function substrateUrl(env: Record<string, string | undefined>): string {
	return (env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

/** `SUBSTRATE_TIMEOUT_MS` when it is a positive number, else the hook-sized default. */
export function requestTimeoutMs(env: Record<string, string | undefined>): number {
	const raw = Number(env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface WorktreeDepsOptions {
	env: Record<string, string | undefined>;
	cwd: string;
	host: string;
	out: (text: string) => void;
	err: (text: string) => void;
}

/** The real dependencies of `runWorktree`, acting as surface `claude-code` (the surface the local commands post and claim as). */
export function worktreeDeps(options: WorktreeDepsOptions): WorktreeDeps {
	const { env } = options;
	const url = substrateUrl(env);
	const token = resolveBearer("claude-code", env) ?? undefined;
	const timeoutMs = requestTimeoutMs(env);
	return {
		env,
		cwd: options.cwd,
		host: options.host,
		out: options.out,
		err: options.err,
		git: spawnGit,
		gh: spawnGh,
		now: () => new Date(),
		freeBytes,
		emit: (event) => postEvent(event, { timeoutMs, collector: "cli", source: "cli.worktree", url }),
		postReport: httpReportPoster({ url, token, timeoutMs: Math.max(timeoutMs, WORKTREE_REPORT_TIMEOUT_MS) }),
		claims: httpClaimsLookup({ url, token, timeoutMs: Math.max(timeoutMs, WORKTREE_CLAIMS_TIMEOUT_MS) }),
		listRegistry: httpRegistryLister({ url, token, timeoutMs: Math.max(timeoutMs, WORKTREE_LISTING_TIMEOUT_MS) }),
	};
}
