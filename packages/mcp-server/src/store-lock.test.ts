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

const walks = new Map<string, Promise<string[]>>();

/**
 * `dot: true` matters more than it looks: an MCP server is registered in
 * `.mcp.json` or `.cursor/mcp.json`, and a scan that skipped dotfiles would let
 * exactly the wiring this file forbids through.
 *
 * Memoised per pattern: the directory walk is the cost, and files do not change
 * during a test run. No caller mutates the shared array (they filter or spread first).
 */
function filesMatching(pattern: string): Promise<string[]> {
	const cached = walks.get(pattern);
	if (cached !== undefined) return cached;
	const walk = (async () => {
		const found: string[] = [];
		for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, dot: true })) {
			if (!IGNORED.some((prefix) => path.includes(prefix))) found.push(path);
		}
		return found;
	})();
	walks.set(pattern, walk);
	return walk;
}

const contents = new Map<string, string>();

// Memoised for the same reason as the walk: many tests re-read every file.
function read(path: string): string {
	const cached = contents.get(path);
	if (cached !== undefined) return cached;
	const text = readFileSync(join(ROOT, path), "utf8");
	contents.set(path, text);
	return text;
}

/** Tests that walk the tree or read every tracked file are slow under host load; Bun's 5 s default is too tight. */
const SCAN_TIMEOUT_MS = 60_000;

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

/**
 * A substrate bearer token assigned a literal value (ADR 0001 S4 criterion 3).
 *
 * The key is any `SUBSTRATE_TOKEN*`: the server's `SUBSTRATE_TOKEN_<SURFACE>` and the client's `SUBSTRATE_TOKEN` are
 * the same secret under two names. A value counts when it is at least 16 token characters, which a generated token is
 * (docs/swarm-workspace.md says 32 random bytes) and which the test fixtures (`tok-a05`) and the docs' placeholders
 * (`…`, `<that agent's token>`, `${SUBSTRATE_TOKEN}`) are not. Code that reads the variable rather than holding a
 * value, `SUBSTRATE_TOKEN: process.env.X`, is not a value either.
 *
 * Unlike the Greptime matcher, a comment is not exempt: a token pasted into a comment is just as committed. The
 * separator is matched within one line, so an empty `SUBSTRATE_TOKEN_X=` followed by the next variable's name (as in
 * `.env.example`) is not read as a value.
 */
