import { describe, expect, test } from "bun:test";
import { HindsightFake } from "./hindsight-fake.ts";
import {
	type CanaryArgs,
	type CanaryDeps,
	CanaryUsageError,
	parseCanaryArgs,
	runCanary,
} from "./hindsight-canary-run.ts";
import type { FetchLike } from "./planes/hindsight.ts";

const URL_PLACEHOLDER = "https://hindsight-candidate.test.invalid";
const KEY_PLACEHOLDER = "test-key-not-a-real-secret";
const ENV = { HINDSIGHT_URL: URL_PLACEHOLDER, HINDSIGHT_API_KEY: KEY_PLACEHOLDER, HINDSIGHT_BANK_PREFIX: "sub-" };
const RECALL_BUDGET = 1111;

const ARGS: CanaryArgs = { confirmThrowaway: true, json: false, mentalModelRefresh: false };

interface Harness {
	deps: CanaryDeps;
	stdout: string[];
	stderr: string[];
}

function harness(fetchImpl: FetchLike, overrides: Partial<CanaryDeps> = {}, args: Partial<CanaryArgs> = {}): Harness {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let clock = 0;
	const deps: CanaryDeps = {
		args: { ...ARGS, ...args },
		env: ENV,
		fetch: fetchImpl,
		now: () => clock++,
		random: () => "abcd1234",
		// Never fires: tests that need a timeout override this.
		delay: () => ({ promise: new Promise<void>(() => {}), cancel: () => {} }),
		out: (text) => void stdout.push(text),
		err: (text) => void stderr.push(text),
		limits: { recallBudgetMs: RECALL_BUDGET },
		...overrides,
	};
	return { deps, stdout, stderr };
}

/** Wrap a fake so a path/method pair answers with something else. */
function intercept(fake: HindsightFake, match: (method: string, path: string) => Response | Promise<Response> | null): FetchLike {
	return async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const hit = match((init?.method ?? "GET").toUpperCase(), url.pathname);
		return hit ?? fake.fetch(input, init);
	};
}

function statusOf(report: { checks: { id: string; status: string }[] } | null, id: string): string | undefined {
	return report?.checks.find((check) => check.id === id)?.status;
}

describe("parseCanaryArgs", () => {
	test("accepts the three flags", () => {
		expect(parseCanaryArgs(["--confirm-throwaway", "--json", "--mental-model-refresh"])).toEqual({
			confirmThrowaway: true,
			json: true,
			mentalModelRefresh: true,
		});
	});
	test("rejects unknown, positional and repeated arguments", () => {
		expect(() => parseCanaryArgs(["--bank"])).toThrow(CanaryUsageError);
		expect(() => parseCanaryArgs(["prod"])).toThrow(CanaryUsageError);
		expect(() => parseCanaryArgs(["--json", "--json"])).toThrow(CanaryUsageError);
	});
});

describe("refusals", () => {
	test("without --confirm-throwaway exits 2 and sends nothing", async () => {
		const fake = new HindsightFake();
		const { deps, stderr } = harness(fake.fetch, {}, { confirmThrowaway: false });
		const outcome = await runCanary(deps);
		expect(outcome.code).toBe(2);
		expect(fake.requests).toHaveLength(0);
		expect(stderr.join("")).toContain("--confirm-throwaway");
	});
	test("missing URL or key exits 2 and sends nothing", async () => {
		for (const env of [{ HINDSIGHT_API_KEY: KEY_PLACEHOLDER }, { HINDSIGHT_URL: URL_PLACEHOLDER }]) {
			const fake = new HindsightFake();
			const { deps, stderr } = harness(fake.fetch, { env });
			expect((await runCanary(deps)).code).toBe(2);
			expect(fake.requests).toHaveLength(0);
			expect(stderr.join("")).not.toContain(KEY_PLACEHOLDER);
		}
	});
	test("an unusable random suffix exits 2", async () => {
		const fake = new HindsightFake();
		const { deps } = harness(fake.fetch, { random: () => "../x" });
		expect((await runCanary(deps)).code).toBe(2);
		expect(fake.requests).toHaveLength(0);
	});
});

