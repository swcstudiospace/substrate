import { describe, expect, test } from "bun:test";
import { assertHookTarget, childEnv, isProofSession, remainingMs } from "./laneb-proof.ts";

describe("laneb-proof guards", () => {
	test("remainingMs measures the ten-second budget from the action", () => {
		expect(remainingMs(1_000, 1_000)).toBe(10_000);
		expect(remainingMs(1_000, 6_000)).toBe(5_000);
		expect(remainingMs(1_000, 11_000)).toBe(0);
		expect(remainingMs(1_000, 99_000)).toBe(0);
	});

	test("isProofSession owns only proof-named sessions", () => {
		expect(isProofSession("substrate-proof-p19-abc")).toBe(true);
		expect(isProofSession("substrate-proof-")).toBe(false);
		expect(isProofSession("default")).toBe(false);
		expect(isProofSession("")).toBe(false);
		expect(isProofSession("substrate-proof-../evil")).toBe(false);
	});

	test("assertHookTarget refuses mismatch and unsafe targets", () => {
		const twin = "http://127.0.0.1:17410";
		expect(assertHookTarget(twin, twin)).toBeNull();
		expect(assertHookTarget("http://127.0.0.1:17411", twin)).not.toBeNull();
		expect(assertHookTarget("", twin)).not.toBeNull();
		expect(assertHookTarget("http://127.0.0.1:7410", "http://127.0.0.1:7410")).not.toBeNull();
		expect(assertHookTarget("http://example.com:17410", "http://example.com:17410")).not.toBeNull();
	});

	test("childEnv carries no session or desktop keys", () => {
		const env = childEnv({ HOME: "/tmp/x", SUBSTRATE_URL: "http://127.0.0.1:17410" });
		expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
		for (const key of Object.keys(env)) {
			expect(key.startsWith("HERDR_")).toBe(false);
			expect(key.startsWith("XDG_")).toBe(false);
		}
		expect(() => childEnv({ HERDR_SOCKET_PATH: "/x" })).toThrow();
		expect(() => childEnv({ XDG_DATA_HOME: "/x" })).toThrow();
	});
});
