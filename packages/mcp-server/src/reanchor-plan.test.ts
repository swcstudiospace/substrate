import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildSignerRotateEvent, classifyChainEvidence, formatMemo, formatMemoV2, HOUR_MS, parseRotationPayload } from "@substrate/ledger";
import { normalizeEvent } from "./event.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import type { AnchorRow } from "./greptime.ts";
import {
	ANCHOR_REANCHOR_ACTION,
	buildReanchorEvent,
	type HourChainEvidence,
	parseReanchorPayload,
	planReanchor,
	ReanchorEventError,
} from "./reanchor-plan.ts";

/**
 * Proof for phase 59b: the re-anchor plan is a dry run over stored rows and chain evidence, and the
 * `anchor.signer.rotate` / `anchor.reanchor` events are valid ledger events.
 */

const H0 = Date.UTC(2026, 9, 20, 10);
const OLD_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const NEW_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SIGNER = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const NEW_SIGNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const NOW = H0 + 100 * HOUR_MS;

const rootFor = (n: number): string => new Bun.CryptoHasher("sha256").update(`p59b-root:${n}`).digest("hex");
const sigFor = (n: number): string => `${n % 9 + 1}${"b".repeat(87)}`;

function row(n: number, overrides: Partial<AnchorRow> = {}): AnchorRow {
	const hour = H0 + n * HOUR_MS;
	const root = rootFor(n);
	const count = 3 + n;
	return {
		period_start: new Date(hour).toISOString(),
		period_end: new Date(hour + HOUR_MS).toISOString(),
		root,
		event_count: count,
		memo: formatMemo({ periodStartMs: hour, rootHex: root, count }),
		tx_sig: sigFor(n),
		signer: SIGNER,
		cluster: "devnet",
		slot: 1000 + n,
		anchored_at: new Date(hour + 2 * HOUR_MS).toISOString(),
		stale_hashes: null,
		...overrides,
	};
}

const hourOf = (n: number): number => H0 + n * HOUR_MS;

function evidence(status: HourChainEvidence["signatureStatus"], observedGenesis: string | null = NEW_GENESIS, n = 0): HourChainEvidence {
	const verdict = classifyChainEvidence({
		expectedGenesis: OLD_GENESIS,
		observedGenesis,
		signatureStatus: status,
		anchoredAtMs: hourOf(n) + 2 * HOUR_MS,
		nowMs: NOW,
	});
	return { ...verdict, signatureStatus: status, observedGenesis };
}

