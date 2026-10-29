import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "./git.ts";
import { Gate, lookupPr, type PrInfo, parsePrList } from "./pr.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("parsePrList", () => {
	test("no pull requests is none", () => {
		expect(parsePrList("[]")).toMatchObject({ state: "none", headSha: null, number: null });
	});

	test("an open pull request outranks a merged one, and every merged head is kept", () => {
		const text = JSON.stringify([
			{ state: "MERGED", headRefOid: SHA_A, number: 1 },
			{ state: "OPEN", headRefOid: SHA_B, number: 2 },
		]);
		expect(parsePrList(text)).toEqual({ state: "open", headSha: SHA_B, number: 2, mergedHeadShas: [SHA_A] });
	});

	test("merged outranks closed", () => {
		const text = JSON.stringify([
			{ state: "CLOSED", headRefOid: SHA_A, number: 1 },
			{ state: "MERGED", headRefOid: SHA_B, number: 2 },
		]);
		expect(parsePrList(text)).toMatchObject({ state: "merged", headSha: SHA_B, number: 2 });
	});

	test("text that is not the expected shape is rejected, not guessed at", () => {
		expect(parsePrList("not json")).toBeNull();
		expect(parsePrList('{"state":"MERGED"}')).toBeNull();
		expect(parsePrList('[{"state":"MERGED"}]')).toBeNull();
		expect(parsePrList('[{"state":"DRAFT","headRefOid":"x","number":1}]')).toBeNull();
	});
});

describe("lookupPr", () => {
	test("asks gh for the branch with the documented arguments and caches per branch", async () => {
		const calls: string[][] = [];
		const run: CommandRunner = async (args) => {
			calls.push(args);
			return { code: 0, stdout: JSON.stringify([{ state: "MERGED", headRefOid: SHA_A, number: 3 }]), stderr: "" };
		};
		const cache = new Map<string, Promise<PrInfo>>();
		const first = await lookupPr("feature/x", { run, cwd: "/repo", cache });
		await lookupPr("feature/x", { run, cwd: "/repo", cache });
		await lookupPr("feature/y", { run, cwd: "/repo", cache });
		expect(first.state).toBe("merged");
		expect(calls[0]).toEqual(["pr", "list", "--head", "feature/x", "--state", "all", "--json", "state,headRefOid,number", "--limit", "5"]);
		// One call per branch: the second ask for feature/x came from the cache.
		expect(calls.map((args) => args[3])).toEqual(["feature/x", "feature/y"]);
	});

	test("a failed or unparsable gh is unknown", async () => {
		expect((await lookupPr("b", { run: async () => ({ code: 1, stdout: "", stderr: "auth" }), cwd: "/r" })).state).toBe("unknown");
		expect((await lookupPr("b", { run: async () => ({ code: 0, stdout: "oops", stderr: "" }), cwd: "/r" })).state).toBe("unknown");
	});
});

describe("Gate", () => {
	test("never runs more than its limit at once and finishes every job", async () => {
		const gate = new Gate(2);
		let running = 0;
		let peak = 0;
		const jobs = Array.from({ length: 8 }, (_unused, index) =>
			gate.run(async () => {
				running += 1;
				peak = Math.max(peak, running);
				await Promise.resolve();
				await Promise.resolve();
				running -= 1;
				return index;
			}),
		);
		expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(peak).toBe(2);
	});
});
