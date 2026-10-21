/**
 * Railway control plane (Phase 45, D45-a to D45-o).
 *
 * The client calls Railway's public GraphQL API with a bearer token read from
 * RAILWAY_API_TOKEN. It never goes through the Tailscale forwarders, which carry
 * data-plane traffic only. The decisions (scale suggestion, cost arithmetic,
 * write refusal, bounds) are pure functions here so they can be checked without
 * a network. The token is read at call time and is never placed in an error,
 * a log, or a returned object.
 */

export const RAILWAY_API_URL = "https://backboard.railway.app/graphql/v2";
export const RAILWAY_DEFAULT_BUDGET_USD = 50;
export const RAILWAY_COST_CACHE_MS = 900_000;
export const RAILWAY_REQUEST_TIMEOUT_MS = 5_000;
export const RAILWAY_SCALE_MIN_SAMPLES = 24;
export const RAILWAY_SCALE_QUANTUM = 0.25;
export const COST_MEASUREMENTS = ["CPU_USAGE", "MEMORY_USAGE_GB", "DISK_USAGE_GB", "NETWORK_TX_GB"] as const;
export type CostMeasurement = (typeof COST_MEASUREMENTS)[number];

const SCALE_SAMPLE_RATE_SECONDS = 300;
const SCALE_AVERAGING_WINDOW_SECONDS = 300;
const DEFAULT_MIN_VCPUS = 0.25;
const DEFAULT_MAX_VCPUS = 4;
const DEFAULT_MIN_MEMORY_GB = 0.25;
const DEFAULT_MAX_MEMORY_GB = 8;
const DEFAULT_HEADROOM = 0.3;
const DEFAULT_WINDOW_SECONDS = 86_400;
const RAILWAY_PAGE_SIZE = 100; // the `first:` of every connection read below, and the size at which a read may be truncated

const PRICE_ENV: Readonly<Record<CostMeasurement, string>> = {
	CPU_USAGE: "SUBSTRATE_RAILWAY_PRICE_CPU_USD",
	MEMORY_USAGE_GB: "SUBSTRATE_RAILWAY_PRICE_MEMORY_GB_USD",
	DISK_USAGE_GB: "SUBSTRATE_RAILWAY_PRICE_DISK_GB_USD",
	NETWORK_TX_GB: "SUBSTRATE_RAILWAY_PRICE_NETWORK_TX_GB_USD",
};

export interface ScaleBounds {
	readonly minVcpus: number;
	readonly maxVcpus: number;
	readonly minMemoryGb: number;
	readonly maxMemoryGb: number;
}

export interface RailwayConfig {
	readonly apiToken: string | null; // RAILWAY_API_TOKEN, trimmed; null when unset
	readonly writesEnabled: boolean; // SUBSTRATE_RAILWAY_WRITES === "on" exactly
	readonly budgetUsd: number; // SUBSTRATE_RAILWAY_BUDGET_USD, default RAILWAY_DEFAULT_BUDGET_USD
	readonly projectIds: readonly string[]; // SUBSTRATE_RAILWAY_PROJECT_IDS, comma list, trimmed, empty and repeated ids dropped
	readonly prices: Readonly<Partial<Record<CostMeasurement, number>>>; // USD per unit; unset key = unpriced
	readonly scale: ScaleBounds & { readonly headroom: number; readonly windowSeconds: number };
}

