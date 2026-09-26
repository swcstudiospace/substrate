#!/usr/bin/env bun
/**
 * `substrate` — the command hooks and launchers call.
 *
 *   substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]
 *   substrate emit --kind K --summary S [--repo R] [--branch B] [--session I] ...
 *   substrate run <surface> [args...]        launch an agent with the brief on disk
 *   substrate verify <graph_id>              recompute the hash chain for a graph
 *   substrate skills propose --dir <path> [--name N] [--surface S] [--rationale R] [--session I]
 *       [--graph G] [--allow-doc-examples pem,jwt] [--replace] [--reopen] [--dry-run]
 *                                            propose a skill dir to the shared library (branch + PR)
 *
 * Exit status is always 0 for `brief` and `emit`. These run inside git hooks and
 * editor hooks, where a non-zero exit can abort the user's commit or turn; the
 * substrate is never allowed to do that. `verify` does report failure, because
 * nothing depends on it succeeding. `skills propose` is operator/batch-facing: it
 * exits 1 on a refusal or a git/gh failure and 0 on opened, existing, unchanged,
 * declined and dry_run. It proposes in-process through the same git path as
 * POST /skills/propose (no 1 MB HTTP cap, no propose key), then posts the
 * skill.propose event.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	CLI_MAX_BYTES,
	execFileRunner,
	ProposeFailed,
	type ProposeInput,
	ProposeRefused,
	type ProposeResult,
	proposeSkill,
} from "../../mcp-server/src/skills/propose.ts";
import type { SkillDocExampleRule } from "../../mcp-server/src/redact.ts";
import type { Surface } from "../../mcp-server/src/types.ts";

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;

function base(): string {
	return (process.env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function timeout(): number {
	const raw = Number(process.env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Parse `--key value` and `--flag` into a map. Unknown keys are kept, not rejected. */
function parseArgs(argv: string[]): Record<string, string | true> {
	const out: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function str(value: string | true | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function git(args: string[], cwd = process.cwd()): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

/** owner/name from the origin remote, matching what ultrathink records. */
function repoSlug(cwd = process.cwd()): string | undefined {
	const url = git(["remote", "get-url", "origin"], cwd);
	const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
	return match?.[1];
}

function branch(cwd = process.cwd()): string | undefined {
	return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || undefined;
}

async function post(path: string, body: unknown): Promise<Response | null> {
	try {
		return await fetch(`${base()}${path}`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout()),
		});
	} catch {
		return null;
	}
}

