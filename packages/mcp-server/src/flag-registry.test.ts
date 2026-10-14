/**
 * The flag-registry lock (uplift-5 U5-7).
 *
 * What each group proves, and the bug it would catch:
 * - the lock: code that reads an environment variable nobody registered fails
 *   here, so a flag cannot ship undocumented; a PLANTED fixture proves the
 *   scanner would catch one (without it the lock could pass because the scanner
 *   is blind, which is exactly how the first ~45 undocumented names went unseen);
 * - the scanner's forms: constant-name declarations, composed prefixes and
 *   index access are reads, a comment is not;
 * - the registry is not stale: every row is read by something, every exemption
 *   is used, every family is live, so rows cannot rot after a flag is removed;
 * - `.env.example` agrees with the `documented` flag in both directions, and
 *   every name it lists is registered;
 * - the registry's defaults are the code's defaults for the policy flags, so
 *   the advisor's "safe" value and the document cannot disagree with `loadConfig`;
 * - each promotion criterion names a real series with real label values.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_RECALL_RESULTS, CACHE_METRIC_RESULTS, MEMORY_EXPIRED_MODES, RECALL_PREFETCH_RESULTS } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import { envReadSources, scanFiles, scanSource, type EnvRead } from "./flag-registry-scan.ts";
import { EXTENDED_COVERAGE_SERIES, FLAGS, FLAG_FAMILIES, REGISTRY_EXEMPT, findUnregistered, policyFlags, registeredNames } from "./flag-registry.ts";
import { sweepModeFromEnv } from "./index-sweep.ts";
import { METRIC_SERIES } from "./metrics-history.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

const where = (reads: readonly EnvRead[]): string[] => reads.map((read) => `${read.name} (${read.form}) ${read.file}:${read.line}`);

let realReads: EnvRead[] | null = null;
async function readsOfTree(): Promise<EnvRead[]> {
	realReads ??= scanFiles(await envReadSources(ROOT), ROOT);
	return realReads;
}

describe("the lock: every environment read has a registry row", () => {
	test("no name read by packages/** or scripts/** (tests excluded) is missing from the registry", async () => {
		expect(where(findUnregistered(await readsOfTree()))).toEqual([]);
	});

	test("a planted unregistered read is caught in every form the repo uses", () => {
		const planted = [
			"const a = process.env.SUBSTRATE_PLANTED_DOT;",
			'const b = env["SUBSTRATE_PLANTED_INDEX"];',
			"const c = io.env.SUBSTRATE_PLANTED_NESTED?.trim();",
			'export const PLANTED_ENV = "SUBSTRATE_PLANTED_CONSTANT";',
			'const d = env("SUBSTRATE_PLANTED_CALL");',
			"const e = env[`SUBSTRATE_PLANTED_FAMILY_${suffix}`];",
		].join("\n");
		const caught = findUnregistered(scanSource("fixture.ts", planted)).map((read) => read.name);
		expect(new Set(caught)).toEqual(
			new Set(["SUBSTRATE_PLANTED_DOT", "SUBSTRATE_PLANTED_INDEX", "SUBSTRATE_PLANTED_NESTED", "SUBSTRATE_PLANTED_CONSTANT", "SUBSTRATE_PLANTED_CALL", "SUBSTRATE_PLANTED_FAMILY_"]),
		);
	});

	test("a helper call with a prefix the scanner has never heard of, and destructured reads, are caught", () => {
		const planted = [
			'const engine = env("RIVET_PLANTED_ENGINE") === "1";',
			'const other = readEnv("ZZPLANTED_HELPER_VAR", fallback);',
			"const { SUBSTRATE_PLANTED_D1, SUBSTRATE_PLANTED_D2: alias, HOME } = process.env;",
			"const {",
			"\tSUBSTRATE_PLANTED_MULTI = 5,",
			"\tZZPLANTED_DESTRUCTURED,",
			"} = Bun.env;",
			'const { notAConstantName } = process.env;',
			'const { unrelated } = options;',
		].join("\n");
		const reads = scanSource("fixture.ts", planted);
		expect(new Set(findUnregistered(reads).map((read) => read.name))).toEqual(
			new Set(["RIVET_PLANTED_ENGINE", "ZZPLANTED_HELPER_VAR", "SUBSTRATE_PLANTED_D1", "SUBSTRATE_PLANTED_D2", "SUBSTRATE_PLANTED_MULTI", "ZZPLANTED_DESTRUCTURED"]),
		);
		// A lower-case destructured binding is not a variable name, and an object that is not an env is not an env read.
		expect(reads.map((read) => read.name)).not.toContain("notAConstantName");
		expect(reads.map((read) => read.name)).not.toContain("unrelated");
	});

	test("the real tree's helper-call reads are seen: RIVET_RUN_ENGINE is read, registered, and documented", async () => {
		const reads = await readsOfTree();
		for (const name of ["RIVET_RUN_ENGINE", "RIVET_RUN_ENGINE_HOST"]) {
			expect({ name, read: reads.some((read) => read.name === name && read.file === "packages/host/src/main.ts") }).toEqual({ name, read: true });
			expect(registeredNames().has(name)).toBe(true);
		}
	});

	test("the same planted read in a file handed to scanFiles is caught, with its line", () => {
		const dir = mkdtempSync(join(tmpdir(), "flag-registry-"));
		try {
			const file = join(dir, "planted.ts");
			writeFileSync(file, 'import x from "y";\n\nexport const limit = Number(process.env.SUBSTRATE_PLANTED_LIMIT);\n');
			const unregistered = findUnregistered(scanFiles([file]));
			expect(unregistered.map((read) => [read.name, read.line])).toEqual([["SUBSTRATE_PLANTED_LIMIT", 3]]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("registered names, exempt platform variables and comments are not reads to report", () => {
		const fixture = [
			"const ok = process.env.SUBSTRATE_PORT;",
			"const home = process.env.HOME;",
			"// process.env.SUBSTRATE_PLANTED_IN_LINE_COMMENT",
			"/**",
			" * `SUBSTRATE_PLANTED_IN_DOC` and env.SUBSTRATE_PLANTED_IN_BLOCK are prose",
			" */",
			'const sentence = "set SUBSTRATE_PLANTED_SENTENCE=1 to enable";',
		].join("\n");
		expect(where(findUnregistered(scanSource("fixture.ts", fixture)))).toEqual([]);
		// And the scanner still saw the two real reads, so the empty result is not blindness.
		expect(scanSource("fixture.ts", fixture).map((read) => read.name).sort()).toEqual(["HOME", "SUBSTRATE_PORT"]);
	});

	test("a composed prefix with no family is a finding; a registered family prefix is not", () => {
		const reads = scanSource("fixture.ts", "const a = env[`SUBSTRATE_PLANTED_FAMILY_${s}`];\nconst b = `SUBSTRATE_TOKEN_${s.toUpperCase()}`;");
		expect(findUnregistered(reads).map((read) => read.name)).toEqual(["SUBSTRATE_PLANTED_FAMILY_"]);
	});
});

