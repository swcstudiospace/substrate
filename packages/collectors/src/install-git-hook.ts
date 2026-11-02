#!/usr/bin/env bun
/**
 * Install the post-commit collector into one or more repositories, and, only when asked, the corpus hint hooks.
 *
 *   bun packages/collectors/src/install-git-hook.ts <repo> [repo...]
 *   bun packages/collectors/src/install-git-hook.ts --check <repo>
 *   bun packages/collectors/src/install-git-hook.ts --corpus <repo> [repo...]
 *   bun packages/collectors/src/install-git-hook.ts --corpus --check <repo>
 *
 * Never clobbers an existing hook: if one is already there and is not ours, it
 * is left alone and reported, because a repo's own hook may be doing something
 * the owner cares about.
 *
 * `--corpus` (v1.7 phase 65, opt-in, run by an operator for chosen repositories) also installs `post-merge`,
 * `post-checkout` and `post-rewrite` hooks. Each one drops a tiny hint for the corpus watcher into the hint spool (outside
 * the repository), in the background with a hard timeout, and always exits 0. `substrate corpus hook install|uninstall|status`
 * uses the functions below; uninstalling removes only our block.
 *
 * With a repository registry (`SUBSTRATE_REPO_REGISTRY`; unset means no check) a hooks directory outside the repository's own
 * worktree or git directory is refused before anything is written, so a `core.hooksPath` cannot place a hook outside the registration.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LOCAL_SURFACE } from "../../cli/src/worktree/scope.ts";
import { redact } from "../../mcp-server/src/redact.ts";
import { localPathGate, localRegistryScope, REPO_REFUSAL_MESSAGES, resolveContained } from "../../mcp-server/src/repo-scope.ts";

const MARKER = "Agent Substrate — git post-commit collector";
const SOURCE = join(import.meta.dir, "git", "post-commit");
/**
 * The hook is copied, not linked, so it cannot find `emit.ts` (the event spool,
 * `SUBSTRATE_EVENT_SPOOL=on`) on its own. The installer writes this checkout's
 * collectors directory into the placeholder; a hook copied by hand keeps the
 * placeholder, which the hook treats as "no spool available".
 */
const SRC_PLACEHOLDER = "__SUBSTRATE_COLLECTORS_SRC__";

/** A directory with shell metacharacters is never written into a script: the placeholder stays. */
const SAFE_PATH = /^[A-Za-z0-9._/@+-]+$/;

/** A failure reason is printed on one line and capped to this many characters. */
const MAX_REASON_CHARS = 200;

