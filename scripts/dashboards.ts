#!/usr/bin/env bun
/**
 * Grafana dashboards as code (`bun run dashboards:build`, uplift-5 S6).
 *
 * Builds the substrate's SLO and data-plane dashboards from the same code the
 * running server judges itself with, so a dashboard cannot drift from it:
 *
 * - the SLO lines are the targets of `sloCatalogue()`, `docsSearchObjective()`,
 *   `ADMISSION_SLO` and `DEFAULT_THRESHOLDS` (never a number typed here);
 * - every panel reads one series of the history allow-list
 *   (`ALL_METRIC_SERIES`), and its unit, aggregate and label come from that
 *   series' own spec;
 * - the source instrument named in each description is a `METRIC` constant.
 *
 * The data is `GET /slo/history?series=&window=&step=` read through the Grafana
 * Infinity datasource (JSON over HTTP). The route is the only feed there is:
 * `/metrics` is JSON, not Prometheus text, and the OTLP exporter has no sink.
 * The route is bearer-gated and answers `404 {enabled:false}` until
 * `SUBSTRATE_METRICS_HISTORY=on`; the panels draw nothing until then.
 *
 * Output is deterministic (sorted keys, stable panel ids and uids, a fixed
 * `schemaVersion`), so `--check` is a byte comparison:
 *
 *   bun scripts/dashboards.ts            write infra/vps/dashboards/
 *   bun scripts/dashboards.ts --check    render in memory, diff, exit 1 on drift
 *   bun scripts/dashboards.ts --out DIR  use DIR instead (tests, a scratch copy)
 *
 * Exits 0 when the files were written or `--check` found none out of date, 1 on
 * drift, 2 on a usage error. Nothing here installs or provisions anything: the
 * provisioning files are `.example` files an operator copies, and they name the
 * datasource's URL and bearer by environment-variable placeholder, never by value.
 *
 * Refusals, each with its reason:
 * - A catalogue objective with no entry in {@link SLO_SERIES} throws. A new
 *   objective must be consciously given a series or marked live-only, not
 *   silently left off the dashboard.
 * - A series with no entry in {@link SERIES_SOURCES} throws, for the same reason.
 * - A panel whose series is absent from the allow-list is omitted (an extended
 *   series on a build that no longer has it), never drawn against a 400.
 * - A window or step option that the route would refuse, or a window longer than
 *   the default retention, throws at build time.
 * - `--check` also reports files in the directory that the generator does not
 *   produce, but the write mode never deletes anything.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DEFAULT_METRICS_HISTORY_TTL, parseMetricsHistoryTtl } from "../packages/mcp-server/src/config.ts";
import { FABRIC_RESOURCES, type FabricResourceName } from "../packages/mcp-server/src/fabric/types.ts";
import { ALL_METRIC_SERIES, parseHistoryStep, parseHistoryWindow, type SeriesSpec } from "../packages/mcp-server/src/metrics-history.ts";
import {
	ADMISSION_SLO,
	CAPACITY_RUNWAY_ID,
	CORPUS_FRESHNESS_METRIC,
	CORPUS_GOLDEN_RECALL5_METRIC,
	CORPUS_INGEST_RATE_METRIC,
	DEFAULT_THRESHOLDS,
	ENDPOINT_PROXY_PLANES_METRIC,
	INDEX_ARCHIVE_AGE_METRIC,
	METRIC,
	OUTBOX_OLDEST_METRIC,
	OUTBOX_SIZE_METRIC,
	PLANES,
	docsSearchObjective,
	sloCatalogue,
	type SloTarget,
	type SloThresholds,
} from "../packages/observability/src/index.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** The Grafana plugin that reads JSON over HTTP, and the uid the provisioning example gives the datasource. Every panel and target refers to it by this pair. */
export const DATASOURCE_TYPE = "yesoreyeram-infinity-datasource";
export const DATASOURCE_UID = "substrate-slo-history";
export const DATASOURCE_NAME = "Substrate SLO history";
/** The placeholders the provisioning example interpolates from Grafana's environment. Names only: the values are the operator's. */
export const URL_PLACEHOLDER = "SUBSTRATE_DASHBOARD_URL";
export const BEARER_PLACEHOLDER = "SUBSTRATE_DASHBOARD_BEARER";

