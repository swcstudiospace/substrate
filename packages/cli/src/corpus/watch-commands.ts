/**
 * The handlers of `substrate corpus sync|reconcile|watch|hint|hook` (v1.7 phase 65). `index.ts` parses the flags and builds a
 * `WatchContext`; everything here takes that context, so no handler reads the environment or the process.
 *
 * Every handler reads the registered repositories and writes nothing into them. The only writes are the ones the command is
 * for: the docs plane through the server (`--execute`), the hint spool, the mirror directory, and, for `hook install`, the
 * hook files of the repository the operator named.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
	CORPUS_PROTOCOL,
	defaultWatchFactory,
	FULL_SWEEP,
	type DocTier,
	type GitBytesRunner,
	type GitRunner,
	type HintBatch,
	readHints,
	type WatchFactory,
	writeHint,
} from "@substrate/corpus";
import { installCorpusHooks, uninstallCorpusHooks } from "../../../collectors/src/install-git-hook.ts";
import type { CorpusClient } from "./client.ts";
import type { EmitDocsSync } from "./events.ts";
import { renderHooks, renderReconcile, renderSync, syncJson, mirrorProblems } from "./render-sync.ts";
import { runSync, type SyncDeps, syncFailed } from "./sync.ts";
import { type LoopSyncRequest, runWatchLoop } from "./watch-loop.ts";
import type { WatchSettings } from "./watch-settings.ts";

/** What the watch loop needs from the outside; every member has a production default. */
export interface LoopSeams {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	stopped: () => boolean;
	watchFactory: WatchFactory;
	readHints: () => HintBatch;
}

export interface WatchContext {
	client: CorpusClient;
	roots: string[];
	maxTier: DocTier;
	maxBytes: number;
	batchDocs: number;
	batchBytes: number;
	settings: WatchSettings;
	/** Discovery's git runner (a test seam). */
	runner: GitRunner | undefined;
	/** The mirror and the view's git runner. */
	git: GitBytesRunner;
	readFile: (path: string) => Uint8Array;
	emit: EmitDocsSync | undefined;
	now: () => number;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Test seams for the watch loop; absent members take their production default. */
	loop?: Partial<LoopSeams> | undefined;
}

function syncDeps(ctx: WatchContext): SyncDeps {
	return {
		client: ctx.client,
		emit: ctx.emit,
		runner: ctx.runner,
		git: ctx.git,
		readFile: ctx.readFile,
		now: ctx.now,
		roots: ctx.roots,
		mirrorDir: ctx.settings.mirrorDir,
		maxTier: ctx.maxTier,
		maxBytes: ctx.maxBytes,
		batchDocs: ctx.batchDocs,
		batchBytes: ctx.batchBytes,
	};
}

interface SyncCommand {
	repos: string[];
	execute: boolean;
	fetch: boolean;
	json: boolean;
}

export async function runSyncCommand(ctx: WatchContext, command: SyncCommand): Promise<number> {
	const result = await runSync(syncDeps(ctx), {
		repos: command.repos.length === 0 ? null : command.repos,
		trigger: "manual",
		execute: command.execute,
		fetchMirrors: command.fetch,
	});
	ctx.out(command.json ? `${JSON.stringify(syncJson(result), null, 2)}\n` : renderSync(result));
	if (result.outcome === "failed") ctx.err(`[substrate] corpus sync failed: ${result.error ?? "see the output above"}\n`);
	// A repository that was asked for and not found is a mistake in the request, never a quiet success.
	return syncFailed(result) || result.notFound.length > 0 ? 1 : 0;
}

interface ReconcileCommand {
	execute: boolean;
	json: boolean;
}

/**
 * Reads every repository (fetching the mirrors), plans what a sync would do, then asks the server where the docs plane and
 * the manifest disagree. With `--execute` the server repairs the drift first (so the missing rows are planned as `add`) and
 * the sync then ingests what changed.
 */
