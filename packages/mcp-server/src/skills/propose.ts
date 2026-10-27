// The one git path every skill proposal takes (D21-12): the MCP tool skills_propose, POST
// /skills/propose and `substrate skills propose --dir` all end in proposeSkill. It validates and
// redacts before the first git or gh call, overlays the proposal on the skill's tree as it is on
// origin/main in a shared clone of the local mirror, pushes a fresh branch and opens a PR on the
// configured library. A production checkout of the library is never written here.
//
// Shape copied from the host package's hostfns.ts (pure argv builders + an injected Runner), not
// imported: the dependency runs host → mcp-server. No argv ever carries a force flag, a search
// query or a colon refspec (T-21-01); idempotence comes from a local ledger and `gh pr view` /
// `gh pr list --head`, which are strongly consistent, never from GitHub's search index.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { redact, redactSkillContent, type SkillDocExampleRule, type SkillFileHit, scanSkillFiles } from "../redact.ts";
import { SURFACES, type Surface } from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/** September's library: the production default. Config overrides it (D21-13). */
export const LIBRARY_REPO = "swcstudiospace/agent-skills";
export const LIBRARY_URL = "https://github.com/swcstudiospace/agent-skills.git";
export const SKILLS_STATE = "/var/lib/substrate/skills";
export const MIRROR = `${SKILLS_STATE}/mirror.git`;
export const PROPOSE_ROOT = `${SKILLS_STATE}/propose`;
export const LOCK_DIR = `${SKILLS_STATE}/mirror.lock`;
export const CONTENT_LOCKS = `${SKILLS_STATE}/locks`;
export const LEDGER = `${SKILLS_STATE}/proposals.jsonl`;

/** Which library a proposal targets: the repo slug plus the remote the clone is checked against. */
export interface SkillsLibrary {
	repo: string;
	remoteUrl: string;
}

/** The production default; `config.skills` carries the live value. */
export const DEFAULT_LIBRARY: SkillsLibrary = { repo: LIBRARY_REPO, remoteUrl: LIBRARY_URL };
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The HTTP route, the MCP tool and the CLI pre-flight share one cap (D21-08: body ≤ 1 MB). */
export const ROUTE_MAX_BYTES = 1_000_000;

export const PR_TITLE_MAX = 256;
export const PR_BODY_MAX = 20_000;
export const RATIONALE_MAX = 2_000;
const BODY_ID_MAX = 200;
const COMMIT_USER_NAME = "substrate skills";
const COMMIT_USER_EMAIL = "skills@substrate.local";
const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 400;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 50;

export type TreeMode = "overlay" | "replace";

/** The propose body (route, tool, queued proposal files). `files` must hold SKILL.md. */
export interface ProposeInput {
	name: string;
	files: Record<string, string>;
	remove?: string[];
	rationale: string;
	surface: Surface;
	session_id?: string;
	graph_id?: string;
}

/** The refusal a beforeWork hook may hand back. It applies only if the library no longer holds the content: the git diff finds a change, before any commit or push. */
export interface ProposeGate {
	unlessUnchanged: Error;
}

export interface ProposeOptions {
	maxBytes: number;
	/** Operator-only: pem/jwt documentation examples become redactions instead of refusals. */
	allowDocExamples?: ReadonlySet<SkillDocExampleRule>;
	/** overlay keeps the files a proposal does not name; replace (operator-only) makes the proposal the whole tree. */
	mode: TreeMode;
	/** Validate, redact, clone and diff; no push, no gh call, no ledger line. */
	dryRun?: boolean;
	/** Propose content whose identical PR the owner closed (operator-only). */
	reopen?: boolean;
	ledgerPath?: string;
	/** Test seam: the state dir holding mirror.git, propose/, mirror.lock, locks/ and the ledger. */
	stateDir?: string;
	/** Which library the proposal targets; defaults to September's. */
	library?: SkillsLibrary;
	/** Test seam: how long a live lock is waited for. */
	lockWaitMs?: number;
	/** Runs after the ledger replay and before any mirror, clone or push work. It is handed the PR of the merged proposal the ledger holds for this content, or null. A throw refuses the proposal with nothing written; a returned gate refuses it only when the library no longer holds the content. Runs for a dry run too. */
	beforeWork?: (mergedPrUrl: string | null) => Promise<ProposeGate | null>;
	run: Runner;
}

export type ProposeStatus = "opened" | "existing" | "unchanged" | "declined" | "dry_run";

export interface ProposeResult {
	status: ProposeStatus;
	pr_url?: string;
	pr_number?: number;
	branch?: string;
	content_sha256: string;
	redactions: SkillFileHit[];
	diff_added?: number;
	diff_changed?: number;
	diff_deleted?: number;
}

export interface ValidatedProposal {
	name: string;
	surface: Surface;
	mode: TreeMode;
	/** Redacted text per relative path. */
	files: Record<string, string>;
	remove: string[];
	redactions: SkillFileHit[];
	content_sha256: string;
}

export interface SkillProposer {
	propose(input: ProposeInput, opts: Omit<ProposeOptions, "run">): Promise<ProposeResult>;
}

/** A guard refused the proposal before any git or gh call. Findings name file, line and rule, never a value. */
export class ProposeRefused extends Error {
	readonly findings?: SkillFileHit[];
	constructor(message: string, findings?: SkillFileHit[]) {
		super(message);
		this.name = "ProposeRefused";
		if (findings) this.findings = findings;
	}
}

