#!/usr/bin/env bun
/**
 * Promotion advisor (`bun run advisor:promote`): WHEN is it safe to flip a
 * shadow, report or off policy to its enforcing value?
 *
 *   bun scripts/promote-advisor.ts [--json] [--flag NAME] [--offline fixture.json]
 *
 * About twenty policies ship in `shadow`/`report`/`off`/unset and nothing said
 * what evidence makes a flip safe. `packages/mcp-server/src/flag-registry.ts`
 * now carries, for each policy flag that the metrics history can speak to, a
 * set of criteria (`evidence`): a series of `GET /slo/history`, a comparator, a
 * threshold, a minimum sample count and a window. This script reads those
 * series from a running substrate and prints one verdict per flag:
 *
 * - `ready`             every criterion is met, with enough samples over the whole window;
 * - `hold`              a criterion is measured and NOT met (the flip would be a regression);
 * - `insufficient-data` the history does not cover the window, or has too few samples, to judge;
 * - `series-unavailable` the substrate cannot give the series at all: history off
 *                        (`SUBSTRATE_METRICS_HISTORY`), a series that is only recorded under
 *                        `SUBSTRATE_METRICS_HISTORY_SERIES=extended`, a refused bearer, no answer.
 *
 * A flag with several criteria is `hold` if any is held, else `series-unavailable`
 * if any series is unavailable, else `insufficient-data` if any lacks data, else
 * `ready`: a measured miss outranks a gap, and an unreadable series outranks a thin one.
 *
 * Refusals, each deliberate:
 * - It never changes anything and never flips a flag. Every request is a GET; the
 *   flip is the operator's step, printed beside the verdict and performed by hand
 *   (units, drop-ins and Railway variables are operator steps in this repo).
 * - The thresholds are PROPOSALS taken from the uplift-5 recon, not measured SLOs;
 *   every row says so, and the runbook (docs/runbooks/flag-promotion.md) says how
 *   to change one. A verdict is advice against a proposal.
 * - It does not read the flag's current value (that is in the unit env, which this
 *   process never opens). Evidence for a `shadow` policy only exists while it
 *   runs in shadow: after a flip the counters change meaning, so a repeated run
 *   then reports on the enforcing mode, not on the decision it already made.
 * - It does not guess a missing answer: a response without `points`, `from` or
 *   `to`, a non-finite number, a truncated answer, or a history whose retention is
 *   shorter than the window is `insufficient-data` or `series-unavailable`, never ready.
 *   Neither is a history with a hole: besides spanning 90 % of the window, no
 *   stretch of it (between two points, or after the last) may exceed 25 % of the
 *   window (`MAX_GAP_FRACTION`), so a sampler or ledger that was down for most of
 *   the window cannot read as covered. A quiet period with no traffic also leaves
 *   no counter rows; that is `insufficient-data` too, which is the safe answer.
 *   Coverage is judged on the criterion's own points: its label terms (another
 *   surface's full day does not vouch for a recent burst), and for an extended
 *   criterion the extended gauge `EXTENDED_COVERAGE_SERIES`, because extended
 *   history starts when `SUBSTRATE_METRICS_HISTORY_SERIES=extended` was enabled
 *   and a missing extended counter row before that is absent, not zero.
 * - A policy's manual check (`also check:`, JSON `manual`) is printed with the
 *   verdict and applies whatever it is, ready included.
 * - The bearer is resolved like the runtime doctor (`doctorBearer`), sent only as
 *   an `Authorization` header to the URL it was resolved for (redirects are not
 *   followed, so it cannot be forwarded), and is never printed or put in JSON.
 * - `/slo` admission.limited_rate reads 0 in shadow by design (only `limited`
 *   counts), so the budget criterion uses the raw `shadow_limited` series.
 *
 * Exits 0 whatever the verdicts; 2 on a usage error (bad flag, unknown `--flag`
 * name, unreadable or invalid `--offline` fixture).
 */
import { readFileSync } from "node:fs";
import { EXTENDED_COVERAGE_SERIES, type Evidence, type FlagSpec, flagByName, policyFlags, type SeriesTerm } from "../packages/mcp-server/src/flag-registry.ts";
import { doctorBearer } from "./doctor-runtime.ts";

