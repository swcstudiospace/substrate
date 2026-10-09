/**
 * The closed-vocabulary lock (Phase 17, FOUND-02).
 *
 * `EVENT_KINDS` is the closed set of 12, in order; `SURFACES` is the v1.2
 * literal of 26 plus exactly one reviewed system surface, `substrate`, for
 * host jobs (operator decision 2026-10-08) — 27 in order, `substrate` last.
 * A later PR that widens either enum has to edit these literals in the same
 * diff, alongside `docs/event-vocabulary.md` and the plan 17-03 baseline
 * check. Runs in plain `bun test`, so every phase's normal verification
 * already catches a change.
 */
import { describe, expect, test } from "bun:test";
import { EVENT_KINDS, SURFACES } from "./types.ts";

describe("the closed event vocabulary", () => {
	test("EVENT_KINDS is the v1.2 literal of 12, in order", () => {
		expect([...EVENT_KINDS]).toEqual([
			"session.start",
			"prompt",
			"claim",
			"tool.call",
			"file.edit",
			"shell",
			"commit",
			"pr",
			"handoff",
			"session.end",
			"note",
			"warning",
		]);
	});

	test("SURFACES is the v1.2 literal of 26 plus substrate last, in order", () => {
		expect([...SURFACES]).toEqual([
			"claude-code",
			"cursor",
			"hermes",
			"omp",
			"muse",
			"grok-build",
			"grok-bot",
			"codex",
			"opencode",
			"pi",
			"rivet-agentos",
			"swarm-a01-orch",
			"swarm-a02-req",
			"swarm-a03-arch",
			"swarm-a04-uxd",
			"swarm-a05-be",
			"swarm-a06-fe",
			"swarm-a07-data",
			"swarm-a08-qa",
			"swarm-a09-rev",
			"swarm-a10-sec",
			"swarm-a11-devops",
			"swarm-a12-rel",
			"swarm-a13-obs",
			"swarm-a14-maint",
			"swarm-a15-doc",
			"substrate",
		]);
	});
});
