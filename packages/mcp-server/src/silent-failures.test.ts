import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { reportSilent, resetSilentFailures } from "./silent-failures.ts";

beforeEach(() => resetSilentFailures());
afterEach(() => resetSilentFailures());

/** Every string written to stderr while `run` executes. The real write is restored in `finally`. */
function stderrDuring(run: () => void): string[] {
	const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		run();
		return spy.mock.calls.map((call) => String(call[0]));
	} finally {
		spy.mockRestore();
	}
}

describe("reportSilent", () => {
	test("reports a token code once for a site", () => {
		const error = Object.assign(new Error("connect to https://user:hunter2@db.internal failed"), { code: "ECONNREFUSED" });
		const lines = stderrDuring(() => reportSilent("emit.test-token", error));
		expect(lines).toEqual(["[substrate] emit.test-token failed (ECONNREFUSED)\n"]);
	});

	test("the message text never appears in the output", () => {
		const secret = "payload-7f3a-do-not-print";
		const lines = stderrDuring(() => reportSilent("emit.test-message", new Error(`refused: ${secret}`)));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("[substrate] emit.test-message failed (Error)\n");
		expect(lines.join("")).not.toContain(secret);
	});

	test("a code that is not a short identifier is not reported; the constructor name is", () => {
		const error = Object.assign(new TypeError("bad"), { code: "has a space and a payload in it" });
		const lines = stderrDuring(() => reportSilent("emit.test-bad-code", error));
		expect(lines).toEqual(["[substrate] emit.test-bad-code failed (TypeError)\n"]);
	});

	test("a repeat of a site with the same code writes nothing; a new code at that site is named", () => {
		const lines = stderrDuring(() => {
			reportSilent("emit.test-once", new Error("first"));
			reportSilent("emit.test-once", new Error("second"));
			reportSilent("emit.test-once", Object.assign(new Error("third"), { code: "ECONNREFUSED" }));
			reportSilent("emit.test-other", new Error("fourth"));
		});
		expect(lines).toEqual([
			"[substrate] emit.test-once failed (Error)\n",
			"[substrate] emit.test-once failed (ECONNREFUSED)\n",
			"[substrate] emit.test-other failed (Error)\n",
		]);
	});

	test("a non-object error reports its typeof", () => {
		const lines = stderrDuring(() => {
			reportSilent("emit.test-string", "a raw string carrying a payload");
			reportSilent("emit.test-number", 42);
		});
		expect(lines).toEqual(["[substrate] emit.test-string failed (string)\n", "[substrate] emit.test-number failed (number)\n"]);
		expect(lines.join("")).not.toContain("payload");
	});
});
