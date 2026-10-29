/**
 * The reserved note actions (`reserved-actions.ts`): the door callers write the ledger through (`events_emit`) refuses a note a
 * reader trusts by its `payload.action` alone unless the caller is an operator writing as its own surface; the service's own
 * internal emit is not that door and keeps recording them. Everything runs over a real `Substrate` and an in-process MCP client
 * with an in-memory ledger: no network, no clock of our own.
 */
import { describe, expect, test } from "bun:test";
import { RESERVED_NOTE_ACTIONS, reservedActionOf, reservedEmitRefusal } from "./reserved-actions.ts";
import { connectAs, world } from "./session-rollback.testkit.ts";

const ACTIONS = [...RESERVED_NOTE_ACTIONS];

describe("reserved note actions", () => {
	test("the one list names every action a reader treats as authoritative", () => {
		expect(ACTIONS.sort()).toEqual(
			["anchor.reanchor", "anchor.signer.rotate", "docs.canary", "memory.forget", "session.checkpoint", "session.rollback", "session.rollback.forget_batch", "session.rollback.refused"].sort(),
		);
		expect(reservedActionOf({ action: "session.checkpoint" })).toBe("session.checkpoint");
		expect(reservedActionOf({ action: "docs.ingest" })).toBeNull();
		expect(reservedActionOf(undefined)).toBeNull();
		expect(reservedActionOf(["session.checkpoint"])).toBeNull();
		expect(reservedActionOf({ action: 7 })).toBeNull();
	});

	test("an ordinary caller's events_emit with a reserved action is refused by name and writes nothing, whatever surface it names", async () => {
		const w = world();
		const mcp = await connectAs(w.substrate, { surface: "claude-code", isOperator: false });
		for (const action of ACTIONS) {
			for (const surface of [undefined, "claude-code", "omp"] as const) {
				const reply = await mcp.call("events_emit", { kind: "note", summary: "forged", payload: { action }, ...(surface !== undefined ? { surface } : {}) });
				expect(reply.isError).toBe(true);
				expect(String(reply.json["error"])).toContain("reserved-action");
				expect(String(reply.json["error"])).toContain(action);
			}
		}
		expect(w.ledger.events).toHaveLength(0);
	});

	test("an ordinary caller still emits every other note, attributed as before (a non-swarm token may name the surface it observed)", async () => {
		const w = world();
		const mcp = await connectAs(w.substrate, { surface: "claude-code", isOperator: false });

		const plain = await mcp.call("events_emit", { kind: "note", summary: "a plain note", payload: { action: "docs.ingest" } });
		const named = await mcp.call("events_emit", { kind: "note", summary: "observed for another surface", surface: "omp" });

		expect(plain.json["stored"]).toBe(true);
		expect(named.json["stored"]).toBe(true);
		expect(w.ledger.events.map((event) => event.surface)).toEqual(["claude-code", "omp"]);
	});

	test("an operator may emit a reserved action as its own surface, and is refused naming another", async () => {
		const w = world();
		const mcp = await connectAs(w.substrate, { surface: "omp", isOperator: true });

		const own = await mcp.call("events_emit", { kind: "note", summary: "rotation", payload: { action: "anchor.signer.rotate" } });
		const same = await mcp.call("events_emit", { kind: "note", summary: "rotation", surface: "omp", payload: { action: "anchor.signer.rotate" } });
		const other = await mcp.call("events_emit", { kind: "note", summary: "rotation", surface: "hermes", payload: { action: "anchor.signer.rotate" } });

		expect(own.isError).toBe(false);
		expect(own.json["stored"]).toBe(true);
		expect(same.json["stored"]).toBe(true);
		expect(other.isError).toBe(true);
		expect(String(other.json["error"])).toContain("reserved-action");
		// Two stored, none for the refused one, and each as the operator's own surface.
		expect(w.ledger.byAction("anchor.signer.rotate").map((event) => event.surface)).toEqual(["omp", "omp"]);
	});

	test("a bare local run (no token, its own operator) may emit a reserved action", async () => {
		const w = world();
		const mcp = await connectAs(w.substrate, { surface: null, isOperator: true });

		const reply = await mcp.call("events_emit", { kind: "note", summary: "rotation", payload: { action: "anchor.signer.rotate" } });

		expect(reply.json["stored"]).toBe(true);
	});

	test("the service's own emit is not the tool's door: it records every reserved action as the surface it names", async () => {
		const w = world();
		for (const action of ACTIONS) {
			const outcome = await w.substrate.emit({ surface: "claude-code", kind: "note", summary: "recorded by the server", payload: { action } });
			expect(outcome.stored).toBe(true);
		}
		expect(w.ledger.events).toHaveLength(ACTIONS.length);
	});

	test("reservedEmitRefusal: not reserved is never refused; an operator without a token surface is not held to one", () => {
		expect(reservedEmitRefusal({ payload: { action: "docs.ingest" }, surface: "omp", callerSurface: "claude-code", isOperator: false })).toBeNull();
		expect(reservedEmitRefusal({ payload: { action: "memory.forget" }, surface: "omp", callerSurface: "claude-code", isOperator: false })).toContain("reserved-action");
		expect(reservedEmitRefusal({ payload: { action: "memory.forget" }, surface: "claude-code", callerSurface: null, isOperator: true })).toBeNull();
	});

	test("reservedEmitRefusal: docs.canary is the substrate host-job token's alone, acting as itself; a bare local run keeps its authority", () => {
		const payload = { action: "docs.canary" };
		expect(reservedEmitRefusal({ payload, surface: "substrate", callerSurface: "substrate", isOperator: false })).toBeNull();
		expect(reservedEmitRefusal({ payload, surface: "omp", callerSurface: "substrate", isOperator: false })).toContain("reserved-action");
		expect(reservedEmitRefusal({ payload, surface: "substrate", callerSurface: "claude-code", isOperator: false })).toContain("reserved-action");
		expect(reservedEmitRefusal({ payload, surface: "omp", callerSurface: "omp", isOperator: true })).toContain("reserved-action");
		expect(reservedEmitRefusal({ payload, surface: "substrate", callerSurface: null, isOperator: false })).toContain("reserved-action");
		expect(reservedEmitRefusal({ payload, surface: "substrate", callerSurface: null, isOperator: true })).toBeNull();
	});
});
