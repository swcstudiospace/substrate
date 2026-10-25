#!/usr/bin/env bun
/**
 * Read-only deploy preflight (`bun run deploy:preflight`): will the NEW release
 * start against what is on this host, judged before `current` is swapped.
 *
 *   bun scripts/deploy-preflight.ts <release-dir> [--env-file <path>]...
 *       [--state-dir <dir>] [--units-dir <dir>] [--installed-units-dir <dir>] [--json]
 *
 * `deploy-release.sh` used to find out only after the swap: the new tree's
 * `loadConfig` first ran inside the restarted unit, a state file written by a
 * newer release was first parsed there, and a unit file the operator never
 * copied was never noticed at all. This script runs the same loaders ahead of
 * time and prints one finding per check.
 *
 * Checks, each wrapped on its own so one failure never hides the others:
 * - config  — the release's REAL `loadConfig` (and every `*ConfigWarnings`
 *             function it finds in the modules `index.ts` takes them from) run
 *             in a child `bun --no-env-file` whose environment is EXACTLY the
 *             variables parsed from the `Environment=` lines of the INSTALLED
 *             `substrate-mcp.service` (the release's own copy when none is
 *             installed) and the `--env-file`s: nothing leaks in from the
 *             operator's shell or a `.env` in the working directory. A
 *             `ConfigError` is an `error` (the unit exits 78 on it); a warning
 *             is a `warn`.
 * - state   — the docs state file, the SLO checkpoint, the retain outbox and
 *             the event spool, at the paths the release's loaded config
 *             resolved (`SUBSTRATE_DOCS_STATE_FILE`, `SUBSTRATE_SLO_CHECKPOINT`,
 *             `SUBSTRATE_RETAIN_OUTBOX_PATH`, `SUBSTRATE_STATE_DIR`), else
 *             under `--state-dir`. Absent is ok; a checkpoint switched off is
 *             ok. Unreadable, over the size cap, invalid, or written by a NEWER
 *             schema than this tree knows is an `error`. The docs and SLO files
 *             go through the new tree's own loaders; the two JSONL files are
 *             parsed here, because constructing a `RetainOutbox` rewrites its
 *             file at boot and this script never writes.
 * - units   — the settings the release's `substrate-mcp.service`
 *             (+ drop-ins, + `substrate.slice`) declares against the installed
 *             copy. Copying units is an operator step, so a difference or a
 *             missing installed unit is only a `warn`.
 * - disk    — free space on the release's filesystem against
 *             `SUBSTRATE_DEPLOY_MIN_FREE_GB` (default 5, `0` disables), read
 *             the way `deploy-release.sh` reads it. It runs after the build,
 *             so it is stricter than the pre-build floor by the size of the tree.
 *
 * Invariants:
 * - Pure read. No network, no docker, no systemctl, no write. The only child
 *   processes are `bun` (the config and loader child) and `df`.
 * - No value from an env FILE is ever printed. Names and verdicts only: a message
 *   that quotes a value an env file supplied (a config warning may; a path may
 *   contain one) is withheld whole and replaced by the names of the variables it
 *   quoted, before anything reaches stdout, stderr or the JSON. Nothing is masked
 *   in place. What the release's own unit file declares is repo text and is shown.
 * - Exit 0 when no finding is an `error`, 1 when at least one is, 2 for usage
 *   or an internal failure. The last line is one `preflight-receipt`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDfAvailableKb, sectionDirectives } from "./doctor-runtime.ts";

export type Level = "ok" | "warn" | "error";
export type CheckClass = "config" | "state" | "units" | "disk";

export interface Finding {
	check: CheckClass;
	name: string;
	level: Level;
	reason: string;
}

export interface Options {
	releaseDir: string;
	envFiles: string[];
	stateDir: string;
	unitsDir: string;
	installedUnitsDir: string;
	json: boolean;
}

export const DEFAULT_STATE_DIR = "/var/lib/substrate";
export const DEFAULT_INSTALLED_UNITS_DIR = "/etc/systemd/system";
export const DEFAULT_MIN_FREE_GB = 5;
/** The docs state file version this tree writes (`docs-ingest.ts:544`, `:621`); a larger one was written by a newer release. */
export const DOCS_STATE_KNOWN_VERSION = 2;
/** Largest state file or JSONL file the preflight reads (the retain outbox holds at most 10 000 locators of a few hundred bytes). */
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
/** Largest env file or unit file the preflight reads. */
export const MAX_ENV_BYTES = 1024 * 1024;
/** Values shorter than this are never withheld: a port is not a credential, and matching every "1" would drop every message. */
export const QUOTE_MIN_LENGTH = 6;
const NOT_A_VALUE = new Set(["enforce", "report", "shadow", "standard", "guarded", "compact", "dry-run", "apply"]);
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_MAX_BUFFER = 4 * 1024 * 1024;