describe("the scanner reads this repo's own declaration styles", () => {
	test("constant-name declarations and composed prefixes are in the real tree's reads", async () => {
		const reads = await readsOfTree();
		const literal = new Set(reads.filter((read) => read.form === "literal").map((read) => read.name));
		// `INDEX_ROOTFS_ENV` and `TOKENS_BURN_ENV` are declared as constants and read later; no `process.env.X` mentions them.
		expect(literal.has("SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS")).toBe(true);
		expect(literal.has("SUBSTRATE_BURN_TOKENS_PER_HOUR")).toBe(true);
		const prefixes = new Set(reads.filter((read) => read.form === "template").map((read) => read.name));
		expect(prefixes.has("SUBSTRATE_TOKEN_")).toBe(true);
		expect(prefixes.has("SUBSTRATE_BUDGET_")).toBe(true);
	});
});

describe("the registry is not stale", () => {
	test("names are unique, across rows and family members", () => {
		const all = [...FLAGS.map((flag) => flag.name), ...FLAG_FAMILIES.flatMap((family) => family.members)];
		const duplicates = all.filter((name, index) => all.indexOf(name) !== index);
		expect(duplicates).toEqual([]);
		expect(registeredNames().size).toBe(all.length);
	});

	test("every row is read by the code (an `unread` row says so and is the only exception)", async () => {
		const read = new Set((await readsOfTree()).filter((entry) => entry.form !== "template").map((entry) => entry.name));
		const stale = FLAGS.filter((flag) => flag.status !== "unread" && flag.status !== "shell" && !read.has(flag.name)).map((flag) => flag.name);
		expect(stale).toEqual([]);
		const unreadButRead = FLAGS.filter((flag) => flag.status === "unread" && read.has(flag.name)).map((flag) => flag.name);
		expect(unreadButRead).toEqual([]);
	});

	test("a `shell` row is spelled in the infra shell file it names and read by no scanned TypeScript", async () => {
		const read = new Set((await readsOfTree()).filter((entry) => entry.form !== "template").map((entry) => entry.name));
		const shell = FLAGS.filter((flag) => flag.status === "shell");
		expect(shell.length).toBeGreaterThan(0);
		expect(shell.filter((flag) => read.has(flag.name)).map((flag) => flag.name)).toEqual([]);
		const unspelled = shell.filter((flag) => !existsSync(join(ROOT, flag.readBy)) || !readFileSync(join(ROOT, flag.readBy), "utf8").includes(flag.name)).map((flag) => flag.name);
		expect(unspelled).toEqual([]);
	});

	test("every family is live and every exemption is used", async () => {
		const reads = await readsOfTree();
		const seen = new Set(reads.map((read) => read.name));
		expect(FLAG_FAMILIES.filter((family) => !seen.has(family.prefix)).map((family) => family.pattern)).toEqual([]);
		expect(REGISTRY_EXEMPT.filter((entry) => !seen.has(entry.name)).map((entry) => entry.name)).toEqual([]);
		expect(REGISTRY_EXEMPT.filter((entry) => entry.reason.trim() === "").map((entry) => entry.name)).toEqual([]);
	});

	test("a family's members are what the code composes: one name per surface, one per class half", () => {
		const tokens = FLAG_FAMILIES.find((family) => family.prefix === "SUBSTRATE_TOKEN_")!;
		expect(tokens.members).toContain("SUBSTRATE_TOKEN_GROK_BOT");
		expect(tokens.members).toContain("SUBSTRATE_TOKEN_SWARM_A05_BE");
		expect(tokens.members).toContain("SUBSTRATE_TOKEN_SUBSTRATE");
		const budgets = FLAG_FAMILIES.find((family) => family.prefix === "SUBSTRATE_BUDGET_")!;
		expect(budgets.members).toContain("SUBSTRATE_BUDGET_READ_RPS");
		expect(budgets.members).toContain("SUBSTRATE_BUDGET_GROK_BOT_COORDINATION_BURST");
		expect(budgets.documentedMembers).toContain("SUBSTRATE_BUDGET_WRITE_BURST");
	});

	test("every doc a row points at exists", () => {
		const docs = new Set([...FLAGS.map((flag) => flag.doc), ...FLAG_FAMILIES.map((family) => family.doc)].filter((doc) => doc !== undefined));
		expect([...docs].filter((doc) => !existsSync(join(ROOT, doc))).sort()).toEqual([]);
	});
});

