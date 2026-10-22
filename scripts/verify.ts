#!/usr/bin/env bun
/**
 * The repository's verification gate in one command.
 *
 * `bun run verify` runs the checks the CI workflow runs, in the same order:
 * a frozen-lockfile install, `tsc --noEmit`, the full test suite and the repo
 * locks (`check:phase-close`). `--audit` adds the known-vulnerability audit,
 * which needs the network. A step's output is shown only when the step fails;
 * otherwise one line per step reports its duration and, for the test suite,
 * the pass/skip/fail counts. The first failure stops the run unless
 * `--keep-going` is given.
 *
 * Usage: bun run verify [--audit] [--only id,id] [--skip id,id] [--keep-going] [--list] [--help]
 *
 * Exit codes: 0 every selected step passed, 1 a step failed, 2 bad usage.
 *
 * `scripts/verify.test.ts` fails when `.github/workflows/ci.yml` runs different
 * commands from the ones listed here, so the two cannot drift apart silently.
 */
import { join } from "node:path";

export type StepId = "install" | "types" | "tests" | "locks" | "audit";

export interface GateStep {
	readonly id: StepId;
	readonly label: string;
	readonly argv: readonly string[];
	/** Skipped unless asked for with `--audit` or named by `--only`. */
	readonly optIn?: boolean;
}

/** The gate, in run order. CI runs the same `argv` as separate workflow steps. */
export const GATE_STEPS: readonly GateStep[] = [
	{ id: "install", label: "Frozen-lockfile install", argv: ["bun", "install", "--frozen-lockfile"] },
	{ id: "types", label: "Typecheck", argv: ["bunx", "tsc", "--noEmit"] },
	{ id: "tests", label: "Test suite", argv: ["bun", "test"] },
	{ id: "locks", label: "Repo locks", argv: ["bun", "run", "check:phase-close"] },
	{ id: "audit", label: "Dependency audit", argv: ["bun", "scripts/audit-gate.ts"], optIn: true },
];

const STEP_IDS: readonly string[] = GATE_STEPS.map((step) => step.id);
const STEP_TIMEOUT_MS = 15 * 60_000;
const FAILURE_TAIL_LINES = 60;
const ROOT = join(import.meta.dir, "..");

export const USAGE = `Usage: bun run verify [options]

Runs the repository's verification gate (the same commands CI runs).

Options:
  --audit          also run the dependency audit (needs the network)
  --only a,b       run only these steps (ids: ${STEP_IDS.join(", ")})
  --skip a,b       leave these steps out
  --keep-going     run every selected step even after one fails
  --list           print the steps and exit
  -h, --help       print this help
`;

export interface VerifyOptions {
	audit: boolean;
	only: string[] | null;
	skip: string[];
	keepGoing: boolean;
	list: boolean;
	help: boolean;
}

const splitIds = (value: string): string[] =>
	value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);

/** Parse the command line; returns `{ error }` for an unknown flag, a missing value or an unknown step id. */
export function parseArgs(argv: readonly string[]): VerifyOptions | { error: string } {
	const options: VerifyOptions = { audit: false, only: null, skip: [], keepGoing: false, list: false, help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === "--audit") options.audit = true;
		else if (arg === "--keep-going") options.keepGoing = true;
		else if (arg === "--list") options.list = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else {
			const flag = /^(--only|--skip)(?:=(.*))?$/.exec(arg);
			if (flag === null) return { error: `unknown option ${arg}` };
			const name = flag[1] as "--only" | "--skip";
			let value = flag[2];
			if (value === undefined) {
				const next = argv[index + 1];
				if (next === undefined || next.startsWith("-")) return { error: `${name} needs a value` };
				value = next;
				index++;
			}
			const ids = splitIds(value);
			if (ids.length === 0) return { error: `${name} needs at least one step id` };
			const unknown = ids.filter((id) => !STEP_IDS.includes(id));
			if (unknown.length > 0) return { error: `unknown step ${unknown.join(", ")} (expected one of ${STEP_IDS.join(", ")})` };
			if (name === "--only") options.only = ids;
			else options.skip.push(...ids);
		}
	}
	return options;
}

/**
 * The steps to run, in gate order: every step that is not opt-in (plus the
 * audit with `--audit`), or exactly the `--only` ids, minus any `--skip` ids.
 */
