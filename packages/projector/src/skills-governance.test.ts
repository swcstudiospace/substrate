import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchApproved,
	gateActions,
	type GovernanceOptions,
	governanceFromEnv,
	MAX_APPROVED,
	MAX_BODY_BYTES,
	MAX_CACHE_BYTES,
	MAX_WARNED_NAMES,
	parseApproved,
	parseGovernanceMode,
	readApprovedCache,
	resolveSurfaceToken,
	RENOTIFY_MS,
	skillsGovernanceConfigWarnings,
	writeApprovedCache,
} from "./skills-governance.ts";
import { type Action, GROK_KNOWN_REAL, apply, inventory, main, plan, postWarning, project, type ProjectOptions, type Root, type WarningEvent } from "./skills.ts";
import { attributedSurface } from "../../mcp-server/src/mcp.ts";
import type { Surface } from "../../mcp-server/src/types.ts";

let T: string;
let LIB: string;
let EXP: string;
let STATE: string;
let CACHE: string;
let WARNED: string;
let CLAUDE: Root;

const TARGET = { url: "http://substrate.invalid", token: "tok-surface" };

function skill(dir: string, name: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

type FakeFetch = typeof fetch & { calls: { url: string; auth: string | null }[] };

/** A fetch answering `body` with `status`; records every call. */
function fakeFetch(answer: () => Response | Promise<Response>): FakeFetch {
	const calls: { url: string; auth: string | null }[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
		return answer();
	}) as FakeFetch;
	impl.calls = calls;
	return impl;
}

const approvedBody = (names: readonly string[], extra: Record<string, unknown> = {}): Response =>
	new Response(JSON.stringify({ governance: "report", skills: names.map((name) => ({ name, content_sha256: "x", merge_sha: "y" })), ...extra }));

const unreachable = (): FakeFetch =>
	fakeFetch(() => {
		throw new Error("connect ECONNREFUSED");
	});

function opts(governance: GovernanceOptions | undefined, warnings: WarningEvent[], out: string[], emit: (event: WarningEvent) => Promise<boolean> = async () => true): ProjectOptions {
	return {
		roots: [CLAUDE],
		libraryDir: LIB,
		exportsDir: EXP,
		backupRoot: join(T, "backup"),
		stateFile: STATE,
		stdout: (line) => out.push(line),
		emitWarning: async (event) => {
			warnings.push(event);
			return emit(event);
		},
		governance,
	};
}

const gov = (mode: "off" | "report" | "enforce", fetchImpl: typeof fetch, extra: Partial<GovernanceOptions> = {}): GovernanceOptions => ({
	mode,
	target: TARGET,
	fetchImpl,
	...extra,
});

