/**
 * Muse projector. The CLI is spawned so importing it does not install a plugin,
 * and MUSE_BIN is a stub so the operator's Muse is never touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "muse.ts");
const ROOT = join(import.meta.dir, "..", "..", "..");
const SENTINEL = "p14-sentinel-token-7f3a9c";
const REDACT_SOURCE = join(ROOT, "packages", "mcp-server", "src", "redact.ts");

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "muse-projector-"));
	made.push(dir);
	return dir;
}

function writeStub(dir: string): string {
	const path = join(dir, "muse-stub.ts");
	writeFileSync(
		path,
		[
			"#!/usr/bin/env bun",
			"const log = process.env.MUSE_STUB_LOG ?? '';",
			"const args = process.argv.slice(2);",
			"const prev = await Bun.file(log).text().catch(() => '');",
			"await Bun.write(log, prev + JSON.stringify(args) + '\\n');",
			"const cmd = args[1];",
			"if (cmd === 'validate') {",
			"  if (process.env.MUSE_STUB_INVALID === '1') {",
			"    console.log(JSON.stringify({ valid: false, diagnostics: [{ message: 'no' }] }));",
			"    process.exit(0);",
			"  }",
			"  console.log(JSON.stringify({ valid: true, diagnostics: [] }));",
			"  process.exit(0);",
			"}",
			"if (cmd === 'list') {",
			"  const cache = process.env.MUSE_STUB_CACHE ?? '';",
			"  const plugins = cache ? [{ plugin: { id: 'substrate' }, record: { cache_path: cache } }] : [];",
			"  console.log(JSON.stringify({ plugins }));",
			"  process.exit(0);",
			"}",
			"if (cmd === 'inspect') {",
			"  console.log(JSON.stringify({ runtime_capabilities: [{ status: process.env.MUSE_STUB_STATUS ?? 'trusted_enabled' }] }));",
			"  process.exit(0);",
			"}",
			"if (cmd === 'install' || cmd === 'update' || cmd === 'approve') {",
			"  console.log(JSON.stringify({ ok: true }));",
			"  process.exit(0);",
			"}",
			"console.error('unexpected ' + args.join(' '));",
			"process.exit(1);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
	return path;
}

function git(repo: string, args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().slice(0, 400));
}

function tempGit(): string {
	const dir = temp();
	git(dir, ["init", "-q", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Substrate Test"]);
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	git(dir, ["remote", "add", "origin", "https://example.invalid/acme/widgets.git"]);
	return dir;
}

interface RunOpts {
	url?: string;
	tokenFile?: string;
	stateDir?: string;
	cache?: string;
	status?: string;
	invalid?: boolean;
}

function run(dir: string, args: string[], opts: RunOpts = {}): { code: number; out: string; err: string; calls: string[][] } {
	const stub = writeStub(dir);
	const log = join(dir, "calls.jsonl");
	writeFileSync(log, "");
	const bundle = join(dir, "bundle");
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			MUSE_BIN: stub,
			MUSE_STUB_LOG: log,
			MUSE_PLUGIN_DIR: bundle,
			SUBSTRATE_URL: opts.url ?? "http://127.0.0.1:7499",
			SUBSTRATE_TOKEN: SENTINEL,
			SUBSTRATE_MUSE_TOKEN_FILE: opts.tokenFile ?? join(dir, "token.env"),
			SUBSTRATE_STATE_DIR: opts.stateDir ?? join(dir, "state"),
			...(opts.cache ? { MUSE_STUB_CACHE: opts.cache } : {}),
			...(opts.status ? { MUSE_STUB_STATUS: opts.status } : {}),
			...(opts.invalid ? { MUSE_STUB_INVALID: "1" } : {}),
		},
	});
	const calls = statExists(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[])
		: [];
	return { code: proc.exitCode ?? 1, out: proc.stdout.toString(), err: proc.stderr.toString(), calls };
}

function statExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function bundleFiles(dir: string): Record<string, string> {
	const root = join(dir, "bundle");
	const out: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out[path.slice(root.length + 1)] = readFileSync(path, "utf8");
	}
	return out;
}

/** Each test spawns `bun` for the projector or the hook. The default 5 s is exceeded on a loaded CI runner, so these get an explicit budget. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

describe("muse projector bundle", () => {
	test("--bundle-only writes the redactor bytes and a config with no token value", () => {
		const dir = temp();
		const result = run(dir, ["--bundle-only"]);
		expect(result.code).toBe(0);
		expect(result.calls.map((call) => call[1])).toEqual(["validate"]);
		const files = bundleFiles(dir);
		for (const text of Object.values(files)) expect(text).not.toContain(SENTINEL);
		const config = JSON.parse(files["hooks/substrate.json"] ?? "{}") as Record<string, unknown>;
		expect(Object.keys(config).sort()).toEqual(["stateDir", "tokenFile", "url"]);
		expect(config.url).toBe("http://127.0.0.1:7499");
		expect(files["hooks/post-tool-use.ts"]).not.toContain("SUBSTRATE_REDACT_MODULE");
		expect(files["hooks/post-tool-use.ts"]).not.toContain("process.env.SUBSTRATE_");
		const source = readFileSync(REDACT_SOURCE, "utf8");
		const commit = Bun.spawnSync(["git", "log", "-1", "--format=%H", "--", "packages/mcp-server/src/redact.ts"], {
			cwd: ROOT,
			stdout: "pipe",
		}).stdout.toString().trim();
		const digest = new Bun.CryptoHasher("sha256").update(source).digest("hex");
		const header = `// Generated by packages/projector/src/muse.ts from packages/mcp-server/src/redact.ts — commit ${commit}, sha256 ${digest}\n`;
		expect(files["hooks/redact.ts"]).toBe(`${header}${source}`);
	}, SPAWN_TEST_TIMEOUT_MS);

	test("a failing validate does not install", () => {
		const dir = temp();
		const result = run(dir, [], { invalid: true });
		expect(result.code).toBe(1);
		expect(result.calls.map((call) => call[1])).toEqual(["validate"]);
		expect(result.err).toContain("validate");
	}, SPAWN_TEST_TIMEOUT_MS);

	test("install then approve, and a second run updates", () => {
		const dir = temp();
		const first = run(dir, []);
		expect(first.code).toBe(0);
		expect(first.calls.map((call) => call.slice(1, 3))).toEqual([
			["validate", join(dir, "bundle")],
			["list", "--json"],
			["install", join(dir, "bundle")],
			["approve", "substrate"],
		]);
		expect(first.calls[2]).toContain("--scope");
		expect(first.calls[2]).toContain("user");
		const second = run(dir, [], { cache: join(dir, "bundle") });
		expect(second.code).toBe(0);
		expect(second.calls.map((call) => call[1])).toEqual(["validate", "list", "update", "approve"]);
		expect(second.calls.some((call) => call.includes("install"))).toBe(false);
	}, SPAWN_TEST_TIMEOUT_MS);

	test("--check is already current for a matching cache and exits 1 on drift or untrusted status", () => {
		const dir = temp();
		expect(run(dir, ["--bundle-only"]).code).toBe(0);
		const bundle = join(dir, "bundle");
		const before = statSync(join(bundle, ".muse-plugin", "plugin.json")).mtimeMs;
		const current = run(dir, ["--check"], { cache: bundle });
		expect(current.code).toBe(0);
		expect(current.out).toContain("already current");
		expect(statSync(join(bundle, ".muse-plugin", "plugin.json")).mtimeMs).toBe(before);

		writeFileSync(join(bundle, "hooks", "post-tool-use.ts"), "drift\n");
		const drifted = run(dir, ["--check"], { cache: bundle });
		expect(drifted.code).toBe(1);
		expect(drifted.out).toContain("hooks/post-tool-use.ts");

		const untrusted = run(dir, ["--check"], { cache: bundle, status: "review_needed" });
		expect(untrusted.code).toBe(1);
		expect(untrusted.out).toContain("trust");
	}, SPAWN_TEST_TIMEOUT_MS);

	test("--check notices a manifest-only drift", () => {
		const dir = temp();
		expect(run(dir, ["--bundle-only"]).code).toBe(0);
		const bundle = join(dir, "bundle");
		expect(run(dir, ["--check"], { cache: bundle }).code).toBe(0);
		writeFileSync(join(bundle, ".muse-plugin", "plugin.json"), "drift\n");
		const drifted = run(dir, ["--check"], { cache: bundle });
		expect(drifted.code).toBe(1);
		expect(drifted.out).toContain(".muse-plugin/plugin.json");
	}, SPAWN_TEST_TIMEOUT_MS);
});

describe("generated muse hook", () => {
	test("emits tool.call from muse with the origin slug, branch and payload", async () => {
		const dir = temp();
		const bodies: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as Record<string, unknown>;
				bodies.push({ body, authorization: req.headers.get("authorization") });
				return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
			},
		});
		const tokenFile = join(dir, "token.env");
		writeFileSync(tokenFile, "SUBSTRATE_TOKEN=tok\n");
		const url = `http://127.0.0.1:${server.port}`;
		expect(run(dir, ["--bundle-only"], { url, tokenFile }).code).toBe(0);
		const repo = tempGit();
		const proc = Bun.spawn(["bun", join(dir, "bundle", "hooks", "post-tool-use.ts")], {
			cwd: repo,
			env: { PATH: process.env.PATH ?? "", HOME: dir },
			stdin: new Blob([
				JSON.stringify({
					tool_name: "Read",
					session_id: "sess-1",
					tool_use_id: "call-1",
					outcome: "success",
					duration_ms: 42,
				}),
			]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		server.stop(true);
		expect(code).toBe(0);
		expect(stdout).toBe("");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.authorization).toBe("Bearer tok");
		expect(bodies[0]?.body).toEqual({
			surface: "muse",
			kind: "tool.call",
			actor: "agent",
			summary: "muse called Read",
			session_id: "sess-1",
			repo: "acme/widgets",
			branch: "main",
			payload: { tool: "Read", outcome: "success", duration_ms: 42, tool_use_id: "call-1" },
		});
	}, SPAWN_TEST_TIMEOUT_MS);

	test("single- and double-quoted tokens authorize as the bare value", async () => {
		for (const quoted of ["'tok'", '"tok"']) {
			const dir = temp();
			const seen: Array<string | null> = [];
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(req) {
					seen.push(req.headers.get("authorization"));
					return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
				},
			});
			const tokenFile = join(dir, "token.env");
			writeFileSync(tokenFile, `SUBSTRATE_TOKEN=${quoted}\n`);
			const url = `http://127.0.0.1:${server.port}`;
			expect(run(dir, ["--bundle-only"], { url, tokenFile }).code).toBe(0);
			const repo = tempGit();
			const proc = Bun.spawn(["bun", join(dir, "bundle", "hooks", "post-tool-use.ts")], {
				cwd: repo,
				env: { PATH: process.env.PATH ?? "", HOME: dir },
				stdin: new Blob([JSON.stringify({ tool_name: "Read" })]),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			server.stop(true);
			expect(code).toBe(0);
			expect(stdout).toBe("");
			expect(seen).toEqual(["Bearer tok"]);
		}
	}, SPAWN_TEST_TIMEOUT_MS);

	test("a dead url exits 0 with empty stdout, and a 400 appends a refused line", async () => {
		const dir = temp();
		const dead = run(dir, ["--bundle-only"], { url: "http://127.0.0.1:1" });
		expect(dead.code).toBe(0);
		const started = Date.now();
		const quiet = Bun.spawn(["bun", join(dir, "bundle", "hooks", "post-tool-use.ts")], {
			cwd: dir,
			env: { PATH: process.env.PATH ?? "", HOME: dir },
			stdin: new Blob([JSON.stringify({ tool_name: "Read" })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(quiet.stdout).text(), quiet.exited]);
		// A cold `bun` start on a loaded runner takes seconds; a hang would still exceed this bound.
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(code).toBe(0);
		expect(stdout).toBe("");

		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(JSON.stringify({ error: "denied" }), { status: 400 }),
		});
		const stateDir = join(dir, "state");
		mkdirSync(stateDir);
		expect(run(dir, ["--bundle-only"], { url: `http://127.0.0.1:${server.port}`, stateDir }).code).toBe(0);
		const refused = Bun.spawn(["bun", join(dir, "bundle", "hooks", "post-tool-use.ts")], {
			cwd: dir,
			env: { PATH: process.env.PATH ?? "", HOME: dir },
			stdin: new Blob([JSON.stringify({ tool_name: "Read" })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [refusedOut, refusedCode] = await Promise.all([new Response(refused.stdout).text(), refused.exited]);
		server.stop(true);
		expect(refusedCode).toBe(0);
		expect(refusedOut).toBe("");
		const line = JSON.parse(readFileSync(join(stateDir, "refused-emits.jsonl"), "utf8").trim()) as Record<string, unknown>;
		expect(Object.keys(line).sort()).toEqual(["collector", "error", "kind", "source", "status", "surface", "ts"]);
		expect(line).toMatchObject({ collector: "muse", source: "muse.tool_call", kind: "tool.call", surface: "muse", status: 400 });
	}, SPAWN_TEST_TIMEOUT_MS);
});
