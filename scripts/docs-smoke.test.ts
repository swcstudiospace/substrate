/**
 * The docs smoke's consumer-visible boundaries. The smoke itself drives a
 * live twin and is proved by running it; these pin the preflight, refusal,
 * verdict, and cleanup parsers it trusts, so a mis-parse cannot turn a
 * failing proof green or a refusal into effects.
 */
import { describe, expect, test } from "bun:test";
import {
	citationsOf,
	citationShapeOk,
	describeRpcError,
	formatCheck,
	isLoopbackHost,
	isPinCommit,
	isPinGap,
	lastJsonFrame,
	parseDocsSmokeArgs,
	parseKeyValues,
	refuseFixtureTarget,
	refuseOwnedBinding,
	toolVerdict,
	parseFixtureCounts,
	type BindingFacts,
	type FixtureTarget,
} from "./docs-smoke.ts";
import { DEFAULT_MCP_PORT, PRODUCTION_PORTS, UNIT_WORKING_DIRECTORY } from "./rehearsal.ts";

function target(over: Partial<FixtureTarget> = {}): FixtureTarget {
	return {
		base: `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
		fixtureUrl: "http://127.0.0.1:19380",
		fixtureEnabled: true,
		fixtureReady: "1",
		operatorToken: "operator-bearer",
		recordName: "owned",
		name: "owned",
		...over,
	};
}

function binding(over: Partial<BindingFacts> = {}): BindingFacts {
	return {
		name: "owned",
		base: `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
		fixtureUrl: "http://127.0.0.1:19380",
		recordEndpoint: "http://127.0.0.1:19380",
		recordPid: "4242",
		fixturePid: 4242,
		mcpPort: DEFAULT_MCP_PORT,
		checkout: "/root/src/worktrees/agent-substrate-v13-current-proof",
		scriptCheckout: "/root/src/worktrees/agent-substrate-v13-current-proof",
		...over,
	};
}

describe("parseDocsSmokeArgs", () => {
	test("a missing --name refuses instead of picking a twin", () => {
		expect(() => parseDocsSmokeArgs([])).toThrow("--name <owned> is required");
	});

	test("takes a named owned instance", () => {
		expect(parseDocsSmokeArgs(["--name", "owned"])).toEqual({ name: "owned" });
	});

	test("an unknown flag refuses instead of running the wrong twin", () => {
		expect(() => parseDocsSmokeArgs(["--nmae", "owned"])).toThrow("unknown flag --nmae");
		expect(() => parseDocsSmokeArgs(["--name"])).toThrow("--name needs a value");
		expect(() => parseDocsSmokeArgs(["owned"])).toThrow("unknown flag owned");
	});
});

describe("isLoopbackHost", () => {
	test("loopback spellings pass, everything else refuses", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("10.0.0.1")).toBe(false);
		expect(isLoopbackHost("example.com")).toBe(false);
		expect(isLoopbackHost("")).toBe(false);
	});
});

describe("refuseFixtureTarget", () => {
	test("a ready fixture twin with a bearer goes", () => {
		expect(refuseFixtureTarget(target())).toBeNull();
	});

	test("a run without the stand-in refuses before any effect", () => {
		expect(refuseFixtureTarget(target({ fixtureEnabled: false }))).toContain("no recording stand-in");
	});

	test("an unready stand-in refuses", () => {
		expect(refuseFixtureTarget(target({ fixtureReady: "0" }))).toContain("not ready");
	});

	test("an anonymous twin refuses", () => {
		expect(refuseFixtureTarget(target({ operatorToken: "" }))).toContain("anonymous");
	});

	test("a record naming another instance refuses", () => {
		expect(refuseFixtureTarget(target({ recordName: "other" }))).toContain("other");
	});

	test("a production twin port refuses", () => {
		expect(refuseFixtureTarget(target({ base: `http://127.0.0.1:${PRODUCTION_PORTS[0]}` }))).not.toBeNull();
	});

	test("a non-loopback twin host refuses", () => {
		expect(refuseFixtureTarget(target({ base: "http://10.0.0.1:17410" }))).toContain("non-loopback");
	});

	test("a twin target carrying credentials refuses", () => {
		expect(refuseFixtureTarget(target({ base: "http://user:pass@127.0.0.1:17410" }))).toContain("credentials");
	});

	test("a non-loopback stand-in refuses", () => {
		expect(refuseFixtureTarget(target({ fixtureUrl: "http://10.0.0.1:19380" }))).toContain("stand-in");
	});

	test("a stand-in on a production port refuses", () => {
		expect(refuseFixtureTarget(target({ fixtureUrl: `http://127.0.0.1:${PRODUCTION_PORTS[0]}` }))).toContain("production");
	});

	test("an unparseable stand-in refuses", () => {
		expect(refuseFixtureTarget(target({ fixtureUrl: "not a url" }))).not.toBeNull();
	});
});