describe("planReanchor", () => {
	test("a reset hour with its signature missing is planned with the stored memo, root and count unchanged, and the plan says dry_run", () => {
		const rows = [row(0), row(1), row(2)];
		const plan = planReanchor({
			anchorRows: rows,
			chainEvidenceByHour: new Map([
				[hourOf(0), evidence("not-found", NEW_GENESIS, 0)],
				[hourOf(1), evidence("not-found", NEW_GENESIS, 1)],
				[hourOf(2), evidence("not-found", NEW_GENESIS, 2)],
			]),
			nowMs: NOW,
		});
		expect(plan.dry_run).toBe(true);
		expect(plan.generated_at_ms).toBe(NOW);
		expect(plan.skipped).toEqual([]);
		expect(plan.hours.map((hour) => hour.period_start)).toEqual(rows.map((r) => r.period_start));
		for (const [i, hour] of plan.hours.entries()) {
			const source = rows[i] as AnchorRow;
			expect(hour).toMatchObject({
				period_start_ms: hourOf(i),
				memo: source.memo,
				root: source.root,
				event_count: source.event_count,
				previous_tx_sig: source.tx_sig,
				previous_signer: SIGNER,
				target_genesis: NEW_GENESIS,
			});
			expect(hour.memo).toBe(formatMemo({ periodStartMs: hourOf(i), rootHex: source.root, count: source.event_count }));
			expect(hour.why).toContain("signature missing after a suspected devnet reset");
			expect(hour.why).toContain(NEW_GENESIS);
		}
		expect(plan.notes.join(" ")).toContain("no transaction was sent and this plan cannot send one");
	});

	test("a v2 row is planned with its own memo carried byte for byte", () => {
		const memo = formatMemoV2({ periodStartMs: hourOf(0), rootHex: rootFor(0), count: 3, headsRootHex: "cd".repeat(32) });
		const plan = planReanchor({
			anchorRows: [row(0, { memo })],
			chainEvidenceByHour: new Map([[hourOf(0), evidence("not-found", NEW_GENESIS, 0)]]),
			nowMs: NOW,
		});
		expect(plan.skipped).toEqual([]);
		expect(plan.hours).toHaveLength(1);
		expect(plan.hours[0]?.memo).toBe(memo);
	});

	test("each other situation is skipped with its own code, and only the reset hour is planned", () => {
		const rows = [row(0), row(1), row(2), row(3), row(4), row(5), row(6)];
		const plan = planReanchor({
			anchorRows: rows,
			chainEvidenceByHour: new Map<number, HourChainEvidence>([
				[hourOf(0), evidence("not-found", NEW_GENESIS, 0)], // planned
				[hourOf(1), evidence("finalized", OLD_GENESIS, 1)], // ok
				[hourOf(2), evidence("unreachable", null, 2)], // chain unreachable
				[hourOf(3), evidence("not-found", OLD_GENESIS, 3)], // signature missing on the expected cluster
				[hourOf(4), evidence("finalized", NEW_GENESIS, 4)], // reset-suspected, but the anchor lives on the new cluster
				[hourOf(5), evidence("unreachable", NEW_GENESIS, 5)], // reset-suspected, lookup did not answer
				// hour 6 has no evidence
			]),
			nowMs: NOW,
		});
		expect(plan.hours.map((hour) => hour.period_start_ms)).toEqual([hourOf(0)]);
		expect(plan.skipped.map((skip) => [skip.period_start, skip.code])).toEqual([
			[new Date(hourOf(1)).toISOString(), "ok"],
			[new Date(hourOf(2)).toISOString(), "chain-unreachable"],
			[new Date(hourOf(3)).toISOString(), "signature-missing-without-reset"],
			[new Date(hourOf(4)).toISOString(), "present-on-observed-cluster"],
			[new Date(hourOf(5)).toISOString(), "chain-unreachable"],
			[new Date(hourOf(6)).toISOString(), "no-evidence"],
		]);
		expect(plan.skipped.find((skip) => skip.code === "signature-missing-without-reset")?.detail).toContain("do not re-anchor");
	});

	test("a row that is not sound is never repaired: it is skipped as invalid-row", () => {
		const good = row(0);
		const wrongMemo = row(1, { memo: formatMemo({ periodStartMs: hourOf(1), rootHex: rootFor(99), count: 4 }) });
		const wrongCount = row(2, { event_count: 99 });
		const badRoot = row(3, { root: "XYZ" });
		const zeroCount = row(4, { event_count: 0 });
		const notAnHour = row(5, { period_start: "2026-10-20T15:30:00.000Z" });
		const garbage = row(6, { period_start: "never" });
		const plan = planReanchor({
			anchorRows: [good, wrongMemo, wrongCount, badRoot, zeroCount, notAnHour, garbage],
			chainEvidenceByHour: new Map([0, 1, 2, 3, 4, 5, 6].map((n) => [hourOf(n), evidence("not-found", NEW_GENESIS, n)] as const)),
			nowMs: NOW,
		});
		expect(plan.hours.map((hour) => hour.period_start_ms)).toEqual([hourOf(0)]);
		expect(plan.skipped).toHaveLength(6);
		expect(new Set(plan.skipped.map((skip) => skip.code))).toEqual(new Set(["invalid-row"]));
	});

	test("two rows for one hour: the second is flagged, never planned twice", () => {
		const first = row(0);
		const second = row(0, { tx_sig: sigFor(8) });
		const plan = planReanchor({ anchorRows: [second, first], chainEvidenceByHour: new Map([[hourOf(0), evidence("not-found")]]), nowMs: NOW });
		expect(plan.hours).toHaveLength(1);
		expect(plan.skipped.map((skip) => skip.code)).toEqual(["duplicate-row"]);
	});

	test("the plan does not depend on the order rows arrive in, and does not mutate its inputs", () => {
		const rows = [row(3), row(1), row(2), row(0)];
		const map = new Map(rows.map((_, n) => [hourOf(n), evidence("not-found", NEW_GENESIS, n)] as const));
		const snapshot = JSON.stringify(rows);
		const forward = planReanchor({ anchorRows: rows, chainEvidenceByHour: map, nowMs: NOW });
		const reversed = planReanchor({ anchorRows: [...rows].reverse(), chainEvidenceByHour: map, nowMs: NOW });
		expect(forward).toEqual(reversed);
		expect(forward.hours.map((hour) => hour.period_start_ms)).toEqual([hourOf(0), hourOf(1), hourOf(2), hourOf(3)]);
		expect(JSON.stringify(rows)).toBe(snapshot);
		forward.notes.push("tamper");
		expect(planReanchor({ anchorRows: rows, chainEvidenceByHour: map, nowMs: NOW }).notes).not.toContain("tamper");
	});

	test("an empty input is an empty plan, and a non-finite clock is refused", () => {
		expect(planReanchor({ anchorRows: [], chainEvidenceByHour: new Map(), nowMs: NOW })).toMatchObject({ dry_run: true, hours: [], skipped: [] });
		expect(() => planReanchor({ anchorRows: [], chainEvidenceByHour: new Map(), nowMs: Number.NaN })).toThrow(TypeError);
	});

	test("the module cannot send: it imports no transport, RPC, CLI or process API", () => {
		const source = readFileSync(new URL("./reanchor-plan.ts", import.meta.url), "utf8");
		const code = source
			.split("\n")
			.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
			.join("\n");
		expect(code).not.toMatch(/createRpc|transferMemoArgv|execFileRunner|Runner|\bfetch\b|Bun\.spawn|Bun\.\$|child_process|node:net|node:http|\bexec(File)?\b|process\.env|WebSocket/);
		const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((match) => match[1]);
		expect(imports.sort()).toEqual(["./greptime.ts", "@substrate/ledger"]);
	});
});

