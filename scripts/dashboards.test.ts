/**
 * The dashboards-as-code lock (uplift-5 S6). The committed Grafana files under
 * `infra/vps/dashboards/` must be exactly what `scripts/dashboards.ts` renders
 * from `sloCatalogue()`, the thresholds and the history allow-list, so a
 * threshold, a series or an objective cannot change without the dashboards
 * following. The same file checks that what is committed is a valid Grafana
 * dashboard that reads real series.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FABRIC_RESOURCES } from "../packages/mcp-server/src/fabric/types.ts";
import { ALL_METRIC_SERIES, METRIC_SERIES, parseHistoryStep, parseHistoryWindow } from "../packages/mcp-server/src/metrics-history.ts";
import { DEFAULT_THRESHOLDS, docsSearchObjective, sloCatalogue, type SloTarget } from "../packages/observability/src/index.ts";
import {
	DATASOURCE_TYPE,
	DATASOURCE_UID,
	DEFAULT_OUT_DIR,
	FABRIC_SERIES,
	SLO_SERIES,
	STEP_OPTIONS,
	WINDOW_OPTIONS,
	buildDashboards,
	checkDashboards,
	main,
	writeDashboards,
	type GeneratedFile,
} from "./dashboards.ts";

interface Panel {
	id: number;
	type: string;
	title: string;
	description?: string;
	datasource?: { type: string; uid: string };
	fieldConfig?: { defaults: { unit: string; thresholds: { steps: Array<{ color: string; value: number | null }> }; custom: { thresholdsStyle: { mode: string } } } };
	targets?: Array<{
		datasource: { type: string; uid: string };
		columns: Array<{ selector: string }>;
		url_options: { params: Array<{ key: string; value: string }> };
	}>;
	options?: { content?: string };
}

interface Dashboard {
	uid: string;
	title: string;
	schemaVersion: number;
	panels: Panel[];
	templating: { list: Array<{ name: string; query: string; current: { value: string } }> };
}

function parse(files: readonly GeneratedFile[], path: string): Dashboard {
	const file = files.find((candidate) => candidate.path === path);
	if (file === undefined) throw new Error(`no generated file ${path}`);
	return JSON.parse(file.content) as Dashboard;
}

/** The series a chart panel reads. */
function seriesOf(panel: Panel): string | null {
	return panel.targets?.[0]?.url_options.params.find((param) => param.key === "series")?.value ?? null;
}

function chartFor(dashboard: Dashboard, series: string): Panel {
	const panel = dashboard.panels.find((candidate) => seriesOf(candidate) === series);
	if (panel === undefined) throw new Error(`no panel reads ${series}`);
	return panel;
}

/** The value of the threshold line: the step that turns red (a ceiling) or green (a floor). */
function line(panel: Panel): number {
	const steps = panel.fieldConfig!.defaults.thresholds.steps;
	const step = steps.find((candidate) => candidate.value !== null);
	if (step === undefined || step.value === null) throw new Error(`panel ${panel.title} has no threshold line`);
	return step.value;
}

const SLO = "substrate-slo.json";
const PLANES = "substrate-data-planes.json";
const committed = (): GeneratedFile[] => buildDashboards();
const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "u5-s6-dashboards-"));
	scratch.push(dir);
	return dir;
}

