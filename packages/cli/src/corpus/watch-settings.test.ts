import { describe, expect, test } from "bun:test";
import { readWatchSettings } from "./watch-settings.ts";

describe("readWatchSettings", () => {
	test("defaults: state directory under XDG_STATE_HOME, else under HOME", () => {
		expect(readWatchSettings({ XDG_STATE_HOME: "/state", HOME: "/home/u" })).toEqual({
			mirrorDir: "/state/substrate/corpus-mirrors",
			spoolDir: "/state/substrate/corpus-hints",
			debounceMs: 2000,
			maxWaitMs: 30_000,
			watchMax: 2000,
			sweepS: 900,
		});
		const home = readWatchSettings({ HOME: "/home/u" });
		expect(home.mirrorDir).toBe("/home/u/.local/state/substrate/corpus-mirrors");
		expect(home.spoolDir).toBe("/home/u/.local/state/substrate/corpus-hints");
	});

	test("a relative or empty XDG_STATE_HOME is ignored", () => {
		expect(readWatchSettings({ XDG_STATE_HOME: "relative/state", HOME: "/home/u" }).spoolDir).toBe("/home/u/.local/state/substrate/corpus-hints");
		expect(readWatchSettings({ XDG_STATE_HOME: "  ", HOME: "/home/u" }).spoolDir).toBe("/home/u/.local/state/substrate/corpus-hints");
	});

	test("the two directories can be set, and are trimmed", () => {
		const settings = readWatchSettings({ SUBSTRATE_CORPUS_MIRROR_DIR: " /m ", SUBSTRATE_CORPUS_SPOOL: "/s", HOME: "/h" });
		expect(settings.mirrorDir).toBe("/m");
		expect(settings.spoolDir).toBe("/s");
	});

	test("numbers are clamped to their range", () => {
		const low = readWatchSettings({ SUBSTRATE_CORPUS_DEBOUNCE_MS: "1", SUBSTRATE_CORPUS_MAX_WAIT_MS: "5", SUBSTRATE_CORPUS_WATCH_MAX: "1", SUBSTRATE_CORPUS_SWEEP_S: "1", HOME: "/h" });
		expect(low).toMatchObject({ debounceMs: 100, maxWaitMs: 1000, watchMax: 10, sweepS: 30 });
		const high = readWatchSettings({ SUBSTRATE_CORPUS_DEBOUNCE_MS: "999999", SUBSTRATE_CORPUS_MAX_WAIT_MS: "99999999", SUBSTRATE_CORPUS_WATCH_MAX: "999999", SUBSTRATE_CORPUS_SWEEP_S: "999999", HOME: "/h" });
		expect(high).toMatchObject({ debounceMs: 60_000, maxWaitMs: 600_000, watchMax: 20_000, sweepS: 86_400 });
	});

	test("the maximum wait is never below the debounce", () => {
		const settings = readWatchSettings({ SUBSTRATE_CORPUS_DEBOUNCE_MS: "20000", SUBSTRATE_CORPUS_MAX_WAIT_MS: "5000", HOME: "/h" });
		expect(settings.debounceMs).toBe(20_000);
		expect(settings.maxWaitMs).toBe(20_000);
	});

	test("text that is not a whole number takes the default", () => {
		const settings = readWatchSettings({
			SUBSTRATE_CORPUS_DEBOUNCE_MS: "2.5",
			SUBSTRATE_CORPUS_MAX_WAIT_MS: "soon",
			SUBSTRATE_CORPUS_WATCH_MAX: "-4",
			SUBSTRATE_CORPUS_SWEEP_S: "",
			HOME: "/h",
		});
		expect(settings).toMatchObject({ debounceMs: 2000, maxWaitMs: 30_000, watchMax: 2000, sweepS: 900 });
	});
});
