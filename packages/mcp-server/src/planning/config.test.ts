/**
 * Planning settings from the environment: an unset list disables the plane, the defaults hold, and every malformed,
 * relative, duplicate or out-of-range value is a typed error rather than a fallback.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_FILES,
	DEFAULT_PRESENCE_TTL_S,
	DEFAULT_SCAN_INTERVAL_MS,
	PLANNING_MAX_BYTES_ENV,
	PLANNING_MAX_FILES_ENV,
	PLANNING_PASS_ENV,
	PLANNING_PRESENCE_TTL_ENV,
	PLANNING_ROOTS_ENV,
	PLANNING_SCAN_INTERVAL_ENV,
	loadPlanningSettings,
	planningConfigWarnings,
	planningPassSetting,
} from "./config.ts";

const DEFAULTS = { presenceTtlS: 90, maxFiles: 500, maxBytes: 262_144, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS };

/** The key `planningSessionId` gives a root: `wt-` and the first 24 hex digits of its sha256. Pinned here, not imported. */
function keyOf(root: string): string {
	return `wt-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

describe("loadPlanningSettings: the plane is off unless a root is set", () => {
	test("an empty environment is disabled, with the documented defaults and no checkouts", () => {
		const result = loadPlanningSettings({});
		expect(result).toEqual({ ok: true, settings: { enabled: false, checkouts: [], ...DEFAULTS } });
		expect(DEFAULT_PRESENCE_TTL_S).toBe(90);
		expect(DEFAULT_MAX_FILES).toBe(500);
		expect(DEFAULT_MAX_BYTES).toBe(262_144);
	});

	test("a blank list, or one holding only commas and blanks, is the same as unset: disabled", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "   " })).toEqual({ ok: true, settings: { enabled: false, checkouts: [], ...DEFAULTS } });
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: " , ,, " })).toEqual({ ok: true, settings: { enabled: false, checkouts: [], ...DEFAULTS } });
	});

	test("the retired single-root variable is ignored: it enables nothing", () => {
		expect(loadPlanningSettings({ SUBSTRATE_PLANNING_ROOT: "/srv/checkout" })).toEqual({ ok: true, settings: { enabled: false, checkouts: [], ...DEFAULTS } });
	});

	test("an absolute root enables the plane; the root is returned trimmed and keyed by planningSessionId", () => {
		const result = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "  /srv/checkout  " });
		expect(result).toEqual({
			ok: true,
			settings: { enabled: true, checkouts: [{ root: "/srv/checkout", key: keyOf("/srv/checkout") }], ...DEFAULTS },
		});
	});

	test("the key has the planningSessionId shape", () => {
		const result = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/checkout" });
		if (!result.ok || !result.settings.enabled) throw new Error("expected an enabled plane");
		expect(result.settings.checkouts[0]?.key).toMatch(/^wt-[0-9a-f]{24}$/);
	});

	test("several roots keep their order; blank entries are dropped and every entry is trimmed", () => {
		const result = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: " /srv/a , ,/srv/b,  /srv/c ," });
		expect(result).toEqual({
			ok: true,
			settings: {
				enabled: true,
				checkouts: [
					{ root: "/srv/a", key: keyOf("/srv/a") },
					{ root: "/srv/b", key: keyOf("/srv/b") },
					{ root: "/srv/c", key: keyOf("/srv/c") },
				],
				...DEFAULTS,
			},
		});
	});

	test("distinct roots get distinct keys, so two checkouts with the same relative paths never share state", () => {
		const result = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a,/srv/b" });
		if (!result.ok || !result.settings.enabled) throw new Error("expected an enabled plane");
		const [first, second] = result.settings.checkouts;
		expect(first?.key).not.toBe(second?.key);
	});

	test("a relative entry refuses the whole list, reported once", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a,checkout,./other" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOTS_ENV, reason: "not-absolute" }],
		});
	});

	test("an entry with a NUL byte is refused", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/\0x" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOTS_ENV, reason: "invalid-characters" }],
		});
	});

	test("the same root twice refuses the list as a duplicate", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a,/srv/b,/srv/a" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOTS_ENV, reason: "duplicate" }],
		});
	});

	test("duplicates are compared as resolved paths: a trailing slash or a dot segment is the same checkout", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a,/srv/a/" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOTS_ENV, reason: "duplicate" }],
		});
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a,/srv/./a" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_ROOTS_ENV, reason: "duplicate" }],
		});
	});

	test("each refusal reason is reported once, in the order it was first seen", () => {
		expect(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "relative,/srv/a,/srv/a,other,/srv/\0" })).toEqual({
			ok: false,
			errors: [
				{ key: PLANNING_ROOTS_ENV, reason: "not-absolute" },
				{ key: PLANNING_ROOTS_ENV, reason: "duplicate" },
				{ key: PLANNING_ROOTS_ENV, reason: "invalid-characters" },
			],
		});
	});

	test("a malformed scan interval is a boot warning that names its key and never its value, and a valid environment has none", () => {
		const refused = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/checkout", [PLANNING_SCAN_INTERVAL_ENV]: "abc" });
		const warnings = planningConfigWarnings(refused);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(PLANNING_SCAN_INTERVAL_ENV);
		expect(warnings.join("\n")).not.toContain("abc");
		expect(planningConfigWarnings(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/checkout" }))).toEqual([]);
	});

	test("a refused roots list names the key and the reason in its warning, never the path", () => {
		const warnings = planningConfigWarnings(loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/secret-checkout,/srv/secret-checkout" }));
		expect(warnings).toEqual([`${PLANNING_ROOTS_ENV} is duplicate; the planning plane stays off until it is fixed`]);
		expect(warnings.join("\n")).not.toContain("secret-checkout");
	});
});

describe("loadPlanningSettings: numeric settings", () => {
	test("valid values are taken as given", () => {
		const env = { [PLANNING_PRESENCE_TTL_ENV]: "120", [PLANNING_MAX_FILES_ENV]: "40", [PLANNING_MAX_BYTES_ENV]: "65536", [PLANNING_SCAN_INTERVAL_ENV]: "2500" };
		expect(loadPlanningSettings(env)).toEqual({ ok: true, settings: { enabled: false, checkouts: [], presenceTtlS: 120, maxFiles: 40, maxBytes: 65_536, scanIntervalMs: 2_500 } });
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
			[PLANNING_ROOTS_ENV]: "relative",
			[PLANNING_PRESENCE_TTL_ENV]: "x",
			[PLANNING_MAX_FILES_ENV]: "0",
		});
		expect(result).toEqual({
			ok: false,
			errors: [
				{ key: PLANNING_PRESENCE_TTL_ENV, reason: "not-integer" },
				{ key: PLANNING_MAX_FILES_ENV, reason: "out-of-range", min: 1, max: 10_000 },
				{ key: PLANNING_ROOTS_ENV, reason: "not-absolute" },
			],
		});
	});
});

describe("planningPassSetting: the pass switch is on unless it is set to off", () => {
	test("unset is on, and on or off is read in any case and around spaces", () => {
		expect(planningPassSetting({})).toBe("on");
		expect(planningPassSetting({ [PLANNING_PASS_ENV]: "off" })).toBe("off");
		expect(planningPassSetting({ [PLANNING_PASS_ENV]: " OFF " })).toBe("off");
		expect(planningPassSetting({ [PLANNING_PASS_ENV]: "On" })).toBe("on");
	});

	test("the switch leaves the settings and the checkouts as they are: with it off the roots still derive their checkouts", () => {
		const withoutSwitch = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a" });
		const withSwitch = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/a", [PLANNING_PASS_ENV]: "off" });
		expect(withSwitch).toEqual(withoutSwitch);
		expect(withSwitch.ok ? withSwitch.settings.checkouts.map((checkout) => checkout.root) : []).toEqual(["/srv/a"]);
	});

	test("an unrecognised value, a blank one included, refuses the planning settings with a typed error, and the value is never echoed", () => {
		for (const value of ["pause-now", "0", "maybe", ""]) {
			const result = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: "/srv/secret-checkout", [PLANNING_PASS_ENV]: value });
			expect(result).toEqual({ ok: false, errors: [{ key: PLANNING_PASS_ENV, reason: "unrecognised" }] });
			if (value !== "") expect(JSON.stringify(result)).not.toContain(value);
			expect(planningConfigWarnings(result)).toEqual([`${PLANNING_PASS_ENV} is unrecognised; the planning plane stays off until it is fixed`]);
		}
	});
});