describe("the committed dashboards are what the generator renders", () => {
	test("`--check` passes on the committed files: nothing is missing, stale or unexpected", () => {
		expect(checkDashboards(DEFAULT_OUT_DIR, committed())).toEqual([]);
	});

	test("the CLI reports drift with exit 1 and a clean tree with exit 0, never writing in --check mode", () => {
		const dir = tempDir();
		expect(main(["--out", dir])).toBe(0);
		expect(main(["--check", "--out", dir])).toBe(0);

		const before = readFileSync(join(dir, SLO), "utf8");
		writeFileSync(join(dir, SLO), before.replace('"value": 800', '"value": 801'));
		expect(main(["--check", "--out", dir])).toBe(1);
		// The check did not repair what it found.
		expect(readFileSync(join(dir, SLO), "utf8")).not.toBe(before);
		// Writing again does.
		expect(main(["--out", dir])).toBe(0);
		expect(readFileSync(join(dir, SLO), "utf8")).toBe(before);

		writeFileSync(join(dir, "stray.json"), "{}\n");
		expect(checkDashboards(dir, committed())).toEqual(["unexpected: stray.json"]);
		expect(main(["--check", "--out", dir])).toBe(1);

		expect(main(["--check", "--bogus"])).toBe(2);
		expect(main(["--out"])).toBe(2);
	});

	test("an edit to the catalogue makes `--check` fail: a moved threshold is drift, and so is a different objective", () => {
		const moved = buildDashboards({ thresholds: { briefP95Ms: 600 } });
		const problems = checkDashboards(DEFAULT_OUT_DIR, moved);
		expect(problems).toEqual([`out of date: ${SLO}`]);
		expect(line(chartFor(parse(moved, SLO), "brief.p95"))).toBe(600);

		const catalogue = sloCatalogue().map((target): SloTarget => (target.id === "emit.success" && target.kind === "ratio-floor" ? { ...target, target: 0.999 } : target));
		expect(checkDashboards(DEFAULT_OUT_DIR, buildDashboards({ catalogue }))).toEqual([`out of date: ${SLO}`]);

		const docs = buildDashboards({ thresholds: { docsSearchP95Ms: 1000 } });
		expect(line(chartFor(parse(docs, SLO), "docs.p95"))).toBe(1000);
		expect(checkDashboards(DEFAULT_OUT_DIR, docs)).toEqual([`out of date: ${SLO}`]);
	});

	test("an allow-list edit is drift too: a series that leaves it takes its panel with it, and an extended-only row disappears with its last panel", () => {
		const { "cache.operations": _removed, ...rest } = ALL_METRIC_SERIES;
		const fewer = buildDashboards({ series: rest });
		expect(checkDashboards(DEFAULT_OUT_DIR, fewer)).toEqual([`out of date: ${PLANES}`]);
		expect(parse(fewer, PLANES).panels.some((panel) => seriesOf(panel) === "cache.operations")).toBe(false);

		const coreOnly = buildDashboards({ series: METRIC_SERIES });
		const planes = parse(coreOnly, PLANES);
		expect(planes.panels.filter((panel) => panel.type === "row").map((panel) => panel.title)).toEqual(["Planes and docs"]);
		for (const panel of planes.panels) {
			const series = seriesOf(panel);
			if (series !== null) expect(Object.hasOwn(METRIC_SERIES, series)).toBe(true);
		}
	});

	test("an objective with no dashboard decision is refused by name rather than left off the dashboard", () => {
		const unknown: SloTarget = { ...sloCatalogue()[1]!, id: "invented.objective", title: "Invented" };
		expect(Object.hasOwn(SLO_SERIES, unknown.id)).toBe(false);
		expect(() => buildDashboards({ catalogue: [...sloCatalogue(), unknown] })).toThrow("invented.objective");
	});

	test("the output is deterministic: two renders are byte-identical, keys are sorted at every depth, every file ends in one newline", () => {
		expect(buildDashboards()).toEqual(buildDashboards());
		const assertSorted = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) assertSorted(item);
			} else if (value !== null && typeof value === "object") {
				const keys = Object.keys(value);
				expect(keys).toEqual([...keys].sort());
				for (const item of Object.values(value)) assertSorted(item);
			}
		};
		for (const file of committed().filter((candidate) => candidate.path.endsWith(".json"))) {
			assertSorted(JSON.parse(file.content));
			expect(file.content.endsWith("}\n")).toBe(true);
			expect(file.content.endsWith("\n\n")).toBe(false);
		}
		expect(committed().map((file) => file.path)).toEqual([
			"provisioning/dashboards.yaml.example",
			"provisioning/datasources.yaml.example",
			"substrate-data-planes.json",
			"substrate-slo.json",
		]);
	});

	test("a write replaces a stale file in place and leaves no temporary file behind", () => {
		const dir = tempDir();
		writeFileSync(join(dir, PLANES), "stale\n");
		writeDashboards(dir, committed());
		expect(checkDashboards(dir, committed())).toEqual([]);
	});
});