const TOKEN_LITERAL = /SUBSTRATE_TOKEN[A-Z0-9_]*["']?[ \t]*[:=][ \t]*["']?(?!process\.env|os\.environ|Bun\.env|env\.)[\w.~+/=-]{16,}/;

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
	}, SCAN_TIMEOUT_MS);

	test("nothing else names the events table in SQL", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /(FROM|INTO|UPDATE|TABLE)\s+"?agent_events"?/i.test(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("nothing else reads GREPTIME_ from the environment", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /GREPTIME_/.test(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
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
	}, SCAN_TIMEOUT_MS);

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
	}, SCAN_TIMEOUT_MS);

	test("one file inserts an entry, and one file decides that it may", async () => {
		// Asserted as a set rather than a ceiling: the failure mode is a *new* caller
		// reaching past the gate, and that shows up here as an extra path.
		const callers = (await filesMatching("**/*.ts"))
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => /\binsertEntry\b/.test(read(path)))
			.sort();

		expect(callers).toEqual([...MEMORY_WRITE_PATH].sort());
	}, SCAN_TIMEOUT_MS);

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
			// The projector's sources, not its tests: a test asserting that no generated file names
			// Greptime has to name it, and is the enforcement of this rule where the configs land.
			...(await filesMatching("packages/projector/**/*.ts")).filter((path) => !path.endsWith(".test.ts")),
		];

		const offenders = configs.filter((path) => {
			const body = read(path);
			const registersServers = /mcpServers|mcp_servers|AddMcpServer|addMcpServer/.test(body);
			return registersServers && /greptime/i.test(body);
		});

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
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
	}, SCAN_TIMEOUT_MS);

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
	}, SCAN_TIMEOUT_MS);

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

	test("no tracked file assigns a substrate token a value", () => {
		// The swarm workspace install names `${SUBSTRATE_TOKEN}` in every config it writes and keeps the value in
		// an env file outside every checkout. A committed value, under either the server's or the client's name,
		// would undo both halves.
		const offenders = trackedFiles()
			.filter((path) => path !== relative(ROOT, import.meta.path))
			.filter((path) => TOKEN_LITERAL.test(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("the token scan catches a value under either name, in an env file or a config", () => {
		for (const body of [
			"SUBSTRATE_TOKEN=3f9a1c0e7b2d4a6f8e1c3b5d7a9f0e2c",
			"SUBSTRATE_TOKEN_SWARM_A05_BE=3f9a1c0e7b2d4a6f8e1c3b5d7a9f0e2c",
			'{ "SUBSTRATE_TOKEN_HERMES": "N2Q4YjVmZTMtOTc0Ni00Y2Jm" }',
			"  SUBSTRATE_TOKEN_CURSOR: 'sk_live_0123456789abcdef'",
			"# SUBSTRATE_TOKEN=3f9a1c0e7b2d4a6f8e1c3b5d7a9f0e2c",
		]) {
			expect({ body, caught: TOKEN_LITERAL.test(body) }).toEqual({ body, caught: true });
		}
	});

	test("the token scan does not fire on a blank, a placeholder, a reference or a short fixture", () => {
		for (const body of [
			"SUBSTRATE_TOKEN_SWARM_A05_BE=",
			// An empty value followed by the next variable, as `.env.example` lists them: not a value.
			"SUBSTRATE_TOKEN_CLAUDE_CODE=\nSUBSTRATE_TOKEN_HERMES=\n",
			"SUBSTRATE_TOKEN_CLAUDE_CODE=…",
			"SUBSTRATE_TOKEN=<that agent's token>",
			'headers = { Authorization = "Bearer ${SUBSTRATE_TOKEN}" }',
			"SUBSTRATE_TOKEN=${SUBSTRATE_TOKEN_SWARM_A05_BE}",
			'SUBSTRATE_TOKEN_HERMES: "tok-hermes",',
			"SUBSTRATE_TOKEN: process.env.SUBSTRATE_TOKEN_SWARM_A05_BE,",
		]) {
			expect({ body, caught: TOKEN_LITERAL.test(body) }).toEqual({ body, caught: false });
		}
	});
});

/**
 * The substrate-only door (D25-01): lightrag is reached ONLY through
 * `substrate-mcp` (`planes/docs-wire.ts`). No lightrag MCP server appears in
 * any agent config, and no package outside `mcp-server` imports the client.
 */
describe("lightrag is reachable only through substrate-mcp", () => {
	test("no agent config registers a lightrag MCP server", async () => {
		// Config files only: prose in the README and in docs/ has to be free
		// to say that this wiring is forbidden.
		const configs = [
			...(await filesMatching("**/*.json")),
			...(await filesMatching("**/*.{yaml,yml}")),
			...(await filesMatching("**/*.toml")),
			// The projector's sources, not its tests: a test asserting that no
			// generated file names lightrag has to name it, and is the
			// enforcement of this rule where the configs land.
			...(await filesMatching("packages/projector/**/*.ts")).filter((path) => !path.endsWith(".test.ts")),
		];

		const offenders = configs.filter((path) => {
			const body = read(path);
			const registersServers = /mcpServers|mcp_servers|AddMcpServer|addMcpServer/.test(body);
			return registersServers && /lightrag/i.test(body);
		});

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("no package outside the MCP server imports the lightrag client", async () => {
		// Mirrors the ledger-client test above. The CLI proves its cap against
		// the engine by reading the file as text rather than importing it for
		// exactly this reason — a string naming the file is not an import.
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !path.startsWith(LEDGER_PACKAGE))
			.filter((path) =>
				/(from\s+["'][^"']*|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*(planes\/lightrag|docs-search|docs-ingest|lightrag-fake)/.test(
					read(path),
				),
			);

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
});

/**
 * A lightrag endpoint or key assigned a value (D25-02: credentials live only
 * in the server env file).
 *
 * Test fixtures are exempt: `docs-search.test.ts` and `server.test.ts` pass
 * `LIGHTRAG_URL` into `loadConfig`, which is the point under test, and the
 * values are reserved example hosts. What the scan protects is production
 * code, env files, docs and configs — proved with inline bodies below.
 */
const LIGHTRAG_CREDENTIAL = /LIGHTRAG_(?:URL|API_KEY|MCP_URL)["']?\s*[:=]\s*["']?[^\s"']/;

function carrieslightragCredential(body: string): boolean {
	return body
		.split("\n")
		.filter((line) => !/^\s*(?:#|\/\/|\*|<!--)/.test(line))
		.some((line) => LIGHTRAG_CREDENTIAL.test(line));
}

describe("no lightrag credentials in the repo", () => {
	test("no committed non-test file carries a lightrag endpoint or credential", () => {
		// Offline eval harness (v1.7 phase 70): docs-eval-server.ts is exempt by exact path only.
		// Its EVAL_PLANE_URL is "http://lightrag.example.test" — the RFC 2606 reserved
		// example.test host, served by a fake plane in-process. No credential is carried.
		const offenders = trackedFiles()
			.filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test-support.ts"))
			.filter((path) => path !== join(LEDGER_PACKAGE, "docs-eval-server.ts"))
			.filter((path) => path !== relative(ROOT, import.meta.path))
			.filter((path) => carrieslightragCredential(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("the scan catches an endpoint or key with a value", () => {
		for (const body of [
			"LIGHTRAG_URL=http://agent-substrate-forwarder:9380",
			"LIGHTRAG_API_KEY=rf-0123456789abcdef",
			'  "LIGHTRAG_MCP_URL": "http://x/mcp"',
			"LIGHTRAG_URL: http://x:9380",
		]) {
			expect({ body, caught: carrieslightragCredential(body) }).toEqual({ body, caught: true });
		}
	});

	test("the scan does not fire on a blank, a bare name or a code read", () => {
		for (const body of [
			"LIGHTRAG_URL=",
			"LIGHTRAG_API_KEY=",
			"Reads `LIGHTRAG_URL` / `LIGHTRAG_API_KEY` only.",
			"const url = env.LIGHTRAG_URL?.trim();",
			"# LIGHTRAG_API_KEY lives in the server env file",
		]) {
			expect({ body, caught: carrieslightragCredential(body) }).toEqual({ body, caught: false });
		}
	});
});

/**
 * The substrate-only door (D26-01): Hindsight is reached ONLY through
 * `substrate-mcp` (`planes/hindsight.ts`). No Hindsight MCP server appears in
 * any agent config, and no package outside `mcp-server` imports the client.
 */
describe("Hindsight is reachable only through substrate-mcp", () => {
	test("no agent config registers a Hindsight MCP server", async () => {
		// Config files only: prose in the README and in docs/ has to be free
		// to say that this wiring is forbidden.
		const configs = [
			...(await filesMatching("**/*.json")),
			...(await filesMatching("**/*.{yaml,yml}")),
			...(await filesMatching("**/*.toml")),
			// The projector's sources, not its tests: a test asserting that no
			// generated file names Hindsight has to name it, and is the
			// enforcement of this rule where the configs land.
			...(await filesMatching("packages/projector/**/*.ts")).filter((path) => !path.endsWith(".test.ts")),
		];

		const offenders = configs.filter((path) => {
			const body = read(path);
			const registersServers = /mcpServers|mcp_servers|AddMcpServer|addMcpServer/.test(body);
			return registersServers && /hindsight/i.test(body);
		});

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("no package outside the MCP server imports the Hindsight client", async () => {
		// Mirrors the ledger-client test above. The CLI proves its cap against
		// the engine by reading the file as text rather than importing it for
		// exactly this reason — a string naming the file is not an import.
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !path.startsWith(LEDGER_PACKAGE))
			.filter((path) =>
				/(from\s+["'][^"']*|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*(planes\/hindsight|memory-recall|memory-retain|hindsight-fake)/.test(
					read(path),
				),
			);

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
});

/**
 * `HINDSIGHT_*` is read only in `mcp-server` (D26-02: credentials live only
 * in the server env file, read by `planes/hindsight.ts`). The bank prefix
 * and bank list are routing config, not credentials, so they carry values in
 * `.env.example` like `GREPTIME_DB=public` does.
 */
describe("no Hindsight reads or credentials outside the MCP server", () => {
	test("nothing outside the MCP server names HINDSIGHT_", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !path.startsWith(LEDGER_PACKAGE))
			.filter((path) => /HINDSIGHT_/.test(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
});

const HINDSIGHT_CREDENTIAL = /HINDSIGHT_(?:URL|API_KEY)["']?\s*[:=]\s*["']?[^\s"']/;

function carriesHindsightCredential(body: string): boolean {
	return body
		.split("\n")
		.filter((line) => !/^\s*(?:#|\/\/|\*|<!--)/.test(line))
		.some((line) => HINDSIGHT_CREDENTIAL.test(line));
}

describe("no Hindsight credentials in the repo", () => {
	test("no committed non-test file carries a Hindsight endpoint or credential", () => {
		const offenders = trackedFiles()
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => path !== relative(ROOT, import.meta.path))
			.filter((path) => carriesHindsightCredential(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("the scan catches an endpoint or key with a value", () => {
		for (const body of [
			"HINDSIGHT_URL=http://agent-substrate-forwarder:8888",
			"HINDSIGHT_API_KEY=hs-0123456789abcdef",
			'  "HINDSIGHT_URL": "http://x:8888"',
			"HINDSIGHT_API_KEY: hs-0123456789abcdef",
		]) {
			expect({ body, caught: carriesHindsightCredential(body) }).toEqual({ body, caught: true });
		}
	});

	test("the scan does not fire on a blank, a routing value, a bare name or a code read", () => {
		for (const body of [
			"HINDSIGHT_URL=",
			"HINDSIGHT_API_KEY=",
			"HINDSIGHT_BANK_PREFIX=sub-",
			"HINDSIGHT_BANKS=",
			"Reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` only.",
			"const url = env.HINDSIGHT_URL?.trim();",
			"# HINDSIGHT_API_KEY lives in the server env file",
		]) {
			expect({ body, caught: carriesHindsightCredential(body) }).toEqual({ body, caught: false });
		}
	});
});

/**
 * The substrate-only door (phase 64): TEI is reached ONLY through `substrate-mcp` (`planes/tei.ts`, behind `embed.ts`).
 * The CLI, the collectors and the scripts that want a vector ask the server over HTTP; the text they send is document
 * content, and the server is where the endpoint policy, the breaker and the cache apply.
 */
describe("TEI is reachable only through substrate-mcp", () => {
	test("no package outside the MCP server imports the TEI client or the embedding service", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !path.startsWith(LEDGER_PACKAGE))
			.filter((path) =>
				/(from\s+["'][^"']*|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*(planes\/tei|mcp-server\/src\/embed)/.test(read(path)),
			);

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);
});

const TEI_CREDENTIAL = /\bTEI_(?:URL|API_KEY)["']?\s*[:=]\s*["']?[^\s"']/;

function carriesTeiCredential(body: string): boolean {
	return body
		.split("\n")
		.filter((line) => !/^\s*(?:#|\/\/|\*|<!--)/.test(line))
		.some((line) => TEI_CREDENTIAL.test(line));
}

describe("no TEI credentials in the repo", () => {
	test("no committed non-test file carries a TEI endpoint or key", () => {
		const offenders = trackedFiles()
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => path !== relative(ROOT, import.meta.path))
			.filter((path) => carriesTeiCredential(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("the scan catches an endpoint or key with a value, and not a blank, a bare name or a code read", () => {
		for (const body of ["TEI_URL=http://x:8080", "TEI_API_KEY=tei-0123456789abcdef", '  "TEI_URL": "http://x:8080"', "TEI_API_KEY: tei-0123456789abcdef"]) {
			expect({ body, caught: carriesTeiCredential(body) }).toEqual({ body, caught: true });
		}
		for (const body of [
			"TEI_URL=",
			"TEI_API_KEY=",
			"SUBSTRATE_TEI_MODEL=bge-small",
			"Set `TEI_URL` and `TEI_API_KEY`.",
			"const url = env.TEI_URL?.trim();",
			"# TEI_API_KEY lives in the server env file",
		]) {
			expect({ body, caught: carriesTeiCredential(body) }).toEqual({ body, caught: false });
		}
	});
});

/**
 * No second door to TEI (phase 64): importing the client is not the only way past the server's checks. A CLI or collector
 * that read `TEI_URL` and posted to `/embed` itself would skip the endpoint policy, the circuit breaker, the input limits
 * and the cache. Only the config reader, the flag registry and the client name the settings or build a request; tests
 * inside the package may, because they feed those files fakes.
 */
const TEI_DIRECT_ALLOWED = [join(LEDGER_PACKAGE, "config.ts"), join(LEDGER_PACKAGE, "flag-registry.ts"), join(LEDGER_PACKAGE, "planes", "tei.ts")];

function mayReachTeiDirectly(path: string): boolean {
	return TEI_DIRECT_ALLOWED.includes(path) || (path.startsWith(LEDGER_PACKAGE) && path.endsWith(".test.ts"));
}

/** A read of the TEI settings by name. */
const TEI_SETTING = /\bTEI_(?:URL|API_KEY)\b/;
/** A request path built in a string: `"/embed"`, `` `${base}/embed` ``, `"http://host/embed"`; not `"./embed.ts"` or `/embeddings`. */
const TEI_EMBED_PATH = /["'`][^"'`]*\/embed(?![\w.-])/;

function reachesTeiDirectly(body: string): boolean {
	return body
		.split("\n")
		.filter((line) => !/^\s*(?:#|\/\/|\/\*|\*|<!--)/.test(line))
		.some((line) => TEI_SETTING.test(line) || TEI_EMBED_PATH.test(line));
}

describe("nothing outside the TEI client reads its settings or builds a request to it", () => {
	test("no source file outside the allow-list names TEI_URL or TEI_API_KEY, or builds an /embed request", async () => {
		const offenders = (await filesMatching("**/*.{ts,mts,js,mjs}"))
			.filter((path) => !mayReachTeiDirectly(path))
			.filter((path) => reachesTeiDirectly(read(path)));

		expect(offenders).toEqual([]);
	}, SCAN_TIMEOUT_MS);

	test("the scan catches a direct request and a read of the settings, over in-memory samples", () => {
		for (const body of [
			'const reply = await fetch(process.env.TEI_URL + "/embed", { method: "POST", body });',
			"const reply = await fetch(`${base}/embed`, { method: 'POST' });",
			"const key = Bun.env.TEI_API_KEY;",
			'const url = new URL("/embed", base);',
			"  headers: { authorization: `Bearer ${env.TEI_API_KEY}` },",
		]) {
			expect({ body, caught: reachesTeiDirectly(body) }).toEqual({ body, caught: true });
		}
	});

	test("the scan does not fire on a comment, an import of a file named embed, another route or another setting", () => {
		for (const body of [
			"// TEI_URL lives in the server env file",
			"/** TEI_URL names the instance. */",
			" * POST /embed answers one vector per input",
			'import { createEmbeddingService } from "./embed.ts";',
			'const reply = await fetch(`${server}/embeddings`);',
			'await fetch(`${server}/docs/search`);',
			"const model = env.SUBSTRATE_TEI_MODEL;",
		]) {
			expect({ body, caught: reachesTeiDirectly(body) }).toEqual({ body, caught: false });
		}
	});

	test("the allow-list is the config reader, the flag registry, the client and the package's own tests", () => {
		expect(TEI_DIRECT_ALLOWED.every((path) => mayReachTeiDirectly(path))).toBe(true);
		expect(mayReachTeiDirectly(join(LEDGER_PACKAGE, "embed.test.ts"))).toBe(true);
		for (const path of [join(LEDGER_PACKAGE, "service.ts"), join(LEDGER_PACKAGE, "embed.ts"), join("packages", "cli", "src", "embed.ts"), join("scripts", "x.ts")]) {
			expect({ path, allowed: mayReachTeiDirectly(path) }).toEqual({ path, allowed: false });
		}
	});
});