/** `[Service]` keys compared between the release's unit and the installed one; the last assignment wins, as in systemd. */
export const UNIT_KEYS: readonly string[] = ["MemoryHigh", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota", "Type", "WatchdogSec", "Slice"];
/** `[Slice]` keys compared between the release's `substrate.slice` and the installed one. */
export const SLICE_KEYS: readonly string[] = ["MemoryLow", "CPUWeight", "IOWeight"];
export const UNIT_NAME = "substrate-mcp.service";
export const SLICE_NAME = "substrate.slice";

/**
 * Where `index.ts` takes its `*ConfigWarnings` from. Every export of these
 * modules whose name matches `WARNING_EXPORT` is run, so a warning function a
 * later change adds to one of them is covered without editing this list.
 * `planning/config.ts` takes the planning settings, which index.ts reads from the loaded config, so it is given `loaded.planning`.
 */
export const WARNING_MODULES: readonly string[] = ["config.ts", "brief-profile.ts", "recall-snapshot.ts", "hindsight-inventory.ts", "planning/config.ts"];
export const WARNING_EXPORT = /^(configWarnings|swarmTokenWarnings)$|ConfigWarnings$/;

// ── env parsing ──────────────────────────────────────────────────────────────

function unquote(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		if ((first === '"' || first === "'") && raw.endsWith(first)) {
			const inner = raw.slice(1, -1);
			if (first === "'") return inner;
			return inner.replace(/\\(.)/g, (_match, escaped: string) => (escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped));
		}
	}
	return raw;
}

/**
 * A systemd `EnvironmentFile` as `NAME=value` pairs, an approximation of systemd's own parser: `#` and `;`
 * comments, `\` continuations (joined with one space), one pair of surrounding quotes, values trimmed, last
 * assignment wins. No `$`-expansion and no `export`.
 */
export function parseEnvText(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		let line = (lines[index] ?? "").trim();
		while (line.endsWith("\\") && !line.endsWith("\\\\") && index + 1 < lines.length) {
			index += 1;
			line = `${line.slice(0, -1)} ${(lines[index] ?? "").trim()}`.trim();
		}
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const name = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
		out.set(name, unquote(line.slice(eq + 1).trim()));
	}
	return out;
}

/** The `NAME=value` pairs of one unit-file `Environment=` value: whitespace-separated, quotes group and are stripped. */
export function parseUnitEnvironment(value: string): Array<[string, string]> {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let open = false;
	for (const ch of value) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			open = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (open || current !== "") tokens.push(current);
			current = "";
			open = false;
			continue;
		}
		current += ch;
		open = true;
	}
	if (open || current !== "") tokens.push(current);
	const pairs: Array<[string, string]> = [];
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) continue;
		const name = token.slice(0, eq);
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) pairs.push([name, token.slice(eq + 1)]);
	}
	return pairs;
}

// ── unit files ───────────────────────────────────────────────────────────────

interface UnitTexts {
	base: string;
	dropIns: string[];
}

type ReadResult = { text: string } | { missing: true } | { error: string };

/**
 * A file's text, or why it was not read. The size is asked first and a file over `maxBytes` is never read: these
 * files live on a host at 94 % disk and a runaway state file must cost one `stat`, not its whole size in memory.
 */
function readText(path: string, maxBytes: number = MAX_STATE_BYTES): ReadResult {
	try {
		const size = statSync(path).size;
		if (size > maxBytes) return { error: `${size} bytes, over the ${maxBytes} byte limit; not read` };
		return { text: readFileSync(path, "utf8") };
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { missing: true } : { error: code ?? "unreadable" };
	}
}

/** The unit file and its `*.conf` drop-ins in systemd order, or why the unit could not be read. Drop-ins that are not `.conf` (the staged `.example` files) are never read, as in systemd. */
function readUnit(dir: string, name: string): { units: UnitTexts } | { missing: true } | { error: string } {
	const base = readText(join(dir, name), MAX_ENV_BYTES);
	if ("missing" in base) return { missing: true };
	if ("error" in base) return { error: base.error };
	const dropIns: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(join(dir, `${name}.d`)).filter((entry) => entry.endsWith(".conf")).sort();
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") return { error: code ?? "unreadable" };
	}
	for (const entry of names) {
		const dropIn = readText(join(dir, `${name}.d`, entry), MAX_ENV_BYTES);
		if ("text" in dropIn) dropIns.push(dropIn.text);
		else if ("error" in dropIn) return { error: dropIn.error };
	}
	return { units: { base: base.text, dropIns } };
}

/** The effective value of `key` in `section`: the last assignment wins and an empty one resets, as in systemd. */
export function effectiveValue(units: UnitTexts, section: string, key: string): string | null {
	let value: string | null = null;
	for (const text of [units.base, ...units.dropIns]) {
		for (const [name, assigned] of sectionDirectives(text, section)) {
			if (name === key) value = assigned === "" ? null : assigned;
		}
	}
	return value;
}

