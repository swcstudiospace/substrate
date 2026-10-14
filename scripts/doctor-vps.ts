/**
 * Runtime-doctor rows for the VPS hardening of uplift-4 S3: scheduling weights
 * against what the kernel will honour, and the disk guardrails. Pure parsers
 * and comparers plus two gatherers that go through the doctor's injected
 * `Host`, so tests feed fixture command output and never read the machine.
 *
 * Everything here is REPORT-ONLY. A row is `ok`, `warn`, `drift` or `unknown`;
 * the disk guardrails never go past `warn` (the doctor exits 0 on `warn`), and
 * a `would-reclaim` row names bytes an operator could free, it frees nothing.
 * Nothing in this file deletes, vacuums, prunes or writes.
 *
 * Imports from `doctor-runtime.ts` are types only: that module imports this one.
 */
import type { Host, Row, Status } from "./doctor-runtime.ts";

// ── Shared small helpers ─────────────────────────────────────────────────────

function row(cls: Row["class"], check: string, status: Status, expected: string, actual: string, hint = ""): Row {
	return { class: cls, check, status, expected, actual, hint };
}

const MIB = 2 ** 20;
const GIB = 2 ** 30;

/** Bytes for a table cell: `2.9 GB`, `26 MB`, `3.9 MB`. Binary units, one decimal under 10. */
export function humanBytes(bytes: number): string {
	if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GB`;
	if (bytes >= MIB) return `${(bytes / MIB).toFixed(bytes >= 10 * MIB ? 0 : 1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

function ageText(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)}s`;
	if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
	if (seconds < 36 * 3600) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86_400).toFixed(1)}d`;
}

/** A directory entry name for a row: printable ASCII only, bounded. Names come from the filesystem. */
export function safeName(name: string): string {
	const printable = name.replace(/[^\x20-\x7e]/g, "?");
	return printable.length <= 64 ? printable : `${printable.slice(0, 63)}…`;
}

// ── Weights: declared against effective, and whether the kernel will honour IOWeight ──

export interface DeclaredWeights {
	cpuWeight: string | null;
	ioWeight: string | null;
}

/** What the host exposes about whether `io.weight` takes effect. Each field is null when unreadable. */
export interface IoEvidence {
	/** `/sys/fs/cgroup/cgroup.controllers`. */
	rootControllers: string | null;
	/** `substrate.slice`'s `io.weight`, else its `io.bfq.weight`; absent when the io controller is not enabled for it. */
	sliceIoWeight: string | null;
	/** `/sys/fs/cgroup/io.cost.qos`; a device line with `enable=1` means io.cost is active. */
	costQos: string | null;
	/** `lsblk -dno NAME,SCHED`: one `<device> <scheduler>` line per disk. */
	schedulers: string | null;
}

export interface IoVerdict {
	status: "ok" | "warn" | "unknown";
	detail: string;
}

/**
 * Whether `IOWeight` can do anything on this host. cgroup v2 `io.weight` is
 * proportional only through BFQ (`io.bfq.weight`) or io.cost (`io.cost.qos`
 * with `enable=1`); under `none` or `mq-deadline` without io.cost the value is
 * accepted and ignored. This reads evidence and says what it found; it does
 * not enable anything.
 */
export function classifyIoWeight(evidence: IoEvidence): IoVerdict {
	if (evidence.rootControllers === null) {
		return { status: "unknown", detail: "cgroup.controllers unreadable (cgroup v1, or /sys hidden); cannot tell whether the io controller exists" };
	}
	if (!evidence.rootControllers.split(/\s+/).includes("io")) {
		return { status: "warn", detail: "the io controller is not available at the cgroup root, so IOWeight has no effect" };
	}
	if (evidence.sliceIoWeight === null) {
		return { status: "warn", detail: "no io.weight in the substrate.slice cgroup: the io controller is not enabled for it, so IOWeight has no effect" };
	}
	const bfq: string[] = [];
	const others: string[] = [];
	for (const line of (evidence.schedulers ?? "").split("\n")) {
		const [device, scheduler] = line.trim().split(/\s+/);
		if (!device) continue;
		if (scheduler === "bfq") bfq.push(device);
		else others.push(`${device}=${scheduler ?? "none"}`);
	}
	const costOn = /\benable=1\b/.test(evidence.costQos ?? "");
	if (costOn) return { status: "ok", detail: "io controller enabled for the slice and io.cost is enabled" };
	if (bfq.length > 0) return { status: "ok", detail: `io controller enabled for the slice and BFQ is the scheduler on ${bfq.join(",")}` };
	if (evidence.schedulers === null && evidence.costQos === null) {
		return { status: "unknown", detail: "io controller is enabled for the slice, but neither the block schedulers nor io.cost.qos could be read" };
	}
	return {
		status: "warn",
		detail: `io controller is enabled for the slice, but the scheduler is not BFQ (${others.join(" ") || "none found"}) and io.cost is off: the weight is accepted and not enforced`,
	};
}

/**
 * `CPUWeight` and `IOWeight` of `substrate.slice` against `systemctl show`
 * (`[not set]` when the installed slice predates them). A value that differs is
 * drift. An `IOWeight` that matches but cannot be honoured is a `warn`, saying
 * so: the doctor reports the setting, it does not claim the setting works.
 */
export function compareSliceWeights(
	declared: DeclaredWeights,
	shown: ReadonlyMap<string, string> | null,
	evidence: IoEvidence,
): Row[] {
	const rows: Row[] = [];
	if (shown === null) return rows;
	if ((shown.get("LoadState") ?? "") !== "loaded") return rows;
	const hint = "installed slice file differs; reinstall infra/vps/substrate.slice and daemon-reload (README: Resource ceilings)";
	if (declared.cpuWeight !== null) {
		const got = (shown.get("CPUWeight") ?? "").trim();
		rows.push(
			got === declared.cpuWeight
				? row("slice", "substrate.slice CPUWeight", "ok", `CPUWeight=${declared.cpuWeight}`, "as declared")
				: row("slice", "substrate.slice CPUWeight", "drift", `CPUWeight=${declared.cpuWeight}`, `CPUWeight=${got || "n/a"}`, hint),
		);
	}
	if (declared.ioWeight !== null) {
		const got = (shown.get("IOWeight") ?? "").trim();
		const check = "substrate.slice IOWeight";
		const want = `IOWeight=${declared.ioWeight}`;
		if (got !== declared.ioWeight) {
			rows.push(row("slice", check, "drift", want, `IOWeight=${got || "n/a"}`, hint));
		} else {
			const verdict = classifyIoWeight(evidence);
			rows.push(
				verdict.status === "ok"
					? row("slice", check, "ok", want, "as declared, and enforceable", verdict.detail)
					: row("slice", check, verdict.status, want, `as declared, ${verdict.status === "warn" ? "NOT enforced" : "enforcement unknown"}`, `informational: ${verdict.detail}`),
			);
		}
	}
	return rows;
}

/** The kernel-side evidence, read through the doctor's host. No command is run for the cgroup files. */
export function gatherIoEvidence(host: Host): IoEvidence {
	const lsblk = host.run(["lsblk", "-dno", "NAME,SCHED"]);
	return {
		rootControllers: host.readText("/sys/fs/cgroup/cgroup.controllers"),
		sliceIoWeight: host.readText("/sys/fs/cgroup/substrate.slice/io.weight") ?? host.readText("/sys/fs/cgroup/substrate.slice/io.bfq.weight"),
		costQos: host.readText("/sys/fs/cgroup/io.cost.qos"),
		schedulers: lsblk !== null && lsblk.code === 0 ? lsblk.out : null,
	};
}

// ── Disk guardrails ──────────────────────────────────────────────────────────

/** Measured 2026-10-13: current + previous release together 2.9 GB (one `du` call; see below). Twice that, rounded up. */
export const DEFAULT_RELEASE_MAX_GB = 6;
/** Measured 2026-10-13: /var/lib/substrate 350 MB (rivetkit 318 MB, audit 3.9 MB). About three times that. */
export const DEFAULT_STATE_MAX_GB = 1;
/** The `SystemMaxUse=` of `infra/vps/journald-substrate.conf`; the journal was 329.6 MB. */
export const DEFAULT_JOURNAL_MAX_MB = 400;
export const DEFAULT_STATE_DIR = "/var/lib/substrate";
/** A `phase<N>-baseline` directory is a reclaim candidate only once nothing inside it is newer than this. */
export const STALE_STATE_DAYS = 30;
/** Largest per-child rows shown; the rest are summed into one row. */
const STATE_CHILD_ROWS = 8;
/** Releases and state children passed to one `du`; a directory with more is cut and says so. */
const MAX_DU_PATHS = 64;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface DiskGuardrails {
	releaseRoot: string;
	stateDir: string;
	/** 0 disables the compare (the rows still report). */
	releaseMaxBytes: number;
	stateMaxBytes: number;
	journalMaxBytes: number;
}

/** A non-negative number, else the default. Each variable names one number: no lists. */
function nonNegativeOr(raw: string | undefined, fallback: number): number {
	const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** `SUBSTRATE_RETAIN_RELEASE_MAX_GB`, `SUBSTRATE_STATE_MAX_GB`, `SUBSTRATE_JOURNAL_MAX_MB`. */
export function diskGuardrailsFromEnv(env: Record<string, string | undefined>, releaseRoot: string): DiskGuardrails {
	return {
		releaseRoot,
		stateDir: DEFAULT_STATE_DIR,
		releaseMaxBytes: Math.round(nonNegativeOr(env.SUBSTRATE_RETAIN_RELEASE_MAX_GB, DEFAULT_RELEASE_MAX_GB) * GIB),
		stateMaxBytes: Math.round(nonNegativeOr(env.SUBSTRATE_STATE_MAX_GB, DEFAULT_STATE_MAX_GB) * GIB),
		journalMaxBytes: Math.round(nonNegativeOr(env.SUBSTRATE_JOURNAL_MAX_MB, DEFAULT_JOURNAL_MAX_MB) * MIB),
	};
}

export interface DuEntry {
	path: string;
	bytes: number;
}

/** `du -s --block-size=1` output: `<bytes>\t<path>` per argument, in argument order. */
export function parseDu(out: string): DuEntry[] {
	const entries: DuEntry[] = [];
	for (const line of out.split("\n")) {
		const m = /^(\d{1,15})\t(.+)$/.exec(line);
		if (m?.[1] && m[2]) entries.push({ path: m[2], bytes: Number(m[1]) });
	}
	return entries;
}

/** `releases/<sha>` or a bare `<sha>` path to its sha, else null. */
function shaOf(path: string): string | null {
	const base = path.split("/").filter(Boolean).pop() ?? "";
	return SHA.test(base) ? base : null;
}

export interface ReleaseUsage {
	/** The sha `current` points at, or null when the symlink is absent or unreadable. */
	current: string | null;
	previous: string | null;
	/** Unique bytes per release in `du`'s argument order: current, previous, then newest first. */
	entries: DuEntry[];
	/** Releases listed but absent from the total: past the du path cap, or unreadable. Absent means 0. */
	notMeasured?: number;
}

/**
 * Release trees share one hardlinked `node_modules`, so a `du` per release
 * charges each of them the whole thing (the lane report's "2.9 G previous
 * against 38 M current" was exactly that). One `du` over every release counts
 * an inode the first time it sees it, so listing current first and the rest
 * newest first attributes to each release only the bytes the earlier ones do
 * not already hold. The total is the real footprint; a release's number is what
 * deleting it (and everything older) would free.
 */
export function compareReleases(usage: ReleaseUsage, budgetBytes: number, releasesDir: string): Row[] {
	const check = `releases unique bytes ${releasesDir}`;
	const budget = budgetBytes === 0 ? "budget disabled (0)" : `≤ ${humanBytes(budgetBytes)} unique (SUBSTRATE_RETAIN_RELEASE_MAX_GB)`;
	if (usage.entries.length === 0) {
		return [row("disk", check, "unknown", budget, "n/a", `no release trees read under ${releasesDir}; ls or du failed or the directory is empty`)];
	}
	const total = usage.entries.reduce((sum, e) => sum + e.bytes, 0);
	const notMeasured = usage.notMeasured ?? 0;
	const over = budgetBytes > 0 && total > budgetBytes;
	// A total that leaves releases out is a floor: over budget is still a proven breach (warn),
	// otherwise the verdict is unknown, never ok.
	const status: Status = over ? "warn" : notMeasured > 0 ? "unknown" : "ok";
	const partial = notMeasured > 0 ? `; ${notMeasured} more not measured (oldest releases; total is a lower bound)` : "";
	const label = (entry: DuEntry): string => {
		const sha = shaOf(entry.path) ?? safeName(entry.path);
		const role = sha === usage.current ? " current" : sha === usage.previous ? " previous" : "";
		return `${sha.slice(0, 8)}${role} ${humanBytes(entry.bytes)}`;
	};
	const rows = [
		row(
			"disk",
			check,
			status,
			budget,
			`${humanBytes(total)} over ${usage.entries.length} release(s): ${usage.entries.map(label).join(", ")}${partial}`,
			"hardlinks counted once (one du call: current, previous, then newest first); a release is charged only the bytes the ones before it do not share. Report only",
		),
	];
	if (usage.current === null && usage.previous === null) return rows;
	for (const entry of usage.entries) {
		const sha = shaOf(entry.path);
		if (sha === null || sha === usage.current || sha === usage.previous) continue;
		rows.push(
			row(
				"disk",
				`would-reclaim release ${sha.slice(0, 12)}`,
				over ? "warn" : "ok",
				"removed by a redeploy of the current tag and by a deploy of a new tag",
				`${humanBytes(entry.bytes)} unique`,
				"nothing was deleted; infra/vps/deploy-release.sh --dry-run lists this set, and the present previous that a new-tag deploy would also remove",
			),
		);
	}
	return rows;
}

/** Who owns a child of the state directory, as far as this repo's code and runbooks say. */
interface StateOwner {
	owner: string;
	/** True when the entry must never be proposed for reclaim: live state, or an owner nobody named. */
	keep: boolean;
}

/**
 * Every path the code base writes under /var/lib/substrate (`StateDirectory=substrate` in each unit),
 * by the unit or module that owns it. Each is live state: never offered for reclaim, whatever its age.
 * A directory's own mtime says nothing about files inside it, so a name here is protected outright.
 */
const LIVE_STATE: Record<string, string> = {
	"agentos": "substrate-host rivetkit storage (RIVETKIT_STORAGE_PATH): stop the unit, decide per task record",
	"desktop": "desktop_run screenshots (SUBSTRATE_DESKTOP_DIR): remove a run only with its owner",
	"skills": "skills proposal and projector state (SUBSTRATE_SKILLS_STATE, refresh-pending.json, projector-warned.json)",
	"dispatcher": "substrate-dispatcher launcher state (SUBSTRATE_STATE_DIR)",
	"worktrees": "dispatcher task worktrees, one per graph id",
	"transcripts": "cursor transcript copies written by the collectors",
	"miner": "substrate_miner bridge log and held state",
	"muse-plugin": "muse collector plugin state",
	"docs-ingest.json": "docs_ingest records and dataset pins (SUBSTRATE_DOCS_STATE_FILE)",
	"docs-canary-last.json": "docs golden canary dedupe record (SUBSTRATE_DOCS_CANARY_STATE)",
	"slo-checkpoint.json": "SLO checkpoint (SUBSTRATE_SLO_CHECKPOINT)",
	"retain-outbox.jsonl": "Hindsight retain outbox (SUBSTRATE_RETAIN_OUTBOX_PATH)",
	"refused-emits.jsonl": "collector refused-emit log (emit.ts)",
	"doctor-last.json": "runtime doctor dedupe record (SUBSTRATE_DOCTOR_STATE)",
	"ledger-archive": "ledger archive output (SUBSTRATE_LEDGER_ARCHIVE_DIR)",
	"index-archive": "index archive output (SUBSTRATE_INDEX_ARCHIVE_DIR)",
};

/** Stale rehearsal baseline snapshots: the only name class ever offered for reclaim. */
const BASELINE_DIR = /^phase\d{1,3}-baseline$/;

/**
 * Owner of a state child. Conservative by construction: only a `phase<N>-baseline` directory is ever
 * a reclaim candidate. Known live names (and their `.tmp`/rotated siblings, `*-offsets.json`, the audit
 * chain) are protected, and every other name is `unknown owner`, reported and never proposed.
 */
export function stateOwner(name: string, type: string): StateOwner {
	if (name.startsWith("mcp-audit")) return { owner: "audit chain: never reclaimed (docs/mcp-audit.md)", keep: true };
	if (type === "f" && name.endsWith("-offsets.json")) return { owner: "collector offsets: live state, never reclaimed", keep: true };
	for (const [live, owner] of Object.entries(LIVE_STATE)) {
		if (name === live || (type === "f" && name.startsWith(`${live}.`))) return { owner: `${owner}: live, never reclaimed`, keep: true };
	}
	if (type === "d" && BASELINE_DIR.test(name)) return { owner: "stale rehearsal baseline snapshot: reclaim candidate once nothing inside it is recent", keep: false };
	return { owner: "unknown owner: not named by any unit or runbook; never proposed for reclaim", keep: true };
}

export interface StateChild {
	name: string;
	type: string;
	bytes: number;
	/** Epoch seconds of the newest mtime of the entry and, for a directory, of what is inside it; null when unknown. */
	mtime: number | null;
	/** True when the nested scan hit its entry cap: the age is a floor, so the entry is never reclaimable. */
	ageCut?: boolean;
}

/**
 * The state directory against `SUBSTRATE_STATE_MAX_GB`, its largest children
 * with age (the entry's own mtime: a directory's is the last time something was
 * added or removed directly in it), and, only when over budget, `would-reclaim`
 * rows for children no runbook owner claims that are at least STALE_STATE_DAYS
 * old, largest first, until the total would fit. None of it is deleted.
 */
export function compareState(children: readonly StateChild[], budgetBytes: number, nowSeconds: number, stateDir: string, notMeasured = 0): Row[] {
	const check = `state ${stateDir}`;
	const budget = budgetBytes === 0 ? "budget disabled (0)" : `≤ ${humanBytes(budgetBytes)} (SUBSTRATE_STATE_MAX_GB)`;
	if (children.length === 0) return [row("disk", check, "unknown", budget, "n/a", `no children read under ${stateDir}; find or du failed or the directory is empty`)];
	const total = children.reduce((sum, c) => sum + c.bytes, 0);
	const over = budgetBytes > 0 && total > budgetBytes;
	const age = (c: StateChild): string => (c.mtime === null ? "age n/a" : c.ageCut ? `age n/a (newest seen ${ageText(Math.max(0, nowSeconds - c.mtime))} old, scan cut)` : `${ageText(Math.max(0, nowSeconds - c.mtime))} old`);
	const bySize = [...children].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	// A total that leaves entries out is a floor. Over budget it is still a proven breach (warn);
	// otherwise the verdict is unknown, never ok.
	const status: Status = over ? "warn" : notMeasured > 0 ? "unknown" : "ok";
	const partial = notMeasured > 0 ? `; ${notMeasured} more not measured (total is a lower bound)` : "";
	const rows = [row("disk", check, status, budget, `${humanBytes(total)} over ${children.length} entries${partial}`, "report only; the audit chain is never reclaimed")];
	for (const c of bySize.slice(0, STATE_CHILD_ROWS)) {
		const owner = stateOwner(c.name, c.type);
		rows.push(row("disk", `state child ${safeName(c.name)}`, "ok", "report only", `${humanBytes(c.bytes)}, ${age(c)}`, owner.owner));
	}
	const rest = bySize.slice(STATE_CHILD_ROWS);
	if (rest.length > 0) {
		rows.push(row("disk", "state child (others)", "ok", "report only", `${humanBytes(rest.reduce((s, c) => s + c.bytes, 0))} over ${rest.length} more entries`, ""));
	}
	if (over) {
		let remaining = total - budgetBytes;
		for (const c of bySize) {
			if (remaining <= 0) break;
			if (stateOwner(c.name, c.type).keep || c.ageCut) continue;
			if (c.mtime === null || nowSeconds - c.mtime < STALE_STATE_DAYS * 86_400) continue;
			remaining -= c.bytes;
			rows.push(
				row("disk", `would-reclaim state ${safeName(c.name)}`, "warn", "operator decision", `${humanBytes(c.bytes)}, ${age(c)}`, "a stale baseline snapshot with nothing recent inside it (30 days); nothing was deleted"),
			);
		}
	}
	return rows;
}

/** `journalctl --disk-usage`: `Archived and active journals take up 329.6M in the file system.` */
export function parseJournalUsage(out: string): number | null {
	const m = /take up ([0-9.]+)([KMGT]?)(?:i?B)?\b/.exec(out);
	if (!m?.[1]) return null;
	const shift = { "": 0, K: 10, M: 20, G: 30, T: 40 }[m[2] ?? ""] ?? 0;
	return Math.round(Number(m[1]) * 2 ** shift);
}

/** The journal against `SUBSTRATE_JOURNAL_MAX_MB`. Over budget prints the vacuum an operator could run; it runs nothing. */
export function compareJournal(bytes: number | null, budgetBytes: number): Row[] {
	const check = "journal size";
	const budget = budgetBytes === 0 ? "budget disabled (0)" : `≤ ${humanBytes(budgetBytes)} (SUBSTRATE_JOURNAL_MAX_MB)`;
	if (bytes === null) return [row("disk", check, "unknown", budget, "n/a", "journalctl --disk-usage failed or printed nothing parseable")];
	const over = budgetBytes > 0 && bytes > budgetBytes;
	const rows = [
		row("disk", check, over ? "warn" : "ok", budget, humanBytes(bytes), "infra/vps/journald-substrate.conf (SystemMaxUse=400M) is the standing cap; it is an operator-installed drop-in"),
	];
	if (over) {
		rows.push(
			row(
				"disk",
				"would-reclaim journal",
				"warn",
				"operator decision",
				`${humanBytes(bytes - budgetBytes)} to reach the budget`,
				`journalctl --vacuum-size=${Math.max(1, Math.floor(budgetBytes / MIB))}M would do it; nothing was run`,
			),
		);
	}
	return rows;
}

/** One `stat -c '%W<TAB>%s<TAB>%n'` line per audit file: birth epoch (0 when unknown), bytes, path. */
export interface AuditFile {
	birth: number;
	bytes: number;
}

export function parseAuditStat(out: string): AuditFile[] {
	const files: AuditFile[] = [];
	for (const line of out.split("\n")) {
		const m = /^(\d{1,12})\t(\d{1,15})\t.+$/.exec(line);
		if (m?.[1] && m[2]) files.push({ birth: Number(m[1]), bytes: Number(m[2]) });
	}
	return files;
}

/**
 * The audit chain's size and its average growth per day since the oldest file
 * was created. The chain is never pruned (`docs/mcp-audit.md`), so this row is
 * `ok` whatever it says: it is the number an operator sizes the next volume by.
 */
export function compareAudit(files: readonly AuditFile[], nowSeconds: number): Row {
	const check = "audit chain size";
	if (files.length === 0) return row("disk", check, "unknown", "report only", "n/a", "no mcp-audit* files under the state directory, or stat failed");
	const total = files.reduce((sum, f) => sum + f.bytes, 0);
	const births = files.map((f) => f.birth).filter((b) => b > 0);
	const oldest = births.length === 0 ? null : Math.min(...births);
	const days = oldest === null ? 0 : (nowSeconds - oldest) / 86_400;
	const growth =
		oldest === null || days < 1 / 24
			? "daily growth n/a (file birth time unknown or under an hour old)"
			: `≈ ${humanBytes(total / days)}/day average over ${days.toFixed(1)} d since the oldest file was created`;
	return row("disk", check, "ok", "report only; never pruned", `${humanBytes(total)} in ${files.length} file(s), ${growth}`, "docs/runbooks/disk-pressure.md: move segments to larger storage with the service stopped, never delete");
}

function runOut(host: Host, argv: readonly string[]): string | null {
	const result = host.run(argv);
	// du and find exit non-zero when one entry is unreadable and still print the rest.
	return result === null || (result.code !== 0 && result.out === "") ? null : result.out;
}

function releaseUsage(host: Host, root: string): ReleaseUsage {
	const releasesDir = `${root}/releases`;
	const link = (name: string): string | null => shaOf(runOut(host, ["readlink", "--", `${root}/${name}`])?.trim() ?? "");
	const current = link("current");
	const previous = link("previous");
	const listing = runOut(host, ["ls", "-1t", "--", releasesDir]);
	if (listing === null) return { current, previous, entries: [] };
	// `ls -t` is newest first. Current, then previous, then the rest in that order: the
	// order `du` charges shared inodes in. A cut at MAX_DU_PATHS therefore keeps the
	// newest releases and drops the oldest.
	const names = listing.split("\n").filter((n) => SHA.test(n));
	const ordered = [...new Set([...(current ? [current] : []), ...(previous ? [previous] : []), ...names])].filter((n) => names.includes(n));
	const paths = ordered.slice(0, MAX_DU_PATHS).map((n) => `${releasesDir}/${n}`);
	if (paths.length === 0) return { current, previous, entries: [] };
	const du = runOut(host, ["du", "-s", "--block-size=1", "--", ...paths]);
	const entries = du === null ? [] : parseDu(du);
	// Cut by the cap and entries du could not read both count: neither is in the total.
	return { current, previous, entries, notMeasured: ordered.length - entries.length };
}

/** Depth and entry bounds of the nested mtime scan of one state directory. */
export const NESTED_SCAN_DEPTH = 2;
export const NESTED_SCAN_ENTRIES = 200;

/**
 * Newest mtime (epoch seconds) of a directory and what is inside it, to depth NESTED_SCAN_DEPTH. Only the
 * first NESTED_SCAN_ENTRIES lines are read; more than that sets `cut`, and the caller then treats the age
 * as unprovable. A directory's own mtime changes only when an entry directly in it is added or removed,
 * so it can stay old while files inside are written every minute.
 */
export function nestedNewest(host: Host, dir: string, ownMtime: number | null): { mtime: number | null; cut: boolean } {
	const out = runOut(host, ["find", dir, "-maxdepth", String(NESTED_SCAN_DEPTH), "-printf", "%T@\\n"]);
	if (out === null) return { mtime: ownMtime, cut: false };
	const lines = out.split("\n").filter((line) => line !== "");
	let newest = ownMtime;
	for (const line of lines.slice(0, NESTED_SCAN_ENTRIES)) {
		const seconds = /^\d{1,12}(?:\.\d+)?$/.test(line) ? Number(line) : Number.NaN;
		if (Number.isFinite(seconds) && (newest === null || seconds > newest)) newest = seconds;
	}
	return { mtime: newest, cut: lines.length > NESTED_SCAN_ENTRIES };
}

function stateChildren(host: Host, stateDir: string): { children: StateChild[]; auditPaths: string[]; notMeasured: number } {
	const found = runOut(host, ["find", stateDir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%p\\t%T@\\t%y\\n"]);
	if (found === null) return { children: [], auditPaths: [], notMeasured: 0 };
	const listed: Array<{ path: string; type: string; mtime: number | null }> = [];
	for (const line of found.split("\n")) {
		const [path, mtime, type] = line.split("\t");
		if (!path || !type) continue;
		const seconds = Number(mtime);
		listed.push({ path, type, mtime: Number.isFinite(seconds) ? seconds : null });
	}
	// `find` prints in directory order. The cut must not depend on it: newest first, then by path.
	const ranked = [...listed].sort((a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || a.path.localeCompare(b.path));
	const slice = ranked.slice(0, MAX_DU_PATHS);
	const du = slice.length === 0 ? null : runOut(host, ["du", "-s", "--block-size=1", "--", ...slice.map((e) => e.path)]);
	const bytes = new Map((du === null ? [] : parseDu(du)).map((e) => [e.path, e.bytes]));
	const children = slice.flatMap((e) => {
		const size = bytes.get(e.path);
		if (size === undefined) return [];
		const nested = e.type === "d" ? nestedNewest(host, e.path, e.mtime) : { mtime: e.mtime, cut: false };
		return [{ name: e.path.slice(stateDir.length).replace(/^\/+/, ""), type: e.type, bytes: size, mtime: nested.mtime, ...(nested.cut ? { ageCut: true } : {}) }];
	});
	return {
		children,
		auditPaths: listed.filter((e) => e.path.slice(stateDir.length).replace(/^\/+/, "").startsWith("mcp-audit")).map((e) => e.path),
		notMeasured: listed.length - children.length,
	};
}

/**
 * Release, state, journal and audit-chain rows. Every command is a fixed argv
 * through the doctor's host; a command that is missing or fails makes its rows
 * `unknown`, never a drift. Report-only: no row here can fail the run.
 */
export function gatherDiskGuardrails(host: Host, g: DiskGuardrails): Row[] {
	const rows: Row[] = [];
	rows.push(...compareReleases(releaseUsage(host, g.releaseRoot), g.releaseMaxBytes, `${g.releaseRoot}/releases`));
	const { children, auditPaths, notMeasured } = stateChildren(host, g.stateDir);
	rows.push(...compareState(children, g.stateMaxBytes, host.now(), g.stateDir, notMeasured));
	const journal = runOut(host, ["journalctl", "--disk-usage"]);
	rows.push(...compareJournal(journal === null ? null : parseJournalUsage(journal), g.journalMaxBytes));
	const stat = auditPaths.length === 0 ? null : runOut(host, ["stat", "-c", "%W\t%s\t%n", "--", ...auditPaths]);
	rows.push(compareAudit(stat === null ? [] : parseAuditStat(stat), host.now()));
	return rows;
}
