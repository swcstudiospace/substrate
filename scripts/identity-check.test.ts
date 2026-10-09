/**
 * Locks for the identity manifest and check: schema, parser safety,
 * per-client verdicts in both modes, and the manifest to runbook to
 * env-example chain. Fixture values stay short on purpose: the store lock
 * flags any committed token-looking value of 16 or more characters.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenEnvName } from "../packages/mcp-server/src/config.ts";
import { SURFACES, type Surface } from "../packages/mcp-server/src/types.ts";
import {
	checkNames,
	checkValues,
	expandHome,
	expectedServerNames,
	formatReport,
	isDormant,
	isLive,
	loadManifest,
	main,
	parseEnvNames,
	parseEnvValues,
	sha256Hex,
	tokensFileVerdict,
	type FileStat,
	type HostReads,
	type Manifest,
} from "./identity-check.ts";

const ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(ROOT, "infra", "identity", "clients.json");
const RUNBOOK = join(ROOT, "docs", "runbooks", "production-identity.md");
const ENV_EXAMPLE = join(ROOT, ".env.example");

/** Every fixture value below is short, so none reads as a token literal. */
const V1 = "qk";
const V2 = "ql";
const V3 = "qm";
const V4 = "qn";
const OTHER = "zz";

let tmpSeq = 0;

