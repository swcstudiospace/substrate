import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const script = join(repoRoot, "infra/vps/deploy-release.sh");

const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const SHA3 = "3333333333333333333333333333333333333333";

interface Harness {
	root: string;
	log: string;
	env: NodeJS.ProcessEnv;
}

function writeExec(path: string, body: string): void {
	writeFileSync(path, body);
	spawnSync("chmod", ["+x", path]);
}

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "deploy-release-"));
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	const log = join(dir, "log");
	const root = join(dir, "opt");
	const repo = join(dir, "repo");
	mkdirSync(bin);
	mkdirSync(join(state, "tags"), { recursive: true });
	mkdirSync(join(state, "trees"), { recursive: true });
	mkdirSync(log);
	mkdirSync(repo);
	writeFileSync(join(state, "main"), "");

	writeExec(
		join(bin, "git"),
		`#!/usr/bin/env bash
set -euo pipefail
args=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-C" ]]; then shift 2; continue; fi
  args+=("$1"); shift
done
printf '%s\\n' "\${args[*]}" >> "$STUB_LOG/git"
cmd="\${args[0]:-}"
case "$cmd" in
  show-ref)
    tag="\${args[3]#refs/tags/}"
    [[ -f "$STUB_STATE/tags/$tag" ]]
    ;;
  rev-parse)
    spec="\${args[2]}"
    tag="\${spec%%^*}"
    cat "$STUB_STATE/tags/$tag"
    ;;
  merge-base)
    grep -qx "\${args[2]}" "$STUB_STATE/main"
    ;;
  archive)
    tar -C "$STUB_STATE/trees/\${args[2]}" -c .
    ;;
  *)
    printf '%s\\n' "unexpected git \${args[*]}" >&2
    exit 1
    ;;
esac
`,
	);
	writeExec(
		join(bin, "bun"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/bun"
printf '%s\\n' "$PWD" >> "$STUB_LOG/bun-cwd"
if [[ "\${FAIL_BUN:-}" == "1" ]]; then exit 1; fi
mkdir -p node_modules
`,
	);
	writeExec(
		join(bin, "systemctl"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/systemctl"
if [[ "$1" == "show" ]]; then
  unit="\${!#}"
  key="$STUB_LOG/show-count-\$unit"
  count=0
  if [[ -f "\$key" ]]; then count=\$(cat "\$key"); fi
  count=\$((count + 1))
  printf '%s\\n' "\$count" > "\$key"
  if [[ "\${FAIL_LOOP:-}" == "1" && "\$unit" == "substrate-collector-grok.service" && \$((count % 2)) -eq 0 ]]; then
    printf 'ActiveState=activating\\nSubState=auto-restart\\nNRestarts=1\\n'
  else
    printf 'ActiveState=active\\nSubState=running\\nNRestarts=0\\n'
  fi
  exit 0
fi
if [[ "$1" == "is-active" && "\${FAIL_ACTIVE:-}" == "1" ]]; then exit 1; fi
if [[ "\${FAIL_SYSTEMCTL:-}" == "1" ]]; then exit 1; fi
`,
	);
	writeExec(
		join(bin, "sleep"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/sleep"
`,
	);
	writeExec(
		join(bin, "curl"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/curl"
if [[ -f "$STUB_LOG/curl-codes" ]]; then
  count=0
  if [[ -f "$STUB_LOG/curl-count" ]]; then count=$(cat "$STUB_LOG/curl-count"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$STUB_LOG/curl-count"
  line=$(sed -n "\${count}p" "$STUB_LOG/curl-codes")
  if [[ -z "$line" ]]; then line=$(tail -n 1 "$STUB_LOG/curl-codes"); fi
  printf '%s' "$line"
else
  printf '200'
fi
`,
	);
	const health = join(bin, "health");
	writeExec(
		health,
		`#!/usr/bin/env bash
if [[ -f "$STUB_LOG/fail-health" ]]; then exit 1; fi
printf '%s\\n' ok >> "$STUB_LOG/health"
`,
	);

	return {
		root,
		log,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			SUBSTRATE_RELEASE_ROOT: root,
			SUBSTRATE_REPO: repo,
			SUBSTRATE_HEALTH_CMD: health,
			SUBSTRATE_HEALTH_DEADLINE: "5",
			SUBSTRATE_HEALTH_INTERVAL: "0",
			SUBSTRATE_UNIT_SETTLE: "0",
			STUB_LOG: log,
			STUB_STATE: state,
			FAIL_BUN: "",
			FAIL_SYSTEMCTL: "",
			FAIL_ACTIVE: "",
			FAIL_LOOP: "",
		},
	};
}

