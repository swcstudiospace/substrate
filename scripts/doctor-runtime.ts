#!/usr/bin/env bun
/**
 * Runtime drift doctor (`bun run doctor:runtime`): the HOST against the DECLARED policy.
 *
 *   bun scripts/doctor-runtime.ts [--json] [--emit] [--infra dir]
 *
 * `scripts/doctor-units.ts` reads the unit files and never asks systemd; this
 * doctor asks systemd, redis, `df` and `/proc` what is actually in force and
 * compares it with what `infra/vps/` declares. The two disagree silently
 * today (uplift-3 CONTEXT.md VPS row): redis still at `maxmemory 0` /
 * `noeviction` / RDB snapshots on a 94 % disk although R7 ships
 * `redis-substrate.conf`; the anchor timer not installed although BP-7 needs
 * its hourly root; no health timer at all.
 *
 * One row per check, status `ok | warn | drift | unknown`:
 * - `drift`   — the host contradicts the declared policy; exit 2.
 * - `warn`    — inside a band the operator should see (disk below 2× the floor); exit 0.
 * - `unknown` — the doctor could not read one side (redis unreachable, a unit
 *               not installed that is not a release unit); exit 0, never a false drift.
 *
 * Invariants:
 * - Read-only. Every external command goes through one injectable `run(argv)`
 *   (fixed argv, never a shell string), so tests feed fixture output.
 * - Env files are never opened by this process. Legacy keys are checked by
 *   NAME through `grep -q '^NAME=.'` exactly as `deploy-release.sh` does, and
 *   only `Environment=` NAMES are compared, so no value from an env file or a
 *   unit can reach a row, the JSON, or an emitted event.
 * - `--emit` posts at most one `warning` event per drift CLASS, only when
 *   `SUBSTRATE_DOCTOR_EMIT=1`, and only when that class's drift set changed
 *   since the last emit (state file). The bearer is resolved like the other
 *   host jobs and never printed.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBearer } from "../packages/cli/src/token.ts";
import { LEGACY_ENV_KEYS, type LegacyEnvKey } from "../packages/mcp-server/src/legacy-env.ts";
import { isSubstrateUnit, logicalLines, SHARED_ENV_FILE } from "./doctor-units.ts";
import { parseSystemctlShow, systemdTimestampToEpoch } from "./parity-check.ts";

export type Status = "ok" | "warn" | "drift" | "unknown";
export type CheckClass = "units" | "slice" | "redis" | "timers" | "disk" | "swap" | "env";

export interface Row {
	class: CheckClass;
	/** Stable id, e.g. `substrate-mcp.service`, `redis maxmemory`, `disk /opt/agent-substrate`. */
	check: string;
	status: Status;
	expected: string;
	actual: string;
	hint: string;
}

export interface RunResult {
	code: number;
	out: string;
}

/** Fixed argv, no shell. `null` when the binary is missing or the spawn failed. */
export type Runner = (argv: readonly string[]) => RunResult | null;

/** Everything the doctor reads from the host, so tests supply fixtures. */
export interface Host {
	run: Runner;
	/** A file's text, or null when unreadable. Used for `/proc` only; env files go through `run(grep -q)`. */
	readText(path: string): string | null;
	sleep(ms: number): Promise<void>;
	/** Epoch seconds. */
	now(): number;
}

/** The four units `deploy-release.sh` restarts (its SUBSTRATE_RELEASE_UNITS default): not installed is drift, not unknown. */
export const RELEASE_UNITS: readonly string[] = [
	"substrate-mcp.service",
	"substrate-collector-grok.service",
	"substrate-collector-herdr.service",
	"substrate-collector-muse.service",
];

export const SLICE_UNIT = "substrate.slice";
export const REDIS_UNIT = "redis-server.service";
export const REDIS_CONF = "redis-substrate.conf";
export const REDIS_DROP_IN = join("redis-server.service.d", "10-substrate-limits.conf");
export const RELEASE_ROOT = "/opt/agent-substrate";
export const DEFAULT_STATE_FILE = "/var/lib/substrate/doctor-last.json";
export const DEFAULT_MIN_FREE_GB = 5;
/** Enough to tell "the host is paging" from "a page or two moved": the ledger warns above this, per second. */
export const DEFAULT_SWAP_PAGES_PER_SECOND = 0;
/** The two /proc/vmstat reads are this far apart; the rate is per second regardless. */
export const SWAP_SAMPLE_MS = 1000;
/** A summary longer than this is cut; the row detail is in the payload. */
export const SUMMARY_MAX = 200;

export interface ExpectedTimer {
	name: string;
	/** Seconds between ticks as the repo timer declares; "not fired for 2× this" is drift. */
	periodSeconds: number;
	/** Not installed: drift when required (BP-7's anchor), unknown with an install hint otherwise. */
	required: boolean;
	why: string;
}

/**
 * The timers the host is expected to carry. Periods follow the `OnCalendar`
 * lines in `infra/vps/*.timer` (hourly; daily 03:17 UTC; every 6 h); the
 * calendar spec itself is not parsed here.
 */
export const EXPECTED_TIMERS: readonly ExpectedTimer[] = [
	{ name: "substrate-anchor.timer", periodSeconds: 3600, required: true, why: "BP-7 hourly ledger root" },
	{ name: "substrate-index-sweep.timer", periodSeconds: 86_400, required: false, why: "opt-in daily retention report" },
	{ name: "substrate-doctor.timer", periodSeconds: 6 * 3600, required: false, why: "opt-in runtime doctor" },
];

