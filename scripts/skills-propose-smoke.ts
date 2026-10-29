#!/usr/bin/env bun
/**
 * Isolated end-to-end proof of `skills_propose` (SKILL-01), against a rehearsal twin started
 * with `--skills-fixture`.
 *
 *   bun run rehearsal up --name p21 --skills-fixture
 *   set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p21/consumer.env"; set +a
 *   bun run smoke:skills-propose
 *   bun run rehearsal down --name p21
 *
 * It sources only `consumer.env` and keeps the harness's guards: it refuses the production
 * port and any host that is not loopback. Git runs for real against a throwaway bare
 * repository inside the run directory; `gh` is a recording script answering from a JSON file;
 * nothing here can reach GitHub or the production skills state. It proves, over the real
 * server, the MCP tool, `POST /skills/propose` and `substrate skills propose`:
 *
 *   a. a valid skill is `opened` on each door, on a `skill/<surface>/<name>-<ts>-<hex>` branch
 *      that exists in the library, with exactly one recorded `gh pr create` each
 *   b. identical content is `existing`; once the PR is closed it is `declined`; content equal
 *      to `main` is `unchanged`; none of the three pushes a branch or opens a second PR
 *   c. a bad name, a `..` path, missing or mismatched frontmatter and a planted secret are each
 *      refused with no new branch and no `gh` call; the secret's finding names file, line and
 *      rule, and its value is nowhere in a response, the ledger, the events, the audit file or
 *      the recorded `gh` calls
 *   d. no token is 401 on the route and on `/mcp`; a body surface naming another surface is
 *      403; an operator-only option from a surface token is 403
 *   e. the library's reflog shows no ref ever updated, so no force-push and no rewrite
 *   f. the events are on the trail (`note` and `warning` rows with `action: skill.propose`) and
 *      the audit file holds `skills_propose` records
 *
 * Exit 0 when every check passes, 1 on a failure, 2 when the twin is not a skills-fixture one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refuseSmokeUrl } from "./rehearsal.ts";

// ── pure helpers (unit-tested in skills-propose-smoke.test.ts) ──────────────

/** `key=value` lines, as `substrate skills propose` prints them. Repeated keys are kept in order. */
export function parseKeyValues(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at <= 0) continue;
		const key = line.slice(0, at);
		const bucket = out[key] ?? [];
		out[key] = bucket;
		bucket.push(line.slice(at + 1));
	}
	return out;
}

/** The branch shape the engine promises: `skill/<surface>/<name>-<UTC ms timestamp>-<4 hex>`. */
export function branchPattern(surface: string, name: string): RegExp {
	return new RegExp(`^skill/${surface}/${name}-\\d{8}T\\d{9}Z-[0-9a-f]{4}$`);
}

/** Reflog lines that record an update rather than a creation: an old sha that is not all zeros. */
export function rewrittenRefs(reflog: string): string[] {
	return reflog
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.filter((line) => !/^0{40}\s/.test(line));
}

