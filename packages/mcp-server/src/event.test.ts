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