/** The `Environment=` pairs of a unit and its drop-ins, in order, an empty assignment clearing what came before. */
export function unitEnvironment(units: UnitTexts): Map<string, string> {
	const env = new Map<string, string>();
	for (const text of [units.base, ...units.dropIns]) {
		for (const [name, value] of sectionDirectives(text, "Service")) {
			if (name !== "Environment") continue;
			if (value === "") {
				env.clear();
				continue;
			}
			for (const [key, assigned] of parseUnitEnvironment(value)) env.set(key, assigned);
		}
	}
	return env;
}

// ── checks ───────────────────────────────────────────────────────────────────

function finding(check: CheckClass, name: string, level: Level, reason: string): Finding {
	return { check, name, level, reason };
}

function messageOf(cause: unknown): string {
	return (cause instanceof Error ? cause.message : String(cause)).split("\n")[0]?.slice(0, 300) ?? "failed";
}

/** Unit drift: what the release declares against what is installed. Differences are `warn`: copying a unit is an operator step. */
export function compareUnits(releaseDir: string, installedDir: string): Finding[] {
	const findings: Finding[] = [];
	const pairs: Array<{ name: string; section: string; keys: readonly string[] }> = [
		{ name: UNIT_NAME, section: "Service", keys: UNIT_KEYS },
		{ name: SLICE_NAME, section: "Slice", keys: SLICE_KEYS },
	];
	for (const pair of pairs) {
		const declared = readUnit(releaseDir, pair.name);
		if (!("units" in declared)) {
			findings.push(finding("units", pair.name, "warn", "missing" in declared ? `the release has no ${pair.name} under ${releaseDir}; nothing to compare` : `the release's ${pair.name} could not be read (${declared.error})`));
			continue;
		}
		const installed = readUnit(installedDir, pair.name);
		if (!("units" in installed)) {
			findings.push(
				finding(
					"units",
					pair.name,
					"warn",
					"missing" in installed
						? `not installed in ${installedDir}: the release's settings are not in force until the operator copies it and runs daemon-reload`
						: `the installed ${pair.name} could not be read (${installed.error})`,
				),
			);
			continue;
		}
		let differences = 0;
		for (const key of pair.keys) {
			const want = effectiveValue(declared.units, pair.section, key);
			const have = effectiveValue(installed.units, pair.section, key);
			if (want === have) continue;
			differences += 1;
			findings.push(finding("units", `${pair.name} ${key}`, "warn", `release declares ${want ?? "unset"}, installed has ${have ?? "unset"}; copying the unit is an operator step (deploy-release.sh reloads units, it never copies them)`));
		}
		if (differences === 0) findings.push(finding("units", pair.name, "ok", `${pair.keys.length} setting(s) match the installed copy`));
	}
	return findings;
}

/** `df -Pk <path>`'s output, or null when it could not run. */
export type DfRunner = (path: string) => string | null;

export const runDf: DfRunner = (path) => {
	const result = spawnSync("df", ["-Pk", "--", path], { encoding: "utf8", timeout: 10_000 });
	return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
};

/** Free space on the release's filesystem against the deploy floor, the way `deploy-release.sh` reads it. */
export function checkDisk(releaseDir: string, rawFloor: string | undefined, df: DfRunner): Finding {
	const name = "free space";
	const text = rawFloor === undefined || rawFloor === "" ? String(DEFAULT_MIN_FREE_GB) : rawFloor;
	if (!/^[0-9]{1,4}$/.test(text)) return finding("disk", name, "error", "SUBSTRATE_DEPLOY_MIN_FREE_GB must be 0-9999 gigabytes");
	const floor = Number(text);
	if (floor === 0) return finding("disk", name, "ok", "floor disabled (SUBSTRATE_DEPLOY_MIN_FREE_GB=0)");
	const out = df(releaseDir);
	const availableKb = out === null ? null : parseDfAvailableKb(out);
	if (availableKb === null) return finding("disk", name, "error", `cannot read free space on ${releaseDir}`);
	const availableGb = availableKb / 1024 / 1024;
	const shown = `${availableGb.toFixed(1)} GB free after the build`;
	if (availableGb < floor) return finding("disk", name, "error", `${shown}, below SUBSTRATE_DEPLOY_MIN_FREE_GB=${floor}; docs/runbooks/disk-pressure.md`);
	return finding("disk", name, "ok", `${shown}, floor ${floor} GB`);
}

/**
 * The `retain-outbox.jsonl` entry shape `RetainOutbox` accepts at boot
 * (`retain-outbox.ts:121`, `isEntry`): a line that is not this is skipped there.
 */
