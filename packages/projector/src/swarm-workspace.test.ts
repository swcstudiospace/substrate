/**
 * The swarm-workspace projector, driven through its CLI the way an operator or installer runs it, over a temp
 * workspace (ADR 0001 S4 criteria 1-3; INST-01, INST-02).
 *
 * The two assertions the ADR separates are kept apart here too: "names Greptime as an MCP server" is checked over
 * every file the run leaves, and "carries a token literal" over every file under the workspace. The projector writes
 * no credential file, so both scopes are the workspace.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply, plan, ProjectionRefused } from "./swarm-workspace";

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

describe("safe staged apply", () => {
	test("refuses a planted backup symlink without touching its victim or earlier files", () => {
		put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);
		const victim = put("victim", "UNCHANGED");
		const backup = join(ws, ".grok/config.toml.substrate-backup");
		symlinkSync(victim, backup);
		const before = files();
		expect(run("--workspace", ws, "--apply").code).toBe(2);
		expect(files()).toEqual(before);
		expect(readFileSync(victim, "utf8")).toBe("UNCHANGED");
		expect(lstatSync(backup).isSymbolicLink()).toBe(true);
	});

	test("ignores old predictable temp links and refuses a collision at its exclusive staging path", () => {
		const victim = put("victim", "UNCHANGED");
		const config = put(".mcp.json", EXISTING_JSON);
		const legacy = `${config}.substrate-tmp-${process.pid}`;
		symlinkSync(victim, legacy);
		const planned = plan(ws, ["claude"]);
		const id = "00000000-0000-0000-0000-000000000000";
		const collision = join(ws, `.substrate-tmp-${id}`);
		symlinkSync(victim, collision);
		const before = files();
		const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
		try {
			expect(() => apply(planned)).toThrow(ProjectionRefused);
		} finally {
			uuid.mockRestore();
		}
		expect(files()).toEqual(before);
		expect(readFileSync(victim, "utf8")).toBe("UNCHANGED");
		expect(lstatSync(collision).isSymbolicLink()).toBe(true);
		apply(planned);
		expect(readFileSync(victim, "utf8")).toBe("UNCHANGED");
		expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
		expect(lstatSync(collision).isSymbolicLink()).toBe(true);
		const first = files();
		expect(apply(plan(ws, ["claude"]))).toEqual([]);
		expect(files()).toEqual(first);
	});

	test("rechecks final and parent symlinks introduced after planning", () => {
		const config = put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);
		const planned = plan(ws);
		const victim = put("victim", EXISTING_JSON);
		rmSync(config);
		symlinkSync(victim, config);
		expect(() => apply(planned)).toThrow(ProjectionRefused);
		expect(readFileSync(victim, "utf8")).toBe(EXISTING_JSON);
		rmSync(config);
		writeFileSync(config, EXISTING_JSON);
		renameSync(join(ws, ".grok"), `${ws}-elsewhere`);
		symlinkSync(`${ws}-elsewhere`, join(ws, ".grok"));
		const before = files();
		expect(() => apply(planned)).toThrow(ProjectionRefused);
		expect(files()).toEqual(before);
		expect(readFileSync(join(`${ws}-elsewhere`, "config.toml"), "utf8")).toBe(EXISTING_TOML);
	});

	test("a late staging write failure leaves all configs and existing backups untouched", () => {
		put(".mcp.json", EXISTING_JSON);
		put(".mcp.json.substrate-backup", "older JSON backup");
		put(".grok/config.toml", EXISTING_TOML);
		put(".grok/config.toml.substrate-backup", "older TOML backup");
		const planned = plan(ws);
		const before = files();
		const realWrite = fs.writeFileSync;
		let count = 0;
		const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
			if (++count === 5) throw new Error("injected staging failure");
			return realWrite(...args);
		});
		try {
			expect(() => apply(planned)).toThrow("injected staging failure");
		} finally {
			write.mockRestore();
		}
		expect(files()).toEqual(before);
	});

	test("a later commit failure rolls back configs, replaced backups, and their modes", () => {
		const config = put(".mcp.json", EXISTING_JSON);
		const backup = put(".mcp.json.substrate-backup", "older JSON backup");
		put(".grok/config.toml", EXISTING_TOML);
		put(".grok/config.toml.substrate-backup", "older TOML backup");
		chmodSync(config, 0o640);
		chmodSync(backup, 0o600);
		const planned = plan(ws);
		const before = files();
		const realRename = fs.renameSync;
		const rename = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (String(destination).endsWith("/config.toml")) throw new Error("injected commit failure");
			return realRename(source, destination);
		});
		try {
			expect(() => apply(planned)).toThrow("injected commit failure");
		} finally {
			rename.mockRestore();
		}
		expect(files()).toEqual(before);
		expect(statSync(config).mode & 0o777).toBe(0o640);
		expect(statSync(backup).mode & 0o777).toBe(0o600);
		apply(plan(ws));
		expect(statSync(config).mode & 0o777).toBe(0o640);
		expect(statSync(backup).mode & 0o777).toBe(0o640);
		const first = files();
		expect(apply(plan(ws))).toEqual([]);
		expect(files()).toEqual(first);
	});

	test("a later commit failure removes only files and directories it created", () => {
		const planned = plan(ws);
		const realLink = fs.linkSync;
		const link = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
			if (String(destination).endsWith("/config.toml")) throw new Error("injected create failure");
			return realLink(source, destination);
		});
		try {
			expect(() => apply(planned)).toThrow("injected create failure");
		} finally {
			link.mockRestore();
		}
		expect(readdirSync(ws)).toEqual([]);
	});

	test("rollback preserves an intervening external config edit and explicitly reports the conflict", () => {
		const config = put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);
		const planned = plan(ws);
		const external = '{"external":"keep this edit"}\n';
		const realRename = fs.renameSync;
		const rename = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (String(destination).endsWith("/config.toml")) {
				writeFileSync(config, external);
				throw new Error("injected commit failure");
			}
			return realRename(source, destination);
		});
		try {
			expect(() => apply(planned)).toThrow("rollback incomplete");
		} finally {
			rename.mockRestore();
		}
		expect(files()).toEqual({ ".mcp.json": external, ".grok/config.toml": EXISTING_TOML });
	});

	test("a directory replaced inside a commit syscall cannot redirect writes through its symlink", () => {
		put(".mcp.json", EXISTING_JSON);
		put(".grok/config.toml", EXISTING_TOML);
		const planned = plan(ws);
		mkdirSync(`${ws}-elsewhere`);
		const victim = join(`${ws}-elsewhere`, "config.toml");
		writeFileSync(victim, "UNCHANGED");
		const realRename = fs.renameSync;
		let swapped = false;
		const rename = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (!swapped && String(destination).endsWith("/config.toml")) {
				swapped = true;
				realRename(join(ws, ".grok"), join(ws, "saved-grok"));
				symlinkSync(`${ws}-elsewhere`, join(ws, ".grok"));
			}
			return realRename(source, destination);
		});
		try {
			expect(() => apply(planned)).toThrow(ProjectionRefused);
		} finally {
			rename.mockRestore();
		}
		expect(readFileSync(victim, "utf8")).toBe("UNCHANGED");
		expect(readFileSync(join(ws, ".mcp.json"), "utf8")).toBe(EXISTING_JSON);
		expect(readFileSync(join(ws, "saved-grok/config.toml"), "utf8")).toBe(EXISTING_TOML);
		expect(readdirSync(join(ws, "saved-grok"))).toEqual(["config.toml"]);
	});
});