export const SLO_DASHBOARD_UID = "substrate-slo";
export const PLANES_DASHBOARD_UID = "substrate-data-planes";
export const SCHEMA_VERSION = 39;

/** The dashboard variables: windows must parse as the route's windows and fit the default retention, steps as its steps. */
export const WINDOW_OPTIONS = ["1h", "6h", "24h", "7d", "14d"] as const;
export const DEFAULT_WINDOW = "24h";
export const STEP_OPTIONS = ["1m", "5m", "15m", "1h"] as const;
export const DEFAULT_STEP = "5m";

/** Where the generated files go, relative to the repo root. */
export const DEFAULT_OUT_DIR = join(import.meta.dir, "..", "infra", "vps", "dashboards");

/**
 * Which history series draws each catalogue objective, or `null` when no
 * durable series exists for it (the objective is then a text panel that points
 * at `GET /slo`). Closed on purpose: an objective added to the catalogue throws
 * until someone decides how it is shown.
 */
export const SLO_SERIES: Readonly<Record<string, string | null>> = {
	"brief.p95": "brief.p95",
	"emit.success": "emit.success",
	"lease.steal_rate": null,
	"quarantine.rate": null,
};

/** The instrument or gauge each series is read from, for the panel description. Closed for the same reason as {@link SLO_SERIES}. */
export const SERIES_SOURCES: Readonly<Record<string, string>> = {
	"brief.p50": METRIC.briefDuration,
	"brief.p95": METRIC.briefDuration,
	"emit.success": METRIC.emitTotal,
	"emit.p95": METRIC.emitDuration,
	"plane.availability": METRIC.planeDuration,
	"plane.p95": METRIC.planeDuration,
	"cache.hit_ratio": METRIC.cacheOperations,
	"admission.decisions": METRIC.admissionDecisions,
	"docs.search": METRIC.docsSearch,
	"docs.p95": METRIC.docsDuration,
	"capacity.runway_days": CAPACITY_RUNWAY_ID,
	"cache.operations": METRIC.cacheOperations,
	"brief.profile_bytes_saved": METRIC.briefProfileBytesSaved,
	"brief.recall": METRIC.briefRecall,
	"recall.prefetch": METRIC.recallPrefetch,
	"memory.expired": METRIC.memoryExpired,
	"hindsight.outbox_size": OUTBOX_SIZE_METRIC,
	"hindsight.outbox_oldest_age_s": OUTBOX_OLDEST_METRIC,
	"planning.transition": "PlanningObserver scan path (planning/observer.ts)",
	"index.archive_age_s": INDEX_ARCHIVE_AGE_METRIC,
	"endpoint.proxy_planes": ENDPOINT_PROXY_PLANES_METRIC,
	"corpus.freshness_seconds": CORPUS_FRESHNESS_METRIC,
	"corpus.ingest_docs_per_s": CORPUS_INGEST_RATE_METRIC,
	"corpus.golden_recall5": CORPUS_GOLDEN_RECALL5_METRIC,
};

/**
 * The series that draws each fabric resource (phase 51, SOTA-07): one panel per resource, reading a series the repo already emits.
 * `null` is a resource with no metric in the repo: a gap, listed in docs/observability.md, never drawn against an invented series.
 * Closed, like {@link SLO_SERIES}: a resource added to FABRIC_RESOURCES throws until it has an entry here.
 */