export function isOutboxEntry(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.bank === "string" &&
		typeof row.document_id === "string" &&
		typeof row.entry_id === "string" &&
		typeof row.surface === "string" &&
		typeof row.entry_hash === "string" &&
		(row.session_id === undefined || typeof row.session_id === "string") &&
		typeof row.attempts === "number" &&
		typeof row.next_at === "number" &&
		typeof row.last_reason === "string" &&
		typeof row.enqueued_at === "number"
	);
}

/** The spool only promises one JSON object per line (`SUBSTRATE_STATE_DIR/event-spool.jsonl`). */
export function isJsonObject(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A JSONL state file. Absent is ok. Unreadable, or non-empty with no usable
 * line, is an error; a malformed line among usable ones (a torn last line after
 * a crash is the usual one) is a warning, because the loader skips it.
 */
export function checkJsonl(dir: string, file: string, label: string, usable: (row: unknown) => boolean): Finding {
	const name = file;
	const read = readText(join(dir, file));
	if ("missing" in read) return finding("state", name, "ok", `absent; ${label} starts empty`);
	if ("error" in read) return finding("state", name, "error", `unreadable (${read.error})`);
	let good = 0;
	let bad = 0;
	for (const line of read.text.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			bad += 1;
			continue;
		}
		if (usable(parsed)) good += 1;
		else bad += 1;
	}
	if (good === 0 && bad > 0) return finding("state", name, "error", `${bad} line(s), none a valid ${label} entry`);
	if (bad > 0) return finding("state", name, "warn", `${good} entr${good === 1 ? "y" : "ies"}; ${bad} malformed line(s) are skipped at boot`);
	return finding("state", name, "ok", `${good} entr${good === 1 ? "y" : "ies"}`);
}

// ── the child: everything that loads the NEW tree ───────────────────────────

interface Namespace {
	[key: string]: unknown;
}

/** The module path is chosen at run time (`--child <release-dir>`): this script judges a tree it is not part of, so a static import cannot name it. */
async function importFrom(releaseDir: string, relative: string): Promise<Namespace> {
	return (await import(pathToFileURL(join(releaseDir, relative)).href)) as Namespace;
}

