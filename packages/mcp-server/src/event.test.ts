import { describe, expect, test } from "bun:test";
import {
	assertWriteTextFields,
	canonicalJson,
	type ChainLink,
	compareToAnchoredHead,
	eventHash,
	GraphIdNulError,
	GraphIdTooLongError,
	headRecordsFromLeaves,
	inChainOrder,
	InvalidEventError,
	normalizeEvent,
	normalizeIdentifier,
	normalizeKey,
	sha256Hex,
	steeringSessionPayload,
	type SteeringSession,
	type StoredLeaf,
	verifyChain,
} from "./event.ts";
import { REDACTED } from "./redact.ts";
import { steeringSessionEvent } from "./planning/session-state.ts";
import { steeringQueuedEvent } from "./planning/steering-delivery.ts";
import { defined } from "./test-support.ts";
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
		const { node_id: _present, ...withoutNode } = base;
		const event = normalizeEvent({ ...withoutNode, branch: "" }, null);
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

describe("inChainOrder", () => {
	const chain = () => {
		const a = normalizeEvent(base, null);
		const b = normalizeEvent({ ...base, summary: "ran cargo build" }, a.hash);
		const c = normalizeEvent({ ...base, summary: "committed 3f2a1c" }, b.hash);
		return { a, b, c };
	};

	test("restores the order a shared millisecond loses", () => {
		// The regression: with append_mode both rows survive a same-millisecond
		// append, and Greptime may return them in either order. Verifying what it
		// happened to return would report a break in an intact chain.
		const { a, b, c } = chain();
		expect(verifyChain([c, a, b]).ok).toBe(false);
		expect(verifyChain(inChainOrder([c, a, b]))).toEqual({ ok: true });
	});

	test("leaves an already-ordered chain alone", () => {
		const { a, b, c } = chain();
		expect(inChainOrder([a, b, c]).map((event) => event.id)).toEqual([a.id, b.id, c.id]);
	});

	test("orders rows that do not reach back to the first event", () => {
		// A window into the middle of a session: nothing here has prev === null.
		const { b, c } = chain();
		expect(inChainOrder([c, b]).map((event) => event.id)).toEqual([b.id, c.id]);
	});

	test("still reports a spliced-out event rather than hiding the gap", () => {
		const { a, c } = chain();
		const result = verifyChain(inChainOrder([a, c]));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("prev");
	});

	test("still reports a tampered event", () => {
		// Ordering by `prev` must not make the hash check vacuous.
		const { a, b } = chain();
		const result = verifyChain(inChainOrder([a, { ...b, summary: "ran rm -rf /" }]));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("hash");
	});

	test("reports a fork instead of silently following one branch", () => {
		// Two events claiming the same prev, which concurrent appends can produce.
		const { a, b } = chain();
		const rival = normalizeEvent({ ...base, summary: "another agent, same session" }, a.hash);
		const ordered = inChainOrder([a, b, rival]);
		expect(ordered).toHaveLength(3); // nothing dropped from the count
		expect(verifyChain(ordered).ok).toBe(false);
	});

	test("keeps every event when the chain is a cycle", () => {
		const { a, b } = chain();
		expect(inChainOrder([{ ...a, prev: b.hash }, b])).toHaveLength(2);
	});
});

describe("normalizeIdentifier", () => {
	test("matches what normalizeEvent stores, so a lookup by it can hit", () => {
		// The bug this prevents: `emit` looked the session up by the raw id while
		// storing a cleaned one, so every append restarted the chain.
		const raw = `sess-GITHUB_TOKEN=ghp_${"a".repeat(40)}`;
		expect(normalizeEvent({ ...base, session_id: raw }, null).session_id).toBe(normalizeIdentifier(raw));
		expect(normalizeIdentifier(raw)).toContain(REDACTED);
	});

	test("agrees with the stored value for an over-long identifier", () => {
		const raw = "s".repeat(900);
		expect(normalizeEvent({ ...base, session_id: raw }, null).session_id).toBe(normalizeIdentifier(raw));
		expect(normalizeIdentifier(raw)?.length).toBe(512);
	});

	test("leaves an ordinary identifier untouched", () => {
		expect(normalizeIdentifier("ut-mz3k1q-8a1f2c3d")).toBe("ut-mz3k1q-8a1f2c3d");
		expect(normalizeIdentifier(undefined)).toBeNull();
	});
});

