/**
 * Runtime-doctor rows for the VPS sandbox drop-ins of uplift-5 U5-2: how
 * exposed `systemd-analyze security` says each installed substrate unit is, and
 * whether an INSTALLED sandbox drop-in is actually in force. Pure parsers and
 * comparers plus one gatherer that goes through the doctor's injected `Host`,
 * so tests feed fixture command output and never read the machine.
 *
 * What it will not do, and why:
 * - It never installs, enables or edits a unit or a drop-in. The drop-ins are
 *   `infra/vps/<unit>.service.d/30-sandbox.conf.example`; the operator copies
 *   them (docs/runbooks/vps-hardening.md). This file only reads.
 * - The exposure compare is opt-in. `SUBSTRATE_EXPOSURE_MAX` unset means every
 *   exposure row is `ok` and says "report only", so the doctor's exit code is
 *   exactly what it was before this module existed. A number turns a unit above
 *   it into `drift` (exit 2), under the doctor's existing semantics. A value
 *   that is not a number from 0 to 10 is reported once as `warn` and the run
 *   stays report-only: a typo must not fail a unit or throw.
 * - It compares an installed drop-in against the repo example by the values
 *   `systemctl show` reports, never by reading the unit's secrets. The only file
 *   it opens is the installed drop-in itself (to learn it is installed); that
 *   file holds sandbox directives and paths, not credentials.
 * - A missing `systemd-analyze`, or one that fails on the first units without
 *   ever printing a verdict (no `security` verb), is one `unknown` row and the
 *   exposure rows stop there. A failure after a verdict was seen is that unit's
 *   own `unknown` row and the next unit is still analysed, so one flaky call
 *   cannot hide a later unit above the ceiling.
 * - Templates (`substrate-alert@.service`) get no exposure row (they have no
 *   instance to analyse) but do get a sandbox row when their drop-in is installed.
 *
 * Imports from `doctor-runtime.ts` are types only: that module imports this one.
 */
import { join } from "node:path";
import type { Host, Row, RunResult, Status } from "./doctor-runtime.ts";
import { logicalLines } from "./doctor-units.ts";

/** Where systemd reads operator drop-ins. A test injects another directory. */
export const INSTALLED_UNITS_DIR = "/etc/systemd/system";
export const EXPOSURE_ENV = "SUBSTRATE_EXPOSURE_MAX";
/** `<NN>-sandbox.conf.example` in the repo is installed as `<NN>-sandbox.conf`. */
export const SANDBOX_EXAMPLE_SUFFIX = "-sandbox.conf.example";

export type SandboxClass = "A" | "B";

/** One example drop-in as declared in the repo. */
export interface SandboxSpec {
	/** The installed file name, e.g. `30-sandbox.conf`. */
	file: string;
	class: SandboxClass | null;
	/** The `# exposure-ceiling:` header line: the score this unit is declared to stay at or under. */
	ceiling: number | null;
	/** The `[Service]` directives in file order. */
	directives: ReadonlyArray<readonly [string, string]>;
}

const CLASS_LINE = /^#\s*sandbox-class:\s*([AB])\s*$/m;
const CEILING_LINE = /^#\s*exposure-ceiling:\s*(\d{1,2}(?:\.\d)?)\s*$/m;

/** The example's header metadata and its `[Service]` directives. `fileName` is the `.example` name. */
export function parseSandboxExample(fileName: string, text: string): SandboxSpec {
	const cls = CLASS_LINE.exec(text)?.[1];
	const ceiling = CEILING_LINE.exec(text)?.[1];
	const directives: Array<readonly [string, string]> = [];
	let section = "";
	for (const line of logicalLines(text)) {
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header?.[1]) {
			section = header[1];
			continue;
		}
		if (section !== "Service") continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		directives.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
	}
	return {
		file: fileName.replace(/\.example$/, ""),
		class: cls === "A" || cls === "B" ? cls : null,
		ceiling: ceiling === undefined ? null : Number(ceiling),
		directives,
	};
}