const linked = (name: string): boolean => lstatSync(join(CLAUDE.dir, name), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

beforeEach(() => {
	T = mkdtempSync(join(tmpdir(), "u5-gov-"));
	LIB = join(T, "agent-skills");
	EXP = join(T, "exports");
	STATE = join(T, "state", "projector-warned.json");
	CACHE = join(T, "state", "approved.json");
	WARNED = join(T, "state", "governance-warned.json");
	mkdirSync(LIB);
	mkdirSync(EXP);
	CLAUDE = { id: "claude", dir: join(T, "claude"), surface: "claude-code", mode: "link" };
	mkdirSync(CLAUDE.dir);
});

afterEach(() => {
	rmSync(T, { recursive: true, force: true });
});

describe("flag parsing", () => {
	test("unset, blank and the three names parse; anything else is off with a named rejection", () => {
		expect(parseGovernanceMode(undefined)).toEqual({ mode: "off", rejected: null });
		expect(parseGovernanceMode("  ")).toEqual({ mode: "off", rejected: null });
		expect(parseGovernanceMode(" Enforce ")).toEqual({ mode: "enforce", rejected: null });
		expect(parseGovernanceMode("report")).toEqual({ mode: "report", rejected: null });
		const bad = parseGovernanceMode("on");
		expect(bad).toEqual({ mode: "off", rejected: "on" });
		expect(skillsGovernanceConfigWarnings(bad)).toHaveLength(1);
		expect(skillsGovernanceConfigWarnings(bad)[0]).toContain("SUBSTRATE_SKILLS_GOVERNANCE");
		expect(skillsGovernanceConfigWarnings({ rejected: null })).toEqual([]);
	});

	test("the token is the surface token first, then the generic one, and a list contributes its first entry only", () => {
		expect(governanceFromEnv({ SUBSTRATE_TOKEN_SUBSTRATE: " one , two", SUBSTRATE_TOKEN: "generic" }).target?.token).toBe("one");
		expect(governanceFromEnv({ SUBSTRATE_TOKEN: ",generic,other" }).target?.token).toBe("generic");
		expect(governanceFromEnv({}).target).toBeNull();
		expect(governanceFromEnv({ SUBSTRATE_URL: "http://127.0.0.1:9/", SUBSTRATE_TOKEN: "t" }).target?.url).toBe("http://127.0.0.1:9");
	});

	test("an invalid flag value runs the projector ungoverned and says so once", async () => {
		skill(LIB, "a");
		const out: string[] = [];
		const options = opts({ ...governanceFromEnv({ SUBSTRATE_SKILLS_GOVERNANCE: "yes", SUBSTRATE_TOKEN: "t" }) }, [], out);
		await project(options);
		expect(linked("a")).toBe(true);
		expect(out.filter((l) => l.includes("SUBSTRATE_SKILLS_GOVERNANCE"))).toHaveLength(1);
	});
});

describe("off", () => {
	test("makes no network call, writes no governance file, and plans exactly what an ungoverned run plans", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		const fetched = unreachable();
		const outOff: string[] = [];
		await project(opts(gov("off", fetched), [], outOff));
		expect(fetched.calls).toHaveLength(0);
		expect(existsSync(CACHE)).toBe(false);
		expect(existsSync(WARNED)).toBe(false);
		expect(linked("a") && linked("b")).toBe(true);
		// Same tree, same output as a run with no governance option at all.
		for (const name of ["a", "b"]) rmSync(join(CLAUDE.dir, name));
		const outAbsent: string[] = [];
		await project(opts(undefined, [], outAbsent));
		expect(outOff).toEqual(outAbsent);
	});
});