export const FABRIC_SERIES: Readonly<Record<FabricResourceName, { series: string; note: string } | null>> = {
	dragonfly: { series: "cache.hit_ratio", note: "Dragonfly is the cache plane, so this is its read-through hit ratio over every key class." },
	"timescaledb-index": { series: "capacity.runway_days", note: "The index volume's runway in days, fitted over its size history." },
	greptime: { series: "plane.availability", note: "The greptime line is the ledger's call availability." },
	lightrag: { series: "plane.p95", note: "The lightrag line is LightRAG's call latency at p95." },
	tei: { series: "plane.p95", note: "The tei line is the embedding service's call latency at p95." },
	hindsight: { series: "hindsight.outbox_size", note: "Retain forwards parked for replay. Needs SUBSTRATE_METRICS_HISTORY_SERIES=extended." },
	"tailscale-proxy": { series: "endpoint.proxy_planes", note: "A count of the data planes on a configured proxy (SUBSTRATE_DB_PROXY_ALLOW), set at boot from the endpoint classes. Needs SUBSTRATE_METRICS_HISTORY_SERIES=extended." },
	corpus: { series: "corpus.freshness_seconds", note: "Age of the newest corpus manifest change; its objective is SUBSTRATE_DOCS_SLO_FRESHNESS_S. No point until the manifest has a change. Needs SUBSTRATE_METRICS_HISTORY_SERIES=extended." },
};

/** A history series unit as Grafana names it; a counting unit (`{decision}`, `{brief}`) is a plain number. */
const GRAFANA_UNITS: Readonly<Record<string, string>> = { ms: "ms", ratio: "percentunit", days: "d", s: "s", By: "bytes" };

export interface DashboardOptions {
	/** The objectives to draw. Default `sloCatalogue(thresholds)`. */
	catalogue?: SloTarget[];
	/** The history allow-list. Default every series the code knows (`core` and `extended`). */
	series?: Readonly<Record<string, SeriesSpec>>;
	/** Threshold overrides; default `DEFAULT_THRESHOLDS`. A deployment's `SUBSTRATE_SLO_*` overrides are not known here. */
	thresholds?: SloThresholds;
}

interface Context {
	catalogue: SloTarget[];
	docs: Extract<SloTarget, { kind: "latency-quantile" }>;
	series: Readonly<Record<string, SeriesSpec>>;
	planeAvailability: number;
	runwayDays: number;
}

interface Threshold {
	value: number;
	direction: "ceiling" | "floor";
}

type Item =
	| { kind: "row"; title: string }
	| { kind: "chart"; series: string; title: string; note: string; threshold?: Threshold; stack?: boolean; bars?: boolean }
	| { kind: "text"; title: string; content: string };

function context(options: DashboardOptions): Context {
	const catalogue = options.catalogue ?? sloCatalogue(options.thresholds);
	const docs = docsSearchObjective(options.thresholds);
	if (docs.kind !== "latency-quantile") throw new Error("the docs search objective is not a latency objective");
	const thresholds = options.thresholds ?? {};
	return {
		catalogue,
		docs,
		series: options.series ?? ALL_METRIC_SERIES,
		planeAvailability: thresholds.planeAvailability ?? DEFAULT_THRESHOLDS.planeAvailability,
		runwayDays: thresholds.runwayDays ?? DEFAULT_THRESHOLDS.runwayDays,
	};
}

function thresholdOf(slo: SloTarget): Threshold {
	if (slo.kind === "latency-quantile") return { value: slo.thresholdMs, direction: "ceiling" };
	return { value: slo.target, direction: slo.kind === "ratio-floor" ? "floor" : "ceiling" };
}

function describeTarget(slo: SloTarget): string {
	if (slo.kind === "latency-quantile") return `at most ${slo.thresholdMs} ms`;
	return `${slo.kind === "ratio-floor" ? "at least" : "at most"} ${(slo.target * 100).toFixed(2)} %`;
}

// ── the items each dashboard draws ───────────────────────────────────────────

