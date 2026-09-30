/**
 * The store lock, enforced against the tree rather than only written down.
 *
 * Four rules that a reviewer would otherwise have to remember:
 *
 *   1. Greptime is reached only through substrate-mcp. If a collector, the CLI or
 *      the projector grew its own client, redaction and the hash chain would no
 *      longer be unskippable — they live on this package's write path.
 *   2. No agent gets Greptime as an MCP server of its own. A native Greptime MCP
 *      would be a second, unredacted door to the same table.
 *   3. No Greptime credential is ever committed.
 *   4. Memory is written only through the governance gate. Same argument as the
 *      first rule: the reason RBAC, quarantine and exactly-once cannot be
 *      forgotten is that there is no second door past them.
 *
 * See `docs/greptime-ledger.md` and `docs/memory-governance.md`.
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
 * The two files allowed to know how a memory entry is written.
 *
 * `index-store.ts` holds the SQL; `memory-write.ts` is the gate that decides
 * whether the SQL runs. Everything else — the MCP tools, the REST routes, the
 * service — goes through `Substrate.writeMemory`, which goes through the gate.
 */
const MEMORY_WRITE_PATH = [join(LEDGER_PACKAGE, "index-store.ts"), join(LEDGER_PACKAGE, "memory-write.ts")];

describe("memory is written only through the governance gate", () => {
	test("nothing outside the MCP server names a memory table in SQL", async () => {
		// A collector or hook writing memory directly would be a write with no RBAC
		// check, no quarantine pass, no idempotency key and no read-back — which is
		// every property the gate exists to provide.
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !path.startsWith(LEDGER_PACKAGE))
			.filter((path) =>
				/(FROM|INTO|UPDATE|TABLE)\s+"?memory_(entries|writes|reviews|quarantine)"?/i.test(read(path)),
			);

		expect(offenders).toEqual([]);
	});

	test("one file inserts an entry, and one file decides that it may", async () => {
		// Asserted as a set rather than a ceiling: the failure mode is a *new* caller
		// reaching past the gate, and that shows up here as an extra path.
		const callers = (await filesMatching("**/*.ts"))
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => /\binsertEntry\b/.test(read(path)))
			.sort();

		expect(callers).toEqual([...MEMORY_WRITE_PATH].sort());
	});

	test("the service reaches memory only through the gate", async () => {
		// `Substrate` holds the index, so it *could* call the store's write primitives
		// directly. It calls governMemoryWrite instead, and that is the whole lock.
		const service = read(join(LEDGER_PACKAGE, "service.ts"));

		expect(service).toContain("governMemoryWrite");
		for (const primitive of ["insertEntry", "claimWrite", "quarantineEntry", "enqueueReview", "supersede"]) {
			expect(service).not.toContain(`index.${primitive}`);
		}
	});

	test("no ungoverned writeMemory survives on the store", async () => {
		// The Phase 0 method took an entry and inserted it. Leaving it in place beside
		// the gate would have made the gate optional.
		expect(read(join(LEDGER_PACKAGE, "index-store.ts"))).not.toMatch(/async\s+writeMemory\s*\(/);
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
