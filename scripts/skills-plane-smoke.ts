#!/usr/bin/env bun
/**
 * Isolated end-to-end proof of the whole skills plane (SKILL-02, SKILL-03), against a rehearsal
 * twin started with `--skills-fixture`.
 *
 *   bun run rehearsal up --name p22 --skills-fixture --surfaces hermes,omp,grok-build,substrate
 *   set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p22/consumer.env"; set +a
 *   bun run smoke:skills-plane
 *   bun run rehearsal down --name p22
 *
 * It sources only `consumer.env` and keeps the harness's guards: it refuses the production port
 * and any host that is not loopback, before any request. Everything it stages lives in a throwaway
 * directory under the OS temp dir; the only repository it touches is the fixture's throwaway bare
 * library, and `gh` is the fixture's recording script. Nothing here can reach the live library,
 * the live queues, the live state or the production port. It proves, over the real server, the
 * bridge's tick and the sync's tick:
 *
 *   a. one staged Hermes pending record, one Omp queue file and one Grok queue file, all older
 *      than the quiet window, survive `bridge --once --dry-run` untouched (no delete, no move,
 *      no hold) and then become three fixture PRs on `skill/hermes/...`, `skill/omp/...` and
 *      `skill/grok-build/...` under `bridge --once`, with all three records removed
 *   b. a fresh record younger than the quiet window is kept by the tick
 *   c. fast-forwarding the fixture's `main` to one branch (the owner's merge), cloning it as a
 *      scratch library and running the sync projects the skill links into scratch roots
 *
 * The bridge's CLI entry has no path seams (its defaults are the live queues), so the smoke
 * drives the same two functions the CLI calls — `run_once` and `drain_queue` — through a small
 * driver written to the scratch directory at run time, with every path pointed at scratch. The
 * sync is driven in-process through its context seams. Exit 0 when every check passes, 1 on a
 * failure, 2 when the twin is not a skills-fixture one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refuseSmokeUrl } from "./rehearsal.ts";
import { branchPattern, skillMd } from "./skills-propose-smoke.ts";
import { defaultOptions, postWarning, project } from "../packages/projector/src/skills.ts";
import { execFileRunner, runSync } from "../packages/projector/src/skills-sync.ts";

/** Surfaces the bridge drains, one token each; the rehearsal run must mint all four. */
const BRIDGE_SURFACES = ["hermes", "omp", "grok-build"] as const;
/** Every token file the run directory must hold for this proof. */
const NEEDED_TOKENS = ["hermes", "omp", "grok-build", "substrate"] as const;
/** The quiet window the bridge waits out, in seconds (mirrors the bridge's own constant). */
const QUIET_S = 120;
/** How far back staged records are aged so the tick settles them. */
const AGED_S = 180;

// ── pure helpers (unit-tested in skills-plane-smoke.test.ts) ─────────────────

/**
 * Why this environment cannot run the proof, or null when it can. Refuses a production target
 * (port or non-loopback host), a twin without the skills fixture, and a run directory missing
 * any of the four surface tokens — before any request and before any staging.
 */
