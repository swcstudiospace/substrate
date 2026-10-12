/**
 * The owned RAGFlow fixture helpers: guards, identity, control shapes.
 *
 * Pure by construction: no test here needs a live fixture process. Control
 * shape tests prove the bounded JSON the stand-in speaks; identity tests
 * prove only the recorded child is ever stopped; refusal tests prove foreign
 * pids, reused pids, occupied listeners and non-loopback targets are refused
 * before any signal or request.
 */
import { describe, expect, test } from "bun:test";
import {
	checkFixtureReady,
	confirmFixtureSpawn,
	FIXTURE_SEED_MAX_CHUNKS,
	mayStopFixture,
	newFixtureKey,
	parseFailRetrievalBody,
	parseFixtureCounts,
	parseParseBehaviourBody,
	parseSeedChunksBody,
	RAGFLOW_FIXTURE_SCRIPT,
	refuseFixtureControlUrl,
	type FixtureProcFacts,
} from "./rehearsal-ragflow.ts";

/** Production ports the harness never binds and never lets a fixture own. */
const PRODUCTION = [7410, 7411, 6420] as const;

/** Safe-to-stop fixture facts; each refusal test overrides one field. */
function proc(over: Partial<FixtureProcFacts> = {}): FixtureProcFacts {
	return {
		pid: 424243,
		argv: ["/root/.bun/bin/bun", "--no-env-file", "packages/mcp-server/src/rehearsal-ragflow-server.ts"],
		cwd: "/tmp/wt-checkout",
		cgroup: "0::/user.slice/user-0.slice/session-1.scope",
		startSeconds: 1791479652.17,
		listensOn: [18410],
		...over,
	};
}

const STATE = {
	pid: 424243,
	startSeconds: 1791479652.17,
	cwd: "/tmp/wt-checkout",
	script: "packages/mcp-server/src/rehearsal-ragflow-server.ts",
};

describe("fixture keys", () => {
	test("fresh keys are hex and differ per call", () => {
		const first = newFixtureKey();
		const second = newFixtureKey();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toMatch(/^[0-9a-f]{64}$/);
		expect(second).not.toBe(first);
	});
});

describe("refuseFixtureControlUrl", () => {
	test("accepts the owned loopback shape", () => {
		expect(refuseFixtureControlUrl("http://127.0.0.1:18410", PRODUCTION)).toBeNull();
		expect(refuseFixtureControlUrl("http://127.0.0.1:18410/__fixture/health", PRODUCTION)).toBeNull();
		expect(refuseFixtureControlUrl("http://localhost:18410", PRODUCTION)).toBeNull();
	});

	test("refuses production ports before any request", () => {
		for (const port of PRODUCTION) {
			expect(refuseFixtureControlUrl(`http://127.0.0.1:${port}`, PRODUCTION)).toContain("production");
		}
	});

	test("refuses non-loopback hosts before any request", () => {
		expect(refuseFixtureControlUrl("http://10.0.0.7:18410", PRODUCTION)).toContain("non-loopback");
		expect(refuseFixtureControlUrl("http://example.invalid:9380", PRODUCTION)).toContain("non-loopback");
	});

	test("refuses an unparseable target", () => {
		expect(refuseFixtureControlUrl("not a url", PRODUCTION)).toContain("unparseable");
	});

	test("refuses non-http, credentials, missing ports, query, fragment, and odd paths", () => {
		expect(refuseFixtureControlUrl("https://127.0.0.1:18410", PRODUCTION)).toContain("non-http");
		expect(refuseFixtureControlUrl("http://user:pass@127.0.0.1:18410", PRODUCTION)).toContain("credentials");
		expect(refuseFixtureControlUrl("http://127.0.0.1", PRODUCTION)).toContain("no port");
		expect(refuseFixtureControlUrl("http://127.0.0.1:18410?x=1", PRODUCTION)).toContain("query or fragment");
		expect(refuseFixtureControlUrl("http://127.0.0.1:18410#frag", PRODUCTION)).toContain("query or fragment");
		expect(refuseFixtureControlUrl("http://127.0.0.1:18410/api/v1/retrieval", PRODUCTION)).toContain("unexpected path");
	});
});

 describe("mayStopFixture", () => {
	test("stops the verified fixture child", () => {
		expect(mayStopFixture(proc(), STATE, PRODUCTION)).toBeNull();
	});

	test("refuses a pid that differs from state.json", () => {
		expect(mayStopFixture(proc({ pid: 999999 }), STATE, PRODUCTION)).toContain("pid differs");
	});

	test("refuses a recorded child whose birth was not verified", () => {
		expect(mayStopFixture(proc(), { ...STATE, startSeconds: null }, PRODUCTION)).not.toBeNull();
	});

	test("refuses a reused pid whose start time moved", () => {
		expect(mayStopFixture(proc({ startSeconds: 1791479999.5 }), STATE, PRODUCTION)).toContain("reused");
	});

	test("refuses a wrong entry point, including the twin's", () => {
		expect(mayStopFixture(proc({ argv: ["/root/.bun/bin/bun", "--no-env-file", "packages/mcp-server/src/index.ts"] }), STATE, PRODUCTION)).toContain(
			"entry point",
		);
	});

	test("refuses a cwd outside the recorded checkout", () => {
		expect(mayStopFixture(proc({ cwd: "/root/src/repos/agent-substrate" }), STATE, PRODUCTION)).toContain("cwd");
	});

	test("refuses a process in system.slice", () => {
		expect(mayStopFixture(proc({ cgroup: "0::/system.slice/substrate-fixture.service" }), STATE, PRODUCTION)).toContain("system.slice");
	});

	test("refuses a process that owns a production port", () => {
		expect(mayStopFixture(proc({ listensOn: [18410, 7410] }), STATE, PRODUCTION)).toContain("production port");
	});
});

