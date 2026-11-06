/**
 * Read-only Hindsight inventory (uplift-4 S5): what the deployment holds,
 * measured against what `HINDSIGHT_BANKS` says it should.
 *
 * Under `SUBSTRATE_HINDSIGHT_INVENTORY=on` a probe lists the banks (bounded
 * pages, at most 200), then reads stats and config for the CONFIGURED banks
 * only (at most 16, two GETs each). It exports, per configured bank, the
 * fact count, the operation backlog and the age of the last write, and
 * reports drift by name: configured banks the deployment lacks, `sub-*` banks
 * it has that nobody configured, and configured banks whose retain extraction
 * mode is not `chunks`. NOTHING is written to Hindsight, here or by anything
 * this module calls.
 *
 * Bounds: a bank label is only ever a name from the configured list, never a
 * string the plane sent; names that do reach the drift report are reduced to
 * `[A-Za-z0-9._:-]` and 64 characters, at most 20 per list; the probe is
 * single-flight, memoised for 60 s, and carries one deadline that sits inside
 * the breaker-gated calls (a timeout is a plane failure). With the flag off
 * nothing here makes a call and no timer exists.
 *
 * The retain outbox gauges are not here: they read in-process state and are
 * always on (`service.ts`, `SubstrateInstruments.setHindsightOutbox`).
 */
import { bankConfig, bankStats, listBanks, type FetchLike, type HindsightBankSummary, type HindsightConfig, type HindsightErrorKind } from "./planes/hindsight.ts";
import { SYSTEM_TIMERS, withDeadline, type TimerHandle, type TimerSeam } from "./recall-snapshot.ts";

const DEFAULT_INVENTORY_INTERVAL_S = 60;
const MIN_INVENTORY_INTERVAL_S = 30;
const MAX_INVENTORY_INTERVAL_S = 3600;
/** Per-bank calls only for this many configured banks. */
export const MAX_INVENTORY_BANKS = 16;
/** Names per drift list. */
export const MAX_DRIFT_NAMES = 20;
const MAX_NAME_CHARS = 64;
/** One probe's deadline, shared by every call in it. */
const INVENTORY_BUDGET_MS = 10_000;
/** A probe younger than this is served again instead of repeated. */
export const INVENTORY_MEMO_MS = 60_000;
const STOP_WAIT_MS = 2000;

export const GAUGE_BANK_FACTS = "substrate.hindsight.bank.facts";
export const GAUGE_BANK_PENDING = "substrate.hindsight.bank.pending_operations";
export const GAUGE_BANK_FAILED = "substrate.hindsight.bank.failed_operations";
export const GAUGE_BANK_LAST_WRITE_AGE = "substrate.hindsight.bank.last_write_age_seconds";

/** `SUBSTRATE_HINDSIGHT_INVENTORY*` as the service reads them. */
export interface InventoryConfig {
	/** `SUBSTRATE_HINDSIGHT_INVENTORY=on`; default off. */
	enabled: boolean;
	/** `SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S`, default 60, floor 30. */
	intervalS: number;
	/** What loading rejected or clamped, for the boot warning. */
	warnings: string[];
}

function quoted(raw: string): string {
	return JSON.stringify(raw.length > 40 ? `${raw.slice(0, 37)}...` : raw);
}

/** Read the inventory settings. Never throws: an unknown flag is off, a bad interval falls back or clamps, each reported once at boot. */
export function loadInventoryConfig(env: Record<string, string | undefined>): InventoryConfig {
	const warnings: string[] = [];
	const flag = (env.SUBSTRATE_HINDSIGHT_INVENTORY?.trim() ?? "").toLowerCase();
	if (flag !== "" && flag !== "on" && flag !== "off") {
		warnings.push(`SUBSTRATE_HINDSIGHT_INVENTORY=${quoted(flag)} is neither on nor off, so the inventory stays off`);
	}
	let intervalS = DEFAULT_INVENTORY_INTERVAL_S;
	const raw = env.SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S?.trim() ?? "";
	if (raw !== "") {
		const value = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isFinite(value)) {
			warnings.push(`SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S=${quoted(raw)} is not a whole number, so ${DEFAULT_INVENTORY_INTERVAL_S} is used`);
		} else {
			intervalS = Math.min(MAX_INVENTORY_INTERVAL_S, Math.max(MIN_INVENTORY_INTERVAL_S, value));
			if (intervalS !== value) {
				warnings.push(`SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S=${quoted(raw)} is outside ${MIN_INVENTORY_INTERVAL_S}..${MAX_INVENTORY_INTERVAL_S}, so ${intervalS} is used`);
			}
		}
	}
	return { enabled: flag === "on", intervalS, warnings };
}