// ── Exposure ─────────────────────────────────────────────────────────────────

/** `→ Overall exposure level for substrate-mcp.service: 4.7 OK :-)`; the level word is optional. */
const OVERALL = /Overall exposure level for [^:\n]+:\s*(\d+(?:\.\d+)?)(?:\s+([A-Z]+))?/;

export interface Exposure {
	score: number;
	level: string;
}

/** The overall verdict from `systemd-analyze security <unit> --no-pager` text; null when there is none. */
export function parseExposure(out: string): Exposure | null {
	const m = OVERALL.exec(out);
	if (!m?.[1]) return null;
	const score = Number(m[1]);
	return Number.isFinite(score) ? { score, level: m[2] ?? "" } : null;
}

export interface ExposureMax {
	/** The ceiling, or null for report-only. */
	max: number | null;
	/** The raw value when it was set and unusable, so the doctor can say so once. */
	invalid: string | null;
}

/** `SUBSTRATE_EXPOSURE_MAX`: unset or empty is report-only; a number 0..10 is the ceiling; anything else is invalid and report-only. */
export function exposureMaxFromEnv(env: Record<string, string | undefined>): ExposureMax {
	const raw = env[EXPOSURE_ENV]?.trim();
	if (raw === undefined || raw === "") return { max: null, invalid: null };
	if (/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) {
		const value = Number(raw);
		if (value >= 0 && value <= 10) return { max: value, invalid: null };
	}
	return { max: null, invalid: raw.replace(/[^\x20-\x7e]/g, "?").slice(0, 24) };
}

function row(check: string, status: Status, expected: string, actual: string, hint = ""): Row {
	return { class: "units", check, status, expected, actual, hint };
}

/**
 * One unit's exposure against the ceiling. No ceiling: `ok`, report only. A score
 * above the ceiling is drift; at or under is ok. A score that could not be read is `unknown`.
 */
export function compareExposure(unit: string, exposure: Exposure | null, max: number | null, ceiling: number | null = null): Row {
	const check = `${unit} exposure`;
	const want = max === null ? `report only (${EXPOSURE_ENV} unset)` : `≤ ${max} (${EXPOSURE_ENV})`;
	if (exposure === null) {
		return row(check, "unknown", want, "n/a", "systemd-analyze security printed no overall exposure level for this unit");
	}
	const actual = `${exposure.score.toFixed(1)}${exposure.level === "" ? "" : ` ${exposure.level}`}`;
	const staged = ceiling === null ? "" : ` (the staged drop-in is declared to reach ≤ ${ceiling})`;
	if (max === null) {
		return row(check, "ok", want, actual, `report only; staged drop-in: infra/vps/${unit}.d/30-sandbox.conf.example${staged}`);
	}
	if (exposure.score > max + 1e-9) {
		return row(
			check,
			"drift",
			want,
			actual,
			`install the staged sandbox drop-in (docs/runbooks/vps-hardening.md), or raise ${EXPOSURE_ENV}; \`systemd-analyze security ${unit}\` lists what is still open`,
		);
	}
	return row(check, "ok", want, actual);
}

// ── Effective values of an installed drop-in ─────────────────────────────────

type Kind = "bool" | "text" | "words" | "paths" | "caps";

/** Directive → how its `systemctl show` value is compared. Anything not listed is not compared. */
const CHECKED: Readonly<Record<string, Kind>> = {
	ProtectSystem: "text",
	ProtectHome: "text",
	ProtectKernelModules: "bool",
	ProtectKernelLogs: "bool",
	ProtectClock: "bool",
	ProtectHostname: "bool",
	LockPersonality: "bool",
	RestrictRealtime: "bool",
	RestrictSUIDSGID: "bool",
	RestrictNamespaces: "words",
	SystemCallArchitectures: "words",
	CapabilityBoundingSet: "caps",
	ReadWritePaths: "paths",
};

/** Every directive a sandbox example may use: the ones this module can verify against `systemctl show`. */
export const SANDBOX_DIRECTIVES: readonly string[] = Object.keys(CHECKED);

