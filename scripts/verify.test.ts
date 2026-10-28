/**
 * Tests for `scripts/verify.ts`, the local mirror of the CI gate.
 *
 * The parsers and the step selection are pure. `runStep` is exercised against
 * tiny `bun -e` programs, never the real gate, so the file stays fast. The
 * drift test reads `.github/workflows/ci.yml` and fails when the workflow runs
 * different commands from the ones `bun run verify` runs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	GATE_STEPS,
	main,
	parseArgs,
	parseTestCounts,
	runStep,
	selectSteps,
	skipNote,
	tailLines,
	type GateStep,
	type StepResult,
} from "./verify.ts";

const ROOT = join(import.meta.dir, "..");
const BUN = process.execPath;

const options = (argv: string[]) => {
	const parsed = parseArgs(argv);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
};
const ids = (argv: string[]): string[] => {
	const steps = selectSteps(options(argv));
	if ("error" in steps) throw new Error(steps.error);
	return steps.map((step) => step.id);
};

describe("parseArgs", () => {
	test("defaults select the six gate steps and leave the audit out", () => {
		expect(options([])).toEqual({ audit: false, only: null, skip: [], keepGoing: false, list: false, help: false });
		expect(ids([])).toEqual(["install", "types", "lint", "tests", "python", "locks"]);
	});

	test("--audit appends the audit; --only names exactly the steps asked for, in gate order", () => {
		expect(ids(["--audit"])).toEqual(["install", "types", "lint", "tests", "python", "locks", "audit"]);
		expect(ids(["--only", "locks,types"])).toEqual(["types", "locks"]);
		expect(ids(["--only=audit"])).toEqual(["audit"]);
	});

	test("--skip removes steps, repeats accumulate, and --only plus --skip compose", () => {
		expect(ids(["--skip", "install"])).toEqual(["types", "lint", "tests", "python", "locks"]);
		expect(ids(["--skip=install", "--skip", "tests"])).toEqual(["types", "lint", "python", "locks"]);
		expect(ids(["--only", "types,tests", "--skip", "tests"])).toEqual(["types"]);
	});

	test("--keep-going, --list and --help are flags", () => {
		expect(options(["--keep-going", "--list", "-h"])).toMatchObject({ keepGoing: true, list: true, help: true });
	});

	test("an unknown option, a missing value, an empty list or an unknown step is refused", () => {
		expect(parseArgs(["--nope"])).toEqual({ error: "unknown option --nope" });
		expect(parseArgs(["--only"])).toEqual({ error: "--only needs a value" });
		expect(parseArgs(["--only", "--audit"])).toEqual({ error: "--only needs a value" });
		expect(parseArgs(["--skip="])).toEqual({ error: "--skip needs at least one step id" });
		expect(parseArgs(["--only=nope"])).toEqual({ error: expect.stringContaining("unknown step nope") });
		expect(parseArgs(["--onlyfoo"])).toEqual({ error: "unknown option --onlyfoo" });
	});

	test("selecting nothing is an error rather than a silent pass", () => {
		expect(selectSteps({ audit: false, only: ["audit"], skip: ["audit"] })).toEqual({ error: "no steps selected" });
	});
});

describe("parseTestCounts and skipNote", () => {
	const summary = "\n 1455 pass\n 56 skip\n 0 fail\nRan 1511 tests across 52 files. [9.92s]\n";

	test("reads pass, skip and fail from bun's summary", () => {
		expect(parseTestCounts(summary)).toEqual({ pass: 1455, skip: 56, fail: 0 });
		expect(parseTestCounts(" 3 pass\n 2 fail\n")).toEqual({ pass: 3, skip: 0, fail: 2 });
	});

	test("returns null when there is no summary, instead of guessing", () => {
		expect(parseTestCounts("error: Cannot find module")).toBeNull();
		expect(parseTestCounts(" 4 pass\n")).toBeNull();
	});

	test("the skip note appears only when tests were skipped and no scratch database is configured", () => {
		const counts = { pass: 10, skip: 56, fail: 0 };
		expect(skipNote(counts, {})).toContain("56 tests skipped");
		expect(skipNote(counts, { SUBSTRATE_TEST_PG_URL: "" })).toContain("SUBSTRATE_TEST_PG_URL is unset");
		// The live suites trim the value before they skip, so blank counts as unset here too.
		expect(skipNote(counts, { SUBSTRATE_TEST_PG_URL: "   " })).toContain("SUBSTRATE_TEST_PG_URL is unset");
		expect(skipNote(counts, { SUBSTRATE_TEST_PG_URL: "postgres://scratch" })).toBeNull();
		expect(skipNote({ pass: 10, skip: 0, fail: 0 }, {})).toBeNull();
		expect(skipNote(null, {})).toBeNull();
	});
});

describe("tailLines", () => {
	test("keeps the last non-empty lines, indented", () => {
		expect(tailLines("a\n\nb\nc\n", 2)).toBe("    b\n    c");
		expect(tailLines("only\n", 5)).toBe("    only");
		expect(tailLines("", 5)).toBe("");
	});
});

describe("runStep", () => {
	test("a passing command is ok and its output is captured", async () => {
		const result = await runStep({ label: "echo", argv: [BUN, "-e", "console.log('hello')"] }, ROOT);
		expect(result).toMatchObject({ label: "echo", ok: true, code: 0 });
		expect(result.output).toContain("hello");
		expect(result.ms).toBeGreaterThanOrEqual(0);
	});

	test("a failing command reports its exit code and both streams", async () => {
		const result = await runStep(
			{ label: "boom", argv: [BUN, "-e", "console.log('out'); console.error('err'); process.exit(3)"] },
			ROOT,
		);
		expect(result).toMatchObject({ ok: false, code: 3 });
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	test("a command that overruns its timeout is killed and reported without an exit code", async () => {
		const result = await runStep({ label: "slow", argv: [BUN, "-e", "setTimeout(() => {}, 30_000)"] }, ROOT, process.env, 300);
		expect(result.ok).toBe(false);
		expect(result.code).toBeNull();
	});

	test("a program that cannot start fails the step instead of throwing", async () => {
		const result = await runStep({ label: "missing", argv: ["/nonexistent/substrate-verify-test"] }, ROOT);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("could not start");
	});
});

/** Run `body` with the process's stdout and stderr silenced, so usage text does not clutter the test log. */
async function quietly<T>(body: () => Promise<T>): Promise<{ result: T; written: string }> {
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	let written = "";
	const capture = (chunk: string | Uint8Array): boolean => {
		written += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	};
	process.stdout.write = capture as typeof process.stdout.write;
	process.stderr.write = capture as typeof process.stderr.write;
	try {
		return { result: await body(), written };
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
}

/** A fake `run` for `main`: records which steps were attempted and answers from a table keyed by step id. */
function fakeRun(outcomes: Partial<Record<GateStep["id"], Partial<StepResult>>> = {}) {
	const ran: string[] = [];
	const run = async (step: GateStep): Promise<StepResult> => {
		ran.push(step.id);
		const output = step.id === "tests" ? "\n 12 pass\n 3 skip\n 0 fail\n" : `output of ${step.id}\n`;
		return { label: step.label, ok: true, code: 0, ms: 5, output, ...outcomes[step.id] };
	};
	return { ran, run };
}

describe("main", () => {
	test("--help and --list exit 0; bad usage exits 2 with the reason and the usage text", async () => {
		const help = await quietly(() => main(["--help"]));
		expect(help.result).toBe(0);
		expect(help.written).toContain("Usage: bun run verify");
		const list = await quietly(() => main(["--list"]));
		expect(list.result).toBe(0);
		expect(list.written).toContain("bun run check:phase-close");
		const bogus = await quietly(() => main(["--bogus"]));
		expect(bogus.result).toBe(2);
		expect(bogus.written).toContain("unknown option --bogus");
		const empty = await quietly(() => main(["--only", "audit", "--skip", "audit"]));
		expect(empty.result).toBe(2);
		expect(empty.written).toContain("no steps selected");
	});

	test("an all-pass run runs the six gate steps in order, reports the suite counts and exits 0", async () => {
		const { ran, run } = fakeRun();
		const { result, written } = await quietly(() => main([], { run, env: { SUBSTRATE_TEST_PG_URL: "postgres://scratch" } }));

		expect(result).toBe(0);
		expect(ran).toEqual(["install", "types", "lint", "tests", "python", "locks"]);
		expect(written).toContain("ok   Test suite (0.0s): 12 pass, 3 skip, 0 fail");
		expect(written).toContain("[verify] pass: install, types, lint, tests, python, locks");
		expect(written).not.toContain("FAIL");
		expect(written).not.toContain("note");
	});

	test("the first failing step stops the run, shows its output tail and exits 1", async () => {
		const { ran, run } = fakeRun({ types: { ok: false, code: 2, output: "src/a.ts(1,1): error TS2322\n" } });
		const { result, written } = await quietly(() => main([], { run }));

		expect(result).toBe(1);
		expect(ran).toEqual(["install", "types"]);
		expect(written).toContain("FAIL Typecheck");
		expect(written).toContain("exit 2");
		expect(written).toContain("error TS2322");
		expect(written).toContain("[verify] FAIL: Typecheck");
		expect(written).not.toContain("[verify] pass:");
	});

	test("--keep-going runs every selected step after a failure and still exits 1", async () => {
		const { ran, run } = fakeRun({ types: { ok: false, code: 2 }, locks: { ok: false, code: 1 } });
		const { result, written } = await quietly(() => main(["--keep-going"], { run }));

		expect(result).toBe(1);
		expect(ran).toEqual(["install", "types", "lint", "tests", "python", "locks"]);
		expect(written).toContain("[verify] FAIL: Typecheck, Repo locks");
	});

	test("a killed step is reported as killed, not as an exit code", async () => {
		const { run } = fakeRun({ install: { ok: false, code: null, output: "" } });
		const { result, written } = await quietly(() => main([], { run }));

		expect(result).toBe(1);
		expect(written).toContain("killed (timeout or could not start)");
	});

	test("--audit adds the audit step and --skip leaves one out", async () => {
		const audited = fakeRun();
		await quietly(() => main(["--audit"], { run: audited.run }));
		expect(audited.ran).toEqual(["install", "types", "lint", "tests", "python", "locks", "audit"]);

		const skipped = fakeRun();
		await quietly(() => main(["--skip", "install,tests"], { run: skipped.run }));
		expect(skipped.ran).toEqual(["types", "lint", "python", "locks"]);
	});

	test("skipped live tests are noted unless a scratch database is configured (blank counts as unset)", async () => {
		for (const [env, noted] of [
			[{}, true],
			[{ SUBSTRATE_TEST_PG_URL: "   " }, true],
			[{ SUBSTRATE_TEST_PG_URL: "postgres://scratch" }, false],
		] as const) {
			const { run } = fakeRun();
			const { written } = await quietly(() => main(["--only", "tests"], { run, env }));
			expect(written.includes("3 tests skipped because SUBSTRATE_TEST_PG_URL is unset")).toBe(noted);
		}
	});
});

describe("the gate matches the CI workflow", () => {
	const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
	const between = (from: string, to?: string): string => {
		const start = workflow.indexOf(`\n  ${from}:`);
		const end = to ? workflow.indexOf(`\n  ${to}:`) : workflow.length;
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return workflow.slice(start, end);
	};
	const runLines = (job: string): string[] => [...job.matchAll(/^\s+run: (.+)$/gm)].map((match) => (match[1] as string).trim());

	test("the verify job runs exactly the non-opt-in gate commands, in order", () => {
		const gate = GATE_STEPS.filter((step) => !step.optIn).map((step) => step.argv.join(" "));
		expect(runLines(between("verify", "dependency-audit"))).toEqual(gate);
	});

	test("the audit job runs the opt-in audit command after a frozen install", () => {
		const audit = GATE_STEPS.find((step) => step.id === "audit");
		if (audit === undefined) throw new Error("the gate has no audit step");
		expect(audit.optIn).toBe(true);
		expect(runLines(between("dependency-audit", "boot-gate"))).toEqual(["bun install --frozen-lockfile --ignore-scripts", audit.argv.join(" ")]);
	});

	test("the boot-gate job is report-only, opt-in on its own variable, and runs only the install and `bun run gate:boot`", () => {
		const job = between("boot-gate");
		// The harness refuses a checkout without node_modules, so the install is a prerequisite, not part of the gate.
		expect(runLines(job)).toEqual(["bun install --frozen-lockfile", "bun run gate:boot"]);
		expect(job).toMatch(/^ {4}continue-on-error: true$/m);
		expect(job).toMatch(/^ {4}if: .*vars\.CI_ENABLED == 'true'.*vars\.BOOT_GATE == 'true'/m);
		// The harness owns its own scratch stores; a service container would be a second, shared one.
		expect(job).not.toMatch(/^ {4}services:/m);
		// Neither gating job may become advisory by accident.
		expect(between("verify", "dependency-audit")).not.toContain("continue-on-error");
		expect(between("dependency-audit", "boot-gate")).not.toContain("continue-on-error");
	});

	test("every job stays behind the CI_ENABLED switch", () => {
		const ifLines = [...workflow.matchAll(/^ {4}if: (.+)$/gm)].map((match) => match[1] as string);
		const jobCount = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}[a-z][a-z-]*:$/gm)].length;
		expect(ifLines).toHaveLength(jobCount);
		for (const line of ifLines) expect(line).toContain("vars.CI_ENABLED == 'true'");
	});

	test("every job's `if:` is exactly its reviewed expression, so only same-repo pull requests reach the shared runner", () => {
		const sameRepoOnly = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
		// A deliberate table: adding, removing or editing a job's condition must be reflected here.
		const expected: Record<string, string> = {
			verify: `vars.CI_ENABLED == 'true' && github.event_name != 'schedule' && ${sameRepoOnly}`,
			"dependency-audit": "vars.CI_ENABLED == 'true' && github.event_name != 'pull_request'",
			"boot-gate": `vars.CI_ENABLED == 'true' && vars.BOOT_GATE == 'true' && github.event_name != 'schedule' && ${sameRepoOnly}`,
		};
		const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
		const ids = [...jobsSection.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1] as string);
		expect([...ids].sort()).toEqual(Object.keys(expected).sort());
		ids.forEach((id, index) => {
			const ifLines = [...between(id, ids[index + 1]).matchAll(/^ {4}if: (.+)$/gm)].map((match) => match[1] as string);
			expect(ifLines).toEqual([expected[id] as string]);
		});
	});

	test("package.json exposes the gate as `bun run verify`", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
		expect(manifest.scripts.verify).toBe("bun scripts/verify.ts");
	});
});
