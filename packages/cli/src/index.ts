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
 *   substrate evidence --graph G [--node N]  the evidence bundle, as JSON or HTML; --node adds that node's artifact (JSON)
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
 *   substrate session checkpoint|checkpoints|rollback|recover|sync   session checkpoints and rollback
 *       (exit 0 done, 1 failed, 2 usage, 3 refused, 4 files restored but the ledger commit is pending)
 *   substrate steer open|heartbeat|close|sessions|status|queue|ack|list|listen|context   Live Steering from a terminal (docs/live-steering.md)
 *       (exit 0 done, 1 failed, 2 usage, 3 refused by the server: not an operator, rate limited, bad token)
 *   substrate corpus scan|plan|ingest|reflect|status|sync|watch|reconcile|hook|hint   the documentation corpus of every repository (docs/corpus.md, docs/corpus-watch.md, docs/corpus-reflect.md)
 *       (exit 0 done, 1 failed, 2 usage; ingest, reflect, sync and reconcile are dry runs until --execute; status --gaps lists unanswered queries)
 *   substrate consistency verify [--json] [--bank B] [--limit N] [--since ISO] [--repair --server-stopped [--repair-orphans]]
 *       the memory consistency verifier: the index, the plane and the ledger compared
 *       (exit 0 consistent, 1 drift, 2 usage, 3 a store could not be read; docs/runbooks/consistency-verify.md)
 *   substrate memory capsule export|verify|redact ...   memory capsules (docs/runbooks/memory-capsules.md)
 *       (exit 0 done, 1 failed or incomplete, 2 usage, 3 verify --anchors could not finish)
 *   substrate worktree list|status|scan|prune|conflicts|provision|disk|guard   the worktree fleet (docs/worktree-fleet.md)
 *       (exit 0 done, 1 a removal, report or creation failed, 2 usage or no worktree root configured)
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
import { driftExitCode, parseEmitPayload, parseEvidenceBundle } from "./guards.ts";
import { resolveBearer } from "./token.ts";
import { docsTimeout, runDocs } from "./docs.ts";
import { httpMemory, lessonsTimeout, runLessons } from "./lessons.ts";
import { runSkills, skillsTimeout } from "./skills.ts";
import { runLedger } from "./ledger.ts";
import { freeBytes, spawnGh, spawnGit } from "../../fleet/src/index.ts";
import { httpClaimsLookup, httpReportPoster, runWorktree } from "./worktree/command.ts";
import { runSpool } from "./spool.ts";
import { spoolConfig } from "../../collectors/src/spool.ts";
import { runSession } from "./session/command.ts";
import { runSteer } from "./steer/index.ts";
import { CORPUS_TIMEOUT_MS, runCorpus } from "./corpus/index.ts";
import { localGitPermitted } from "./corpus/scope.ts";
import type { TranscriptPort } from "./session/rollback.ts";
import { runConsistency } from "./consistency.ts";
import { httpCapsuleMcp, nodeCapsuleFs, runMemory } from "./capsule.ts";
import { createTranscriptPort, resolveOmpSessionsDir } from "./session/transcript-port.ts";
import { LocalBlobStore } from "../../mcp-server/src/blob-store.ts";
import { postEvent as emitEvent } from "../../collectors/src/emit.ts";
import { INDEX_ARCHIVE_SUBCOMMANDS, INDEX_ARCHIVE_USAGE, runIndexArchive } from "./index-archive.ts";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;
/** Added to the verify budget for `/evidence`: the server builds the bundle after its hour loop, outside that budget. */
const EVIDENCE_RESPONSE_MARGIN_MS = 5_000;
/** A worktree report holds up to 500 rows per request, so it gets more time than a hook-sized call. */
const WORKTREE_REPORT_TIMEOUT_MS = 10_000;
/** A claims lookup answers from one index read, but prune waits on it before every removal, so it gets more than a hook's budget. */
const WORKTREE_CLAIMS_TIMEOUT_MS = 5_000;

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