/** A deterministic scratch dir: random suffixes could collide with fixtures. */
function makeTmp(): string {
	const dir = join(tmpdir(), `idcheck-${process.pid}-${tmpSeq}`);
	tmpSeq += 1;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function captureStdout(fn: () => number): { code: number; out: string } {
	const original = process.stdout.write;
	let out = "";
	process.stdout.write = ((chunk: unknown) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		return { code: fn(), out };
	} finally {
		process.stdout.write = original;
	}
}

/** A small manifest exercising every delivery kind. */
function fixtureManifest(dir: string): Manifest {
	return {
		version: 1,
		server_env: join(dir, "srv.env"),
		required_server_names: ["SUBSTRATE_OPERATOR_TOKENS"],
		clients: [
			{
				id: "cli",
				surface: "claude-code",
				delivery: { kind: "env-file", path: join(dir, "cli.env"), variable: "SUBSTRATE_TOKEN" },
				state: "live",
				evidence: "unit",
			},
			{ id: "cur", surface: "cursor", delivery: { kind: "tokens-dir" }, state: "live", evidence: "unit" },
			{
				id: "dor",
				surface: "substrate",
				delivery: { kind: "env-file", path: join(dir, "dor.env"), variable: "SUBSTRATE_TOKEN_SUBSTRATE" },
				state: "dormant:22",
				evidence: "unit",
			},
			{
				id: "ext",
				surface: "hermes",
				delivery: { kind: "external", note: "another repo resolves it" },
				state: "live",
				evidence: "unit",
			},
		],
	};
}

function fixtureReads(texts: Record<string, string>, stats: Record<string, FileStat>): HostReads {
	const textMap = new Map(Object.entries(texts));
	const statMap = new Map(Object.entries(stats));
	return {
		readText: (path) => textMap.get(path) ?? null,
		statFile: (path) => statMap.get(path) ?? null,
	};
}

const GOOD_STAT: FileStat = { isFile: true, mode: 0o100600, uid: 0, size: 3 };

describe("the tracked manifest", () => {
	test("loads with the server env path and the required names", () => {
		const manifest = loadManifest(MANIFEST_PATH);
		expect(manifest.version).toBe(1);
		expect(manifest.server_env).toBe("/etc/substrate/substrate.env");
		expect(manifest.required_server_names).toContain("SUBSTRATE_OPERATOR_TOKENS");
		expect(manifest.required_server_names).toContain("SUBSTRATE_HANDOFF_KEY");
		expect(manifest.required_server_names).toContain("SUBSTRATE_AUDIT_PATH");
	});

	test("every client has a known shape and state", () => {
		const manifest = loadManifest(MANIFEST_PATH);
		expect(manifest.clients.length).toBeGreaterThan(40);
		const ids = new Set(manifest.clients.map((c) => c.id));
		expect(ids.size).toBe(manifest.clients.length);
		for (const client of manifest.clients) {
			expect([...(SURFACES as readonly string[])]).toContain(client.surface);
			expect(isLive(client.state) || client.state === "after-phase-19" || isDormant(client.state) || client.state === "not-installed").toBe(
				true,
			);
			expect(client.evidence.length).toBeGreaterThan(0);
			expect(client.evidence).not.toContain("|");
		}
	});

	test("delivery paths are production paths, never a checkout", () => {
		const manifest = loadManifest(MANIFEST_PATH);
		for (const client of manifest.clients) {
			const delivery = client.delivery;
			if (delivery.kind === "env-file" || delivery.kind === "operator-file") {
				expect(delivery.path.startsWith("/etc/") || delivery.path.startsWith("~/")).toBe(true);
			}
		}
	});

	test("herdr covers every mapped non-swarm surface from a tokens-dir file", () => {
		const manifest = loadManifest(MANIFEST_PATH);
		const herdr = new Map(manifest.clients.filter((c) => c.id.startsWith("herdr-")).map((c) => [c.surface, c]));
		for (const surface of ["claude-code", "codex", "opencode", "pi", "omp", "hermes", "cursor", "grok-build", "muse"]) {
			const row = herdr.get(surface);
			expect(row?.delivery.kind).toBe("tokens-dir");
			expect(row?.state).toBe("after-phase-19");
		}
	});

	test("every manifest surface names its token variable in .env.example", () => {
		const example = readFileSync(ENV_EXAMPLE, "utf8").split("\n");
		const manifest = loadManifest(MANIFEST_PATH);
		for (const surface of new Set(manifest.clients.map((c) => c.surface))) {
			expect(example).toContain(`${tokenEnvName(surface as Surface)}=`);
		}
	});

	test("manifest ids appear in the runbook marked table (active once Task 2 lands)", () => {
		if (!existsSync(RUNBOOK)) return;
		const doc = readFileSync(RUNBOOK, "utf8");
		const start = doc.indexOf("<!-- identity-clients:start -->");
		const end = doc.indexOf("<!-- identity-clients:end -->");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const table = doc.slice(start, end);
		for (const client of loadManifest(MANIFEST_PATH).clients) expect(table).toContain(client.id);
	});

	test("expected server names cover the required names and every surface", () => {
		const manifest = loadManifest(MANIFEST_PATH);
		const expected = expectedServerNames(manifest);
		for (const name of manifest.required_server_names) expect(expected.has(name)).toBe(true);
		for (const client of manifest.clients) expect(expected.has(tokenEnvName(client.surface as Surface))).toBe(true);
	});
});

describe("loadManifest refusals", () => {
	test("missing file, bad JSON and unknown kinds throw", () => {
		const dir = makeTmp();
		expect(() => loadManifest(join(dir, "nope.json"))).toThrow("cannot read manifest");
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{nope");
		expect(() => loadManifest(bad)).toThrow("is not JSON");
		const kind = join(dir, "kind.json");
		writeFileSync(
			kind,
			JSON.stringify({
				version: 1,
				server_env: join(dir, "srv.env"),
				required_server_names: [],
				clients: [{ id: "x", surface: "cursor", delivery: { kind: "pigeon" }, state: "live", evidence: "u" }],
			}),
		);
		expect(() => loadManifest(kind)).toThrow("unknown delivery kind");
	});
});

describe("parseEnvNames", () => {
	test("keeps names only and drops values at parse time", () => {
		const names = parseEnvNames(`SUBSTRATE_TOKEN_CLAUDE_CODE=${V1}\nSUBSTRATE_TOKEN_CURSOR=${V2}\n`);
		expect(names.get("SUBSTRATE_TOKEN_CLAUDE_CODE")).toEqual({ count: 1, empty: false });
		expect(names.get("SUBSTRATE_TOKEN_CURSOR")).toEqual({ count: 1, empty: false });
		expect(JSON.stringify([...names])).not.toContain(V1);
		expect(JSON.stringify([...names])).not.toContain(V2);
	});

	test("skips comments and blanks, handles export and quoted empties", () => {
		const names = parseEnvNames(
			["# a comment", "; another", "", `export SUBSTRATE_TOKEN_CLAUDE_CODE="${V1}"`, "SUBSTRATE_OPERATOR_TOKENS=", "EMPTY_TWO=''"].join(
				"\n",
			),
		);
		expect(names.get("SUBSTRATE_TOKEN_CLAUDE_CODE")).toEqual({ count: 1, empty: false });
		expect(names.get("SUBSTRATE_OPERATOR_TOKENS")).toEqual({ count: 1, empty: true });
		expect(names.get("EMPTY_TWO")).toEqual({ count: 1, empty: true });
		expect(names.has("#")).toBe(false);
	});

	test("skips continuation fragments and counts duplicates last-wins", () => {
		const names = parseEnvNames(
			[`SUBSTRATE_TOKEN_CLAUDE_CODE=${V1}\\`, `frag=${V2}`, `SUBSTRATE_TOKEN_CURSOR=${V3}`, `SUBSTRATE_TOKEN_CURSOR=${V4}`].join("\n"),
		);
		expect(names.has("frag")).toBe(false);
		expect(names.get("SUBSTRATE_TOKEN_CURSOR")).toEqual({ count: 2, empty: false });
		expect(JSON.stringify([...names])).not.toContain(V2);
	});

	test("values mode keeps the last definition with quotes stripped", () => {
		const values = parseEnvValues(`A='${V1}'\nA="${V2}"\nB=${V3}\n`);
		expect(values.get("A")).toBe(V2);
		expect(values.get("B")).toBe(V3);
	});
});

describe("tokensFileVerdict", () => {
	test("names every outcome from stat alone", () => {
		expect(tokensFileVerdict(null)).toBe("missing");
		expect(tokensFileVerdict({ ...GOOD_STAT, isFile: false })).toBe("not-regular");
		expect(tokensFileVerdict({ ...GOOD_STAT, size: 0 })).toBe("empty");
		expect(tokensFileVerdict({ ...GOOD_STAT, mode: 0o100644 })).toBe("bad-mode");
		expect(tokensFileVerdict({ ...GOOD_STAT, uid: 1000 })).toBe("bad-owner");
		expect(tokensFileVerdict(GOOD_STAT)).toBe("ok");
	});
});

describe("checkNames", () => {
	test("passes when every live delivery exists", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const td = join(dir, "td");
		mkdirSync(td);
		const report = checkNames(
			manifest,
			fixtureReads(
				{
					[join(dir, "srv.env")]: `SUBSTRATE_TOKEN_CLAUDE_CODE=${V1}\nSUBSTRATE_TOKEN_CURSOR=${V3}\nSUBSTRATE_TOKEN_SUBSTRATE=${V4}\nSUBSTRATE_TOKEN_HERMES=${V1}\nSUBSTRATE_OPERATOR_TOKENS=${V2}\n`,
					[join(dir, "cli.env")]: `SUBSTRATE_TOKEN=${V1}\n`,
				},
				{ [join(td, "cursor")]: GOOD_STAT },
			),
			join(dir, "srv.env"),
			td,
		);
		expect(report.pass).toBe(true);
		expect(report.strandedLive).toEqual([]);
		expect(report.clients.find((c) => c.id === "ext")?.status).toBe("external");
		const out = formatReport({ ...report, manifestPath: "m" }, false);
		expect(out).toContain("PASS");
		for (const value of [V1, V2, V3, V4]) expect(out).not.toContain(value);
	});

	test("a missing live delivery strands while dormant never fails", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const report = checkNames(manifest, fixtureReads({}, {}), join(dir, "srv.env"), join(dir, "td"));
		expect(report.pass).toBe(false);
		expect(report.strandedLive).toContain("cli");
		expect(report.strandedLive).toContain("cur");
		expect(report.strandedLive).not.toContain("dor");
		expect(report.strandedLive).not.toContain("ext");
	});

	test("reports unexpected token names but never echoes other names or values", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const report = checkNames(
			manifest,
			fixtureReads({ [join(dir, "srv.env")]: `SUBSTRATE_TOKEN_QQ=${V1}\nSOME_OTHER_VAR=${OTHER}\n` }, {}),
			join(dir, "srv.env"),
			join(dir, "td"),
		);
		expect(report.unexpected).toEqual(["SUBSTRATE_TOKEN_QQ"]);
		const out = formatReport({ ...report, manifestPath: "m" }, true) + formatReport({ ...report, manifestPath: "m" }, false);
		expect(out).toContain("SUBSTRATE_TOKEN_QQ");
		expect(out).not.toContain("SOME_OTHER_VAR");
		expect(out).not.toContain(V1);
		expect(out).not.toContain(OTHER);
	});

	test("flags the bare client variable in the server env", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const report = checkNames(
			manifest,
			fixtureReads({ [join(dir, "srv.env")]: `SUBSTRATE_TOKEN=${V1}\n` }, {}),
			join(dir, "srv.env"),
			join(dir, "td"),
		);
		expect(report.warnings.some((w) => w.includes("SUBSTRATE_TOKEN"))).toBe(true);
		expect(formatReport({ ...report, manifestPath: "m" }, false)).not.toContain(V1);
	});
});