/** A git or gh step failed (or a lock stayed busy); the message carries at most 400 redacted characters of output. */
export class ProposeFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposeFailed";
	}
}

// ── validation ──────────────────────────────────────────────────────────────

/** A relative path inside the skill: no absolute path, backslash, `..`, dot-segment, NUL or Python bytecode. */
function pathProblem(path: string): string | null {
	if (path.length === 0) return "empty path";
	if (path.startsWith("/")) return "absolute path";
	if (path.includes("\\")) return "backslash in path";
	if (path.includes("\u0000")) return "NUL in path";
	for (const segment of path.split("/")) {
		if (segment.length === 0) return "empty path segment";
		if (segment.startsWith(".")) return "dot-segment in path";
		if (segment === "__pycache__") return "__pycache__ in path";
	}
	if (path.endsWith(".pyc")) return ".pyc file";
	return null;
}

/**
 * Free text that leaves the server in the PR body or the commit, where the file scan
 * never looks. NUL reaches `gh` argv through `prBody` and `execFile` rejects it only
 * after the branch is pushed and the push recorded — so refuse it here, before any
 * git work, without echoing the value.
 */
function refuseNulText(label: string, value: string): void {
	if (value.includes(String.fromCharCode(0))) throw new ProposeRefused(`${label} contains NUL`);
}

function refusePath(path: string, where: string): void {
	const problem = pathProblem(path);
	if (problem) throw new ProposeRefused(`${where} ${JSON.stringify(path.slice(0, 200))}: ${problem}`);
}

/** A path that is also a prefix of another (`a` and `a/b.txt`) cannot be written as both a file and a directory. */
function conflictingPaths(paths: readonly string[]): string | null {
	const sorted = [...paths].sort();
	for (let i = 0; i < sorted.length; i++) {
		const parent = sorted[i] ?? "";
		for (let j = i + 1; j < sorted.length; j++) {
			const child = sorted[j] ?? "";
			if (!child.startsWith(parent)) break;
			if (child.startsWith(`${parent}/`)) return `${JSON.stringify(parent)} is both a file and a parent of ${JSON.stringify(child)}`;
		}
	}
	return null;
}

/**
 * Filenames, removals and ids leave the server in the tree or the PR body, and the file scan
 * never sees them. Refuse when the shared redactor would change the text, and do not echo it.
 */
function refuseSecretText(label: string, value: string): void {
	if (redact(value) !== value) throw new ProposeRefused(`${label} contains secret-like content`);
}

/**
 * Every content guard in one place, before any git or gh call: name, surface, paths, SKILL.md and
 * its frontmatter, text only, the byte cap, the removals, then the skill redactor's findings.
 * Returns the redacted files and the content hash: sha256 over `<mode>\0`, the sorted
 * `file\0path\0content\0` entries, then the sorted `delete\0path\0` entries. The tags
 * differ so a file named `remove` is not the same proposal as a deletion.
 */
export function validateProposal(
	input: ProposeInput,
	opts: Pick<ProposeOptions, "maxBytes" | "allowDocExamples" | "mode">,
): ValidatedProposal {
	const { name, surface, files, rationale } = input;
	if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
		throw new ProposeRefused(`invalid skill name ${JSON.stringify(String(name).slice(0, 80))}: must match ${SKILL_NAME_RE.source}`);
	}
	if (!(SURFACES as readonly string[]).includes(surface)) throw new ProposeRefused(`unknown surface ${JSON.stringify(String(surface).slice(0, 80))}`);
	if (typeof rationale !== "string") throw new ProposeRefused("rationale must be a string");
	refuseNulText("rationale", rationale);
	if (files === null || typeof files !== "object" || Array.isArray(files)) throw new ProposeRefused("files must be an object of relative path to text");
	if (opts.mode !== "overlay" && opts.mode !== "replace") throw new ProposeRefused("mode must be overlay or replace");

	let bytes = 0;
	for (const [path, text] of Object.entries(files)) {
		refuseSecretText("a file path", path);
		refusePath(path, "file");
		if (typeof text !== "string") throw new ProposeRefused(`file ${JSON.stringify(path)} is not text`);
		if (text.includes("\u0000")) throw new ProposeRefused(`file ${JSON.stringify(path)} contains NUL (binary content is not proposed)`);
		bytes += Buffer.byteLength(text, "utf8");
	}
	if (bytes > opts.maxBytes) throw new ProposeRefused(`proposal is ${bytes} bytes, over the limit of ${opts.maxBytes} bytes`);
	const conflict = conflictingPaths(Object.keys(files));
	if (conflict) throw new ProposeRefused(conflict);

	const skillMd = files["SKILL.md"];
	if (typeof skillMd !== "string") throw new ProposeRefused("files must contain SKILL.md");
	const frontmatter = parseFrontmatter(skillMd);
	if (!frontmatter) throw new ProposeRefused("SKILL.md has no parseable YAML frontmatter");
	if (frontmatter.name !== name) throw new ProposeRefused(`SKILL.md frontmatter name must equal ${JSON.stringify(name)}`);
	if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
		throw new ProposeRefused("SKILL.md frontmatter needs a non-empty description");
	}

	const remove = input.remove ?? [];
	if (!Array.isArray(remove)) throw new ProposeRefused("remove must be an array of relative paths");
	for (const path of remove) {
		if (typeof path !== "string") throw new ProposeRefused("remove must be an array of relative paths");
		refuseSecretText("a remove path", path);
		refusePath(path, "remove");
		if (path === "SKILL.md") throw new ProposeRefused("remove must never name SKILL.md");
		if (Object.hasOwn(files, path)) throw new ProposeRefused(`${JSON.stringify(path)} is in both files and remove`);
	}
	if (input.session_id !== undefined) {
		if (typeof input.session_id !== "string") throw new ProposeRefused("session_id must be a string");
		refuseSecretText("session_id", input.session_id);
		refuseNulText("session_id", input.session_id);
	}
	if (input.graph_id !== undefined) {
		if (typeof input.graph_id !== "string") throw new ProposeRefused("graph_id must be a string");
		refuseSecretText("graph_id", input.graph_id);
		refuseNulText("graph_id", input.graph_id);
	}

	const scan = scanSkillFiles(files, opts.allowDocExamples ? { allowDocExamples: opts.allowDocExamples } : {});
	if (scan.findings.length > 0) {
		throw new ProposeRefused(`secret-like content in ${scan.findings.length} place(s); remove it or use an env reference`, scan.findings);
	}

	// Redaction can turn a string field into YAML that no longer matches the contract
	// (a description that is only the redaction marker parses as an array). The committed text is what is checked.
	const redactedMd = scan.files["SKILL.md"];
	const redactedFrontmatter = typeof redactedMd === "string" ? parseFrontmatter(redactedMd) : null;
	if (!redactedFrontmatter) throw new ProposeRefused("SKILL.md frontmatter is not valid after redaction");
	if (redactedFrontmatter.name !== name) throw new ProposeRefused(`SKILL.md frontmatter name must equal ${JSON.stringify(name)} after redaction`);
	if (typeof redactedFrontmatter.description !== "string" || redactedFrontmatter.description.trim().length === 0) {
		throw new ProposeRefused("SKILL.md frontmatter needs a non-empty string description after redaction");
	}

	const sortedRemove = [...new Set(remove)].sort();
	const hash = createHash("sha256");
	hash.update(`${opts.mode}\0`);
	for (const path of Object.keys(scan.files).sort()) hash.update(`file\0${path}\0${scan.files[path]}\0`);
	for (const path of sortedRemove) hash.update(`delete\0${path}\0`);
	return {
		name,
		surface,
		mode: opts.mode,
		files: scan.files,
		remove: sortedRemove,
		redactions: scan.redactions,
		content_sha256: hash.digest("hex"),
	};
}
/**
 * The content hash before `file`/`delete` tags separated files from removals
 * (`<mode>\0`, sorted `path\0content\0`, sorted `remove\0path\0`). Read-only
 * compatibility for ledger lines from that era: `fromLedger` consults it only when
 * the tagged hash matches nothing, and new ledger writes keep the tagged hash, so
 * the file-named-`remove` collision stays fixed.
 */
