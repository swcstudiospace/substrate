import { describe, expect, test } from "bun:test";
import { EVENT_SOURCES } from "../../mcp-server/src/event-sources.ts";
import { normalizeEvent } from "../../mcp-server/src/event.ts";
import {
	HERDR_AGENT_SURFACES,
	HERDR_UNMAPPED,
	isRelease,
	mapHerdrEvent,
	normalizeWireName,
	transitionToEvent,
	type HerdrPane,
	type HerdrTransition,
} from "./herdr-map.ts";

/** herdr 0.9.1 IntegrationTarget, verbatim from the schema enum. */
const INTEGRATION_TARGETS = [
	"pi",
	"omp",
	"claude",
	"codex",
	"copilot",
	"devin",
	"droid",
	"kimi",
	"opencode",
	"kilo",
	"hermes",
	"qodercli",
	"qwen",
	"cursor",
	"mastracode",
	"antigravity_cli",
	"grok",
] as const;

function row(id: string) {
	const found = EVENT_SOURCES.find((source) => source.id === id);
	if (!found) throw new Error(`no EVENT_SOURCES row ${id}`);
	return found;
}

function base(over: Partial<HerdrTransition> = {}): HerdrTransition {
	return {
		rowId: "herdr.status_changed",
		surface: "omp",
		agent: "omp",
		pane_id: "w4:p1",
		terminal_id: "term_65d5",
		session_id: "herdr:term_65d5:2026-10-09T00:00:00.000Z",
		repo: "swcstudiospace/agent-substrate",
		branch: "main",
		status: "idle",
		previous_status: "working",
		herdr_type: "pane.agent_status_changed",
		...over,
	};
}

describe("pinned agent table", () => {
	test("every 0.9.1 enum id is mapped or explicitly unmapped, and muse is separate", () => {
		expect(INTEGRATION_TARGETS).toHaveLength(17);
		for (const id of INTEGRATION_TARGETS) {
			const mapped = Object.prototype.hasOwnProperty.call(HERDR_AGENT_SURFACES, id);
			const unmapped = HERDR_UNMAPPED.has(id);
			expect({ id, classified: mapped !== unmapped && (mapped || unmapped) }).toEqual({ id, classified: true });
		}
		expect(INTEGRATION_TARGETS).not.toContain("muse");
		expect(HERDR_AGENT_SURFACES.muse).toBe("muse");
		expect(HERDR_AGENT_SURFACES.claude).toBe("claude-code");
		expect(HERDR_AGENT_SURFACES.grok).toBe("grok-build");
	});
});

describe("wire names", () => {
	test("underscore and dotted spellings normalize, and released:true is a release", () => {
		const detected = {
			data: { agent: "omp", pane_id: "w1:p1", type: "pane_agent_detected", workspace_id: "w1" },
			event: "pane_agent_detected",
		};
		const released = {
			data: {
				agent: "omp",
				final_status: "unknown",
				pane_id: "w1:p1",
				released: true,
				type: "pane_agent_detected",
				workspace_id: "w1",
			},
			event: "pane_agent_detected",
		};
		const status = {
			data: { agent: "omp", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1" },
			event: "pane.agent_status_changed",
		};
		expect(normalizeWireName(detected.event)).toBe("pane.agent_detected");
		expect(normalizeWireName(detected.data.type)).toBe("pane.agent_detected");
		expect(normalizeWireName("pane.exited")).toBe("pane.exited");
		expect(normalizeWireName("pane_closed")).toBe("pane.closed");
		expect(normalizeWireName(status.event)).toBe("pane.agent_status_changed");
		expect(isRelease(detected.data)).toBe(false);
		expect(isRelease(released.data)).toBe(true);
	});
});

describe("transition conformance", () => {
	test("each herdr row keeps kind, surface, runtime and repo through normalizeEvent", () => {
		const cases: HerdrTransition[] = [
			base({
				rowId: "herdr.agent_detected",
				herdr_type: "pane.agent_detected",
				status: "working",
				previous_status: undefined,
			}),
			base(),
			base({
				rowId: "herdr.pane_exited",
				herdr_type: "pane.exited",
				status: undefined,
				previous_status: undefined,
				end_reason: "pane_gone",
			}),
		];
		for (const transition of cases) {
			const ev = transitionToEvent(transition);
			const source = row(transition.rowId);
			const stored = normalizeEvent(ev, null);
			expect({
				kind: stored.kind,
				runtime: ev.payload?.runtime,
				action: ev.payload?.action,
				repo: Boolean(ev.repo),
			}).toEqual({
				kind: source.kind,
				runtime: source.runtime,
				action: source.actions?.[0],
				repo: source.carriesRepo,
			});
			expect((Object.values(HERDR_AGENT_SURFACES) as readonly string[]).includes(stored.surface)).toBe(true);
			expect(stored.surface).toBe(ev.surface);
			expect(stored.kind).toBe(ev.kind);
			expect(ev.actor).toBe("agent");
			expect(ev.payload?.herdr_type).toBe(transition.herdr_type);
		}
	});

	test("a note names the status change and an exit keeps repo", () => {
		const note = transitionToEvent(base());
		expect(note.kind).toBe("note");
		expect(note.summary).toBe("herdr: working → idle (pane w4:p1)");
		expect(note.payload).toMatchObject({ status: "idle", previous_status: "working", runtime: "herdr" });
		const end = transitionToEvent(
			base({ rowId: "herdr.pane_exited", herdr_type: "pane.exited", end_reason: "agent_released" }),
		);
		expect(end.kind).toBe("session.end");
		expect(end.repo).toBe("swcstudiospace/agent-substrate");
	});

	test("no origin still emits, without repo", () => {
		const ev = transitionToEvent(base({ repo: undefined, branch: undefined }));
		expect(ev.repo).toBeUndefined();
		expect(ev.kind).toBe("note");
	});
});

describe("output_matched", () => {
	const pane: HerdrPane = { pane_id: "w1:p1", terminal_id: "term_1", agent: "omp", cwd: "/tmp/repo" };

	test("redacts matched text and omits repo", () => {
		const secret = ["tskey", "abc123def456"].join("-");
		const out = mapHerdrEvent({ type: "pane.output_matched", pane_id: "w1:p1", matched_line: `auth token ${secret}` }, pane);
		expect(out?.kind).toBe("note");
		expect(out?.surface).toBe("omp");
		expect(out?.repo).toBeUndefined();
		expect(out?.summary).not.toContain(secret);
		expect(JSON.stringify(out?.payload)).not.toContain(secret);
		expect(out?.payload).toMatchObject({ runtime: "herdr", herdr_type: "pane.output_matched", agent: "omp" });
		const stored = normalizeEvent(out!, null);
		expect(stored.kind).toBe("note");
		expect(stored.surface).toBe("omp");
	});

	test("an agentless pane and a lifecycle push emit nothing", () => {
		expect(mapHerdrEvent({ type: "pane.output_matched", matched_line: "hello" }, { pane_id: "w1:p1" })).toBeNull();
		expect(mapHerdrEvent({ type: "pane.agent_detected", pane_id: "w1:p1" }, pane)).toBeNull();
		expect(mapHerdrEvent({ event: "pane_output_matched", matched_line: "x", agent: "not-a-real-agent" }, pane)).toBeNull();
	});
});