/**
 * Keys whose presence in the shared env is drift, with the hint `config.ts`
 * prints at boot. The table lives in the MCP server package because the key
 * may be spelled only there (store-lock.test.ts); this script never names it.
 */
export const LEGACY_KEYS: readonly LegacyEnvKey[] = LEGACY_ENV_KEYS;

const SYSTEMCTL_UNIT_PROPS = "LoadState,ActiveState,SubState,Slice,MemoryMax,TasksMax,NRestarts,FragmentPath,Environment";
const SYSTEMCTL_SLICE_PROPS = "LoadState,ActiveState,MemoryLow";
const SYSTEMCTL_TIMER_PROPS = "LoadState,ActiveState,UnitFileState,LastTriggerUSec,NextElapseUSecRealtime";
const SPAWN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLASS_ORDER: readonly CheckClass[] = ["units", "slice", "redis", "timers", "disk", "swap", "env"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Declared policy (repo files) ─────────────────────────────────────────────

export interface DeclaredUnit {
	name: string;
	slice: string | null;
	memoryMax: string | null;
	tasksMax: string | null;
	/** `Environment=` NAMES from the unit and its drop-ins; values stay in the files. */
	environmentNames: readonly string[];
}

/** The `[Service]` (or `[Slice]`) directives of one unit text as ordered pairs; repeated keys stay repeated. */
export function sectionDirectives(text: string, section: string): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	let current = "";
	for (const line of logicalLines(text)) {
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header?.[1]) {
			current = header[1];
			continue;
		}
		if (current !== section) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		pairs.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
	}
	return pairs;
}

/** Declared ceilings and env names from a unit file plus its drop-ins, last assignment winning like systemd. */
export function declaredUnit(name: string, baseText: string, dropIns: readonly string[] = []): DeclaredUnit {
	let slice: string | null = null;
	let memoryMax: string | null = null;
	let tasksMax: string | null = null;
	const names = new Set<string>();
	for (const text of [baseText, ...dropIns]) {
		for (const [key, value] of sectionDirectives(text, "Service")) {
			if (key === "Slice") slice = value || null;
			else if (key === "MemoryMax") memoryMax = value || null;
			else if (key === "TasksMax") tasksMax = value || null;
			else if (key === "Environment") {
				if (value === "") names.clear();
				else for (const envName of environmentNames(value)) names.add(envName);
			}
		}
	}
	return { name, slice, memoryMax, tasksMax, environmentNames: [...names].sort() };
}

/**
 * The NAMES in an `Environment=` value (unit file or `systemctl show`), never
 * the values. Tokens are split on whitespace outside quotes; a token that
 * is not `NAME=…` is skipped. A `=` inside a quoted value cannot start a
 * name because the quoted token is consumed whole.
 */
export function environmentNames(value: string): string[] {
	const names: string[] = [];
	for (const token of splitQuoted(value)) {
		const eq = token.indexOf("=");
		if (eq <= 0) continue;
		const name = token.slice(0, eq);
		if (ENV_NAME.test(name)) names.push(name);
	}
	return names;
}

function splitQuoted(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let started = false;
	for (const ch of value) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

/** Every `substrate-*.service` under `dir` as declared ceilings, with its `.d/*.conf` drop-ins applied. */
export function loadDeclaredUnits(dir: string): DeclaredUnit[] {
	const units: DeclaredUnit[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!isSubstrateUnit(name)) continue;
		const base = readFileSync(join(dir, name), "utf8");
		units.push(declaredUnit(name, base, readDropIns(join(dir, `${name}.d`))));
	}
	return units;
}

function readDropIns(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return [];
	}
	return names.filter((n) => n.endsWith(".conf")).map((n) => readFileSync(join(dir, n), "utf8"));
}

/** `MemoryLow` from the repo `substrate.slice`. */
export function declaredSliceMemoryLow(text: string): string | null {
	let low: string | null = null;
	for (const [key, value] of sectionDirectives(text, "Slice")) if (key === "MemoryLow") low = value || null;
	return low;
}

export interface DeclaredRedis {
	maxmemory: string | null;
	maxmemoryPolicy: string | null;
	/** The `save` points joined by a space; `""` in the conf is the empty string (no RDB snapshots). */
	save: string | null;
	appendonly: string | null;
}

/**
 * The four cache-policy directives of a redis conf. Several `save` lines
 * accumulate like redis does; `save ""` resets to none. Unknown directives
 * are ignored, so `bind` and the rest never surface here.
 */
export function parseRedisConf(text: string): DeclaredRedis {
	const out: DeclaredRedis = { maxmemory: null, maxmemoryPolicy: null, save: null, appendonly: null };
	const saves: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const space = line.search(/\s/);
		const key = space < 0 ? line : line.slice(0, space);
		const value = space < 0 ? "" : line.slice(space + 1).trim();
		switch (key) {
			case "maxmemory":
				out.maxmemory = value;
				break;
			case "maxmemory-policy":
				out.maxmemoryPolicy = value;
				break;
			case "appendonly":
				out.appendonly = value;
				break;
			case "save":
				if (value === '""' || value === "''" || value === "") saves.length = 0;
				else saves.push(value);
				out.save = saves.join(" ");
				break;
			default:
				break;
		}
	}
	return out;
}

// ── Size and value normalisation ─────────────────────────────────────────────

const SIZE_SHIFT: Record<string, number> = { k: 10, m: 20, g: 30, t: 40 };