/**
 * The whole-verify budget (D28-18), read as the server reads `SUBSTRATE_VERIFY_TIMEOUT_MS`. The hour
 * loop of `/verify` and `/evidence` runs under it, so a client that waits less gives up on a report
 * the server is still building.
 */
function verifyBudgetMs(): number {
	const raw = Number(process.env.SUBSTRATE_VERIFY_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function timeout(): number {
	const raw = Number(process.env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Reads git in `cwd` only when the registry permits it (phase 72): an unset registry reads as before; a set one reads only a
 * registered checkout the local surface is granted. An unregistered checkout yields "", as a checkout with no git would.
 */
function git(args: string[], cwd = process.cwd()): string {
	if (!localGitPermitted(process.env, cwd)) return "";
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
		const parsed = parseEmitPayload(rawPayload);
		if (parsed.kind === "ok") {
			payload = parsed.payload;
		} else if (parsed.kind === "invalid-json") {
			process.stderr.write("[substrate] --payload is not valid JSON; dropping it\n");
		} else {
			process.stderr.write("[substrate] --payload is not a JSON object; dropping it\n");
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
	const budgetMs = verifyBudgetMs();
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
		hours?: Array<{ period_start: string; status: string; tx_sig?: string; reason?: string; pointer?: "verified" | "failed" | "absent" }>;
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
		// Each hour line names its pointer status, so an hour the chain names through no pointer is visible as such (design 5).
		const pointer = hour.pointer === undefined ? "" : ` [pointer ${hour.pointer}]`;
		if (hour.status === "anchored") {
			process.stdout.write(`${hour.period_start} anchored ${hour.tx_sig ?? ""}${pointer}\n`);
		} else if (hour.status === "pending") {
			process.stdout.write(`${hour.period_start} pending${pointer}\n`);
		} else if (hour.status === "mismatch") {
			process.stdout.write(`hour ${hour.period_start} does not match its anchor: ${hour.reason ?? "mismatch"}${pointer}\n`);
		} else if (hour.status === "unverified") {
			process.stderr.write(`[substrate] verify could not check devnet for ${hour.period_start}: ${hour.reason ?? "unreadable"}\n`);
		} else {
			process.stdout.write(`${hour.period_start} ${hour.status}${hour.reason ? `: ${hour.reason}` : ""}${pointer}\n`);
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
		return driftExitCode(body);
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
 * `substrate evidence --graph ut-… [--node N] [--format json|html] [--out PATH]`
 *
 * The bundle is composed by `substrate-mcp`, not here: it is the process holding the
 * metric snapshot and the audit chain, and a second composer would be a second
 * answer to the same question. This command asks for it and puts it somewhere.
 *
 * With `--node N` the server also answers with that node's artifact (claim, Linear, Notion and
 * Definition-of-Done steps) as the `node` member of the JSON document.
 *
 * A stub, deliberately — the bundle says so in its own `pending` list.
 */
async function cmdEvidence(args: Record<string, string | true>): Promise<number> {
	const usage = "usage: substrate evidence --graph <graph_id> [--node <node_id>] [--format json|html] [--out PATH]\n";
	const graphId = str(args.graph);
	if (!graphId) {
		process.stderr.write(usage);
		return 2;
	}
	// `--node` with no value (the flag alone, or an empty string) names no node: a typo, not "every node".
	const nodeRequested = args.node !== undefined;
	const nodeId = str(args.node);
	if (nodeRequested && !nodeId) {
		process.stderr.write(usage);
		return 2;
	}
	const format = str(args.format) ?? (str(args.out)?.endsWith(".html") ? "html" : "json");
	if (format !== "json" && format !== "html") {
		process.stderr.write(`[substrate] unknown --format ${format}; expected json or html\n`);
		return 2;
	}
	// The HTML is rendered here from the bundle, and the bundle type has no node member, so the node
	// artifact would be silently dropped. Say so instead.
	if (nodeId && format === "html") {
		process.stderr.write("[substrate] --node cannot be combined with --format html: the node artifact is part of the JSON document only\n");
		return 2;
	}

	// The bundle is always fetched as JSON, whatever is being written out, and the HTML
	// is rendered from that same bundle here. Asking the server for HTML gave a document
	// this command could not read, so `--format html` skipped the chain and SLO checks
	// entirely and exited 0 over a broken chain. Asking twice would be worse: the two
	// bundles are taken at different instants, so the verdict could describe numbers the
	// document does not contain.
	// `/evidence` runs the same hour loop as `/verify`, so it waits out the same whole-verify budget,
	// plus a margin for the reads the server makes after that loop (teachables, audit) and the response.
	const request: Record<string, string> = { graph_id: graphId, format: "json" };
	if (nodeId) request.node_id = nodeId;
	const response = await post("/evidence", request, "claude-code", verifyBudgetMs() + EVIDENCE_RESPONSE_MARGIN_MS);
	if (!response) {
		process.stderr.write(`[substrate] unreachable at ${base()}; evidence needs a running substrate-mcp\n`);
		return 1;
	}
	const body = await response.text();
	if (!response.ok) {
		process.stderr.write(`[substrate] evidence failed (${response.status}): ${body.slice(0, 300)}\n`);
		return 1;
	}

	const parsed = parseEvidenceBundle(body);
	if (!parsed.ok) {
		process.stderr.write(
			parsed.reason === "invalid-json"
				? "[substrate] evidence was not valid JSON\n"
				: `[substrate] evidence is not an evidence bundle: ${parsed.detail}\n`,
		);
		return 1;
	}
	const bundle: EvidenceBundle = parsed.bundle;

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

	// A requested artifact that could not be built is a failure, like a broken chain, but only after the
	// document is out: it still carries the bundle and the server's `node: { error }` answer. The remaining
	// checks still run so their findings are reported too.
	let nodeFailed = false;
	if (nodeId) {
		if (parsed.node === undefined) {
			process.stderr.write(`[substrate] node ${nodeId}: the server answered without a node artifact\n`);
			nodeFailed = true;
		} else if ("error" in parsed.node) {
			process.stderr.write(`[substrate] node ${nodeId}: ${parsed.node.error}\n`);
			nodeFailed = true;
		}
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
	return nodeFailed ? 1 : 0;
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

/**
 * `substrate consistency verify …` — the same spawn-the-runner shape as `ledger`: the index, plane and ledger
 * credentials live in the server package only. The grammar check and the exit-code mapping are `runConsistency`'s.
 */
function cmdConsistency(argv: string[]): number {
	const runner = join(import.meta.dir, "..", "..", "mcp-server", "src", "consistency-run.ts");
	return runConsistency(argv, {
		// A runner that ended on a signal has no status; -1 is not an exit code `runConsistency` passes through.
		spawn: (runnerArgs) => spawnSync(process.execPath, [runner, ...runnerArgs], { stdio: "inherit", env: process.env }).status ?? -1,
		err: (text) => process.stderr.write(text),
	});
}

/**
 * The transcript adapter for `substrate session rollback`: omp gets a forked session file, every other surface a
 * marker. All file access is the real filesystem here and nowhere else; the port itself is injected with it.
 * Built on the first rewind, so `checkpoint`, `checkpoints`, `recover` and `sync` never look for an omp bucket.
 */
function transcriptPort(surface: string): TranscriptPort {
	return {
		rewind: (request) => {
			const home = homedir();
			// omp's default sessions root; an omp started with another profile or agent directory keeps its sessions elsewhere,
			// which is reported as `unsupported` (the bucket is not found), never guessed.
			const ompSessionsDir = resolveOmpSessionsDir({
				candidates: [process.cwd(), git(["rev-parse", "--show-toplevel"])],
				homeDir: home,
				tmpRoot: tmpdir(),
				sessionsRoot: join(home, ".omp", "agent", "sessions"),
				realpath: (path) => realpathSync(path),
				isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
			});
			return createTranscriptPort({
				surface,
				...(ompSessionsDir === undefined ? {} : { ompSessionsDir }),
				listDir: (dir) => readdir(dir),
				readFile: async (path, maxBytes) => {
					const info = await stat(path);
					if (info.size > maxBytes) throw new Error(`the file is ${info.size} bytes; the limit is ${maxBytes}`);
					return readFile(path, "utf8");
				},
				writeFile: (path, text, options) => writeFile(path, text, options),
				now: () => new Date(),
				newSessionId: () => crypto.randomUUID(),
			}).rewind(request);
		},
	};
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
	case "brief":
		await cmdBrief(args);
		process.exit(0);
		break;
	case "emit":
		await cmdEmit(args);
		process.exit(0);
		break;
	case "run":
		process.exit(await cmdRun(rest));
		break;
	case "verify":
		process.exit(await cmdVerify(rest[0]));
		break;
	case "drift":
		process.exit(await cmdDrift(args));
		break;
	case "handoff":
		await cmdHandoff(args);
		process.exit(0);
		break;
	case "evidence":
		process.exit(await cmdEvidence(args));
		break;
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
		break;
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
		break;
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
		break;
	case "index":
		process.exit(cmdIndex(rest, args));
		break;
	case "worktree":
		process.exit(
			await runWorktree(rest, {
				env: process.env,
				cwd: process.cwd(),
				host: hostname(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
				git: spawnGit,
				gh: spawnGh,
				now: () => new Date(),
				freeBytes,
				emit: (event) => emitEvent(event, { timeoutMs: timeout(), collector: "cli", source: "cli.worktree", url: base() }),
				postReport: httpReportPoster({
					url: base(),
					token: resolveBearer("claude-code", process.env) ?? undefined,
					// A report can hold hundreds of rows; the hook-sized default budget is too short for it.
					timeoutMs: Math.max(timeout(), WORKTREE_REPORT_TIMEOUT_MS),
				}),
				claims: httpClaimsLookup({
					url: base(),
					token: resolveBearer("claude-code", process.env) ?? undefined,
					timeoutMs: Math.max(timeout(), WORKTREE_CLAIMS_TIMEOUT_MS),
				}),
			}),
		);
		break;
	case "ledger":
		process.exit(cmdLedger(rest, args));
		break;
	case "spool":
		process.exit(
			await runSpool(rest, {
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
		break;
	case "consistency":
		process.exit(cmdConsistency(rest));
		break;
	case "memory":
		process.exit(
			await runMemory(rest, {
				mcpFor: (surface) =>
					httpCapsuleMcp({ url: base(), token: resolveBearer(surface, process.env) ?? undefined, timeoutMs: lessonsTimeout(process.env.SUBSTRATE_TIMEOUT_MS) }),
				fs: nodeCapsuleFs(),
				openStore: (dir) => new LocalBlobStore(dir),
				emit: (event) => emitEvent(event, { timeoutMs: timeout(), collector: "cli", source: "cli.memory-capsule", url: base(), ...(event.idempotency_key === undefined ? {} : { idempotencyKey: event.idempotency_key }) }),
				now: () => new Date(),
				cwd: process.cwd(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
		break;
	case "session":
		process.exit(
			await runSession(rest, {
				worktree: git(["rev-parse", "--show-toplevel"]) || process.cwd(),
				url: base(),
				tokenFor: (surface) => resolveBearer(surface, process.env) ?? undefined,
				timeoutMs: timeout(),
				now: () => new Date(),
				randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
				// The surface is the command's own `--surface` (default claude-code), the same default `runSession` applies.
				transcript: transcriptPort(str(args.surface) ?? "claude-code"),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
			}),
		);
		break;
	case "steer": {
		// SIGINT ends `steer listen` cleanly (exit 0); an in-flight long poll is aborted with it.
		const interrupt = new AbortController();
		process.once("SIGINT", () => interrupt.abort());
		process.exit(
			await runSteer(rest, {
				url: base(),
				tokenFor: (surface) => resolveBearer(surface, process.env) ?? undefined,
				timeoutMs: Math.max(timeout(), 5_000),
				now: () => new Date(),
				repo: () => repoSlug(),
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
				signalFor: (ms) => AbortSignal.any([AbortSignal.timeout(ms), interrupt.signal]),
				interrupt: interrupt.signal,
			}),
		);
		break;
	}
	case "corpus":
		process.exit(
			await runCorpus(rest, {
				url: base(),
				token: resolveBearer("claude-code", process.env) ?? undefined,
				timeoutMs: CORPUS_TIMEOUT_MS,
				env: process.env,
				out: (text) => process.stdout.write(text),
				err: (text) => process.stderr.write(text),
				audit: (event) => emitEvent(event, { timeoutMs: timeout(), collector: "cli", source: "cli.corpus", url: base() }),
			}),
		);
		break;
	default:
		process.stdout.write(
			"substrate brief [--repo R] [--branch B] [--graph G] [--surface S] [--write]\n" +
				"substrate emit --kind K --summary S [--repo R] [--session I] [--graph G] [--payload JSON]\n" +
				"substrate run <surface> [args...]\n" +
				"substrate verify <graph_id>\n" +
				"substrate drift [--repo R] [--path P] [--idle SECONDS] [--json]\n" +
				"substrate handoff --to S --goal G [--files a,b] [--dod 'x;y'] [--blockers 'z']\n" +
				"                  [--graph G] [--node N] [--lease L] [--release] [--session I]\n" +
				"substrate evidence --graph <graph_id> [--node <node_id>] [--format json|html] [--out PATH]\n" +
				"substrate lessons add|ingest|recall|digest|outcome ...   (substrate lessons help)\n" +
				"substrate skills propose --dir PATH [--name N] [--rationale R] [--remove a,b] [--session I] [--graph G]\n" +
				"                         [--dry-run] [--replace] [--reopen] [--allow-doc-examples pem,jwt]\n" +
				"substrate skills list [--state approved|proposed|declined|retired|all]\n" +
				"substrate skills approve --name N --pr NUMBER --decision approve|decline|retire [--reason R]\n" +
				"substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]\n" +
				"substrate index sweep [--apply] [--json]   (--apply also needs SUBSTRATE_INDEX_SWEEP=apply)\n" +
				"substrate index archive [--out DIR] [--page-size N] | verify-archive <dir> | restore --scratch URL <dir>\n" +
				"substrate ledger coverage [--json] | archive [--until D] [--out DIR] [--page-size N] | verify-archive <dir> [--day D]\n" +
				"substrate session checkpoint | checkpoints | rollback <ckpt|seq|previous> | recover | sync   (substrate session for the flags)\n" +
				"substrate steer open --repo R | heartbeat --session ID | close --session ID | sessions | status | queue --session ID --action A --body T | ack DIRECTIVE --applied|--declined | list --session ID | listen --session ID [--once] | context   (private commands use --binding-file PATH; substrate steer for all flags; exit 0 done, 1 failed, 2 usage, 3 refused)\n" +
				"substrate consistency verify [--json] [--bank B] [--limit N] [--since ISO] [--repair --server-stopped [--repair-orphans]]   (exit 0 consistent, 1 drift, 2 usage, 3 unreadable store)\n" +
				"substrate memory capsule export --out FILE [--session S] [--repo R] [--since ISO] [--limit N] [--store DIR]\n" +
				"                         | verify FILE [--anchors] | redact FILE --ids a,b --reason TEXT --out FILE2   (substrate memory capsule for the flags)\n" +
				"substrate spool status [--json] | flush [--json] [--budget-ms N]   (the event spool needs SUBSTRATE_EVENT_SPOOL=on)\n" +
				"substrate worktree list|status|scan|prune|conflicts|provision|disk|guard ...   (substrate worktree --help; roots from SUBSTRATE_WORKTREE_ROOTS)\n" +
				"substrate corpus scan | plan | ingest [--execute] | reflect [--execute] | status [--gaps] | sync [--repo R] [--execute] | watch [--once] | reconcile [--execute] | prove | verify | hook install|uninstall|status --repo DIR | hint --repo DIR\n" +
				"                  (substrate corpus --help for the flags; ingest, reflect, sync and reconcile are dry runs without --execute)\n",
		);
		process.exit(command ? 2 : 0);
}