describe("report", () => {
	test("projects every skill, makes the same links as off, and warns once with names only", async () => {
		for (const name of ["a", "b", "c"]) skill(LIB, name);
		const warnings: WarningEvent[] = [];
		const fetched = fakeFetch(() => approvedBody(["a"]));
		await project(opts(gov("report", fetched), warnings, []));
		expect(["a", "b", "c"].map(linked)).toEqual([true, true, true]);
		expect(fetched.calls).toEqual([{ url: "http://substrate.invalid/skills?state=approved", auth: "Bearer tok-surface" }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.kind).toBe("warning");
		expect(warnings[0]?.payload).toEqual({ action: "skills.sync", component: "skills-projector", reason: "unapproved", mode: "report", count: 2, names: ["b", "c"] });
	});

	test("an unreachable, refusing or malformed substrate leaves the projection whole and the run green", async () => {
		skill(LIB, "a");
		const answers: (() => Response | Promise<Response>)[] = [
			() => {
				throw new Error("down");
			},
			() => new Response("no", { status: 503 }),
			() => new Response(JSON.stringify({ governance: "report" })),
			() => new Response("not json"),
		];
		for (const answer of answers) {
			rmSync(join(CLAUDE.dir, "a"), { force: true });
			const warnings: WarningEvent[] = [];
			const out: string[] = [];
			expect(await main([], opts(gov("report", fakeFetch(answer)), warnings, out))).toBe(0);
			expect(linked("a")).toBe(true);
			expect(warnings).toEqual([]);
			expect(out.some((l) => l.includes("approved list unavailable"))).toBe(true);
		}
	});

	test("no surface token means no fetch at all and an ungoverned projection", async () => {
		skill(LIB, "a");
		const fetched = fakeFetch(() => approvedBody([]));
		await project(opts(gov("report", fetched, { target: null }), [], []));
		expect(fetched.calls).toHaveLength(0);
		expect(linked("a")).toBe(true);
	});

	test("a fetch that never answers is cut at the deadline and the run still projects", async () => {
		skill(LIB, "a");
		const hang = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
		const started = Date.now();
		await project(opts(gov("report", hang, { timeoutMs: 30 }), [], []));
		expect(Date.now() - started).toBeLessThan(2000);
		expect(linked("a")).toBe(true);
	});

	test("an answer larger than the body cap is refused while it is read", async () => {
		const huge = fakeFetch(() => new Response(JSON.stringify({ skills: [{ name: "a", pad: "x".repeat(MAX_BODY_BYTES) }] })));
		expect(await fetchApproved(TARGET, huge)).toEqual({ ok: false, reason: "skills answer too large" });
	});

	test("the warning names at most 20 skills, sorted, and counts all of them", async () => {
		const all = Array.from({ length: 25 }, (_, i) => `s${String(i).padStart(2, "0")}`);
		for (const name of all) skill(LIB, name);
		const warnings: WarningEvent[] = [];
		await project(opts(gov("report", fakeFetch(() => approvedBody([]))), warnings, []));
		const payload = warnings[0]?.payload as { names: string[]; count: number };
		expect(payload.count).toBe(25);
		expect(payload.names).toEqual(all.slice(0, MAX_WARNED_NAMES));
		expect(payload.names).toHaveLength(20);
	});

	test("nothing unapproved means nothing to say", async () => {
		skill(LIB, "a");
		const warnings: WarningEvent[] = [];
		await project(opts(gov("report", fakeFetch(() => approvedBody(["a", "retired-elsewhere"]))), warnings, []));
		expect(warnings).toEqual([]);
	});
});

describe("warning dedupe", () => {
	test("the same gap is sent once, again after the renotify interval, at once when the set changes, and is retried when the post is refused", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		let clock = 1_000_000;
		const warnings: WarningEvent[] = [];
		const fetched = fakeFetch(() => approvedBody(["a"]));
		const run = (emit?: (event: WarningEvent) => Promise<boolean>) => project(opts(gov("report", fetched, { now: () => clock }), warnings, [], emit));

		await run();
		await run();
		clock += RENOTIFY_MS - 1;
		await run();
		expect(warnings).toHaveLength(1);

		clock += 2;
		await run();
		expect(warnings).toHaveLength(2);

		skill(LIB, "c");
		await run();
		expect(warnings).toHaveLength(3);
		expect((warnings[2]?.payload as { names: string[] }).names).toEqual(["b", "c"]);

		skill(LIB, "d");
		await run(async () => false);
		expect(warnings).toHaveLength(4);
		await run();
		expect(warnings).toHaveLength(5);
		await run();
		expect(warnings).toHaveLength(5);
	});

	test("a warned-state file that cannot be written does not fail the run", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		mkdirSync(WARNED, { recursive: true });
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		await project(opts(gov("report", fakeFetch(() => approvedBody(["a"]))), warnings, out));
		expect(warnings).toHaveLength(1);
		expect(out.some((l) => l.includes("warned-state not written"))).toBe(true);
		expect(linked("a") && linked("b")).toBe(true);
	});
});