export function legacyContentSha256(mode: TreeMode, files: Record<string, string>, remove: readonly string[]): string {
	const hash = createHash("sha256");
	hash.update(`${mode}\0`);
	for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
	for (const path of [...new Set(remove)].sort()) hash.update(`remove\0${path}\0`);
	return hash.digest("hex");
}


// ── tree ────────────────────────────────────────────────────────────────────

/** True when `path` is a symlink, including a dangling one (`existsSync` follows and would miss it). */
function symlinkAt(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw cause;
	}
}

/** The absolute target of `rel` under root, refusing anything that resolves outside or crosses a symlink. */
function confined(root: string, rel: string): string {
	const problem = pathProblem(rel);
	if (problem) throw new ProposeFailed(`refusing tree path ${JSON.stringify(rel)}: ${problem}`);
	const target = resolve(root, rel);
	if (!target.startsWith(`${root}${sep}`)) throw new ProposeFailed(`refusing tree path ${JSON.stringify(rel)}: outside the skill`);
	let current = root;
	for (const segment of rel.split("/").slice(0, -1)) {
		current = join(current, segment);
		if (symlinkAt(current)) {
			throw new ProposeFailed(`refusing tree path ${JSON.stringify(rel)}: ${segment} is a symlink`);
		}
	}
	return target;
}

/**
 * Write a proposal into `<cloneDir>/<name>/`. overlay: the named files are (re)written, `remove`
 * paths are deleted, everything else of the skill is kept. replace: the skill dir is emptied
 * first, so it holds exactly the proposed files. Nothing outside `<cloneDir>/<name>/` is touched.
 *
 * A file the proposal names can clash with the library's tree: an existing directory where the
 * file goes, or an existing file where a parent directory goes. Those reach `writeFileSync`
 * and `mkdirSync` as raw filesystem errors (and a 500 that names nothing), so refuse them here
 * with the path the caller must change. Checked after the removals, so a removal that clears
 * the clash still applies.
 */
function treeClash(root: string, rel: string, target: string): string | null {
	let current = root;
	for (const segment of rel.split("/").slice(0, -1)) {
		current = join(current, segment);
		let ancestor: Stats | null = null;
		try {
			ancestor = lstatSync(current);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return `${JSON.stringify(segment)} cannot be inspected`;
		}
		if (ancestor !== null && !ancestor.isDirectory()) return `${JSON.stringify(segment)} exists and is not a directory`;
	}
	try {
		if (lstatSync(target).isDirectory()) return "a directory already exists there";
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return "the path cannot be inspected";
	}
	return null;
}
export function writeTree(cloneDir: string, name: string, files: Record<string, string>, remove: readonly string[], mode: TreeMode): void {
	if (!SKILL_NAME_RE.test(name)) throw new ProposeFailed(`refusing skill name ${JSON.stringify(name)}`);
	const root = resolve(cloneDir, name);
	const targets = Object.entries(files).map(([rel, text]) => ({ rel, target: confined(root, rel), text }));
	const removals = remove.map((rel) => confined(root, rel));
	if (symlinkAt(root)) throw new ProposeFailed(`refusing skill dir ${name}: a symlink`);
	if (mode === "replace") rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const target of removals) rmSync(target, { recursive: true, force: true });
	for (const { rel, target, text } of targets) {
		const clash = treeClash(root, rel, target);
		if (clash !== null) throw new ProposeRefused(`file ${JSON.stringify(rel)} clashes with the skill tree: ${clash}`);
		mkdirSync(dirname(target), { recursive: true });
		// `existsSync` is false for a dangling link, and `writeFileSync` would follow it.
		if (symlinkAt(target)) rmSync(target);
		writeFileSync(target, text);
	}
}