/** The `systemctl show -p` list for the directives a spec declares and this module can compare. */
export function sandboxProperties(spec: SandboxSpec): string {
	return [...new Set(spec.directives.map(([name]) => name).filter((name) => Object.hasOwn(CHECKED, name)))].join(",");
}

function normaliseBool(value: string): string {
	const v = value.trim().toLowerCase();
	if (v === "1" || v === "yes" || v === "true" || v === "on") return "yes";
	if (v === "0" || v === "no" || v === "false" || v === "off") return "no";
	return v;
}

function words(value: string): string[] {
	return value.trim().split(/\s+/).filter((w) => w !== "");
}

/** `systemctl show` prints a boolean as `yes`/`no`; the unit file spells it `true`/`false`. */
function sameScalar(kind: Kind, declared: string, effective: string): boolean {
	if (kind === "bool" || kind === "text") return normaliseBool(declared) === normaliseBool(effective);
	const a = words(normaliseBool(declared)).map((w) => w.toLowerCase()).sort();
	const b = words(normaliseBool(effective)).map((w) => w.toLowerCase()).sort();
	return a.length === b.length && a.every((w, i) => w === b[i]);
}

const PATH_FLAGS = /^[-+]+/;

/** Declared paths that are not in the effective list. Extra effective paths are fine: the operator adds repo roots. */
function missingPaths(declared: string, effective: string): string[] {
	const present = new Set(words(effective).map((p) => p.replace(PATH_FLAGS, "")));
	return words(declared)
		.map((p) => p.replace(PATH_FLAGS, ""))
		.filter((p) => !present.has(p));
}

/**
 * Whether a capability is still allowed by the effective bounding set. `systemctl show` prints either the
 * allowed names (`cap_chown cap_kill ...`) or, for a set it stores negated, `~cap_x ...`. A hex number or
 * an empty value cannot be judged: null.
 */
function capabilityVerdict(effective: string): ((cap: string) => boolean) | null {
	const tokens = words(effective).map((t) => t.toLowerCase());
	if (!tokens.some((t) => t.replace(/^~/, "").startsWith("cap_"))) return null;
	const negated = tokens[0]?.startsWith("~") === true;
	const set = new Set(tokens.map((t) => t.replace(/^~/, "")));
	return (cap) => (negated ? !set.has(cap.toLowerCase()) : set.has(cap.toLowerCase()));
}

export interface SandboxDiff {
	directive: string;
	expected: string;
	actual: string;
}

const MAX_NAMES_SHOWN = 5;

/**
 * The declared directives against the effective values. Only keys `systemctl show` actually printed are
 * compared (an old systemd that omits a property cannot be told from a mismatch). Returns the mismatches
 * and how many directives were checked.
 */