/**
 * A systemd size (`2G`, `512M`, `infinity`, bytes) or a redis size
 * (`256mb`, `1g`, bytes) as bytes; `infinity` for unlimited; null when it
 * is neither. Both use binary units. A redis `maxmemory 0` is "no limit" but
 * stays 0 here: against a declared `256mb` it is the drift being looked for.
 */
export function parseBytes(value: string | null | undefined): number | "infinity" | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "") return null;
	if (trimmed === "infinity") return "infinity";
	const m = /^(\d+)\s*([kmgt])?(?:i?b)?$/.exec(trimmed);
	if (!m?.[1]) return null;
	const shift = SIZE_SHIFT[m[2] ?? ""] ?? 0;
	return Number(m[1]) * 2 ** shift;
}

/** Bytes back to the short form the unit files use (`2G`, `512M`), for the table. */
export function formatBytes(value: number | "infinity" | null): string {
	if (value === null) return "n/a";
	if (value === "infinity") return "infinity";
	for (const [unit, shift] of [
		["T", 40],
		["G", 30],
		["M", 20],
		["K", 10],
	] as const) {
		const size = 2 ** shift;
		if (value >= size && value % size === 0) return `${value / size}${unit}`;
	}
	return String(value);
}

function sameBytes(declared: string | null, host: string | undefined): boolean {
	return parseBytes(declared) === parseBytes(host);
}

// ── Checks (pure: parsed inputs in, rows out) ────────────────────────────────

function row(cls: CheckClass, check: string, status: Status, expected: string, actual: string, hint = ""): Row {
	return { class: cls, check, status, expected, actual, hint };
}

/**
 * One unit against its `systemctl show` properties. `shown` is null when
 * systemctl could not be asked at all. A unit systemd does not know
 * (`LoadState=not-found`) is unknown — the repo stages units before the
 * operator installs them — except the release units, which must be there.
 */
export function compareUnit(declared: DeclaredUnit, shown: ReadonlyMap<string, string> | null): Row[] {
	const check = declared.name;
	const want = [
		declared.slice === null ? null : `Slice=${declared.slice}`,
		declared.memoryMax === null ? null : `MemoryMax=${declared.memoryMax}`,
		declared.tasksMax === null ? null : `TasksMax=${declared.tasksMax}`,
	]
		.filter((s): s is string => s !== null)
		.join(" ");
	if (shown === null) return [row("units", check, "unknown", want, "n/a", "systemctl show failed")];
	const load = shown.get("LoadState") ?? "";
	if (load !== "loaded") {
		const release = RELEASE_UNITS.includes(declared.name);
		return [
			row(
				"units",
				check,
				release ? "drift" : "unknown",
				want,
				`LoadState=${load || "n/a"}`,
				release
					? "release unit not installed; deploy-release.sh restarts it on every deploy"
					: "not installed on this host; staged in infra/vps until the operator installs it",
			),
		];
	}
	const rows: Row[] = [];
	const diffs: Array<[string, string]> = [];
	const hostSlice = shown.get("Slice") ?? "";
	if (declared.slice !== null && hostSlice !== declared.slice) diffs.push([`Slice=${declared.slice}`, `Slice=${hostSlice || "n/a"}`]);
	if (declared.memoryMax !== null && !sameBytes(declared.memoryMax, shown.get("MemoryMax"))) {
		diffs.push([`MemoryMax=${declared.memoryMax}`, `MemoryMax=${formatBytes(parseBytes(shown.get("MemoryMax")))}`]);
	}
	if (declared.tasksMax !== null && (shown.get("TasksMax") ?? "").trim() !== declared.tasksMax) {
		diffs.push([`TasksMax=${declared.tasksMax}`, `TasksMax=${shown.get("TasksMax") || "n/a"}`]);
	}
	const active = shown.get("ActiveState") ?? "";
	const restarts = shown.get("NRestarts") ?? "0";
	const vitals = `ActiveState=${active || "n/a"} NRestarts=${restarts}`;
	if (RELEASE_UNITS.includes(declared.name) && active !== "active") {
		diffs.push(["ActiveState=active", `ActiveState=${active || "n/a"}`]);
	}
	if (diffs.length > 0) {
		rows.push(
			row(
				"units",
				check,
				"drift",
				diffs.map(([e]) => e).join(" "),
				diffs.map(([, a]) => a).join(" "),
				`${vitals}; reinstall the unit from infra/vps and daemon-reload`,
			),
		);
	} else {
		rows.push(row("units", check, "ok", want || "no ceilings declared", "as declared", vitals));
	}
	if (declared.environmentNames.length > 0) {
		const present = new Set(environmentNames(shown.get("Environment") ?? ""));
		const missing = declared.environmentNames.filter((name) => !present.has(name));
		rows.push(
			missing.length === 0
				? row("units", `${check} Environment`, "ok", declared.environmentNames.join(" "), "all names present")
				: row(
						"units",
						`${check} Environment`,
						"drift",
						declared.environmentNames.join(" "),
						`missing: ${missing.join(" ")}`,
						"the installed unit predates these Environment= lines; reinstall it from infra/vps",
					),
		);
	}
	return rows;
}