function writeHook(path: string): void {
	const safeDir = SAFE_PATH.test(import.meta.dir) ? import.meta.dir : SRC_PLACEHOLDER;
	const body = readFileSync(SOURCE, "utf8").replaceAll(SRC_PLACEHOLDER, safeDir);
	writeFileSync(path, body, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function hooksDir(repo: string): string | null {
	const result = spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const relative = result.stdout.trim();
	return resolve(repo, relative);
}

type Status = "installed" | "already-ours" | "foreign-hook" | "not-a-repo" | "refused";

/** The environment the registry is read from. Callers may pass their own; the default is the process environment. */
type Env = Readonly<Record<string, string | undefined>>;

/** The real locations git reports for `repo`: its worktree, its git directory and its common git directory. */
function ownLocations(repo: string): string[] {
	const found: string[] = [];
	const top = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (top.status === 0) found.push(resolve(repo, top.stdout.trim()));
	const dirs = spawnSync("git", ["-C", repo, "rev-parse", "--git-dir", "--git-common-dir"], { encoding: "utf8" });
	if (dirs.status === 0) {
		for (const line of dirs.stdout.split("\n")) {
			if (line.trim() !== "") found.push(resolve(repo, line.trim()));
		}
	}
	return found.map((dir) => resolveContained(dir) ?? dir);
}

/** Whether `target` is `root` or lies beneath it. Both are real, absolute paths. */
function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why the hooks directory `dir` of `repo` may not be written, or null when it may. Unset registry: null, as before. Set: `repo`
 * must lie in a registration (the lookup the corpus CLI gates on), and `dir` must lie in the repository's own worktree or git
 * directory, so a `core.hooksPath` that points elsewhere is refused before anything is written there.
 */
function hooksDirRefusal(repo: string, dir: string, env: Env): string | null {
	const parsed = localRegistryScope(env);
	if (!parsed.ok) return `hooks directory ${dir}: ${parsed.problem}`;
	if (parsed.value === null) return null;
	const gate = localPathGate(parsed.value, LOCAL_SURFACE, resolve(repo));
	if (!gate.ok) return `hooks directory ${dir}: ${REPO_REFUSAL_MESSAGES[gate.reason]}`;
	const target = resolveContained(dir) ?? dir;
	if (ownLocations(repo).some((root) => within(root, target))) return null;
	return `hooks directory ${dir} is outside the repository's own worktree and git directory`;
}

function inspect(repo: string, env: Env): { status: Status; path?: string; detail?: string } {
	const dir = hooksDir(repo);
	if (!dir) return { status: "not-a-repo" };
	const refusal = hooksDirRefusal(repo, dir, env);
	if (refusal !== null) return { status: "refused", detail: refusal };
	const path = join(dir, "post-commit");
	if (!existsSync(path)) return { status: "installed", path };
	const existing = readFileSync(path, "utf8");
	return { status: existing.includes(MARKER) ? "already-ours" : "foreign-hook", path };
}

/** The hooks that carry a corpus hint: a merge, a checkout and a rebase or amend move the documentation under a checkout. */
export const CORPUS_HOOKS = ["post-merge", "post-checkout", "post-rewrite"] as const;
export type CorpusHook = (typeof CORPUS_HOOKS)[number];

export const CORPUS_BLOCK_BEGIN = "# >>> substrate corpus hint >>>";
export const CORPUS_BLOCK_END = "# <<< substrate corpus hint <<<";
const CLI_PLACEHOLDER = "__SUBSTRATE_CLI__";

/**
 * The block a corpus hook holds. It runs in the background with `timeout` when the host has it, sends its output nowhere,
 * and exits 0 whatever happens, so it can never fail or hold up the user's git command. `SUBSTRATE_HOOK_WAIT=1` runs it in
 * the foreground (the post-commit hook's own test seam). The CLI is `substrate` when that is on the PATH, else this
 * checkout's `packages/cli/src/index.ts` through bun, else nothing happens.
 */
export function corpusHookBlock(hook: CorpusHook, cliPath: string): string {
	const cli = SAFE_PATH.test(cliPath) ? cliPath : CLI_PLACEHOLDER;
	return [
		CORPUS_BLOCK_BEGIN,
		`# Agent Substrate — tells the corpus watcher that this repository changed (${hook}).`,
		"# It writes one small file to the hint spool, outside this repository, and exits 0 whatever happens.",
		"corpus_hint() {",
		'\ttop="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0',
		'\t[ -n "$top" ] || return 0',
		"\tif command -v substrate >/dev/null 2>&1; then",
		"\t\tset -- substrate",
		`\telif command -v bun >/dev/null 2>&1 && [ -f "${cli}" ]; then`,
		`\t\tset -- bun "${cli}"`,
		"\telse",
		"\t\treturn 0",
		"\tfi",
		"\tif command -v timeout >/dev/null 2>&1; then",
		'\t\ttimeout 10 "$@" corpus hint --repo "$top" </dev/null >/dev/null 2>&1',
		"\telse",
		'\t\t"$@" corpus hint --repo "$top" </dev/null >/dev/null 2>&1',
		"\tfi",
		"\treturn 0",
		"}",
		'if [ "${SUBSTRATE_HOOK_WAIT:-}" = "1" ]; then',
		"\tcorpus_hint || true",
		"else",
		"\t( corpus_hint ) </dev/null >/dev/null 2>&1 &",
		"fi",
		CORPUS_BLOCK_END,
		"",
	].join("\n");
}

export const HOOK_STATES = ["installed", "refreshed", "present", "absent", "removed", "foreign", "not-a-repo", "refused"] as const;
export type HookState = (typeof HOOK_STATES)[number];

export interface HookReport {
	hook: string;
	state: HookState;
	/** Why a hook was left alone, or what an uninstall kept. */
	detail?: string | undefined;
}

type Existing = { kind: "none" } | { kind: "foreign"; why: string } | { kind: "ours"; text: string };

function markerCount(text: string, marker: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = text.indexOf(marker, from);
		if (at === -1) return count;
		count += 1;
		from = at + marker.length;
	}
}

/** One begin before one end. Reversed, repeated or one-sided markers are damaged and must not be rewritten. */
function intactBlock(text: string): boolean {
	if (markerCount(text, CORPUS_BLOCK_BEGIN) !== 1 || markerCount(text, CORPUS_BLOCK_END) !== 1) return false;
	return text.indexOf(CORPUS_BLOCK_BEGIN) < text.indexOf(CORPUS_BLOCK_END);
}

function readExisting(path: string): Existing {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch {
		// No file at that path: nothing to protect.
		return { kind: "none" };
	}
	if (!stat.isFile()) return { kind: "foreign", why: "not a regular file" };
	const text = readFileSync(path, "utf8");
	if (!text.includes(CORPUS_BLOCK_BEGIN) && !text.includes(CORPUS_BLOCK_END)) return { kind: "foreign", why: "a different hook is installed" };
	if (!intactBlock(text)) return { kind: "foreign", why: "our block is damaged" };
	return { kind: "ours", text };
}

/** The text with our block (markers included) cut out. The caller has already refused a damaged pair. */
function cutBlock(text: string): { before: string; after: string } {
	const begin = text.indexOf(CORPUS_BLOCK_BEGIN);
	const endMarker = text.indexOf(CORPUS_BLOCK_END, begin);
	let end = endMarker + CORPUS_BLOCK_END.length;
	if (text[end] === "\n") end += 1;
	return { before: text.slice(0, begin), after: text.slice(end) };
}

function isShebangOnly(text: string): boolean {
	return text.split("\n").every((line) => line.trim() === "" || line.startsWith("#!"));
}

/** Installs (or with `check` only reports) the three corpus hint hooks. A hook file that is not ours is reported and left alone. */
export function installCorpusHooks(repo: string, options: { check: boolean; cliPath?: string | undefined; env?: Env | undefined }): HookReport[] {
	const dir = hooksDir(repo);
	if (!dir) return CORPUS_HOOKS.map((hook) => ({ hook, state: "not-a-repo" as const }));
	const refusal = hooksDirRefusal(repo, dir, options.env ?? process.env);
	if (refusal !== null) return CORPUS_HOOKS.map((hook): HookReport => ({ hook, state: "refused", detail: refusal }));
	const cliPath = options.cliPath ?? resolve(import.meta.dir, "..", "..", "cli", "src", "index.ts");
	return CORPUS_HOOKS.map((hook): HookReport => {
		const path = join(dir, hook);
		const existing = readExisting(path);
		if (existing.kind === "foreign") return { hook, state: "foreign", detail: existing.why };
		if (options.check) return { hook, state: existing.kind === "ours" ? "present" : "absent" };
		if (existing.kind === "none") mkdirSync(dir, { recursive: true });
		const block = corpusHookBlock(hook, cliPath);
		if (existing.kind === "none") {
			writeFileSync(path, `#!/bin/sh\n${block}`, { mode: 0o755 });
			chmodSync(path, 0o755);
			return { hook, state: "installed" };
		}
		const { before, after } = cutBlock(existing.text);
		writeFileSync(path, `${before}${block}${after}`, { mode: 0o755 });
		chmodSync(path, 0o755);
		return { hook, state: "refreshed" };
	});
}

/** Removes only our block from each hook; a file left with nothing but a shebang is deleted, any other line is kept. */
export function uninstallCorpusHooks(repo: string, env: Env = process.env): HookReport[] {
	const dir = hooksDir(repo);
	if (!dir) return CORPUS_HOOKS.map((hook) => ({ hook, state: "not-a-repo" as const }));
	const refusal = hooksDirRefusal(repo, dir, env);
	if (refusal !== null) return CORPUS_HOOKS.map((hook): HookReport => ({ hook, state: "refused", detail: refusal }));
	return CORPUS_HOOKS.map((hook): HookReport => {
		const path = join(dir, hook);
		const existing = readExisting(path);
		if (existing.kind === "none") return { hook, state: "absent" };
		if (existing.kind === "foreign") return { hook, state: "foreign", detail: existing.why };
		const { before, after } = cutBlock(existing.text);
		const rest = `${before}${after}`;
		if (isShebangOnly(rest)) {
			rmSync(path, { force: true });
			return { hook, state: "removed" };
		}
		writeFileSync(path, rest, { mode: 0o755 });
		return { hook, state: "removed", detail: "other lines of the file were kept" };
	});
}

/** A repository whose install threw: its path and a redacted one-line reason. */
export interface RepoFailure {
	repo: string;
	reason: string;
}

export interface InstallOptions {
	checkOnly?: boolean | undefined;
	corpus?: boolean | undefined;
	/** The environment the registry is read from. Defaults to the process environment. */
	env?: Env | undefined;
	/** Where the per-repository lines go. Defaults to stdout. */
	write?: ((text: string) => void) | undefined;
}

/** `failures` counts the distinct repositories with a problem and decides the exit code; `errors` names the repositories whose install threw (each is also in `failures`). */
export interface InstallOutcome {
	failures: number;
	errors: RepoFailure[];
}

/** A reason fit to print: redacted, first line only, no URL, short. */
function oneLineReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = redact(message).split("\n")[0] ?? "";
	const reason = firstLine.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
	return reason === "" ? "install failed" : reason;
}