describe("refuseOwnedBinding", () => {
	test("the recorded identity goes", () => {
		expect(refuseOwnedBinding(binding())).toBeNull();
	});

	test("a consumer endpoint that is not the recorded one refuses", () => {
		expect(refuseOwnedBinding(binding({ fixtureUrl: "http://127.0.0.1:19381" }))).toContain("not the recorded endpoint");
	});

	test("a foreign pid refuses even when the number looks plausible", () => {
		expect(refuseOwnedBinding(binding({ recordPid: "4243" }))).toContain("unverifiable");
	});

	test("a twin url off the recorded port refuses", () => {
		expect(refuseOwnedBinding(binding({ base: "http://127.0.0.1:17411" }))).toContain("not the recorded twin port");
	});

	test("a foreign checkout refuses", () => {
		expect(refuseOwnedBinding(binding({ checkout: "/tmp/stranger" }))).toContain("not this checkout");
	});

	test("the production unit checkout refuses", () => {
		expect(refuseOwnedBinding(binding({ checkout: UNIT_WORKING_DIRECTORY, scriptCheckout: UNIT_WORKING_DIRECTORY }))).not.toBeNull();
	});
});

describe("toolVerdict", () => {
	test("a transport failure is a protocol error, never a refusal", () => {
		const verdict = toolVerdict({ status: null, body: null, raw: "error: timeout" });
		expect(verdict.isError).toBe(true);
		expect(verdict.value).toBeNull();
		expect(verdict.protocolError).toContain("transport");
	});

	test("a JSON-RPC error is a protocol error, never a refusal", () => {
		const verdict = toolVerdict({
			status: 200,
			body: { jsonrpc: "2.0", id: 14, error: { code: -32601, message: "Method not found" } },
			raw: "{}",
		});
		expect(verdict.isError).toBe(true);
		expect(verdict.value).toBeNull();
		expect(verdict.protocolError).toContain("json-rpc-error");
	});

	test("an expected refusal keeps its reason payload", () => {
		const verdict = toolVerdict({
			status: 200,
			body: {
				result: {
					isError: true,
					content: [{ text: JSON.stringify({ ok: false, refused: true, reason: "page-too-large", page: "docs/x.md" }) }],
				},
			},
			raw: "{}",
		});
		expect(verdict.isError).toBe(true);
		expect(verdict.protocolError).toBeNull();
		expect(verdict.value?.["reason"]).toBe("page-too-large");
	});

	test("a success carries its value", () => {
		const verdict = toolVerdict({
			status: 200,
			body: { result: { content: [{ text: JSON.stringify({ chunks: [], untrusted: "untrusted text" }) }] } },
			raw: "{}",
		});
		expect(verdict.isError).toBe(false);
		expect(verdict.protocolError).toBeNull();
		expect(verdict.value?.["untrusted"]).toBe("untrusted text");
	});

	test("an unparseable tool payload is a protocol error", () => {
		const verdict = toolVerdict({ status: 200, body: { result: { content: [{ text: "not json" }] } }, raw: "{}" });
		expect(verdict.isError).toBe(true);
		expect(verdict.protocolError).toBe("malformed-tool-payload");
	});

	test("a result without text is a protocol error", () => {
		const verdict = toolVerdict({ status: 200, body: { result: {} }, raw: "{}" });
		expect(verdict.isError).toBe(true);
		expect(verdict.protocolError).toBe("malformed-tool-result");
	});
});

describe("describeRpcError", () => {
	test("names code and message, never the payload", () => {
		expect(describeRpcError({ code: -32601, message: "Method not found" })).toBe("code=-32601 Method not found");
		expect(describeRpcError(null)).toBe("unknown error shape");
	});
});