describe("enforce", () => {
	test("links approved skills only, holds the rest back, and still warns", async () => {
		for (const name of ["a", "b"]) skill(LIB, name);
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["a"]))), warnings, out));
		expect(linked("a")).toBe(true);
		expect(linked("b")).toBe(false);
		expect(out).toContain("[projector] claude held link-new b (not approved)");
		expect((warnings[0]?.payload as { reason: string; mode: string; names: string[] }).names).toEqual(["b"]);
	});

	test("a skill already linked that is no longer approved keeps its link, its library copy and every other link", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		symlinkSync(join(LIB, "a"), join(CLAUDE.dir, "a"));
		symlinkSync(join(LIB, "b"), join(CLAUDE.dir, "b"));
		const warnings: WarningEvent[] = [];
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["a"]))), warnings, []));
		expect(readlinkSync(join(CLAUDE.dir, "b"))).toBe(join(LIB, "b"));
		expect(existsSync(join(LIB, "b", "SKILL.md"))).toBe(true);
		expect(readdirSync(CLAUDE.dir).sort()).toEqual(["a", "b"]);
		expect((warnings[0]?.payload as { names: string[] }).names).toEqual(["b"]);
	});

	test("gating removes exactly the actions that put a library link where there was none or an exports link: link-new, backup-then-link and repoint; skip-warns and removals pass through, nothing is added", () => {
		const actions: Action[] = [
			{ kind: "link-new", root: CLAUDE, name: "x", target: "/l/x" },
			{ kind: "backup-then-link", root: CLAUDE, name: "y", target: "/l/y" },
			{ kind: "repoint", root: CLAUDE, name: "z", target: "/l/z", from: "/e/z" },
			{ kind: "remove-own-link", root: CLAUDE, name: "w", from: "/l/w" },
			{ kind: "skip-warn", root: CLAUDE, name: "v", reason: "foreign-link", from: "/o" },
			{ kind: "link-new", root: CLAUDE, name: "ok", target: "/l/ok" },
			{ kind: "repoint", root: CLAUDE, name: "ok2", target: "/l/ok2", from: "/e/ok2" },
		];
		const gated = gateActions(actions, new Set(["ok", "ok2"]));
		expect(gated.actions.map((a) => `${a.kind}:${a.name}`)).toEqual(["remove-own-link:w", "skip-warn:v", "link-new:ok", "repoint:ok2"]);
		expect(gated.held.map((a) => `${a.kind}:${a.name}`)).toEqual(["link-new:x", "backup-then-link:y", "repoint:z"]);
		expect(gateActions(actions, null).actions.map((a) => a.kind)).toEqual(["remove-own-link", "skip-warn"]);
	});

	test("an existing link into the exports dir is not repointed at an unapproved library skill, and stays where it is", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		skill(EXP, "a");
		skill(EXP, "b");
		symlinkSync(join(EXP, "a"), join(CLAUDE.dir, "a"));
		symlinkSync(join(EXP, "b"), join(CLAUDE.dir, "b"));
		const out: string[] = [];
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["a"]))), [], out));
		expect(readlinkSync(join(CLAUDE.dir, "a"))).toBe(join(LIB, "a"));
		expect(readlinkSync(join(CLAUDE.dir, "b"))).toBe(join(EXP, "b"));
		expect(out).toContain("[projector] claude held repoint b (not approved)");
		// Report mode does not hold it: the same tree is repointed.
		await project(opts(gov("report", fakeFetch(() => approvedBody(["a"]))), [], []));
		expect(readlinkSync(join(CLAUDE.dir, "b"))).toBe(join(LIB, "b"));
	});

	test("an unapproved skill that a real directory already mirrors is not swapped for a link, and raises no stray-directory warning", async () => {
		skill(LIB, "a");
		skill(LIB, "same");
		const grok: Root = { id: "grok", dir: join(T, "grok"), surface: "grok-build", mode: "link", knownReal: GROK_KNOWN_REAL };
		skill(grok.dir, "same");
		writeFileSync(join(grok.dir, "same", "SKILL.md"), readFileSync(join(LIB, "same", "SKILL.md")));
		const warnings: WarningEvent[] = [];
		const options = { ...opts(gov("enforce", fakeFetch(() => approvedBody(["a"]))), warnings, []), roots: [CLAUDE, grok] };
		await project(options);
		expect(lstatSync(join(grok.dir, "same")).isDirectory()).toBe(true);
		expect(lstatSync(join(grok.dir, "same")).isSymbolicLink()).toBe(false);
		expect(warnings.map((w) => w.payload.reason)).toEqual(["unapproved"]);
		// The planner itself still sees the full library: this is the action the gate held.
		const full = plan([inventory(grok)], ["a", "same"], { libraryDir: LIB, exportsDir: EXP });
		expect(full.some((a) => a.kind === "backup-then-link" && a.name === "same")).toBe(true);
	});

	test("--check in enforce prints only the approved pending links and writes nothing at all", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		expect(await main(["--check"], opts(gov("enforce", fakeFetch(() => approvedBody(["a"]))), warnings, out))).toBe(1);
		expect(out).toEqual(["[projector] would link-new claude a"]);
		expect(warnings).toEqual([]);
		expect(existsSync(CACHE)).toBe(false);
		expect(existsSync(WARNED)).toBe(false);
		expect(readdirSync(CLAUDE.dir)).toEqual([]);
	});
});