/** `substrate.slice` must be installed, active and carry the declared `MemoryLow`. */
export function compareSlice(declaredMemoryLow: string | null, shown: ReadonlyMap<string, string> | null): Row {
	const want = `MemoryLow=${declaredMemoryLow ?? "n/a"}`;
	if (shown === null) return row("slice", SLICE_UNIT, "unknown", want, "n/a", "systemctl show failed");
	const load = shown.get("LoadState") ?? "";
	if (load !== "loaded") {
		return row(
			"slice",
			SLICE_UNIT,
			"drift",
			want,
			`LoadState=${load || "n/a"}`,
			"cp infra/vps/substrate.slice /etc/systemd/system/ && systemctl daemon-reload (README: Resource ceilings)",
		);
	}
	const active = shown.get("ActiveState") ?? "";
	const low = shown.get("MemoryLow");
	if (active !== "active") {
		return row("slice", SLICE_UNIT, "drift", `${want} ActiveState=active`, `ActiveState=${active || "n/a"}`, "no member unit is running in the slice");
	}
	if (!sameBytes(declaredMemoryLow, low)) {
		return row("slice", SLICE_UNIT, "drift", want, `MemoryLow=${formatBytes(parseBytes(low))}`, "installed slice file differs; reinstall and daemon-reload");
	}
	return row("slice", SLICE_UNIT, "ok", want, "as declared", `ActiveState=${active}`);
}

export interface RedisHost {
	/** `redis-cli config get <key>` values by key; null when redis was unreachable. */
	config: ReadonlyMap<string, string> | null;
	/** `used_memory_human` from `info memory`, for the hint. */
	usedMemoryHuman: string | null;
}

/**
 * `redis-cli config get <key>` prints the key on one line and the value on
 * the next (an empty `save` is an empty line). A connection error leaves
 * no key line, which is how an unreachable redis is told from an empty value.
 */
export function parseRedisConfigGet(key: string, out: string): string | null {
	const lines = out.replace(/\r/g, "").split("\n");
	const at = lines.indexOf(key);
	if (at < 0) return null;
	return lines[at + 1] ?? "";
}

/** `used_memory_human:` from `redis-cli info memory`. */
export function parseRedisInfoUsed(out: string): string | null {
	const m = /^used_memory_human:(.*)$/m.exec(out);
	return m?.[1]?.trim() || null;
}

/** Redis in force against `redis-substrate.conf`, plus the unit's `MemoryMax` against the drop-in. */
export function compareRedis(
	declared: DeclaredRedis,
	declaredUnitMemoryMax: string | null,
	host: RedisHost,
	unitShown: ReadonlyMap<string, string> | null,
): Row[] {
	const rows: Row[] = [];
	const unreachable = host.config === null;
	const hint = unreachable
		? "redis unreachable on 127.0.0.1 (redis-cli); nothing compared"
		: `used_memory ${host.usedMemoryHuman ?? "n/a"}; install redis-substrate.conf (README: Loopback redis)`;
	const compare = (
		check: string,
		want: string | null,
		got: string | null,
		same: (a: string, b: string) => boolean,
		render: (v: string) => string = (v) => v,
	) => {
		if (want === null) return;
		if (unreachable || got === null) {
			rows.push(row("redis", check, "unknown", render(want), "n/a", hint));
			return;
		}
		rows.push(same(want, got) ? row("redis", check, "ok", render(want), "as declared", hint) : row("redis", check, "drift", render(want), render(got), hint));
	};
	const bytesEqual = (a: string, b: string) => parseBytes(a) === parseBytes(b);
	const textEqual = (a: string, b: string) => a.trim() === b.trim();
	const saveEqual = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
	const showSave = (v: string) => (v.trim() === "" ? '"" (no RDB snapshots)' : v.trim());
	const showBytes = (v: string) => formatBytes(parseBytes(v));
	compare("redis maxmemory", declared.maxmemory, host.config?.get("maxmemory") ?? null, bytesEqual, showBytes);
	compare("redis maxmemory-policy", declared.maxmemoryPolicy, host.config?.get("maxmemory-policy") ?? null, textEqual);
	compare("redis save", declared.save, host.config?.get("save") ?? null, saveEqual, showSave);
	compare("redis appendonly", declared.appendonly, host.config?.get("appendonly") ?? null, textEqual);

	const unitWant = `MemoryMax=${declaredUnitMemoryMax ?? "n/a"}`;
	if (declaredUnitMemoryMax === null) return rows;
	if (unitShown === null || (unitShown.get("LoadState") ?? "") !== "loaded") {
		rows.push(
			row("redis", `${REDIS_UNIT} MemoryMax`, "unknown", unitWant, `LoadState=${unitShown?.get("LoadState") || "n/a"}`, "redis-server unit not installed as a systemd service"),
		);
	} else if (!sameBytes(declaredUnitMemoryMax, unitShown.get("MemoryMax"))) {
		rows.push(
			row(
				"redis",
				`${REDIS_UNIT} MemoryMax`,
				"drift",
				unitWant,
				`MemoryMax=${formatBytes(parseBytes(unitShown.get("MemoryMax")))}`,
				`install infra/vps/${REDIS_DROP_IN} and daemon-reload (README: Loopback redis)`,
			),
		);
	} else {
		rows.push(row("redis", `${REDIS_UNIT} MemoryMax`, "ok", unitWant, "as declared"));
	}
	return rows;
}

/**
 * A timer against the inventory: installed, enabled, active, and fired
 * within 2× its period. Not installed is drift only for the required
 * anchor timer; the opt-in timers say so instead of alarming.
 */