describe("normalizeKey", () => {
	// A surrogate pair across the 512-unit cap: the cap leaves a lone high surrogate, which the stored form drops.
	const straddling = (head: string) => `${head.padEnd(511, "s")}\u{1F600}`;

	test("matches what normalizeEvent stores for a session id whose surrogate pair straddles the cap", () => {
		const raw = straddling("sess-");
		const stored = normalizeEvent({ ...base, session_id: raw }, null).session_id;
		expect(stored).toBe(raw.slice(0, 511));
		expect(normalizeKey(raw)).toBe(stored);
	});

	test("refuses a repo whose surrogate pair straddles the cap on write, by name", () => {
		// 513 code units: the write refuses it. A read still cuts it, as it always has.
		const raw = straddling("owner/");
		expect(() => normalizeEvent({ ...base, repo: raw }, null)).toThrow("repo_too_long:");
		expect(normalizeKey(raw)).toBe(raw.slice(0, 511));
	});

	test("drops the dangling high surrogate that normalizeIdentifier keeps", () => {
		expect(normalizeIdentifier(straddling("sess-"))?.endsWith("\uD83D")).toBe(true);
		expect(normalizeKey(straddling("sess-"))?.endsWith("\uD83D")).toBe(false);
	});

	test("leaves an ordinary identifier and an absent one as normalizeIdentifier does", () => {
		expect(normalizeKey("ut-mz3k1q-8a1f2c3d")).toBe("ut-mz3k1q-8a1f2c3d");
		expect(normalizeKey(undefined)).toBeNull();
		expect(normalizeKey("")).toBeNull();
	});
});

describe("graph id cap on the write path", () => {
	test("refuses a graph id of 513 characters by name, rather than storing it cut to 512", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "g".repeat(513) }, null)).toThrow(GraphIdTooLongError);
		expect(() => normalizeEvent({ ...base, graph_id: "g".repeat(900) }, null)).toThrow("graph_id_too_long:");
	});

	test("refuses a graph id over 512 UTF-8 bytes even when it is under 512 characters", () => {
		// 257 characters of two bytes each: 514 bytes.
		expect(() => normalizeEvent({ ...base, graph_id: "é".repeat(257) }, null)).toThrow(GraphIdTooLongError);
		// 512 characters of three bytes each: 1,536 bytes.
		expect(() => normalizeEvent({ ...base, graph_id: "€".repeat(512) }, null)).toThrow(GraphIdTooLongError);
	});

	test("accepts a 512-character ASCII graph id unchanged", () => {
		const graphId = "g".repeat(512);
		expect(normalizeEvent({ ...base, graph_id: graphId }, null).graph_id).toBe(graphId);
	});

	test("accepts a graph id of exactly 512 UTF-8 bytes", () => {
		const graphId = "é".repeat(256);
		expect(normalizeEvent({ ...base, graph_id: graphId }, null).graph_id).toBe(graphId);
	});

	test("the refusal is an InvalidEventError, so the existing 400 path answers it", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "€".repeat(512) }, null)).toThrow(InvalidEventError);
	});

	test("an absent or empty graph id stays null", () => {
		expect(normalizeEvent({ ...base, graph_id: undefined }, null).graph_id).toBeNull();
		expect(normalizeEvent({ ...base, graph_id: "" }, null).graph_id).toBeNull();
	});

	test("refuses a graph id with a NUL byte at write, by name", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "g\u0000x" }, null)).toThrow(GraphIdNulError);
		expect(() => normalizeEvent({ ...base, graph_id: "g\u0000x" }, null)).toThrow("graph_id_nul:");
	});

	test("refuses a graph id with a lone high surrogate at write, by name", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "g\uD800x" }, null)).toThrow("graph_id_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, graph_id: "g\uD800x" }, null)).toThrow("U+D800");
	});

	test("refuses a graph id with a lone low surrogate at write, by name", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "\uDC00g" }, null)).toThrow("graph_id_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, graph_id: "\uDC00g" }, null)).toThrow("U+DC00");
	});

	test("refuses a high surrogate that is followed by another high surrogate, not a low one", () => {
		expect(() => normalizeEvent({ ...base, graph_id: "\uD83D\uD83D\uDE42" }, null)).toThrow("graph_id_lone_surrogate:");
	});

	test("the lone surrogate refusal is a named subclass of InvalidEventError", () => {
		let refused: unknown;
		try {
			normalizeEvent({ ...base, graph_id: "x\uD83D" }, null);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(InvalidEventError);
		expect((refused as Error).constructor.name).toBe("GraphIdLoneSurrogateError");
	});

	test("accepts a well-formed astral character, written as a surrogate pair or as one code point", () => {
		const astral = "graph-\u{1F642}-x";
		expect(normalizeEvent({ ...base, graph_id: astral }, null).graph_id).toBe(astral);
		const pair = "graph-\uD83D\uDE42-x";
		expect(normalizeEvent({ ...base, graph_id: pair }, null).graph_id).toBe(pair);
	});

	test("accepts a graph id with a newline, which is not a NUL", () => {
		const graphId = "first line\nsecond line";
		expect(normalizeEvent({ ...base, graph_id: graphId }, null).graph_id).toBe(graphId);
	});
});