function isFn(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

/** `loadConfig` and every warning function, against the child's environment (which the parent set to exactly the parsed variables). `loaded` is the resolved config, or null when it was refused. */
async function configFindings(releaseDir: string): Promise<{ findings: Finding[]; loaded: Record<string, unknown> | null }> {
	const refused = (reason: string): { findings: Finding[]; loaded: null } => ({ findings: [finding("config", "loadConfig", "error", reason)], loaded: null });
	let config: Namespace;
	try {
		config = await importFrom(releaseDir, "packages/mcp-server/src/config.ts");
	} catch (cause) {
		return refused(`config.ts could not be loaded from the release: ${messageOf(cause)}`);
	}
	const loadConfig = config.loadConfig;
	const ConfigError = config.ConfigError;
	if (!isFn(loadConfig)) return refused("the release's config.ts exports no loadConfig");
	let loaded: Record<string, unknown>;
	try {
		// The one host probe index.ts passes: whether the state directory exists (uplift-3 N2).
		loaded = loadConfig(process.env, { directoryExists: (path: string) => existsSync(path) && statSync(path).isDirectory() }) as Record<string, unknown>;
	} catch (cause) {
		if (isFn(ConfigError) && cause instanceof ConfigError) return refused(`refused, the unit would exit 78: ${messageOf(cause)}`);
		return refused(`threw ${messageOf(cause)}`);
	}
	const findings: Finding[] = [finding("config", "loadConfig", "ok", "accepted the supplied environment")];
	let sources = 0;
	let fired = 0;
	for (const module of WARNING_MODULES) {
		// A release from before the planning plane has no planning/config.ts and so no planning warnings to run; it must not be reported as broken.
		if (module === "planning/config.ts" && !existsSync(join(releaseDir, "packages/mcp-server/src", module))) continue;
		let namespace: Namespace;
		try {
			namespace = module === "config.ts" ? config : await importFrom(releaseDir, `packages/mcp-server/src/${module}`);
		} catch (cause) {
			findings.push(finding("config", module, "error", `could not be loaded, so its config warnings were not checked: ${messageOf(cause)}`));
			continue;
		}
		for (const exported of Object.keys(namespace).sort()) {
			const fn = namespace[exported];
			if (!WARNING_EXPORT.test(exported) || !isFn(fn)) continue;
			sources += 1;
			try {
				// index.ts passes config.planning to planningConfigWarnings, not the whole config.
				const messages = fn(module === "planning/config.ts" ? fieldOf(loaded, "planning") : loaded);
				for (const message of Array.isArray(messages) ? messages : []) {
					fired += 1;
					findings.push(finding("config", exported, "warn", String(message)));
				}
			} catch (cause) {
				findings.push(finding("config", exported, "error", `threw ${messageOf(cause)}; the boot loop calls it at top level`));
			}
		}
	}
	const metrics = loaded.metricsHistory;
	if (metrics !== null && typeof metrics === "object") {
		sources += 1;
		const problems = fieldOf(metrics, "problems");
		for (const problem of Array.isArray(problems) ? problems : []) {
			fired += 1;
			findings.push(finding("config", "metricsHistory.problems", "warn", String(problem)));
		}
	}
	if (fired === 0) findings.push(finding("config", "config warnings", "ok", `${sources} warning source(s) ran; none fired`));
	return { findings, loaded };
}

/** One own-or-inherited field of an untrusted value, or undefined when the value is not an object. */
function fieldOf(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

async function docsStateFinding(releaseDir: string, path: string): Promise<Finding> {
	const file = basename(path);
	const read = readText(path);
	if ("missing" in read) return finding("state", file, "ok", "absent; the docs ingest starts with empty records");
	if ("error" in read) return finding("state", file, "error", `unreadable (${read.error})`);
	try {
		const parsed: unknown = JSON.parse(read.text);
		const version = fieldOf(parsed, "version");
		if (typeof version === "number" && version > DOCS_STATE_KNOWN_VERSION) {
			return finding("state", file, "error", `version ${version} was written by a newer release; this tree reads version ${DOCS_STATE_KNOWN_VERSION}`);
		}
	} catch {
		// Not JSON: the loader below reports it in its own words.
	}
	let ingest: Namespace;
	try {
		ingest = await importFrom(releaseDir, "packages/mcp-server/src/docs-ingest.ts");
	} catch (cause) {
		return finding("state", file, "error", `the release's docs-ingest.ts could not be loaded: ${messageOf(cause)}`);
	}
	const load = ingest.loadIngestRecords;
	if (!isFn(load)) return finding("state", file, "error", "the release's docs-ingest.ts exports no loadIngestRecords");
	const loaded = await load(path);
	const problem = fieldOf(loaded, "problem");
	const records = fieldOf(loaded, "records");
	const versions = fieldOf(loaded, "versions");
	if (typeof problem === "string") return finding("state", file, "error", problem);
	if (!(records instanceof Map) || !(versions instanceof Map)) return finding("state", file, "error", "the release's loadIngestRecords returned an unexpected shape");
	return finding("state", file, "ok", `${records.size} record(s), ${versions.size} dataset version list(s)`);
}

/** `path` is null when `SUBSTRATE_SLO_CHECKPOINT` switched the checkpoint off (or rejected it): nothing is read then, and the boot says so itself. */
async function checkpointFinding(releaseDir: string, path: string | null): Promise<Finding> {
	if (path === null) return finding("state", "slo-checkpoint", "ok", "off (SUBSTRATE_SLO_CHECKPOINT disables it); SLO history starts fresh each restart");
	const file = basename(path);
	const read = readText(path);
	if ("missing" in read) return finding("state", file, "ok", "absent; SLO history starts fresh");
	if ("error" in read) return finding("state", file, "error", `unreadable (${read.error})`);
	let checkpoint: Namespace;
	try {
		checkpoint = await importFrom(releaseDir, "packages/observability/src/checkpoint.ts");
	} catch (cause) {
		return finding("state", file, "error", `the release's checkpoint.ts could not be loaded: ${messageOf(cause)}`);
	}
	const restore = checkpoint.restoreCheckpoint;
	const known = checkpoint.CHECKPOINT_VERSION;
	if (!isFn(restore) || typeof known !== "number") return finding("state", file, "error", "the release's checkpoint.ts exports no restoreCheckpoint or CHECKPOINT_VERSION");
	try {
		const parsed: unknown = JSON.parse(read.text);
		const version = fieldOf(parsed, "v");
		if (typeof version === "number" && version > known) return finding("state", file, "error", `version ${version} was written by a newer release; this tree reads version ${known}`);
	} catch {
		// Not JSON: restoreCheckpoint names it below.
	}
	try {
		restore(read.text);
	} catch (cause) {
		return finding("state", file, "error", messageOf(cause));
	}
	return finding("state", file, "ok", `a version ${known} checkpoint`);
}

/** A non-empty string field of the loaded config, or null. */
function pathField(value: unknown, key: string): string | null {
	const field = fieldOf(value, key);
	return typeof field === "string" && field !== "" ? field : null;
}

/**
 * Where each state file is, by what the release's own `loadConfig` resolved from the supplied environment
 * (`SUBSTRATE_DOCS_STATE_FILE`, `SUBSTRATE_RETAIN_OUTBOX_PATH`, `SUBSTRATE_SLO_CHECKPOINT`), and the
 * `--state-dir` default for a file the environment does not place. `loaded` is null when `loadConfig` refused:
 * everything falls back to the directory. The event spool follows `SUBSTRATE_STATE_DIR`, the collectors' own.
 */
export function stateFilePaths(loaded: unknown, stateDir: string, env: Readonly<Record<string, string | undefined>>): { docs: string; slo: string | null; retain: string; spool: string } {
	const sloSet = (env.SUBSTRATE_SLO_CHECKPOINT ?? "").trim() !== "";
	const configured = pathField(loaded, "sloCheckpointPath");
	const inStateDir = join(stateDir, "slo-checkpoint.json");
	// Unset, `loadConfig` lands the checkpoint in `/var/lib/substrate` when that directory exists on THIS host; the
	// preflight's state directory stands in for it, so that default is read from `--state-dir`, not from the host.
	// Set in the environment but resolved to nothing: disabled (or a rejected relative path, which the config warning names).
	let slo: string | null;
	if (configured !== null) slo = !sloSet && configured === join(DEFAULT_STATE_DIR, "slo-checkpoint.json") ? inStateDir : configured;
	else slo = loaded !== null && sloSet ? null : inStateDir;
	return {
		docs: pathField(loaded, "docsStateFile") ?? join(stateDir, "docs-ingest.json"),
		slo,
		retain: pathField(fieldOf(loaded, "retainOutbox"), "path") ?? join(stateDir, "retain-outbox.jsonl"),
		spool: join((env.SUBSTRATE_STATE_DIR ?? "").trim() || stateDir, "event-spool.jsonl"),
	};
}

/** Everything that imports the release: config, warnings, and the four state files. Each part is isolated. */
export async function childFindings(releaseDir: string, stateDir: string): Promise<Finding[]> {
	const findings: Finding[] = [];
	let loaded: unknown = null;
	const guarded = async (check: CheckClass, name: string, run: () => Promise<Finding | Finding[]>): Promise<void> => {
		try {
			const result = await run();
			findings.push(...(Array.isArray(result) ? result : [result]));
		} catch (cause) {
			findings.push(finding(check, name, "error", `check crashed: ${messageOf(cause)}`));
		}
	};
	await guarded("config", "config", async () => {
		const outcome = await configFindings(releaseDir);
		loaded = outcome.loaded;
		return outcome.findings;
	});
	const paths = stateFilePaths(loaded, stateDir, process.env);
	await guarded("state", "docs-ingest.json", () => docsStateFinding(releaseDir, paths.docs));
	await guarded("state", "slo-checkpoint.json", () => checkpointFinding(releaseDir, paths.slo));
	await guarded("state", "retain-outbox.jsonl", async () => checkJsonl(dirname(paths.retain), basename(paths.retain), "retain outbox", isOutboxEntry));
	await guarded("state", "event-spool.jsonl", async () => checkJsonl(dirname(paths.spool), basename(paths.spool), "event spool", isJsonObject));
	return findings;
}

// ── the parent ───────────────────────────────────────────────────────────────

/** What the config child printed and how it ended. */
export interface ChildResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

/** Runs the child with EXACTLY `env`. Injectable so a test can stand in for it. */
export type ChildRunner = (args: readonly string[], env: Record<string, string>) => ChildResult;

const runChild: ChildRunner = (args, env) => {
	// --no-env-file: Bun would otherwise load a `.env` from the working directory into the child, and those variables
	// are not in the unit's environment. The child sees exactly `env`.
	const result = spawnSync(process.execPath, ["--no-env-file", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error !== undefined ? { error: result.error.message } : {}) };
};

function isFinding(value: unknown): value is Finding {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		(row.check === "config" || row.check === "state" || row.check === "units" || row.check === "disk") &&
		typeof row.name === "string" &&
		(row.level === "ok" || row.level === "warn" || row.level === "error") &&
		typeof row.reason === "string"
	);
}

function childFailure(why: string): Finding[] {
	return [
		finding("config", "loadConfig", "error", `the config child did not report (${why}); config, docs-ingest.json, slo-checkpoint, retain-outbox.jsonl and event-spool.jsonl were not checked`),
	];
}

/** The findings the child printed, or one error naming why there are none. */
export function readChildReport(result: ChildResult): Finding[] {
	if (result.error !== undefined) return childFailure(result.error);
	const last = result.stdout.split("\n").filter((line) => line.trim() !== "").at(-1);
	if (last === undefined) return childFailure(`exit ${result.status ?? "signal"}, no output: ${result.stderr.split("\n")[0]?.slice(0, 200) ?? ""}`);
	try {
		const parsed: unknown = JSON.parse(last);
		const reported = fieldOf(parsed, "findings");
		if (Array.isArray(reported) && reported.every(isFinding)) return reported;
	} catch {
		// Falls through to the failure below.
	}
	return childFailure(`exit ${result.status ?? "signal"}, unparsable output`);
}

export interface Io {
	stdout(text: string): void;
	stderr(text: string): void;
	/** The preflight's own environment: only `SUBSTRATE_DEPLOY_MIN_FREE_GB` is read from it. */
	env: Record<string, string | undefined>;
	child?: ChildRunner;
	df?: DfRunner;
	/** The script the child runs; defaults to this file. */
	script?: string;
}

export function summarize(findings: readonly Finding[]): { ok: number; warn: number; error: number } {
	const counts = { ok: 0, warn: 0, error: 0 };
	for (const item of findings) counts[item.level] += 1;
	return counts;
}

/** `preflight-receipt`: one line a log search can count. Names and totals only. */
export function receiptLine(releaseDir: string, findings: readonly Finding[]): string {
	const counts = summarize(findings);
	return `preflight-receipt release=${basename(resolve(releaseDir))} result=${counts.error === 0 ? "pass" : "fail"} ok=${counts.ok} warn=${counts.warn} error=${counts.error}`;
}

export function formatTable(findings: readonly Finding[]): string {
	const checkWidth = Math.max(5, ...findings.map((item) => item.check.length));
	const nameWidth = Math.min(44, Math.max(7, ...findings.map((item) => item.name.length)));
	const lines = [`${"CHECK".padEnd(checkWidth)}  ${"FINDING".padEnd(nameWidth)}  LEVEL  REASON`];
	for (const item of findings) lines.push(`${item.check.padEnd(checkWidth)}  ${item.name.padEnd(nameWidth)}  ${item.level.padEnd(5)}  ${item.reason}`);
	return `${lines.join("\n")}\n`;
}

/**
 * Findings that are safe to print. A message the release's own code composed (a config warning, a
 * `ConfigError`) may quote a value it was given; when one quotes a whole value an env file supplied, the whole
 * message is withheld and the finding names the VARIABLES whose values it quoted, so the operator still knows
 * where to look. Nothing is masked in place, and no value is ever echoed: the text is dropped, not edited.
 * Only a WHOLE value is recognised: a message that quotes part of one, or transforms it, is not caught.
 * Values under `QUOTE_MIN_LENGTH` characters, and the mode words in `NOT_A_VALUE`, are not withheld: a port
 * or `enforce` is not a credential, and matching every "1" would drop every message.
 */
export function withholdQuotedValues(findings: readonly Finding[], fileValues: ReadonlyMap<string, string>): Finding[] {
	const quoted = [...fileValues].filter(([, value]) => value.length >= QUOTE_MIN_LENGTH && !NOT_A_VALUE.has(value.toLowerCase()));
	// A message may quote the value as written or JSON-escaped (a `ConfigError` for SUBSTRATE_LEDGER_TTL does), so both forms are looked for.
	const forms = quoted.map(([name, value]): [string, string[]] => [name, [value, JSON.stringify(value).slice(1, -1)]]);
	const quotes = (text: string, shapes: string[]): boolean => shapes.some((shape) => text.includes(shape));
	return findings.map((item) => {
		const hits = forms.filter(([, shapes]) => quotes(item.reason, shapes) || quotes(item.name, shapes));
		if (hits.length === 0) return item;
		const names = [...new Set(hits.map(([name]) => name))].sort();
		// A finding named after a value (an env file whose path embeds one) is renamed to its check class.
		const leakyName = hits.some(([, shapes]) => quotes(item.name, shapes));
		return { check: item.check, name: leakyName ? item.check : item.name, level: item.level, reason: `withheld: the message quoted the value of ${names.join(", ")}` };
	});
}

export type Parsed = { ok: true; options: Options } | { ok: false; message: string };

export function parseArgs(argv: readonly string[]): Parsed {
	let releaseDir: string | null = null;
	const envFiles: string[] = [];
	let stateDir = DEFAULT_STATE_DIR;
	let unitsDir: string | null = null;
	let installedUnitsDir = DEFAULT_INSTALLED_UNITS_DIR;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--env-file" || arg === "--state-dir" || arg === "--units-dir" || arg === "--installed-units-dir") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return { ok: false, message: `${arg} needs a value` };
			index += 1;
			if (arg === "--env-file") envFiles.push(value);
			else if (arg === "--state-dir") stateDir = value;
			else if (arg === "--units-dir") unitsDir = value;
			else installedUnitsDir = value;
			continue;
		}
		if (arg.startsWith("--")) return { ok: false, message: `unknown option ${arg}` };
		if (releaseDir !== null) return { ok: false, message: "only one release directory" };
		releaseDir = arg;
	}
	if (releaseDir === null) return { ok: false, message: "a release directory is required" };
	const release = resolve(releaseDir);
	return { ok: true, options: { releaseDir: release, envFiles, stateDir, unitsDir: unitsDir ?? join(release, "infra", "vps"), installedUnitsDir, json } };
}