describe("the committed JSON is a valid Grafana dashboard", () => {
	const dashboards: Array<[string, Dashboard]> = [
		[SLO, parse(committed(), SLO)],
		[PLANES, parse(committed(), PLANES)],
	];

	test("stable uids and a fixed schemaVersion; panel ids are unique and count up from 1 in layout order", () => {
		expect(dashboards.map(([, dashboard]) => dashboard.uid)).toEqual(["substrate-slo", "substrate-data-planes"]);
		for (const [, dashboard] of dashboards) {
			expect(dashboard.schemaVersion).toBe(39);
			expect(dashboard.panels.map((panel) => panel.id)).toEqual(dashboard.panels.map((_, index) => index + 1));
			for (const panel of dashboard.panels) expect(panel.title.length).toBeGreaterThan(0);
		}
	});

	test("every datasource reference resolves to the provisioning example, which carries its uid and type and no value of ours", () => {
		const example = committed().find((file) => file.path === "provisioning/datasources.yaml.example")!.content;
		expect(example).toContain(`uid: ${DATASOURCE_UID}`);
		expect(example).toContain(`type: ${DATASOURCE_TYPE}`);
		for (const [, dashboard] of dashboards) {
			for (const panel of dashboard.panels.filter((candidate) => candidate.type === "timeseries")) {
				expect(panel.datasource).toEqual({ type: DATASOURCE_TYPE, uid: DATASOURCE_UID });
				for (const target of panel.targets!) expect(target.datasource).toEqual({ type: DATASOURCE_TYPE, uid: DATASOURCE_UID });
			}
		}
	});

	test("the provisioning examples hold placeholders only: no scheme, no host, no literal bearer, no assignment a token scan would catch", () => {
		for (const file of committed().filter((candidate) => candidate.path.startsWith("provisioning/"))) {
			const body = file.content;
			expect(body).not.toMatch(/https?:\/\//);
			expect(body).not.toMatch(/\bBearer\s+[A-Za-z0-9]/);
			expect(body).not.toMatch(/\.(?:ts\.net|up\.railway\.app|internal|local)\b/);
			// The token scan in store-lock.test.ts: a name followed by 16+ value characters.
			expect(body).not.toMatch(/SUBSTRATE_TOKEN[A-Z0-9_]*["']?[ \t]*[:=][ \t]*["']?[\w.~+/=-]{16,}/);
		}
		const datasource = committed().find((file) => file.path === "provisioning/datasources.yaml.example")!.content;
		expect(datasource).toMatch(/^ {4}url: \$\{[A-Z_]+\}$/m);
		expect(datasource).toMatch(/^ {6}bearerToken: \$\{[A-Z_]+\}$/m);
	});

	test("every chart reads one series of the allow-list, with its unit and label taken from that series' own spec", () => {
		const units: Record<string, string> = { ms: "ms", ratio: "percentunit", days: "d", s: "s", By: "bytes" };
		for (const [, dashboard] of dashboards) {
			for (const panel of dashboard.panels.filter((candidate) => candidate.type === "timeseries")) {
				const series = seriesOf(panel)!;
				expect(Object.hasOwn(ALL_METRIC_SERIES, series)).toBe(true);
				const spec = ALL_METRIC_SERIES[series]!;
				expect(panel.fieldConfig!.defaults.unit).toBe(units[spec.unit] ?? "short");
				const selectors = panel.targets![0]!.columns.map((column) => column.selector);
				expect(selectors).toEqual(spec.label === null ? ["ts", "value"] : ["ts", "value", `labels.${spec.label}`]);
				// The route's own parameters: a series, and the two dashboard variables.
				expect(panel.targets![0]!.url_options.params.map((param) => param.key)).toEqual(["series", "window", "step"]);
				expect(panel.description).toContain(`\`${series}\``);
			}
		}
	});

	test("every series the code records is drawn somewhere, so a new series cannot ship without a panel", () => {
		const drawn = new Set(dashboards.flatMap(([, dashboard]) => dashboard.panels.map(seriesOf)).filter((series): series is string => series !== null));
		expect([...drawn].sort()).toEqual(Object.keys(ALL_METRIC_SERIES).sort());
	});

	test("the window and step variables are values the route accepts, the default is among them, and no window outruns the default retention", () => {
		for (const [, dashboard] of dashboards) {
			const window = dashboard.templating.list.find((variable) => variable.name === "window")!;
			const step = dashboard.templating.list.find((variable) => variable.name === "step")!;
			expect(window.query.split(",")).toEqual([...WINDOW_OPTIONS]);
			expect(step.query.split(",")).toEqual([...STEP_OPTIONS]);
			expect(window.query.split(",")).toContain(window.current.value);
			expect(step.query.split(",")).toContain(step.current.value);
			for (const option of WINDOW_OPTIONS) expect(parseHistoryWindow(option)).toBeLessThanOrEqual(14 * 86_400);
			for (const option of STEP_OPTIONS) expect(parseHistoryStep(option)).not.toBeNull();
			for (const option of WINDOW_OPTIONS) expect(parseHistoryWindow(option)).not.toBeNull();
		}
	});
});

describe("the threshold lines are the catalogue's targets", () => {
	const slo = parse(committed(), SLO);
	const catalogue = sloCatalogue();
	const byId = (id: string): SloTarget => catalogue.find((target) => target.id === id)!;

	test("brief p95 is the catalogue's millisecond ceiling and the docs search p95 is the docs objective's", () => {
		const brief = byId("brief.p95");
		if (brief.kind !== "latency-quantile") throw new Error("brief.p95 is a latency objective");
		const panel = chartFor(slo, "brief.p95");
		expect(line(panel)).toBe(brief.thresholdMs);
		expect(line(panel)).toBe(DEFAULT_THRESHOLDS.briefP95Ms);
		// A ceiling is green under the line and red from it.
		expect(panel.fieldConfig!.defaults.thresholds.steps.map((step) => step.color)).toEqual(["green", "red"]);
		expect(panel.fieldConfig!.defaults.custom.thresholdsStyle.mode).toBe("line");
		expect(panel.description).toContain(brief.statement);

		const docs = docsSearchObjective();
		if (docs.kind !== "latency-quantile") throw new Error("docs.search.p95 is a latency objective");
		expect(line(chartFor(slo, "docs.p95"))).toBe(docs.thresholdMs);
	});

	test("emit success is the catalogue's ratio floor: red below the line, green from it", () => {
		const emit = byId("emit.success");
		if (emit.kind !== "ratio-floor") throw new Error("emit.success is a floor");
		const panel = chartFor(slo, "emit.success");
		expect(line(panel)).toBe(emit.target);
		expect(line(panel)).toBe(DEFAULT_THRESHOLDS.emitSuccessRatio);
		expect(panel.fieldConfig!.defaults.thresholds.steps.map((step) => step.color)).toEqual(["red", "green"]);
	});

	test("plane availability and capacity runway use the thresholds the evaluators use; cache hit ratio, which has no objective, draws no line", () => {
		expect(line(chartFor(slo, "plane.availability"))).toBe(DEFAULT_THRESHOLDS.planeAvailability);
		expect(line(chartFor(slo, "capacity.runway_days"))).toBe(DEFAULT_THRESHOLDS.runwayDays);
		const cache = chartFor(slo, "cache.hit_ratio");
		expect(cache.fieldConfig!.defaults.custom.thresholdsStyle.mode).toBe("off");
		expect(cache.fieldConfig!.defaults.thresholds.steps).toEqual([{ color: "green", value: null }]);
	});

	test("the objectives with no durable series say so, with their catalogue target, instead of drawing an empty chart", () => {
		for (const id of ["lease.steal_rate", "quarantine.rate"]) {
			const target = byId(id);
			if (target.kind !== "ratio-ceiling") throw new Error(`${id} is a ceiling`);
			const panel = slo.panels.find((candidate) => candidate.title.includes(`(${id})`))!;
			expect(panel.type).toBe("text");
			expect(panel.options!.content).toContain(`at most ${(target.target * 100).toFixed(2)} %`);
			expect(panel.options!.content).toContain("/slo");
			expect(SLO_SERIES[id]).toBeNull();
		}
	});

	test("every catalogue objective appears on the SLO dashboard, once", () => {
		for (const target of catalogue) {
			expect(slo.panels.filter((panel) => panel.title.includes(`(${target.id})`))).toHaveLength(1);
		}
	});

	test("an objective whose series the build does not carry degrades to its text panel rather than a chart against a 400", () => {
		const { "emit.success": _gone, ...rest } = ALL_METRIC_SERIES;
		const degraded = parse(buildDashboards({ series: rest }), SLO);
		const panel = degraded.panels.find((candidate) => candidate.title.includes("(emit.success)"))!;
		expect(panel.type).toBe("text");
		expect(panel.options!.content).toContain("99.50 %");
	});
});

describe("the fabric panels (phase 51)", () => {
	test("each fabric resource draws one panel of an existing series, and the gap draws none", () => {
		const planes = parse(buildDashboards(), "substrate-data-planes.json");
		expect(FABRIC_RESOURCES.filter((resource) => FABRIC_SERIES[resource] === null)).toEqual(["tailscale-proxy"]);
		for (const resource of FABRIC_RESOURCES) {
			const panels = planes.panels.filter((panel) => panel.title === `Fabric: ${resource}`);
			if (FABRIC_SERIES[resource] === null) {
				expect(panels).toEqual([]);
				continue;
			}
			expect(panels).toHaveLength(1);
			const series = seriesOf(panels[0]!);
			expect(series).not.toBeNull();
			expect(Object.hasOwn(ALL_METRIC_SERIES, series ?? "")).toBe(true);
		}
	});
});