export const VERDICTS = ["ready", "hold", "insufficient-data", "series-unavailable"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Share of the criterion window the history must span before it can be judged (a bucket start is not the window start). */
export const COVERAGE_MIN = 0.9;
/** The longest stretch of the window with no point (between two points, or after the last) the history may have and still be judged. */
export const MAX_GAP_FRACTION = 0.25;
const REQUEST_TIMEOUT_MS = 5000;
/** A `/slo/history` answer is at most 2000 points; this is a hard cap on what is read, enforced while reading. */
const MAX_BODY_BYTES = 4_000_000;
const DEFAULT_BASE = "http://127.0.0.1:7410";
const WINDOW_UNIT_S: Readonly<Record<string, number>> = { m: 60, h: 3600, d: 86_400 };

// ── answers ──────────────────────────────────────────────────────────────────

export interface HistoryPoint {
	tsMs: number;
	labels: Readonly<Record<string, string>>;
	value: number | null;
	count: number;
}

export type SeriesResult =
	| { ok: true; fromMs: number; toMs: number; windowCapped: boolean; truncated: boolean; points: readonly HistoryPoint[] }
	| { ok: false; reason: string; hint: string };

/** A response as the advisor sees it: `status` 0 is "no answer" (unreachable, timed out or over the size cap). */
export interface Answer {
	status: number;
	body: unknown;
}

/** The only I/O the advisor has, and it takes a path and query: there is no way to name a method. */
export type Getter = (pathAndQuery: string) => Promise<Answer>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePoint(raw: unknown): HistoryPoint | null {
	if (!isRecord(raw) || typeof raw.ts !== "string" || !isRecord(raw.labels)) return null;
	const tsMs = Date.parse(raw.ts);
	if (!Number.isFinite(tsMs)) return null;
	const value = raw.value;
	if (value !== null && !(typeof value === "number" && Number.isFinite(value))) return null;
	if (typeof raw.count !== "number" || !Number.isFinite(raw.count) || raw.count < 0) return null;
	const labels: Record<string, string> = {};
	for (const [key, label] of Object.entries(raw.labels)) {
		if (typeof label !== "string") return null;
		labels[key] = label;
	}
	return { tsMs, labels, value, count: raw.count };
}

const HINT_HISTORY_OFF = "set SUBSTRATE_METRICS_HISTORY=on in the unit env and restart (it also needs the ledger; decide the Greptime volume first, docs/observability.md)";
const HINT_EXTENDED = "set SUBSTRATE_METRICS_HISTORY_SERIES=extended in the unit env and restart (opt-in: it adds rows to the history table; a substrate release without that flag does not record the series)";
const HINT_BEARER = "set SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_SUBSTRATE, SUBSTRATE_TOKEN_FILE or SUBSTRATE_TOKENS_DIR for the substrate surface";

/** One `/slo/history` answer as a result. Anything that is not a complete, well-formed 200 is `ok: false` with a closed reason. */
export function parseSeriesAnswer(answer: Answer, needs: Evidence["needs"]): SeriesResult {
	const { status, body } = answer;
	if (status === 0) return { ok: false, reason: "no answer (unreachable, timed out or too large)", hint: "check SUBSTRATE_URL and that substrate-mcp is up" };
	if (status === 404 && isRecord(body) && body.enabled === false) return { ok: false, reason: "metrics history is off", hint: HINT_HISTORY_OFF };
	if (status === 400) {
		return {
			ok: false,
			reason: "series is not recorded by this substrate",
			hint: needs === "extended" ? HINT_EXTENDED : "this build does not record the series; run it against a release that does",
		};
	}
	if (status === 401 || status === 403) return { ok: false, reason: `bearer refused (HTTP ${status})`, hint: HINT_BEARER };
	if (status === 429) return { ok: false, reason: "admission refused the read (HTTP 429)", hint: "retry shortly" };
	if (status === 503) return { ok: false, reason: "the history store could not answer (HTTP 503)", hint: "retry shortly; check the ledger plane in /healthz" };
	if (status !== 200) return { ok: false, reason: `unexpected HTTP ${status}`, hint: "check the substrate version and URL" };
	if (!isRecord(body) || body.enabled !== true || !Array.isArray(body.points) || typeof body.from !== "string" || typeof body.to !== "string") {
		return { ok: false, reason: "malformed history answer", hint: "the substrate is not a version this advisor reads" };
	}
	const fromMs = Date.parse(body.from);
	const toMs = Date.parse(body.to);
	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { ok: false, reason: "malformed history answer", hint: "the substrate is not a version this advisor reads" };
	const points: HistoryPoint[] = [];
	for (const raw of body.points) {
		const point = parsePoint(raw);
		if (point === null) return { ok: false, reason: "malformed history answer", hint: "the substrate is not a version this advisor reads" };
		points.push(point);
	}
	return { ok: true, fromMs, toMs, windowCapped: body.windowCapped === true, truncated: body.truncated === true, points };
}

// ── judging ──────────────────────────────────────────────────────────────────

export function windowSeconds(window: string): number {
	const match = /^([1-9][0-9]{0,3})([mhd])$/.exec(window);
	if (match === null) throw new Error(`evidence window ${window} is not <n><m|h|d>`);
	return Number(match[1]) * WINDOW_UNIT_S[match[2]!]!;
}

export const keyOf = (series: string, window: string): string => `${series}@${window}`;

/** Every series a criterion reads, with the window it asks for: numerator, denominator, and the series that proves coverage. */
export function requiredSeries(evidence: Evidence): string[] {
	const names = [evidence.numerator.series];
	if (evidence.denominator !== undefined) names.push(evidence.denominator.series);
	names.push(coverageTermOf(evidence).series);
	return [...new Set(names)];
}

/**
 * The points whose presence proves the window was sampled. An extended criterion is covered by the extended
 * gauge (a row every interval, from the moment extended sampling started); a core criterion by the points it is
 * about, with its own label terms: the denominator's for a share or ratio, else the numerator's.
 */
function coverageTermOf(evidence: Evidence): SeriesTerm {
	if (evidence.needs === "extended") return { series: EXTENDED_COVERAGE_SERIES };
	return evidence.stat === "share" || evidence.stat === "ratio" ? (evidence.denominator ?? { series: evidence.numerator.series }) : evidence.numerator;
}

function pick(points: readonly HistoryPoint[], term: SeriesTerm): HistoryPoint[] {
	const labels = term.labels;
	if (labels === undefined) return [...points];
	// The label key is the series' one label; a point with no label never matches a named value.
	return points.filter((point) => Object.values(point.labels).some((value) => labels.includes(value)));
}

const sumValue = (points: readonly HistoryPoint[]): number => points.reduce((total, point) => total + (point.value ?? 0), 0);
const sumCount = (points: readonly HistoryPoint[]): number => points.reduce((total, point) => total + point.count, 0);

export interface Criterion {
	id: string;
	verdict: Verdict;
	/** The measured number, in the criterion's unit; null when it was not measured. */
	observed: number | null;
	comparator: Evidence["comparator"];
	threshold: number;
	unit: Evidence["unit"];
	/** Denominator sum or observation count the judgement rests on; null when no series answered. */
	samples: number | null;
	minSamples: number;
	window: string;
	needs: Evidence["needs"];
	/** Always true: the threshold is a proposal, never a measured SLO. */
	proposed: true;
	detail: string;
	hint: string | null;
	/** A standing caveat on how to read the number (for example that it is a bound), from the registry. */
	note: string | null;
}

function compare(observed: number, comparator: Evidence["comparator"], threshold: number): boolean {
	switch (comparator) {
		case "<=":
			return observed <= threshold;
		case ">=":
			return observed >= threshold;
		case "<":
			return observed < threshold;
		case ">":
			return observed > threshold;
		case "==":
			return observed === threshold;
	}
}

function criterionBase(evidence: Evidence): Omit<Criterion, "verdict" | "observed" | "samples" | "detail" | "hint"> {
	return {
		id: evidence.id,
		comparator: evidence.comparator,
		threshold: evidence.threshold,
		unit: evidence.unit,
		minSamples: evidence.minSamples,
		window: evidence.window,
		needs: evidence.needs,
		note: evidence.note ?? null,
		proposed: true,
	};
}

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)} h`;

/** One criterion against the answers fetched for it (`keyOf(series, window)` → result). Pure. */
export function judgeCriterion(evidence: Evidence, results: ReadonlyMap<string, SeriesResult>): Criterion {
	const base = criterionBase(evidence);
	const answered = new Map<string, Extract<SeriesResult, { ok: true }>>();
	for (const series of requiredSeries(evidence)) {
		const result = results.get(keyOf(series, evidence.window)) ?? { ok: false as const, reason: "series was not fetched", hint: "rerun the advisor" };
		if (!result.ok) return { ...base, verdict: "series-unavailable", observed: null, samples: null, detail: `${series}: ${result.reason}`, hint: result.hint };
		answered.set(series, result);
	}
	const unjudged = (detail: string, hint: string, samples: number | null = null): Criterion => ({ ...base, verdict: "insufficient-data", observed: null, samples, detail, hint });
	const windowMs = windowSeconds(evidence.window) * 1000;

	// Window checks first: a number computed over part of the window must not read as the whole.
	if ([...answered.values()].some((result) => result.truncated)) {
		return unjudged("the answer was truncated, so the oldest part of the window is missing", "narrow the criterion window or raise SUBSTRATE_METRICS_HISTORY_INTERVAL_S");
	}
	if ([...answered.values()].some((result) => result.windowCapped)) {
		return unjudged(`history retention is shorter than the ${evidence.window} window`, "raise SUBSTRATE_METRICS_HISTORY_TTL (an existing table needs an operator ALTER, docs/observability.md)");
	}
	const coverageTerm = coverageTermOf(evidence);
	const coverageAnswer = answered.get(coverageTerm.series)!;
	// Coverage is judged on the points the criterion is about (its own label terms), so another surface's full day cannot vouch for a recent burst; an extended criterion is judged on the extended gauge, because extended history only starts when the flag was enabled.
	const coveragePoints = pick(coverageAnswer.points, coverageTerm);
	const why = evidence.needs === "extended" ? "extended history only starts when SUBSTRATE_METRICS_HISTORY_SERIES=extended was enabled, and a missing extended counter row is zero only after that; " : "";
	const earliest = coveragePoints.reduce((min, point) => Math.min(min, point.tsMs), Number.POSITIVE_INFINITY);
	const coveredMs = coveragePoints.length === 0 ? 0 : Math.max(0, coverageAnswer.toMs - earliest);
	if (coveredMs < COVERAGE_MIN * windowMs) {
		return unjudged(`${why}${coverageTerm.series} covers ${hours(coveredMs)} of the ${evidence.window} window (needs ${Math.round(COVERAGE_MIN * 100)} %)`, "let it soak in the safe mode; rerun when the window is covered");
	}
	// Coverage from the first point to now says nothing about a hole in the middle (sampler or ledger down): no stretch of the window, between points or after the last one, may exceed MAX_GAP_FRACTION of it.
	const stamps = [...new Set(coveragePoints.map((point) => point.tsMs))].sort((a, b) => a - b);
	const widest = stamps.reduce((gap, stamp, index) => Math.max(gap, index === 0 ? 0 : stamp - stamps[index - 1]!), Math.max(0, coverageAnswer.toMs - stamps[stamps.length - 1]!));
	if (widest > MAX_GAP_FRACTION * windowMs) {
		return unjudged(`${why}${coverageTerm.series} has a ${hours(widest)} gap in the ${evidence.window} window (allowed ${hours(MAX_GAP_FRACTION * windowMs)}): the sampler or the ledger was down, or there was no traffic`, "check the sampler and the ledger plane in /healthz; rerun when the window is continuous");
	}

	const numeratorPoints = pick(answered.get(evidence.numerator.series)!.points, evidence.numerator);
	const thin = (samples: number): Criterion => unjudged(`${samples} samples in the window, needs ${evidence.minSamples}`, "let it soak in the safe mode; rerun when there is traffic", samples);
	let observed: number;
	let samples: number;
	let detail: string;
	if (evidence.stat === "share" || evidence.stat === "ratio") {
		// No denominator means every point of the numerator's series, so a label set is a share of the whole series.
		const denominatorTerm = evidence.denominator ?? { series: evidence.numerator.series };
		const denominatorPoints = pick(answered.get(denominatorTerm.series)!.points, denominatorTerm);
		const top = sumValue(numeratorPoints);
		const bottom = evidence.stat === "share" ? sumValue(denominatorPoints) : sumCount(denominatorPoints);
		samples = bottom;
		if (bottom <= 0 || bottom < evidence.minSamples) return thin(samples);
		observed = top / bottom;
		detail = `${top} of ${bottom}`;
	} else if (evidence.stat === "max") {
		const values = numeratorPoints.flatMap((point) => (point.value === null ? [] : [point.value]));
		samples = sumCount(numeratorPoints);
		if (values.length === 0 || samples < evidence.minSamples) return thin(samples);
		observed = Math.max(...values);
		detail = `worst of ${values.length} intervals`;
	} else {
		samples = sumCount(numeratorPoints);
		if (samples < evidence.minSamples) return thin(samples);
		observed = sumValue(numeratorPoints);
		detail = `${numeratorPoints.length} intervals with a count`;
	}
	const met = compare(observed, evidence.comparator, evidence.threshold);
	return { ...base, verdict: met ? "ready" : "hold", observed, samples, detail, hint: null };
}

export interface FlagVerdict {
	flag: string;
	safe: string;
	enforcing: string;
	verdict: Verdict;
	step: string;
	rollback: string;
	/** The policy's manual check, which still applies when the verdict is `ready`; null when the policy has none. */
	manual: string | null;
	criteria: Criterion[];
}

const PRECEDENCE: readonly Verdict[] = ["hold", "series-unavailable", "insufficient-data"];

/** A flag's verdict from its criteria: hold, then series-unavailable, then insufficient-data, else ready. */
export function judgeFlag(flag: FlagSpec, results: ReadonlyMap<string, SeriesResult>): FlagVerdict {
	const policy = flag.policy!;
	const criteria = policy.evidence.map((evidence) => judgeCriterion(evidence, results));
	const verdict = PRECEDENCE.find((candidate) => criteria.some((criterion) => criterion.verdict === candidate)) ?? "ready";
	return { flag: flag.name, safe: policy.safe, enforcing: policy.enforcing, verdict, step: policy.step, rollback: policy.rollback, manual: policy.manual ?? null, criteria };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

async function readCapped(res: Response, max: number): Promise<string | null> {
	const reader = res.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * GET-only access to one substrate. `redirect: "manual"` means a 3xx is an
 * unexpected status rather than a request the bearer follows to another origin;
 * the deadline is an `AbortSignal` that also covers reading the body.
 */
export function liveGetter(base: string, bearer: string | null, fetchImpl: typeof fetch = fetch): Getter {
	const root = base.replace(/\/+$/, "");
	return async (pathAndQuery) => {
		try {
			const res = await fetchImpl(`${root}${pathAndQuery}`, {
				method: "GET",
				headers: bearer === null ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${bearer}` },
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await readCapped(res, MAX_BODY_BYTES);
			if (text === null) return { status: 0, body: null };
			let body: unknown = null;
			try {
				body = JSON.parse(text);
			} catch {
				body = null;
			}
			return { status: res.status, body };
		} catch {
			return { status: 0, body: null };
		}
	};
}