function sloItems(ctx: Context): Item[] {
	const items: Item[] = [{ kind: "row", title: "Catalogue objectives" }];
	for (const slo of ctx.catalogue) {
		if (!Object.hasOwn(SLO_SERIES, slo.id)) {
			throw new Error(`SLO ${slo.id} is in the catalogue but has no dashboard decision; add it to SLO_SERIES in scripts/dashboards.ts`);
		}
		const series = SLO_SERIES[slo.id] ?? null;
		if (series === null || !Object.hasOwn(ctx.series, series)) {
			items.push({
				kind: "text",
				title: `${slo.title} (${slo.id})`,
				content:
					`**${slo.title}** (\`${slo.id}\`): ${slo.statement}.\n\n` +
					`Target: ${describeTarget(slo)}. No durable history series exists for this objective, so it is read live from \`GET /slo\` and is not drawn here.`,
			});
			continue;
		}
		items.push({
			kind: "chart",
			series,
			title: `${slo.title} (${slo.id})`,
			note: `Objective: ${slo.statement}. The threshold line is that target at the catalogue defaults (a \`SUBSTRATE_SLO_*\` override is not reflected).`,
			threshold: thresholdOf(slo),
		});
	}
	items.push(
		{
			kind: "chart",
			series: "docs.p95",
			title: `${ctx.docs.title} (${ctx.docs.id})`,
			note: `Objective: ${ctx.docs.statement}. The threshold line is that target at the catalogue default.`,
			threshold: thresholdOf(ctx.docs),
		},
		{ kind: "row", title: "Planes, cache, admission, capacity" },
		{
			kind: "chart",
			series: "plane.availability",
			title: "Plane availability",
			note: `Calls ok over every call, an open breaker, a timeout and an error all counting against it. Per-plane floor: at least ${(ctx.planeAvailability * 100).toFixed(2)} % (the live \`/slo\` judges it over a rolling hour; this is the stored history).`,
			threshold: { value: ctx.planeAvailability, direction: "floor" },
		},
		{ kind: "chart", series: "cache.hit_ratio", title: "Cache hit ratio", note: "hit / (hit + miss) over all key classes; a bypass or an error is neither. No objective." },
		{
			kind: "chart",
			series: "admission.decisions",
			title: "Admission decisions",
			note: `Counts per decision. Objective \`${ADMISSION_SLO.id}\`: ${ADMISSION_SLO.statement}, judged live by \`GET /slo\`; \`shadow_limited\` is the refusals the budgets would have made.`,
			stack: true,
			bars: true,
		},
		{
			kind: "chart",
			series: "capacity.runway_days",
			title: "Index capacity runway",
			note: `Days of index growth the volume still has. Objective: at least ${ctx.runwayDays} days at the default.`,
			threshold: { value: ctx.runwayDays, direction: "floor" },
		},
	);
	return items;
}

/** The fabric panels (phase 51): one per resource in `FABRIC_RESOURCES` that {@link FABRIC_SERIES} draws; a gap draws nothing. */
function fabricItems(): Item[] {
	const items: Item[] = [{ kind: "row", title: "Fabric resources (phase 51)" }];
	for (const resource of FABRIC_RESOURCES) {
		if (!Object.hasOwn(FABRIC_SERIES, resource)) {
			throw new Error(`fabric resource ${resource} has no dashboard entry; add it to FABRIC_SERIES in scripts/dashboards.ts`);
		}
		const drawn = FABRIC_SERIES[resource];
		if (drawn !== null) items.push({ kind: "chart", series: drawn.series, title: `Fabric: ${resource}`, note: drawn.note });
	}
	return items;
}