export async function runReconcileCommand(ctx: WatchContext, command: ReconcileCommand): Promise<number> {
	const deps = syncDeps(ctx);
	let sync = await runSync(deps, { repos: null, trigger: "reconcile", execute: false, fetchMirrors: true });
	if (sync.outcome === "failed") {
		ctx.out(command.json ? `${JSON.stringify(syncJson(sync), null, 2)}\n` : renderSync(sync));
		ctx.err(`[substrate] corpus reconcile failed: ${sync.error ?? "the plan failed"}\n`);
		return 1;
	}
	const reconciled = await ctx.client.reconcile({ protocol: CORPUS_PROTOCOL, execute: command.execute });
	if (!reconciled.ok) {
		ctx.err(`[substrate] corpus reconcile failed: ${reconciled.error.message}\n`);
		return 1;
	}
	if (command.execute) sync = await runSync(deps, { repos: null, trigger: "reconcile", execute: true, fetchMirrors: false });
	const { drift, repaired } = reconciled.value;
	ctx.out(
		command.json
			? `${JSON.stringify({ drift, repaired, mirrorProblems: mirrorProblems(sync.mirrors), sync: syncJson(sync) }, null, 2)}\n`
			: renderReconcile({ sync, drift, repaired, execute: command.execute }),
	);
	return command.execute && syncFailed(sync) ? 1 : 0;
}

interface WatchCommand {
	once: boolean;
	/** The `--sweep-s` flag; absent takes the setting. */
	sweepS: number | undefined;
}

interface Stopper {
	stopped: () => boolean;
	sleep: (ms: number) => Promise<void>;
	dispose: () => void;
}

/** SIGTERM and SIGINT end the loop after the sync in flight; a sleeping loop wakes at once. */
function createStopper(): Stopper {
	let stop = false;
	let wake: (() => void) | null = null;
	const onSignal = (): void => {
		stop = true;
		wake?.();
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	return {
		stopped: () => stop,
		sleep: (ms) => {
			const { promise, resolve: done } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				wake = null;
				done();
			}, ms);
			wake = () => {
				clearTimeout(timer);
				wake = null;
				done();
			};
			return promise;
		},
		dispose: () => {
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
		},
	};
}

export async function runWatchCommand(ctx: WatchContext, command: WatchCommand): Promise<number> {
	// `stopped` and `sleep` come as a pair: a test supplies both, the command installs the signal handlers for both.
	const given = ctx.loop;
	const stopper: Stopper = given?.stopped !== undefined && given.sleep !== undefined ? { stopped: given.stopped, sleep: given.sleep, dispose: () => undefined } : createStopper();
	const deps = syncDeps(ctx);
	try {
		return await runWatchLoop({
			settings: ctx.settings,
			roots: ctx.roots,
			sweepS: command.sweepS ?? ctx.settings.sweepS,
			once: command.once,
			now: ctx.loop?.now ?? ctx.now,
			sleep: stopper.sleep,
			stopped: stopper.stopped,
			sync: (request: LoopSyncRequest) =>
				runSync(deps, {
					repos: request.repo === FULL_SWEEP ? null : [request.repo],
					trigger: request.trigger,
					execute: true,
					// Only the sweep goes to the network; a change the checkout shows is read from the mirror as it is.
					fetchMirrors: request.trigger === "sweep",
					firstSignalAtMs: request.firstSignalAtMs,
				}),
			runner: ctx.runner,
			readHints: ctx.loop?.readHints ?? (() => readHints(ctx.settings.spoolDir)),
			watchFactory: ctx.loop?.watchFactory ?? defaultWatchFactory,
			out: ctx.out,
			err: ctx.err,
		});
	} finally {
		stopper.dispose();
	}
}

/** Writes one hint for the repository at `repo`. Exits 0 whatever happens and prints nothing on success. */
export function runHintCommand(ctx: Pick<WatchContext, "settings" | "now" | "err">, repo: string): number {
	const written = writeHint(ctx.settings.spoolDir, resolve(repo), { nowMs: ctx.now, random: () => randomBytes(4).toString("hex") });
	if (!written.ok) ctx.err(`[substrate] corpus hint not written: ${written.reason}\n`);
	return 0;
}

export const HOOK_ACTIONS = ["install", "uninstall", "status"] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

export function runHookCommand(ctx: Pick<WatchContext, "out"> & { env?: Readonly<Record<string, string | undefined>> | undefined }, action: HookAction, repo: string): number {
	const env = ctx.env ?? process.env;
	const reports = action === "install" ? installCorpusHooks(repo, { check: false, env }) : action === "status" ? installCorpusHooks(repo, { check: true, env }) : uninstallCorpusHooks(repo, env);
	ctx.out(renderHooks(reports));
	const refused = reports.some((report) => report.state === "not-a-repo" || report.state === "refused" || (report.state === "foreign" && action !== "status"));
	return refused ? 1 : 0;
}
