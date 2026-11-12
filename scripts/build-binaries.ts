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
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64", "bun-linux-x64"] as const;
export type BinaryTarget = (typeof TARGETS)[number];

/** Each executable: its file name without the platform extension, and the entry file it compiles. */
export const BINARIES = [
	{ name: "substrate", entry: "packages/cli/src/index.ts" },
	{ name: "substrate-mcp", entry: "packages/mcp-server/src/index.ts" },
] as const;

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

/** One step per (target, executable), in target order then BINARIES order. Paths use forward slashes on every host. */
export function buildSteps(targets: readonly BinaryTarget[]): BuildStep[] {
	return targets.flatMap((target) =>
		BINARIES.map(({ name, entry }) => {
			const outfile = `dist/bin/${target}/${outfileName(name, target)}`;
			return {
				target,
				name,
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