describe("runCanary against the fake", () => {
	test("all checks pass, only the canary bank is touched, and it is deleted", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-production-bank", []);
		const { deps, stdout } = harness(fake.fetch);
		const outcome = await runCanary(deps);
		expect(outcome.code).toBe(0);
		expect(outcome.report?.ok).toBe(true);
		expect(outcome.report?.version).toBe("0.9.1");
		expect(outcome.report?.checks.map((check) => check.id)).toEqual([
			"health-version",
			"bank-ensure",
			"retain",
			"recall",
			"document-get",
			"tag-patch",
			"document-delete",
			"mental-model-refresh",
			"bank-delete",
			"bank-id-validation",
		]);
		expect(statusOf(outcome.report, "mental-model-refresh")).toBe("skip");
		expect(statusOf(outcome.report, "bank-id-validation")).toBe("skip");
		expect([...fake.banks.keys()]).toEqual(["sub-production-bank"]);
		for (const request of fake.requests) {
			if (request.path.startsWith("/v1/default/banks/")) expect(request.path).toMatch(/^\/v1\/default\/banks\/sub-(canary-abcd1234|production-bank)/);
		}
		expect(fake.requests.some((request) => request.path.includes("production-bank"))).toBe(false);
		const text = stdout.join("");
		expect(text).toContain("result: ok");
		expect(text).not.toContain(KEY_PLACEHOLDER);
		expect(text).not.toContain("hindsight-candidate");
	});

	test("passes with a wrapped recall shape and empty-body deletes", async () => {
		const fake = new HindsightFake();
		fake.recallShape = "wrapped";
		fake.emptyDelete = true;
		const outcome = await runCanary(harness(fake.fetch).deps);
		expect(outcome.code).toBe(0);
		expect(fake.banks.size).toBe(0);
	});

	test("--json output has a stable schema and no secret", async () => {
		const fake = new HindsightFake();
		const { deps, stdout } = harness(fake.fetch, {}, { json: true });
		await runCanary(deps);
		const parsed = JSON.parse(stdout.join(""));
		expect(Object.keys(parsed).sort()).toEqual(["checks", "ok", "schema", "version"]);
		expect(parsed.schema).toBe(1);
		for (const check of parsed.checks) {
			expect(["id", "ms", "reason", "status"]).toEqual(expect.arrayContaining(Object.keys(check)));
			expect(["pass", "fail", "skip"]).toContain(check.status);
			expect(typeof check.ms).toBe("number");
		}
		expect(stdout.join("")).not.toContain(KEY_PLACEHOLDER);
		expect(stdout.join("")).not.toContain("hindsight-candidate");
	});

	test("a recall hang is a recall-timeout FAIL within budget, then cleanup runs", async () => {
		const fake = new HindsightFake();
		const hanging = intercept(fake, (method, path) => (method === "POST" && path.endsWith("/memories/recall") ? new Promise<Response>(() => {}) : null));
		const delay: CanaryDeps["delay"] = (ms) => ({
			promise: ms === RECALL_BUDGET ? Promise.resolve() : new Promise<void>(() => {}),
			cancel: () => {},
		});
		const { deps } = harness(hanging, { delay });
		const outcome = await runCanary(deps);
		expect(outcome.code).toBe(1);
		const recall = outcome.report?.checks.find((check) => check.id === "recall");
		expect(recall?.status).toBe("fail");
		expect(recall?.reason).toContain("recall-timeout");
		expect(statusOf(outcome.report, "document-delete")).toBe("pass");
		expect(fake.banks.size).toBe(0);
	});

	test("an unexpected recall shape fails the recall check only", async () => {
		const fake = new HindsightFake();
		const odd = intercept(fake, (method, path) => (method === "POST" && path.endsWith("/memories/recall") ? Response.json({ nope: 1 }) : null));
		const outcome = await runCanary(harness(odd).deps);
		expect(outcome.code).toBe(1);
		expect(statusOf(outcome.report, "recall")).toBe("fail");
		expect(statusOf(outcome.report, "document-get")).toBe("pass");
		expect(fake.banks.size).toBe(0);
	});

	test("a non-JSON document get fails document-get", async () => {
		const fake = new HindsightFake();
		const odd = intercept(fake, (method, path) => (method === "GET" && path.includes("/documents/") ? new Response("oops", { status: 200 }) : null));
		const outcome = await runCanary(harness(odd).deps);
		expect(statusOf(outcome.report, "document-get")).toBe("fail");
		expect(outcome.code).toBe(1);
	});

	test("a bank not in chunks mode fails bank-ensure and still cleans up", async () => {
		const fake = new HindsightFake();
		const lying = intercept(fake, (method, path) =>
			method === "PATCH" && path.endsWith("/config") ? Response.json({ config: { retain_extraction_mode: "server-default" } }) : null,
		);
		const outcome = await runCanary(harness(lying).deps);
		expect(statusOf(outcome.report, "bank-ensure")).toBe("fail");
		expect(statusOf(outcome.report, "retain")).toBe("skip");
		expect(fake.banks.size).toBe(0);
		expect(outcome.code).toBe(1);
	});

	test("cleanup runs after a mid-run retain failure and dependents skip", async () => {
		const fake = new HindsightFake();
		fake.failRetainWith = 500;
		const outcome = await runCanary(harness(fake.fetch).deps);
		expect(outcome.code).toBe(1);
		expect(statusOf(outcome.report, "retain")).toBe("fail");
		expect(statusOf(outcome.report, "recall")).toBe("skip");
		expect(statusOf(outcome.report, "bank-delete")).toBe("pass");
		expect(fake.banks.size).toBe(0);
	});

	test("a second delete that errors fails document-delete", async () => {
		const fake = new HindsightFake();
		let deletes = 0;
		const flaky = intercept(fake, (method, path) => {
			if (method === "DELETE" && path.includes("/documents/")) {
				deletes += 1;
				if (deletes === 2) return Response.json({ detail: "boom" }, { status: 500 });
			}
			return null;
		});
		const outcome = await runCanary(harness(flaky).deps);
		expect(statusOf(outcome.report, "document-delete")).toBe("fail");
		expect(fake.banks.size).toBe(0);
	});

	test("a bank still readable after delete fails bank-delete", async () => {
		const fake = new HindsightFake();
		const sticky = intercept(fake, (method, path) => (method === "DELETE" && /\/banks\/[^/]+$/.test(path) ? Response.json({ success: true }) : null));
		const outcome = await runCanary(harness(sticky).deps);
		expect(statusOf(outcome.report, "bank-delete")).toBe("fail");
		expect(outcome.code).toBe(1);
	});

	test("the total deadline fails later checks but still deletes the bank", async () => {
		const fake = new HindsightFake();
		let clock = 0;
		const { deps } = harness(fake.fetch, { now: () => (clock += 100_000), limits: { deadlineMs: 150_000, recallBudgetMs: RECALL_BUDGET } });
		const outcome = await runCanary(deps);
		expect(outcome.code).toBe(1);
		expect(outcome.report?.checks.some((check) => check.reason === "total-deadline-exceeded")).toBe(true);
		expect(fake.banks.size).toBe(0);
	});

	test("an unreachable candidate exits 3 with no URL in the output and no bank calls", async () => {
		const down: FetchLike = async () => {
			throw new TypeError(`connect failed for ${URL_PLACEHOLDER}/health with ${KEY_PLACEHOLDER}`);
		};
		const { deps, stdout, stderr } = harness(down);
		const outcome = await runCanary(deps);
		expect(outcome.code).toBe(3);
		expect(outcome.report?.ok).toBe(false);
		expect(statusOf(outcome.report, "bank-ensure")).toBe("skip");
		expect(statusOf(outcome.report, "bank-delete")).toBe("skip");
		const text = stdout.join("") + stderr.join("");
		expect(text).not.toContain("hindsight-candidate");
		expect(text).not.toContain(KEY_PLACEHOLDER);
	});

	test("--mental-model-refresh records the response shape on success", async () => {
		const fake = new HindsightFake();
		const refresh = intercept(fake, (method, path) => (method === "POST" && path.endsWith("/refresh") ? Response.json({ operation_id: "op", status: "queued" }) : null));
		const outcome = await runCanary(harness(refresh, {}, { mentalModelRefresh: true }).deps);
		const check = outcome.report?.checks.find((entry) => entry.id === "mental-model-refresh");
		expect(check?.status).toBe("pass");
		expect(check?.reason).toContain("operation_id");
		expect(outcome.code).toBe(0);
	});

	test("--mental-model-refresh with a 404 is a skip, and a 500 is a fail", async () => {
		const fake404 = new HindsightFake();
		const notFound = intercept(fake404, (method, path) => (method === "POST" && path.endsWith("/refresh") ? Response.json({ detail: "x" }, { status: 404 }) : null));
		const first = await runCanary(harness(notFound, {}, { mentalModelRefresh: true }).deps);
		expect(statusOf(first.report, "mental-model-refresh")).toBe("skip");
		expect(first.code).toBe(0);
		const second = await runCanary(harness(new HindsightFake().fetch, {}, { mentalModelRefresh: true }).deps);
		expect(statusOf(second.report, "mental-model-refresh")).toBe("fail");
		expect(second.code).toBe(1);
	});
});