function stage(env: NodeJS.ProcessEnv, tag: string, sha: string, onMain: boolean): void {
	const state = env.STUB_STATE ?? "";
	writeFileSync(join(state, "tags", tag), `${sha}\n`);
	const tree = join(state, "trees", sha);
	mkdirSync(join(tree, "packages/mcp-server/src"), { recursive: true });
	mkdirSync(join(tree, "packages/collectors/src"), { recursive: true });
	writeFileSync(join(tree, "package.json"), "{}\n");
	writeFileSync(join(tree, "bun.lock"), "{}\n");
	writeFileSync(join(tree, "packages/mcp-server/src/index.ts"), "");
	writeFileSync(join(tree, "packages/collectors/src/grok.ts"), "");
	writeFileSync(join(tree, "packages/collectors/src/herdr.ts"), "");
	writeFileSync(join(tree, "packages/collectors/src/muse.ts"), "");
	if (onMain) writeFileSync(join(state, "main"), `${readFileSync(join(state, "main"), "utf8")}${sha}\n`);
}

function deploy(h: Harness, args: string[], env: NodeJS.ProcessEnv = h.env) {
	return spawnSync(script, args, { env, encoding: "utf8" });
}

function releases(root: string): string[] {
	const dir = join(root, "releases");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).sort();
}