export function preflight(env: Record<string, string | undefined>): string | null {
	const base = (env.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
	if (!base) return "SUBSTRATE_URL is not set: source the instance's consumer.env first";
	const refused = refuseSmokeUrl(base);
	if (refused !== null) return refused;
	const need = [
		"SUBSTRATE_REHEARSAL_SKILLS_STATE",
		"SUBSTRATE_REHEARSAL_SKILLS_ORIGIN",
		"SUBSTRATE_REHEARSAL_SKILLS_GH_STATE",
		"SUBSTRATE_REHEARSAL_SKILLS_REPO",
		"SUBSTRATE_REHEARSAL_TOKENS_DIR",
	];
	const missing = need.filter((key) => !env[key]);
	if (missing.length > 0) return `this twin has no skills fixture (${missing.join(", ")} unset): rehearsal up --skills-fixture`;
	const tokensDir = env.SUBSTRATE_REHEARSAL_TOKENS_DIR as string;
	const absent = NEEDED_TOKENS.filter((surface) => !existsSync(join(tokensDir, surface)));
	if (absent.length > 0)
		return `the run directory holds no token for ${absent.join(", ")}: rehearsal up --surfaces hermes,omp,grok-build,substrate`;
	return null;
}

/** One `[skills-bridge:dry-run]` line, as the bridge prints it in dry-run mode. */
export interface DryRunLine {
	name: string;
	surface: string;
	classification: string;
	records: string[];
	reply: string;
}

export function parseDryRunLine(line: string): DryRunLine | null {
	const match = /^\[skills-bridge:dry-run\] name=(\S+) surface=(\S+) classification=(\S+) records=(\S*) reply=(\S+)\s*$/.exec(
		line.trim(),
	);
	if (!match) return null;
	return {
		name: match[1] as string,
		surface: match[2] as string,
		classification: match[3] as string,
		records: (match[4] as string).split(",").filter(Boolean),
		reply: match[5] as string,
	};
}

// ── the Python driver (written to scratch at run time; every path arrives in its args) ───────

const DRIVER_PY = `"""Drive one bridge tick with scratch seams: the same run_once/drain_queue the CLI calls."""
import json
import os
import sys

sys.path.insert(0, os.environ["SUBSTRATE_MINER_SRC"])

from substrate_miner import bridge
from substrate_miner import token as token_module


def summarize(result) -> dict:
    return {
        "ok": result.ok,
        "proposed": result.proposed,
        "rejected": result.rejected,
        "held": result.held,
        "kept": result.kept,
        "waiting": result.waiting,
    }


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as handle:
        args = json.load(handle)
    refused = token_module.single_token_refusal(os.environ)
    if refused is not None:
        print(json.dumps({"ok": False, "refused": refused}))
        return 3
    tokens = bridge.resolve_surface_tokens(tuple(args["surfaces"]), os.environ)
    with bridge.ProposeClient(args["url"], tokens=tokens) as client:
        tick = bridge.run_once(
            client,
            pending_dir=args["pending_dir"],
            library=args["library_dir"],
            hermes_skills=args["hermes_skills_dir"],
            log_path=args["log_path"],
            held_path=args["held_path"],
            surface="hermes",
            dry_run=args["dry_run"],
        )
        omp = bridge.drain_queue(args["omp_dir"], "omp", client, log_path=args["log_path"], dry_run=args["dry_run"])
        grok = bridge.drain_queue(
            args["grok_dir"], "grok-build", client, log_path=args["log_path"], dry_run=args["dry_run"]
        )
    with open(args["result_path"], "w", encoding="utf-8") as handle:
        json.dump({"tick": summarize(tick), "omp": summarize(omp), "grok": summarize(grok)}, handle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

// ── the proof ─────────────────────────────────────────────────────────────────

interface TickCounts {
	ok: boolean;
	proposed: number;
	rejected: number;
	held: number;
	kept: number;
	waiting: number;
}

interface TickResult {
	tick: TickCounts;
	omp: TickCounts;
	grok: TickCounts;
}

async function main(): Promise<number> {
	const env = process.env;
	const blocked = preflight(env);
	if (blocked !== null) {
		process.stderr.write(`[skills-plane-smoke] ${blocked}\n`);
		return 2;
	}
	const base = (env.SUBSTRATE_URL as string).replace(/\/+$/, "");
	const origin = env.SUBSTRATE_REHEARSAL_SKILLS_ORIGIN as string;
	const ghStatePath = env.SUBSTRATE_REHEARSAL_SKILLS_GH_STATE as string;
	const repo = env.SUBSTRATE_REHEARSAL_SKILLS_REPO as string;
	const tokensDir = env.SUBSTRATE_REHEARSAL_TOKENS_DIR as string;
	const operatorToken = env.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN || "";
	const runDir = dirname(tokensDir);

	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\nskills-plane smoke — ${new URL(base).host}, library ${repo}\n\n`);

	const tag = Math.random().toString(16).slice(2, 8);
	const scratch = mkdtempSync(join(tmpdir(), "skills-plane-"));
	const pendingDir = join(scratch, "hermes-pending");
	const ompDir = join(scratch, "omp-queue");
	const grokDir = join(scratch, "grok-queue");
	const hermesSkillsDir = join(scratch, "hermes-skills");
	const emptyLibraryDir = join(scratch, "empty-library");
	const bridgeStateDir = join(scratch, "bridge-state");
	const logPath = join(bridgeStateDir, "bridge-log.jsonl");
	const heldPath = join(bridgeStateDir, "bridge-held.json");
	for (const dir of [pendingDir, ompDir, grokDir, hermesSkillsDir, emptyLibraryDir, bridgeStateDir]) mkdirSync(dir, { recursive: true });

	const gitEnv = { PATH: env.PATH ?? "", HOME: runDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const gitOrigin = (...args: string[]): string =>
		execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8", env: gitEnv });
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
	const branches = (): string[] =>
		gitOrigin("for-each-ref", "--format=%(refname:short)", "refs/heads/skill/").split("\n").filter(Boolean).sort();
	const ghState = () => JSON.parse(readFileSync(ghStatePath, "utf8")) as { prs: Array<{ number: number; url: string; head: string; state: string }>; calls: string[][] };
	const creates = (): number => ghState().calls.filter((argv) => argv[0] === "pr" && argv[1] === "create").length;
	const snapshot = () => ({ branches: branches(), creates: creates(), prs: ghState().prs.length });
	const stagedCount = (): number =>
		readdirSync(pendingDir).length + readdirSync(ompDir).length + readdirSync(grokDir).length;

	const minerSrc = join(import.meta.dir, "..", "packages", "miner", "src");
	const driverPath = join(scratch, "bridge-driver.py");
	writeFileSync(driverPath, DRIVER_PY);
	const tick = async (dryRun: boolean): Promise<{ result: TickResult | null; lines: DryRunLine[]; raw: string }> => {
		const resultPath = join(scratch, dryRun ? "tick-dry.json" : "tick-live.json");
		const argsPath = join(scratch, dryRun ? "tick-dry-args.json" : "tick-live-args.json");
		rmSync(resultPath, { force: true });
		writeFileSync(
			argsPath,
			`${JSON.stringify({ op: "tick", dry_run: dryRun, pending_dir: pendingDir, library_dir: emptyLibraryDir, hermes_skills_dir: hermesSkillsDir, log_path: logPath, held_path: heldPath, omp_dir: ompDir, grok_dir: grokDir, surfaces: [...BRIDGE_SURFACES], url: base, result_path: resultPath }, null, 2)}\n`,
		);
		const proc = Bun.spawn(["python3", driverPath, argsPath], {
			env: {
				PATH: env.PATH ?? "",
				HOME: runDir,
				GIT_TERMINAL_PROMPT: "0",
				SUBSTRATE_URL: base,
				SUBSTRATE_TOKENS_DIR: tokensDir,
				SUBSTRATE_MINER_SRC: minerSrc,
				PYTHONDONTWRITEBYTECODE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) return { result: null, lines: [], raw: `driver exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}` };
		const lines = out.split("\n").map(parseDryRunLine).filter((line) => line !== null);
		try {
			return { result: JSON.parse(readFileSync(resultPath, "utf8")) as TickResult, lines, raw: out };
		} catch {
			return { result: null, lines, raw: "the driver left no result file" };
		}
	};

	const hermesName = `plane-hermes-${tag}`;
	const ompName = `plane-omp-${tag}`;
	const grokName = `plane-grok-${tag}`;

	try {
		// ── (a) stage three aged records ─────────────────────────────────────
		const agedAt = new Date(Date.now() - AGED_S * 1000);
		const hermesId = `p22${tag}01`;
		const hermesRecord = join(pendingDir, `${hermesId}.json`);
		writeFileSync(
			hermesRecord,
			`${JSON.stringify({ subsystem: "skills", id: hermesId, action: "create", origin: "foreground", created_at: agedAt.getTime() / 1000, summary: "smoke: staged hermes skill", payload: { action: "create", name: hermesName, content: skillMd(hermesName) } }, null, 2)}\n`,
		);
		const ompFile = join(ompDir, `${ompName}-dry.json`);
		writeFileSync(
			ompFile,
			`${JSON.stringify({ name: ompName, files: { "SKILL.md": skillMd(ompName) }, rationale: "smoke: staged omp queue", surface: "omp" }, null, 2)}\n`,
		);
		const grokFile = join(grokDir, `${grokName}-dry.json`);
		writeFileSync(
			grokFile,
			`${JSON.stringify({ name: grokName, files: { "SKILL.md": skillMd(grokName) }, rationale: "smoke: staged grok queue", surface: "grok-build" }, null, 2)}\n`,
		);
		for (const path of [hermesRecord, ompFile, grokFile]) utimesSync(path, agedAt, agedAt);
		check(stagedCount() === 3, "three aged records are staged, one per queue");

		// ── (a) dry-run: classify and post dry_run, change nothing ──────────
		const before = snapshot();
		const dry = await tick(true);
		check(dry.result !== null, "the dry-run tick runs", dry.result === null ? dry.raw : undefined);
		const dryLines = dry.lines;
		check(
			dryLines.length === 3 &&
				dryLines.some((line) => line.surface === "hermes" && line.classification === "new") &&
				dryLines.some((line) => line.surface === "omp" && line.classification === "queued") &&
				dryLines.some((line) => line.surface === "grok-build" && line.classification === "queued"),
			"the dry run classifies one new hermes skill and two queued files",
			dryLines.map((line) => `${line.surface}:${line.classification}`).join(" "),
		);
		check(
			dryLines.every((line) => line.reply === "dry_run"),
			"every dry-run proposal is answered dry_run",
			dryLines.map((line) => line.reply).join(" "),
		);
		check(stagedCount() === 3, "the dry run deletes, moves and holds nothing");
		check(!existsSync(heldPath) && !existsSync(logPath), "the dry run leaves no held state and no log");
		check(JSON.stringify(snapshot()) === JSON.stringify(before), "the dry run opens no branch and calls no gh");

		// ── (a) live: three PRs, three records gone ─────────────────────────
		const live = await tick(false);
		check(live.result !== null, "the live tick runs", live.result === null ? live.raw : undefined);
		check(
			live.result !== null && live.result.tick.proposed === 1 && live.result.omp.proposed === 1 && live.result.grok.proposed === 1,
			"the live tick proposes all three",
			live.result === null ? undefined : `hermes=${live.result.tick.proposed} omp=${live.result.omp.proposed} grok=${live.result.grok.proposed}`,
		);
		check(stagedCount() === 0, "all three records are removed");
		const after = snapshot();
		const hermesBranch = after.branches.find((branch) => branchPattern("hermes", hermesName).test(branch)) ?? "";
		const ompBranch = after.branches.find((branch) => branchPattern("omp", ompName).test(branch)) ?? "";
		const grokBranch = after.branches.find((branch) => branchPattern("grok-build", grokName).test(branch)) ?? "";
		check(hermesBranch !== "" && ompBranch !== "" && grokBranch !== "", "three branches carry the per-surface prefix", after.branches.join(" "));
		check(after.creates === before.creates + 3 && after.prs === before.prs + 3, "exactly three gh pr creates and three PRs are recorded");
		const prUrls = [hermesBranch, ompBranch, grokBranch].map(
			(branch) => ghState().prs.find((pr) => pr.head === branch)?.url ?? "",
		);
		check(
			prUrls.every((url) => url.startsWith(`https://github.com/${repo}/pull/`)) && prUrls[0] !== prUrls[1] && prUrls[0] !== prUrls[2] && prUrls[1] !== prUrls[2],
			"three distinct fixture PRs, all under the fixture library",
			prUrls.join(" "),
		);

		// ── (b) a fresh record is kept ──────────────────────────────────────
		const freshId = `p22${tag}02`;
		const freshRecord = join(pendingDir, `${freshId}.json`);
		writeFileSync(
			freshRecord,
			`${JSON.stringify({ subsystem: "skills", id: freshId, action: "create", origin: "foreground", created_at: Date.now() / 1000, summary: "smoke: fresh record", payload: { action: "create", name: `plane-fresh-${tag}`, content: skillMd(`plane-fresh-${tag}`) } }, null, 2)}\n`,
		);
		const freshQueue = join(ompDir, `plane-fresh-${tag}.json`);
		writeFileSync(
			freshQueue,
			`${JSON.stringify({ name: `plane-fresh-${tag}`, files: { "SKILL.md": skillMd(`plane-fresh-${tag}`) }, rationale: "smoke: fresh queue", surface: "omp" }, null, 2)}\n`,
		);
		const kept = await tick(false);
		check(kept.result !== null, "the quiet tick runs", kept.result === null ? kept.raw : undefined);
		const freshKept = existsSync(freshRecord) && existsSync(freshQueue);
		check(
			freshKept,
			"records younger than the quiet window are kept",
			kept.result === null ? undefined : `waiting=${kept.result.tick.waiting} queue_kept=${kept.result.omp.kept}`,
		);
		check(
			kept.result !== null && kept.result.tick.proposed === 0 && kept.result.omp.proposed === 0 && kept.result.grok.proposed === 0,
			"the quiet tick proposes nothing",
		);
		check(JSON.stringify(snapshot()) === JSON.stringify(after), "the quiet tick opens no branch and calls no gh");
		rmSync(freshRecord, { force: true });
		rmSync(freshQueue, { force: true });

		// ── (c) the owner's merge flows through the sync into links ─────────
		const libDir = join(scratch, "lib");
		execFileSync("git", ["clone", "-q", origin, libDir], { encoding: "utf8", env: gitEnv });
		check(git(libDir, "rev-parse", "--abbrev-ref", "HEAD").trim() === "main", "the scratch library is cloned on main");
		// The projector only links into roots that exist (only one root creates its own), so the
		// scratch home starts with the agent skill directories present, as on a real host.
		const homeDir = join(scratch, "home");
		const syncStateDir = join(scratch, "sync-state");
		const expectedRoots = [join(homeDir, ".claude/skills"), join(homeDir, ".grok/skills"), join(homeDir, ".agents/skills"), join(homeDir, ".config/muse/skills")];
		for (const root of expectedRoots.slice(0, 3)) mkdirSync(root, { recursive: true });
		mkdirSync(syncStateDir, { recursive: true });
		const syncEnv = { SUBSTRATE_SKILLS_LIBRARY: libDir, SUBSTRATE_SKILLS_STATE: syncStateDir };
		const runTick = async (): Promise<{ decision: string; code: number; lines: string[]; warnings: unknown[] }> => {
			const lines: string[] = [];
			const warnings: unknown[] = [];
			const sync = await runSync({
				runner: execFileRunner,
				libraryDir: libDir,
				warnStateFile: join(syncStateDir, "skills-sync-warned.json"),
				log: (line: string) => lines.push(line),
				emitWarning: async (event: unknown) => {
					warnings.push(event);
					return true;
				},
				project: () =>
					project({
						...defaultOptions({ ...syncEnv, SUBSTRATE_SKILLS_HOME: homeDir, SUBSTRATE_SKILLS_BACKUP: join(scratch, "backups") }),
						stdout: (line: string) => lines.push(line),
						emitWarning: async (event: unknown) => {
							warnings.push(event);
							return true;
						},
					}),
			});
			return { decision: sync.decision, code: sync.code, lines, warnings };
		};
		const settled = await runTick();
		check(settled.code === 0 && settled.decision === "current", "the scratch library starts current", settled.decision);
		const branchSha = gitOrigin("rev-parse", hermesBranch).trim();
		gitOrigin("update-ref", "refs/heads/main", branchSha);
		check(gitOrigin("rev-parse", "main").trim() === branchSha, "the fixture main is fast-forwarded to the hermes branch");
		const merged = await runTick();
		check(merged.code === 0 && merged.decision === "ff", "the sync fast-forwards and projects", `${merged.decision} ${merged.lines.at(-1) ?? ""}`);
		const links = expectedRoots.map((root) => join(root, hermesName));
		check(
			links.every((link) => existsSync(join(link, "SKILL.md"))),
			"the merged skill is linked into every scratch root",
			expectedRoots.map((root) => root.slice(homeDir.length)).join(" "),
		);
		const linkedMd = readFileSync(join(links[0] as string, "SKILL.md"), "utf8");
		check(linkedMd === skillMd(hermesName), "the projected link reads back the merged skill");
		check(merged.warnings.length === 0, "a successful sync is silent: no warning leaves the tick");

		// A dirty checkout posts one real warning (bearer from the token dir) and
		// the next tick the same day does not post again. A refused bearer is
		// retried: the first tick uses a token the twin will reject.
		writeFileSync(join(libDir, "DIRTY.md"), "smoke dirty checkout\n");
		const dirtyStarted = new Date().toISOString();
		const dirtyTick = async (tokenEnv: Record<string, string | undefined>) =>
			runSync({
				runner: execFileRunner,
				libraryDir: libDir,
				warnStateFile: join(syncStateDir, "skills-sync-warned.json"),
				log: () => undefined,
				emitWarning: (event) => postWarning(event, { SUBSTRATE_URL: base, ...tokenEnv }),
				project: async () => undefined,
			});
		const refused = await dirtyTick({ SUBSTRATE_TOKEN: "not-a-token" });
		const posted = await dirtyTick({ SUBSTRATE_TOKENS_DIR: tokensDir });
		const repeated = await dirtyTick({ SUBSTRATE_TOKENS_DIR: tokensDir });
		check(refused.decision === "refuse-dirty" && posted.decision === "refuse-dirty" && repeated.decision === "refuse-dirty", "a dirty checkout refuses, including after a rejected bearer", `${refused.decision}/${posted.decision}/${repeated.decision}`);

		// ── events read-back ────────────────────────────────────────────────
		if (!operatorToken) {
			check(false, "the twin names an operator token for the events read-back");
		} else {
			const queried = await fetch(`${base}/events/query`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${operatorToken}` },
				body: JSON.stringify({ limit: 200, include_payload: true }),
				signal: AbortSignal.timeout(120_000),
			});
			const body = (await queried.json()) as {
				events?: Array<{ kind: string; ts?: string; surface?: string; payload?: Record<string, unknown> }>;
			};
			const wanted = new Set([hermesName, ompName, grokName]);
			const proposals = (body.events ?? []).filter((event) => {
				const name = event.payload?.name;
				return event.payload?.action === "skill.propose" && typeof name === "string" && wanted.has(name);
			});
			const opened = proposals.filter((event) => event.kind === "note" && event.payload?.status === "opened");
			check(opened.length === 3, "the trail holds this run's three opened proposals", `${opened.length} opened of ${proposals.length} matching proposal events`);
			for (const name of wanted) {
				check(opened.filter((event) => event.payload?.name === name).length === 1, `one opened proposal for ${name}`);
			}
			const dirtyWarnings = (body.events ?? []).filter(
				(event) =>
					event.payload?.action === "skills.sync" &&
					event.payload?.reason === "dirty" &&
					typeof event.ts === "string" &&
					event.ts >= dirtyStarted,
			);
			check(dirtyWarnings.length === 1, "two dirty ticks after a refused post leave one warning", `${dirtyWarnings.length}`);

			process.stdout.write(
				`\n evidence  hermes=${hermesBranch} omp=${ompBranch} grok=${grokBranch}\n evidence  fresh-kept=${freshKept ? "yes" : "NO"}\n evidence  links=${links.map((link) => link.slice(homeDir.length + 1)).join(",")}\n evidence  proposal-events=${proposals.length} opened=${opened.length} dirty-warnings=${dirtyWarnings.length}\n`,
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} checks passed.\n`);
	return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