const USAGE =
	"usage: deploy-preflight.ts <release-dir> [--env-file <path>]... [--state-dir <dir>] [--units-dir <dir>] [--installed-units-dir <dir>] [--json]\n";

/**
 * Parent-side: the variables the restarting unit would have, as findings and a map. systemd restarts the INSTALLED
 * unit (a deploy reloads units, it never copies them), so its `Environment=` lines are read when it is installed;
 * otherwise the release's own unit stands in. Then each `--env-file`, later assignments winning. Parsing follows
 * systemd's rules closely, not completely (a continuation is joined with a single space, values are trimmed).
 * `fileValues` is every value that did not come from the repo's own unit file, by name: the values no finding may quote.
 */
function buildEnvironment(options: Options): { env: Map<string, string>; fileValues: Map<string, string>; findings: Finding[] } {
	const findings: Finding[] = [];
	const env = new Map<string, string>();
	const fileValues = new Map<string, string>();
	const installed = readUnit(options.installedUnitsDir, UNIT_NAME);
	if ("units" in installed) {
		for (const [name, value] of unitEnvironment(installed.units)) {
			env.set(name, value);
			fileValues.set(name, value);
		}
	} else {
		const declared = readUnit(options.unitsDir, UNIT_NAME);
		if ("units" in declared) for (const [name, value] of unitEnvironment(declared.units)) env.set(name, value);
	}
	for (const file of options.envFiles) {
		const read = readText(file, MAX_ENV_BYTES);
		if ("missing" in read) {
			findings.push(finding("config", file, "warn", "env file not found; it contributes no variables (systemd will not start a unit whose non-optional EnvironmentFile is missing)"));
			continue;
		}
		if ("error" in read) {
			findings.push(finding("config", file, "error", `env file unreadable (${read.error})`));
			continue;
		}
		for (const [name, value] of parseEnvText(read.text)) {
			env.set(name, value);
			fileValues.set(name, value);
		}
	}
	return { env, fileValues, findings };
}