describe("approved cache", () => {
	test("a successful fetch writes the cache atomically at 0600 and leaves no temp file", async () => {
		skill(LIB, "a");
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["b", "a"]))), [], []));
		expect((lstatSync(CACHE).mode & 0o777).toString(8)).toBe("600");
		expect([...(readApprovedCache(CACHE)?.names ?? [])].sort()).toEqual(["a", "b"]);
		expect(readdirSync(join(T, "state")).filter((f) => f.endsWith(".substrate-tmp"))).toEqual([]);
	});

	test("when the fetch fails the cached set decides: cached skills link, others are held", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		mkdirSync(join(T, "state"), { recursive: true });
		writeApprovedCache(CACHE, new Set(["a"]), 0);
		const warnings: WarningEvent[] = [];
		const out: string[] = [];
		await project(opts(gov("enforce", unreachable()), warnings, out));
		expect(linked("a")).toBe(true);
		expect(linked("b")).toBe(false);
		expect(out.some((l) => l.includes("using the cached set"))).toBe(true);
		expect((warnings[0]?.payload as { reason: string }).reason).toBe("unapproved");
	});

	test("with no cache and no answer nothing new is linked, existing links stay, and one warning says why", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		symlinkSync(join(LIB, "a"), join(CLAUDE.dir, "a"));
		const warnings: WarningEvent[] = [];
		const run = () => project(opts(gov("enforce", unreachable()), warnings, []));
		await run();
		await run();
		expect(readlinkSync(join(CLAUDE.dir, "a"))).toBe(join(LIB, "a"));
		expect(linked("b")).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "skills.sync", reason: "approved-list-unavailable", mode: "enforce", count: 2, names: [] });
	});

	test("a corrupt, oversized, wrong-version or badly named cache is ignored, never partly trusted", () => {
		mkdirSync(join(T, "state"), { recursive: true });
		const bad: Record<string, string> = {
			garbage: "{not json",
			array: "[]",
			version: JSON.stringify({ version: 2, names: ["a"] }),
			names: JSON.stringify({ version: 1, names: "a" }),
			path: JSON.stringify({ version: 1, names: ["a", "../b"] }),
			number: JSON.stringify({ version: 1, names: ["a", 7] }),
			big: JSON.stringify({ version: 1, names: ["a"], pad: "x".repeat(MAX_CACHE_BYTES) }),
			many: JSON.stringify({ version: 1, names: Array.from({ length: MAX_APPROVED + 1 }, (_, i) => `n${i}`) }),
		};
		for (const [label, body] of Object.entries(bad)) {
			writeFileSync(CACHE, body);
			expect([label, readApprovedCache(CACHE)]).toEqual([label, null]);
		}
		writeFileSync(CACHE, JSON.stringify({ version: 1, names: ["a"] }));
		expect([...(readApprovedCache(CACHE)?.names ?? [])]).toEqual(["a"]);
		rmSync(CACHE);
		expect(readApprovedCache(CACHE)).toBeNull();
	});

	test("a corrupt cache after a failed fetch fails closed for new links", async () => {
		skill(LIB, "a");
		mkdirSync(join(T, "state"), { recursive: true });
		writeFileSync(CACHE, "{not json");
		const warnings: WarningEvent[] = [];
		await project(opts(gov("enforce", unreachable()), warnings, []));
		expect(linked("a")).toBe(false);
		expect((warnings[0]?.payload as { reason: string }).reason).toBe("approved-list-unavailable");
	});

	test("a cache that cannot be written is one stdout line, not a failed run or a lost projection", async () => {
		skill(LIB, "a");
		mkdirSync(CACHE, { recursive: true });
		const out: string[] = [];
		await project(opts(gov("report", fakeFetch(() => approvedBody(["a"]))), [], out));
		expect(linked("a")).toBe(true);
		expect(out.some((l) => l.includes("governance cache not written"))).toBe(true);
	});
});