export function compareTimer(expected: ExpectedTimer, shown: ReadonlyMap<string, string> | null, nowSeconds: number): Row {
	const check = expected.name;
	const want = `installed enabled active, fired within ${Math.round((2 * expected.periodSeconds) / 3600)}h (${expected.why})`;
	if (shown === null) return row("timers", check, "unknown", want, "n/a", "systemctl show failed");
	const load = shown.get("LoadState") ?? "";
	if (load !== "loaded") {
		return expected.required
			? row("timers", check, "drift", want, `LoadState=${load || "n/a"}`, `${expected.why} is not scheduled; install and enable the timer (README: Hourly anchor job)`)
			: row("timers", check, "unknown", want, `LoadState=${load || "n/a"}`, `${expected.why}: opt-in, not installed on this host; install and enable it to turn this on`);
	}
	const fileState = shown.get("UnitFileState") ?? "";
	const active = shown.get("ActiveState") ?? "";
	const last = systemdTimestampToEpoch(shown.get("LastTriggerUSec"));
	const ageSeconds = last === null ? null : Math.max(0, nowSeconds - last);
	const actual = `UnitFileState=${fileState || "n/a"} ActiveState=${active || "n/a"} last fired ${ageSeconds === null ? "never" : `${formatAge(ageSeconds)} ago`}`;
	if (fileState !== "enabled" && fileState !== "static") {
		return row("timers", check, "drift", want, actual, "installed but not enabled; systemctl enable --now " + check);
	}
	if (active !== "active") return row("timers", check, "drift", want, actual, "enabled but not active; systemctl start " + check);
	if (ageSeconds !== null && ageSeconds > 2 * expected.periodSeconds) {
		return row("timers", check, "drift", want, actual, "timer is active but has not fired for two periods; journalctl -u " + check);
	}
	return row("timers", check, "ok", want, actual, ageSeconds === null ? "no tick yet; a Persistent timer fires on its first elapse" : "");
}

export function formatAge(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)}s`;
	if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
	if (seconds < 36 * 3600) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86_400).toFixed(1)}d`;
}

/** The available kilobytes from `df -Pk <path>` (second line, fourth column), as `deploy-release.sh` reads it. */
export function parseDfAvailableKb(out: string): number | null {
	const second = out.split("\n")[1];
	if (!second) return null;
	const avail = second.trim().split(/\s+/)[3];
	return avail !== undefined && /^\d{1,15}$/.test(avail) ? Number(avail) : null;
}

/**
 * Free space on the release filesystem against the deploy floor
 * (`SUBSTRATE_DEPLOY_MIN_FREE_GB`, default 5; `0` disables, as in
 * `deploy-release.sh`). Below the floor is drift — the next deploy will
 * refuse; below 2× the floor is warn — the next release tree plus
 * node_modules will take it there.
 */
export function compareDisk(availableKb: number | null, minFreeGb: number): Row {
	const check = `disk ${RELEASE_ROOT}`;
	const floor = `≥ ${minFreeGb} GB free (SUBSTRATE_DEPLOY_MIN_FREE_GB)`;
	if (availableKb === null) return row("disk", check, "unknown", floor, "n/a", `df -Pk ${RELEASE_ROOT} failed`);
	const availableGb = availableKb / 1024 / 1024;
	const actual = `${availableGb.toFixed(1)} GB free`;
	if (minFreeGb === 0) return row("disk", check, "ok", "floor disabled (0)", actual, "SUBSTRATE_DEPLOY_MIN_FREE_GB=0 disables the floor");
	if (availableGb < minFreeGb) return row("disk", check, "drift", floor, actual, "deploy-release.sh will refuse to build; docs/runbooks/disk-pressure.md");
	if (availableGb < 2 * minFreeGb) {
		return row("disk", check, "warn", floor, actual, `below 2× the floor (${2 * minFreeGb} GB); reclaim before the next deploy: docs/runbooks/disk-pressure.md`);
	}
	return row("disk", check, "ok", floor, actual);
}

export interface SwapSample {
	pswpin: number;
	pswpout: number;
}

/** `pswpin` / `pswpout` counters from `/proc/vmstat`; null when either is missing. */
export function parseVmstatSwap(text: string): SwapSample | null {
	const pick = (key: string): number | null => {
		const m = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
		return m?.[1] ? Number(m[1]) : null;
	};
	const pswpin = pick("pswpin");
	const pswpout = pick("pswpout");
	return pswpin === null || pswpout === null ? null : { pswpin, pswpout };
}

/** `SwapTotal` / `SwapFree` kB from `/proc/meminfo`, as used bytes and total bytes; null when absent. */
export function parseMeminfoSwap(text: string): { usedBytes: number; totalBytes: number } | null {
	const pick = (key: string): number | null => {
		const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
		return m?.[1] ? Number(m[1]) * 1024 : null;
	};
	const total = pick("SwapTotal");
	const free = pick("SwapFree");
	return total === null || free === null ? null : { usedBytes: total - free, totalBytes: total };
}

/**
 * Paging rate from two vmstat samples. Occupancy is reported in the hint
 * and never alone a drift: this host has run for months with 12 GiB of
 * swap occupied and nothing paging, and that is not a condition the
 * operator can act on. Pages moving is.
 */
export function compareSwap(
	before: SwapSample | null,
	after: SwapSample | null,
	elapsedMs: number,
	occupancy: { usedBytes: number; totalBytes: number } | null,
	maxPagesPerSecond: number,
): Row {
	const check = "swap paging";
	const want = `≤ ${maxPagesPerSecond} pages/s in+out`;
	const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);
	const occupied = occupancy === null ? "occupancy n/a" : `swap ${gib(occupancy.usedBytes)} GiB of ${gib(occupancy.totalBytes)} GiB in use`;
	if (before === null || after === null || elapsedMs <= 0) return row("swap", check, "unknown", want, "n/a", `/proc/vmstat unreadable; ${occupied}`);
	const pages = Math.max(0, after.pswpin - before.pswpin) + Math.max(0, after.pswpout - before.pswpout);
	const rate = pages / (elapsedMs / 1000);
	const actual = `${rate.toFixed(1)} pages/s over ${(elapsedMs / 1000).toFixed(1)}s`;
	if (rate > maxPagesPerSecond) {
		return row("swap", check, "drift", want, actual, `host is paging; ${occupied}; docs/runbooks/disk-pressure.md names the co-tenants`);
	}
	return row("swap", check, "ok", want, actual, occupied);
}

