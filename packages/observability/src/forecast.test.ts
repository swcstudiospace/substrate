import { describe, expect, test } from "bun:test";
import { FORECAST_ALPHA, FORECAST_BETA, FORECAST_MIN_POINTS, forecastHistoryOff, forecastRow, holtForecast } from "./forecast.ts";

describe("holtForecast", () => {
	test("a linear series recovers its slope exactly, and projects along it", () => {
		const points = Array.from({ length: 20 }, (_, i) => 100 + 3 * i);
		const fit = holtForecast(points, 12, FORECAST_ALPHA, FORECAST_BETA);
		expect(fit?.trend).toBeCloseTo(3, 9);
		expect(fit?.level).toBeCloseTo(100 + 3 * 19, 9);
		expect(fit?.predicted).toBeCloseTo(100 + 3 * 19 + 3 * 12, 9);
	});

	test("drops non-finite values before fitting, and refuses input it cannot fit", () => {
		expect(holtForecast([Number.NaN, 5, Number.POSITIVE_INFINITY, 7], 1, FORECAST_ALPHA, FORECAST_BETA)).toMatchObject({ predicted: 9 });
		expect(holtForecast([], 12, FORECAST_ALPHA, FORECAST_BETA)).toBeNull();
		expect(holtForecast([Number.NaN, 5], 12, FORECAST_ALPHA, FORECAST_BETA)).toBeNull();
		expect(holtForecast([1, 2, 3], 0, FORECAST_ALPHA, FORECAST_BETA)).toBeNull();
		expect(holtForecast([1, 2, 3], 12, 0, FORECAST_BETA)).toBeNull();
	});
});

describe("forecastRow", () => {
	test("a rising latency series predicts a breach of a maximum target at the horizon", () => {
		const latency = Array.from({ length: 24 }, (_, i) => 100 + 40 * i);
		const row = forecastRow("brief.p95", 800, "maximum", latency, 12, "worst-surface");
		expect(row).toMatchObject({ id: "brief.p95", status: "predicted-breach", target: 800, samples: 24, basis: "worst-surface" });
		expect(row.predicted).toBeGreaterThan(800);
	});

	test("a flat series is ok, with the level as its prediction", () => {
		const row = forecastRow("brief.p95", 800, "maximum", Array.from({ length: 24 }, () => 100), 12, "worst-surface");
		expect(row).toMatchObject({ status: "ok", predicted: 100, samples: 24, basis: "worst-surface" });
	});

	test("a falling ratio predicts a breach of a minimum target; a flat one at the target stays ok", () => {
		const falling = Array.from({ length: 24 }, (_, i) => 1 - 0.01 * i);
		expect(forecastRow("emit.success", 0.995, "minimum", falling, 12, "service")).toMatchObject({ status: "predicted-breach", basis: "service" });
		expect(forecastRow("emit.success", 0.995, "minimum", Array.from({ length: 24 }, () => 1), 12, "service")).toMatchObject({ status: "ok" });
	});

	test("the basis is carried onto the row, so a service-wide objective and a worst-surface one are told apart", () => {
		const series = Array.from({ length: 24 }, () => 100);
		expect(forecastRow("emit.success", 800, "maximum", series, 12, "service").basis).toBe("service");
		expect(forecastRow("brief.p95", 800, "maximum", series, 12, "worst-surface").basis).toBe("worst-surface");
	});

	test("fewer than the minimum points is insufficient-data, with the finite count and no number", () => {
		const eleven = Array.from({ length: FORECAST_MIN_POINTS - 1 }, (_, i) => 100 + 40 * i);
		expect(forecastRow("brief.p95", 800, "maximum", eleven, 12, "worst-surface")).toEqual({
			id: "brief.p95",
			status: "insufficient-data",
			predicted: null,
			target: 800,
			samples: FORECAST_MIN_POINTS - 1,
			basis: "worst-surface",
		});
	});

	test("empty input and NaN values are insufficient-data, never a number", () => {
		expect(forecastRow("brief.p95", 800, "maximum", [], 12, "worst-surface")).toEqual({
			id: "brief.p95",
			status: "insufficient-data",
			predicted: null,
			target: 800,
			samples: 0,
			basis: "worst-surface",
		});
		const allNaN = Array.from({ length: 30 }, () => Number.NaN);
		expect(forecastRow("brief.p95", 800, "maximum", allNaN, 12, "worst-surface")).toMatchObject({ status: "insufficient-data", predicted: null, samples: 0 });
		const elevenFinite = [...Array.from({ length: 11 }, (_, i) => 100 + i), ...Array.from({ length: 5 }, () => Number.NaN)];
		expect(forecastRow("brief.p95", 800, "maximum", elevenFinite, 12, "worst-surface")).toMatchObject({ status: "insufficient-data", predicted: null, samples: 11 });
	});

	test("an invalid horizon or a non-finite target is insufficient-data", () => {
		const series = Array.from({ length: 24 }, (_, i) => 100 + 40 * i);
		expect(forecastRow("brief.p95", 800, "maximum", series, 0, "worst-surface")).toMatchObject({ status: "insufficient-data", predicted: null });
		expect(forecastRow("brief.p95", Number.NaN, "maximum", series, 12, "worst-surface")).toMatchObject({ status: "insufficient-data", predicted: null });
	});

	test("history off is a row with no value and no sample, and keeps its basis", () => {
		expect(forecastHistoryOff("brief.p95", 800, "worst-surface")).toEqual({
			id: "brief.p95",
			status: "history-off",
			predicted: null,
			target: 800,
			samples: 0,
			basis: "worst-surface",
		});
	});
});