describe(".env.example agrees with the registry", () => {
	const lines = readFileSync(join(ROOT, ".env.example"), "utf8").split("\n");
	/** Names with a `NAME=` line, live or commented out; prose that merely mentions a name does not count. */
	const listed = new Set<string>();
	for (const line of lines) {
		const match = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
		if (match !== null) listed.add(match[1]!);
	}

	test("every row marked documented has a NAME= line, and every other row has none", () => {
		expect(FLAGS.filter((flag) => flag.documented && !listed.has(flag.name)).map((flag) => flag.name)).toEqual([]);
		expect(FLAGS.filter((flag) => !flag.documented && listed.has(flag.name)).map((flag) => flag.name)).toEqual([]);
	});

	test("every documented family member has a line", () => {
		expect(FLAG_FAMILIES.flatMap((family) => family.documentedMembers).filter((name) => !listed.has(name))).toEqual([]);
	});

	test("every name the file lists is registered", () => {
		const names = registeredNames();
		expect([...listed].filter((name) => !names.has(name))).toEqual([]);
	});
});

describe("the registry's defaults are the code's defaults", () => {
	const config = loadConfig({});
	const code: Record<string, string> = {
		SUBSTRATE_BUDGETS: config.admission.mode,
		SUBSTRATE_CACHE_SWR: config.cacheSwr,
		SUBSTRATE_BRIEF_PROFILE: config.briefProfile.mode,
		SUBSTRATE_BRIEF_RECALL: config.briefRecall.mode,
		SUBSTRATE_MEMORY_EXPIRY: config.memoryExpiry,
		SUBSTRATE_INDEX_SWEEP: sweepModeFromEnv({}),
		SUBSTRATE_INDEX_TUNE: config.indexArchive.tune,
		SUBSTRATE_HINDSIGHT_INVENTORY: config.hindsightInventory.enabled ? "on" : "off",
		SUBSTRATE_METRICS_HISTORY: config.metricsHistory.enabled ? "on" : "off",
	};

	test("each mode flag's registry default equals what loadConfig yields with nothing set", () => {
		for (const [name, value] of Object.entries(code)) {
			expect({ name, default: FLAGS.find((flag) => flag.name === name)?.default }).toEqual({ name, default: value });
		}
	});

	test("each policy's safe value is the default (or `unset` where the default is off)", () => {
		for (const flag of policyFlags()) {
			const policy = flag.policy!;
			expect(policy.safe === "unset" || policy.safe === flag.default).toBe(true);
		}
	});

	test("the flags that default off or report are off or report in the code, and the numeric boot defaults hold", () => {
		expect(config.sloNotify.enabled).toBe(false);
		expect(config.docsPruneSuperseded).toBe(false);
		expect(config.ledger.ttl).toBeNull();
		expect(config.cacheSwrWindowS).toBe(30);
		expect(config.briefBudgetMs).toBe(1200);
		expect(config.briefRecall.intervalS).toBe(120);
		expect(config.metricsHistory.ttlDays).toBe(14);
		for (const [name, value] of [
			["SUBSTRATE_CACHE_SWR_WINDOW_S", "30"],
			["SUBSTRATE_BRIEF_BUDGET_MS", "1200"],
			["SUBSTRATE_BRIEF_RECALL_INTERVAL_S", "120"],
			["SUBSTRATE_METRICS_HISTORY_TTL", "14d"],
		] as const) {
			expect({ name, default: FLAGS.find((flag) => flag.name === name)?.default }).toEqual({ name, default: value });
		}
	});
});

