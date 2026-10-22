/**
 * Planning settings from the environment: an unset root disables the plane, the defaults hold,
 * and every malformed or out-of-range value is a typed error rather than a fallback.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_FILES,
	DEFAULT_PRESENCE_TTL_S,
	DEFAULT_SCAN_INTERVAL_MS,
	PLANNING_MAX_BYTES_ENV,
	PLANNING_MAX_FILES_ENV,
	PLANNING_PRESENCE_TTL_ENV,
	PLANNING_SCAN_INTERVAL_ENV,
	PLANNING_ROOT_ENV,
	loadPlanningSettings,
	planningConfigWarnings,
} from "./config.ts";

const DEFAULTS = { presenceTtlS: 90, maxFiles: 500, maxBytes: 262_144, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS };

describe("loadPlanningSettings: the plane is off unless a root is set", () => {
	test("an empty environment is disabled, with the documented defaults and no root", () => {
		const result = loadPlanningSettings({});
		expect(result).toEqual({ ok: true, settings: { enabled: false, ...DEFAULTS } });
		expect(DEFAULT_PRESENCE_TTL_S).toBe(90);
		expect(DEFAULT_MAX_FILES).toBe(500);
		expect(DEFAULT_MAX_BYTES).toBe(262_144);
	});

	test("a blank root is the same as unset: disabled", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOT_ENV]: "   " })).toEqual({ ok: true, settings: { enabled: false, ...DEFAULTS } });
	});

	test("an absolute root enables the plane and is returned trimmed", () => {
		const result = loadPlanningSettings({ [PLANNING_ROOT_ENV]: "  /srv/checkout  " });
		expect(result).toEqual({ ok: true, settings: { enabled: true, root: "/srv/checkout", ...DEFAULTS } });
	});

	test("a relative root is refused", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOT_ENV]: "checkout" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOT_ENV, reason: "not-absolute" }],
		});
	});

	test("a root with a NUL byte is refused", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOT_ENV]: "/srv/\0x" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOT_ENV, reason: "invalid-characters" }],
		});
	});

	test("a malformed scan interval is a boot warning that names its key and never its value, and a valid environment has none", () => {
		const refused = loadPlanningSettings({ [PLANNING_ROOT_ENV]: "/srv/checkout", [PLANNING_SCAN_INTERVAL_ENV]: "abc" });
		const warnings = planningConfigWarnings(refused);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(PLANNING_SCAN_INTERVAL_ENV);
		expect(warnings.join("\n")).not.toContain("abc");
		expect(planningConfigWarnings(loadPlanningSettings({ [PLANNING_ROOT_ENV]: "/srv/checkout" }))).toEqual([]);
	});
});

describe("loadPlanningSettings: numeric settings", () => {
	test("valid values are taken as given", () => {
		const env = { [PLANNING_PRESENCE_TTL_ENV]: "120", [PLANNING_MAX_FILES_ENV]: "40", [PLANNING_MAX_BYTES_ENV]: "65536", [PLANNING_SCAN_INTERVAL_ENV]: "2500" };
		expect(loadPlanningSettings(env)).toEqual({ ok: true, settings: { enabled: false, presenceTtlS: 120, maxFiles: 40, maxBytes: 65_536, scanIntervalMs: 2_500 } });
	});

	test.each([
		["90s"],
		["-1"],
		["1.5"],
		["1e3"],
		[" 90"],
		[""],
		["abc"],
	])("the malformed value %p is a not-integer error for its key", (value) => {
		expect(loadPlanningSettings({ [PLANNING_PRESENCE_TTL_ENV]: value })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_PRESENCE_TTL_ENV, reason: "not-integer" }],
		});
	});

	test("a value outside its bounds is out-of-range, and the bounds are reported", () => {
		expect(loadPlanningSettings({ [PLANNING_MAX_FILES_ENV]: "10001" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_MAX_FILES_ENV, reason: "out-of-range", min: 1, max: 10_000 }],
		});
		expect(loadPlanningSettings({ [PLANNING_MAX_BYTES_ENV]: "1023" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_MAX_BYTES_ENV, reason: "out-of-range", min: 1_024, max: 4_194_304 }],
		});
		expect(loadPlanningSettings({ [PLANNING_PRESENCE_TTL_ENV]: "0" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_PRESENCE_TTL_ENV, reason: "out-of-range", min: 1, max: 86_400 }],
		});
	});

	test("a digit string too large for a safe integer is out-of-range, not silently rounded", () => {
		expect(loadPlanningSettings({ [PLANNING_PRESENCE_TTL_ENV]: "9".repeat(30) })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_PRESENCE_TTL_ENV, reason: "out-of-range", min: 1, max: 86_400 }],
		});
	});

	test("a malformed number is an error even when the plane is disabled", () => {
		const result = loadPlanningSettings({ [PLANNING_PRESENCE_TTL_ENV]: "soon" });
		expect(result.ok).toBe(false);
	});

	test("every bad key is reported in one result", () => {
		const result = loadPlanningSettings({
			[PLANNING_ROOT_ENV]: "relative",
			[PLANNING_PRESENCE_TTL_ENV]: "x",
			[PLANNING_MAX_FILES_ENV]: "0",
		});
		expect(result).toEqual({
			ok: false,
			errors: [
				{ key: PLANNING_PRESENCE_TTL_ENV, reason: "not-integer" },
				{ key: PLANNING_MAX_FILES_ENV, reason: "out-of-range", min: 1, max: 10_000 },
				{ key: PLANNING_ROOT_ENV, reason: "not-absolute" },
			],
		});
	});
});