describe("repo cap on the write path", () => {
	// "owner/" is six code units, so 507 more makes 513 and 506 more makes 512.
	test("refuses a repo of 513 code units by name, rather than storing it cut to 512", () => {
		const repo = `owner/${"r".repeat(507)}`;
		expect(repo.length).toBe(513);
		let refused: unknown;
		try {
			normalizeEvent({ ...base, repo }, null);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(InvalidEventError);
		expect((refused as Error).constructor.name).toBe("RepoTooLongError");
		expect((refused as Error).message).toBe("repo_too_long: a repo may not exceed 512 code units; got 513");
	});

	test("refuses an over-long repo in the sessioned path's text-field check, before any chain read", () => {
		expect(() => assertWriteTextFields({ ...base, repo: `owner/${"r".repeat(507)}` })).toThrow("repo_too_long:");
	});

	test("accepts a repo of exactly 512 code units, stored unchanged", () => {
		const repo = `owner/${"r".repeat(506)}`;
		expect(repo.length).toBe(512);
		expect(normalizeEvent({ ...base, repo }, null).repo).toBe(repo);
	});

	test("accepts a 512-unit repo whose last two units are an astral pair, stored unchanged", () => {
		const repo = `owner/${"r".repeat(504)}\u{1F600}`;
		expect(repo.length).toBe(512);
		expect(normalizeEvent({ ...base, repo }, null).repo).toBe(repo);
	});
});

describe("lone surrogates in the other write text fields", () => {
	test("refuses a lone high surrogate in the summary, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, summary: "ran \uD800 tests" }, null)).toThrow(InvalidEventError);
		expect(() => normalizeEvent({ ...base, summary: "ran \uD800 tests" }, null)).toThrow("summary_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, summary: "ran \uD800 tests" }, null)).toThrow("U+D800");
	});

	test("refuses a lone low surrogate in the summary, by name", () => {
		expect(() => normalizeEvent({ ...base, summary: "ran \uDC00 tests" }, null)).toThrow("summary_lone_surrogate:");
	});

	test("refuses a lone high surrogate in the session id, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, session_id: "sess-\uD800" }, null)).toThrow("session_id_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, session_id: "sess-\uD800" }, null)).toThrow("U+D800");
	});

	test("refuses a lone high surrogate in the repo, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, repo: "swcstudiospace/\uD800x" }, null)).toThrow("repo_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, repo: "swcstudiospace/\uD800x" }, null)).toThrow("U+D800");
	});

	test("refuses a lone high surrogate in the branch, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, branch: "feat/\uD800x" }, null)).toThrow("branch_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, branch: "feat/\uD800x" }, null)).toThrow("U+D800");
	});

	test("refuses a lone high surrogate in the node id, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, node_id: "n\uD800" }, null)).toThrow("node_id_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, node_id: "n\uD800" }, null)).toThrow("U+D800");
	});

	test("refuses a lone high surrogate in the linear identifier, by name, with its code unit", () => {
		expect(() => normalizeEvent({ ...base, linear_identifier: "ENG-\uD800" }, null)).toThrow("linear_identifier_lone_surrogate:");
		expect(() => normalizeEvent({ ...base, linear_identifier: "ENG-\uD800" }, null)).toThrow("U+D800");
	});

	test("accepts a well-formed astral character in the summary, as a surrogate pair or as one code point", () => {
		const pair = "shipped the page \uD83D\uDE42";
		const point = "shipped the page \u{1F642}";
		expect(normalizeEvent({ ...base, summary: pair }, null).summary).toBe(pair);
		expect(normalizeEvent({ ...base, summary: point }, null).summary).toBe(point);
	});

	test("does not refuse a surrogate pair that the summary cap cuts in half", () => {
		// The caller's text is well formed; the cut belongs to the length cap, so it is not refused here.
		expect(() => normalizeEvent({ ...base, summary: `${"x".repeat(1999)}\u{1F642}` }, null)).not.toThrow();
	});

	test("stores a summary whose surrogate pair the length cap cuts without a lone surrogate at its end", () => {
		// 1,999 ASCII characters, then a pair that straddles character 2,000, which the cap cuts.
		const event = normalizeEvent({ ...base, summary: `${"x".repeat(1999)}\u{1F642}` }, null);
		expect(event.summary).toBe("x".repeat(1999));
		expect(event.summary.length).toBe(1999);
	});
});

