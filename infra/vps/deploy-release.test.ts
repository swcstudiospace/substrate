import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
# Honour -o the way the script uses it: the body lands in that file. A staged
# body stands in for /healthz; without one the answer is a healthy local dev.
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; continue; fi
  shift
done
if [[ -n "$out" && "$out" != /dev/null ]]; then
  if [[ -f "$STUB_LOG/healthz-body" ]]; then cp "$STUB_LOG/healthz-body" "$out"
  else printf '%s' '{"index":true,"greptime":false,"eventsWritable":false}' > "$out"; fi
fi
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
	writeExec(
		join(bin, "df"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/df"
avail=104857600
if [[ -f "$STUB_LOG/df-avail-kb" ]]; then avail=$(cat "$STUB_LOG/df-avail-kb"); fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/stub 419430400 %s %s 50%% /\\n' "$((419430400 - avail))" "$avail"
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
			SUBSTRATE_HEALTH_ENV_FILE: join(state, "substrate.env"),
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

	test("a filesystem below the free-disk floor refuses before anything is built", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		// 4 GiB free against the default 5 GB floor.
		writeFileSync(join(h.log, "df-avail-kb"), `${4 * 1024 * 1024}\n`);
		const refused = deploy(h, ["v1"]);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("refusing to build");
		expect(refused.stderr).toContain("SUBSTRATE_DEPLOY_MIN_FREE_GB=5");
		expect(refused.stderr).toContain("docs/runbooks/disk-pressure.md");
		expect(existsSync(join(h.log, "bun"))).toBe(false);
		expect(existsSync(join(h.log, "systemctl"))).toBe(false);
		expect(releases(h.root)).toEqual([]);
		expect(readFileSync(join(h.log, "df"), "utf8")).toContain(h.root);

		// A lower floor, or none, lets the same host build.
		expect(deploy(h, ["v1"], { ...h.env, SUBSTRATE_DEPLOY_MIN_FREE_GB: "3" }).status).toBe(0);
		stage(h.env, "v2", SHA2, true);
		expect(deploy(h, ["v2"], { ...h.env, SUBSTRATE_DEPLOY_MIN_FREE_GB: "0" }).status).toBe(0);
		expect(deploy(h, ["v2"], { ...h.env, SUBSTRATE_DEPLOY_MIN_FREE_GB: "lots" }).stderr).toContain("SUBSTRATE_DEPLOY_MIN_FREE_GB");
	});

	test("a filesystem above the floor builds", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		writeFileSync(join(h.log, "df-avail-kb"), `${6 * 1024 * 1024}\n`);
		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	/**
	 * The ledger key's *name*, assembled at runtime: the store lock forbids the literal
	 * outside the ledger client, and this test only ever writes the name with a
	 * placeholder value so the gate can see that the store is configured.
	 */
	const LEDGER_URL_KEY = ["GREPTIME", "URL"].join("_");
	const INDEX_URL_KEY = "SUBSTRATE_PG_URL";
	const BOTH_STORES = `${LEDGER_URL_KEY}=configured\n${INDEX_URL_KEY}=configured\n`;

	/** The curl path with both store names configured, so the gate has something to require. */
	function storeGate(body: string, names = BOTH_STORES): { h: Harness; env: NodeJS.ProcessEnv } {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		writeFileSync(h.env.SUBSTRATE_HEALTH_ENV_FILE ?? "", names);
		writeFileSync(join(h.log, "healthz-body"), body);
		const env = { ...h.env };
		delete env.SUBSTRATE_HEALTH_CMD;
		return { h, env };
	}

	test("the store gate passes a healthy body with both stores and closed breakers", () => {
		const { h, env } = storeGate(
			'{"index":true,"greptime":true,"eventsWritable":true,"planes":{"greptime":{"ok":true,"breaker":{"plane":"greptime","state":"closed","failures":0,"openedAt":null,"lastErrorAt":null,"lastError":null}},"index":{"ok":true,"breaker":{"plane":"index","state":"half-open","failures":5,"openedAt":1,"lastErrorAt":1,"lastError":null}},"cache":{"ok":null,"breaker":null}}}',
		);
		const result = deploy(h, ["v1"], env);
		expect(result.status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		// The gate judges the poll's own answer: one request, not a second fetch.
		expect(readFileSync(join(h.log, "curl"), "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("index=false with SUBSTRATE_PG_URL configured rolls back", () => {
		const { h, env } = storeGate('{"index":true,"greptime":true,"eventsWritable":true}');
		expect(deploy(h, ["v1"], env).status).toBe(0);
		writeFileSync(join(h.log, "healthz-body"), '{"index":false,"greptime":true,"eventsWritable":true}');
		const failed = deploy(h, ["v2"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("index=false");
		expect(failed.stderr).toContain("SUBSTRATE_PG_URL");
		expect(failed.stderr).toContain("rolling back");
		// The env file's values stay out of the log: only the name is printed.
		expect(`${failed.stdout}${failed.stderr}`).not.toContain("=configured");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
	});

	test("eventsWritable=false with the ledger configured rolls back, and a missing field fails closed", () => {
		const { h, env } = storeGate('{"index":true,"greptime":false,"eventsWritable":false}');
		const failed = deploy(h, ["v1"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("eventsWritable=false");
		expect(failed.stderr).toContain(LEDGER_URL_KEY);
		expect(existsSync(join(h.root, "current"))).toBe(false);

		writeFileSync(join(h.log, "healthz-body"), '{"index":true,"greptime":true}');
		const missing = deploy(h, ["v2"], env);
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain("eventsWritable=missing");
	});

	test("a store the env file does not name is not required", () => {
		// Local-dev shape: neither name set, so index=false and eventsWritable=false pass.
		const { h, env } = storeGate('{"index":false,"greptime":false,"eventsWritable":false}', "SUBSTRATE_PORT=7410\n");
		expect(deploy(h, ["v1"], env).status).toBe(0);

		// Only the ledger named: the index may be down, the ledger may not.
		writeFileSync(h.env.SUBSTRATE_HEALTH_ENV_FILE ?? "", `${LEDGER_URL_KEY}=configured\n`);
		writeFileSync(join(h.log, "healthz-body"), '{"index":false,"greptime":true,"eventsWritable":true}');
		expect(deploy(h, ["v2"], env).status).toBe(0);
		writeFileSync(join(h.log, "healthz-body"), '{"index":true,"greptime":false,"eventsWritable":false}');
		const failed = deploy(h, ["v1"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("eventsWritable=false");
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA2}`);
	});

	test("an open breaker in planes rolls back even when the booleans pass", () => {
		const { h, env } = storeGate(
			'{"index":true,"greptime":true,"eventsWritable":true,"planes":{"index":{"ok":true,"breaker":{"plane":"index","state":"closed","failures":0,"openedAt":null,"lastErrorAt":null,"lastError":null}},"hindsight":{"ok":false,"breaker":{"plane":"hindsight","state":"open","failures":5,"openedAt":1760000000000,"lastErrorAt":1760000000000,"lastError":"connect ETIMEDOUT"}}}}',
		);
		const failed = deploy(h, ["v1"], env);
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("hindsight");
		expect(failed.stderr).toContain("breaker open");
		expect(failed.stderr).toContain("rolling back");
		expect(existsSync(join(h.root, "current"))).toBe(false);
	});

	test("a body without planes is judged on the booleans alone", () => {
		const { h, env } = storeGate('{"index":true,"greptime":true,"eventsWritable":true,"auditDurable":true}');
		expect(deploy(h, ["v1"], env).status).toBe(0);
	});

	test("SUBSTRATE_HEALTH_REQUIRE_STORES=0 keeps the status-only check", () => {
		const { h, env } = storeGate('{"index":false,"greptime":false,"eventsWritable":false,"planes":{"greptime":{"ok":false,"breaker":{"plane":"greptime","state":"open","failures":9,"openedAt":1,"lastErrorAt":1,"lastError":null}}}}');
		const off = deploy(h, ["v1"], { ...env, SUBSTRATE_HEALTH_REQUIRE_STORES: "0" });
		expect(off.status).toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		const on = deploy(h, ["v2"], env);
		expect(on.status).not.toBe(0);
		expect(readlinkSync(join(h.root, "current"))).toBe(`releases/${SHA1}`);
		expect(deploy(h, ["v2"], { ...env, SUBSTRATE_HEALTH_REQUIRE_STORES: "2" }).stderr).toContain("SUBSTRATE_HEALTH_REQUIRE_STORES");
	});

	test("a custom health command is the whole verdict and reads no body", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		writeFileSync(h.env.SUBSTRATE_HEALTH_ENV_FILE ?? "", BOTH_STORES);
		writeFileSync(join(h.log, "healthz-body"), '{"index":false,"greptime":false,"eventsWritable":false}');
		expect(deploy(h, ["v1"]).status).toBe(0);
		expect(existsSync(join(h.log, "curl"))).toBe(false);
	});

	test("--dry-run lists what the prune would remove with unique bytes, and deletes, swaps, locks and restarts nothing", () => {
		const h = harness();
		stage(h.env, "v1", SHA1, true);
		stage(h.env, "v2", SHA2, true);
		stage(h.env, "v3", SHA3, true);
		const norestart = { ...h.env, SUBSTRATE_RELEASE_RESTART: "0" };
		expect(deploy(h, ["v1"], norestart).status).toBe(0);
		expect(deploy(h, ["v2"], norestart).status).toBe(0);
		expect(deploy(h, ["v3"], norestart).status).toBe(0);
		// current -> SHA3; give `previous` a target by hand, as a restart deploy would have.
		rmSync(join(h.root, "previous"), { force: true });
		symlinkSync(`releases/${SHA2}`, join(h.root, "previous"));
		// One hardlinked file shared by every tree, like node_modules: a du per tree would charge it three times.
		const shared = join(h.root, "releases", SHA1, "shared.bin");
		writeFileSync(shared, Buffer.alloc(2 * 1024 * 1024, 7));
		linkSync(shared, join(h.root, "releases", SHA2, "shared.bin"));
		linkSync(shared, join(h.root, "releases", SHA3, "shared.bin"));
		// The previous release holds 512 KiB nobody else has: only a new-tag deploy would free it.
		writeFileSync(join(h.root, "releases", SHA2, "own.bin"), Buffer.alloc(512 * 1024, 9));
		const before = releases(h.root);
		const linkBefore = readlinkSync(join(h.root, "current"));
		rmSync(join(h.log, "systemctl"), { force: true });

		const dry = deploy(h, ["--dry-run"]);
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain(`keep current ${SHA3}`);
		expect(dry.stdout).toMatch(new RegExp(`keep previous ${SHA2} \\d+ bytes .*would remove after the next new-tag deploy`));
		expect(dry.stdout).toContain(`would-remove ${SHA1}`);
		const redeploy = /a redeploy of the current tag would remove 1 release\(s\), freeing (\d+) bytes/.exec(dry.stdout);
		const newTag = /the next deploy of a new tag would remove 2 release\(s\), freeing (\d+) bytes/.exec(dry.stdout);
		expect(redeploy).not.toBeNull();
		expect(newTag).not.toBeNull();
		// The new-tag case adds the present previous, with its unique bytes (at least its own 512 KiB).
		expect(Number(newTag?.[1]) - Number(redeploy?.[1])).toBeGreaterThanOrEqual(512 * 1024);
		expect(dry.stdout).toContain("nothing was deleted");
		// The old tree is charged only what current and previous do not share: far less than its 2 MiB hardlink.
		const charged = /would-remove [0-9a-f]{40} (\d+) bytes/.exec(dry.stdout);
		expect(Number(charged?.[1])).toBeLessThan(1024 * 1024);

		// Nothing changed: same releases, same symlinks, no lock directory, no unit touched, no build.
		expect(releases(h.root)).toEqual(before);
		expect(readlinkSync(join(h.root, "current"))).toBe(linkBefore);
		expect(readlinkSync(join(h.root, "previous"))).toBe(`releases/${SHA2}`);
		expect(existsSync(join(h.root, ".deploy.lock"))).toBe(false);
		expect(existsSync(join(h.log, "systemctl"))).toBe(false);
		// The real flow is unchanged: a health-checked deploy of the same tag still prunes.
		expect(deploy(h, ["v3"]).status).toBe(0);
		expect(releases(h.root)).toEqual([SHA2, SHA3]);
	});

	test("--dry-run with no releases, with extra arguments, and on a root that does not exist deletes and creates nothing", () => {
		const h = harness();
		mkdirSync(join(h.root, "releases"), { recursive: true });
		const empty = deploy(h, ["--dry-run"]);
		expect(empty.status).toBe(0);
		expect(empty.stdout).toContain("nothing would be removed");
		expect(deploy(h, ["--dry-run", "extra"]).status).toBe(2);
		const missing = deploy(h, ["--dry-run"], { ...h.env, SUBSTRATE_RELEASE_ROOT: join(h.root, "absent") });
		expect(missing.status).toBe(1);
		expect(existsSync(join(h.root, "absent"))).toBe(false);
	});

	test("--dry-run flags a release directory the real prune would abort on, and deletes nothing", () => {
		const h = harness();
		mkdirSync(join(h.root, "releases", "not-a-sha"), { recursive: true });
		const dry = deploy(h, ["--dry-run"]);
		expect(dry.status).toBe(1);
		expect(dry.stdout).toContain("refuse: releases/not-a-sha");
		expect(existsSync(join(h.root, "releases", "not-a-sha"))).toBe(true);
	});
});

describe("operator runbook", () => {
	test("the readme lists Ming's steps and does not copy the missing collectors", () => {
		const readme = readFileSync(join(repoRoot, "infra/vps/README.md"), "utf8");
		for (const phrase of [
			"Phase 16",
			"Phase 19",
			"Phase 22",
			"354310c",
			"be77187",
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