describe("promotion policies", () => {
	const closedLabels: Record<string, readonly string[]> = {
		"cache.operations": CACHE_METRIC_RESULTS,
		"brief.recall": BRIEF_RECALL_RESULTS,
		"recall.prefetch": RECALL_PREFETCH_RESULTS,
		"memory.expired": MEMORY_EXPIRED_MODES,
	};
	const terms = policyFlags().flatMap((flag) =>
		flag.policy!.evidence.flatMap((evidence) => [
			{ flag: flag.name, evidence, term: evidence.numerator },
			...(evidence.denominator === undefined ? [] : [{ flag: flag.name, evidence, term: evidence.denominator }]),
		]),
	);

	test("every flag that cites the history has at least one criterion, and a criterion is always a proposal", () => {
		expect(terms.length).toBeGreaterThan(0);
		for (const flag of policyFlags()) {
			for (const evidence of flag.policy!.evidence) {
				expect(evidence.proposed).toBe(true);
				expect(evidence.rationale.startsWith("PROPOSED")).toBe(true);
				expect(evidence.minSamples).toBeGreaterThanOrEqual(0);
				expect(Number.isFinite(evidence.threshold)).toBe(true);
				expect(/^[1-9][0-9]{0,3}[mhd]$/.test(evidence.window)).toBe(true);
				if (evidence.stat === "ratio") expect(evidence.denominator).toBeDefined();
			}
		}
	});

	test("a criterion's series is recorded (core) or declared extended, and its labels are in the series' closed set", () => {
		for (const { flag, evidence, term } of terms) {
			const label = `${flag} ${evidence.id} ${term.series}`;
			const core = Object.hasOwn(METRIC_SERIES, term.series);
			const closed = closedLabels[term.series];
			// An extended criterion's measured series is not in the core allow-list (that is what extended means); every other series must be.
			if (term === evidence.numerator && evidence.needs === "extended") expect({ label, core }).toEqual({ label, core: false });
			else expect({ label, known: core || closed !== undefined }).toEqual({ label, known: true });
			if (term.labels === undefined) continue;
			const allowed: ReadonlySet<string> | null = core ? METRIC_SERIES[term.series]!.values : closed === undefined ? null : new Set(closed);
			expect({ label, valid: allowed !== null && term.labels.every((value) => allowed.has(value)) }).toEqual({ label, valid: true });
		}
	});

	test("a policy's safe and enforcing values are values the flag accepts, and differ", () => {
		for (const flag of policyFlags()) {
			const policy = flag.policy!;
			expect(policy.safe).not.toBe(policy.enforcing);
			if (flag.kind !== "mode" && flag.kind !== "toggle") continue;
			const accepted = new Set(flag.allowed.split(/[\s|()]+/).filter((token) => token !== ""));
			if (policy.safe !== "unset") expect({ flag: flag.name, safe: accepted.has(policy.safe) }).toEqual({ flag: flag.name, safe: true });
			expect({ flag: flag.name, enforcing: accepted.has(policy.enforcing) }).toEqual({ flag: flag.name, enforcing: true });
		}
	});

	test("extended criteria are covered by an extended gauge that is not a core series, so core history cannot vouch for them", () => {
		expect(Object.hasOwn(METRIC_SERIES, EXTENDED_COVERAGE_SERIES)).toBe(false);
		const extended = policyFlags().flatMap((flag) => flag.policy!.evidence).filter((evidence) => evidence.needs === "extended");
		expect(extended.length).toBeGreaterThan(0);
		// An evidence row has no way to name a core series as its coverage: the field is gone, the advisor derives it.
		for (const evidence of extended) expect(Object.hasOwn(evidence, "coverageSeries")).toBe(false);
	});

	test("a flag with no history evidence says how the operator judges it instead", () => {
		for (const flag of policyFlags()) {
			const policy = flag.policy!;
			if (policy.evidence.length === 0) expect({ flag: flag.name, manual: (policy.manual ?? "").length > 0 }).toEqual({ flag: flag.name, manual: true });
		}
	});
});