/**
 * A legacy key by NAME. `present` is the `grep -q '^NAME=.'` verdict: true,
 * false, or null when the file could not be read. The value never leaves grep.
 */
export function compareLegacyKey(key: LegacyEnvKey, present: boolean | null, file: string): Row {
	const check = `${file} ${key.name}`;
	const want = `${key.name} unset (use ${key.replacement})`;
	if (present === null) return row("env", check, "unknown", want, "n/a", "env file unreadable");
	if (present) return row("env", check, "drift", want, `${key.name} set`, key.hint);
	return row("env", check, "ok", want, "unset");
}

// ── Gathering (the only place the host is touched) ───────────────────────────

export interface Policy {
	units: readonly DeclaredUnit[];
	sliceMemoryLow: string | null;
	redis: DeclaredRedis;
	redisUnitMemoryMax: string | null;
}

/** Everything `infra/vps` declares, read once. */
export function loadPolicy(infraDir: string): Policy {
	const redisDropIn = declaredUnit(REDIS_UNIT, "", [readFileSync(join(infraDir, REDIS_DROP_IN), "utf8")]);
	return {
		units: loadDeclaredUnits(infraDir),
		sliceMemoryLow: declaredSliceMemoryLow(readFileSync(join(infraDir, SLICE_UNIT), "utf8")),
		redis: parseRedisConf(readFileSync(join(infraDir, REDIS_CONF), "utf8")),
		redisUnitMemoryMax: redisDropIn.memoryMax,
	};
}

function show(host: Host, unit: string, props: string): ReadonlyMap<string, string> | null {
	const result = host.run(["systemctl", "show", unit, "-p", props, "--timestamp=unix"]);
	if (result === null || result.code !== 0) return null;
	return parseSystemctlShow(result.out);
}

function redisFromHost(host: Host): RedisHost {
	const config = new Map<string, string>();
	for (const key of ["maxmemory", "maxmemory-policy", "save", "appendonly"]) {
		const result = host.run(["redis-cli", "-h", "127.0.0.1", "config", "get", key]);
		if (result === null || result.code !== 0) return { config: null, usedMemoryHuman: null };
		const value = parseRedisConfigGet(key, result.out);
		if (value === null) return { config: null, usedMemoryHuman: null };
		config.set(key, value);
	}
	const info = host.run(["redis-cli", "-h", "127.0.0.1", "info", "memory"]);
	return { config, usedMemoryHuman: info && info.code === 0 ? parseRedisInfoUsed(info.out) : null };
}

/** `grep -q '^NAME=.' file`: 0 set, 1 unset, anything else (or no grep) unreadable. The value stays in grep. */
function envSets(host: Host, file: string, name: string): boolean | null {
	const result = host.run(["grep", "-q", "--", `^${name}=.`, file]);
	if (result === null) return null;
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	return null;
}

export interface DoctorOptions {
	minFreeGb: number;
	maxSwapPagesPerSecond: number;
	envFile: string;
}

/** The deploy floor as `deploy-release.sh` reads it: 0-9999 whole gigabytes, default 5. */
export function minFreeGbFromEnv(env: Record<string, string | undefined>): number {
	const raw = env.SUBSTRATE_DEPLOY_MIN_FREE_GB?.trim();
	if (raw === undefined || raw === "") return DEFAULT_MIN_FREE_GB;
	return /^[0-9]{1,4}$/.test(raw) ? Number(raw) : DEFAULT_MIN_FREE_GB;
}