// ── argv builders (pinned by tests) ─────────────────────────────────────────

/** skill/<surface>/<name>-<UTC yyyymmddThhmmssmmmZ>-<4 hex> */
export function branchName(surface: string, name: string, at: Date, hex: string): string {
	return `skill/${surface}/${name}-${at.toISOString().replace(/[-:.]/g, "")}-${hex}`;
}

export function fetchArgv(mirror = MIRROR): string[] {
	return ["git", "-C", mirror, "fetch", "origin", "main"];
}

export function cloneArgv(dir: string, mirror = MIRROR): string[] {
	return ["git", "clone", "--shared", "--no-checkout", mirror, dir];
}

export function setUrlArgv(dir: string, remoteUrl: string): string[] {
	return ["git", "-C", dir, "remote", "set-url", "origin", remoteUrl];
}

export function checkoutArgv(dir: string, branch: string): string[] {
	return ["git", "-C", dir, "checkout", "-q", "-b", branch, "origin/main"];
}

/** Explicit pathspec: git ≥ 2.0 stages the removals under it too; never `add -A` on the whole clone. */
export function addArgv(dir: string, name: string): string[] {
	return ["git", "-C", dir, "add", "--", name];
}

/** What `git add` actually staged. An ignored path is absent, which the engine refuses. */
export function stagedArgv(dir: string, name: string): string[] {
	return ["git", "-C", dir, "ls-files", "-z", "--full-name", "--", name];
}

export function diffQuietArgv(dir: string): string[] {
	return ["git", "-C", dir, "diff", "--cached", "--quiet"];
}

export function nameStatusArgv(dir: string): string[] {
	return ["git", "-C", dir, "diff", "--cached", "--name-status", "--no-renames"];
}

export function commitArgv(dir: string, message: string): string[] {
	return ["git", "-C", dir, "-c", `user.name=${COMMIT_USER_NAME}`, "-c", `user.email=${COMMIT_USER_EMAIL}`, "commit", "-q", "-m", message];
}

export function originUrlArgv(dir: string): string[] {
	return ["git", "-C", dir, "remote", "get-url", "origin"];
}

/** A new branch to origin; nothing else, ever. */
export function pushArgv(dir: string, branch: string): string[] {
	return ["git", "-C", dir, "push", "origin", branch];
}

export function prViewArgv(url: string): string[] {
	return ["gh", "pr", "view", url, "--json", "state,url,number"];
}

