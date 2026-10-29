/**
 * Pull-request state for a branch, through the GitHub CLI behind an injected runner.
 *
 * The answer is evidence for the prune classifier only. Every failure (no `gh`, not signed in, no
 * network, unparsable output) is `unknown`, which never makes anything safer. One branch can have had
 * several pull requests, so the result also lists the head commits of every merged one: a worktree
 * whose HEAD equals one of them is exactly what a squash merge leaves behind.
 */
import type { CommandRunner } from "./git.ts";

export type PrState = "open" | "merged" | "closed" | "none" | "unknown";

export interface PrInfo {
	state: PrState;
	/** Head commit of the pull request the state describes, null when there is none. */
	headSha: string | null;
	number: number | null;
	/** Head commits of every merged pull request returned for the branch. */
	mergedHeadShas: string[];
}

export const PR_UNKNOWN: PrInfo = { state: "unknown", headSha: null, number: null, mergedHeadShas: [] };
export const PR_NONE: PrInfo = { state: "none", headSha: null, number: null, mergedHeadShas: [] };

/** `gh pr list` returns at most this many pull requests for one branch. */
export const PR_LIST_LIMIT = 5;
export const DEFAULT_PR_CONCURRENCY = 4;

/** At most `limit` jobs run at once; the rest wait in order. */
export class Gate {
	private running = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async run<T>(job: () => Promise<T>): Promise<T> {
		if (this.running >= this.limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.waiting.push(resolve);
			await promise;
		} else {
			this.running += 1;
		}
		try {
			return await job();
		} finally {
			// Hand the slot straight to the next waiter so the limit holds across the wake-up.
			const next = this.waiting.shift();
			if (next === undefined) this.running -= 1;
			else next();
		}
	}
}

export interface PrDeps {
	run: CommandRunner;
	/** A directory inside the repository, so `gh` finds its remote. */
	cwd: string;
	/** Shared across calls so a branch is asked about once. Keyed by directory and branch. */
	cache?: Map<string, Promise<PrInfo>>;
	gate?: Gate;
}

interface RawPr {
	state: string;
	headRefOid: string;
	number: number;
}

function isRawPr(value: unknown): value is RawPr {
	return (
		typeof value === "object" &&
		value !== null &&
		"state" in value &&
		typeof value.state === "string" &&
		"headRefOid" in value &&
		typeof value.headRefOid === "string" &&
		"number" in value &&
		typeof value.number === "number"
	);
}

/** Parse `gh pr list --json state,headRefOid,number`; null when the text is not that shape. */
export function parsePrList(text: string): PrInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || !parsed.every(isRawPr)) return null;
	const prs = parsed;
	if (prs.length === 0) return PR_NONE;
	const states = prs.map((pr) => pr.state.toUpperCase());
	const mergedHeadShas = prs.filter((_pr, index) => states[index] === "MERGED").map((pr) => pr.headRefOid);
	// An open pull request outranks a merged one: the branch is still in play. gh lists newest first.
	for (const [wanted, state] of [["OPEN", "open"], ["MERGED", "merged"], ["CLOSED", "closed"]] as const) {
		const index = states.indexOf(wanted);
		const pr = prs[index];
		if (index >= 0 && pr !== undefined) return { state, headSha: pr.headRefOid, number: pr.number, mergedHeadShas };
	}
	return null;
}

async function ask(branch: string, deps: PrDeps): Promise<PrInfo> {
	const args = ["pr", "list", "--head", branch, "--state", "all", "--json", "state,headRefOid,number", "--limit", String(PR_LIST_LIMIT)];
	const result = await deps.run(args, deps.cwd);
	if (result.code !== 0) return PR_UNKNOWN;
	return parsePrList(result.stdout) ?? PR_UNKNOWN;
}

/** The pull-request state of `branch`, cached per directory and branch, with bounded concurrency. */
export function lookupPr(branch: string, deps: PrDeps): Promise<PrInfo> {
	const key = `${deps.cwd}\0${branch}`;
	const cached = deps.cache?.get(key);
	if (cached !== undefined) return cached;
	const pending = deps.gate === undefined ? ask(branch, deps) : deps.gate.run(() => ask(branch, deps));
	deps.cache?.set(key, pending);
	return pending;
}