/** A non-negative number, else the default. */
function nonNegativeOr(raw: string | undefined, fallback: number): number {
	const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function optionsFromEnv(env: Record<string, string | undefined>): DoctorOptions {
	return {
		minFreeGb: minFreeGbFromEnv(env),
		maxSwapPagesPerSecond: nonNegativeOr(env.SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S, DEFAULT_SWAP_PAGES_PER_SECOND),
		envFile: SHARED_ENV_FILE,
	};
}

/** Every check, in class order. The only function that touches the host. */
export async function gatherRows(policy: Policy, host: Host, options: DoctorOptions): Promise<Row[]> {
	const rows: Row[] = [];
	for (const unit of policy.units) rows.push(...compareUnit(unit, show(host, unit.name, SYSTEMCTL_UNIT_PROPS)));
	rows.push(compareSlice(policy.sliceMemoryLow, show(host, SLICE_UNIT, SYSTEMCTL_SLICE_PROPS)));
	rows.push(...compareRedis(policy.redis, policy.redisUnitMemoryMax, redisFromHost(host), show(host, REDIS_UNIT, "LoadState,MemoryMax")));
	for (const timer of EXPECTED_TIMERS) rows.push(compareTimer(timer, show(host, timer.name, SYSTEMCTL_TIMER_PROPS), host.now()));
	const df = host.run(["df", "-Pk", "--", RELEASE_ROOT]);
	rows.push(compareDisk(df === null || df.code !== 0 ? null : parseDfAvailableKb(df.out), options.minFreeGb));
	const before = parseVmstatSwap(host.readText("/proc/vmstat") ?? "");
	await host.sleep(SWAP_SAMPLE_MS);
	const after = parseVmstatSwap(host.readText("/proc/vmstat") ?? "");
	rows.push(compareSwap(before, after, SWAP_SAMPLE_MS, parseMeminfoSwap(host.readText("/proc/meminfo") ?? ""), options.maxSwapPagesPerSecond));
	for (const key of LEGACY_KEYS) rows.push(compareLegacyKey(key, envSets(host, options.envFile, key.name), options.envFile));
	return rows;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function driftClasses(rows: readonly Row[]): CheckClass[] {
	const found = new Set(rows.filter((r) => r.status === "drift").map((r) => r.class));
	return CLASS_ORDER.filter((c) => found.has(c));
}

export function exitCode(rows: readonly Row[]): 0 | 2 {
	return rows.some((r) => r.status === "drift") ? 2 : 0;
}

/** A fixed-width table; the hint column is last so it may run long. */
export function formatTable(rows: readonly Row[]): string {
	const header = ["CHECK", "STATUS", "EXPECTED", "ACTUAL", "HINT"];
	const cells = rows.map((r) => [r.check, r.status, r.expected, r.actual, r.hint]);
	const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
	const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
	const counts = { ok: 0, warn: 0, drift: 0, unknown: 0 };
	for (const r of rows) counts[r.status] += 1;
	const summary = `runtime doctor: ${counts.drift} drift, ${counts.warn} warn, ${counts.unknown} unknown, ${counts.ok} ok`;
	return `${[line(header), ...cells.map(line)].join("\n")}\n${summary}\n`;
}

// ── Emit (one warning per drift class, deduplicated) ─────────────────────────

export interface EmitState {
	/** Per class, the sorted drift check ids last emitted. A class absent here was not in drift. */
	emitted: Record<string, string[]>;
}

export interface EmitEvent {
	surface: "substrate";
	kind: "warning";
	summary: string;
	session_id: string;
	payload: {
		action: "doctor";
		runtime: "doctor";
		class: CheckClass;
		checks: Array<{ check: string; expected: string; actual: string }>;
	};
}

/** The drift set per class: check ids only, so a changing `actual` (free GB, age) does not re-emit the same drift. */
export function driftSets(rows: readonly Row[]): Record<string, string[]> {
	const sets: Record<string, string[]> = {};
	for (const cls of driftClasses(rows)) {
		sets[cls] = rows
			.filter((r) => r.class === cls && r.status === "drift")
			.map((r) => r.check)
			.sort();
	}
	return sets;
}

/** One event per drift class whose set differs from `previous`. Never carries a value from an env file: the rows do not. */
export function eventsToEmit(rows: readonly Row[], previous: EmitState, stampedAt: string): Array<{ cls: CheckClass; event: EmitEvent }> {
	const sets = driftSets(rows);
	const out: Array<{ cls: CheckClass; event: EmitEvent }> = [];
	for (const cls of driftClasses(rows)) {
		const set = sets[cls] ?? [];
		const before = previous.emitted[cls];
		if (before !== undefined && before.length === set.length && before.every((id, i) => id === set[i])) continue;
		const drifted = rows.filter((r) => r.class === cls && r.status === "drift");
		const full = `runtime drift (${cls}): ${drifted.map((r) => r.check).join(", ")}`;
		const summary = full.length <= SUMMARY_MAX ? full : `${full.slice(0, SUMMARY_MAX - 1)}…`;
		out.push({
			cls,
			event: {
				surface: "substrate",
				kind: "warning",
				summary,
				session_id: `doctor:${stampedAt}`,
				payload: {
					action: "doctor",
					runtime: "doctor",
					class: cls,
					checks: drifted.map((r) => ({ check: r.check, expected: r.expected, actual: r.actual })),
				},
			},
		});
	}
	return out;
}

export function readEmitState(text: string | null): EmitState {
	if (text === null) return { emitted: {} };
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "emitted" in parsed && parsed.emitted && typeof parsed.emitted === "object") {
			const emitted: Record<string, string[]> = {};
			for (const [cls, ids] of Object.entries(parsed.emitted as Record<string, unknown>)) {
				if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) emitted[cls] = [...ids];
			}
			return { emitted };
		}
	} catch {
		// A corrupt state file means "nothing emitted yet": one extra event, never a lost one.
	}
	return { emitted: {} };
}

/** POST one event; true on 202. Tests substitute this; the bearer is sent, never printed. */
export type Poster = (url: string, body: EmitEvent, bearer: string) => Promise<boolean>;

export interface EmitIo {
	readState(): string | null;
	writeState(text: string): void;
	post: Poster;
	stderr(text: string): void;
}

/**
 * The bearer the doctor emits with. `SUBSTRATE_TOKEN` first (chaos-smoke's
 * rule), then the shared env's `SUBSTRATE_TOKEN_SUBSTRATE` (what the host
 * jobs are delivered, by that name), then the client resolver's token file
 * and tokens dir for the `substrate` surface. Never logged.
 *
 * The server's variable may list several entries (comma or whitespace, as
 * during a rotation) and any one of them authenticates; the whole list sent
 * as one bearer is refused with 401 and the drift warnings fall silent, so
 * the first non-empty entry is the bearer, as `grok-connector-smoke.ts` does.
 */
export function doctorBearer(env: Record<string, string | undefined>): string | null {
	const listed = env.SUBSTRATE_TOKEN_SUBSTRATE?.split(/[\s,]+/).find((entry) => entry.length > 0);
	return resolveBearer("substrate", { ...env, SUBSTRATE_TOKEN: env.SUBSTRATE_TOKEN?.trim() || listed });
}

