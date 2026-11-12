#!/usr/bin/env bun
/**
 * Compile the `substrate` CLI and the `substrate-mcp` server into standalone
 * executables, one per target:
 *
 *   dist/bin/<target>/substrate[.exe]
 *   dist/bin/<target>/substrate-mcp[.exe]
 *
 *   bun run build:binaries                        every target in TARGETS
 *   bun run build:binaries -- --target <target>   one target
 *
 * Each build is `bun build --compile --target=<target>`, so any host can emit
 * any target. The matrix job in .github/workflows/binaries.yml runs one target
 * per runner. A failed build is reported by target and makes the script exit 1.
 *
 * Standalone `substrate` REFUSES `index`, `ledger` and `consistency` (the chosen fix; the
 * alternative, bundling their runners and a Bun interpreter, was not straightforward here).
 * Those commands spawn a server-side `.ts` runner beside the source tree with `process.execPath`.
 * A compiled binary has neither the runner file nor a Bun interpreter, so it cannot run them.
 * The standalone `substrate` is therefore compiled from a generated guard entry
 * (`dist/entry/substrate.ts`) that looks at argv[2] before importing the CLI. For `index`,
 * `ledger` and `consistency` it writes `substrate <command> is not available in the standalone
 * binary: …` to stderr and exits 2 without importing anything. Every other command imports
 * packages/cli/src/index.ts unchanged. Source runs execute packages/cli/src/index.ts directly and
 * are unaffected. substrate-mcp has none of these commands and compiles from its entry as before.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64", "bun-linux-x64"] as const;
export type BinaryTarget = (typeof TARGETS)[number];

/**
 * Each executable: its file name without the platform extension, the entry file it compiles, and
 * `guarded`: whether it compiles the generated guard entry (see the header) instead of `entry`.
 */
export const BINARIES = [
	{ name: "substrate", entry: "packages/cli/src/index.ts", guarded: true },
	{ name: "substrate-mcp", entry: "packages/mcp-server/src/index.ts", guarded: false },
] as const;

/** The commands the standalone `substrate` refuses, each with the server-side runner it would spawn. */
export const STANDALONE_REFUSALS = [
	{ command: "index", runner: "packages/mcp-server/src/index-run.ts or index-sweep-run.ts" },
	{ command: "ledger", runner: "packages/mcp-server/src/ledger-run.ts" },
	{ command: "consistency", runner: "packages/mcp-server/src/consistency-run.ts" },
] as const;

/** Where the generated guard entries are written, relative to the repository root. Build output, under dist/. */
export const ENTRY_DIR = "dist/entry";

export const USAGE = `usage: bun run build:binaries -- [--target <${TARGETS.join("|")}>]`;

const ROOT = join(import.meta.dir, "..");

export type ParsedArgs = { targets: readonly BinaryTarget[] } | { error: string };

function isTarget(value: string): value is BinaryTarget {
	return (TARGETS as readonly string[]).includes(value);
}

/** No `--target`: every target. One `--target` (spaced or `=` form): that target. Anything else is refused. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	let requested: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		// `bun run <script> -- …` may hand the separator through.
		if (arg === "--") continue;
		if (arg === "--target") {
			requested = argv[i + 1];
			if (requested === undefined) return { error: `--target needs a value. ${USAGE}` };
			i++;
			continue;
		}
		if (arg.startsWith("--target=")) {
			requested = arg.slice("--target=".length);
			continue;
		}
		return { error: `unknown argument "${arg}". ${USAGE}` };
	}
	if (requested === undefined) return { targets: TARGETS };
	if (!isTarget(requested)) {
		return { error: `unknown --target "${requested}"; expected one of ${TARGETS.join(", ")}` };
	}
	return { targets: [requested] };
}

/** `.exe` for the Windows target, bare otherwise. */
export function outfileName(name: string, target: BinaryTarget): string {
	return target.startsWith("bun-windows-") ? `${name}.exe` : name;
}

export interface BuildStep {
	target: BinaryTarget;
	name: string;
	/** Relative to the repository root. */
	outfile: string;
	/** Arguments for the bun executable; the working directory is the repository root. */
	argv: string[];
}

/** The guard entry of a guarded binary, relative to the repository root. */
export function guardedEntry(name: string): string {
	return `${ENTRY_DIR}/${name}.ts`;
}

/**
 * The text of a guard entry. `entryImport` is the specifier, relative to the guard file, of the real entry.
 * The CLI is imported dynamically on purpose: a static import would run the CLI, and its command switch,
 * before the refusal check could see argv.
 */
export function guardedEntrySource(entryImport: string): string {
	const refusals = STANDALONE_REFUSALS.map(({ command, runner }) => [
		command,
		`substrate ${command} is not available in the standalone binary: it runs ${runner} from the source checkout, which this artifact does not include. Run it from a checkout with: bun packages/cli/src/index.ts ${command} ...`,
	]);
	return [
		"// Generated by scripts/build-binaries.ts; do not edit. See the header there.",
		`const refused = new Map(${JSON.stringify(refusals)});`,
		'const reason = refused.get(process.argv[2] ?? "");',
		"if (reason === undefined) {",
		`\tawait import(${JSON.stringify(entryImport)});`,
		"} else {",
		'\tprocess.stderr.write(reason + "\\n");',
		"\tprocess.exitCode = 2;",
		"}",
		"",
	].join("\n");
}

/** Module specifier of `to` as seen from `fromDir`: forward slashes, always starting with `.`. */
export function importSpecifier(fromDir: string, to: string): string {
	const rel = relative(fromDir, to).split(sep).join("/");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/** One step per (target, executable), in target order then BINARIES order. Paths use forward slashes on every host. */
export function buildSteps(targets: readonly BinaryTarget[]): BuildStep[] {
	return targets.flatMap((target) =>
		BINARIES.map((binary) => {
			const outfile = `dist/bin/${target}/${outfileName(binary.name, target)}`;
			// A guarded binary compiles its generated guard; the guard imports `binary.entry`.
			const entry = binary.guarded ? guardedEntry(binary.name) : binary.entry;
			return {
				target,
				name: binary.name,
				outfile,
				argv: ["build", "--compile", `--target=${target}`, entry, "--outfile", outfile],
			};
		}),
	);
}

export function main(argv: readonly string[]): number {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`build-binaries: ${parsed.error}\n`);
		return 2;
	}
	// Regenerated on every run, so the guard always imports the entry that exists in this checkout.
	for (const binary of BINARIES) {
		if (!binary.guarded) continue;
		const guard = join(ROOT, guardedEntry(binary.name));
		mkdirSync(dirname(guard), { recursive: true });
		writeFileSync(guard, guardedEntrySource(importSpecifier(dirname(guard), join(ROOT, binary.entry))));
	}
	const failures: string[] = [];
	for (const step of buildSteps(parsed.targets)) {
		mkdirSync(dirname(join(ROOT, step.outfile)), { recursive: true });
		process.stdout.write(`build-binaries: ${step.target} ${step.outfile}\n`);
		const result = spawnSync(process.execPath, step.argv, { cwd: ROOT, stdio: "inherit" });
		if (result.error || result.status !== 0) {
			const why = result.error ? result.error.message : `exit ${result.status}`;
			failures.push(`${step.target} (${step.name}): ${why}`);
			process.stderr.write(`build-binaries: FAILED ${step.target} ${step.name}: ${why}\n`);
		}
	}
	if (failures.length > 0) {
		process.stderr.write(`build-binaries: ${failures.length} build(s) failed: ${failures.join("; ")}\n`);
		return 1;
	}
	return 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
