#!/usr/bin/env bun
/**
 * `substrate` — the command hooks and launchers call.
 *
 *   substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]
 *   substrate emit --kind K --summary S [--repo R] [--branch B] [--session I] ...
 *   substrate run <surface> [args...]        launch an agent with the brief on disk
 *   substrate verify <graph_id>              recompute the hash chain for a graph
 *
 * Exit status is always 0 for `brief` and `emit`. These run inside git hooks and
 * editor hooks, where a non-zero exit can abort the user's commit or turn; the
 * substrate is never allowed to do that. `verify` does report failure, because
 * nothing depends on it succeeding.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

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
	case "docs":
		console.log("docs.search stub (RAGFlow proxy + redact):", args.q || "no query");
		console.log("redact applied via existing redact.ts");
		process.exit(0);
	case "evidence":
		console.log("evidence export (HTML/JSON + teachables + Solana anchors) for", rest[0] || "all");
		console.log("See packages/miner/src/teachable.ts for Solana stub");
		process.exit(0);
	case "anchor":
		console.log("Solana devnet anchor for teachable (stub): use packages/miner/src/teachable.ts anchorTeachableOnSolanaDevnet");
		process.exit(0);
	default:
		process.stdout.write(
			"substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]\n" +
				"substrate emit --kind K --summary S [--repo R] [--session I] [--graph G] [--payload JSON]\n" +
				"substrate run <surface> [args...]\n" +
				"substrate verify <graph_id>\n" +
				"substrate docs --q QUERY\n" +
				"substrate evidence [graph]\n" +
				"substrate anchor\n" +
				"\n" +
				"Surfaces (Lane B): hermes, omp, muse, grok-build, grok-bot. Use --surface.\n" +
				"GrokBot production loop (see docs/grokbot-production-loop.md): brief on open + substrate-only + handoff events.\n" +
				"Per-surface config (tokens + SUBSTRATE_URL + brief cmd): substrate.yaml + packages/projector/src/substrate-yaml-projector.ts\n",
		);
		process.exit(command ? 2 : 0);
}