/** One preflight. Returns the process exit code; writes only through `io`. */
export async function run(options: Options, io: Io): Promise<number> {
	const findings: Finding[] = [];
	const guard = async (check: CheckClass, name: string, work: () => Promise<Finding[]> | Finding[]): Promise<void> => {
		try {
			findings.push(...(await work()));
		} catch (cause) {
			findings.push(finding(check, name, "error", `check crashed: ${messageOf(cause)}`));
		}
	};
	let env = new Map<string, string>();
	let fileValues = new Map<string, string>();
	await guard("config", "environment", () => {
		const built = buildEnvironment(options);
		env = built.env;
		fileValues = built.fileValues;
		return built.findings;
	});
	await guard("config", "loadConfig", () => {
		const child = io.child ?? runChild;
		const script = io.script ?? import.meta.path;
		return readChildReport(child([script, "--child", options.releaseDir, options.stateDir], Object.fromEntries(env)));
	});
	await guard("units", "unit drift", () => compareUnits(options.unitsDir, options.installedUnitsDir));
	await guard("disk", "free space", () => [checkDisk(options.releaseDir, io.env.SUBSTRATE_DEPLOY_MIN_FREE_GB, io.df ?? runDf)]);
	const order: CheckClass[] = ["config", "state", "units", "disk"];
	findings.sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check));
	const receipt = receiptLine(options.releaseDir, findings);
	const counts = summarize(findings);
	const shown = withholdQuotedValues(findings, fileValues);
	const body = options.json
		? `${JSON.stringify({ release: basename(options.releaseDir), findings: shown, summary: counts, result: counts.error === 0 ? "pass" : "fail", receipt })}\n`
		: `deploy-preflight ${basename(options.releaseDir)} (read-only; no environment value is printed)\n${formatTable(shown)}${receipt}\n`;
	io.stdout(body);
	return counts.error === 0 ? 0 : 1;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		io.stderr(`deploy-preflight: ${parsed.message}\n${USAGE}`);
		return 2;
	}
	let isDirectory = false;
	try {
		isDirectory = statSync(parsed.options.releaseDir).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) {
		io.stderr(`deploy-preflight: ${basename(parsed.options.releaseDir)} is not a directory\n${USAGE}`);
		return 2;
	}
	return await run(parsed.options, io);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	try {
		if (argv[0] === "--child") {
			const [, releaseDir, stateDir] = argv;
			if (releaseDir === undefined || stateDir === undefined) process.exit(2);
			const findings = await childFindings(releaseDir, stateDir);
			process.stdout.write(`${JSON.stringify({ findings })}\n`);
			process.exit(0);
		}
		process.exit(
			await main(argv, {
				stdout: (text) => process.stdout.write(text),
				stderr: (text) => process.stderr.write(text),
				env: process.env,
			}),
		);
	} catch (cause) {
		process.stderr.write(`deploy-preflight: ${messageOf(cause)}\n`);
		process.exit(2);
	}
}
