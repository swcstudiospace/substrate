import { describe, expect, test } from "bun:test";
import { canonicalJson, eventHash, InvalidEventError, normalizeEvent, verifyChain } from "./event.ts";
import { REDACTED } from "./redact.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const base: EventInput = {
	surface: "claude-code",
	kind: "file.edit",
	summary: "edited gateway/ws.rs, ran cargo test (pass)",
	session_id: "sess-1",
	graph_id: "ut-mz3k1q-8a1f2c3d",
	node_id: "n2",
	repo: "swcstudiospace/autonogrammer",
};

describe("canonicalJson", () => {
	test("sorts object keys so two encoders agree", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	test("preserves array order, which is meaningful", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	test("sorts nested keys too", () => {
		expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
	});

	test("drops undefined values rather than emitting invalid JSON", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});

describe("normalizeEvent", () => {
	test("fills id, ts, actor and hash", () => {
		const event = normalizeEvent(base, null);
		expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
		expect(event.actor).toBe("agent");
		expect(event.prev).toBeNull();
		expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(new Date(event.ts).getTime()).toBeGreaterThan(0);
	});

	test("redacts the summary and the payload on the write path", () => {
		const event = normalizeEvent(
			{ ...base, summary: "exported PGPASSWORD=s3cr3t", payload: { api_key: "abc", cmd: "cargo test" } },
			null,
		);
		expect(event.summary).toBe(`exported PGPASSWORD=${REDACTED}`);
		expect(event.payload.api_key).toBe(REDACTED);
		expect(event.payload.cmd).toBe("cargo test");
	});

	test("rejects an unknown surface or kind rather than storing it", () => {
		expect(() => normalizeEvent({ ...base, surface: "nope" as never }, null)).toThrow(InvalidEventError);
		expect(() => normalizeEvent({ ...base, kind: "nope" as never }, null)).toThrow(InvalidEventError);
	});

	test("requires a summary", () => {
		expect(() => normalizeEvent({ ...base, summary: "" }, null)).toThrow(InvalidEventError);
	});

	test("rejects an unparseable timestamp", () => {
		expect(() => normalizeEvent({ ...base, ts: "not-a-date" }, null)).toThrow(InvalidEventError);
	});

	test("truncates a runaway summary", () => {
		const event = normalizeEvent({ ...base, summary: "x".repeat(5000) }, null);
		expect(event.summary.length).toBe(2000);
	});

	test("redacts every free-text field, not only the summary", () => {
		// A branch name and a session id are agent-supplied too, and there is no
		// second chance once the row is in an append-only log.
		const event = normalizeEvent(
			{
				...base,
				branch: "fix/GITHUB_TOKEN=ghp_pasted_by_accident",
				session_id: "sess-authorization: Bearer abcdefghijklmnop",
				repo: "swcstudiospace/x",
			},
			null,
		);
		expect(event.branch).toBe(`fix/GITHUB_TOKEN=${REDACTED}`);
		expect(event.session_id).toBe(`sess-authorization: ${REDACTED}`);
		expect(event.repo).toBe("swcstudiospace/x");
	});

	test("redacts before truncating, so a cut-off token cannot survive", () => {
		// Truncating first would leave a fragment the pattern no longer matches.
		const token = `ghp_${"a".repeat(40)}`;
		const event = normalizeEvent({ ...base, summary: `${"x".repeat(1990)} ${token}` }, null);
		expect(event.summary).not.toContain("ghp_");
	});

	test("an empty optional field is stored as NULL, not as an empty string", () => {
		const event = normalizeEvent({ ...base, branch: "", node_id: undefined }, null);
		expect(event.branch).toBeNull();
		expect(event.node_id).toBeNull();
	});

	test("keeps step a whole number", () => {
		expect(normalizeEvent({ ...base, step: 2.7 }, null).step).toBe(2);
		expect(normalizeEvent({ ...base, step: Number.NaN }, null).step).toBeNull();
	});
});

describe("payload limits", () => {
	test("caps an individual oversized string but keeps its siblings", () => {
		const event = normalizeEvent({ ...base, payload: { diff: "d".repeat(9000), file: "ws.rs" } }, null);
		expect(String(event.payload.diff)).toContain("[truncated]");
		expect(String(event.payload.diff).length).toBeLessThan(4100);
		expect(event.payload.file).toBe("ws.rs");
	});

	test("replaces a payload that is still oversized after capping", () => {
		// Many medium strings pass the per-string cap and still bloat the log, so
		// the whole payload is swapped for a marker rather than half-written.
		const payload: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) payload[`k${i}`] = "v".repeat(2000);
		const event = normalizeEvent({ ...base, payload }, null);
		expect(event.payload._dropped).toContain("exceeded");
		expect(typeof event.payload._bytes).toBe("number");
		expect(event.payload.k0).toBeUndefined();
	});

	test("caps strings nested in arrays and objects", () => {
		const event = normalizeEvent({ ...base, payload: { runs: [{ out: "o".repeat(9000) }] } }, null);
		const runs = event.payload.runs as Array<{ out: string }>;
		expect(runs[0]?.out).toContain("[truncated]");
	});

	test("leaves a payload within the limits untouched", () => {
		const payload = { cmd: "cargo test", exit: 0, ok: true, files: ["a.rs"] };
		expect(normalizeEvent({ ...base, payload }, null).payload).toEqual(payload);
	});
});

describe("hash chain", () => {
	test("the hash covers prev, so reordering is detectable", () => {
		const first = normalizeEvent(base, null);
		const second = normalizeEvent(base, first.hash);
		const { hash: _h, ...rest } = second;
		expect(eventHash({ ...rest, prev: "something-else" })).not.toBe(second.hash);
	});

	test("verifies an intact chain", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const c = normalizeEvent({ ...base, summary: "committed 3f2a1c" }, b.hash);
		expect(verifyChain([a, b, c])).toEqual({ ok: true });
	});

	test("flags an altered event", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const tampered: SubstrateEvent = { ...b, summary: "ran rm -rf /" };
		const result = verifyChain([a, tampered]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.brokenAt).toBe(b.id);
			expect(result.reason).toContain("hash");
		}
	});

	test("flags a spliced-out event", () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const c = normalizeEvent({ ...base, summary: "committed 3f2a1c" }, b.hash);
		const result = verifyChain([a, c]); // b removed
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("prev");
	});
});