/**
 * Emit the changed drift classes and record what was emitted. A class that
 * cleared is dropped from the state so its next drift is emitted again. A
 * failed POST leaves the previous record, so the next run retries it.
 */
export async function emitDrift(
	rows: readonly Row[],
	env: Record<string, string | undefined>,
	io: EmitIo,
	stampedAt = new Date().toISOString(),
): Promise<CheckClass[]> {
	if (env.SUBSTRATE_DOCTOR_EMIT?.trim() !== "1") {
		io.stderr("runtime doctor: --emit ignored, SUBSTRATE_DOCTOR_EMIT is not 1 (set it on the timer's drop-in to emit)\n");
		return [];
	}
	const bearer = doctorBearer(env);
	if (bearer === null) {
		io.stderr("runtime doctor: --emit skipped, no bearer (SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_SUBSTRATE, SUBSTRATE_TOKEN_FILE or SUBSTRATE_TOKENS_DIR)\n");
		return [];
	}
	const base = (env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const previous = readEmitState(io.readState());
	const current = driftSets(rows);
	const next: EmitState = { emitted: {} };
	const emitted: CheckClass[] = [];
	const pending = eventsToEmit(rows, previous, stampedAt);
	for (const cls of Object.keys(current)) {
		const change = pending.find((p) => p.cls === cls);
		if (change === undefined) {
			next.emitted[cls] = previous.emitted[cls] ?? [];
			continue;
		}
		const ok = await io.post(`${base}/events`, change.event, bearer);
		if (ok) {
			next.emitted[cls] = current[cls] ?? [];
			emitted.push(change.cls);
		} else {
			io.stderr(`runtime doctor: emit for ${cls} was not stored; will retry next run\n`);
			const kept = previous.emitted[cls];
			if (kept !== undefined) next.emitted[cls] = kept;
		}
	}
	io.writeState(`${JSON.stringify(next, null, "\t")}\n`);
	return emitted;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface CliOptions {
	json: boolean;
	emit: boolean;
	infraDir: string;
}

export function parseArgs(argv: readonly string[]): CliOptions | { usage: string } {
	const options: CliOptions = { json: false, emit: false, infraDir: join(import.meta.dir, "..", "infra", "vps") };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		if (arg === "--json") options.json = true;
		else if (arg === "--emit") options.emit = true;
		else if (arg === "--infra") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) return { usage: "--infra needs a directory" };
			options.infraDir = value;
			i += 1;
		} else if (arg === "--help" || arg === "-h") return { usage: "" };
		else return { usage: `unknown argument ${arg}` };
	}
	return options;
}

const USAGE = `usage: bun scripts/doctor-runtime.ts [--json] [--emit] [--infra dir]

Compares the host (systemd, redis, df, /proc, the shared env by key NAME) with
the policy declared under infra/vps. Read-only. Exit 0 when nothing drifts,
2 on any drift, 1 on a usage error. --emit posts one warning per drift class
to SUBSTRATE_URL/events when SUBSTRATE_DOCTOR_EMIT=1, deduplicated through
SUBSTRATE_DOCTOR_STATE (default ${DEFAULT_STATE_FILE}).
`;

export const realHost: Host = {
	run(argv) {
		try {
			const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", timeout: SPAWN_TIMEOUT_MS });
			return { code: result.exitCode ?? -1, out: result.stdout.toString() };
		} catch {
			return null;
		}
	},
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	sleep: (ms) => Bun.sleep(ms),
	now: () => Math.floor(Date.now() / 1000),
};

async function postEvent(url: string, body: EmitEvent, bearer: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		await res.text();
		return res.status === 202;
	} catch {
		return false;
	}
}

export async function main(
	argv: readonly string[],
	host: Host = realHost,
	env: Record<string, string | undefined> = process.env,
	io: { stdout(text: string): void; stderr(text: string): void; post: Poster } = {
		stdout: (t) => process.stdout.write(t),
		stderr: (t) => process.stderr.write(t),
		post: postEvent,
	},
): Promise<number> {
	const parsed = parseArgs(argv);
	if ("usage" in parsed) {
		if (parsed.usage === "") {
			io.stdout(USAGE);
			return 0;
		}
		io.stderr(`runtime doctor: ${parsed.usage}\n${USAGE}`);
		return 1;
	}
	const policy = loadPolicy(parsed.infraDir);
	const rows = await gatherRows(policy, host, optionsFromEnv(env));
	let emitted: CheckClass[] = [];
	if (parsed.emit) {
		const stateFile = env.SUBSTRATE_DOCTOR_STATE?.trim() || DEFAULT_STATE_FILE;
		emitted = await emitDrift(rows, env, {
			readState: () => host.readText(stateFile),
			writeState: (text) => {
				try {
					writeFileSync(stateFile, text, { mode: 0o600 });
				} catch {
					// The report stands without the dedupe record; the next run re-emits once more.
					io.stderr(`runtime doctor: could not write ${stateFile}; the next run will emit again\n`);
				}
			},
			post: io.post,
			stderr: io.stderr,
		});
	}
	if (parsed.json) io.stdout(`${JSON.stringify({ rows, drift: driftClasses(rows), emitted }, null, "\t")}\n`);
	else io.stdout(formatTable(rows));
	return exitCode(rows);
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "doctor failed";
		process.stderr.write(`runtime doctor: ${message}\n`);
		process.exit(1);
	}
}