export function diffSandbox(spec: SandboxSpec, shown: ReadonlyMap<string, string>): { diffs: SandboxDiff[]; checked: number } {
	// Last assignment wins for a scalar; ReadWritePaths accumulates across assignments, an empty one resets.
	const scalar = new Map<string, string>();
	let paths: string[] = [];
	for (const [name, value] of spec.directives) {
		if (!Object.hasOwn(CHECKED, name)) continue;
		if (name === "ReadWritePaths") paths = value === "" ? [] : [...paths, ...words(value)];
		else scalar.set(name, value);
	}
	const diffs: SandboxDiff[] = [];
	let checked = 0;
	for (const [name, declared] of scalar) {
		const kind = CHECKED[name];
		const effective = shown.get(name);
		if (kind === undefined || effective === undefined) continue;
		if (kind === "caps") {
			const verdict = capabilityVerdict(effective);
			if (verdict === null) continue;
			checked += 1;
			const caps = words(declared);
			if (declared.trim().startsWith("~")) {
				const denied = caps.map((c) => c.replace(/^~/, "").toUpperCase());
				const leaked = denied.filter((c) => verdict(c));
				if (leaked.length > 0) {
					diffs.push({
						directive: name,
						expected: `denies ${denied.length} capabilities`,
						actual: `still allows ${leaked.slice(0, MAX_NAMES_SHOWN).join(" ")}${leaked.length > MAX_NAMES_SHOWN ? ` (+${leaked.length - MAX_NAMES_SHOWN})` : ""}`,
					});
				}
			} else {
				const wanted = caps.map((c) => c.toUpperCase());
				const missing = wanted.filter((c) => !verdict(c));
				if (missing.length > 0) diffs.push({ directive: name, expected: `allows ${wanted.length} capabilities`, actual: `denies ${missing.slice(0, MAX_NAMES_SHOWN).join(" ")}` });
			}
			continue;
		}
		checked += 1;
		if (!sameScalar(kind, declared, effective)) diffs.push({ directive: name, expected: `${name}=${declared}`, actual: `${name}=${effective}` });
	}
	if (paths.length > 0 && shown.has("ReadWritePaths")) {
		checked += 1;
		const missing = missingPaths(paths.join(" "), shown.get("ReadWritePaths") ?? "");
		if (missing.length > 0) {
			diffs.push({
				directive: "ReadWritePaths",
				expected: `ReadWritePaths includes ${missing.slice(0, MAX_NAMES_SHOWN).join(" ")}`,
				actual: "not in force",
			});
		}
	}
	return { diffs, checked };
}

/**
 * An installed sandbox drop-in against `systemctl show`. `shown` is null when systemctl could not be asked.
 * A drop-in that is on disk but not in force (no `daemon-reload` since the copy, or a later drop-in
 * overriding it) is drift: the operator believes the unit is sandboxed and it is not.
 */
export function compareSandbox(unit: string, spec: SandboxSpec, shown: ReadonlyMap<string, string> | null): Row {
	const check = `${unit} sandbox`;
	const want = `${spec.file} in force (${spec.directives.length} directives, class ${spec.class ?? "?"})`;
	if (shown === null) return row(check, "unknown", want, "n/a", "systemctl show failed");
	const { diffs, checked } = diffSandbox(spec, shown);
	if (checked === 0) return row(check, "unknown", want, "n/a", "systemctl show returned none of the sandbox properties; systemd too old to compare");
	if (diffs.length > 0) {
		return row(
			check,
			"drift",
			diffs.map((d) => d.expected).join("; "),
			diffs.map((d) => d.actual).join("; "),
			`${spec.file} is installed but not in force: systemctl daemon-reload && systemctl restart ${unit}, or a later drop-in overrides it. Rollback: remove ${spec.file}`,
		);
	}
	return row(check, "ok", want, `as declared (${checked} compared)`);
}

// ── Gathering (the only place the host is touched) ───────────────────────────

export interface HardeningUnit {
	name: string;
	sandbox?: SandboxSpec;
}

export interface HardeningOptions {
	/** The ceiling, or null for report only. */
	exposureMax: number | null;
	/** A set but unusable `SUBSTRATE_EXPOSURE_MAX`, reported once. */
	invalidMax: string | null;
	/** Where installed drop-ins live; `INSTALLED_UNITS_DIR` unless a test says otherwise. */
	installedDir: string;
}

export function hardeningOptionsFromEnv(env: Record<string, string | undefined>): HardeningOptions {
	const { max, invalid } = exposureMaxFromEnv(env);
	return { exposureMax: max, invalidMax: invalid, installedDir: INSTALLED_UNITS_DIR };
}

/** `systemctl show <unit> -p <props>` as the doctor reads it; null when it failed. */
export type ShowProps = (unit: string, props: string) => ReadonlyMap<string, string> | null;

function runGuarded(host: Host, argv: readonly string[]): RunResult | null {
	try {
		return host.run(argv);
	} catch {
		return null;
	}
}

/** Leading analyzer failures (no verdict ever seen) that mean "this systemd cannot do `security`", not "this unit failed". */
const LEADING_FAILURES_LIMIT = 2;
/** Hard cap on `systemd-analyze` spawns per run; past it one `unknown` row is emitted and no more spawns happen. */
export const MAX_ANALYZER_CALLS = 64;