describe("confirmFixtureSpawn", () => {
	const deps = (over: {
		alive?: boolean;
		start?: number | null;
		ports?: number[] | null;
	} = {}): { alive: (pid: number) => boolean; startOf: (pid: number) => number | null; listensOn: (pid: number) => number[] | null } => ({
		alive: () => over.alive ?? true,
		startOf: () => over.start ?? 1791479652.17,
		listensOn: () => (over.ports === undefined ? [18410] : over.ports),
	});

	test("confirms the live owner and refuses strangers", () => {
		expect(confirmFixtureSpawn(424243, 18410, 1791479652.17, deps())).toBeNull();
		expect(confirmFixtureSpawn(424243, 18410, 1791479652.17, deps({ alive: false }))).toContain("is gone");
		expect(confirmFixtureSpawn(424243, 18410, 1791479000, deps())).toContain("reused");
		expect(confirmFixtureSpawn(424243, 18410, 1791479652.17, deps({ ports: [9999] }))).toContain("does not own port");
		expect(confirmFixtureSpawn(424243, 18410, 1791479652.17, deps({ ports: null }))).toContain("could not read");
	});
});

describe("parseFixtureCounts", () => {
	test("accepts the served shape and rejects the rest", () => {
		expect(parseFixtureCounts({ requests: 3, retrievals: 1, uploads: 2, documents: 2 })).toEqual({
			requests: 3,
			retrievals: 1,
			uploads: 2,
			documents: 2,
		});
		expect(parseFixtureCounts(null)).toBeNull();
		expect(parseFixtureCounts({ requests: 3, retrievals: 1 })).toBeNull();
		expect(parseFixtureCounts({ requests: -1, retrievals: 0, uploads: 0, documents: 0 })).toBeNull();
		expect(parseFixtureCounts({ requests: 1.5, retrievals: 0, uploads: 0, documents: 0 })).toBeNull();
		expect(parseFixtureCounts({ requests: "3", retrievals: 0, uploads: 0, documents: 0 })).toBeNull();
	});
});

describe("control body shapes", () => {
	test("fail-retrieval takes only the bounded statuses or null", () => {
		expect(parseFailRetrievalBody({ status: 503 })).toEqual({ status: 503 });
		expect(parseFailRetrievalBody({ status: 500 })).toEqual({ status: 500 });
		expect(parseFailRetrievalBody({ status: 502 })).toEqual({ status: 502 });
		expect(parseFailRetrievalBody({ status: null })).toEqual({ status: null });
		expect(parseFailRetrievalBody({ status: 400 })).toBeNull();
		expect(parseFailRetrievalBody({ status: "503" })).toBeNull();
		expect(parseFailRetrievalBody(null)).toBeNull();
		expect(parseFailRetrievalBody({})).toBeNull();
	});

	test("parse takes only done or never", () => {
		expect(parseParseBehaviourBody({ behavior: "done" })).toEqual({ behavior: "done" });
		expect(parseParseBehaviourBody({ behavior: "never" })).toEqual({ behavior: "never" });
		expect(parseParseBehaviourBody({ behavior: "sometimes" })).toBeNull();
		expect(parseParseBehaviourBody(null)).toBeNull();
	});

	test("seed-chunks takes a bounded dataset with defaulted per-chunk fields", () => {
		const parsed = parseSeedChunksBody({
			dataset: "ds-berlin-agent-substrate",
			chunks: [{ content: "marker", document_id: "seed-x-1", score: 0.5 }],
		});
		expect(parsed?.seeds).toEqual([
			{
				dataset: "ds-berlin-agent-substrate",
				content: "marker",
				document_id: "seed-x-1",
				source_url: "",
				heading_path: "",
				score: 0.5,
			},
		]);
		const defaulted = parseSeedChunksBody({
			dataset: "ds-a",
			chunks: [{ content: "c", document_id: "d", dataset: "ds-b" }],
		});
		expect(defaulted?.seeds[0]?.dataset).toBe("ds-b");
		expect(parseSeedChunksBody({ dataset: "ds-a", chunks: [] })).toBeNull();
		expect(parseSeedChunksBody({ dataset: "", chunks: [{ content: "c", document_id: "d" }] })).toBeNull();
		expect(parseSeedChunksBody({ dataset: "ds-a", chunks: [{ content: "", document_id: "d" }] })).toBeNull();
		expect(parseSeedChunksBody({ dataset: "ds-a", chunks: [{ content: "c", document_id: "" }] })).toBeNull();
		expect(parseSeedChunksBody({ dataset: "ds-a", chunks: [{ content: "c", document_id: "d", score: 2 }] })).toBeNull();
		expect(parseSeedChunksBody({ dataset: "ds-a", chunks: new Array(FIXTURE_SEED_MAX_CHUNKS + 1).fill({ content: "c", document_id: "d" }) })).toBeNull();
		expect(parseSeedChunksBody(null)).toBeNull();
	});
});

describe("bounded fetch helpers", () => {
	test("an unparseable endpoint is not ready", async () => {
		expect(await checkFixtureReady("http://127.0.0.1:1", 50)).toBe(false);
	});

	test("a closed loopback port is not ready", async () => {
		expect(await checkFixtureReady("http://127.0.0.1:9", 500)).toBe(false);
	});
});
