/**
 * Tests for the headless Hermes launch contract (DISP-04, DISP-07,
 * T-24-03b, T-24-03c, T-24-03f).
 *
 * Spawning goes through an injected fake that records argv: the real
 * `hermes` binary is never executed. Prompt files land in tmp dirs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildChildEnv,
	buildPrompt,
	buildSessionId,
	checkSubstrateMcp,
	hermesArgv,
	launchHermes,
	writePromptFile,
	type HermesSpawnOptions,
} from "./launch-hermes.ts";

const tmpBases: string[] = [];
afterEach(() => {
	while (tmpBases.length > 0) {
		const base = tmpBases.pop();
		if (base !== undefined) rmSync(base, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const base = mkdtempSync(join(tmpdir(), "dispatcher-launch-"));
	tmpBases.push(base);
	return base;
}

describe("hermes argv contract", () => {
	test("argv matches the headless contract exactly", () => {
		expect(hermesArgv("/wt/ut-x", "/wt/ut-x/prompt.md")).toEqual([
			"hermes",
			"chat",
			"--oneshot",
			"--quiet",
			"--source",
			"tool",
			"--yolo",
			"--accept-hooks",
			"--in",
			"/wt/ut-x",
			"--query-file",
			"/wt/ut-x/prompt.md",
		]);
	});

	test("argv carries no shell prompt, worktree, or config-stripping flags", () => {
		const argv = hermesArgv("/wt", "/wt/prompt.md");
		for (const forbidden of ["--worktree", "-z", "--safe-mode", "--ignore-user-config", "-q"]) {
			expect(argv).not.toContain(forbidden);
		}
	});

	test("launch spawns detached with stdin /dev/null and cwd on the worktree", async () => {
		const seen: Array<{ argv: string[]; options: HermesSpawnOptions }> = [];
		const child = await launchHermes(
			{ worktreePath: "/wt/ut-x", promptPath: "/wt/ut-x/prompt.md", env: { PATH: "/usr/bin" } },
			{
				spawn: (argv, options) => {
					seen.push({ argv, options });
					return { pid: 4242 };
				},
			},
		);
		expect(child).toEqual({ pid: 4242 });
		expect(seen).toHaveLength(1);
		const first = seen[0];
		if (!first) throw new Error("expected one recorded spawn");
		expect(first.argv[0]).toBe("hermes");
		expect(first.options).toEqual({
			cwd: "/wt/ut-x",
			env: { PATH: "/usr/bin" },
			stdinPath: "/dev/null",
			detached: true,
		});
	});
});

describe("child environment allowlist", () => {
	test("only plumbing plus the hermes token pass; every other secret is dropped", () => {
		const env = buildChildEnv(
			{
				HOME: "/root",
				PATH: "/usr/bin:/bin",
				USER: "root",
				LANG: "C.UTF-8",
				TMPDIR: "/tmp",
				HERMES_HOME: "/root/.hermes-alt",
				LINEAR_API_KEY: "lin-secret",
				NOTION_API_KEY: "notion-secret",
				SUBSTRATE_TOKEN_SUBSTRATE: "substrate-secret",
				SUBSTRATE_TOKEN_HERMES: "decoy-hermes-token",
				SUBSTRATE_OPERATOR_TOKENS: "op-secret",
				SUBSTRATE_PG_URL: "postgres-secret",
			},
			{ substrateUrl: "http://127.0.0.1:7410", hermesToken: "real-hermes-token" },
		);
		expect(Object.keys(env).sort()).toEqual(
			["HERMES_HOME", "HOME", "LANG", "PATH", "SUBSTRATE_TOKEN_HERMES", "SUBSTRATE_URL", "TMPDIR", "USER"].sort(),
		);
		expect(env.SUBSTRATE_TOKEN_HERMES).toBe("real-hermes-token");
		expect(env.SUBSTRATE_URL).toBe("http://127.0.0.1:7410");
	});

	test("unset plumbing stays absent rather than empty", () => {
		const env = buildChildEnv(
			{ HOME: "/root", PATH: "/usr/bin" },
			{ substrateUrl: "http://127.0.0.1:7410", hermesToken: "t" },
		);
		expect(env).toEqual({
			HOME: "/root",
			PATH: "/usr/bin",
			SUBSTRATE_URL: "http://127.0.0.1:7410",
			SUBSTRATE_TOKEN_HERMES: "t",
		});
	});
});

describe("ids-only prompt", () => {
	const CANARY_TITLE = "CANARY-TITLE-quartz-vinegar-917";
	const CANARY_DESC = "CANARY-DESC-midnight-harbor-441";

	test("prompt and argv carry ids only, never issue text", () => {
		const graphId = "ut-mkts36-abcdef01";
		const nodeId = "n3";
		const sessionId = buildSessionId(graphId, nodeId);
		expect(sessionId).toBe("hermes:ut-mkts36-abcdef01:n3");

		const dir = makeTmp();
		const promptPath = writePromptFile(dir, { graphId, nodeId, sessionId });
		const prompt = buildPrompt(graphId, nodeId, sessionId);
		const argv = hermesArgv(dir, promptPath);

		for (const text of [prompt, argv.join("\n")]) {
			expect(text).toContain(graphId);
			expect(text).toContain(nodeId);
			expect(text).toContain(sessionId);
			expect(text).not.toContain(CANARY_TITLE);
			expect(text).not.toContain(CANARY_DESC);
		}
		expect(promptPath.endsWith(".md")).toBe(true);
	});

	test("prompt file is mode 0600", () => {
		const dir = makeTmp();
		const promptPath = writePromptFile(dir, {
			graphId: "ut-mkts36-abcdef01",
			nodeId: "n3",
			sessionId: "hermes:ut-mkts36-abcdef01:n3",
		});
		expect(statSync(promptPath).mode & 0o777).toBe(0o600);
	});
});

describe("substrate MCP preflight", () => {
	test("missing or substrate-free config skips without a spawn", () => {
		expect(checkSubstrateMcp(null)).toBe("mcp-unconfigured");
		expect(checkSubstrateMcp(undefined)).toBe("mcp-unconfigured");
		expect(checkSubstrateMcp("")).toBe("mcp-unconfigured");
		expect(checkSubstrateMcp("mcp_servers:\n  filesystem:\n    enabled: true\n")).toBe("mcp-unconfigured");
	});

	test("a substrate server entry passes", () => {
		expect(
			checkSubstrateMcp(
				"mcp_servers:\n  substrate:\n    url: http://127.0.0.1:7410/mcp\n    enabled: true\n",
			),
		).toBe("ok");
	});
});
