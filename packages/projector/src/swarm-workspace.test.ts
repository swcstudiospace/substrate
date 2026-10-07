/**
 * The swarm-workspace projector, driven through its CLI the way an operator or installer runs it, over a temp
 * workspace (ADR 0001 S4 criteria 1-3; INST-01, INST-02).
 *
 * The two assertions the ADR separates are kept apart here too: "names Greptime as an MCP server" is checked over
 * every file the run leaves, and "carries a token literal" over every file under the workspace. The projector writes
 * no credential file, so both scopes are the workspace.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "swarm-workspace.ts");
/** What a real token would be: if the projector ever expanded the environment, this is the string that would leak. */
const SENTINEL = "p14-sentinel-token-7f3a9c";

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "p14-projector-"));
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(`${ws}-elsewhere`, { recursive: true, force: true });
});

function run(...args: string[]): { code: number; out: string; err: string } {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		env: {
			...process.env,
			SUBSTRATE_URL: "http://127.0.0.1:7499",
			SUBSTRATE_TOKEN: SENTINEL,
			SUBSTRATE_TOKEN_SWARM_A05_BE: SENTINEL,
		},
	});
	return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function put(rel: string, text: string): string {
	const path = join(ws, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

function files(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(ws, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out[path.slice(ws.length + 1)] = readFileSync(path, "utf8");
	}
	return out;
}

/** Every MCP server a generated file registers, by name, with its definition as text. */
function servers(rel: string, text: string): Record<string, string> {
	const doc = (rel.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text)) as Record<string, unknown>;
	const table = (doc.mcpServers ?? doc.mcp_servers ?? {}) as Record<string, unknown>;
	return Object.fromEntries(Object.entries(table).map(([name, def]) => [name, JSON.stringify(def)]));
}

const EXISTING_JSON = `${JSON.stringify(
	{ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } }, other: { keep: true } },
	null,
	2,
)}\n`;
const EXISTING_TOML = [
	'model = "grok-4"',
	"",
	"[mcp_servers.notion]",
	'url = "https://mcp.notion.com/mcp"',
	"",
	"[permission]",
	'allow = ["read_file"]',
	"",
].join("\n");

describe("a fresh workspace", () => {
	test("gets one substrate entry per runtime file, naming the token's variable and never its value", () => {
		const { code, err } = run("--workspace", ws, "--apply");
		expect({ code, err }).toEqual({ code: 0, err: "" });

		const written = files();
		expect(Object.keys(written).sort()).toEqual([".grok/config.toml", ".mcp.json"]);
		const claude = JSON.parse(written[".mcp.json"] ?? "") as { mcpServers: Record<string, unknown> };
		expect(claude.mcpServers.substrate).toEqual({
			type: "http",
			url: "${SUBSTRATE_URL}/mcp",
			headers: { Authorization: "Bearer ${SUBSTRATE_TOKEN}" },
		});
		const grok = Bun.TOML.parse(written[".grok/config.toml"] ?? "") as { mcp_servers: Record<string, unknown> };
		expect(grok.mcp_servers.substrate).toEqual({
			url: "${SUBSTRATE_URL}/mcp",
			headers: { Authorization: "Bearer ${SUBSTRATE_TOKEN}" },
		});
	});

	test("no generated file names Greptime as an MCP server, and no file under the workspace holds a token", () => {
		put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);
		expect(run("--workspace", ws, "--apply").code).toBe(0);

		const written = files();
		expect(Object.keys(written).length).toBeGreaterThan(0);
		for (const [rel, text] of Object.entries(written)) {
			// store-lock rule 2, enforced where the configs land
			if (rel.endsWith(".mcp.json") || rel.endsWith(".toml")) {
				for (const [name, def] of Object.entries(servers(rel, text))) {
					expect(`${rel} ${name} ${def}`).not.toMatch(/greptime/i);
				}
			}
			expect({ rel, leaked: text.includes(SENTINEL) }).toEqual({ rel, leaked: false });
		}
	});
});