export function prListHeadArgv(branch: string, repo: string): string[] {
	return ["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "url,number,state"];
}

/** The library's default branch: the base every proposal PR targets, and the only base `skills_approve` accepts. */
export const LIBRARY_BASE = "main";

export function prCreateArgv(branch: string, title: string, body: string, repo: string): string[] {
	return ["gh", "pr", "create", "--repo", repo, "--head", branch, "--base", LIBRARY_BASE, "--title", title, "--body", body];
}

/** worktree.py `_origin_matches`: exactly this owner/repo (case-insensitive, `.git` ignored, path or scp suffix). */
export function originMatches(url: string, slug: string): boolean {
	let norm = url.trim().toLowerCase().replace(/\/+$/, "");
	if (norm.endsWith(".git")) norm = norm.slice(0, -".git".length);
	const want = slug.toLowerCase();
	return norm === want || norm.endsWith(`/${want}`) || norm.endsWith(`:${want}`);
}

/**
 * The `url` of the mirror's `origin` remote, read from its git config — null when the
 * mirror has no origin or its config cannot be read. The mirror is bootstrapped once by
 * the operator (`git clone --bare`), so a missing origin means hand-built state, not a
 * second library: only a present-but-foreign URL refuses the proposal.
 */
export function mirrorOriginUrl(mirror: string): string | null {
	let config: string;
	try {
		config = readFileSync(join(mirror, "config"), "utf8");
	} catch {
		return null;
	}
	let inOrigin = false;
	for (const line of config.split("\n")) {
		const section = /^\s*\[\s*remote\s+"origin"\s*\]\s*$/i.exec(line);
		if (section) {
			inOrigin = true;
			continue;
		}
		if (/^\s*\[/.test(line)) inOrigin = false;
		else if (inOrigin) {
			const url = /^\s*url\s*=\s*(\S.*?)\s*$/.exec(line);
			if (url?.[1]) return url[1];
		}
	}
	return null;
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** The library's PR URL from gh's stdout (its last matching line), or null. The slug is the configured one. */
export function prUrlOf(stdout: string, repo: string): { url: string; number: number } | null {
	for (const line of stdout.split("\n").reverse()) {
		const match = PR_URL_RE.exec(line.trim());
		if (match && match[1]?.toLowerCase() === repo.toLowerCase()) return { url: line.trim(), number: Number(match[2]) };
	}
	return null;
}

// ── PR text ─────────────────────────────────────────────────────────────────

function oneLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").slice(0, BODY_ID_MAX);
}

export function prTitle(name: string, surface: string): string {
	return `skill(${name}): proposal from ${surface}`.slice(0, PR_TITLE_MAX);
}

/** The PR body: hash, provenance, tree mode and removals, the capped (and redacted) rationale, the redacted spans. */
export function prBody(v: ValidatedProposal, input: Pick<ProposeInput, "rationale" | "session_id" | "graph_id">): string {
	const head = [
		`Proposed through substrate skills propose (surface: ${v.surface}). The owner reviews and merges; nothing is published live.`,
		"",
		`skill-content-sha256: ${v.content_sha256}`,
		`surface: ${v.surface}`,
		...(input.session_id ? [`session_id: ${oneLine(input.session_id)}`] : []),
		...(input.graph_id ? [`graph_id: ${oneLine(input.graph_id)}`] : []),
		`tree mode: ${v.mode}${v.mode === "overlay" ? " (files not named here are kept)" : " (the proposal is the whole skill)"}`,
		`removed paths: ${v.remove.length > 0 ? v.remove.join(", ") : "none"}`,
		"",
		"## Rationale",
		"",
		// Redact the whole rationale first. Capping first can cut a `<private>` block in half and
		// copy the private text into the PR.
		redactSkillContent(input.rationale).text.slice(0, RATIONALE_MAX) || "(none given)",
		"",
		"## Redacted spans",
		"",
		"",
	].join("\n");
	if (v.redactions.length === 0) return `${head}none\n`;
	let body = head;
	for (const [i, hit] of v.redactions.entries()) {
		const line = `- ${hit.file}:${hit.line} ${hit.rule}\n`;
		if (body.length + line.length > PR_BODY_MAX - 80) return `${body}- … ${v.redactions.length - i} more\n`;
		body += line;
	}
	return body;
}

function commitMessage(v: ValidatedProposal): string {
	return `skill(${v.name}): ${v.surface} proposal\n\nskill-content-sha256: ${v.content_sha256}`;
}

// ── runner ──────────────────────────────────────────────────────────────────

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/**
 * The exact environment git and gh children run with (D21-15): PATH, HOME, and the two
 * no-prompt flags. Store URLs, surface tokens and the handoff key never reach a child.
 * HOME is the configured or inherited home, /root when unset, so gh's stored credential
 * answers under systemd. Git's own config is not: a host `url.*.insteadOf` must not
 * redirect the push. That does not change where gh reads credentials.
 */
export function childEnv(home?: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home ?? process.env.HOME ?? "/root",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		// The host gitconfig stays unread, so `url.*.insteadOf` cannot redirect a push.
		// GitHub HTTPS still authenticates through gh, which is what `/root/.gitconfig` sets.
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_1: "!/usr/bin/gh auth git-credential",
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
	};
}

/** argv[0] stays the literal "git"/"gh" in every builder; only the spawn maps gh to the configured binary. */
export function childBinary(argv0: string, gh: string): string {
	return argv0 === "gh" ? gh : argv0;
}

/**
 * The production runner: execFile with an argv (never a shell), 120 s, a 4 MiB buffer,
 * and the allowlisted childEnv; git and gh never prompt.
 */
export function createExecFileRunner({ gh, home }: { gh: string; home?: string }): Runner {
	const env = childEnv(home);
	return (argv: readonly string[]) => {
		const { promise, resolve: done } = Promise.withResolvers<RunResult>();
		execFile(
			childBinary(argv[0] as string, gh),
			argv.slice(1),
			{ timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
				done({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		return promise;
	};
}

function tail(result: RunResult): string {
	return redact(`${result.stdout}${result.stderr}`.trim()).slice(-OUTPUT_TAIL_CHARS);
}

async function must(run: Runner, label: string, argv: string[]): Promise<RunResult> {
	const result = await run(argv);
	if (result.code !== 0) throw new ProposeFailed(`${label} exited ${String(result.code)}: ${tail(result)}`);
	return result;
}

// ── locks and ledger ────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
}
let lockTakeoverSeq = 0;

/** The PID the lock directory names, or NaN when it names none (being written, or left without one). */
function lockPidOf(dir: string): number {
	try {
		return Number(readFileSync(join(dir, "pid"), "utf8").trim());
	} catch {
		return Number.NaN;
	}
}

/** Whether the lock instance at `dir` is free to take under the wait's staleness rule. */
function lockIsStale(dir: string, waitMs: number): boolean {
	const pid = lockPidOf(dir);
	if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
	const age = Date.now() - (existsSync(dir) ? statSync(dir).mtimeMs : Date.now());
	return age > waitMs;
}

/**
 * Remove the stale lock without ever deleting a fresh one: rename it aside (atomic, so
 * concurrent recoverers of the same lock elect exactly one winner), re-check the renamed
 * copy, and restore that exact instance untouched when its owner showed up mid-takeover.
 * Returns true when the stale instance is gone and the caller may try to acquire again.
 */
async function takeStaleLock(path: string, waitMs: number): Promise<boolean> {
	const stale = `${path}.stale.${process.pid}.${lockTakeoverSeq++}`;
	try {
		renameSync(path, stale);
	} catch {
		return false;
	}
	if (!lockIsStale(stale, waitMs)) {
		// Its owner arrived mid-takeover: put that exact instance back. A fresh lock may
		// occupy the path for a moment; wait for it to drain rather than strand a live lock.
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				renameSync(stale, path);
				return false;
			} catch {
				if (Date.now() >= deadline) return false;
				await Bun.sleep(LOCK_POLL_MS);
			}
		}
	}
	try {
		rmSync(stale, { recursive: true, force: true });
	} catch {
		// A uniquely named leftover keeps its old mtime, so a later recovery reclaims it.
	}
	return true;
}

/**
 * A directory lock holding the owner's PID. A lock whose PID is gone (or that never got a PID
 * within the wait) is reclaimed; a live one is waited for, then ProposeFailed(`<label> busy`).
 * Recovery takes the stale instance aside rather than deleting the live path, and the release
 * removes only the lock this caller still owns — never a replacement another process took since.
 */
export async function acquireLock(path: string, label: string, waitMs: number): Promise<() => void> {
	const started = Date.now();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	for (;;) {
		try {
			mkdirSync(path, { mode: 0o700 });
			try {
				writeFileSync(join(path, "pid"), String(process.pid));
			} catch (writeCause) {
				// Our mkdir won but the pid never landed: drop exactly that half-made
				// instance. `rmdirSync` only removes an empty directory, so a lock another
				// process claimed since is never deleted wholesale.
				try {
					rmdirSync(path);
				} catch {
					// Taken over or claimed meanwhile; age-based recovery covers leftovers.
				}
				throw writeCause;
			}
			const owner = process.pid;
			return () => {
				if (lockPidOf(path) !== owner) return;
				rmSync(path, { recursive: true, force: true });
			};
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
		}
		if (lockIsStale(path, waitMs)) {
			await takeStaleLock(path, waitMs);
			continue;
		}
		if (Date.now() - started >= waitMs) throw new ProposeFailed(`${label} busy`);
		await Bun.sleep(LOCK_POLL_MS);
	}
}

type LedgerState = "pushed" | "opened" | "closed";
type LedgerLine = {
	ts: string;
	content_sha256: string;
	name: string;
	surface: string;
	branch: string;
	state: LedgerState;
	/** The library slug this record was opened against. Absent on a line written before it was recorded. */
	repo?: string;
	pr_url?: string;
	pr_number?: number;
};

function ledgerMatches(path: string, sha: string): LedgerLine[] {
	if (!existsSync(path)) return [];
	const found: LedgerLine[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.includes(sha)) continue;
		try {
			const parsed = JSON.parse(line) as LedgerLine;
			if (parsed.content_sha256 === sha) found.push(parsed);
		} catch {
			// a torn line never decides anything
		}
	}
	return found;
}

function ledgerAppend(path: string, line: Omit<LedgerLine, "ts">): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fresh = !existsSync(path);
	appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
	if (fresh) chmodSync(path, 0o600);
}
/**
 * The push/ledger window: a pushed branch with no ledger line is invisible to a
 * retry, which pushes a second branch. Touch the ledger before pushing so a
 * read-only file or directory refuses here, before the branch exists remotely.
 */