export class FixtureError extends Error {}

/** A fixture: `{ series: { "<series>[@<window>]": { status, body } }, slo?: { status, body } }`. */
export interface Fixture {
	series: ReadonlyMap<string, Answer>;
	slo: Answer | null;
}

function parseAnswer(raw: unknown, where: string): Answer {
	if (!isRecord(raw) || typeof raw.status !== "number" || !Number.isInteger(raw.status)) throw new FixtureError(`${where} needs an integer "status" and a "body"`);
	return { status: raw.status, body: raw.body ?? null };
}

export function parseFixture(text: string): Fixture {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new FixtureError("the fixture is not JSON");
	}
	if (!isRecord(parsed) || !isRecord(parsed.series)) throw new FixtureError('the fixture needs a "series" object');
	const series = new Map<string, Answer>();
	for (const [key, raw] of Object.entries(parsed.series)) series.set(key, parseAnswer(raw, `series "${key}"`));
	return { series, slo: parsed.slo === undefined ? null : parseAnswer(parsed.slo, "slo") };
}

/** The fixture as a getter: `<series>@<window>` first, then `<series>`; an absent series answers like a series the substrate does not record. */
export function offlineGetter(fixture: Fixture): Getter {
	return async (pathAndQuery) => {
		const url = new URL(pathAndQuery, "http://fixture.invalid");
		if (url.pathname === "/slo") return fixture.slo ?? { status: 0, body: null };
		const series = url.searchParams.get("series") ?? "";
		const window = url.searchParams.get("window") ?? "";
		return fixture.series.get(keyOf(series, window)) ?? fixture.series.get(series) ?? { status: 400, body: { enabled: true, error: "series is not one of the recorded series" } };
	};
}