describe("an existing workspace", () => {
	test("keeps every entry and key it had, and a second run changes nothing", () => {
		put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);

		expect(run("--workspace", ws, "--apply").code).toBe(0);
		const first = files();
		const claude = JSON.parse(first[".mcp.json"] ?? "") as Record<string, Record<string, unknown>>;
		expect(Object.keys(claude.mcpServers ?? {})).toEqual(["linear", "substrate"]);
		expect(claude.other).toEqual({ keep: true });
		// the TOML is appended to as text, so the original bytes are a prefix of the result
		expect(first[".grok/config.toml"]?.startsWith(EXISTING_TOML)).toBe(true);
		const grok = Bun.TOML.parse(first[".grok/config.toml"] ?? "") as Record<string, unknown>;
		expect(grok.model).toBe("grok-4");
		expect(Object.keys((grok.mcp_servers ?? {}) as object)).toEqual(["notion", "substrate"]);
		expect(grok.permission).toEqual({ allow: ["read_file"] });
		// what was there before is kept beside the file
		expect(first[".mcp.json.substrate-backup"]).toBe(EXISTING_JSON);
		expect(first[".grok/config.toml.substrate-backup"]).toBe(EXISTING_TOML);

		const again = run("--workspace", ws, "--apply");
		expect(again.code).toBe(0);
		expect(again.out).toContain("= .mcp.json: substrate already present (claude, omp)");
		expect(again.out).toContain("= .grok/config.toml: substrate already present (grok)");
		expect(files()).toEqual(first);
		expect(run("--workspace", ws, "--check").code).toBe(0);
	});

	test("--check reports pending additions with exit 1 and writes nothing", () => {
		put(".mcp.json", EXISTING_JSON);
		const r = run("--workspace", ws, "--check");
		expect(r.code).toBe(1);
		expect(r.out).toContain("+ append to .mcp.json (claude, omp):");
		expect(r.out).toContain("+ create .grok/config.toml (grok):");
		expect(files()).toEqual({ ".mcp.json": EXISTING_JSON });
	});

	test("an identical hand-written entry counts as present, whatever its key order", () => {
		const text = `${JSON.stringify({
			mcpServers: {
				substrate: { headers: { Authorization: "Bearer ${SUBSTRATE_TOKEN}" }, url: "${SUBSTRATE_URL}/mcp", type: "http" },
			},
		})}\n`;
		put(".mcp.json", text);
		expect(run("--workspace", ws, "--runtimes", "claude", "--apply").code).toBe(0);
		expect(files()).toEqual({ ".mcp.json": text });
	});
});

describe("refusals: exit 2 and nothing written anywhere", () => {
	const cases: Array<[string, () => void]> = [
		["unparsable JSON", () => put(".mcp.json", "{ not json")],
		["unparsable TOML", () => put(".grok/config.toml", "[mcp_servers\nurl = ")],
		["a differing substrate entry", () => put(".mcp.json", JSON.stringify({ mcpServers: { substrate: { url: "http://x/mcp" } } }))],
		[
			"a substrate entry holding a token value",
			() => put(".grok/config.toml", '[mcp_servers.substrate]\nurl = "${SUBSTRATE_URL}/mcp"\nheaders = { Authorization = "Bearer abc" }\n'),
		],
		["an inline mcp_servers table it cannot extend", () => put(".grok/config.toml", 'mcp_servers = { notion = { url = "https://n/mcp" } }\n')],
		[
			"a symlinked config directory",
			() => {
				mkdirSync(`${ws}-elsewhere`);
				symlinkSync(`${ws}-elsewhere`, join(ws, ".grok"));
			},
		],
		["a dangling symlink where the file goes", () => symlinkSync(join(ws, "nowhere"), join(ws, ".mcp.json"))],
	];

	for (const [name, setup] of cases) {
		test(name, () => {
			// each case breaks one file; the other runtime's file would be fine, and the refusal is all-or-nothing
			setup();
			const before = files();
			const r = run("--workspace", ws, "--apply");
			expect(r.code).toBe(2);
			expect(r.err).toContain("Nothing was written");
			expect(files()).toEqual(before);
		});
	}

	test("a runtime with no MCP entry cannot be wired as an executing agent", () => {
		const r = run("--workspace", ws, "--runtimes", "claude,trae", "--apply");
		expect(r.code).toBe(2);
		expect(r.err).toContain("no MCP entry for runtime trae");
		expect(files()).toEqual({});
	});

	test("a workspace that does not exist", () => {
		const r = run("--workspace", join(ws, "missing"), "--apply");
		expect(r.code).toBe(2);
		expect(files()).toEqual({});
	});
});