function assertLedgerWritable(ledger: string, branch: string): void {
	try {
		mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
		appendFileSync(ledger, "", { mode: 0o600 });
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code ?? "EIO";
		throw new ProposeFailed(`proposal ledger is not writable (${code}); refusing to push ${branch}`);
	}
}

// ── propose ─────────────────────────────────────────────────────────────────

type Paths = { mirror: string; proposeRoot: string; mirrorLock: string; contentLocks: string; ledger: string };

function pathsFor(opts: ProposeOptions): Paths {
	const state = opts.stateDir ?? SKILLS_STATE;
	return {
		mirror: join(state, "mirror.git"),
		proposeRoot: join(state, "propose"),
		mirrorLock: join(state, "mirror.lock"),
		contentLocks: join(state, "locks"),
		ledger: opts.ledgerPath ?? join(state, "proposals.jsonl"),
	};
}

/** The missing-mirror refusal, rendered with the configured remote and path (D21-14). */
export function missingMirrorMessage(mirror: string, remoteUrl: string): string {
	return (
		`${mirror} missing; bootstrap it:\n` +
		`env -i HOME=/root PATH=/usr/bin:/bin git clone --bare ${remoteUrl} ${mirror}\n` +
		`git -C ${mirror} config remote.origin.fetch +refs/heads/main:refs/heads/main\n` +
		`env -i HOME=/root PATH=/usr/bin:/bin git -C ${mirror} fetch origin`
	);
}

async function openPr(
	run: Runner,
	v: ValidatedProposal,
	input: ProposeInput,
	branch: string,
	ledger: string,
	library: SkillsLibrary,
): Promise<ProposeResult> {
	const created = await must(run, "gh pr create", prCreateArgv(branch, prTitle(v.name, v.surface), prBody(v, input), library.repo));
	const pr = prUrlOf(created.stdout, library.repo);
	if (!pr) throw new ProposeFailed(`gh pr create printed no pull request URL for ${library.repo}`);
	ledgerAppend(ledger, { content_sha256: v.content_sha256, name: v.name, surface: v.surface, branch, state: "opened", repo: library.repo, pr_url: pr.url, pr_number: pr.number });
	return { status: "opened", pr_url: pr.url, pr_number: pr.number, branch, content_sha256: v.content_sha256, redactions: v.redactions };
}

/**
 * What the ledger already knows about this content: an OPEN PR is `existing`, an owner-CLOSED
 * one `declined` (unless reopen), a pushed branch without a PR gets its PR (never a second push).
 * null means: run the git path (no record, a MERGED PR, or reopen). A MERGED match is recorded in replay.mergedPrUrl for beforeWork.
 */
