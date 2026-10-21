#!/usr/bin/env bun
/**
 * `substrate` — the command hooks and launchers call.
 *
 *   substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]
 *   substrate emit --kind K --summary S [--repo R] [--branch B] [--session I] ...
 *   substrate run <surface> [args...]        launch an agent with the brief on disk
 *   substrate verify <graph_id>              recompute the hash chain for a graph
 *   substrate drift [--repo R] [--path P]    compare git, the ledger and the claims
 *   substrate handoff --to S --goal G ...    record a signed handoff packet
 *   substrate evidence --graph G             the evidence bundle, as JSON or HTML
 *   substrate lessons add|recall|digest|outcome   the lessons bank (docs/lessons-bank.md)
 *   substrate skills propose|list|approve ...  propose, list or decide a skill (docs/runbooks/skills-governance.md)
 *   substrate docs ingest --dataset NAME --path PATH --source-url URL [...]
 *       ingest one page into a docs dataset (docs/docs-search-ingest.md)
 *   substrate index sweep [--apply] [--json]  the index retention sweep (dry-run unless --apply
 *       AND SUBSTRATE_INDEX_SWEEP=apply are both given)
 *   substrate ledger coverage|archive|verify-archive   anchor coverage and the verified
 *       off-box archive (docs/greptime-ledger.md, "Coverage and archive")
 *   substrate index archive|verify-archive|restore   the verified logical export of the Postgres
 *       index and its restore-to-scratch proof (docs/runbooks/index-archive.md)
 *   substrate spool status|flush             the collector event spool (docs/collectors.md, "Event spool")
 *
 * With `SUBSTRATE_EVENT_SPOOL=on`, `emit` parks an event that failed for a retryable reason
 * (network error, timeout, 5xx) in the spool and returns at once — it never replays; `spool flush`
 * does. With the flag off `emit` is the single POST it always was.
 *
 * Exit status is always 0 for `brief`, `emit` and `handoff`. These run inside
 * git hooks and editor hooks, where a non-zero exit can abort the user's commit
 * or turn; the substrate is never allowed to do that. `verify`, `drift`,
 * `evidence` and the `lessons` writes do report failure, because nothing depends
 * on them succeeding and a silent empty answer would be worse than an error —
 * `drift` exits 1 when it found drift, so a hook or a cron can act on it, and an
 * evidence document nobody can tell from a missing one is not evidence. `lessons
 * recall` fails open instead: an unreachable bank injects nothing into a phase.
 *
 * The bearer for a surface comes from the token resolver: the environment
 * value first, then the token-file variable, then the per-surface file in
 * the tokens dir. Commands without a surface send as `claude-code`.
 * `skills` reports failure like `verify` and `drift`: it is not a hook command, and
 * a proposal, list or decision that was refused or never reached the server must not look like one that landed.
 */
import { chainStateOf, renderEvidenceHtml, type EvidenceBundle } from "@substrate/evidence";
import { list, parseArgs, str } from "./args.ts";
import { resolveBearer } from "./token.ts";
import { docsTimeout, runDocs } from "./docs.ts";
import { httpMemory, lessonsTimeout, runLessons } from "./lessons.ts";
import { runSkills, skillsTimeout } from "./skills.ts";
import { runLedger } from "./ledger.ts";
import { runSpool } from "./spool.ts";
import { spoolConfig } from "../../collectors/src/spool.ts";
import { INDEX_ARCHIVE_SUBCOMMANDS, INDEX_ARCHIVE_USAGE, runIndexArchive } from "./index-archive.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;

