/**
 * The desktop_run allowlist and directory (D30-01, D30-09).
 *
 * `SUBSTRATE_DESKTOP_SURFACES` is the only gate: unset or empty means nobody
 * may call `desktop_run`, unknown names are dropped with a boot warning, and
 * an operator token grants nothing here. `SUBSTRATE_DESKTOP_DIR` overrides the
 * default only when absolute. Mirrors the `swarmTokenWarnings` describe in
 * `authority.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DESKTOP_DIR,
	configWarnings,
	desktopConfigWarnings,
	loadConfig,
} from "../config.ts";

describe("desktopConfigWarnings", () => {
	test("an empty allowlist is the fail-closed default and warns nothing", () => {
		const config = loadConfig({});
		expect(config.desktopSurfaces.size).toBe(0);
		expect(config.desktopIgnored).toEqual([]);
		expect(desktopConfigWarnings(config)).toEqual([]);
	});

	test("a valid allowlist with stray spaces parses and warns nothing", () => {
		const config = loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp, cursor ," });
		expect(config.desktopSurfaces.has("omp")).toBe(true);
		expect(config.desktopSurfaces.has("cursor")).toBe(true);
		expect(config.desktopSurfaces.size).toBe(2);
		expect(desktopConfigWarnings(config)).toEqual([]);
	});

	test("an unknown name is dropped, warned by name, and never leaks a token value", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_OMP: "tok-omp",
			SUBSTRATE_DESKTOP_SURFACES: "omp,nobody",
		});
		expect(config.desktopSurfaces.has("omp")).toBe(true);
		expect(config.desktopSurfaces.size).toBe(1);
		expect(config.desktopIgnored).toEqual(["nobody"]);
		const warnings = desktopConfigWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("nobody");
		// Named by surface, never by token: the warning goes to a log.
		expect(warnings[0]).not.toContain("tok-omp");
	});

	test("a relative desktop dir keeps the default with one warning", () => {
		const config = loadConfig({ SUBSTRATE_DESKTOP_DIR: "relative/shots" });
		expect(config.desktopDir).toBe(DEFAULT_DESKTOP_DIR);
		expect(config.desktopDir).toBe("/var/lib/substrate/desktop");
		const warnings = desktopConfigWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SUBSTRATE_DESKTOP_DIR");
	});

	test("an absolute desktop dir is kept with no warning", () => {
		const config = loadConfig({ SUBSTRATE_DESKTOP_DIR: "/tmp/shots" });
		expect(config.desktopDir).toBe("/tmp/shots");
		expect(desktopConfigWarnings(config)).toEqual([]);
	});

	test("an unknown allowlist name leaves configWarnings untouched", () => {
		expect(configWarnings(loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "nobody" }))).toEqual([]);
	});
});