async function fromLedger(
	run: Runner,
	v: ValidatedProposal,
	input: ProposeInput,
	opts: ProposeOptions,
	ledger: string,
	replay: { mergedPrUrl: string | null },
): Promise<ProposeResult | null> {
	const library = opts.library ?? DEFAULT_LIBRARY;
	let knownLines = ledgerMatches(ledger, v.content_sha256);
	if (knownLines.length === 0) {
		// A line written before `file`/`delete` tags hashes the same content
		// differently. Fall back to that hash so September's proposals are still
		// found — gated on name and surface so the old scheme's file/remove
		// collision cannot decide a different proposal.
		const legacy = legacyContentSha256(v.mode, v.files, v.remove);
		if (legacy !== v.content_sha256) {
			knownLines = ledgerMatches(ledger, legacy).filter((line) => line.name === v.name && line.surface === v.surface);
		}
	}
	if (knownLines.length === 0) return null;
	// A line written before `repo` was recorded still names its library when the saved PR URL
	// does. A line that names neither must not decide this library, and a later identified
	// line is allowed to.
	const identified = knownLines.map((line) => ({ line, repo: ledgerRepo(line) }));
	const known = [...identified].reverse().find((item) => item.repo === library.repo)?.line;
	if (!known) {
		if (identified.some((item) => item.repo === null)) {
			throw new ProposeFailed(`proposal ledger has no library identity; use a separate state directory before proposing to ${library.repo}`);
		}
		return null;
	}
	const base = { content_sha256: v.content_sha256, redactions: v.redactions, branch: known.branch };
	if (known.pr_url) {
		const view = await must(run, "gh pr view", prViewArgv(known.pr_url));
		let state: unknown;
		try {
			state = (JSON.parse(view.stdout) as { state?: unknown }).state;
		} catch {
			throw new ProposeFailed("gh pr view printed no JSON");
		}
		const pr = { pr_url: known.pr_url, ...(known.pr_number !== undefined ? { pr_number: known.pr_number } : {}) };
		if (state === "OPEN") return { status: "existing", ...base, ...pr };
		if (state === "CLOSED" && !opts.reopen) {
			if (known.state !== "closed") {
				const { ts: _ts, ...rest } = known;
				ledgerAppend(ledger, { ...rest, state: "closed" });
			}
			return { status: "declined", ...base, ...pr };
		}
		if (state === "MERGED") replay.mergedPrUrl = known.pr_url;
		if (state !== "CLOSED" && state !== "MERGED") throw new ProposeFailed(`gh pr view reported state ${JSON.stringify(String(state)).slice(0, 40)}`);
		return null;
	}
	if (known.state !== "pushed") return null;
	const listed = await must(run, "gh pr list", prListHeadArgv(known.branch, library.repo));
	let prs: Array<{ url?: unknown; number?: unknown; state?: unknown }>;
	try {
		prs = JSON.parse(listed.stdout) as Array<{ url?: unknown; number?: unknown; state?: unknown }>;
	} catch {
		throw new ProposeFailed("gh pr list printed no JSON");
	}
	const rows = prs.flatMap((p) => {
		if (typeof p.url !== "string" || typeof p.state !== "string") return [];
		const located = prUrlOf(p.url, library.repo);
		return located ? [{ ...located, state: p.state }] : [];
	});
	const open = rows.find((row) => row.state === "OPEN");
	if (open) {
		ledgerAppend(ledger, {
			content_sha256: v.content_sha256,
			name: v.name,
			surface: v.surface,
			branch: known.branch,
			state: "opened",
			repo: library.repo,
			pr_url: open.url,
			pr_number: open.number,
		});
		return { status: "existing", ...base, pr_url: open.url, pr_number: open.number };
	}
	const closed = rows.find((row) => row.state === "CLOSED");
	if (closed && !opts.reopen) {
		ledgerAppend(ledger, {
			content_sha256: v.content_sha256,
			name: v.name,
			surface: v.surface,
			branch: known.branch,
			state: "closed",
			repo: library.repo,
			pr_url: closed.url,
			pr_number: closed.number,
		});
		return { status: "declined", ...base, pr_url: closed.url, pr_number: closed.number };
	}
	// Merged, or a closed PR the operator asked to reopen: the git path, not a second PR on the old branch.
	const merged = rows.find((row) => row.state === "MERGED");
	if (merged) replay.mergedPrUrl = merged.url;
	if (rows.length > 0) return null;
	return openPr(run, v, input, known.branch, ledger, library);
}

/** The library a ledger line was written for: the recorded slug, or the one in its PR URL. */
function ledgerRepo(line: LedgerLine): string | null {
	if (typeof line.repo === "string" && line.repo.length > 0) return line.repo;
	const match = typeof line.pr_url === "string" ? PR_URL_RE.exec(line.pr_url.trim()) : null;
	return match?.[1] ?? null;
}

function countNameStatus(stdout: string): { diff_added: number; diff_changed: number; diff_deleted: number } {
	const counts = { diff_added: 0, diff_changed: 0, diff_deleted: 0 };
	for (const line of stdout.split("\n")) {
		const letter = line.trim().charAt(0);
		if (letter === "A") counts.diff_added++;
		else if (letter === "M" || letter === "T") counts.diff_changed++;
		else if (letter === "D") counts.diff_deleted++;
	}
	return counts;
}