/** Installs the post-commit collector (and the corpus hooks when asked) into each repository. A repository whose install throws is recorded and the loop goes on. */
export function installRepos(repos: readonly string[], options: InstallOptions = {}): InstallOutcome {
	const checkOnly = options.checkOnly ?? false;
	const corpus = options.corpus ?? false;
	const env = options.env ?? process.env;
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	let failures = 0;
	const errors: RepoFailure[] = [];
	for (const repo of repos) {
		let problem = false;
		try {
			const { status, path, detail } = inspect(repo, env);
			if (status === "not-a-repo") {
				write(`✗ ${repo} — not a git repository\n`);
				problem = true;
				continue;
			}
			if (status === "refused") {
				write(`✗ ${repo} — refused: ${detail}; nothing was written\n`);
				problem = true;
				continue;
			}
			if (status === "foreign-hook") {
				write(`⚠ ${repo} — a different post-commit hook is already installed; left alone\n`);
				problem = true;
			} else if (status === "already-ours") {
				if (!checkOnly && path) {
					writeHook(path);
				}
				write(`✓ ${repo} — ${checkOnly ? "present" : "refreshed"}\n`);
			} else if (checkOnly) {
				write(`○ ${repo} — not installed\n`);
			} else if (path) {
				writeHook(path);
				write(`✓ ${repo} — installed\n`);
			}
			if (!corpus) continue;
			for (const report of installCorpusHooks(repo, { check: checkOnly, env })) {
				const mark = report.state === "foreign" ? "⚠" : report.state === "absent" ? "○" : "✓";
				write(`${mark} ${repo} — ${report.hook} ${report.state}${report.detail === undefined ? "" : ` (${report.detail}; left alone)`}\n`);
				if (report.state === "foreign") problem = true;
			}
		} catch (error) {
			const reason = oneLineReason(error);
			errors.push({ repo, reason });
			problem = true;
			write(`✗ ${repo} — install failed: ${reason}\n`);
		} finally {
			if (problem) failures++;
		}
	}
	return { failures, errors };
}

function main(): void {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const corpus = args.includes("--corpus");
	const repos = args.filter((a) => !a.startsWith("--"));

	if (repos.length === 0) {
		process.stderr.write("usage: install-git-hook.ts [--check] [--corpus] <repo> [repo...]\n");
		process.exit(2);
	}

	const outcome = installRepos(repos, { checkOnly, corpus });
	process.exit(outcome.failures > 0 ? 1 : 0);
}

if (import.meta.main) main();