describe("checkValues", () => {
	test("matches, misses and mismatches by hash equality", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const serverValues = new Map([
			["SUBSTRATE_TOKEN_CLAUDE_CODE", `${V1},${V2}`],
			["SUBSTRATE_TOKEN_CURSOR", V3],
			["SUBSTRATE_TOKEN_HERMES", V1],
		]);
		const report = checkValues(
			manifest,
			serverValues,
			new Map([
				["cli", V1],
				["cur", OTHER],
				["dor", null],
			]),
			join(dir, "srv.env"),
			join(dir, "td"),
		);
		expect(report.clients.find((c) => c.id === "cli")?.status).toBe("match");
		expect(report.clients.find((c) => c.id === "cur")?.status).toBe("mismatch");
		expect(report.clients.find((c) => c.id === "dor")?.status).toBe("missing");
		expect(report.clients.find((c) => c.id === "ext")?.status).toBe("unchecked");
		expect(report.pass).toBe(false);
		expect(report.strandedLive).toEqual(["cur"]);
		const out = formatReport({ ...report, manifestPath: "m" }, false) + formatReport({ ...report, manifestPath: "m" }, true);
		for (const value of [V1, V2, V3, OTHER]) expect(out).not.toContain(value);
		expect(out).toContain("mismatch");
	});

	test("names boot contradictions without values", () => {
		const dir = makeTmp();
		const manifest = fixtureManifest(dir);
		const report = checkValues(
			manifest,
			new Map([
				["SUBSTRATE_TOKEN_CLAUDE_CODE", V1],
				["SUBSTRATE_TOKEN_CURSOR", V1],
				["SUBSTRATE_TOKEN_QQ", V2],
			]),
			new Map(),
			join(dir, "srv.env"),
			join(dir, "td"),
		);
		expect(report.errors.length).toBeGreaterThan(0);
		const errors = report.errors.join("\n");
		expect(errors).toContain("SUBSTRATE_TOKEN_CLAUDE_CODE");
		expect(errors).toContain("SUBSTRATE_TOKEN_CURSOR");
		expect(errors).not.toContain(V1);
		expect(errors).not.toContain(V2);
	});
});