/** What `/slo` says about how long the counters have been accumulating. Context only; null when absent or malformed. */
export function sloHistoryOf(answer: Answer): { epoch: number; since: string } | null {
	if (answer.status !== 200 || !isRecord(answer.body) || !isRecord(answer.body.history)) return null;
	const { epoch, since } = answer.body.history;
	return typeof epoch === "number" && Number.isFinite(epoch) && typeof since === "string" ? { epoch, since } : null;
}

export interface Report {
	source: "live" | "offline";
	history: { epoch: number; since: string } | null;
	flags: FlagVerdict[];
	/** Policy flags whose evidence is not in the history: the operator reads the `manual` line. */
	notJudged: Array<{ flag: string; safe: string; enforcing: string; step: string; rollback: string; manual: string }>;
}

/** Fetch every distinct (series, window) once, sequentially: the route allows 16 concurrent reads and each is a ledger scan. */
export async function buildReport(flags: readonly FlagSpec[], get: Getter, source: Report["source"]): Promise<Report> {
	const wanted = new Map<string, { series: string; window: string; needs: Evidence["needs"] }>();
	for (const flag of flags) {
		for (const evidence of flag.policy?.evidence ?? []) {
			for (const series of requiredSeries(evidence)) {
				const key = keyOf(series, evidence.window);
				// `needs` describes the series the criterion measures (its numerator) and the extended coverage gauge; a denominator or a coverage series of a core criterion is a core series.
				const needs = (series === evidence.numerator.series && evidence.needs === "extended") || series === EXTENDED_COVERAGE_SERIES ? "extended" : "core";
				if (!wanted.has(key)) wanted.set(key, { series, window: evidence.window, needs });
			}
		}
	}
	const results = new Map<string, SeriesResult>();
	for (const [key, item] of wanted) {
		const answer = await get(`/slo/history?series=${encodeURIComponent(item.series)}&window=${encodeURIComponent(item.window)}`);
		results.set(key, parseSeriesAnswer(answer, item.needs));
	}
	const history = sloHistoryOf(await get("/slo"));
	const judged: FlagVerdict[] = [];
	const notJudged: Report["notJudged"] = [];
	for (const flag of flags) {
		const policy = flag.policy;
		if (policy === undefined) continue;
		if (policy.evidence.length === 0) {
			notJudged.push({ flag: flag.name, safe: policy.safe, enforcing: policy.enforcing, step: policy.step, rollback: policy.rollback, manual: policy.manual ?? "" });
		} else {
			judged.push(judgeFlag(flag, results));
		}
	}
	return { source, history, flags: judged, notJudged };
}