describe("assertWriteTextFields refuses a lone surrogate in each write text field", () => {
	const clean = {
		summary: "ran cargo test",
		session_id: "sess-1",
		repo: "swcstudiospace/autonogrammer",
		branch: "gsd/v18-int-all",
		node_id: "n2",
		linear_identifier: "ENG-123",
	};

	test("refuses a lone high surrogate in each of the six fields, by name", () => {
		for (const field of ["summary", "session_id", "repo", "branch", "node_id", "linear_identifier"] as const) {
			expect(() => assertWriteTextFields({ ...clean, [field]: "a\uD800b" })).toThrow(InvalidEventError);
			expect(() => assertWriteTextFields({ ...clean, [field]: "a\uD800b" })).toThrow(`${field}_lone_surrogate:`);
		}
	});

	test("refuses a lone low surrogate in each of the six fields, by name", () => {
		for (const field of ["summary", "session_id", "repo", "branch", "node_id", "linear_identifier"] as const) {
			expect(() => assertWriteTextFields({ ...clean, [field]: "a\uDC00b" })).toThrow(`${field}_lone_surrogate:`);
		}
	});

	test("does not throw for clean input, including well-formed astral characters", () => {
		expect(() => assertWriteTextFields(clean)).not.toThrow();
		expect(() => assertWriteTextFields({ ...clean, summary: "shipped \u{1F642}", branch: "feat/\uD83D\uDE42" })).not.toThrow();
	});

	test("does not throw when the optional fields are absent", () => {
		expect(() => assertWriteTextFields({ summary: "ran cargo test" })).not.toThrow();
	});
});

describe("new live events expose public metadata only", () => {
	const privateFields = {
		steering: "PRIVATE_DIRECTION_MARKER_71",
		planning_hash: "a1".repeat(32),
		session_binding: "sb_PRIVATE_PROOF_MARKER_71",
		proof_hash: "b2".repeat(32),
		body: "PRIVATE_DIRECTIVE_BODY_MARKER_71",
		directive_count: 731,
		question: "PRIVATE_AUGMENTED_QUESTION_MARKER_71",
		nested: { steering: "PRIVATE_NESTED_MARKER_71" },
	};
	const session: SteeringSession & typeof privateFields = {
		session_id: `ls_${"c3".repeat(32)}`,
		repo_id: "owner/repo",
		state: "CONTEXT_REFRESH",
		updated_at: "2026-10-31T12:00:00.000Z",
		...privateFields,
	};
	const publicPayload = {
		action: "docs.steering",
		repo_id: session.repo_id,
		session_id: session.session_id,
		state: session.state,
		updated_at: session.updated_at,
		non_blocking: true,
	};

	function expectNoPrivateFields(value: unknown): void {
		const serialized = JSON.stringify(value);
		for (const marker of [
			privateFields.steering,
			privateFields.planning_hash,
			privateFields.session_binding,
			privateFields.proof_hash,
			privateFields.body,
			privateFields.question,
			privateFields.nested.steering,
		]) expect(serialized).not.toContain(marker);
	}

	test("the transition payload is an exact allowlist, with previous state only when supplied", () => {
		expect(steeringSessionPayload(session)).toEqual(publicPayload);
		expect(steeringSessionPayload(session, "ACTIVE")).toEqual({ ...publicPayload, previous_state: "ACTIVE" });
		expectNoPrivateFields(steeringSessionPayload(session, "ACTIVE"));
	});

	test("the actual transition producer ignores private snapshot fields and arbitrary acknowledgement extras", () => {
		for (const state of ["CONTEXT_REFRESH", "PAUSED"] as const) {
			const event = steeringSessionEvent("omp", { ...session, state }, "ACTIVE", {
				...privateFields,
				directive_id: "steer-public-71",
				via: "steering_acknowledge",
			});
			expect(event.kind).toBe(state === "PAUSED" ? "warning" : "note");
			expect(event.session_id).toBe(session.session_id);
			expect(event.repo).toBe(session.repo_id);
			expect(event.payload).toEqual({
				...publicPayload,
				state,
				previous_state: "ACTIVE",
				directive_id: "steer-public-71",
				via: "steering_acknowledge",
			});
			const stored = normalizeEvent(event, null);
			expect(stored.payload).toEqual(defined(event.payload, "transition event payload"));
			expectNoPrivateFields(stored);
		}
	});

	test("unknown transition extras cannot overwrite public metadata or become a via marker", () => {
		const event = steeringSessionEvent("omp", session, undefined, {
			...privateFields,
			action: "private-action-marker-71",
			session_id: "private-target-marker-71",
			repo_id: "private/repo",
			state: "PAUSED",
			updated_at: "private-time-marker-71",
			non_blocking: false,
			via: "PRIVATE_NESTED_MARKER_71",
			directive_id: { body: privateFields.body },
		});
		expect(event.payload).toEqual(publicPayload);
		expectNoPrivateFields(normalizeEvent(event, null));
	});

	test("the queued wake event omits command action, priority, body, counts and nested extras", () => {
		const directive = {
			id: "steer-public-71",
			targetSessionId: session.session_id,
			action: "pause" as const,
			priority: "high" as const,
			...privateFields,
		};
		const event = steeringQueuedEvent(directive);
		expect(event.payload).toEqual({
			action: "steering.queued",
			directive_id: directive.id,
			session_id: session.session_id,
			non_blocking: true,
		});
		const stored = normalizeEvent(event, null);
		expect(stored.payload).toEqual(defined(event.payload, "queued event payload"));
		expect(stored.payload).not.toHaveProperty("priority");
		expect(stored.payload).not.toHaveProperty("directive_action");
		expectNoPrivateFields(stored);
	});
});