describe("citationsOf", () => {
	test("reads the chunks array, else null so a miss cannot pass as an answer", () => {
		expect(citationsOf({ chunks: [] })).toEqual([]);
		expect(citationsOf({ chunks: "no" })).toBeNull();
		expect(citationsOf(null)).toBeNull();
		expect(citationsOf("garbage")).toBeNull();
	});
});

describe("citationShapeOk", () => {
	const good = {
		title: "t",
		source_url: "https://example.com/x",
		heading_path: "H",
		commit: "a".repeat(40),
		snippet: "s",
		score: 0.9,
		document_id: "d",
		chunk_id: "c",
	};

	test("a pin commit or an honest gap passes", () => {
		expect(citationShapeOk(good)).toBe(true);
		expect(citationShapeOk({ ...good, commit: "dataset-pin:agent-substrate:unpinned" })).toBe(true);
	});

	test("a false current, an over-cap snippet, or missing ids fail", () => {
		expect(citationShapeOk({ ...good, commit: "v1" })).toBe(false);
		expect(citationShapeOk({ ...good, snippet: "x".repeat(1201) })).toBe(false);
		expect(citationShapeOk({ ...good, source_url: "" })).toBe(false);
		expect(citationShapeOk({ ...good, document_id: 7 })).toBe(false);
		expect(citationShapeOk({ ...good, chunk_id: null })).toBe(false);
	});
});

describe("parseFixtureCounts", () => {
	test("a full zeroed shape parses; anything else is not proof", () => {
		expect(parseFixtureCounts({ requests: 0, retrievals: 0, uploads: 0, documents: 0 })).toEqual({
			requests: 0,
			retrievals: 0,
			uploads: 0,
			documents: 0,
		});
		expect(parseFixtureCounts({ requests: 0, uploads: 0 })).toBeNull();
		expect(parseFixtureCounts({ requests: 0, retrievals: 0, uploads: -1, documents: 0 })).toBeNull();
		expect(parseFixtureCounts(null)).toBeNull();
	});
});

describe("parseKeyValues", () => {
	test("reads CLI status lines and keeps repeats in order", () => {
		expect(parseKeyValues("status=stored\ndocument_id=abc\ndocument_id=def\n")).toEqual({ status: ["stored"], document_id: ["abc", "def"] });
	});

	test("a value may itself contain =", () => {
		expect(parseKeyValues("source=https://x/y?z=1\n")).toEqual({ source: ["https://x/y?z=1"] });
	});

	test("noise lines are ignored", () => {
		expect(parseKeyValues("\nnoise\n=orphan\n")).toEqual({});
	});
});

describe("lastJsonFrame", () => {
	test("reads a plain JSON reply", () => {
		expect(lastJsonFrame('{"status":200}')).toEqual({ status: 200 });
	});

	test("reads the last data frame of a server-sent-events reply", () => {
		expect(lastJsonFrame('event: message\ndata: {"a":1}\n\nevent: message\ndata: {"a":2}\n\n')).toEqual({ a: 2 });
	});

	test("garbage is null, so a transport error cannot pass as an answer", () => {
		expect(lastJsonFrame("not json")).toBeNull();
		expect(lastJsonFrame("")).toBeNull();
	});
});

describe("pin classifiers", () => {
	test("a 40-hex commit is a pin, anything else is not", () => {
		expect(isPinCommit("a".repeat(40))).toBe(true);
		expect(isPinCommit("abc")).toBe(false);
		expect(isPinCommit("")).toBe(false);
		expect(isPinCommit(null)).toBe(false);
	});

	test("a gap name says so, a pin does not", () => {
		expect(isPinGap("dataset-pin:agent-substrate:unpinned")).toBe(true);
		expect(isPinGap("a".repeat(40))).toBe(false);
		expect(isPinGap("")).toBe(false);
	});
});

describe("formatCheck", () => {
	test("a passing check names only what it was given", () => {
		expect(formatCheck("search-shape", true, "count=3")).toBe("  ok   search-shape — count=3\n");
	});

	test("a failing check is unmistakable", () => {
		expect(formatCheck("search-shape", false)).toBe(" FAIL  search-shape\n");
	});
});
