#!/usr/bin/env bun
/**
 * Rehearsal proof of the mined-to-projected loop (SKILL-07, rehearsal half), against a
 * rehearsal twin started with `--skills-fixture`.
 *
 *   bun run rehearsal up --name p22 --skills-fixture
 *   set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p22/consumer.env"; set +a
 *   bun run smoke:skills-sync
 *   bun run rehearsal down --name p22
 *
 * It sources only `consumer.env` and keeps the harness's guards: it refuses the production
 * port and any host that is not loopback. Git runs for real against throwaway clones of the
 * fixture's bare origin; `gh` is the fixture's recording script; the bridge runs for real
 * over HTTP to the twin with the fixture's hermes bearer. Nothing here can reach GitHub,
 * the production library checkout or the production state. It proves:
 *
 *   a. a staged Hermes pending group past quiet proposes as `opened` through the route with
 *      the hermes bearer (records unlinked, bridge log carries the PR URL), while a second
 *      group inside quiet is held with no request
 *   b. Omp and Grok queue bodies drain to `opened` and are deleted, while a 401-kept body stays
 *   c. dirty, off-branch and diverged fixture checkouts each refuse with a warning event and
 *      exit 0, projecting nothing
 *   d. after simulating the owner merge (fast-forward the fixture library main to the PR
 *      branch), one sync tick prints ff and projects a symlink for the new skill in the
 *      claude and grok fixture roots, which hold only links afterwards
 *   e. every refusal warning is on the substrate surface and carries rule names only, never values
 *
 * September 04-12 proof-route note: with no Cursor transcripts staged, the pending path is
 * empty and the queues are the route — (b) is that fallback, proven rather than assumed.
 *
 * Exit 0 when every check passes, 1 on a failure, 2 when the twin is not a skills-fixture one.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSync, type Runner } from "../packages/projector/src/skills-sync.ts";
import { project, type ProjectOptions, type Root, type WarningEvent } from "../packages/projector/src/skills.ts";
import { refuseSmokeUrl } from "./rehearsal.ts";

const AUTHOR = ["-c", "user.name=rehearsal", "-c", "user.email=rehearsal@localhost"];

function skillMd(name: string, body = "A sync-smoke proposal."): string {
	return `---\nname: ${name}\ndescription: Rehearsal sync smoke skill ${name}.\n---\n\n${body}\n`;
}

async function main(): Promise<number> {
	const env = process.env;
	const base = (env.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
	const refused = base ? refuseSmokeUrl(base) : "SUBSTRATE_URL is not set: source the instance's consumer.env first";
	if (refused !== null) {
		process.stderr.write(`[sync-smoke] ${refused}\n`);
		return 2;
	}
	const need = ["SUBSTRATE_REHEARSAL_SKILLS_STATE", "SUBSTRATE_REHEARSAL_SKILLS_ORIGIN", "SUBSTRATE_REHEARSAL_SKILLS_GH_STATE", "SUBSTRATE_REHEARSAL_SKILLS_REPO", "SUBSTRATE_REHEARSAL_TOKENS_DIR"];
	const missing = need.filter((key) => !env[key]);
	if (missing.length > 0) {
		process.stderr.write(`[sync-smoke] this twin has no skills fixture (${missing.join(", ")} unset): rehearsal up --skills-fixture\n`);
		return 2;
	}
	const origin = env.SUBSTRATE_REHEARSAL_SKILLS_ORIGIN as string;
	const ghStatePath = env.SUBSTRATE_REHEARSAL_SKILLS_GH_STATE as string;
	const tokensDir = env.SUBSTRATE_REHEARSAL_TOKENS_DIR as string;
	const runDir = dirname(tokensDir);
	const tokenFor = (surface: string): string => (existsSync(join(tokensDir, surface)) ? readFileSync(join(tokensDir, surface), "utf8").trim() : "");
	const hermesToken = tokenFor("hermes");
	const ompToken = tokenFor("omp");
	const grokToken = tokenFor("grok-build");
	if (!hermesToken || !ompToken || !grokToken) {
		process.stderr.write("[sync-smoke] needs the fixture hermes, omp and grok-build tokens; start the twin with the default surfaces\n");
		return 2;
	}

	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\nskills sync smoke — ${new URL(base).host}, library ${env.SUBSTRATE_REHEARSAL_SKILLS_REPO}\n\n`);

	const tag = Math.random().toString(16).slice(2, 8);
	const now = Math.floor(Date.now() / 1000);
	const scratch = mkdtempSync(join(tmpdir(), "skills-sync-smoke-"));
	const gitEnv = {
		PATH: env.PATH ?? "",
		HOME: runDir,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
	};
	const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", env: gitEnv, cwd: scratch });
	const runner: Runner = (argv) => {
		const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
		execFile(argv[0] as string, argv.slice(1), { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: gitEnv }, (error, stdout, stderr) => {
			const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : error === null ? 0 : null;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
		return promise;
	};
	const ghState = () => JSON.parse(readFileSync(ghStatePath, "utf8")) as { prs: Array<{ number: number; url: string; head: string; state: string }>; calls: string[][] };
	const creates = (): number => ghState().calls.filter((argv) => argv[0] === "pr" && argv[1] === "create").length;
	const drive = async (token: string, ...args: string[]): Promise<{ code: number; summary: Record<string, unknown> }> => {
		const proc = Bun.spawn(["python3", join(import.meta.dir, "skills-sync-smoke-bridge.py"), ...args], {
			env: { PATH: env.PATH ?? "", SUBSTRATE_TOKEN: token },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		let summary: Record<string, unknown> = {};
		try {
			summary = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
		} catch {
			// Kept as {}: the checks below fail on the missing fields.
		}
		return { code, summary };
	};

	try {
		const mined = `smoke-mined-${tag}`;
		const quiet = `smoke-quiet-${tag}`;
		const ompSkill = `smoke-queue-omp-${tag}`;
		const grokSkill = `smoke-queue-grok-${tag}`;

		// ── fixture checkouts: one bridge/sync library each, so the merge simulation ──
		// ── below can advance the origin while the sync tree still lags behind ─────────
		const originUrl = pathToFileURL(origin).href;
		const libMain = join(scratch, "lib-main");
		const libSync = join(scratch, "lib-sync");
		git("clone", "-q", originUrl, libMain);
		git("clone", "-q", originUrl, libSync);

		const pending = join(scratch, "pending");
		const hermesSkills = join(scratch, "hermes-skills");
		const bridgeState = join(scratch, "bridge-state");
		mkdirSync(pending, { recursive: true });
		mkdirSync(hermesSkills, { recursive: true });
		mkdirSync(bridgeState, { recursive: true });
		const stage = (id: string, record: Record<string, unknown>): void => {
			writeFileSync(join(pending, `${id}.json`), `${JSON.stringify(record)}\n`);
		};

		// ── a. past quiet proposes opened; inside quiet waits ─────────────────────────
		const createsBefore = creates();
		stage("aaaa0001", { id: "aaaa0001", subsystem: "skills", action: "create", summary: "create", origin: "foreground", created_at: now - 600, payload: { action: "create", name: mined, content: skillMd(mined) } });
		stage("aaaa0002", { id: "aaaa0002", subsystem: "skills", action: "write_file", summary: "add notes", origin: "foreground", created_at: now - 500, payload: { action: "write_file", name: mined, file_path: "references/notes.md", file_content: "notes\n" } });
		stage("bbbb0001", { id: "bbbb0001", subsystem: "skills", action: "create", summary: "too fresh", origin: "foreground", created_at: now - 30, payload: { action: "create", name: quiet, content: skillMd(quiet) } });
		const tick = await drive(hermesToken, "run-once", `--url=${base}`, `--pending-dir=${pending}`, `--library=${libMain}`, `--hermes-skills=${hermesSkills}`, `--log=${join(bridgeState, "log.jsonl")}`, `--held=${join(bridgeState, "held.json")}`, `--now=${now}`);
		check(tick.code === 0 && tick.summary.proposed === 1 && tick.summary.waiting === 1, "a past-quiet group proposes opened while a fresh group waits", JSON.stringify(tick.summary));
		const pendingLeft = readdirSync(pending).sort();
		check(pendingLeft.length === 1 && (pendingLeft[0] as string).startsWith("bbbb"), "the proposed records are unlinked, the quiet one stays", pendingLeft.join(","));
		const openedLine = readFileSync(join(bridgeState, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
		check(openedLine.some((line) => line.name === mined && line.status === "opened" && typeof line.pr_url === "string"), "the bridge log carries the opened PR URL", `${openedLine.length} lines`);
		check(creates() === createsBefore + 1, "exactly one recorded gh pr create", `${creates()} creates`);

		// ── b. queue drains: omp and grok bodies opened and deleted; 401 kept ─────────
		// Each drain authenticates as the queued body's surface: the route refuses a
		// mismatched body surface with 403, so a single hermes client cannot drain them.
		const ompQueue = join(scratch, "omp-queue");
		const grokQueue = join(scratch, "grok-queue");
		mkdirSync(ompQueue, { recursive: true });
		mkdirSync(grokQueue, { recursive: true });
		const queued = (name: string, surface: string): Record<string, unknown> => ({ name, files: { "SKILL.md": skillMd(name) }, rationale: `smoke: ${surface} queue`, surface });
		writeFileSync(join(ompQueue, `${ompSkill}-20260926T090000Z.json`), `${JSON.stringify(queued(ompSkill, "omp"))}\n`);
		writeFileSync(join(grokQueue, `${grokSkill}-20260926T090000Z.json`), `${JSON.stringify(queued(grokSkill, "grok-build"))}\n`);
		const ompDrain = await drive(ompToken, "drain", `--url=${base}`, `--dir=${ompQueue}`, "--surface=omp", `--log=${join(bridgeState, "log.jsonl")}`);
		check(ompDrain.code === 0 && ompDrain.summary.proposed === 1 && readdirSync(ompQueue).length === 0, "the omp queue body drains to opened and is deleted", JSON.stringify(ompDrain.summary));
		const grokDrain = await drive(grokToken, "drain", `--url=${base}`, `--dir=${grokQueue}`, "--surface=grok-build", `--log=${join(bridgeState, "log.jsonl")}`);
		check(grokDrain.code === 0 && grokDrain.summary.proposed === 1 && readdirSync(grokQueue).length === 0, "the grok queue body drains to opened and is deleted", JSON.stringify(grokDrain.summary));
		writeFileSync(join(grokQueue, `${grokSkill}-kept-20260926T090000Z.json`), `${JSON.stringify(queued(`${grokSkill}-kept`, "grok-build"))}\n`);
		const keptDrain = await drive("wrong-bearer", "drain", `--url=${base}`, `--dir=${grokQueue}`, "--surface=grok-build", `--log=${join(bridgeState, "log.jsonl")}`);
		check(keptDrain.summary.kept === 1 && readdirSync(grokQueue).length === 1, "a 401-kept body stays for the next tick", JSON.stringify(keptDrain.summary));

		// ── c. dirty, off-branch and diverged checkouts refuse with a warning ─────────
		const warnings: WarningEvent[] = [];
		const syncLog: string[] = [];
		const syncCtx = (libraryDir: string): Parameters<typeof runSync>[0] => ({
			runner,
			libraryDir,
			log: (line) => syncLog.push(line),
			emitWarning: async (event) => {
				warnings.push(event);
				return true;
			},
			project: async () => ({ actions: 0, warnings: 0 }),
		});
		const dirtyTree = join(scratch, "lib-dirty");
		const branchTree = join(scratch, "lib-branch");
		const divergedA = join(scratch, "lib-diverged-a");
		git("clone", "-q", originUrl, dirtyTree);
		git("clone", "-q", originUrl, branchTree);
		git("clone", "-q", originUrl, divergedA);
		writeFileSync(join(dirtyTree, "untracked.md"), "dirt\n");
		git("-C", branchTree, "checkout", "-q", "-b", "skill/x");
		// Local-only commit: HEAD is no longer an ancestor of origin/main, so the
		// gate refuses as diverged while the fixture origin never moves.
		writeFileSync(join(divergedA, "from-a.md"), "a\n");
		git("-C", divergedA, ...AUTHOR, "add", "from-a.md");
		git("-C", divergedA, ...AUTHOR, "commit", "-q", "-m", "a side");
		const dirty = await runSync(syncCtx(dirtyTree));
		check(dirty.decision === "refuse-dirty" && dirty.code === 0, "a dirty fixture tree refuses with exit 0", `${dirty.decision} ${dirty.code}`);
		const branched = await runSync(syncCtx(branchTree));
		check(branched.decision === "refuse-branch" && branched.code === 0, "an off-branch fixture checkout refuses with exit 0", `${branched.decision} ${branched.code}`);
		const diverged = await runSync(syncCtx(divergedA));
		check(diverged.decision === "refuse-diverged" && diverged.code === 0, "a diverged fixture checkout refuses with exit 0", `${diverged.decision} ${diverged.code}`);
		check(warnings.length === 3 && syncLog.filter((line) => line.startsWith("[skills-sync] refused")).length === 3, "each refusal logs and warns once", `${warnings.length} warnings`);

		// ── d. owner merge, then one sync tick fast-forwards and projects ─────────────
		const prs = ghState().prs;
		const head = prs.find((pr) => pr.head.includes(mined))?.head;
		check(typeof head === "string", "the rehearsal PR branch names the mined skill", head ?? "none");
		if (typeof head === "string") {
			git("-C", libMain, "fetch", "-q", "origin");
			git("-C", libMain, "merge", "-q", "--ff-only", `origin/${head}`);
			git("-C", libMain, "push", "-q", "origin", "main");
		}
		const claudeRoot = join(scratch, "roots", "claude");
		const grokRoot = join(scratch, "roots", "grok");
		mkdirSync(claudeRoot, { recursive: true });
		mkdirSync(grokRoot, { recursive: true });
		const roots: Root[] = [
			{ id: "claude", dir: claudeRoot, surface: "claude-code", mode: "link" },
			{ id: "grok", dir: grokRoot, surface: "grok-build", mode: "link" },
		];
		const tickLog: string[] = [];
		const tickWarnings: WarningEvent[] = [];
		const options: ProjectOptions = {
			roots,
			libraryDir: libSync,
			exportsDir: join(scratch, "exports"),
			backupRoot: join(scratch, "backup"),
			stateFile: join(scratch, "warned.json"),
			stdout: (line) => tickLog.push(line),
			emitWarning: async (event) => {
				tickWarnings.push(event);
				return true;
			},
		};
		const ff = await runSync({ runner, libraryDir: libSync, log: (line) => tickLog.push(line), emitWarning: options.emitWarning, project: () => project(options) });
		check(ff.decision === "ff" && ff.code === 0 && tickLog.some((line) => line.startsWith("[skills-sync] ff ")), "one sync tick fast-forwards after the merge", `${ff.decision} ${ff.code}`);
		const minedLink = readlinkSync(join(claudeRoot, mined));
		const grokLink = readlinkSync(join(grokRoot, mined));
		check(minedLink === join(libSync, mined) && grokLink === join(libSync, mined), "the new skill is a symlink in the claude and grok roots", `${minedLink} ${grokLink}`);
		const rootEntries = (dir: string): string[] => readdirSync(dir).sort() as string[];
		// The library is the source of truth: on a reused twin it holds earlier runs'
		// merged skills too, and the roots must match it exactly (no missing, no extras).
		const expected = readdirSync(libSync, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(libSync, entry.name, "SKILL.md"))).map((entry) => entry.name).sort();
		const onlyLinks = (dir: string): boolean => rootEntries(dir).every((name) => {
			try {
				return readlinkSync(join(dir, name)).length > 0;
			} catch {
				return false;
			}
		});
		check(JSON.stringify(rootEntries(claudeRoot)) === JSON.stringify(expected) && JSON.stringify(rootEntries(grokRoot)) === JSON.stringify(expected), "both roots hold exactly the library names", rootEntries(claudeRoot).join(","));
		check(onlyLinks(claudeRoot) && onlyLinks(grokRoot), "neither root config changed: roots hold only links", "links only");

		// ── e. refusal warnings carry rule names only ─────────────────────────────────
		const reasons = warnings.map((warning) => warning.payload.reason);
		check(warnings.every((warning) => warning.surface === "substrate" && warning.kind === "warning"), "every refusal warns from the substrate surface", reasons.join(","));
		const ruleName = /^[a-z][a-z0-9.-]*$/;
		check(warnings.every((warning) => Object.keys(warning.payload).sort().join() === "action,reason,runtime" && Object.values(warning.payload).every((value) => typeof value === "string" && ruleName.test(value))), "warning payloads carry rule names only, never values", JSON.stringify(reasons));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const failed = results.filter((ok) => !ok).length;
	process.stdout.write(failed === 0 ? `\nsync smoke: ${results.length} checks passed\n` : `\nsync smoke: ${failed}/${results.length} checks FAILED\n`);
	return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