describe("names from the server", () => {
	test("path-like, mis-cased, empty and non-string names are dropped; valid ones and the truncation flag survive", () => {
		const parsed = parseApproved({
			truncated: true,
			skills: [{ name: "../etc" }, { name: "a/b" }, { name: "A" }, { name: "" }, { name: 5 }, null, "str", { name: "x".repeat(65) }, { name: "ok-1" }, { name: "constructor" }],
		});
		expect([...(parsed?.names ?? [])].sort()).toEqual(["constructor", "ok-1"]);
		expect(parsed?.dropped).toBe(8);
		expect(parsed?.truncated).toBe(true);
	});

	test("a missing skills array is a malformed answer, not an empty approval list", () => {
		expect(parseApproved({ governance: "report" })).toBeNull();
		expect(parseApproved({ skills: "a" })).toBeNull();
		expect(parseApproved([])).toBeNull();
		expect(parseApproved(null)).toBeNull();
	});

	test("more than 500 entries keep the first 500 and say truncated", () => {
		const parsed = parseApproved({ skills: Array.from({ length: MAX_APPROVED + 5 }, (_, i) => ({ name: `n${i}` })) });
		expect(parsed?.names.size).toBe(MAX_APPROVED);
		expect(parsed?.truncated).toBe(true);
	});

	test("a hostile name approves nothing outside the library and never reaches a path", async () => {
		skill(LIB, "a");
		const warnings: WarningEvent[] = [];
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["../a", "a/../a"]))), warnings, []));
		expect(linked("a")).toBe(false);
		expect(existsSync(CACHE) ? readApprovedCache(CACHE)?.names : new Set()).toEqual(new Set());
		expect((warnings[0]?.payload as { names: string[] }).names).toEqual(["a"]);
	});
});

describe("fetch outcome reasons", () => {
	test("a 200 body that is not JSON is a malformed answer, not an unreachable substrate", async () => {
		for (const body of ["<html>proxy</html>", ""]) {
			expect(await fetchApproved(TARGET, fakeFetch(() => new Response(body)))).toEqual({ ok: false, reason: "skills answer malformed" });
		}
		const refused = await fetchApproved(TARGET, unreachable());
		expect(refused.ok === false && refused.reason.startsWith("skills unreachable: ")).toBe(true);
	});
});

describe("one identity for the fetch and the warning", () => {
	/** The Authorization header postWarning sends for `env`; null when none. */
	async function sentAuth(env: NodeJS.ProcessEnv): Promise<string | null> {
		let auth: string | null = null;
		const seen = fakeFetch(() => new Response("{}"));
		const ok = await postWarning({ surface: "substrate", kind: "warning", actor: "agent", summary: "s", payload: {} }, env, seen);
		expect(ok).toBe(true);
		auth = seen.calls[0]?.auth ?? null;
		return auth;
	}

	test("an env that holds only the unit's own token posts with it", async () => {
		expect(await sentAuth({ SUBSTRATE_TOKEN_SUBSTRATE: "unit-tok" })).toBe("Bearer unit-tok");
	});

	test("a comma list contributes its first entry, never the whole list; the unit token wins over the generic one", async () => {
		expect(await sentAuth({ SUBSTRATE_TOKEN_SUBSTRATE: "first, second" })).toBe("Bearer first");
		expect(await sentAuth({ SUBSTRATE_TOKEN: ",gen-one,gen-two" })).toBe("Bearer gen-one");
		expect(await sentAuth({ SUBSTRATE_TOKEN_SUBSTRATE: "unit", SUBSTRATE_TOKEN: "generic" })).toBe("Bearer unit");
		expect(await sentAuth({})).toBeNull();
	});

	test("the token the warning is posted with is the token the approved list was fetched with", () => {
		for (const env of [{ SUBSTRATE_TOKEN_SUBSTRATE: "u1,u2" }, { SUBSTRATE_TOKEN: "g1,g2" }, { SUBSTRATE_TOKEN_SUBSTRATE: " ", SUBSTRATE_TOKEN: "g" }]) {
			expect(governanceFromEnv(env).target?.token).toBe(resolveSurfaceToken(env));
		}
	});
});