export function selectSteps(options: Pick<VerifyOptions, "audit" | "only" | "skip">): GateStep[] | { error: string } {
	const selected = GATE_STEPS.filter((step) => {
		if (options.skip.includes(step.id)) return false;
		if (options.only !== null) return options.only.includes(step.id);
		return !step.optIn || options.audit;
	});
	return selected.length > 0 ? selected : { error: "no steps selected" };
}

export interface TestCounts {
	pass: number;
	skip: number;
	fail: number;
}

/** Read the counts from the end of `bun test` output; null when the summary is absent. */
export function parseTestCounts(output: string): TestCounts | null {
	const read = (word: string): number | null => {
		const match = output.match(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m"));
		return match?.[1] === undefined ? null : Number(match[1]);
	};
	const pass = read("pass");
	const fail = read("fail");
	if (pass === null || fail === null) return null;
	return { pass, skip: read("skip") ?? 0, fail };
}

/** A reminder when tests were skipped because no scratch database was configured; null otherwise. */
export function skipNote(counts: TestCounts | null, env: Readonly<Record<string, string | undefined>>): string | null {
	if (counts === null || counts.skip === 0) return null;
	// The live suites trim the variable before they decide to skip, so a blank value counts as unset.
	if (env.SUBSTRATE_TEST_PG_URL?.trim()) return null;
	return `${counts.skip} tests skipped because SUBSTRATE_TEST_PG_URL is unset; CI runs them against a scratch Postgres (see docs/ci.md).`;
}

/** The last `count` non-empty lines of `output`, indented for display under a failed step. */
export function tailLines(output: string, count: number): string {
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	return lines
		.slice(-count)
		.map((line) => `    ${line}`)
		.join("\n");
}

export interface StepResult {
	label: string;
	ok: boolean;
	/** Exit code, or null when the process was killed (timeout). */
	code: number | null;
	ms: number;
	output: string;
}

/** Run one step to completion with output captured (stdout then stderr), never throwing for a failing command. */
export async function runStep(
	step: Pick<GateStep, "label" | "argv">,
	cwd: string,
	env: Record<string, string | undefined> = process.env,
	timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<StepResult> {
	const started = performance.now();
	try {
		const proc = Bun.spawn([...step.argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const killed = proc.signalCode !== null;
		return { label: step.label, ok: code === 0 && !killed, code: killed ? null : code, ms: performance.now() - started, output: out + err };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { label: step.label, ok: false, code: null, ms: performance.now() - started, output: `could not start ${step.argv.join(" ")}: ${message}` };
	}
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Seams for the tests: how a step is run and which environment the skip note reads. */
export interface VerifyDeps {
	run?: (step: GateStep, cwd: string) => Promise<StepResult>;
	env?: Readonly<Record<string, string | undefined>>;
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: VerifyDeps = {}): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`[verify] ${parsed.error}\n${USAGE}`);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (parsed.list) {
		for (const step of GATE_STEPS) {
			process.stdout.write(`${step.id.padEnd(8)} ${step.argv.join(" ")}${step.optIn ? "  (opt-in: --audit)" : ""}\n`);
		}
		return 0;
	}
	const steps = selectSteps(parsed);
	if ("error" in steps) {
		process.stderr.write(`[verify] ${steps.error}\n${USAGE}`);
		return 2;
	}
	const failed: string[] = [];
	for (const step of steps) {
		const result = await (deps.run ?? runStep)(step, ROOT);
		const counts = step.id === "tests" ? parseTestCounts(result.output) : null;
		const detail = counts ? `: ${counts.pass} pass, ${counts.skip} skip, ${counts.fail} fail` : "";
		if (result.ok) {
			process.stdout.write(`[verify] ok   ${step.label} (${seconds(result.ms)})${detail}\n`);
			const note = skipNote(counts, deps.env ?? process.env);
			if (note) process.stdout.write(`[verify] note ${note}\n`);
			continue;
		}
		failed.push(step.label);
		const how = result.code === null ? "killed (timeout or could not start)" : `exit ${result.code}`;
		process.stdout.write(`[verify] FAIL ${step.label} (${seconds(result.ms)}): ${how}${detail}\n`);
		process.stdout.write(`${tailLines(result.output, FAILURE_TAIL_LINES)}\n`);
		if (!parsed.keepGoing) break;
	}
	if (failed.length > 0) {
		process.stdout.write(`[verify] FAIL: ${failed.join(", ")}\n`);
		return 1;
	}
	process.stdout.write(`[verify] pass: ${steps.map((step) => step.id).join(", ")}\n`);
	return 0;
}

if (import.meta.main) process.exit(await main());
