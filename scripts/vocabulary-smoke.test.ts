/**
 * Guard, parser and tag tests for `scripts/vocabulary-smoke.ts`.
 *
 * No network: every case drives the exported pure helpers, so the
 * production refusal and the run tagging verify without a harness.
 */
import { describe, expect, test } from "bun:test";
import { isRefused, parseConsumerEnv, refuseTarget, runSession, runTag } from "./vocabulary-smoke.ts";

describe("parseConsumerEnv", () => {
	test("parses single-quoted export lines", () => {
		const record = parseConsumerEnv("export SUBSTRATE_URL='http://127.0.0.1:18080'\nexport SUBSTRATE_TOKEN='tok-p17'\n");
		expect(record["SUBSTRATE_URL"]).toBe("http://127.0.0.1:18080");
		expect(record["SUBSTRATE_TOKEN"]).toBe("tok-p17");
	});

	test("undoes the POSIX single-quote escape", () => {
		// The harness shell-escapes quotes this way; the smoke must read them back.
		const record = parseConsumerEnv("export SUBSTRATE_TEST_PG_URL='postgresql://a'\\''b@localhost/x'\n");
		expect(record["SUBSTRATE_TEST_PG_URL"]).toBe("postgresql://a'b@localhost/x");
	});

	test("ignores non-export lines", () => {
		const record = parseConsumerEnv("# a comment\nexport SUBSTRATE_URL='http://127.0.0.1:18080'\n");
		expect(Object.keys(record)).toEqual(["SUBSTRATE_URL"]);
	});
});

describe("refuseTarget", () => {
	test("null only for a loopback host outside the production ports", () => {
		expect(refuseTarget("http://127.0.0.1:18080")).toBeNull();
		expect(refuseTarget("http://localhost:18080")).toBeNull();
	});

	test("refuses the production ports before any request", () => {
		// Aiming at production must fail closed without sending anything.
		for (const port of [7410, 7411, 6420]) {
			expect(refuseTarget(`http://127.0.0.1:${port}`)).toContain("refusing");
		}
	});

	test("refuses a non-loopback host", () => {
		expect(refuseTarget("http://10.0.0.9:18080")).toContain("non-loopback");
		expect(refuseTarget("http://example.com:18080")).toContain("non-loopback");
	});

	test("refuses an unparseable target", () => {
		expect(refuseTarget("not a url")).toContain("unparseable");
	});
});

describe("runTag and runSession", () => {
	test("graph ids carry the rh-vocab prefix with the epoch millis", () => {
		expect(runTag(1728000000000)).toBe("rh-vocab-1728000000000");
	});

	test("session ids suffix the entry id", () => {
		expect(runSession("rh-vocab-1", "herdr.agent_detected")).toBe("rh-vocab-1-herdr.agent_detected");
	});

	test("session ids stay under 512 chars", () => {
		expect(runSession("rh-vocab-1", "x".repeat(600)).length).toBeLessThan(512);
	});
});

describe("isRefused", () => {
	test("only a stored 202 passes", () => {
		expect(isRefused(202, true)).toBe(false);
	});

	test("every other outcome counts as a refusal", () => {
		// 400 rejected input, 401/403 denied attribution, 503 failed
		// storage, an unstored 202 and an unreachable twin all refused.
		expect(isRefused(400, false)).toBe(true);
		expect(isRefused(401, false)).toBe(true);
		expect(isRefused(403, false)).toBe(true);
		expect(isRefused(503, false)).toBe(true);
		expect(isRefused(202, false)).toBe(true);
		expect(isRefused(null, false)).toBe(true);
	});
});