describe("warning clock", () => {
	test("a clock that steps backwards does not silence the warning until the old timestamp is reached again", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		let clock = 10 * RENOTIFY_MS;
		const warnings: WarningEvent[] = [];
		const fetched = fakeFetch(() => approvedBody(["a"]));
		const run = () => project(opts(gov("report", fetched, { now: () => clock }), warnings, []));
		await run();
		expect(warnings).toHaveLength(1);
		clock -= 5 * RENOTIFY_MS;
		await run();
		expect(warnings).toHaveLength(2);
		await run();
		expect(warnings).toHaveLength(2);
	});
});

describe("a list the server cut", () => {
	test("enforce holds approved-beyond-the-cut skills, says so with its own reason, and remembers the cut in the cache", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		const warnings: WarningEvent[] = [];
		await project(opts(gov("enforce", fakeFetch(() => approvedBody(["a"], { truncated: true }))), warnings, []));
		expect(linked("a")).toBe(true);
		expect(linked("b")).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "skills.sync", reason: "approved-list-truncated", mode: "enforce", count: 1, names: ["b"], truncated: true });
		expect(readApprovedCache(CACHE)?.truncated).toBe(true);
	});

	test("the cut survives a fetch failure: the cached set still reports approved-list-truncated", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		mkdirSync(join(T, "state"), { recursive: true });
		writeApprovedCache(CACHE, new Set(["a"]), 0, true);
		const warnings: WarningEvent[] = [];
		await project(opts(gov("report", unreachable()), warnings, []));
		expect((warnings[0]?.payload as { reason: string }).reason).toBe("approved-list-truncated");
	});

	test("a complete list keeps the plain unapproved reason and carries no truncated field", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		const warnings: WarningEvent[] = [];
		await project(opts(gov("report", fakeFetch(() => approvedBody(["a"]))), warnings, []));
		expect(warnings[0]?.payload.reason).toBe("unapproved");
		expect(Object.hasOwn(warnings[0]?.payload ?? {}, "truncated")).toBe(false);
		expect(readApprovedCache(CACHE)?.truncated).toBe(false);
	});

	test("a cache whose truncated field is not a boolean is ignored whole", () => {
		mkdirSync(join(T, "state"), { recursive: true });
		writeFileSync(CACHE, JSON.stringify({ version: 1, truncated: "yes", names: ["a"] }));
		expect(readApprovedCache(CACHE)).toBeNull();
	});
});

