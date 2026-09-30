/**
 * The store lock, enforced against the tree rather than only written down.
 *
 * Three rules that a reviewer would otherwise have to remember:
 *
 *   1. Greptime is reached only through substrate-mcp. If a collector, the CLI or
 *      the projector grew its own client, redaction and the hash chain would no
 *      longer be unskippable — they live on this package's write path.
 *   2. No agent gets Greptime as an MCP server of its own. A native Greptime MCP
 *      would be a second, unredacted door to the same table.
 *   3. No Greptime credential is ever committed.
 *
 * See `docs/greptime-ledger.md`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const LEDGER_PACKAGE = join("packages", "mcp-server", "src");

/**
 * The one file outside this package allowed to hold the ledger client.
 *
 * `scripts/greptime-smoke.ts` is the live proof harness: it drives
 * `Substrate.emit` and `GreptimeClient` deliberately — including the UPDATE and
 * DELETE it expects to be refused — rather than reaching around them. Naming it
 * rather than exempting `scripts/` wholesale means the next file that wants
 * direct access has to be argued for here.
 */
const SMOKE_HARNESS = join("scripts", "greptime-smoke.ts");

const IGNORED = ["node_modules/", ".git/", "dist/"];

/** Files that may talk to Greptime directly. */
function mayReachLedger(path: string): boolean {
	return path.startsWith(LEDGER_PACKAGE) || path === SMOKE_HARNESS;
}

/**
 * `dot: true` matters more than it looks: an MCP server is registered in
 * `.mcp.json` or `.cursor/mcp.json`, and a scan that skipped dotfiles would let
 * exactly the wiring this file forbids through.
 */
async function filesMatching(pattern: string): Promise<string[]> {
	const found: string[] = [];
	for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, dot: true })) {
		if (!IGNORED.some((prefix) => path.includes(prefix))) found.push(path);
	}
	return found;
}

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/** Every file git tracks, so the secret scan covers what is actually committed. */
function trackedFiles(): string[] {
	const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
	if (!listed.success) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
	return listed.stdout
		.toString()
		.split("\0")
		.filter((path) => path.length > 0);
}

describe("Greptime is reachable only through substrate-mcp", () => {
	test("no package outside the MCP server imports the ledger client", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /from\s+["'][^"']*greptime(\.ts)?["']|new\s+GreptimeClient/.test(read(path)));

		expect(offenders).toEqual([]);
	});

	test("nothing else names the events table in SQL", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /(FROM|INTO|UPDATE|TABLE)\s+"?agent_events"?/i.test(read(path)));

		expect(offenders).toEqual([]);
	});

	test("nothing else reads GREPTIME_ from the environment", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /GREPTIME_/.test(read(path)));

		expect(offenders).toEqual([]);
	});
});

describe("no native Greptime MCP wiring", () => {
	test("no agent config registers Greptime as an MCP server", async () => {
		// Config files only: prose in the README and in docs/ has to be free to say
		// that this wiring is forbidden.
		const configs = [
			...(await filesMatching("**/*.json")),
			...(await filesMatching("**/*.{yaml,yml}")),
			...(await filesMatching("**/*.toml")),
			...(await filesMatching("packages/projector/**/*.ts")),
		];

		const offenders = configs.filter((path) => {
			const body = read(path);
			const registersServers = /mcpServers|mcp_servers|AddMcpServer|addMcpServer/.test(body);
			return registersServers && /greptime/i.test(body);
		});

		expect(offenders).toEqual([]);
	});
});

describe("no secrets in the repo", () => {
	test(".env.example declares the Greptime keys and fills none of them in", () => {
		const lines = read(".env.example").split("\n");
		const greptime = lines.filter((line) => /^GREPTIME_/.test(line));

		expect(greptime.map((line) => line.split("=")[0])).toEqual([
			"GREPTIME_URL",
			"GREPTIME_USER",
			"GREPTIME_PASSWORD",
			"GREPTIME_DB",
		]);
		for (const line of greptime) {
			const [key, value = ""] = line.split("=");
			// GREPTIME_DB names a database, not a credential, so it carries a default.
			if (key === "GREPTIME_DB") expect(value).toBe("public");
			else expect(value).toBe("");
		}
	});

	test("no tracked file carries a Greptime endpoint or credential", () => {
		// Asked of git rather than of a glob: the claim is about what is *in the
		// repository*, so a tracked `.env.production` — exactly where a deployment
		// credential would sit — has to be covered, while an operator's untracked
		// local `.env` must not fail their test run.
		const tracked = trackedFiles().filter((path) => path !== relative(ROOT, import.meta.path));

		// Comments are exempt: `.env.example` has to be able to show the shape of a
		// Railway host, and the docs have to be able to name one.
		const isComment = (line: string) => /^\s*(?:#|\/\/|\*|<!--)/.test(line);

		const offenders = tracked.filter((path) =>
			read(path)
				.split("\n")
				.filter((line) => !isComment(line))
				.some(
					(line) =>
						/GREPTIME_(?:URL|USER|PASSWORD)\s*[:=]\s*\S/.test(line) ||
						/[a-z0-9-]+\.(?:up\.railway\.app|proxy\.rlwy\.net)/i.test(line),
				),
		);

		expect(offenders).toEqual([]);
	});
});