function planeItems(): Item[] {
	return [
		...fabricItems(),
		{ kind: "row", title: "Planes and docs" },
		{ kind: "chart", series: "brief.p50", title: "Brief latency p50", note: "Median brief duration per surface. No objective." },
		{ kind: "chart", series: "emit.p95", title: "Emit latency p95", note: "p95 of the time to append one event. No objective." },
		{ kind: "chart", series: "plane.p95", title: "Plane call latency p95", note: `Per data plane (${PLANES.join(", ")}); a refused call (breaker open) carries no duration and is not in it.` },
		{ kind: "chart", series: "docs.search", title: "Docs searches by outcome", note: "hit, empty or degraded searches per step.", stack: true, bars: true },
		{ kind: "chart", series: "planning.transition", title: "Planning transitions by outcome", note: "One record per detected planning change: applied when the change reached the ledger, refused when it did not.", stack: true, bars: true },
		{ kind: "row", title: "Extended series (needs SUBSTRATE_METRICS_HISTORY_SERIES=extended)" },
		{
			kind: "chart",
			series: "cache.operations",
			title: "Cache operations by result",
			note: "All key classes summed. `would_serve_stale` is counted only for the brief class under `SUBSTRATE_CACHE_SWR=shadow`, beside the `miss` it is a share of.",
			stack: true,
			bars: true,
		},
		{ kind: "chart", series: "brief.profile_bytes_saved", title: "Brief profile bytes saved", note: "Bytes the compact profile saves (full minus compact), fresh answers in shadow or enforce.", bars: true },
		{ kind: "chart", series: "brief.recall", title: "Brief recall results", note: "included, would_include, cold, stale, disabled, dropped_by_cap.", stack: true, bars: true },
		{ kind: "chart", series: "recall.prefetch", title: "Recall prefetch results", note: "Snapshot refreshes by result.", stack: true, bars: true },
		{ kind: "chart", series: "memory.expired", title: "Expired memory entries met", note: "served (tagged) or hidden, by what the read did.", stack: true, bars: true },
		{ kind: "chart", series: "hindsight.outbox_size", title: "Hindsight retain outbox size", note: "Parked retain forwards at the sample; the worst reading in a step." },
		{ kind: "chart", series: "hindsight.outbox_oldest_age_s", title: "Hindsight retain outbox oldest age", note: "0 for an empty outbox; the worst reading in a step." },
		{ kind: "chart", series: "index.archive_age_s", title: "Index archive age", note: "Age of the newest complete archive. No point until a first archive exists." },
		{ kind: "chart", series: "corpus.ingest_docs_per_s", title: "Corpus ingest throughput", note: "Documents per second of the last ingest request's wall time; 0 when it sent nothing. The objective is SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S." },
		{ kind: "chart", series: "corpus.golden_recall5", title: "Golden-set recall at 5", note: "As the docs canary last reported it. No point until a first report. The objective is SUBSTRATE_DOCS_SLO_RECALL5." },
	];
}

// ── Grafana JSON ─────────────────────────────────────────────────────────────

const DS_REF: JsonObject = { type: DATASOURCE_TYPE, uid: DATASOURCE_UID };

/** Panel ids and positions: two panels a row, rows full width, ids in item order from 1. */
class Layout {
	private id = 0;
	private x = 0;
	private y = 0;

	nextId(): number {
		this.id += 1;
		return this.id;
	}

	row(): JsonObject {
		if (this.x !== 0) {
			this.x = 0;
			this.y += 8;
		}
		const at = { h: 1, w: 24, x: 0, y: this.y };
		this.y += 1;
		return at;
	}

	panel(): JsonObject {
		const at = { h: 8, w: 12, x: this.x, y: this.y };
		if (this.x === 0) {
			this.x = 12;
		} else {
			this.x = 0;
			this.y += 8;
		}
		return at;
	}
}

function steps(threshold: Threshold | undefined): Json[] {
	if (threshold === undefined) return [{ color: "green", value: null }];
	return threshold.direction === "ceiling"
		? [{ color: "green", value: null }, { color: "red", value: threshold.value }]
		: [{ color: "red", value: null }, { color: "green", value: threshold.value }];
}