/**
 * Exposure and sandbox rows for the units systemd has loaded. `units` is the installed subset: the caller
 * passes only units whose `LoadState` is `loaded`, so a staged unit that is not installed gets no row here
 * (compareUnit already says `unknown` for it). Every command is a fixed argv through `host.run`; nothing is
 * written.
 *
 * Failure policy for `systemd-analyze security` (a unit's own failure must never silence the others, or a
 * later unit above `SUBSTRATE_EXPOSURE_MAX` would never drift):
 * - binary absent (the spawn returned null): one `unknown` row, no more calls;
 * - the first LEADING_FAILURES_LIMIT calls all fail before any verdict was ever read: the verb is missing
 *   or unusable on this systemd, so one `unknown` row replaces those per-unit rows and no more calls;
 * - any other non-zero exit (a timeout, a unit systemd could not analyse): that unit's own `unknown` row,
 *   and the next unit is still analysed.
 * A template (`name@.service`) has no instance to analyse, so it gets a sandbox row but no exposure row.
 */
export function gatherHardeningRows(host: Host, units: readonly HardeningUnit[], showProps: ShowProps, options: HardeningOptions): Row[] {
	const rows: Row[] = [];
	if (options.invalidMax !== null) {
		rows.push(row(EXPOSURE_ENV, "warn", "a number from 0 to 10, or unset", `"${options.invalidMax}"`, "not a number from 0 to 10; the exposure rows stay report-only"));
	}
	const wantMax = options.exposureMax === null ? `report only (${EXPOSURE_ENV} unset)` : `≤ ${options.exposureMax} (${EXPOSURE_ENV})`;
	const analyzerRow = (hint: string): Row => row("systemd-analyze security", "unknown", wantMax, "n/a", hint);
	let analyzing = true;
	let calls = 0;
	let sawVerdict = false;
	let leading: Row[] = [];
	for (const unit of units) {
		if (unit.sandbox !== undefined) {
			const props = sandboxProperties(unit.sandbox);
			let installed: string | null = null;
			try {
				installed = host.readText(join(options.installedDir, `${unit.name}.d`, unit.sandbox.file));
			} catch {
				installed = null;
			}
			if (installed !== null && props !== "") rows.push(compareSandbox(unit.name, unit.sandbox, showProps(unit.name, props)));
		}
		if (unit.name.includes("@") || !analyzing) continue;
		if (calls >= MAX_ANALYZER_CALLS) {
			analyzing = false;
			rows.push(analyzerRow(`stopped after ${MAX_ANALYZER_CALLS} systemd-analyze calls; the remaining units have no exposure row`));
			continue;
		}
		calls += 1;
		const result = runGuarded(host, ["systemd-analyze", "security", unit.name, "--no-pager"]);
		if (result === null) {
			analyzing = false;
			leading = [];
			rows.push(analyzerRow("systemd-analyze is not available (not installed, or it could not be run); no further exposure rows"));
			continue;
		}
		if (result.code !== 0) {
			const failed = row(
				`${unit.name} exposure`,
				"unknown",
				wantMax,
				"n/a",
				`systemd-analyze security exited ${result.code} for this unit (a timeout, no bus access, or a unit it cannot analyse); the other units are still checked`,
			);
			if (sawVerdict) {
				rows.push(failed);
				continue;
			}
			leading.push(failed);
			if (leading.length >= LEADING_FAILURES_LIMIT) {
				analyzing = false;
				leading = [];
				rows.push(analyzerRow(`systemd-analyze security failed (exit ${result.code}) on the first ${LEADING_FAILURES_LIMIT} units and never printed a verdict: the verb is missing on this systemd, or there is no bus access; no further exposure rows`));
			}
			continue;
		}
		sawVerdict = true;
		rows.push(...leading);
		leading = [];
		rows.push(compareExposure(unit.name, parseExposure(result.out), options.exposureMax, unit.sandbox?.ceiling ?? null));
	}
	rows.push(...leading);
	return rows;
}