describe("main", () => {
	test("names mode passes against fixtures and prints no values", () => {
		const dir = makeTmp();
		const td = join(dir, "td");
		mkdirSync(td);
		const manifest = {
			version: 1,
			server_env: join(dir, "srv.env"),
			required_server_names: ["SUBSTRATE_OPERATOR_TOKENS"],
			clients: [
				{
					id: "cli",
					surface: "claude-code",
					delivery: { kind: "env-file", path: join(dir, "cli.env"), variable: "SUBSTRATE_TOKEN" },
					state: "live",
					evidence: "unit",
				},
				{ id: "cur", surface: "cursor", delivery: { kind: "tokens-dir" }, state: "live", evidence: "unit" },
			],
		};
		const mp = join(dir, "clients.json");
		writeFileSync(mp, JSON.stringify(manifest));
		writeFileSync(
			join(dir, "srv.env"),
			`SUBSTRATE_TOKEN_CLAUDE_CODE=${V1}\nSUBSTRATE_TOKEN_CURSOR=${V3}\nSUBSTRATE_OPERATOR_TOKENS=${V2}\n`,
		);
		writeFileSync(join(dir, "cli.env"), `SUBSTRATE_TOKEN=${V1}\n`);
		writeFileSync(join(td, "cursor"), `${V3}\n`);
		chmodSync(join(td, "cursor"), 0o600);
		const { code, out } = captureStdout(() => main(["--manifest", mp, "--server-env", join(dir, "srv.env"), "--tokens-dir", td]));
		expect(code).toBe(0);
		expect(out).toContain("PASS");
		for (const value of [V1, V2, V3]) expect(out).not.toContain(value);
	});

	test("missing server env strands live clients with exit 1", () => {
		const dir = makeTmp();
		const mp = join(dir, "clients.json");
		writeFileSync(mp, JSON.stringify(fixtureManifest(dir)));
		const { code, out } = captureStdout(() => main(["--manifest", mp]));
		expect(code).toBe(1);
		expect(out).toContain("FAIL");
		expect(out).toContain("cli");
	});

	test("values mode matches then mismatches", () => {
		const dir = makeTmp();
		const manifest = {
			version: 1,
			server_env: join(dir, "srv.env"),
			required_server_names: [],
			clients: [
				{
					id: "cli",
					surface: "claude-code",
					delivery: { kind: "env-file", path: join(dir, "cli.env"), variable: "SUBSTRATE_TOKEN" },
					state: "live",
					evidence: "unit",
				},
			],
		};
		const mp = join(dir, "clients.json");
		writeFileSync(mp, JSON.stringify(manifest));
		writeFileSync(join(dir, "srv.env"), `SUBSTRATE_TOKEN_CLAUDE_CODE=${V1}\n`);
		writeFileSync(join(dir, "cli.env"), `SUBSTRATE_TOKEN=${V1}\n`);
		const args = ["--values", "--manifest", mp, "--server-env", join(dir, "srv.env"), "--tokens-dir", join(dir, "td")];
		const ok = captureStdout(() => main(args));
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("match");
		writeFileSync(join(dir, "cli.env"), `SUBSTRATE_TOKEN=${OTHER}\n`);
		const bad = captureStdout(() => main(args));
		expect(bad.code).toBe(1);
		expect(bad.out).toContain("mismatch");
		for (const value of [V1, OTHER]) {
			expect(ok.out).not.toContain(value);
			expect(bad.out).not.toContain(value);
		}
	});

	test("usage problems exit 2 and help exits 0", () => {
		expect(main(["--bogus"])).toBe(2);
		expect(main(["--manifest"])).toBe(2);
		const dir = makeTmp();
		expect(main(["--manifest", join(dir, "nope.json")])).toBe(2);
		const { code, out } = captureStdout(() => main(["--help"]));
		expect(code).toBe(0);
		expect(out).toContain("usage:");
	});
});

describe("helpers", () => {
	test("expandHome resolves a leading tilde only", () => {
		expect(expandHome("~/a/b", "/home/op")).toBe(join("/home/op", "a/b"));
		expect(expandHome("/etc/x", "/home/op")).toBe("/etc/x");
	});

	test("sha256Hex is stable and 64 hex characters", () => {
		expect(sha256Hex(V1)).toBe(sha256Hex(V1));
		expect(sha256Hex(V1)).not.toBe(sha256Hex(V2));
		expect(sha256Hex(V1)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("state predicates read the manifest vocabulary", () => {
		expect(isLive("live")).toBe(true);
		expect(isLive("dormant:22")).toBe(false);
		expect(isDormant("dormant:22")).toBe(true);
		expect(isDormant("live")).toBe(false);
	});
});