describe("deploy-release.sh", () => {
	test("a tagged commit on main becomes current and keeps one previous", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		stage(h.env, "v3", SHA3, true);

		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(deploy(h, ["v2"]).status).toBe(0);
		const third = deploy(h, ["v3"]);
		expect(third.status).toBe(0);
		expect(third.stdout.trim()).toBe(`current -> releases/${SHA3}`);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA3}`);
		expect(readlinkSync(join(h.root, "previous"))).toBe(`releases/${SHA2}`);
		expect(releases(h.root)).toEqual([SHA2, SHA3]);
		expect(readFileSync(join(h.log, "bun"), "utf8")).toContain("install --frozen-lockfile");
		const restarted = readFileSync(join(h.log, "systemctl"), "utf8");
		expect(restarted).toContain("daemon-reload");
		expect(restarted).toContain("is-active --quiet substrate-mcp.service");
		expect(restarted).toContain("restart substrate-mcp.service");
		expect(restarted).toContain("restart substrate-collector-grok.service");
		expect(restarted).toContain("restart substrate-collector-herdr.service");
		expect(restarted).toContain("restart substrate-collector-muse.service");
		expect(restarted).not.toContain("dispatcher");
		expect(restarted).not.toContain("skills");
	});

	test("a failed health check rolls current back and the next success drops the failed tree", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		stage(h.env, "v3", SHA3, true);
		expect(deploy(h, ["v1"]).status).toBe(0);

		writeFileSync(join(h.log, "fail-health"), "1");
		const failed = deploy(h, ["v2"]);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("rolling back");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		expect(releases(h.root)).toContain(SHA2);

		rmSync(join(h.log, "fail-health"));
		expect(deploy(h, ["v3"]).status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA3}`);
		expect(readlinkSync(join(h.root, "previous"))).toBe(`releases/${SHA1}`);
		expect(releases(h.root)).toEqual([SHA1, SHA3]);
	});

	test("a failed restart rolls current back to the previous release", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		expect(deploy(h, ["v1"]).status).toBe(0);
		const failed = deploy(h, ["v2"], { ...h.env, FAIL_SYSTEMCTL: "1" });
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("rolling back");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	test("the first release is not left current when its health check fails", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		writeFileSync(join(h.log, "fail-health"), "1");
		expect(deploy(h, ["v1"]).status).not.toBe(0);
		expect(existsSync(join(h.root, "current"))).toBe(false);
	});

	test("rollback points current at the previous release", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(deploy(h, ["v2"]).status).toBe(0);
		const rolled = deploy(h, ["rollback"]);
		expect(rolled.status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		expect(readlinkSync(join(h.root, "previous"))).toBe(`releases/${SHA2}`);
	});

	test("a refused ref does not swap current", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		expect(deploy(h, ["v1"]).status).toBe(0);

		const notTag = deploy(h, ["main"]);
		expect(notTag.status).not.toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);

		stage(h.env, "side", SHA2, false);
		const offMain = deploy(h, ["side"]);
		expect(offMain.status).not.toBe(0);
		expect(offMain.stderr).toContain("not on main");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		expect(releases(h.root)).toEqual([SHA1]);
	});

	test("a tag name that escapes the release root is refused before git runs", () => {
		const h = harness();
		const escaped = deploy(h, ["../evil"]);
		expect(escaped.status).not.toBe(0);
		expect(existsSync(join(h.log, "git"))).toBe(false);
		expect(existsSync(h.root)).toBe(false);
	});

	test("a failed frozen install does not publish current", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		const env = { ...h.env, FAIL_BUN: "1" };
		const failed = deploy(h, ["v1"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("bun install failed");
		expect(existsSync(join(h.root, "current"))).toBe(false);
		expect(releases(h.root)).toEqual([]);
		expect(existsSync(join(h.log, "systemctl"))).toBe(false);
	});

	test("the default health check is a local curl and does not take a credential in the url", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		const env = { ...h.env };
		delete env.SUBSTRATE_HEALTH_CMD;
		expect(deploy(h, ["v1"], env).status).toBe(0);
		const curl = readFileSync(join(h.log, "curl"), "utf8");
		expect(curl).toContain("--max-time");
		expect(curl).toContain("http_code");
		expect(curl).toContain("http://127.0.0.1:7410/healthz");

		const envBad = { ...env, SUBSTRATE_HEALTH_URL: "http://user:secret@127.0.0.1:7410/healthz" };
		stage(h.env, "v2", SHA2, true);
		const refused = deploy(h, ["v2"], envBad);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("refusing health url");
		expect(readFileSync(join(h.log, "curl"), "utf8")).not.toContain("secret");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	test("a release missing a unit entry is not published", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		const tree = join(h.env.STUB_STATE ?? "", "trees", SHA1);
		rmSync(join(tree, "packages/collectors/src/grok.ts"));
		const failed = deploy(h, ["v1"]);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("missing packages/collectors/src/grok.ts");
		expect(existsSync(join(h.root, "current"))).toBe(false);
		expect(existsSync(join(h.log, "systemctl"))).toBe(false);
	});

	test("a collector that restart-loops during the settle window rolls current back", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		expect(deploy(h, ["v1"]).status).toBe(0);
		const failed = deploy(h, ["v2"], { ...h.env, FAIL_LOOP: "1", SUBSTRATE_UNIT_SETTLE: "2" });
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("substrate-collector-grok.service");
		expect(failed.stderr).toContain("restart-looping");
		expect(failed.stderr).toContain("rolling back");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		expect(readFileSync(join(h.log, "sleep"), "utf8")).toContain("2");
		const shown = readFileSync(join(h.log, "systemctl"), "utf8");
		expect(shown).toContain("show");
		expect(shown).toContain("NRestarts");
		expect(shown).toContain("substrate-collector-grok.service");
	});

	test("a unit that is not active rolls current back", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		expect(deploy(h, ["v1"]).status).toBe(0);
		const failed = deploy(h, ["v2"], { ...h.env, FAIL_ACTIVE: "1" });
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("is not active");
		expect(failed.stderr).toContain("rolling back");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	test("connection refused is retried and a later 200 is accepted", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		writeFileSync(join(h.log, "curl-codes"), "000\n200\n");
		const env = { ...h.env };
		delete env.SUBSTRATE_HEALTH_CMD;
		expect(deploy(h, ["v1"], env).status).toBe(0);
		expect(readFileSync(join(h.log, "curl"), "utf8").trim().split("\n")).toHaveLength(2);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	test("healthz 401 fails closed and names the token file without a secret", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		writeFileSync(join(h.log, "curl-codes"), "401\n");
		const env = { ...h.env };
		delete env.SUBSTRATE_HEALTH_CMD;
		const failed = deploy(h, ["v1"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("401");
		expect(failed.stderr).toContain("SUBSTRATE_HEALTH_TOKEN_FILE");
		expect(failed.stderr).not.toContain("failed after");
		expect(readFileSync(join(h.log, "curl"), "utf8").trim().split("\n")).toHaveLength(1);
		expect(existsSync(join(h.root, "current"))).toBe(false);
	});

	test("a bearer file is passed to curl as a config and is not printed", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		const token = "substrate-test-token-value";
		const tokenFile = join(h.log, "token");
		writeFileSync(tokenFile, `${token}\n`);
		const env = { ...h.env, SUBSTRATE_HEALTH_TOKEN_FILE: tokenFile };
		delete env.SUBSTRATE_HEALTH_CMD;
		const result = deploy(h, ["v1"], env);
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain(token);
		expect(result.stderr).not.toContain(token);
		const curl = readFileSync(join(h.log, "curl"), "utf8");
		expect(curl).not.toContain(token);
		expect(curl).toContain("-K ");
		const config = /-K (\S+)/.exec(curl)?.[1] ?? "";
		expect(config).not.toBe("");
		expect(existsSync(config)).toBe(false);
	});

	test("a no-restart publish keeps every release directory", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		stage(h.env, "v3", SHA3, true);
		const env = { ...h.env, SUBSTRATE_RELEASE_RESTART: "0" };
		expect(deploy(h, ["v1"], env).status).toBe(0);
		expect(deploy(h, ["v2"], env).status).toBe(0);
		expect(deploy(h, ["v3"], env).status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA3}`);
		expect(releases(h.root)).toEqual([SHA1, SHA2, SHA3]);
		expect(existsSync(join(h.log, "systemctl"))).toBe(false);
		expect(deploy(h, ["v3"]).status).toBe(0);
		expect(releases(h.root)).toEqual([SHA2, SHA3]);
	});

	test("deploying the same tag again does not reinstall", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(readFileSync(join(h.log, "bun-cwd"), "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe("operator runbook", () => {
	test("the readme lists Ming's steps and does not copy the missing collectors", () => {
		const readme = readFileSync(join(repoRoot, "infra/vps/README.md"), "utf8");
		for (const phrase of [
			"Phase 16",
			"Phase 19",
			"Phase 22",
			"plans 22-01 to 22-03",
			"substrate-skills-sync.timer",
			"substrate-skills-bridge.timer",
			"SUBSTRATE_DISPATCH_DISABLED",
			"SUBSTRATE_AUDIT_PATH",
			"herdr",
			"muse",
			"ProtectHome=false",
			"/healthz",
			"rollback",
			"one at a time",
			"daemon-reload",
			"no previous release",
			"SUBSTRATE_HEALTH_TOKEN_FILE",
			"SUBSTRATE_RELEASE_RESTART=0",
			"SUBSTRATE_UNIT_SETTLE",
		]) {
			expect(readme).toContain(phrase);
		}
		expect(readme).not.toContain("SWARM_ED25519_KEY");
		expect(readme).not.toContain("BEGIN OPENSSH PRIVATE KEY");
	});
});