/** The boot warnings for a loaded inventory config, in the shape `index.ts` prints. */
export function hindsightInventoryConfigWarnings(config: { hindsightInventory: InventoryConfig }): string[] {
	return config.hindsightInventory.warnings;
}

/** A plane name made safe to print: only `[A-Za-z0-9._:-]` survives, the rest becomes `?`, 64 characters at most. */
export function safeBankName(name: string): string {
	return name.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, MAX_NAME_CHARS);
}

/** One configured bank as the probe found it. Numbers are null when the plane did not say. */
interface InventoryBank {
	/** A name from the configured list, never from the plane. */
	bank: string;
	/** The deployment lists it. */
	/** `null`: the listing was cut before this bank and a direct read did not settle it. Never counted as missing. */
	present: boolean | null;
	facts: number | null;
	pendingOperations: number | null;
	failedOperations: number | null;
	/** Epoch ms of the last write the plane reported; the gauge ages it at read time. */
	lastWriteMs: number | null;
	extractionMode: string | null;
	/** The plane error kind of a failed per-bank call, or `skipped`; null when both calls answered. */
	error: string | null;
}

interface InventoryDrift {
	/** Configured banks the deployment does not list. */
	missing: string[];
	/** `sub-*` banks the deployment lists that are not configured. */
	unconfigured: string[];
	/** Configured banks whose retain extraction mode is known and is not `chunks`. */
	notChunks: string[];
	/** Names left out because a list reached its bound. */
	more: number;
}

export interface InventoryReport {
	/** Epoch ms the probe started. */
	at: number;
	/** The bank listing answered. */
	ok: boolean;
	/** The plane error kind (or `circuit-open`, `unconfigured`) when `ok` is false; a fixed vocabulary, never plane text. */
	reason: string | null;
	upstreamBanks: number;
	/** The deployment holds more banks than the 200 the probe reads. */
	truncated: boolean;
	banks: InventoryBank[];
	drift: InventoryDrift;
}

/** What `/healthz.hindsight` carries; absent when the inventory is off. */
export interface InventoryHealth {
	checkedAt: string | null;
	ok: boolean | null;
	reason: string | null;
	upstreamBanks: number | null;
	truncated: boolean;
	banks: Array<{
		bank: string;
		present: boolean | null;
		facts: number | null;
		pendingOperations: number | null;
		failedOperations: number | null;
		lastWriteAgeSeconds: number | null;
		extractionMode: string | null;
		error: string | null;
	}>;
	drift: InventoryDrift;
}

/** One gauge point; `bank` is the only label and is always a configured name. */
export interface BankGaugeSample {
	name: string;
	unit: string;
	description: string;
	attributes: { bank: string };
	value: number;
}

const EMPTY_DRIFT: InventoryDrift = { missing: [], unconfigured: [], notChunks: [], more: 0 };

/** The configured banks the inventory reads: the `HINDSIGHT_BANKS` list, deduplicated, at most 16. */
export function resolveInventoryBanks(configured: readonly string[] | null | undefined): string[] {
	return [...new Set(configured ?? [])].slice(0, MAX_INVENTORY_BANKS);
}

export interface HindsightInventoryDeps {
	config: Pick<InventoryConfig, "enabled" | "intervalS">;
	/** The plane's config, or null when it has none (or this is a guest). */
	hindsight: () => HindsightConfig | null;
	/** The configured bank list (`HINDSIGHT_BANKS`), or null. */
	banks: () => readonly string[] | null;
	/** The gated fetch every call goes through. */
	fetchImpl: FetchLike;
	/** True while the plane's breaker refuses calls. */
	breakerOpen: () => boolean;
	now?: () => number;
	timers?: TimerSeam;
	budgetMs?: number;
	memoMs?: number;
}

function dedupeBounded(names: readonly string[]): { kept: string[]; more: number } {
	const unique = [...new Set(names)];
	return { kept: unique.slice(0, MAX_DRIFT_NAMES), more: Math.max(0, unique.length - MAX_DRIFT_NAMES) };
}

/** Kinds that say the plane itself is unwell: the probe stops asking rather than send more. */
const HALTING_KINDS: Readonly<Partial<Record<HindsightErrorKind, true>>> = { network: true, timeout: true, server: true, "rate-limit": true };

