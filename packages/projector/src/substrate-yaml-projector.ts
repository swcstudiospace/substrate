#!/usr/bin/env bun
/**
 * substrate-yaml-projector
 *
 * substrate.yaml → per-surface config fragments.
 *
 *   bun packages/projector/src/substrate-yaml-projector.ts [--check] [--remove] [--surface NAME] [--out DIR]
 *
 * Generates shell-env style blocks (for sourcing in hermes/omp etc units or .env per surface)
 * containing:
 *   SUBSTRATE_URL=...
 *   SUBSTRATE_TOKEN=... (the value; resolved if env present at run, else the ${VAR} form)
 *   SUBSTRATE_BRIEF_CMD=...
 *
 * For Lane B (hermes, omp, muse, grok-build, grok-bot) + cursor/claude for completeness.
 * Uses patterns from grok.ts (env+state, fail open) and cursor.ts (managed tags, backup).
 *
 * All additive / fail-open. No mutation of live agent configs unless --out points at them.
 * substrate.yaml is the single source; re-run converges.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_YAML = join(process.cwd(), "substrate.yaml");
const DEFAULT_OUT = join(process.cwd(), ".projected"); // example output; real infra uses /etc/substrate/...

interface SurfaceSpec {
	name: string;
	token_env: string;
	brief: string;
	emit_example?: string;
	notes?: string;
}

interface SubstrateYaml {
	version: string;
	default_url: string;
	surfaces: SurfaceSpec[];
}

interface ProjectedConfig {
	surface: string;
	env: string; // sourceable text
}

function parseYaml(content: string): SubstrateYaml {
	const lines = content.split("\n");
	const result: { version?: string; default_url?: string; surfaces: SurfaceSpec[] } = { surfaces: [] };
	let inSurfaces = false;
	let current: Partial<SurfaceSpec> | null = null;
	let currentIndent = 0;

	for (let raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;

		if (line.startsWith("version:")) {
			const idx = line.indexOf(":");
			result.version = idx >= 0 ? line.slice(idx + 1).trim().replace(/"/g, "") : "";
			continue;
		}
		if (line.startsWith("default_url:")) {
			const idx = line.indexOf(":");
			result.default_url = idx >= 0 ? line.slice(idx + 1).trim().replace(/"/g, "") : "http://127.0.0.1:7410";
			continue;
		}
		if (line === "surfaces:") {
			inSurfaces = true;
			continue;
		}
		if (!inSurfaces) continue;

		if (line.startsWith("- name:")) {
			if (current && current.name && current.token_env && current.brief) {
				result.surfaces.push(buildSurface(current));
			}
			const idx = line.indexOf(":");
			current = { name: idx >= 0 ? line.slice(idx + 1).trim() : "" };
			currentIndent = indent;
			continue;
		}
		if (current && indent > currentIndent) {
			if (line.includes(":")) {
				const idx = line.indexOf(":");
				const key = line.slice(0, idx).trim();
				const val = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
				if (key === "token_env") current.token_env = val;
				else if (key === "brief") current.brief = val;
				else if (key === "emit_example") current.emit_example = val;
				else if (key === "notes") current.notes = val;
			}
		}
	}
	if (current && current.name && current.token_env && current.brief) {
		result.surfaces.push(buildSurface(current));
	}

	if (!result.default_url) result.default_url = "http://127.0.0.1:7410";
	return {
		version: result.version ?? "0.1",
		default_url: result.default_url,
		surfaces: result.surfaces,
	};
}

function buildSurface(p: Partial<SurfaceSpec>): SurfaceSpec {
	return {
		name: p.name ?? "",
		token_env: p.token_env ?? "",
		brief: p.brief ?? "",
		...(p.emit_example ? { emit_example: p.emit_example } : {}),
		...(p.notes ? { notes: p.notes } : {}),
	};
}

function resolveToken(tokenEnv: string): string {
	const v = process.env[tokenEnv]?.trim();
	return v || `\${${tokenEnv}}`;
}

function generateForSurface(spec: SurfaceSpec, defaultUrl: string): ProjectedConfig {
	const url = process.env.SUBSTRATE_URL?.trim() || defaultUrl;
	const token = resolveToken(spec.token_env);
	const envBlock = [
		`# Per-surface config for ${spec.name} (generated from substrate.yaml)`,
		`SUBSTRATE_URL=${url}`,
		`SUBSTRATE_TOKEN=${token}`,
		`SUBSTRATE_BRIEF_CMD='${spec.brief}'`,
		spec.emit_example ? `SUBSTRATE_EMIT_EXAMPLE='${spec.emit_example}'` : "",
		spec.notes ? `# notes: ${spec.notes}` : "",
		"",
	].filter(Boolean).join("\n");

	return {
		surface: spec.name,
		env: envBlock,
	};
}

function main() {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const remove = args.includes("--remove");
	const yamlPathIndex = args.indexOf("--yaml");
	const yamlPath = yamlPathIndex >= 0 ? (args[yamlPathIndex + 1] ?? DEFAULT_YAML) : DEFAULT_YAML;
	const outIndex = args.indexOf("--out");
	const outDir = outIndex >= 0 ? (args[outIndex + 1] ?? DEFAULT_OUT) : DEFAULT_OUT;
	const surfIndex = args.indexOf("--surface");
	const onlySurface = surfIndex >= 0 ? args[surfIndex + 1] : null;

	if (!existsSync(yamlPath)) {
		process.stderr.write(`[substrate-yaml-projector] ${yamlPath} not found\n`);
		process.exit(1);
	}

	const yamlContent = readFileSync(yamlPath, "utf8");
	let spec: SubstrateYaml;
	try {
		spec = parseYaml(yamlContent);
	} catch (cause) {
		process.stderr.write(`[substrate-yaml-projector] failed to parse ${yamlPath}: ${String(cause)}\n`);
		process.exit(1);
	}

	const generated: ProjectedConfig[] = spec.surfaces
		.filter((s) => !onlySurface || s.name === onlySurface)
		.map((s) => generateForSurface(s, spec.default_url));

	if (remove) {
		// For demo, just note; real would clean generated files
		process.stdout.write(`[substrate-yaml-projector] remove not implemented for safety (use git)\n`);
		process.exit(0);
	}

	if (generated.length === 0) {
		process.stdout.write(`[substrate-yaml-projector] no surfaces matched\n`);
		process.exit(0);
	}

	// Always print for visibility / piping into units
	for (const g of generated) {
		process.stdout.write(`\n=== ${g.surface} ===\n${g.env}`);
	}

	if (checkOnly) {
		process.stdout.write(`\n[substrate-yaml-projector] --check: would write ${generated.length} surface config(s) to ${outDir}\n`);
		process.exit(0);
	}

	// Write example projected files (additive, under .projected/ which is gitignored)
	try {
		mkdirSync(outDir, { recursive: true });
		for (const g of generated) {
			const outFile = join(outDir, `${g.surface}.env`);
			const backup = `${outFile}.bak`;
			if (existsSync(outFile)) {
				copyFileSync(outFile, backup);
			}
			writeFileSync(outFile, `${g.env}\n`);
			process.stdout.write(`\n[substrate-yaml-projector] wrote ${outFile} (backup ${backup} if existed)\n`);
		}
	} catch (cause) {
		process.stderr.write(`[substrate-yaml-projector] write error: ${String(cause)}\n`);
		// still succeeded on stdout
	}

	process.stdout.write(`\n[substrate-yaml-projector] done for ${generated.length} surface(s). Use in systemd: EnvironmentFile=/etc/substrate/${onlySurface || "hermes"}.env\n`);
}

main();