function chartPanel(item: Extract<Item, { kind: "chart" }>, spec: SeriesSpec, id: number, gridPos: JsonObject): JsonObject {
	const source = Object.hasOwn(SERIES_SOURCES, item.series) ? (SERIES_SOURCES[item.series] ?? null) : null;
	if (source === null) throw new Error(`series ${item.series} has no entry in SERIES_SOURCES; add its instrument to scripts/dashboards.ts`);
	const labelNote = spec.label === null ? "" : ` One line per \`${spec.label}\`.`;
	const description = `${item.note} Series \`${item.series}\` (${spec.kind}, ${spec.agg} per step, ${spec.unit}), source \`${source}\`.${labelNote}`;
	const columns: Json[] = [
		{ selector: "ts", text: "Time", type: "timestamp" },
		{ selector: "value", text: "Value", type: "number" },
	];
	if (spec.label !== null) columns.push({ selector: `labels.${spec.label}`, text: spec.label, type: "string" });
	return {
		datasource: DS_REF,
		description,
		fieldConfig: {
			defaults: {
				color: { mode: "palette-classic" },
				custom: {
					drawStyle: item.bars === true ? "bars" : "line",
					fillOpacity: item.bars === true ? 60 : 10,
					lineWidth: 1,
					showPoints: "never",
					spanNulls: false,
					stacking: { group: "A", mode: item.stack === true ? "normal" : "none" },
					thresholdsStyle: { mode: item.threshold === undefined ? "off" : "line" },
				},
				mappings: [],
				thresholds: { mode: "absolute", steps: steps(item.threshold) },
				unit: Object.hasOwn(GRAFANA_UNITS, spec.unit) ? (GRAFANA_UNITS[spec.unit] ?? "short") : "short",
			},
			overrides: [],
		},
		gridPos,
		id,
		options: {
			legend: { calcs: [], displayMode: "list", placement: "bottom", showLegend: true },
			tooltip: { mode: "multi", sort: "none" },
		},
		targets: [
			{
				columns,
				datasource: DS_REF,
				filters: [],
				format: "table",
				refId: "A",
				root_selector: "points",
				source: "url",
				type: "json",
				url: "/slo/history",
				url_options: {
					data: "",
					method: "GET",
					params: [
						{ key: "series", value: item.series },
						{ key: "window", value: "$window" },
						{ key: "step", value: "$step" },
					],
				},
			},
		],
		title: item.title,
		transformations: spec.label === null ? [] : [{ id: "partitionByValues", options: { fields: [spec.label] } }],
		type: "timeseries",
	};
}

function panels(items: Item[], series: Readonly<Record<string, SeriesSpec>>): Json[] {
	const layout = new Layout();
	const out: Json[] = [];
	// A row title is held until its first panel is drawn, so a row whose every panel was omitted is not drawn either.
	let pendingRow: string | null = null;
	for (const item of items) {
		if (item.kind === "row") {
			pendingRow = item.title;
			continue;
		}
		const spec = item.kind === "chart" && Object.hasOwn(series, item.series) ? series[item.series] : undefined;
		if (item.kind === "chart" && spec === undefined) continue;
		if (pendingRow !== null) {
			out.push({ collapsed: false, gridPos: layout.row(), id: layout.nextId(), panels: [], title: pendingRow, type: "row" });
			pendingRow = null;
		}
		if (item.kind === "text") {
			out.push({ gridPos: layout.panel(), id: layout.nextId(), options: { content: item.content, mode: "markdown" }, title: item.title, type: "text" });
		} else if (spec !== undefined) {
			out.push(chartPanel(item, spec, layout.nextId(), layout.panel()));
		}
	}
	return out;
}

function variable(name: string, label: string, options: readonly string[], selected: string): JsonObject {
	return {
		current: { selected: false, text: selected, value: selected },
		hide: 0,
		includeAll: false,
		label,
		multi: false,
		name,
		options: options.map((option) => ({ selected: option === selected, text: option, value: option })),
		query: options.join(","),
		queryValue: "",
		skipUrlSync: false,
		type: "custom",
	};
}

function checkVariables(): void {
	const ttl = parseMetricsHistoryTtl(DEFAULT_METRICS_HISTORY_TTL);
	if (ttl === null) throw new Error(`the default metrics history retention ${DEFAULT_METRICS_HISTORY_TTL} does not parse`);
	const ttlDays = ttl.days;
	for (const window of WINDOW_OPTIONS) {
		const seconds = parseHistoryWindow(window);
		if (seconds === null || seconds > ttlDays * 86_400) throw new Error(`window option ${window} is refused by /slo/history or longer than the default ${ttlDays}d retention`);
	}
	for (const step of STEP_OPTIONS) {
		if (parseHistoryStep(step) === null) throw new Error(`step option ${step} is refused by /slo/history`);
	}
	if (!(WINDOW_OPTIONS as readonly string[]).includes(DEFAULT_WINDOW) || !(STEP_OPTIONS as readonly string[]).includes(DEFAULT_STEP)) {
		throw new Error("the default window and step must be among the options");
	}
}