describe("events posted with the unit's host-job token", () => {
	const UNIT_ENV = { SUBSTRATE_TOKEN_SUBSTRATE: "unit-tok", SUBSTRATE_TOKEN: "agent-tok" };

	/** A POST /events twin: bearer -> caller surface, then the server's real `attributedSurface` (403 on a mismatch). */
	function eventsServer(bearers: Record<string, Surface>): { fetchImpl: typeof fetch; stored: WarningEvent[]; refused: string[] } {
		const stored: WarningEvent[] = [];
		const refused: string[] = [];
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
			const caller = Object.hasOwn(bearers, bearer) ? bearers[bearer] : null;
			const body = JSON.parse(String(init?.body)) as WarningEvent;
			const attribution = attributedSurface(caller ?? null, body.surface);
			if ("refused" in attribution) {
				refused.push(attribution.refused);
				return new Response("{}", { status: 403 });
			}
			stored.push({ ...body, surface: attribution.surface });
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		return { fetchImpl, stored, refused };
	}

	const skipWarn: WarningEvent = {
		surface: "grok-build",
		kind: "warning",
		actor: "agent",
		summary: "skills projector left x alone (real-dir-differs)",
		payload: { component: "skills-projector", root: "grok", name: "x", reason: "real-dir-differs" },
	};

	test("a root's skip-warning is accepted: it is stored as substrate and keeps the root and its surface in the payload", async () => {
		const server = eventsServer({ "unit-tok": "substrate", "agent-tok": "cursor" });
		expect(await postWarning(skipWarn, UNIT_ENV, server.fetchImpl)).toBe(true);
		expect(server.refused).toEqual([]);
		expect(server.stored).toHaveLength(1);
		expect(server.stored[0]?.surface).toBe("substrate");
		expect(server.stored[0]?.payload).toEqual({ ...skipWarn.payload, root_surface: "grok-build" });
	});

	test("without the unit token the event goes out exactly as built, under the generic agent token", async () => {
		const server = eventsServer({ "agent-tok": "cursor" });
		expect(await postWarning(skipWarn, { SUBSTRATE_TOKEN: "agent-tok" }, server.fetchImpl)).toBe(true);
		expect(server.stored[0]).toEqual(skipWarn);
	});

	test("a substrate-surface event is not rewritten and gains no root_surface", async () => {
		const server = eventsServer({ "unit-tok": "substrate" });
		const own: WarningEvent = { ...skipWarn, surface: "substrate", payload: { action: "skills.sync", reason: "dirty" } };
		expect(await postWarning(own, UNIT_ENV, server.fetchImpl)).toBe(true);
		expect(server.stored[0]).toEqual(own);
	});

	test("the server twin does refuse a non-substrate surface with the unit token (the premise the rewrite answers)", () => {
		expect("refused" in attributedSurface("substrate", "grok-build")).toBe(true);
	});

	test("apply's skip-warnings reach the ledger once and enter the dedupe file", async () => {
		skill(LIB, "real");
		skill(CLAUDE.dir, "real");
		writeFileSync(join(CLAUDE.dir, "real", "SKILL.md"), "different\n");
		const server = eventsServer({ "unit-tok": "substrate", "agent-tok": "cursor" });
		const actions = plan([inventory(CLAUDE)], ["real"], { libraryDir: LIB, exportsDir: EXP });
		const applyCtx = { backupDir: join(T, "bk"), stateFile: STATE, log: () => undefined, emitWarning: (event: WarningEvent) => postWarning(event, UNIT_ENV, server.fetchImpl) };
		expect(await apply(actions, applyCtx)).toEqual({ actions: 0, warnings: 1 });
		expect(server.stored.map((e) => [e.surface, e.payload.root, e.payload.root_surface, e.payload.reason])).toEqual([["substrate", "claude", "claude-code", "real-dir-differs"]]);
		expect(readFileSync(STATE, "utf8")).toContain("claude:real:real-dir-differs");
		expect(await apply(actions, applyCtx)).toEqual({ actions: 0, warnings: 0 });
		expect(server.stored).toHaveLength(1);
	});

	test("a governance warning posted with the unit token is accepted", async () => {
		skill(LIB, "a");
		skill(LIB, "b");
		const server = eventsServer({ "unit-tok": "substrate", "agent-tok": "cursor" });
		const options = opts(gov("report", fakeFetch(() => approvedBody(["a"]))), [], [], (event) => postWarning(event, UNIT_ENV, server.fetchImpl));
		await project(options);
		expect(server.refused).toEqual([]);
		expect(server.stored.map((e) => [e.surface, e.payload.action, e.payload.reason])).toEqual([["substrate", "skills.sync", "unapproved"]]);
		expect(Object.hasOwn(server.stored[0]?.payload ?? {}, "root_surface")).toBe(false);
		expect(Object.hasOwn(JSON.parse(readFileSync(WARNED, "utf8")), "unapproved")).toBe(true);
	});
});