export class HindsightInventory {
	private readonly now: () => number;
	private readonly timers: TimerSeam;
	private readonly budgetMs: number;
	private readonly memoMs: number;
	private report: InventoryReport | null = null;
	private flight: Promise<InventoryReport | null> | null = null;
	private interval: TimerHandle | null = null;
	private stopped = false;

	constructor(private readonly deps: HindsightInventoryDeps) {
		this.now = deps.now ?? Date.now;
		this.timers = deps.timers ?? SYSTEM_TIMERS;
		this.budgetMs = deps.budgetMs ?? INVENTORY_BUDGET_MS;
		this.memoMs = deps.memoMs ?? INVENTORY_MEMO_MS;
	}

	get enabled(): boolean {
		return this.deps.config.enabled;
	}

	/** The newest probe, or null before the first (or when off). Never makes a call. */
	last(): InventoryReport | null {
		return this.report;
	}

	/**
	 * Probe now, or serve the memoised probe while it is under a minute old.
	 * Single-flight: a call while a probe runs joins it. `force` skips the memo
	 * (the timer's). Off: null, no call. Never rejects.
	 */
	refresh(options: { force?: boolean } = {}): Promise<InventoryReport | null> {
		if (!this.deps.config.enabled) return Promise.resolve(null);
		if (this.flight !== null) return this.flight;
		if (options.force !== true && this.report !== null && this.now() - this.report.at < this.memoMs) return Promise.resolve(this.report);
		const flight: Promise<InventoryReport | null> = this.probe()
			.then((report) => {
				this.report = report;
				return report;
			})
			.catch(() => this.report)
			.finally(() => {
				if (this.flight === flight) this.flight = null;
			});
		this.flight = flight;
		return flight;
	}

	/** Start the interval (and one probe now). False when off or already running. The timer is unref'd. */
	start(): boolean {
		if (!this.deps.config.enabled || this.interval !== null) return false;
		this.stopped = false;
		this.interval = this.timers.setInterval(() => {
			if (!this.stopped) void this.refresh({ force: true });
		}, this.deps.config.intervalS * 1000);
		this.interval.unref?.();
		void this.refresh({ force: true });
		return true;
	}

	/** Clear the interval and wait (bounded) for the probe in flight. No final probe. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.interval !== null) {
			this.timers.clearInterval(this.interval);
			this.interval = null;
		}
		const flight = this.flight;
		// The flight never rejects (refresh's catch answers the last report), so only the stop deadline can reject here, and that bounded wait is the design.
		if (flight !== null) await withDeadline(flight, STOP_WAIT_MS, this.timers, "hindsight inventory stop").catch(() => undefined);
	}

	/** The `/healthz.hindsight` block: null when off, a pending one before the first probe. Reads memory only. */
	health(): InventoryHealth | null {
		if (!this.deps.config.enabled) return null;
		const report = this.report;
		if (report === null) {
			return { checkedAt: null, ok: null, reason: null, upstreamBanks: null, truncated: false, banks: [], drift: EMPTY_DRIFT };
		}
		const now = this.now();
		return {
			checkedAt: new Date(report.at).toISOString(),
			ok: report.ok,
			reason: report.reason,
			upstreamBanks: report.ok ? report.upstreamBanks : null,
			truncated: report.truncated,
			banks: report.banks.map((bank) => ({
				bank: bank.bank,
				present: bank.present,
				facts: bank.facts,
				pendingOperations: bank.pendingOperations,
				failedOperations: bank.failedOperations,
				lastWriteAgeSeconds: bank.lastWriteMs === null ? null : Math.max(0, Math.floor((now - bank.lastWriteMs) / 1000)),
				extractionMode: bank.extractionMode,
				error: bank.error,
			})),
			drift: report.drift,
		};
	}

	/** The per-bank gauge points of the newest successful probe. Empty when off, before the first probe or after a failed one. */
	gauges(): BankGaugeSample[] {
		const report = this.report;
		if (!this.deps.config.enabled || report === null || !report.ok) return [];
		const now = this.now();
		const samples: BankGaugeSample[] = [];
		const point = (name: string, unit: string, description: string, bank: string, value: number | null): void => {
			if (value !== null) samples.push({ name, unit, description, attributes: { bank }, value });
		};
		for (const bank of report.banks) {
			if (bank.present !== true) continue;
			point(GAUGE_BANK_FACTS, "{fact}", "Facts the bank holds, as the deployment lists it", bank.bank, bank.facts);
			point(GAUGE_BANK_PENDING, "{operation}", "Operations the bank has queued", bank.bank, bank.pendingOperations);
			point(GAUGE_BANK_FAILED, "{operation}", "Operations the bank has failed", bank.bank, bank.failedOperations);
			point(
				GAUGE_BANK_LAST_WRITE_AGE,
				"s",
				"Seconds since the bank's last write",
				bank.bank,
				bank.lastWriteMs === null ? null : Math.max(0, (now - bank.lastWriteMs) / 1000),
			);
		}
		return samples;
	}