describe("historical event payload compatibility", () => {
	test("generic historical append does not retroactively apply the new live-producer allowlist", () => {
		const payload = {
			action: "docs.steering",
			steering: "historically-published-direction-71",
			planning_hash: "d4".repeat(32),
			directive_count: 7,
			nested: { body: "historically-published-body-71" },
		};
		const stored = normalizeEvent({
			surface: "omp",
			kind: "note",
			session_id: "historical-session-71",
			summary: "historical caller-controlled payload",
			payload,
		}, null);
		expect(stored.session_id).toBe("historical-session-71");
		expect(stored.payload).toEqual(payload);
	});
});

describe("chain leaves and the anchored head (D73-02, D73-03)", () => {
	const H10 = Date.UTC(2026, 8, 26, 10);
	const hashOf = (text: string): string => sha256Hex(text);
	const leaf = (seq: number, eventId: string, hash: string = hashOf(eventId)): StoredLeaf => ({
		graph_id: "graph-a",
		session_id: "s",
		seq,
		event_id: eventId,
		hash,
	});
	const link = (id: string, prev: string | null = null): ChainLink => ({ id, hash: hashOf(id), storedHash: hashOf(id), prev });
	const headOf = (stored: StoredLeaf[]) => {
		const head = headRecordsFromLeaves(stored, H10)?.[0];
		if (head === undefined) throw new Error("the leaves form no head");
		return head;
	};

	const ids = ["evt_1", "evt_2", "evt_3", "evt_4"];
	const leaves = ids.map((id, seq) => leaf(seq, id));
	const head = headOf(leaves);
	const intact = ids.map((id) => link(id));

	test("an intact chain agrees with its anchored head", () => {
		expect(compareToAnchoredHead(intact, leaves, head)).toEqual({ ok: true });
	});

	test("changing any stored event id changes the leaves root, so the leaves no longer reproduce the head", () => {
		for (const seq of [0, 1, 2]) {
			const forged = leaves.map((stored) => (stored.seq === seq ? { ...stored, event_id: "evt_forged" } : stored));
			expect(headOf(forged).leavesRootHex).not.toBe(head.leavesRootHex);
			expect(compareToAnchoredHead(intact, forged, head)).toMatchObject({ ok: false, kind: "stored-leaves-mismatch" });
		}
	});

	test("a deleted middle event is first-missing at the deleted id", () => {
		const without = intact.filter((event) => event.id !== "evt_2");
		expect(compareToAnchoredHead(without, leaves, head)).toEqual({ ok: false, kind: "first-missing", eventId: "evt_2" });
	});

	test("a truncated tail is first-missing at the first absent event", () => {
		const truncated = intact.filter((event) => event.id !== "evt_3" && event.id !== "evt_4");
		expect(compareToAnchoredHead(truncated, leaves, head)).toEqual({ ok: false, kind: "first-missing", eventId: "evt_3" });
	});

	test("an edited payload is first-differing at the edited event", () => {
		const edited = intact.map((event) => (event.id === "evt_2" ? { ...event, hash: hashOf("evt_2 edited") } : event));
		expect(compareToAnchoredHead(edited, leaves, head)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_2" });
	});

	test("a row whose stored hash no longer matches its content is first-differing at that row", () => {
		const rewritten = intact.map((event) => (event.id === "evt_3" ? { ...event, storedHash: hashOf("evt_3 rewritten") } : event));
		expect(compareToAnchoredHead(rewritten, leaves, head)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_3" });
	});

	test("an event past the stored end is first-differing", () => {
		const extended = [...intact, link("evt_5", hashOf("evt_4"))];
		expect(compareToAnchoredHead(extended, leaves, head)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_5" });
	});

	test("two rows under one id are first-differing at that id", () => {
		expect(compareToAnchoredHead([...intact, link("evt_2")], leaves, head)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_2" });
	});

	test("in a later-hour slice a middle payload edit names that event, not an intact successor", () => {
		// evt_a0 sorts before evt_m1 and its prev points at the edited event's old hash: an order built from changed hashes would start there.
		const sliceLeaves = [leaf(0, "evt_m1"), leaf(1, "evt_m2"), leaf(2, "evt_a0")];
		const sliceHead = headOf(sliceLeaves);
		const sliceEvents: ChainLink[] = [
			{ id: "evt_m1", hash: hashOf("evt_m1"), storedHash: hashOf("evt_m1"), prev: hashOf("previous hour") },
			{ id: "evt_m2", hash: hashOf("evt_m2 edited"), storedHash: hashOf("evt_m2"), prev: hashOf("evt_m1") },
			{ id: "evt_a0", hash: hashOf("evt_a0"), storedHash: hashOf("evt_a0"), prev: hashOf("evt_m2") },
		];
		expect(compareToAnchoredHead(sliceEvents, sliceLeaves, sliceHead)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_m2" });
	});

	test("an edit past the committed end names the event that links to the head, not an intact successor that sorts first", () => {
		// evt_z was appended after the anchored head and its payload was then edited, so its recomputed hash no longer matches the stored one.
		// evt_a sorts first and its prev is evt_z's stored hash: an order built from the changed hashes would start there.
		const extended: ChainLink[] = [
			...intact,
			{ id: "evt_z", hash: hashOf("evt_z edited"), storedHash: hashOf("evt_z"), prev: hashOf("evt_4") },
			{ id: "evt_a", hash: hashOf("evt_a"), storedHash: hashOf("evt_a"), prev: hashOf("evt_z") },
		];
		expect(compareToAnchoredHead(extended, leaves, head)).toEqual({ ok: false, kind: "first-differing", eventId: "evt_z" });
	});

	test("a leaf with an empty event id is no head and does not throw", () => {
		const blank = leaves.map((stored) => (stored.seq === 3 ? { ...stored, event_id: "" } : stored));
		expect(() => headRecordsFromLeaves(blank, H10)).not.toThrow();
		expect(headRecordsFromLeaves(blank, H10)).toBeNull();
		expect(compareToAnchoredHead(intact, blank, head)).toMatchObject({ ok: false, kind: "stored-leaves-mismatch" });
	});

	test("a graph filter rebuilds one graph's records alone: another graph's broken chain does not stop it (design 5, step 8)", () => {
		const broken = [
			{ graph_id: "graph-b", session_id: "s", seq: 0, event_id: "evt_x", hash: hashOf("evt_x") },
			{ graph_id: "graph-b", session_id: "s", seq: 0, event_id: "evt_y", hash: hashOf("evt_y") },
		];
		const mixed = [...leaves, ...broken];
		expect(headRecordsFromLeaves(mixed, H10)).toBeNull();
		expect(headRecordsFromLeaves(mixed, H10, "graph-a")).toEqual([head]);
		expect(headRecordsFromLeaves(mixed, H10, "graph-b")).toBeNull();
		expect(headRecordsFromLeaves(mixed, H10, "graph-c")).toEqual([]);
	});
});
