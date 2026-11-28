/** E6 episodic memory tests (phase 84): fakes only, no ledger, no network. */
import { describe, expect, test } from "bun:test";
import {
	episodicIndex,
	episodicPayload,
	episodesForGraph,
	episodesForSession,
	parseEpisodicEvent,
	parseEpisodicEvents,
	supersessionChain,
	type EpisodicRecord,
} from "./episodic.ts";
import type { SubstrateEvent } from "../types.ts";

function event(session: string, graph: string, payload: Record<string, unknown>, over: Partial<SubstrateEvent> = {}): SubstrateEvent {
	return {
		id: `ev-${String(Object.keys(payload).length)}-${payload.episode_id ?? "x"}`,
		ts: "2026-11-28T12:00:00Z",
		surface: "omp",
		session_id: session,
		graph_id: graph,
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: "episode",
		payload,
		hash: "h",
		prev: null,
		...over,
	};
}

const record = (id: string, session: string, graph: string, supersedes_id?: string): EpisodicRecord => ({
	episode_id: id,
	session_id: session,
	graph_id: graph,
	outcome: "done",
	summary: `summary ${id}`,
	provenance: "hindsight:doc-1",
	...(supersedes_id !== undefined ? { supersedes_id } : {}),
});

describe("episodic payload and parse", () => {
	test("payload stamps the episodic marker and the supersession link", () => {
		expect(episodicPayload(record("ep-1", "s-1", "g-1"))).toEqual({
			episodic: true,
			episode_id: "ep-1",
			outcome: "done",
			summary: "summary ep-1",
			provenance: "hindsight:doc-1",
		});
		expect(episodicPayload(record("ep-2", "s-1", "g-1", "ep-1")).supersedes_id).toBe("ep-1");
	});

	test("a ledger note round-trips back to its record; a plain note is not an episode", () => {
		const parsed = parseEpisodicEvent(event("s-1", "g-1", episodicPayload(record("ep-2", "s-1", "g-1", "ep-1"))));
		expect(parsed).toEqual({ episode_id: "ep-2", session_id: "s-1", graph_id: "g-1", outcome: "done", summary: "summary ep-2", provenance: "hindsight:doc-1", supersedes_id: "ep-1" });
		expect(parseEpisodicEvent(event("s-1", "g-1", { episodic: false }))).toBeNull();
		expect(parseEpisodicEvent(event("s-1", "g-1", {}))).toBeNull();
	});

	test("parseEpisodicEvents keeps ledger order and drops non-episodic rows", () => {
		const events = [
			event("s-1", "g-1", episodicPayload(record("ep-1", "s-1", "g-1"))),
			event("s-1", "g-1", { hello: "world" }),
			event("s-1", "g-1", episodicPayload(record("ep-2", "s-1", "g-1", "ep-1"))),
		];
		expect(parseEpisodicEvents(events).map((row) => row.episode_id)).toEqual(["ep-1", "ep-2"]);
	});
});

describe("episodic supersession", () => {
	test("a superseding episode makes superseded_by visible both ways", () => {
		const linked = supersessionChain([record("ep-1", "s-1", "g-1"), record("ep-2", "s-1", "g-1", "ep-1")]);
		expect(linked[0]).toMatchObject({ episode_id: "ep-1", superseded_by: "ep-2" });
		expect(linked[1]).toMatchObject({ episode_id: "ep-2", supersedes_id: "ep-1", superseded_by: null });
	});

	test("the chain walks back: ep-3 supersedes ep-2 supersedes ep-1", () => {
		const linked = supersessionChain([record("ep-1", "s-1", "g-1"), record("ep-2", "s-1", "g-1", "ep-1"), record("ep-3", "s-1", "g-1", "ep-2")]);
		expect(linked.map((row) => [row.episode_id, row.superseded_by])).toEqual([["ep-1", "ep-2"], ["ep-2", "ep-3"], ["ep-3", null]]);
	});
});

describe("episodic retrieval", () => {
	const all = [record("ep-1", "s-1", "g-1"), record("ep-2", "s-1", "g-2", "ep-1"), record("ep-3", "s-2", "g-1")];

	test("session filter isolates one session's episodes, with chains resolved", () => {
		expect(episodesForSession(all, "s-1").map((row) => row.episode_id)).toEqual(["ep-1", "ep-2"]);
		expect(episodesForSession(all, "s-1", "g-1").map((row) => row.episode_id)).toEqual(["ep-1"]);
		expect(episodesForSession(all, "s-2").map((row) => row.episode_id)).toEqual(["ep-3"]);
	});

	test("graph filter isolates one graph's episodes", () => {
		expect(episodesForGraph(all, "g-1").map((row) => row.episode_id)).toEqual(["ep-1", "ep-3"]);
		expect(episodesForGraph(all, "g-2").map((row) => row.episode_id)).toEqual(["ep-2"]);
	});

	test("registry index groups by session, sorted, without mutating entries", () => {
		const before = all.map((row) => ({ ...row }));
		const index = episodicIndex(all);
		expect(index.map((row) => row.session_id)).toEqual(["s-1", "s-2"]);
		expect(index[0]?.episodes.map((row) => row.episode_id)).toEqual(["ep-1", "ep-2"]);
		expect(index[0]?.episodes[0]?.superseded_by).toBe("ep-2");
		expect(all).toEqual(before);
	});
});