describe("anchor.reanchor event", () => {
	const fields = {
		period_start: new Date(H0).toISOString(),
		root: rootFor(0),
		event_count: 3,
		previous_tx_sig: sigFor(0),
		new_tx_sig: sigFor(1),
		genesis: NEW_GENESIS,
	};

	test("a valid payload round-trips in declared key order", () => {
		const parsed = parseReanchorPayload({ action: ANCHOR_REANCHOR_ACTION, ...fields });
		expect(Object.keys(parsed)).toEqual(["action", "period_start", "root", "event_count", "previous_tx_sig", "new_tx_sig", "genesis"]);
		expect(parsed).toEqual({ action: ANCHOR_REANCHOR_ACTION, ...fields });
	});

	test("every invalid shape is refused with its rule", () => {
		const rule = (value: unknown, options?: { stored?: boolean }): string => {
			try {
				parseReanchorPayload(value, options);
			} catch (cause) {
				if (cause instanceof ReanchorEventError) return cause.rule;
				throw cause;
			}
			return "no error";
		};
		const ok = { action: ANCHOR_REANCHOR_ACTION, ...fields };
		expect(rule("x")).toBe("not_object");
		expect(rule({ ...ok, action: "anchor" })).toBe("enum");
		expect(rule({ ...ok, extra: 1 })).toBe("unknown_key");
		expect(rule({ ...ok, _ik: "reanchor:abc" })).toBe("unknown_key");
		expect(rule({ ...ok, genesis: undefined })).toBe("missing");
		expect(rule({ ...ok, period_start: "2026-10-20T10:30:00.000Z" })).toBe("format");
		expect(rule({ ...ok, period_start: "2026-13-40T10:00:00.000Z" })).toBe("format");
		expect(rule({ ...ok, root: rootFor(0).toUpperCase() })).toBe("format");
		expect(rule({ ...ok, event_count: 0 })).toBe("range");
		expect(rule({ ...ok, event_count: 1.5 })).toBe("type");
		expect(rule({ ...ok, new_tx_sig: "short" })).toBe("format");
		expect(rule({ ...ok, new_tx_sig: ok.previous_tx_sig })).toBe("format");
		expect(rule({ ...ok, genesis: 5 })).toBe("type");
		expect(rule({ ...ok, _ik: "reanchor:abc12345" }, { stored: true })).toBe("no error");
	});

	test("the builder returns a note draft with a stable idempotency key the ledger accepts", () => {
		const draft = buildReanchorEvent(fields);
		expect(draft.kind).toBe("note");
		expect(draft.payload.action).toBe(ANCHOR_REANCHOR_ACTION);
		expect(draft.idempotency_key).toBe(`reanchor:${fields.period_start}:${fields.new_tx_sig}`);
		expect(draft.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
		expect(draft.summary).toContain(fields.period_start);
		expect(() => buildReanchorEvent({ ...fields, event_count: 0 })).toThrow(ReanchorEventError);
	});
});

describe("the phase 59b events are valid ledger events", () => {
	test("both drafts pass normalizeEvent with their payload intact (redaction does not alter a key or a signature)", () => {
		const rotate = buildSignerRotateEvent({ old_pubkey: SIGNER, new_pubkey: NEW_SIGNER, effective_from_ms: H0, reason: "scheduled rotation" });
		const reanchor = buildReanchorEvent({
			period_start: new Date(H0).toISOString(),
			root: rootFor(0),
			event_count: 3,
			previous_tx_sig: sigFor(0),
			new_tx_sig: sigFor(1),
			genesis: NEW_GENESIS,
		});
		for (const draft of [rotate, reanchor]) {
			const event = normalizeEvent({ surface: "claude-code", kind: draft.kind, summary: draft.summary, session_id: "anchor-admin:p59b", payload: { ...draft.payload } }, null);
			expect(event.kind).toBe("note");
			expect(event.payload).toEqual({ ...draft.payload });
		}
		expect(parseRotationPayload(rotate.payload)).toEqual(rotate.payload);
	});

	test("the vocabulary rows exist, are notes from the caller, and their samples satisfy the validators", () => {
		const rotateRow = EVENT_SOURCES.find((source) => source.id === "anchor.signer.rotate");
		const reanchorRow = EVENT_SOURCES.find((source) => source.id === "anchor.reanchor");
		expect(rotateRow).toMatchObject({ phase: 59, kind: "note", surface: "caller", actions: ["anchor.signer.rotate"], carriesRepo: false, periodic: false });
		expect(reanchorRow).toMatchObject({ phase: 59, kind: "note", surface: "caller", actions: ["anchor.reanchor"], carriesRepo: false, periodic: false });
		expect(parseRotationPayload(rotateRow?.sample().payload)).toMatchObject({ action: "anchor.signer.rotate" });
		expect(parseReanchorPayload(reanchorRow?.sample().payload)).toMatchObject({ action: "anchor.reanchor" });
	});
});
