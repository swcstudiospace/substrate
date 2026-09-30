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

/**
 * Whether a file's text holds a Greptime endpoint or credential.
 *
 * Line-based and comment-exempt: `.env.example` has to be able to show the shape
 * of a Railway host and the docs have to be able to name one.
 *
 * The key may be quoted and so may the value, because a credential is as likely to
 * sit in a tracked JSON or YAML config (`"GREPTIME_PASSWORD": "…"`) as in an env
 * file. The value must start with something that is neither whitespace nor a quote,
 * so an empty placeholder — `GREPTIME_PASSWORD=` or `"GREPTIME_PASSWORD": ""` —
 * does not read as a secret.
 */
const CREDENTIAL = /GREPTIME_(?:URL|USER|PASSWORD)["']?\s*[:=]\s*["']?[^\s"']/i;
const RAILWAY_HOST = /[a-z0-9-]+\.(?:up\.railway\.app|proxy\.rlwy\.net)/i;

function carriesCredential(body: string): boolean {
	return body
		.split("\n")
		.filter((line) => !/^\s*(?:#|\/\/|\*|<!--)/.test(line))
		.some((line) => CREDENTIAL.test(line) || RAILWAY_HOST.test(line));
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

/**
 * Files that may hand a statement to the ledger client.
 *
 * `greptime.ts` owns the statements; `brief.ts` composes the one read the briefing
 * needs. Everything else — the MCP tools, the HTTP routes, the service — asks for
 * events through a typed method. That is what keeps the read path from becoming an
 * arbitrary SQL door onto `agent_events`: a caller supplies values, never syntax.
 */
const MAY_SEND_SQL = new Set(["greptime.ts", "brief.ts"]);

describe("no caller reaches the ledger with SQL", () => {
	test("only the ledger client and the brief compose statements", async () => {
		const offenders = (await filesMatching(`${LEDGER_PACKAGE}/*.ts`))
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => !MAY_SEND_SQL.has(path.split("/").at(-1) ?? ""))
			// A file that both names the ledger and sends a statement. `index-store.ts`
			// sends plenty, but to Postgres — the index is not the ledger.
			.filter((path) => {
				const body = read(path);
				return /greptime/i.test(body) && /\.sql\(/.test(body);
			});

		expect(offenders).toEqual([]);
	});

	test("the query tool's filters are columns this package names, not a caller's string", () => {
		// `events_query` and `POST /events/query` take a fixed set of typed filters. If a
		// tool ever took a statement, a summary, or a column name, the redaction and
		// append-only guarantees on the write path would still hold — but every row in the
		// ledger would be reachable by whatever SQL a caller cared to send.
		for (const file of ["mcp.ts", "server.ts", "service.ts"]) {
			// The offending lines, not the file: a failure here should read as a diff.
			const offending = read(join(LEDGER_PACKAGE, file))
				.split("\n")
				.filter((line) => /\b(?:sql|statement)\s*:/.test(line) || /\bSELECT\s/i.test(line));

			expect({ file, offending }).toEqual({ file, offending: [] });
		}
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
		const offenders = trackedFiles()
			.filter((path) => path !== relative(ROOT, import.meta.path))
			.filter((path) => carriesCredential(read(path)));

		expect(offenders).toEqual([]);
	});

	test("the scan covers every tracked env file, whatever its suffix", () => {
		// `git ls-files` is what makes this true without enumerating suffixes, so the
		// list it returns is asserted rather than assumed.
		const tracked = trackedFiles();
		expect(tracked).toContain(".env.example");
		expect(tracked.some((path) => path.endsWith("store-lock.test.ts"))).toBe(true);

		// And the detector itself catches what such a file would hold.
		for (const body of [
			"GREPTIME_PASSWORD=hunter2",
			"GREPTIME_URL=https://greptime-prod.up.railway.app",
			"GREPTIME_USER=admin",
			'  greptime_url: "https://x.proxy.rlwy.net:1234"',
		]) {
			expect(carriesCredential(body)).toBe(true);
		}
	});

	test("the scan catches a credential whose key is quoted", () => {
		// A credential is as likely to sit in a tracked JSON or YAML config as in an
		// env file, and requiring `:` immediately after the key missed all of those.
		for (const body of [
			'{ "GREPTIME_PASSWORD": "hunter2" }',
			"  'GREPTIME_USER' = 'admin'",
			'greptime:\n  GREPTIME_PASSWORD: "hunter2"',
		]) {
			expect(carriesCredential(body)).toBe(true);
		}
	});

	test("the scan does not fire on a placeholder or a comment", () => {
		// `.env.example` must be able to show the shape of a host, and the docs must
		// be able to name one, without failing the lock.
		for (const body of [
			"GREPTIME_PASSWORD=",
			"GREPTIME_DB=public",
			'{ "GREPTIME_PASSWORD": "" }',
			"# e.g. https://greptime-xxxx.up.railway.app",
			"// GREPTIME_URL=https://example.up.railway.app",
		]) {
			expect(carriesCredential(body)).toBe(false);
		}
	});
});