function positiveNumber(raw: string | undefined): number | null {
	const trimmed = raw?.trim() ?? "";
	const value = Number(trimmed);
	return trimmed !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

function unitInterval(raw: string | undefined): number | null {
	const trimmed = raw?.trim() ?? "";
	const value = Number(trimmed);
	return trimmed !== "" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function pricesFromEnv(env: Record<string, string | undefined>): Partial<Record<CostMeasurement, number>> {
	const prices: Partial<Record<CostMeasurement, number>> = {};
	for (const measurement of COST_MEASUREMENTS) {
		const price = positiveNumber(env[PRICE_ENV[measurement]]);
		if (price !== null) prices[measurement] = price;
	}
	return prices;
}

/** Reads the SUBSTRATE_RAILWAY_* names and RAILWAY_API_TOKEN from `env`. Never throws; an invalid value takes its default. */
export function railwayFromEnv(env: Record<string, string | undefined> = process.env): RailwayConfig {
	const token = env.RAILWAY_API_TOKEN?.trim() ?? "";
	return {
		apiToken: token === "" ? null : token,
		writesEnabled: env.SUBSTRATE_RAILWAY_WRITES === "on",
		budgetUsd: positiveNumber(env.SUBSTRATE_RAILWAY_BUDGET_USD) ?? RAILWAY_DEFAULT_BUDGET_USD,
		projectIds: [
			...new Set(
				(env.SUBSTRATE_RAILWAY_PROJECT_IDS ?? "")
					.split(",")
					.map((id) => id.trim())
					.filter((id) => id !== ""),
			),
		],
		prices: pricesFromEnv(env),
		scale: {
			minVcpus: positiveNumber(env.SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS) ?? DEFAULT_MIN_VCPUS,
			maxVcpus: positiveNumber(env.SUBSTRATE_RAILWAY_SCALE_MAX_VCPUS) ?? DEFAULT_MAX_VCPUS,
			minMemoryGb: positiveNumber(env.SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB) ?? DEFAULT_MIN_MEMORY_GB,
			maxMemoryGb: positiveNumber(env.SUBSTRATE_RAILWAY_SCALE_MAX_MEMORY_GB) ?? DEFAULT_MAX_MEMORY_GB,
			headroom: unitInterval(env.SUBSTRATE_RAILWAY_SCALE_HEADROOM) ?? DEFAULT_HEADROOM,
			windowSeconds: positiveNumber(env.SUBSTRATE_RAILWAY_SCALE_WINDOW_SECONDS) ?? DEFAULT_WINDOW_SECONDS,
		},
	};
}

export interface ServiceRef {
	readonly environmentId: string;
	readonly serviceId: string;
}

export interface RailwayResources {
	readonly projects: readonly {
		readonly id: string;
		readonly name: string;
		readonly environments: readonly { readonly id: string; readonly name: string; readonly isEphemeral: boolean }[];
		readonly services: readonly { readonly id: string; readonly name: string }[];
	}[];
	readonly truncated: boolean; // true when a page of RAILWAY_PAGE_SIZE items was full: later items may exist and were not read
}

export interface RailwayMonitor {
	readonly environmentId: string;
	readonly serviceId: string;
	readonly serviceName: string | null;
	readonly numReplicas: number | null;
	readonly region: string | null;
	readonly latestDeployment: { readonly id: string; readonly status: string; readonly createdAt: string } | null;
}

export type ScaleStatus = "ok" | "insufficient-data";
export interface ScaleSuggestion {
	readonly status: ScaleStatus;
	readonly current: { readonly vCPUs: number | null; readonly memoryGB: number | null };
	readonly p95: { readonly vCPUs: number | null; readonly memoryGB: number | null };
	readonly suggested: { readonly vCPUs: number; readonly memoryGB: number } | null;
	readonly samples: number;
	readonly windowSeconds: number;
	readonly detail: string;
}

export type WriteRefusal = "writes-disabled" | "operator-required" | "approval-ref-missing" | "unconfigured" | "out-of-bounds";
export interface WriteGate {
	readonly isOperator: boolean;
	readonly approvalRef: string | null;
}
export interface WriteLimits {
	readonly vCPUs: number;
	readonly memoryGB: number;
}
export type WriteOutcome = { readonly applied: true } | { readonly applied: false; readonly refusal: WriteRefusal };

/** Gate checks in this order: unconfigured (no token), writes-disabled, operator-required, approval-ref-missing. Null = pass. */
export function writeRefusal(config: RailwayConfig, gate: WriteGate): WriteRefusal | null {
	if (config.apiToken === null || config.apiToken === "") return "unconfigured";
	if (!config.writesEnabled) return "writes-disabled";
	if (!gate.isOperator) return "operator-required";
	if (gate.approvalRef === null || !approvalRefValid(gate.approvalRef)) return "approval-ref-missing";
	return null;
}

/** "out-of-bounds" when a value is outside the scale bounds (inclusive); null = pass. A non-finite value is out of bounds. */
export function boundsRefusal(bounds: ScaleBounds, limits: WriteLimits): WriteRefusal | null {
	const vcpuOk = Number.isFinite(limits.vCPUs) && limits.vCPUs >= bounds.minVcpus && limits.vCPUs <= bounds.maxVcpus;
	const memoryOk = Number.isFinite(limits.memoryGB) && limits.memoryGB >= bounds.minMemoryGb && limits.memoryGB <= bounds.maxMemoryGb;
	return vcpuOk && memoryOk ? null : "out-of-bounds";
}

/** The first inverted scale pair, named by its environment variables; null when every minimum is at most its maximum. */
export function scaleBoundsError(scale: ScaleBounds): string | null {
	if (scale.minVcpus > scale.maxVcpus) {
		return `SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS (${scale.minVcpus}) is above SUBSTRATE_RAILWAY_SCALE_MAX_VCPUS (${scale.maxVcpus}).`;
	}
	if (scale.minMemoryGb > scale.maxMemoryGb) {
		return `SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB (${scale.minMemoryGb}) is above SUBSTRATE_RAILWAY_SCALE_MAX_MEMORY_GB (${scale.maxMemoryGb}).`;
	}
	return null;
}

/** True when the ref matches ^[A-Za-z0-9._:/#-]{1,128}$. */
export function approvalRefValid(ref: string): boolean {
	return /^[A-Za-z0-9._:/#-]{1,128}$/.test(ref);
}

/** Nearest-rank p95; null for an empty input. */
export function p95(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((95 * sorted.length) / 100);
	return sorted[rank - 1] ?? null;
}

/** Ceil to a multiple of `quantum` (default RAILWAY_SCALE_QUANTUM); tolerant of float error (ceil(x/q - 1e-9) * q). */
export function roundUpToQuantum(value: number, quantum = RAILWAY_SCALE_QUANTUM): number {
	const steps = Math.ceil(value / quantum - 1e-9);
	return steps === 0 ? 0 : steps * quantum;
}

export interface SuggestScaleInput {
	readonly cpu: readonly number[]; // CPU_USAGE samples
	readonly memoryGb: readonly number[]; // MEMORY_USAGE_GB samples
	readonly currentVcpus: number | null; // newest CPU_LIMIT sample
	readonly currentMemoryGb: number | null; // newest MEMORY_LIMIT_GB sample
	readonly scale: ScaleBounds & { readonly headroom: number; readonly windowSeconds: number };
}

/** Pure. insufficient-data when either series has < RAILWAY_SCALE_MIN_SAMPLES or a limit is null; never guesses. */
export function suggestScale(input: SuggestScaleInput): ScaleSuggestion {
	const { scale } = input;
	const samples = Math.min(input.cpu.length, input.memoryGb.length);
	const enough = input.cpu.length >= RAILWAY_SCALE_MIN_SAMPLES && input.memoryGb.length >= RAILWAY_SCALE_MIN_SAMPLES;
	const usage = {
		vCPUs: enough ? p95(input.cpu) : null,
		memoryGB: enough ? p95(input.memoryGb) : null,
	};
	const current = { vCPUs: input.currentVcpus, memoryGB: input.currentMemoryGb };
	if (usage.vCPUs === null || usage.memoryGB === null || current.vCPUs === null || current.memoryGB === null) {
		return {
			status: "insufficient-data",
			current,
			p95: usage,
			suggested: null,
			samples,
			windowSeconds: scale.windowSeconds,
			detail: `Not enough data: at least ${RAILWAY_SCALE_MIN_SAMPLES} samples of each usage series and both current limits are needed. Nothing is suggested.`,
		};
	}
	const vCPUs = roundUpToQuantum(usage.vCPUs * (1 + scale.headroom));
	const memoryGB = roundUpToQuantum(usage.memoryGB * (1 + scale.headroom));
	return {
		status: "ok",
		current,
		p95: usage,
		suggested: {
			vCPUs: Math.min(Math.max(vCPUs, scale.minVcpus), scale.maxVcpus),
			memoryGB: Math.min(Math.max(memoryGB, scale.minMemoryGb), scale.maxMemoryGb),
		},
		samples,
		windowSeconds: scale.windowSeconds,
		detail: `Advisory only: the p95 of ${samples} samples over ${scale.windowSeconds} s plus ${scale.headroom} headroom, clamped to the configured bounds. Nothing is applied.`,
	};
}

export type CostStatus = "ok" | "over-budget" | "unpriced" | "unavailable" | "unconfigured";
export interface CostLine {
	readonly measurement: CostMeasurement;
	readonly estimatedValue: number; // summed over projects
	readonly unitPriceUsd: number | null;
	readonly costUsd: number | null;
}
export interface CostReport {
	readonly status: CostStatus;
	readonly budgetUsd: number;
	readonly projectedMonthlyUsd: number | null;
	readonly lines: readonly CostLine[];
	readonly detail: string;
	readonly generatedAt: string | null;
}

/** Pure. Rows whose measurement is not in COST_MEASUREMENTS are skipped. Any line with value > 0 and no price => unpriced (lines kept, projectedMonthlyUsd null). over-budget when total > budgetUsd. */
export function buildCostReport(input: {
	readonly usage: readonly { readonly measurement: string; readonly estimatedValue: number }[];
	readonly prices: Readonly<Partial<Record<CostMeasurement, number>>>;
	readonly budgetUsd: number;
	readonly configured: boolean;
	readonly generatedAt: string;
}): CostReport {
	if (!input.configured) {
		return {
			status: "unconfigured",
			budgetUsd: input.budgetUsd,
			projectedMonthlyUsd: null,
			lines: [],
			detail: "Railway is not configured: RAILWAY_API_TOKEN and SUBSTRATE_RAILWAY_PROJECT_IDS are both needed.",
			generatedAt: input.generatedAt,
		};
	}
	const lines: CostLine[] = COST_MEASUREMENTS.map((measurement) => {
		const estimatedValue = input.usage
			.filter((row) => row.measurement === measurement)
			.reduce((sum, row) => sum + row.estimatedValue, 0);
		const unitPriceUsd = input.prices[measurement] ?? null;
		return { measurement, estimatedValue, unitPriceUsd, costUsd: unitPriceUsd === null ? null : estimatedValue * unitPriceUsd };
	});
	if (lines.some((line) => line.estimatedValue > 0 && line.unitPriceUsd === null)) {
		return {
			status: "unpriced",
			budgetUsd: input.budgetUsd,
			projectedMonthlyUsd: null,
			lines,
			detail: "A measured line has no unit price, so no total is projected. Set its SUBSTRATE_RAILWAY_PRICE_*_USD value.",
			generatedAt: input.generatedAt,
		};
	}
	const total = lines.reduce((sum, line) => sum + (line.costUsd ?? 0), 0);
	const overBudget = total > input.budgetUsd;
	return {
		status: overBudget ? "over-budget" : "ok",
		budgetUsd: input.budgetUsd,
		projectedMonthlyUsd: total,
		lines,
		detail: overBudget ? "Projected total is above the budget." : "Projected total is within the budget.",
		generatedAt: input.generatedAt,
	};
}

export type RailwayErrorKind = "not-configured" | "configuration" | "transport" | "graphql" | "shape";

export class RailwayRequestError extends Error {
	readonly kind: RailwayErrorKind;

	constructor(kind: RailwayErrorKind, message: string) {
		super(message);
		this.name = "RailwayRequestError";
		this.kind = kind;
	}
}

export type RailwayFetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface Sample {
	readonly ts: number;
	readonly value: number;
}

const PROJECT_FIELDS = `id name environments(first: ${RAILWAY_PAGE_SIZE}) { edges { node { id name isEphemeral } } } services(first: ${RAILWAY_PAGE_SIZE}) { edges { node { id name } } }`;
const PROJECTS_QUERY = `query { projects(first: ${RAILWAY_PAGE_SIZE}) { edges { node { ${PROJECT_FIELDS} } } } }`;
const PROJECT_QUERY = `query ($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`;
const MONITOR_QUERY =
	"query ($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { serviceId serviceName environmentId numReplicas region latestDeployment { id status createdAt } } }";
const METRICS_QUERY = `query ($environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!) { metrics(measurements: [CPU_USAGE, MEMORY_USAGE_GB, CPU_LIMIT, MEMORY_LIMIT_GB], environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, sampleRateSeconds: ${SCALE_SAMPLE_RATE_SECONDS}, averagingWindowSeconds: ${SCALE_AVERAGING_WINDOW_SECONDS}) { measurement values { ts value } } }`;
const ESTIMATE_QUERY = `query ($projectId: String!) { estimatedUsage(measurements: [${COST_MEASUREMENTS.join(", ")}], projectId: $projectId) { measurement estimatedValue projectId } }`;
const SET_LIMITS_MUTATION = "mutation ($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }";
const REDEPLOY_MUTATION = "mutation ($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }";

/** The module's one object guard. Fields behind it stay `unknown` until checked with the helpers below. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(where: string): RailwayRequestError {
	return new RailwayRequestError("shape", `Railway API response has an unexpected shape at ${where}`);
}

function recordAt(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value)) throw shapeError(where);
	return value;
}

function stringAt(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw shapeError(key);
	return value;
}

function nullableStringAt(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw shapeError(key);
	return value;
}

function numberAt(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw shapeError(key);
	return value;
}

function nullableNumberAt(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) throw shapeError(key);
	return value;
}

function booleanAt(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw shapeError(key);
	return value;
}

/** The node of every edge in a connection; a missing or malformed edge is a shape error. */
function nodesOf(connection: unknown, where: string): Record<string, unknown>[] {
	const edges = recordAt(connection, where).edges;
	if (!Array.isArray(edges)) throw shapeError(where);
	return edges.map((edge) => recordAt(recordAt(edge, where).node, where));
}

/** True when a project's environments or services page is full, so items beyond it may exist and were not read. */
function projectIsTruncated(node: Record<string, unknown>): boolean {
	const environments = nodesOf(node.environments, "environments").length;
	const services = nodesOf(node.services, "services").length;
	return environments >= RAILWAY_PAGE_SIZE || services >= RAILWAY_PAGE_SIZE;
}

function parseEnvironment(node: Record<string, unknown>) {
	return { id: stringAt(node, "id"), name: stringAt(node, "name"), isEphemeral: booleanAt(node, "isEphemeral") };
}

function parseService(node: Record<string, unknown>) {
	return { id: stringAt(node, "id"), name: stringAt(node, "name") };
}

function parseProject(node: Record<string, unknown>): RailwayResources["projects"][number] {
	return {
		id: stringAt(node, "id"),
		name: stringAt(node, "name"),
		environments: nodesOf(node.environments, "environments").map(parseEnvironment),
		services: nodesOf(node.services, "services").map(parseService),
	};
}

function parseMetrics(value: unknown): Map<string, Sample[]> {
	if (!Array.isArray(value)) throw shapeError("metrics");
	const series = new Map<string, Sample[]>();
	for (const item of value) {
		const result = recordAt(item, "metrics");
		const measurement = stringAt(result, "measurement");
		if (!Array.isArray(result.values)) throw shapeError("values");
		const samples = result.values.map((sample) => {
			const record = recordAt(sample, "values");
			return { ts: numberAt(record, "ts"), value: numberAt(record, "value") };
		});
		series.set(measurement, [...(series.get(measurement) ?? []), ...samples]);
	}
	return series;
}

function parseEstimates(value: unknown): { measurement: string; estimatedValue: number }[] {
	if (!Array.isArray(value)) throw shapeError("estimatedUsage");
	return value.map((item) => {
		const record = recordAt(item, "estimatedUsage");
		return { measurement: stringAt(record, "measurement"), estimatedValue: numberAt(record, "estimatedValue") };
	});
}

function latestValue(samples: readonly Sample[] | undefined): number | null {
	let latest: Sample | null = null;
	for (const sample of samples ?? []) {
		if (latest === null || sample.ts > latest.ts) latest = sample;
	}
	return latest === null ? null : latest.value;
}

function parseJson(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		return undefined;
	}
}

/**
 * One line per GraphQL error: its message and trace id. The token is removed here,
 * the only place an error text is built, and the text is bounded in length.
 */
function graphqlFailures(parsed: unknown, token: string): string[] {
	if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return [];
	return parsed.errors.map((item) => {
		const record: Record<string, unknown> = isRecord(item) ? item : {};
		const extensions: Record<string, unknown> = isRecord(record.extensions) ? record.extensions : {};
		const message = typeof record.message === "string" ? record.message : "unrecognised error";
		const trace = typeof extensions.traceId === "string" ? ` (trace ${extensions.traceId})` : "";
		return `${message}${trace}`.split(token).join("[redacted]").slice(0, 300);
	});
}

function refused(refusal: WriteRefusal): WriteOutcome {
	return { applied: false, refusal };
}

function requireTrue(data: Record<string, unknown>, key: string): WriteOutcome {
	if (data[key] !== true) throw shapeError(key);
	return { applied: true };
}

/** Settles with `work`, or rejects with the signal's reason when the signal aborts first, so a deadline holds even for a call that ignores its signal. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

interface CostCache {
	readonly at: number;
	readonly report: CostReport;
}

export class RailwayClient {
	private readonly config: RailwayConfig;
	private readonly fetchImpl: RailwayFetch;
	private readonly now: () => Date;
	private readonly timeoutMs: number;
	private cost: CostCache | null = null;
	private costInFlight: Promise<CostReport> | null = null;

	constructor(config: RailwayConfig, options: { readonly fetch?: RailwayFetch; readonly now?: () => Date; readonly timeoutMs?: number } = {}) {
		this.config = config;
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = options.timeoutMs ?? RAILWAY_REQUEST_TIMEOUT_MS;
	}

	/** Rejects RailwayRequestError on failure. */
	async listResources(): Promise<RailwayResources> {
		const token = this.requireToken();
		const projectIds = this.config.projectIds;
		if (projectIds.length === 0) {
			const data = await this.send(token, PROJECTS_QUERY, {});
			const nodes = nodesOf(data.projects, "projects");
			return { projects: nodes.map(parseProject), truncated: nodes.length >= RAILWAY_PAGE_SIZE || nodes.some(projectIsTruncated) };
		}
		const projects: RailwayResources["projects"][number][] = [];
		let truncated = false;
		for (const id of projectIds) {
			const data = await this.send(token, PROJECT_QUERY, { id });
			const node = recordAt(data.project, "project");
			projects.push(parseProject(node));
			truncated = truncated || projectIsTruncated(node);
		}
		return { projects, truncated };
	}

	/** Rejects RailwayRequestError on failure. */
	async monitor(ref: ServiceRef): Promise<RailwayMonitor> {
		const token = this.requireToken();
		const data = await this.send(token, MONITOR_QUERY, { environmentId: ref.environmentId, serviceId: ref.serviceId });
		const instance = recordAt(data.serviceInstance, "serviceInstance");
		const latest = instance.latestDeployment;
		const deployment = latest === null || latest === undefined ? null : recordAt(latest, "latestDeployment");
		return {
			environmentId: ref.environmentId,
			serviceId: ref.serviceId,
			serviceName: nullableStringAt(instance, "serviceName"),
			numReplicas: nullableNumberAt(instance, "numReplicas"),
			region: nullableStringAt(instance, "region"),
			latestDeployment:
				deployment === null
					? null
					: { id: stringAt(deployment, "id"), status: stringAt(deployment, "status"), createdAt: stringAt(deployment, "createdAt") },
		};
	}

	/** Reads CPU_USAGE, MEMORY_USAGE_GB, CPU_LIMIT, MEMORY_LIMIT_GB for the window, then suggestScale. Refuses before any request when a scale minimum is above its maximum. */
	async suggestScale(ref: ServiceRef): Promise<ScaleSuggestion> {
		const token = this.requireToken();
		const { scale } = this.config;
		const boundsError = scaleBoundsError(scale);
		if (boundsError !== null) throw new RailwayRequestError("configuration", `${boundsError} No scale suggestion is made.`);
		const end = this.now();
		const start = new Date(end.getTime() - scale.windowSeconds * 1000);
		const data = await this.send(token, METRICS_QUERY, {
			environmentId: ref.environmentId,
			serviceId: ref.serviceId,
			startDate: start.toISOString(),
			endDate: end.toISOString(),
		});
		const series = parseMetrics(data.metrics);
		return suggestScale({
			cpu: (series.get("CPU_USAGE") ?? []).map((sample) => sample.value),
			memoryGb: (series.get("MEMORY_USAGE_GB") ?? []).map((sample) => sample.value),
			currentVcpus: latestValue(series.get("CPU_LIMIT")),
			currentMemoryGb: latestValue(series.get("MEMORY_LIMIT_GB")),
			scale,
		});
	}

	/** Never rejects. Cached RAILWAY_COST_CACHE_MS in process, and concurrent callers share one read. A failed read is `unavailable` and is not cached. */
	async costReport(): Promise<CostReport> {
		const at = this.now();
		if (this.cost !== null && at.getTime() - this.cost.at < RAILWAY_COST_CACHE_MS) return this.cost.report;
		if (this.costInFlight === null) {
			this.costInFlight = this.readCostReport(at)
				.then((report) => {
					if (report.status !== "unavailable") this.cost = { at: at.getTime(), report };
					return report;
				})
				.finally(() => {
					this.costInFlight = null;
				});
		}
		return this.costInFlight;
	}

	/** Order: boundsRefusal, then writeRefusal, then one serviceInstanceLimitsUpdate call. Refusals make NO request. Rejects on transport/graphql/shape failure after the gate passes. */
	async setServiceLimits(ref: ServiceRef, limits: WriteLimits, gate: WriteGate): Promise<WriteOutcome> {
		const bounds = boundsRefusal(this.config.scale, limits);
		if (bounds !== null) return refused(bounds);
		const refusal = writeRefusal(this.config, gate);
		if (refusal !== null) return refused(refusal);
		const token = this.requireToken();
		const data = await this.send(token, SET_LIMITS_MUTATION, {
			input: { environmentId: ref.environmentId, serviceId: ref.serviceId, vCPUs: limits.vCPUs, memoryGB: limits.memoryGB },
		});
		return requireTrue(data, "serviceInstanceLimitsUpdate");
	}

	/** Order: writeRefusal, then one serviceInstanceRedeploy call. Refusals make NO request. */
	async redeployService(ref: ServiceRef, gate: WriteGate): Promise<WriteOutcome> {
		const refusal = writeRefusal(this.config, gate);
		if (refusal !== null) return refused(refusal);
		const token = this.requireToken();
		const data = await this.send(token, REDEPLOY_MUTATION, { environmentId: ref.environmentId, serviceId: ref.serviceId });
		return requireTrue(data, "serviceInstanceRedeploy");
	}

	private requireToken(): string {
		const token = this.config.apiToken;
		if (token === null || token === "") throw new RailwayRequestError("not-configured", "RAILWAY_API_TOKEN is not set");
		return token;
	}

	private async readCostReport(at: Date): Promise<CostReport> {
		const generatedAt = at.toISOString();
		const { budgetUsd, prices, projectIds } = this.config;
		const token = this.config.apiToken;
		if (token === null || token === "" || projectIds.length === 0) {
			return buildCostReport({ usage: [], prices, budgetUsd, configured: false, generatedAt });
		}
		try {
			// Projects are read concurrently: each request has its own deadline, so one slow project cannot stretch the whole read.
			const replies = await Promise.all(projectIds.map((projectId) => this.send(token, ESTIMATE_QUERY, { projectId })));
			const usage = replies.flatMap((data) => parseEstimates(data.estimatedUsage));
			return buildCostReport({ usage, prices, budgetUsd, configured: true, generatedAt });
		} catch (error) {
			return {
				status: "unavailable",
				budgetUsd,
				projectedMonthlyUsd: null,
				lines: [],
				detail: error instanceof RailwayRequestError ? error.message : "Railway cost read failed.",
				generatedAt,
			};
		}
	}

	/** One HTTP POST under RAILWAY_REQUEST_TIMEOUT_MS. The deadline bounds the request and its body read. Any throw, the deadline included, becomes a transport error that carries no detail. */
	private async dispatch(token: string, query: string, variables: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		try {
			const response = await bounded(
				this.fetchImpl(RAILWAY_API_URL, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
					body: JSON.stringify({ query, variables }),
					signal,
				}),
				signal,
			);
			return { ok: response.ok, status: response.status, text: await bounded(response.text(), signal) };
		} catch {
			throw new RailwayRequestError("transport", "Railway API request did not complete");
		}
	}

	/** One GraphQL operation; returns its `data` object or throws a RailwayRequestError whose message holds no token, body or header. */
	private async send(token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
		const reply = await this.dispatch(token, query, variables);
		const parsed = parseJson(reply.text);
		const failures = graphqlFailures(parsed, token);
		if (failures.length > 0) throw new RailwayRequestError("graphql", `Railway API error: ${failures.join("; ")}`);
		if (!reply.ok) throw new RailwayRequestError("transport", `Railway API returned HTTP ${reply.status}`);
		if (!isRecord(parsed) || !isRecord(parsed.data)) throw shapeError("response");
		return parsed.data;
	}
}