function base(): string {
	return (process.env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * The bearer for a surface comes from the token resolver: the environment
 * value first, else the token-file variable, else the per-surface file in
 * the tokens dir. Absent everywhere means no header, as before.
 */
function headers(surface: string): Record<string, string> {
	const token = resolveBearer(surface, process.env);
	return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function timeout(): number {
	const raw = Number(process.env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
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

async function post(path: string, body: unknown, surface = "claude-code", timeoutMs?: number): Promise<Response | null> {
	try {
		return await fetch(`${base()}${path}`, {
			method: "POST",
			headers: headers(surface),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs ?? timeout()),
		});
	} catch {
		return null;
	}
}

async function cmdBrief(args: Record<string, string | true>): Promise<void> {
	const repo = str(args.repo) ?? repoSlug();
	const surface = str(args.surface) ?? "claude-code";
	const response = await post(
		"/brief",
		{
			repo,
			branch: str(args.branch) ?? branch(),
			graph_id: str(args.graph),
			surface,
		},
		surface,
	);
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
	const surface = str(args.surface) ?? "claude-code";
	const body = {
		kind,
		summary,
		surface,
		session_id: str(args.session),
		graph_id: str(args.graph),
		node_id: str(args.node),
		repo: str(args.repo) ?? repoSlug(),
		branch: str(args.branch) ?? branch(),
		actor: str(args.actor) ?? "agent",
		payload,
	};
	if (spoolConfig().mode === "on") {
		// The shared emit stamps `ts` and the idempotency key at this first attempt and parks a
		// retryable failure in the spool; the CLI never replays (`substrate spool flush` does).
		const { postEvent } = await import("../../collectors/src/emit.ts");
		await postEvent(body as Parameters<typeof postEvent>[0], {
			timeoutMs: timeout(),
			collector: "cli",
			source: "cli.emit",
			url: base(),
		});
		return;
	}
	await post("/events", body, surface);
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
	// The `/verify` request may wait out the hour loop's devnet reads, so it
	// shares the server's whole-verify budget (D28-18), not the brief timeout.
	const budgetRaw = Number(process.env.SUBSTRATE_VERIFY_TIMEOUT_MS);
	const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 30_000;
	const response = await post("/verify", { graph_id: graphId }, "claude-code", budgetMs);
	if (!response) {
		process.stderr.write("[substrate] unreachable\n");
		return 1;
	}
	const body = (await response.json()) as {
		ok?: boolean;
		brokenAt?: string;
		reason?: string;
		events?: number;
		chain?: { ok: boolean; brokenAt?: string; reason?: string };
		hours?: Array<{ period_start: string; status: string; tx_sig?: string; reason?: string }>;
		uncovered?: { count: number; ids: string[] };
		missing?: { count: number; ids: string[] };
	};
	// The chain line reports the chain, not the anchors: an anchor failure
	// still prints `chain intact` here, and the hour lines carry the failure.
	const chainBroken = body.chain ? !body.chain.ok : !body.ok;
	if (!chainBroken) {
		process.stdout.write(`chain intact for ${graphId} (${body.events ?? 0} events)\n`);
	} else {
		process.stderr.write(`chain BROKEN for ${graphId} at ${body.chain?.brokenAt ?? body.brokenAt}: ${body.chain?.reason ?? body.reason}\n`);
	}
	for (const hour of body.hours ?? []) {
		if (hour.status === "anchored") {
			process.stdout.write(`${hour.period_start} anchored ${hour.tx_sig ?? ""}\n`);
		} else if (hour.status === "pending") {
			process.stdout.write(`${hour.period_start} pending\n`);
		} else if (hour.status === "mismatch") {
			process.stdout.write(`hour ${hour.period_start} does not match its anchor: ${hour.reason ?? "mismatch"}\n`);
		} else if (hour.status === "unverified") {
			process.stderr.write(`[substrate] verify could not check devnet for ${hour.period_start}: ${hour.reason ?? "unreadable"}\n`);
		} else {
			process.stdout.write(`${hour.period_start} ${hour.status}${hour.reason ? `: ${hour.reason}` : ""}\n`);
		}
	}
	if ((body.uncovered?.count ?? 0) > 0) {
		process.stderr.write(`uncovered events with no ingest record: ${(body.uncovered?.ids ?? []).join(", ")}\n`);
	}
	if ((body.missing?.count ?? 0) > 0) {
		process.stderr.write(`events with an ingest record but no event row: ${(body.missing?.ids ?? []).join(", ")}\n`);
	}
	return body.ok ? 0 : 1;
}

/**
 * Compare git, the ledger and the claims for this repo.
 *
 * The tip is read here rather than by the server: this already runs in the
 * checkout, so it knows it, and the substrate never has to be handed a path to
 * run `git` in. Exits 1 when there is drift, so a cron or a hook can branch on it.
 */
async function cmdDrift(args: Record<string, string | true>): Promise<number> {
	const repo = str(args.repo) ?? repoSlug();
	if (!repo) {
		process.stderr.write("[substrate] drift needs --repo, or a git remote to read it from\n");
		return 2;
	}
	const response = await post("/drift", {
		repo,
		branch: str(args.branch) ?? branch(),
		// `--path` asks the server to read a checkout instead; useful for scanning a
		// repo this process is not sitting in.
		path: str(args.path),
		git_tip: str(args.path) ? undefined : git(["rev-parse", "HEAD"]) || undefined,
		idle_seconds: Number(str(args.idle)) || undefined,
		format: args.json ? "json" : "text",
	});
	if (!response?.ok) {
		process.stderr.write("[substrate] unreachable\n");
		return 1;
	}
	const body = await response.text();
	process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
	// Exit 1 on drift in both modes. Reading the flag instead of the report meant
	// `--json` always exited 0, so a hook or cron that branched on the status saw
	// every scan as clean — the one thing the status code is for.
	if (args.json) {
		try {
			const report = JSON.parse(body) as { ok?: boolean; findings?: unknown[] };
			return report.ok === true || (report.findings?.length ?? 0) === 0 ? 0 : 1;
		} catch {
			// A reply that is not the report at all is not a clean scan either.
			return 1;
		}
	}
	return body.includes("— no drift") ? 0 : 1;
}

/**
 * Record a signed handoff packet. Exits 0 whatever happens, like `emit`: a
 * handoff runs at the end of a turn, and failing the turn over it would lose
 * the very work the handoff is there to preserve.
 */
async function cmdHandoff(args: Record<string, string | true>): Promise<void> {
	const to = str(args.to);
	const goal = str(args.goal);
	if (!to || !goal) {
		process.stderr.write("[substrate] handoff needs --to and --goal\n");
		return;
	}
	const surface = str(args.surface) ?? "claude-code";
	const response = await post(
		"/handoff",
		{
			to,
			goal,
			files: list(args.files),
			dod: list(args.dod),
			blockers: list(args.blockers),
			graph_id: str(args.graph),
			node_id: str(args.node),
			linear_identifier: str(args.linear),
			repo: str(args.repo) ?? repoSlug(),
			branch: str(args.branch) ?? branch(),
			session_id: str(args.session),
			surface,
			notes: str(args.notes),
			lease_id: str(args.lease),
			release_lease: args.release === true || str(args.release) === "true",
		},
		surface,
	);
	if (!response) {
		process.stderr.write("[substrate] unreachable; the handoff was not recorded\n");
		return;
	}
	const body = (await response.json()) as { packet?: { handoff_id?: string }; signed?: boolean; stored?: boolean; gaps?: string[] };
	process.stdout.write(
		`${body.packet?.handoff_id ?? "handoff"} to ${to} — ${body.signed ? "signed" : "UNSIGNED"}, ` +
			`${body.stored ? "stored" : "NOT stored"}\n`,
	);
	// The gaps go to stderr: they are advice to the operator, not the packet.
	for (const gap of body.gaps ?? []) process.stderr.write(`[substrate] ${gap}\n`);
}

/**
 * `substrate evidence --graph ut-… [--format json|html] [--out PATH]`
 *
 * The bundle is composed by `substrate-mcp`, not here: it is the process holding the
 * metric snapshot and the audit chain, and a second composer would be a second
 * answer to the same question. This command asks for it and puts it somewhere.
 *
 * A stub, deliberately — the bundle says so in its own `pending` list.
 */
async function cmdEvidence(args: Record<string, string | true>): Promise<number> {
	const graphId = str(args.graph);
	if (!graphId) {
		process.stderr.write("usage: substrate evidence --graph <graph_id> [--format json|html] [--out PATH]\n");
		return 2;
	}
	const format = str(args.format) ?? (str(args.out)?.endsWith(".html") ? "html" : "json");
	if (format !== "json" && format !== "html") {
		process.stderr.write(`[substrate] unknown --format ${format}; expected json or html\n`);
		return 2;
	}

	// The bundle is always fetched as JSON, whatever is being written out, and the HTML
	// is rendered from that same bundle here. Asking the server for HTML gave a document
	// this command could not read, so `--format html` skipped the chain and SLO checks
	// entirely and exited 0 over a broken chain. Asking twice would be worse: the two
	// bundles are taken at different instants, so the verdict could describe numbers the
	// document does not contain.
	const response = await post("/evidence", { graph_id: graphId, format: "json" });
	if (!response) {
		process.stderr.write(`[substrate] unreachable at ${base()}; evidence needs a running substrate-mcp\n`);
		return 1;
	}
	const body = await response.text();
	if (!response.ok) {
		process.stderr.write(`[substrate] evidence failed (${response.status}): ${body.slice(0, 300)}\n`);
		return 1;
	}

	let bundle: EvidenceBundle;
	try {
		bundle = JSON.parse(body) as EvidenceBundle;
	} catch {
		process.stderr.write("[substrate] evidence was not valid JSON\n");
		return 1;
	}

	// Rendering is not composing: the bundle is the answer, and this only presents it.
	// `substrate-mcp` remains the only thing that decides what is in it.
	const document = format === "html" ? renderEvidenceHtml(bundle) : JSON.stringify(bundle, null, 2);

	const out = str(args.out);
	if (out) {
		try {
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, document.endsWith("\n") ? document : `${document}\n`);
			process.stderr.write(`[substrate] wrote ${out}\n`);
		} catch (cause) {
			process.stderr.write(`[substrate] could not write ${out}: ${String(cause)}\n`);
			return 1;
		}
	} else {
		process.stdout.write(`${document}\n`);
	}

	// Non-zero when the evidence itself says something is wrong, so this composes in a
	// script: a bundle whose chain is broken or whose objective is breached should not
	// read as a clean run just because the request succeeded. Checked for both formats —
	// the document that reports a broken chain must not exit 0 because it is HTML.
	//
	// **A chain that could not be verified counts.** The contract for this command is
	// non-zero on an unreachable substrate, a chain that does not verify, or a breached
	// objective — and "does not verify" covers a chain the ledger would not answer for,
	// not only one that came back broken. It used to check `ok === false` alone, so a
	// Greptime outage produced a bundle whose app chain was `unknown` and an exit status
	// of 0 as long as no objective happened to be breached: a caller that trusted the
	// status shipped an unverified document as a verified one. `not-configured` is the
	// one state that is not a failure — a deployment with no ledger has no app chain to
	// verify, and saying so is the honest answer rather than an error.
	const chains = [
		{ name: "Greptime app events", chain: bundle.chains?.app_events },
		{ name: "MCP audit", chain: bundle.chains?.mcp_audit },
	];
	for (const { name, chain } of chains) {
		if (!chain) continue;
		const state = chainStateOf(chain);
		if (state === "broken") {
			process.stderr.write(`[substrate] the ${name} chain for ${graphId} does not verify: ${chain.reason ?? "broken"}\n`);
			return 1;
		}
		if (state === "unverifiable") {
			process.stderr.write(
				`[substrate] the ${name} chain for ${graphId} could not be verified: ${chain.reason ?? "no reason given"}\n` +
					"[substrate] the bundle was written, but it does not attest to that chain\n",
			);
			return 1;
		}
	}
	// A bundle labelled for one graph whose audit decisions may be another's is not
	// evidence about that graph, however complete it looks. Two identifiers that clean to
	// the same stored string are indistinguishable once stored, so nothing downstream can
	// separate them — which makes this the same kind of answer as a chain that could not be
	// verified, and it gets the same exit status.
	if (bundle.audit?.attribution === "ambiguous") {
		process.stderr.write(
			`[substrate] the audit decisions for ${graphId} cannot be attributed to it alone: its identifier is stored in a ` +
				"cleaned form, and another graph cleaning to the same string would share this selection\n" +
				"[substrate] the bundle was written, but its audit tally is not this graph's alone\n",
		);
		return 1;
	}
	// An hour devnet could not confirm fails closed (D41-5): the bundle is written with that hour
	// marked `unverified`, and this command exits non-zero. A `pending` hour is not a failure.
	const unverified = (bundle.anchors ?? []).filter((anchor) => anchor.status === "unverified");
	if (unverified.length > 0) {
		process.stderr.write(
			`[substrate] ${unverified.length} hour${unverified.length === 1 ? "" : "s"} of ${graphId} could not be verified against devnet: ` +
				`${unverified.map((anchor) => anchor.period_start).join(", ")}\n` +
				"[substrate] the bundle was written, but it does not attest to those hours\n",
		);
		return 1;
	}
	if ((bundle.slo_summary?.breached ?? 0) > 0) {
		process.stderr.write(`[substrate] ${bundle.slo_summary.breached} SLO(s) breached for ${graphId}\n`);
		return 1;
	}
	return 0;
}

/**
 * `substrate index sweep [--apply] [--json]`
 *
 * Runs `packages/mcp-server/src/index-sweep-run.ts` from this checkout (or the
 * pinned release the CLI is installed in) with the operator's environment, so the
 * one job the timer runs is the one the operator runs by hand. Without `--apply`
 * the runner is told `--dry-run` explicitly: an environment that happens to carry
 * `SUBSTRATE_INDEX_SWEEP=apply` must not delete because someone asked for a
 * report. With `--apply`, the runner refuses unless that env is also `apply` —
 * two keys to delete — and the refusal comes back as exit 2 with its reason.
 * The CLI package does not depend on the server package, which is why this is a
 * spawn and not an import.
 */
function cmdIndex(argv: string[], args: Record<string, string | true>): number {
	if ((INDEX_ARCHIVE_SUBCOMMANDS as readonly string[]).includes(argv[0] ?? "")) {
		// uplift-4 S2: the same spawn-the-runner shape, for the verified index archive.
		const archiveRunner = join(import.meta.dir, "..", "..", "mcp-server", "src", "index-run.ts");
		return runIndexArchive(argv, args, {
			spawn: (runnerArgs) => spawnSync(process.execPath, [archiveRunner, ...runnerArgs], { stdio: "inherit", env: process.env }).status ?? 1,
			err: (text) => process.stderr.write(text),
			env: process.env,
		});
	}
	if (argv[0] !== "sweep") {
		process.stderr.write(`usage: substrate index sweep [--apply] [--json]\n${INDEX_ARCHIVE_USAGE}`);
		return 2;
	}
	const runner = join(import.meta.dir, "..", "..", "mcp-server", "src", "index-sweep-run.ts");
	const flags = [args.apply === true ? "--apply" : "--dry-run", ...(args.json === true ? ["--json"] : [])];
	const result = spawnSync(process.execPath, [runner, ...flags], { stdio: "inherit", env: process.env });
	return result.status ?? 1;
}

/**
 * `substrate ledger …` — the same spawn-the-runner shape as `index sweep`, for
 * the same reason: the ledger client and its credentials live in the server
 * package only. The grammar check and the exit code are `runLedger`'s.
 */
function cmdLedger(argv: string[], args: Record<string, string | true>): number {
	const runner = join(import.meta.dir, "..", "..", "mcp-server", "src", "ledger-run.ts");
	return runLedger(argv, args, {
		spawn: (runnerArgs) => spawnSync(process.execPath, [runner, ...runnerArgs], { stdio: "inherit", env: process.env }).status ?? 1,
		err: (text) => process.stderr.write(text),
	});
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
	case "drift":
		process.exit(await cmdDrift(args));
	case "handoff":
		await cmdHandoff(args);
		process.exit(0);
	case "evidence":
		process.exit(await cmdEvidence(args));
	case "lessons":
		process.exit(
			await runLessons(rest, {
				memory: httpMemory({
					url: base(),
					token: resolveBearer("claude-code", process.env) ?? undefined,
					timeoutMs: lessonsTimeout(process.env.SUBSTRATE_TIMEOUT_MS),
				}),
				repo: repoSlug(),
				root: git(["rev-parse", "--show-toplevel"]) || process.cwd(),
				cwd: process.cwd(),
				now: () => new Date(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
	case "skills":
		process.exit(
			await runSkills(rest, {
				url: base(),
				token: process.env.SUBSTRATE_TOKEN?.trim() || undefined,
				timeoutMs: skillsTimeout(process.env.SUBSTRATE_SKILLS_TIMEOUT_MS),
				cwd: process.cwd(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
	case "docs":
		process.exit(
			await runDocs(rest, {
				url: base(),
				token: resolveBearer("claude-code", process.env) ?? undefined,
				timeoutMs: docsTimeout(process.env.SUBSTRATE_DOCS_TIMEOUT_MS),
				cwd: process.cwd(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
				vmGuest: (process.env.SUBSTRATE_VM_GUEST?.trim() ?? "") === "1",
			}),
		);
	case "index":
		process.exit(cmdIndex(rest, args));
	case "ledger":
		process.exit(cmdLedger(rest, args));
	case "spool":
		process.exit(
			await runSpool(rest, {
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
	default:
		process.stdout.write(
			"substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]\n" +
				"substrate emit --kind K --summary S [--repo R] [--session I] [--graph G] [--payload JSON]\n" +
				"substrate run <surface> [args...]\n" +
				"substrate verify <graph_id>\n" +
				"substrate drift [--repo R] [--path P] [--idle SECONDS] [--json]\n" +
				"substrate handoff --to S --goal G [--files a,b] [--dod 'x;y'] [--blockers 'z']\n" +
				"                  [--graph G] [--node N] [--lease L] [--release] [--session I]\n" +
				"substrate evidence --graph <graph_id> [--format json|html] [--out PATH]\n" +
				"substrate lessons add|ingest|recall|digest|outcome ...   (substrate lessons help)\n" +
				"substrate skills propose --dir PATH [--name N] [--rationale R] [--remove a,b] [--session I] [--graph G]\n" +
				"                         [--dry-run] [--replace] [--reopen] [--allow-doc-examples pem,jwt]\n" +
				"substrate skills list [--state approved|proposed|declined|retired|all]\n" +
				"substrate skills approve --name N --pr NUMBER --decision approve|decline|retire [--reason R]\n" +
				"substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]\n" +
				"substrate index sweep [--apply] [--json]   (--apply also needs SUBSTRATE_INDEX_SWEEP=apply)\n" +
				"substrate index archive [--out DIR] [--page-size N] | verify-archive <dir> | restore --scratch URL <dir>\n" +
				"substrate ledger coverage [--json] | archive [--until D] [--out DIR] [--page-size N] | verify-archive <dir> [--day D]\n" +
				"substrate spool status [--json] | flush [--json] [--budget-ms N]   (the event spool needs SUBSTRATE_EVENT_SPOOL=on)\n",
		);
		process.exit(command ? 2 : 0);
}