function dashboard(uid: string, title: string, description: string, tags: string[], body: Json[]): JsonObject {
	return {
		annotations: { list: [] },
		description,
		editable: false,
		fiscalYearStartMonth: 0,
		graphTooltip: 1,
		id: null,
		links: [],
		panels: body,
		// Each chart is its own /slo/history request and the route runs at most 16 reads at once (HISTORY_PENDING_MAX): a slow refresh keeps a loaded dashboard clear of the 503 busy answer.
		refresh: "5m",
		schemaVersion: SCHEMA_VERSION,
		tags,
		templating: { list: [variable("window", "Window", WINDOW_OPTIONS, DEFAULT_WINDOW), variable("step", "Step", STEP_OPTIONS, DEFAULT_STEP)] },
		time: { from: "now-24h", to: "now" },
		timepicker: {},
		timezone: "utc",
		title,
		uid,
		version: 1,
	};
}

// ── files ────────────────────────────────────────────────────────────────────

/** Keys sorted at every depth, so the bytes depend on the content and not on the order the code built it in. */
function sortKeys(value: Json): Json {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const sorted: JsonObject = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child !== undefined) sorted[key] = sortKeys(child);
		}
		return sorted;
	}
	return value;
}

export function renderJson(value: Json): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function datasourcesExample(): string {
	return [
		"# Grafana datasource provisioning example (generated by scripts/dashboards.ts; do not edit).",
		"#",
		"# Copy to Grafana's provisioning/datasources/ directory. Needs the Infinity plugin",
		`# (${DATASOURCE_TYPE}). The datasource reads GET <url>/slo/history, which the substrate`,
		"# serves only with SUBSTRATE_METRICS_HISTORY=on and only to a bearer.",
		"#",
		`# Nothing here is a value: Grafana interpolates \${${URL_PLACEHOLDER}} (the substrate base URL)`,
		`# and \${${BEARER_PLACEHOLDER}} (a substrate surface bearer) from ITS OWN environment. Set them in`,
		"# the environment file of the Grafana unit, never in this file or in the repository.",
		"apiVersion: 1",
		"datasources:",
		`  - name: ${DATASOURCE_NAME}`,
		`    uid: ${DATASOURCE_UID}`,
		`    type: ${DATASOURCE_TYPE}`,
		"    access: proxy",
		`    url: \${${URL_PLACEHOLDER}}`,
		"    isDefault: false",
		"    editable: false",
		"    jsonData:",
		"      auth_method: bearerToken",
		"      allowedHosts:",
		`        - \${${URL_PLACEHOLDER}}`,
		"    secureJsonData:",
		`      bearerToken: \${${BEARER_PLACEHOLDER}}`,
		"",
	].join("\n");
}

function dashboardsExample(): string {
	return [
		"# Grafana dashboard provisioning example (generated by scripts/dashboards.ts; do not edit).",
		"#",
		"# Copy to Grafana's provisioning/dashboards/ directory, and the two *.json files next to",
		"# this one to the `path` below (an absolute path on the Grafana host; adjust it).",
		"apiVersion: 1",
		"providers:",
		"  - name: substrate",
		"    orgId: 1",
		"    folder: Substrate",
		"    type: file",
		"    disableDeletion: true",
		"    allowUiUpdates: false",
		"    updateIntervalSeconds: 60",
		"    options:",
		"      path: /var/lib/grafana/dashboards/substrate",
		"",
	].join("\n");
}

export interface GeneratedFile {
	/** Relative to the output directory, forward slashes. */
	path: string;
	content: string;
}