/**
 * validate → mirror check → per-content lock → ledger → beforeWork → mirror lock, fetch, unlock → shared
 * clone, set-url, checkout → writeTree → add → diff → commit → origin check → push → ledger
 * pushed → gh pr create → ledger opened. The clone is removed and the locks released in finally.
 */
export async function proposeSkill(input: ProposeInput, opts: ProposeOptions): Promise<ProposeResult> {
	const v = validateProposal(input, opts);
	// The removal list sits in the body header. Cap the whole body before any git work, so a
	// pushed branch is never left behind a `gh` that cannot accept the argument.
	if (prBody(v, input).length > PR_BODY_MAX) {
		throw new ProposeRefused(`pull request body is over the limit of ${PR_BODY_MAX} characters`);
	}
	const paths = pathsFor(opts);
	const library = opts.library ?? DEFAULT_LIBRARY;
	if (!existsSync(join(paths.mirror, "HEAD"))) {
		throw new ProposeFailed(missingMirrorMessage(paths.mirror, library.remoteUrl));
	}
	// The state directory outlives the configuration: an operator who changes the library
	// while keeping SUBSTRATE_SKILLS_STATE would otherwise fetch the old library's history
	// and build the branch from its tree, answering `unchanged` or pushing wrongly. Refuse
	// a mirror whose origin names another library before any fetch or clone.
	const mirrorOrigin = mirrorOriginUrl(paths.mirror);
	if (mirrorOrigin !== null && !originMatches(mirrorOrigin, library.repo)) {
		throw new ProposeFailed(
			`mirror ${paths.mirror} points at ${JSON.stringify(mirrorOrigin.slice(0, 120))}, not ${library.repo}; re-bootstrap it for the configured library before proposing`,
		);
	}
	const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
	const run = opts.run;

	const releaseContent = opts.dryRun ? null : await acquireLock(join(paths.contentLocks, v.content_sha256), "proposal", waitMs);
	let clone: string | null = null;
	try {
		const replay: { mergedPrUrl: string | null } = { mergedPrUrl: null };
		if (!opts.dryRun) {
			const known = await fromLedger(run, v, input, opts, paths.ledger, replay);
			if (known) return known;
		}
		const gate = opts.beforeWork ? await opts.beforeWork(replay.mergedPrUrl) : null;

		const releaseMirror = await acquireLock(paths.mirrorLock, "mirror", waitMs);
		try {
			await must(run, "git fetch", fetchArgv(paths.mirror));
		} finally {
			releaseMirror();
		}

		const now = new Date();
		const hex = randomBytes(2).toString("hex");
		const branch = branchName(v.surface, v.name, now, hex);
		mkdirSync(paths.proposeRoot, { recursive: true, mode: 0o700 });
		clone = join(paths.proposeRoot, `${v.name}-${now.getTime()}-${hex}`);
		await must(run, "git clone", cloneArgv(clone, paths.mirror));
		await must(run, "git remote set-url", setUrlArgv(clone, library.remoteUrl));
		await must(run, "git checkout", checkoutArgv(clone, branch));
		writeTree(clone, v.name, v.files, v.remove, v.mode);
		await must(run, "git add", addArgv(clone, v.name));
		const staged = await must(run, "git ls-files", stagedArgv(clone, v.name));
		const stagedSet = new Set(staged.stdout.split("\0").filter((line) => line.length > 0));
		for (const rel of Object.keys(v.files)) {
			if (!stagedSet.has(`${v.name}/${rel}`)) {
				throw new ProposeFailed(`refusing to propose ${JSON.stringify(rel)}: git did not stage it`);
			}
		}

		const base = { content_sha256: v.content_sha256, redactions: v.redactions };
		if (opts.dryRun) {
			const status = await must(run, "git diff", nameStatusArgv(clone));
			return { status: "dry_run", ...base, ...countNameStatus(status.stdout) };
		}
		const diff = await run(diffQuietArgv(clone));
		if (diff.code === 0) return { status: "unchanged", ...base };
		if (diff.code !== 1) throw new ProposeFailed(`git diff exited ${String(diff.code)}: ${tail(diff)}`);
		// A merged retry the library no longer confirms is refused here: no commit, branch push or PR.
		if (gate) throw gate.unlessUnchanged;

		await must(run, "git commit", commitArgv(clone, commitMessage(v)));
		const origin = await must(run, "git remote get-url", originUrlArgv(clone));
		if (!originMatches(origin.stdout, library.repo)) throw new ProposeFailed(`clone origin is not ${library.repo}; refusing to push`);
		assertLedgerWritable(paths.ledger, branch);
		await must(run, "git push", pushArgv(clone, branch));
		try {
			ledgerAppend(paths.ledger, { content_sha256: v.content_sha256, name: v.name, surface: v.surface, branch, state: "pushed", repo: library.repo });
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code ?? "EIO";
			throw new ProposeFailed(`could not record the pushed branch in the proposal ledger (${code}); recover with \`gh pr create --repo ${library.repo} --head ${branch} --base main\` or delete the branch`);
		}
		return await openPr(run, v, input, branch, paths.ledger, library);
	} finally {
		if (clone) rmSync(clone, { recursive: true, force: true });
		releaseContent?.();
	}
}

/** service.ts's seam: the runner, library and state dir bound once, request options per call. */
export function createSkillProposer({
	run,
	library,
	stateDir,
}: {
	run: Runner;
	library?: SkillsLibrary;
	stateDir?: string;
}): SkillProposer {
	return { propose: (input, opts) => proposeSkill(input, { library, stateDir, ...opts, run }) };
}