	private failed(at: number, reason: string): InventoryReport {
		return { at, ok: false, reason, upstreamBanks: 0, truncated: false, banks: [], drift: EMPTY_DRIFT };
	}

	private async probe(): Promise<InventoryReport> {
		const at = this.now();
		const hindsight = this.deps.hindsight();
		if (hindsight === null) return this.failed(at, "unconfigured");
		if (this.deps.breakerOpen()) return this.failed(at, "circuit-open");
		const configured = resolveInventoryBanks(this.deps.banks());
		// One deadline for the whole probe, handed to every call: it fires inside the gated fetch, so a stall is a plane failure.
		const signal = AbortSignal.timeout(this.budgetMs);
		const listed = await listBanks(hindsight, this.deps.fetchImpl, { signal });
		if (!listed.ok) return this.failed(at, listed.error.kind);
		const upstream = new Map<string, HindsightBankSummary>(listed.value.banks.map((bank) => [bank.bank_id, bank]));
		const banks: InventoryBank[] = [];
		let halted = false;
		for (const name of configured) {
			const summary = upstream.get(name);
			// A listing cut at 200 banks says nothing about a bank it did not reach: that one is asked for directly
			// below (its stats), and is `unknown`, never `missing`, until the plane answers.
			if (summary === undefined && !listed.value.truncated) {
				banks.push({ bank: name, present: false, facts: null, pendingOperations: null, failedOperations: null, lastWriteMs: null, extractionMode: null, error: null });
				continue;
			}
			const entry: InventoryBank = {
				bank: name,
				present: summary === undefined ? null : true,
				facts: summary?.fact_count ?? null,
				pendingOperations: null,
				failedOperations: null,
				lastWriteMs: summary?.last_write_at == null ? null : toMs(summary.last_write_at),
				extractionMode: null,
				error: null,
			};
			banks.push(entry);
			if (halted || this.deps.breakerOpen() || signal.aborted) {
				entry.error = "skipped";
				continue;
			}
			const stats = await bankStats(hindsight, name, this.deps.fetchImpl, { signal });
			if (entry.present === null && !stats.ok && stats.error.kind === "not-found") {
				entry.present = false;
				continue;
			}
			if (stats.ok) {
				entry.present ??= true;
				entry.pendingOperations = stats.value.pending_operations;
				entry.failedOperations = stats.value.failed_operations;
				const written = stats.value.last_write_at === null ? null : toMs(stats.value.last_write_at);
				if (written !== null) entry.lastWriteMs = written;
			} else {
				entry.error = stats.error.kind;
				if (HALTING_KINDS[stats.error.kind] === true) {
					halted = true;
					continue;
				}
			}
			if (this.deps.breakerOpen() || signal.aborted) {
				entry.error ??= "skipped";
				continue;
			}
			const config = await bankConfig(hindsight, name, this.deps.fetchImpl, { signal });
			if (config.ok) {
				entry.extractionMode = config.value.retain_extraction_mode;
			} else {
				entry.error ??= config.error.kind;
				if (HALTING_KINDS[config.error.kind] === true) halted = true;
			}
		}
		const configuredSet = new Set(configured);
		const prefix = hindsight.bankPrefix;
		const missing = dedupeBounded(banks.filter((bank) => bank.present === false).map((bank) => safeBankName(bank.bank)));
		const unconfigured = dedupeBounded(
			[...upstream.keys()].filter((name) => name.startsWith(prefix) && !configuredSet.has(name)).map(safeBankName),
		);
		const notChunks = dedupeBounded(
			banks.filter((bank) => bank.present !== false && bank.extractionMode !== null && bank.extractionMode !== "chunks").map((bank) => safeBankName(bank.bank)),
		);
		return {
			at,
			ok: true,
			reason: null,
			upstreamBanks: upstream.size,
			truncated: listed.value.truncated,
			banks,
			drift: { missing: missing.kept, unconfigured: unconfigured.kept, notChunks: notChunks.kept, more: missing.more + unconfigured.more + notChunks.more },
		};
	}
}

function toMs(iso: string): number | null {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}