// ── output ───────────────────────────────────────────────────────────────────

function formatNumber(value: number, unit: Evidence["unit"]): string {
	if (unit === "share") return `${(value * 100).toFixed(2)} %`;
	const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
	return unit === "count" ? text : `${text} ${unit}`;
}

function formatCriterion(criterion: Criterion): string {
	const wanted = `${criterion.comparator} ${formatNumber(criterion.threshold, criterion.unit)}`;
	const measured =
		criterion.observed === null
			? `not measured (${criterion.detail})`
			: `${formatNumber(criterion.observed, criterion.unit)} ${wanted} (${criterion.detail}; ${criterion.samples ?? 0} samples, needs ${criterion.minSamples})`;
	const tail = criterion.observed === null ? ` -> wanted ${wanted} over ${criterion.window}` : ` over ${criterion.window}`;
	const hint = criterion.hint === null ? "" : `\n      -> ${criterion.hint}`;
	const note = criterion.note === null ? "" : ` (${criterion.note})`;
	return `  [${criterion.verdict}] ${criterion.id}: ${measured}${tail}${note} [PROPOSED${criterion.needs === "extended" ? ", extended series" : ""}]${hint}`;
}

export function formatReport(report: Report): string {
	const lines = [
		"promotion advisor: read-only (every request is a GET); thresholds are PROPOSALS, not measured SLOs (docs/runbooks/flag-promotion.md)",
		`source: ${report.source}${report.history === null ? "" : `; counters since ${report.history.since} (epoch ${report.history.epoch})`}`,
		"it does not read the flag's current value: evidence for a shadow policy exists only while it runs in shadow",
		"",
	];
	for (const flag of report.flags) {
		lines.push(`${flag.flag}  ${flag.safe} -> ${flag.enforcing}  ${flag.verdict.toUpperCase()}`);
		for (const criterion of flag.criteria) lines.push(formatCriterion(criterion));
		lines.push(`  when ready: ${flag.step}`);
		// A verdict from the history is not the whole decision: the manual check still applies, ready included.
		if (flag.manual !== null) lines.push(`  also check: ${flag.manual}  (applies whatever the verdict, ready included)`);
		lines.push(`  rollback:   ${flag.rollback}`, "");
	}
	if (report.notJudged.length > 0) {
		lines.push("not judged from the history (read the manual evidence):");
		for (const item of report.notJudged) lines.push(`  ${item.flag}  ${item.safe} -> ${item.enforcing}: ${item.manual}`);
		lines.push("");
	}
	return `${lines.join("\n")}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface CliOptions {
	json: boolean;
	flag: string | null;
	offline: string | null;
}

export function parseArgs(argv: readonly string[]): CliOptions | { usage: string } {
	const options: CliOptions = { json: false, flag: null, offline: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		if (arg === "--json") options.json = true;
		else if (arg === "--flag" || arg === "--offline") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) return { usage: `${arg} needs a value` };
			if (arg === "--flag") options.flag = value;
			else options.offline = value;
			i += 1;
		} else if (arg === "--help" || arg === "-h") return { usage: "" };
		else return { usage: `unknown argument ${arg}` };
	}
	return options;
}

const USAGE = `usage: bun scripts/promote-advisor.ts [--json] [--flag NAME] [--offline fixture.json]

Reads GET /slo/history (and /slo) from SUBSTRATE_URL (default ${DEFAULT_BASE}) and prints, per
policy flag, ready | hold | insufficient-data | series-unavailable against the PROPOSED
thresholds in the flag registry, with the observed number, the threshold, the sample count
and the operator's one-line promotion step. Read-only: it makes no write call and flips
nothing. --offline reads the same answers from a JSON fixture and makes no request.
Exit 0 whatever the verdicts, 2 on a usage error.
`;

export interface Io {
	stdout(text: string): void;
	stderr(text: string): void;
	fetchImpl?: typeof fetch;
	readFile?: (path: string) => string;
}

export async function main(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	io: Io = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
): Promise<number> {
	const parsed = parseArgs(argv);
	if ("usage" in parsed) {
		if (parsed.usage === "") {
			io.stdout(USAGE);
			return 0;
		}
		io.stderr(`promote advisor: ${parsed.usage}\n${USAGE}`);
		return 2;
	}
	let flags: readonly FlagSpec[] = policyFlags();
	if (parsed.flag !== null) {
		const named = flagByName(parsed.flag);
		if (named?.policy === undefined) {
			io.stderr(`promote advisor: ${parsed.flag} is not a policy flag in the registry (${flags.map((flag) => flag.name).join(", ")})\n`);
			return 2;
		}
		flags = [named];
	}
	let get: Getter;
	let source: Report["source"];
	if (parsed.offline !== null) {
		try {
			get = offlineGetter(parseFixture((io.readFile ?? ((path) => readFileSync(path, "utf8")))(parsed.offline)));
		} catch (cause) {
			io.stderr(`promote advisor: ${cause instanceof FixtureError ? cause.message : "the fixture could not be read"}\n`);
			return 2;
		}
		source = "offline";
	} else {
		const base = env.SUBSTRATE_URL?.trim() || DEFAULT_BASE;
		if (!/^https?:\/\//i.test(base)) {
			io.stderr("promote advisor: SUBSTRATE_URL must be an http(s) URL\n");
			return 2;
		}
		get = liveGetter(base, doctorBearer(env), io.fetchImpl);
		source = "live";
	}
	const report = await buildReport(flags, get, source);
	io.stdout(parsed.json ? `${JSON.stringify(report, null, "\t")}\n` : formatReport(report));
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "advisor failed";
		process.stderr.write(`promote advisor: ${message}\n`);
		process.exit(2);
	}
}