/** A tool reply's JSON and whether it was an error, from a JSON or a server-sent-events body. */
export function toolReply(body: string): { isError: boolean; value: Record<string, unknown> } | null {
	const frames = body.includes("data:")
		? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
		: [body];
	for (const frame of frames.reverse()) {
		try {
			const result = (JSON.parse(frame) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
			const text = result?.content?.[0]?.text;
			if (text !== undefined) return { isError: result?.isError === true, value: JSON.parse(text) as Record<string, unknown> };
		} catch {
			// A frame that is not JSON (or not a tool reply) is skipped; the next one is tried.
		}
	}
	return null;
}

export function skillMd(name: string, body = "A rehearsal smoke proposal."): string {
	return `---\nname: ${name}\ndescription: Rehearsal smoke skill ${name}.\n---\n\n${body}\n`;
}

// ── the proof ───────────────────────────────────────────────────────────────

interface Reply {
	status: number;
	json: Record<string, unknown>;
	text: string;
}

async function main(): Promise<number> {
	const env = process.env;
	const base = (env.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
	const refused = base ? refuseSmokeUrl(base) : "SUBSTRATE_URL is not set: source the instance's consumer.env first";
	if (refused !== null) {
		process.stderr.write(`[skills-smoke] ${refused}\n`);
		return 2;
	}
	const need = ["SUBSTRATE_REHEARSAL_SKILLS_STATE", "SUBSTRATE_REHEARSAL_SKILLS_ORIGIN", "SUBSTRATE_REHEARSAL_SKILLS_GH_STATE", "SUBSTRATE_REHEARSAL_SKILLS_REPO", "SUBSTRATE_REHEARSAL_TOKENS_DIR"];
	const missing = need.filter((key) => !env[key]);
	if (missing.length > 0) {
		process.stderr.write(`[skills-smoke] this twin has no skills fixture (${missing.join(", ")} unset): rehearsal up --skills-fixture\n`);
		return 2;
	}
	const stateDir = env.SUBSTRATE_REHEARSAL_SKILLS_STATE as string;
	const origin = env.SUBSTRATE_REHEARSAL_SKILLS_ORIGIN as string;
	const ghStatePath = env.SUBSTRATE_REHEARSAL_SKILLS_GH_STATE as string;
	const repo = env.SUBSTRATE_REHEARSAL_SKILLS_REPO as string;
	const tokensDir = env.SUBSTRATE_REHEARSAL_TOKENS_DIR as string;
	const runDir = dirname(tokensDir);
	const operatorToken = env.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN || env.SUBSTRATE_TOKEN || "";
	const agentSurface = "cursor";
	const agentToken = existsSync(join(tokensDir, agentSurface)) ? readFileSync(join(tokensDir, agentSurface), "utf8").trim() : "";
	if (!operatorToken || !agentToken) {
		process.stderr.write(`[skills-smoke] needs the operator's token and ${join(tokensDir, agentSurface)}; start the twin with the default surfaces\n`);
		return 2;
	}

	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\nskills_propose smoke — ${new URL(base).host}, library ${repo}\n\n`);

	const tag = Math.random().toString(16).slice(2, 8);
	const graph = `smoke-skills-${tag}`;
	const scratch = mkdtempSync(join(tmpdir(), "skills-smoke-"));
	// Assembled at run time so no token-shaped literal sits in the repository.
	const secret = `ghp_${"S".repeat(8)}${tag}${"k".repeat(22)}`.slice(0, 40);

	const git = (...args: string[]): string =>
		execFileSync("git", ["-C", origin, ...args], {
			encoding: "utf8",
			env: { PATH: env.PATH ?? "", HOME: runDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		});
	const branches = (): string[] => git("for-each-ref", "--format=%(refname:short)", "refs/heads/skill/").split("\n").filter(Boolean).sort();
	const ghState = () => JSON.parse(readFileSync(ghStatePath, "utf8")) as { prs: Array<{ number: number; url: string; head: string; state: string }>; calls: string[][] };
	const creates = (): number => ghState().calls.filter((argv) => argv[0] === "pr" && argv[1] === "create").length;
	const snapshot = () => ({ branches: branches(), creates: creates(), calls: ghState().calls.length, prs: ghState().prs.length });

	const headers = (token: string | null): Record<string, string> => ({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	});
	const route = async (token: string | null, body: unknown): Promise<Reply> => {
		const response = await fetch(`${base}/skills/propose`, { method: "POST", headers: headers(token), body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
		const text = await response.text();
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(text) as Record<string, unknown>;
		} catch {
			// Not JSON: the text is kept for the check.
		}
		return { status: response.status, json, text };
	};
	let rpcId = 0;
	const tool = async (token: string | null, args: Record<string, unknown>): Promise<{ status: number; reply: ReturnType<typeof toolReply>; text: string }> => {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "skills_propose", arguments: args } }),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await response.text();
		return { status: response.status, reply: toolReply(text), text };
	};
	const cli = async (token: string, dir: string, ...flags: string[]): Promise<{ code: number; fields: Record<string, string[]>; text: string }> => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"), "skills", "propose", "--dir", dir, ...flags], {
			env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", SUBSTRATE_URL: base, SUBSTRATE_TOKEN: token },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, fields: parseKeyValues(out), text: `${out}${err}` };
	};
	const writeSkillDir = (name: string, files: Record<string, string>): string => {
		const dir = join(scratch, name);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		return dir;
	};
	/** Nothing at all happened since `before`: no branch, no PR, no gh call. */
	const unchangedSince = (before: ReturnType<typeof snapshot>) => JSON.stringify(snapshot()) === JSON.stringify(before);
	/** No branch was pushed and no PR opened; a read-only `gh pr view` or `pr list` may have run. */
	const nothingPushed = (before: ReturnType<typeof snapshot>) => {
		const now = snapshot();
		return now.branches.join() === before.branches.join() && now.creates === before.creates && now.prs === before.prs;
	};

	try {
		// ── a. opened on each door ───────────────────────────────────────────
		const names = { route: `smoke-${tag}-route`, mcp: `smoke-${tag}-mcp`, cli: `smoke-${tag}-cli` };
		const routeBody = { name: names.route, files: { "SKILL.md": skillMd(names.route) }, rationale: "smoke: route", graph_id: graph, session_id: `smoke-${tag}-r` };
		let before = snapshot();
		const viaRoute = await route(agentToken, routeBody);
		check(viaRoute.status === 200 && viaRoute.json.status === "opened", "the route answers opened", `${viaRoute.status} ${String(viaRoute.json.status ?? viaRoute.json.error)}`);
		check(typeof viaRoute.json.branch === "string" && branchPattern(agentSurface, names.route).test(viaRoute.json.branch), "the route's branch is skill/<surface>/<name>-<ts>-<hex>", String(viaRoute.json.branch));
		check(branches().includes(String(viaRoute.json.branch)) && creates() === before.creates + 1, "that branch is in the library and exactly one gh pr create was recorded");

		before = snapshot();
		const viaTool = await tool(agentToken, { name: names.mcp, files: { "SKILL.md": skillMd(names.mcp) }, rationale: "smoke: mcp", graph_id: graph, session_id: `smoke-${tag}-m` });
		const toolValue = viaTool.reply?.value ?? {};
		check(viaTool.reply !== null && !viaTool.reply.isError && toolValue.status === "opened", "the MCP tool answers opened", String(toolValue.status ?? toolValue.error ?? viaTool.status));
		check(typeof toolValue.branch === "string" && branchPattern(agentSurface, names.mcp).test(toolValue.branch) && branches().includes(toolValue.branch) && creates() === before.creates + 1, "the tool's branch is in the library with one recorded gh pr create");

		before = snapshot();
		const cliDir = writeSkillDir(names.cli, { "SKILL.md": skillMd(names.cli), "scripts/run.sh": "echo smoke\n" });
		const viaCli = await cli(agentToken, cliDir, "--rationale", "smoke: cli", "--graph", graph, "--session", `smoke-${tag}-c`);
		const cliBranch = viaCli.fields.branch?.[0] ?? "";
		check(viaCli.code === 0 && viaCli.fields.status?.[0] === "opened", "substrate skills propose prints status=opened and exits 0", viaCli.text.trim().split("\n")[0]);
		check(branchPattern(agentSurface, names.cli).test(cliBranch) && branches().includes(cliBranch) && creates() === before.creates + 1, "the CLI's branch is in the library with one recorded gh pr create");
		const prUrls = [viaRoute.json.pr_url, toolValue.pr_url, viaCli.fields.pr_url?.[0]].map(String);
		check(prUrls.every((url) => url.startsWith(`https://github.com/${repo}/pull/`)) && new Set(prUrls).size === 3, "three distinct PRs, all under the fixture library", prUrls.join(" "));

		// ── b. existing, declined, unchanged ─────────────────────────────────
		before = snapshot();
		const again = await route(agentToken, routeBody);
		check(again.status === 200 && again.json.status === "existing" && again.json.pr_url === viaRoute.json.pr_url, "identical content answers existing, with the same PR");
		check(nothingPushed(before), "existing pushed no branch and opened no second PR");

		const state = ghState();
		const pr = state.prs.find((candidate) => candidate.url === viaRoute.json.pr_url);
		if (pr) pr.state = "CLOSED";
		writeFileSync(ghStatePath, `${JSON.stringify(state, null, 2)}\n`);
		before = snapshot();
		const declined = await route(agentToken, routeBody);
		check(declined.status === 200 && declined.json.status === "declined", "once the PR is closed the same content answers declined", String(declined.json.status));
		check(nothingPushed(before), "declined pushed no branch and opened no second PR");

		const seedMd = git("show", "main:seed-skill/SKILL.md");
		before = snapshot();
		const same = await route(agentToken, { name: "seed-skill", files: { "SKILL.md": seedMd }, rationale: "smoke: unchanged", graph_id: graph, session_id: `smoke-${tag}-u` });
		check(same.status === 200 && same.json.status === "unchanged", "content equal to main answers unchanged", String(same.json.status ?? same.json.error));
		check(nothingPushed(before), "unchanged pushed no branch and opened no second PR");

		// ── c. refusals ──────────────────────────────────────────────────────
		const refusalCases: Array<[string, Record<string, unknown>]> = [
			["a bad name", { name: "Bad_Name", files: { "SKILL.md": skillMd("Bad_Name") } }],
			["a .. path", { name: `smoke-${tag}-dots`, files: { "SKILL.md": skillMd(`smoke-${tag}-dots`), "../escape.md": "x" } }],
			["missing frontmatter", { name: `smoke-${tag}-nofm`, files: { "SKILL.md": "just text, no frontmatter\n" } }],
			["mismatched frontmatter", { name: `smoke-${tag}-mismatch`, files: { "SKILL.md": skillMd("some-other-name") } }],
		];
		for (const [label, partial] of refusalCases) {
			before = snapshot();
			const reply = await route(agentToken, { rationale: "smoke: refusal", graph_id: graph, session_id: `smoke-${tag}-x`, ...partial });
			check(reply.status === 400 && typeof reply.json.error === "string", `${label} is refused 400`, String(reply.json.error).slice(0, 80));
			check(unchangedSince(before), `${label}: no new branch and no gh call`);
		}

		before = snapshot();
		const secretName = `smoke-${tag}-secret`;
		const planted = await route(agentToken, {
			name: secretName,
			files: { "SKILL.md": skillMd(secretName, `Use GITHUB_TOKEN=${secret} to call the API.`) },
			rationale: "smoke: secret",
			graph_id: graph,
			session_id: `smoke-${tag}-s`,
		});
		const findings = (planted.json.findings ?? []) as Array<{ file?: string; line?: number; rule?: string }>;
		check(planted.status === 400 && findings.length > 0 && findings.every((f) => f.file === "SKILL.md" && typeof f.line === "number" && typeof f.rule === "string"), "a planted secret is refused with findings naming file, line and rule", JSON.stringify(findings[0] ?? {}));
		check(unchangedSince(before), "the planted secret: no new branch and no gh call");
		const viaToolSecret = await tool(agentToken, { name: `${secretName}2`, files: { "SKILL.md": skillMd(`${secretName}2`, `token ${secret}`) }, rationale: "smoke: secret via mcp", graph_id: graph, session_id: `smoke-${tag}-s2` });
		check(viaToolSecret.reply?.isError === true, "the same secret through the MCP tool is an error reply too");

		// ── d. authentication and attribution ────────────────────────────────
		before = snapshot();
		const anonymousRoute = await route(null, routeBody);
		const anonymousMcp = await tool(null, { name: names.route, files: { "SKILL.md": skillMd(names.route) }, rationale: "x" });
		check(anonymousRoute.status === 401, "no token is 401 on /skills/propose", String(anonymousRoute.status));
		check(anonymousMcp.status === 401, "no token is 401 on /mcp", String(anonymousMcp.status));
		const mismatch = await route(agentToken, { ...routeBody, name: `smoke-${tag}-mm`, files: { "SKILL.md": skillMd(`smoke-${tag}-mm`) }, surface: "claude-code" });
		check(mismatch.status === 403, "a body surface naming another surface is 403, never re-attributed", `${mismatch.status} ${String(mismatch.json.error).slice(0, 60)}`);
		for (const [label, option] of [["replace", { mode: "replace" }], ["reopen", { reopen: true }], ["doc examples", { allow_doc_examples: ["pem"] }]] as const) {
			const privileged = await route(agentToken, { ...routeBody, name: `smoke-${tag}-pv`, files: { "SKILL.md": skillMd(`smoke-${tag}-pv`) }, ...option });
			check(privileged.status === 403, `${label} from a surface token is 403`, String(privileged.status));
		}
		check(unchangedSince(before), "no authentication or attribution refusal pushed a branch or called gh");

		// ── dry run, as the operator ─────────────────────────────────────────
		before = snapshot();
		const dry = await route(operatorToken, { name: `smoke-${tag}-dry`, files: { "SKILL.md": skillMd(`smoke-${tag}-dry`) }, rationale: "smoke: dry run", dry_run: true, graph_id: graph });
		check(dry.status === 200 && dry.json.status === "dry_run" && typeof dry.json.content_sha256 === "string", "a dry run answers dry_run with the content hash", String(dry.json.status ?? dry.json.error));
		check(unchangedSince(before), "a dry run pushed nothing and called no gh");

		// ── e. the library's reflog ──────────────────────────────────────────
		const refRoot = join(origin, "logs", "refs", "heads");
		const logs: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else logs.push(readFileSync(path, "utf8"));
			}
		};
		if (existsSync(refRoot)) walk(refRoot);
		const rewritten = rewrittenRefs(logs.join("\n"));
		check(logs.length >= 4 && rewritten.length === 0, "every ref in the library was created once and never updated", `${logs.length} ref logs, ${rewritten.length} updates`);

		// ── f. events and audit ──────────────────────────────────────────────
		const queried = await fetch(`${base}/events/query`, {
			method: "POST",
			headers: headers(operatorToken),
			body: JSON.stringify({ graph_id: graph, limit: 200, include_payload: true }),
		});
		const events = ((await queried.json()) as { events?: Array<{ kind: string; surface: string; payload?: Record<string, unknown> }> }).events ?? [];
		const proposals = events.filter((event) => event.payload?.action === "skill.propose");
		const notes = proposals.filter((event) => event.kind === "note").map((event) => event.payload?.status);
		const warnings = proposals.filter((event) => event.kind === "warning");
		check(["opened", "existing", "declined", "unchanged"].every((status) => notes.includes(status)) && notes.filter((status) => status === "opened").length >= 3, "note events record opened, existing, declined and unchanged", `${notes.length} notes`);
		check(warnings.length >= 5 && warnings.every((event) => event.payload?.status === "refused"), "warning events record each refusal", `${warnings.length} warnings`);
		check(
			warnings.some((event) => {
				const rules = event.payload?.rules;
				return Array.isArray(rules) && rules.length > 0;
			}),
			"a refusal's event carries rule names",
		);
		check(proposals.every((event) => event.surface === agentSurface || event.surface === "claude-code"), "every event is attributed to a token surface");

		const auditPath = join(runDir, "mcp-audit.jsonl");
		const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
		const auditRecords = audit.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool?: string; transport?: string });
		const proposed = auditRecords.filter((record) => record.tool === "skills_propose");
		check(proposed.length >= 10 && proposed.some((record) => record.transport === "rest") && proposed.some((record) => record.transport === "mcp"), "the audit file holds skills_propose records for both transports", `${proposed.length} records`);

		// ── the planted secret is nowhere ────────────────────────────────────
		const ledgerFile = join(stateDir, "proposals.jsonl");
		const places: Array<[string, string]> = [
			["the route response", planted.text],
			["the MCP response", viaToolSecret.text],
			["the proposal ledger", existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : ""],
			["the events", JSON.stringify(events)],
			["the audit file", audit],
			["the recorded gh calls", readFileSync(ghStatePath, "utf8")],
			["the library's refs", git("for-each-ref", "--format=%(refname) %(subject)")],
		];
		for (const [where, text] of places) check(!text.includes(secret) && !text.includes(secret.slice(8)), `the planted secret is not in ${where}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} checks passed.\n`);
	return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
