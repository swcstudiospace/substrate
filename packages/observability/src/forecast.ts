/**
 * Predictive SLO rows (phase 47, D47-b and D47-c): Holt's double exponential
 * smoothing over an objective's recorded history, projected one horizon ahead.
 *
 * Pure: the caller reads the history and passes its values in order, one per
 * step. The rows are report-only; nothing here decides `breached`.
 */

/** Level smoothing. */
export const FORECAST_ALPHA = 0.5;
/** Trend smoothing. */
export const FORECAST_BETA = 0.3;
/** Fewest finite points a forecast is made from: one hour at the 5-minute step. */
export const FORECAST_MIN_POINTS = 12;
/** How far ahead a forecast projects. */
export const FORECAST_HORIZON_MS = 60 * 60 * 1000;
/** The history window `/slo` reads for a forecast: 24 points at the 5-minute step. */
export const FORECAST_WINDOW = "2h";
/** The step `/slo` asks the history for; the reader may raise it for a labelled series. */
export const FORECAST_STEP_S = 300;

/** `maximum`: a breach is above the target (latency, a ceiling). `minimum`: below it (a floor). */
export type ForecastDirection = "maximum" | "minimum";

/** `service`: the history is service-wide. `worst-surface`: the history is the largest surface value per bucket. */
type ForecastBasis = "service" | "worst-surface";

type ForecastStatus = "predicted-breach" | "ok" | "insufficient-data" | "history-off";

/** One objective's forecast; `predicted` is the value at the horizon, or `null` when none is made. `basis` says what the history measures. */
export interface ForecastRow {
	id: string;
	status: ForecastStatus;
	predicted: number | null;
	target: number;
	samples: number;
	basis: ForecastBasis;
}

interface HoltFit {
	level: number;
	trend: number;
	/** The value `horizonSteps` after the last point: `level + trend * horizonSteps`. */
	predicted: number;
}

/**
 * Holt's linear method over the finite values of `points`, in order. The level
 * starts at the second value and the trend at their difference, so a linear
 * series keeps its slope exactly. `null` when there are fewer than two finite
 * values, a smoothing constant is outside (0, 1], the horizon is not a positive
 * number of steps, or the projection is not finite.
 */
export function holtForecast(points: readonly number[], horizonSteps: number, alpha: number, beta: number): HoltFit | null {
	if (!(alpha > 0 && alpha <= 1) || !(beta > 0 && beta <= 1)) return null;
	if (!Number.isFinite(horizonSteps) || horizonSteps <= 0) return null;
	const values = points.filter((value) => Number.isFinite(value));
	if (values.length < 2) return null;
	const first = values[0];
	const second = values[1];
	if (first === undefined || second === undefined) return null;
	let level = second;
	let trend = second - first;
	for (let i = 2; i < values.length; i++) {
		const value = values[i];
		if (value === undefined) break;
		const previousLevel = level;
		level = alpha * value + (1 - alpha) * (previousLevel + trend);
		trend = beta * (level - previousLevel) + (1 - beta) * trend;
	}
	const predicted = level + trend * horizonSteps;
	return Number.isFinite(predicted) ? { level, trend, predicted } : null;
}

/**
 * The forecast row for one objective. `insufficient-data` below
 * {@link FORECAST_MIN_POINTS} finite points, or for a non-finite target or an
 * invalid horizon; otherwise `predicted-breach` when the horizon value crosses
 * the target in `direction` (strictly beyond it), and `ok` when it does not.
 * `basis` is carried onto the row unchanged: it names what `points` measure.
 */
export function forecastRow(
	id: string,
	target: number,
	direction: ForecastDirection,
	points: readonly number[],
	horizonSteps: number,
	basis: ForecastBasis,
): ForecastRow {
	const samples = points.filter((value) => Number.isFinite(value)).length;
	const fit = samples >= FORECAST_MIN_POINTS && Number.isFinite(target) ? holtForecast(points, horizonSteps, FORECAST_ALPHA, FORECAST_BETA) : null;
	if (fit === null) return { id, status: "insufficient-data", predicted: null, target, samples, basis };
	const breach = direction === "maximum" ? fit.predicted > target : fit.predicted < target;
	return { id, status: breach ? "predicted-breach" : "ok", predicted: fit.predicted, target, samples, basis };
}

/** The row for an objective while history is off: no value, no sample. */
export function forecastHistoryOff(id: string, target: number, basis: ForecastBasis): ForecastRow {
	return { id, status: "history-off", predicted: null, target, samples: 0, basis };
}