async function cmdBrief(args: Record<string, string | true>): Promise<void> {
	const repo = str(args.repo) ?? repoSlug();
	const response = await post("/brief", {
		repo,
		branch: str(args.branch) ?? branch(),
		graph_id: str(args.graph),
		surface: str(args.surface) ?? "claude-code",
	});
	const brief = response?.ok ? (await response.text()).trim() : "";
	if (!brief) return; // fail-open and silent: nothing useful to say

	if (args.write) {
		// `.substrate/BRIEF.md` is the fallback path for every surface: if a hook
		// fails or an agent has no hook API at all, the brief is still on disk.
		const path = join(process.cwd(), ".substrate", "BRIEF.md");
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${brief}\n`);
			process.stderr.write(`[substrate] wrote ${path}\n`);
		} catch (cause) {
			process.stderr.write(`[substrate] could not write ${path}: ${String(cause)}\n`);
		}
	}
	process.stdout.write(`${brief}\n`);
}

async function cmdEmit(args: Record<string, string | true>): Promise<void> {
	const kind = str(args.kind);
	const summary = str(args.summary);
	if (!kind || !summary) {
		process.stderr.write("[substrate] emit needs --kind and --summary\n");
		return;
	}
	let payload: Record<string, unknown> | undefined;
	const rawPayload = str(args.payload);
	if (rawPayload) {
		try {
			payload = JSON.parse(rawPayload) as Record<string, unknown>;
		} catch {
			process.stderr.write("[substrate] --payload is not valid JSON; dropping it\n");
		}
	}
	await post("/events", {
		kind,
		summary,
		surface: str(args.surface) ?? "claude-code",
		session_id: str(args.session),
		graph_id: str(args.graph),
		node_id: str(args.node),
		repo: str(args.repo) ?? repoSlug(),
		branch: str(args.branch) ?? branch(),
		actor: str(args.actor) ?? "agent",
		payload,
	});
}

/** Write the brief to disk, then exec the agent. For surfaces with no hook API. */
async function cmdRun(argv: string[]): Promise<number> {
	const surface = argv[0];
	if (!surface) {
		process.stderr.write("usage: substrate run <surface> [args...]\n");
		return 2;
	}
	await cmdBrief({ write: true, surface });
	const result = spawnSync(surface, argv.slice(1), { stdio: "inherit" });
	return result.status ?? 1;
}

async function cmdVerify(graphId: string | undefined): Promise<number> {
	if (!graphId) {
		process.stderr.write("usage: substrate verify <graph_id>\n");
		return 2;
	}
	const response = await post("/verify", { graph_id: graphId });
	if (!response) {
		process.stderr.write("[substrate] unreachable\n");
		return 1;
	}
	const body = (await response.json()) as { ok?: boolean; brokenAt?: string; reason?: string; events?: number };
	if (body.ok) {
		process.stdout.write(`chain intact for ${graphId} (${body.events ?? 0} events)\n`);
		return 0;
	}
	process.stderr.write(`chain BROKEN for ${graphId} at ${body.brokenAt}: ${body.reason}\n`);
	return 1;
}

class DirRefused extends Error {}

/**
 * Every file under `dir` as UTF-8 text, keyed by its relative path. Nothing is skipped silently:
 * a symlink, a special file or a file that is not valid UTF-8 refuses the whole dir, naming it,
 * and so does a total over the CLI cap.
 */
function readSkillDir(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	const walk = (abs: string, rel: string) => {
		for (const entry of readdirSync(abs).sort()) {
			const path = join(abs, entry);
			const relPath = rel ? `${rel}/${entry}` : entry;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new DirRefused(`${relPath} is a symlink`);
			if (stat.isDirectory()) walk(path, relPath);
			else if (!stat.isFile()) throw new DirRefused(`${relPath} is not a regular file`);
			else {
				bytes += stat.size;
				if (bytes > CLI_MAX_BYTES) throw new DirRefused(`the dir is over the limit of ${CLI_MAX_BYTES} bytes`);
				try {
					files[relPath] = decoder.decode(readFileSync(path));
				} catch {
					throw new DirRefused(`${relPath} is not valid UTF-8`);
				}
			}
		}
	};
	walk(dir, "");
	return files;
}

async function cmdSkillsPropose(args: Record<string, string | true>): Promise<number> {
	const out = (key: string, value: string | number | undefined) => {
		if (value !== undefined) process.stdout.write(`${key}=${value}\n`);
	};
	const refuse = (message: string) => {
		out("status", "refused");
		process.stderr.write(`[substrate] skills propose refused: ${message}\n`);
		return 1;
	};
	const dirArg = str(args.dir);
	if (!dirArg) return refuse("--dir <path> is required");
	const dir = resolve(dirArg);
	let files: Record<string, string>;
	try {
		const stat = lstatSync(dir);
		if (stat.isSymbolicLink()) return refuse(`${dirArg} is a symlink`);
		if (!stat.isDirectory()) return refuse(`${dirArg} is not a directory`);
		files = readSkillDir(dir);
	} catch (cause) {
		return refuse(cause instanceof DirRefused ? cause.message : `cannot read ${dirArg}: ${(cause as Error).message}`);
	}

	const allow = new Set<SkillDocExampleRule>();
	const allowArg = args["allow-doc-examples"];
	if (allowArg !== undefined) {
		if (allowArg === true) return refuse("--allow-doc-examples takes pem, jwt or pem,jwt");
		for (const rule of allowArg.split(",").map((r) => r.trim())) {
			if (rule !== "pem" && rule !== "jwt") return refuse(`--allow-doc-examples accepts only pem and jwt, not ${JSON.stringify(rule)}`);
			allow.add(rule);
		}
	}

	const name = str(args.name) ?? basename(dir);
	const surface = (str(args.surface) ?? "claude-code") as Surface;
	const session = str(args.session);
	const graph = str(args.graph);
	const input: ProposeInput = {
		name,
		files,
		rationale: str(args.rationale) ?? `substrate skills propose --dir ${basename(dir)}`,
		surface,
		...(session ? { session_id: session } : {}),
		...(graph ? { graph_id: graph } : {}),
	};
	let result: ProposeResult;
	try {
		result = await proposeSkill(input, {
			maxBytes: CLI_MAX_BYTES,
			...(allow.size > 0 ? { allowDocExamples: allow } : {}),
			mode: args.replace !== undefined ? "replace" : "overlay",
			dryRun: args["dry-run"] !== undefined,
			reopen: args.reopen !== undefined,
			run: execFileRunner,
		});
	} catch (cause) {
		if (cause instanceof ProposeRefused) {
			for (const finding of cause.findings ?? []) out("finding", `${finding.file}:${finding.line} ${finding.rule}`);
			return refuse(cause.message);
		}
		out("status", "failed");
		process.stderr.write(`[substrate] skills propose failed: ${cause instanceof ProposeFailed ? cause.message : String(cause)}\n`);
		return 1;
	}

	out("status", result.status);
	out("pr_url", result.pr_url);
	out("pr_number", result.pr_number);
	out("branch", result.branch);
	out("content_sha256", result.content_sha256);
	out("redactions", result.redactions.length);
	out("diff_added", result.diff_added);
	out("diff_changed", result.diff_changed);
	out("diff_deleted", result.diff_deleted);
	let eventStatus = "none";
	if (result.status !== "dry_run") {
		const response = await post("/events", {
			kind: "skill.propose",
			surface,
			summary: `skill ${name} ${result.status}`,
			session_id: session,
			graph_id: graph,
			actor: "agent",
			payload: {
				name,
				status: result.status,
				pr_url: result.pr_url,
				content_sha256: result.content_sha256,
				redactions: result.redactions.length,
			},
		});
		if (response) eventStatus = String(response.status);
	}
	out("event_status", eventStatus);
	return 0;
}

async function cmdSkills(argv: string[]): Promise<number> {
	if (argv[0] !== "propose") {
		process.stderr.write("usage: substrate skills propose --dir <path> [--name N] [--surface S] [--rationale R] ...\n");
		return 2;
	}
	return cmdSkillsPropose(parseArgs(argv.slice(1)));
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
	case "brief":
		await cmdBrief(args);
		process.exit(0);
	case "emit":
		await cmdEmit(args);
		process.exit(0);
	case "run":
		process.exit(await cmdRun(rest));
	case "verify":
		process.exit(await cmdVerify(rest[0]));
	case "skills":
		process.exit(await cmdSkills(rest));
	default:
		process.stdout.write(
			"substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]\n" +
				"substrate emit --kind K --summary S [--repo R] [--session I] [--graph G] [--payload JSON]\n" +
				"substrate run <surface> [args...]\n" +
				"substrate verify <graph_id>\n" +
				"substrate skills propose --dir <path> [--name N] [--surface S] [--rationale R] [--session I] [--graph G] [--allow-doc-examples pem,jwt] [--replace] [--reopen] [--dry-run]\n",
		);
		process.exit(command ? 2 : 0);
}