/** Every file the generator owns, sorted by path. Pure: reads code, not the disk. */
export function buildDashboards(options: DashboardOptions = {}): GeneratedFile[] {
	checkVariables();
	const ctx = context(options);
	const slo = dashboard(
		SLO_DASHBOARD_UID,
		"Substrate SLOs",
		"Brief latency, emit success, docs search latency, plane availability, cache, admission and capacity, from GET /slo/history. Needs SUBSTRATE_METRICS_HISTORY=on. Generated by scripts/dashboards.ts; edit the generator, not this file.",
		["substrate", "slo"],
		panels(sloItems(ctx), ctx.series),
	);
	const planes = dashboard(
		PLANES_DASHBOARD_UID,
		"Substrate data planes",
		"Fabric resources (phase 51) first, one panel per resource; then per-plane latency, docs outcomes and, with SUBSTRATE_METRICS_HISTORY_SERIES=extended, cache results, brief profile and recall evidence, memory expiry and the outbox and archive gauges. Generated by scripts/dashboards.ts; edit the generator, not this file.",
		["substrate", "data-planes"],
		panels(planeItems(), ctx.series),
	);
	return [
		{ path: "provisioning/dashboards.yaml.example", content: dashboardsExample() },
		{ path: "provisioning/datasources.yaml.example", content: datasourcesExample() },
		{ path: "substrate-data-planes.json", content: renderJson(planes) },
		{ path: "substrate-slo.json", content: renderJson(slo) },
	];
}

function listFiles(dir: string, base: string = dir): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
		else out.push(relative(base, full).split("\\").join("/"));
	}
	return out.sort();
}

/** What differs between the rendered files and a directory: missing, changed and unexpected files. Empty means up to date. */
export function checkDashboards(dir: string, files: readonly GeneratedFile[]): string[] {
	const problems: string[] = [];
	const wanted = new Set(files.map((file) => file.path));
	for (const file of files) {
		const at = join(dir, file.path);
		if (!existsSync(at)) problems.push(`missing: ${file.path}`);
		else if (readFileSync(at, "utf8") !== file.content) problems.push(`out of date: ${file.path}`);
	}
	for (const present of listFiles(dir)) {
		if (!wanted.has(present)) problems.push(`unexpected: ${present}`);
	}
	return problems;
}

/** Write each file through a temporary name and a rename, so an interrupted run leaves the old file or the new one, never half of one. */
export function writeDashboards(dir: string, files: readonly GeneratedFile[]): void {
	for (const file of files) {
		const at = join(dir, file.path);
		mkdirSync(dirname(at), { recursive: true });
		const temporary = `${at}.tmp-${process.pid}`;
		writeFileSync(temporary, file.content);
		renameSync(temporary, at);
	}
}

export function main(argv: readonly string[]): number {
	let check = false;
	let out = DEFAULT_OUT_DIR;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--check") {
			check = true;
		} else if (arg === "--out") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				process.stderr.write("dashboards: --out needs a directory\n");
				return 2;
			}
			out = value;
			i += 1;
		} else {
			process.stderr.write(`dashboards: unknown argument ${arg}\nusage: bun scripts/dashboards.ts [--check] [--out DIR]\n`);
			return 2;
		}
	}
	const files = buildDashboards();
	if (check) {
		const problems = checkDashboards(out, files);
		if (problems.length === 0) {
			process.stdout.write(`dashboards: ${files.length} files up to date in ${out}\n`);
			return 0;
		}
		for (const problem of problems) process.stderr.write(`dashboards: ${problem}\n`);
		process.stderr.write("dashboards: drift; run `bun run dashboards:build` and commit the result\n");
		return 1;
	}
	writeDashboards(out, files);
	for (const stray of checkDashboards(out, files).filter((problem) => problem.startsWith("unexpected:"))) process.stderr.write(`dashboards: ${stray} (left in place)\n`);
	process.stdout.write(`dashboards: wrote ${files.length} files to ${out}\n`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
