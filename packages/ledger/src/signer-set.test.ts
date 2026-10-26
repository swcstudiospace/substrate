import { describe, expect, test } from "bun:test";
import {
	ANCHOR_SIGNER_ROTATE_ACTION,
	acceptsSigner,
	buildSignerRotateEvent,
	isBase58Pubkey,
	parseRotationPayload,
	parseSignerSet,
	ROTATION_MAX_BACKDATE_MS,
	ROTATION_MAX_FUTURE_MS,
	type RotationEventInput,
	SIGNER_SET_MAX_ENTRIES,
	SignerSetError,
	type SignerSet,
	signerSetFromRotationEvents,
} from "./signer-set.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) encoder, test-only, so the suite can mint as many valid 32-byte keys as it needs. */
function bs58encode(bytes: Uint8Array): string {
	const digits: number[] = [];
	for (const byte of bytes) {
		let carry = byte;
		for (let i = 0; i < digits.length; i++) {
			carry += (digits[i] as number) << 8;
			digits[i] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	let zeros = 0;
	while (bytes[zeros] === 0) zeros++;
	return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

/** The nth deterministic public key. */
function key(n: number): string {
	return bs58encode(new Uint8Array(new Bun.CryptoHasher("sha256").update(`p59b-signer:${n}`).digest()));
}

const A = key(1);
const B = key(2);
const C = key(3);
const D = key(4);
const T0 = Date.UTC(2026, 9, 1);
const DAY = 24 * 3_600_000;

function rule(fn: () => unknown): string {
	try {
		fn();
	} catch (cause) {
		if (cause instanceof SignerSetError) return cause.rule;
		throw cause;
	}
	return "no error";
}

describe("isBase58Pubkey", () => {
	test("accepts a 32-byte key, including the all-zero system program, and rejects everything else", () => {
		expect(isBase58Pubkey(A)).toBe(true);
		expect(isBase58Pubkey("1".repeat(32))).toBe(true);
		expect(isBase58Pubkey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo")).toBe(true);
		expect(isBase58Pubkey("2".repeat(32))).toBe(false); // base58 text that does not decode to 32 bytes
		expect(isBase58Pubkey("1".repeat(31))).toBe(false);
		expect(isBase58Pubkey(`${A}0`)).toBe(false); // 0 is not in the alphabet
		expect(isBase58Pubkey(`${A}O`)).toBe(false);
		expect(isBase58Pubkey("")).toBe(false);
		expect(isBase58Pubkey(42)).toBe(false);
		expect(isBase58Pubkey(undefined)).toBe(false);
	});
});

describe("parseSignerSet", () => {
	test("parses an array or its JSON text, sorted by (valid_from_ms, pubkey), and the result is a fresh copy", () => {
		const input = [
			{ pubkey: B, valid_from_ms: T0 + DAY, valid_until_ms: null, label: "second" },
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: T0 + DAY },
		];
		const set = parseSignerSet(input);
		expect(set.map((entry) => entry.pubkey)).toEqual([A, B]);
		expect(set[1]?.label).toBe("second");
		expect(parseSignerSet(JSON.stringify(input))).toEqual(set);
		const first = set[0];
		if (first) first.valid_from_ms = 7;
		expect(input[1]?.valid_from_ms).toBe(0);
	});

	test("rejects what is not a signer set", () => {
		const ok = { pubkey: A, valid_from_ms: 0, valid_until_ms: null };
		expect(rule(() => parseSignerSet("{nope"))).toBe("not_json");
		expect(rule(() => parseSignerSet({ signers: [ok] }))).toBe("not_array");
		expect(rule(() => parseSignerSet([42]))).toBe("not_object");
		expect(rule(() => parseSignerSet([{ ...ok, secret: "x" }]))).toBe("unknown_key");
		expect(rule(() => parseSignerSet([{ pubkey: A, valid_from_ms: 0 }]))).toBe("missing");
		expect(rule(() => parseSignerSet([{ ...ok, pubkey: "not-a-key" }]))).toBe("format");
		expect(rule(() => parseSignerSet([{ ...ok, pubkey: 5 }]))).toBe("type");
		expect(rule(() => parseSignerSet([{ ...ok, valid_from_ms: -1 }]))).toBe("range");
		expect(rule(() => parseSignerSet([{ ...ok, valid_from_ms: 1.5 }]))).toBe("type");
		expect(rule(() => parseSignerSet([{ ...ok, valid_from_ms: "0" }]))).toBe("type");
		expect(rule(() => parseSignerSet([{ ...ok, valid_until_ms: undefined }]))).toBe("missing");
		expect(rule(() => parseSignerSet([{ ...ok, label: "" }]))).toBe("range");
		expect(rule(() => parseSignerSet([{ ...ok, label: "bad\nlabel" }]))).toBe("format");
	});

	test("windows must be well ordered", () => {
		expect(rule(() => parseSignerSet([{ pubkey: A, valid_from_ms: 10, valid_until_ms: 10 }]))).toBe("range");
		expect(rule(() => parseSignerSet([{ pubkey: A, valid_from_ms: 10, valid_until_ms: 5 }]))).toBe("range");
		expect(() => parseSignerSet([{ pubkey: A, valid_from_ms: 10, valid_until_ms: 11 }])).not.toThrow();
	});

	test("the same key may not appear twice with overlapping windows; a key may return after its window closed", () => {
		const overlap = [
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: 100 },
			{ pubkey: A, valid_from_ms: 99, valid_until_ms: null },
		];
		expect(rule(() => parseSignerSet(overlap))).toBe("overlap");
		const identical = [
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
		];
		expect(rule(() => parseSignerSet(identical))).toBe("overlap");
		const openEnded = [
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
			{ pubkey: A, valid_from_ms: 500, valid_until_ms: 600 },
		];
		expect(rule(() => parseSignerSet(openEnded))).toBe("overlap");
		const touching = [
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: 100 },
			{ pubkey: A, valid_from_ms: 100, valid_until_ms: null },
		];
		expect(() => parseSignerSet(touching)).not.toThrow();
	});

	test("different keys may overlap (a grace period), and at most 16 entries are allowed", () => {
		expect(() =>
			parseSignerSet([
				{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
				{ pubkey: B, valid_from_ms: 0, valid_until_ms: null },
			]),
		).not.toThrow();
		const make = (n: number) => Array.from({ length: n }, (_, i) => ({ pubkey: key(100 + i), valid_from_ms: 0, valid_until_ms: null }));
		expect(parseSignerSet(make(SIGNER_SET_MAX_ENTRIES))).toHaveLength(16);
		expect(rule(() => parseSignerSet(make(SIGNER_SET_MAX_ENTRIES + 1)))).toBe("too_many");
	});
});

describe("acceptsSigner", () => {
	const set: SignerSet = parseSignerSet([
		{ pubkey: A, valid_from_ms: T0, valid_until_ms: T0 + DAY },
		{ pubkey: B, valid_from_ms: T0 + DAY, valid_until_ms: null },
		{ pubkey: A, valid_from_ms: T0 + 10 * DAY, valid_until_ms: T0 + 11 * DAY },
	]);

	test("a window is [from, until): inclusive start, exclusive end", () => {
		expect(acceptsSigner(set, A, T0).ok).toBe(true);
		expect(acceptsSigner(set, A, T0 + DAY - 1).ok).toBe(true);
		const atEnd = acceptsSigner(set, A, T0 + DAY);
		expect(atEnd.ok).toBe(false);
		if (!atEnd.ok) expect(atEnd.reason).toContain("outside its valid window");
		expect(acceptsSigner(set, A, T0 - 1).ok).toBe(false);
	});

	test("an open-ended window accepts every later time, and the entry is returned", () => {
		const result = acceptsSigner(set, B, T0 + 400 * DAY);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.entry.pubkey).toBe(B);
		expect(acceptsSigner(set, B, T0 + DAY - 1).ok).toBe(false);
	});

	test("a returning key is accepted in its second window and refused between windows", () => {
		expect(acceptsSigner(set, A, T0 + 10 * DAY + 5).ok).toBe(true);
		expect(acceptsSigner(set, A, T0 + 5 * DAY).ok).toBe(false);
	});

	test("an unknown key, a malformed key and a bad block time are refused with a reason, never thrown", () => {
		const unknown = acceptsSigner(set, C, T0);
		expect(unknown).toEqual({ ok: false, reason: `signer ${C} is not in the signer set` });
		expect(acceptsSigner(set, "nope", T0).ok).toBe(false);
		expect(acceptsSigner(set, A, Number.NaN).ok).toBe(false);
		expect(acceptsSigner(set, A, -5).ok).toBe(false);
		expect(acceptsSigner(set, A, 1.5).ok).toBe(false);
		expect(acceptsSigner([], A, T0).ok).toBe(false);
	});
});

describe("rotation payloads and event drafts", () => {
	const valid = { action: ANCHOR_SIGNER_ROTATE_ACTION, old_pubkey: A, new_pubkey: B, effective_from_ms: T0, reason: "scheduled quarterly rotation" } as const;

	test("a valid payload round-trips in declared key order", () => {
		expect(Object.keys(parseRotationPayload(valid))).toEqual(["action", "old_pubkey", "new_pubkey", "effective_from_ms", "reason"]);
		const { old_pubkey: _drop, ...addOnly } = valid;
		expect(parseRotationPayload(addOnly)).toEqual(addOnly);
	});

	test("every invalid shape is refused", () => {
		expect(rule(() => parseRotationPayload(null))).toBe("not_object");
		expect(rule(() => parseRotationPayload({ ...valid, action: "anchor.signer.revoke" }))).toBe("enum");
		expect(rule(() => parseRotationPayload({ ...valid, extra: 1 }))).toBe("unknown_key");
		expect(rule(() => parseRotationPayload({ ...valid, _ik: "k1234567" }))).toBe("unknown_key");
		expect(rule(() => parseRotationPayload({ ...valid, new_pubkey: undefined }))).toBe("missing");
		expect(rule(() => parseRotationPayload({ ...valid, new_pubkey: "short" }))).toBe("format");
		expect(rule(() => parseRotationPayload({ ...valid, old_pubkey: "short" }))).toBe("format");
		expect(rule(() => parseRotationPayload({ ...valid, old_pubkey: B }))).toBe("format");
		expect(rule(() => parseRotationPayload({ ...valid, effective_from_ms: -1 }))).toBe("range");
		expect(rule(() => parseRotationPayload({ ...valid, effective_from_ms: "now" }))).toBe("type");
		expect(rule(() => parseRotationPayload({ ...valid, reason: "" }))).toBe("range");
		expect(rule(() => parseRotationPayload({ ...valid, reason: "x".repeat(201) }))).toBe("range");
		expect(rule(() => parseRotationPayload({ ...valid, reason: "line\nbreak" }))).toBe("format");
		expect(rule(() => parseRotationPayload({ ...valid, reason: 7 }))).toBe("type");
	});

	test("a payload read back from the ledger may carry the reserved _ik, only when asked", () => {
		expect(parseRotationPayload({ ...valid, _ik: "anchor-rotate:abc" }, { stored: true })).toEqual(valid);
	});

	test("the builder returns a note draft with a stable idempotency key that the ledger accepts", () => {
		const { action: _a, ...fields } = valid;
		const draft = buildSignerRotateEvent(fields);
		expect(draft.kind).toBe("note");
		expect(draft.payload).toEqual(valid);
		expect(draft.summary).toContain(B);
		expect(draft.idempotency_key).toBe(`anchor-rotate:${B}:${T0}`);
		expect(draft.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
		expect(buildSignerRotateEvent(fields).idempotency_key).toBe(draft.idempotency_key);
		expect(rule(() => buildSignerRotateEvent({ ...fields, reason: "" }))).toBe("range");
	});
});

describe("signerSetFromRotationEvents", () => {
	const bootstrap = parseSignerSet([{ pubkey: A, valid_from_ms: 0, valid_until_ms: null }]);
	const operator = (event: RotationEventInput) => event.surface === "operator";

	function rotationPayload(fields: { old?: string; new: string; at: number; reason?: string }): Record<string, unknown> {
		return {
			action: ANCHOR_SIGNER_ROTATE_ACTION,
			...(fields.old === undefined ? {} : { old_pubkey: fields.old }),
			new_pubkey: fields.new,
			effective_from_ms: fields.at,
			reason: fields.reason ?? "rotation",
		};
	}

	function rotation(id: string, fields: { old?: string; new: string; at: number; reason?: string }, extra: Partial<RotationEventInput> = {}): RotationEventInput {
		return { event_id: id, ts_ms: fields.at, surface: "operator", payload: rotationPayload(fields), ...extra };
	}

	test("a rotation closes the old window and opens the new one at the same instant", () => {
		const derived = signerSetFromRotationEvents(bootstrap, [rotation("evt_1", { old: A, new: B, at: T0 })], { authorize: operator });
		expect(derived.issues).toEqual([]);
		expect(derived.applied).toEqual(["evt_1"]);
		expect(derived.set).toEqual([
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: T0 },
			{ pubkey: B, valid_from_ms: T0, valid_until_ms: null },
		]);
		expect(acceptsSigner(derived.set, A, T0 - 1).ok).toBe(true);
		expect(acceptsSigner(derived.set, A, T0).ok).toBe(false);
		expect(acceptsSigner(derived.set, B, T0).ok).toBe(true);
	});

	test("a rotation without old_pubkey adds a key and retires nothing", () => {
		const derived = signerSetFromRotationEvents(bootstrap, [rotation("evt_1", { new: B, at: T0 })], { authorize: operator });
		expect(derived.set).toEqual([
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
			{ pubkey: B, valid_from_ms: T0, valid_until_ms: null },
		]);
	});

	test("the derived set is the same for every arrival order of the events, issues included", () => {
		const events = [
			rotation("evt_c", { old: B, new: C, at: T0 + 2 * DAY }),
			rotation("evt_a", { old: A, new: B, at: T0 }),
			rotation("evt_d", { old: C, new: D, at: T0 + 3 * DAY }),
			rotation("evt_bad", { new: "short", at: T0 + DAY }),
			rotation("evt_forged", { new: D, at: T0 + DAY }, { surface: "claude-code" }),
			rotation("evt_stale", { old: A, new: C, at: T0 + 4 * DAY }),
		];
		const permutations = (items: RotationEventInput[]): RotationEventInput[][] =>
			items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
		const all = permutations(events);
		expect(all.length).toBe(720);
		const reference = JSON.stringify(signerSetFromRotationEvents(bootstrap, events, { authorize: operator }));
		for (const order of all) {
			expect(JSON.stringify(signerSetFromRotationEvents(bootstrap, order, { authorize: operator }))).toBe(reference);
		}
		const derived = signerSetFromRotationEvents(bootstrap, events, { authorize: operator });
		expect(derived.applied).toEqual(["evt_a", "evt_c", "evt_d"]);
		expect(derived.set.map((entry) => entry.pubkey)).toEqual([A, B, C, D]);
		expect(derived.issues.map((issue) => `${issue.reason}:${issue.event_id}`)).toEqual(["invalid-payload:evt_bad", "old-key-not-valid:evt_stale", "unauthorized:evt_forged"]);
	});

	test("an event whose payload is invalid is ignored and reported, never thrown", () => {
		const events: RotationEventInput[] = [
			{ event_id: "evt_1", ts_ms: T0, surface: "operator", payload: { action: ANCHOR_SIGNER_ROTATE_ACTION } },
			{ event_id: "evt_2", ts_ms: T0, surface: "operator", payload: "text" },
			{ event_id: "evt_3", ts_ms: T0, surface: "operator", payload: { action: "session.checkpoint" } },
		];
		const derived = signerSetFromRotationEvents(bootstrap, events, { authorize: operator });
		expect(derived.set).toEqual(bootstrap);
		expect(derived.issues.map((issue) => issue.reason)).toEqual(["invalid-payload", "invalid-payload", "invalid-payload"]);
	});

	test("a malformed event envelope is reported as invalid-event", () => {
		const events = [{ event_id: "has space", ts_ms: T0, payload: {} }, { event_id: "evt_1", ts_ms: Number.NaN, payload: {} }] as RotationEventInput[];
		const derived = signerSetFromRotationEvents(bootstrap, events, { authorize: () => true });
		expect(derived.issues.map((issue) => issue.reason)).toEqual(["invalid-event", "invalid-event"]);
	});

	test("authorisation is required, and only authorised events are honoured", () => {
		const events = [rotation("evt_1", { old: A, new: B, at: T0 })];
		expect(() => signerSetFromRotationEvents(bootstrap, events, {} as never)).toThrow(TypeError);
		const refused = signerSetFromRotationEvents(bootstrap, events, { authorize: () => false });
		expect(refused.set).toEqual(bootstrap);
		expect(refused.issues).toEqual([{ event_id: "evt_1", reason: "unauthorized", detail: "the event was not written by an authorised operator" }]);
	});

	test("an effective time far from the event's own time is refused (no back-dating an attacker's key over old anchors)", () => {
		const ts = T0 + 60 * DAY;
		const backdated = { ...rotation("evt_old", { new: B, at: ts - ROTATION_MAX_BACKDATE_MS - 1 }), ts_ms: ts };
		const tooFar = { ...rotation("evt_far", { new: C, at: ts + ROTATION_MAX_FUTURE_MS + 1 }), ts_ms: ts };
		const edgePast = { ...rotation("evt_edge1", { new: D, at: ts - ROTATION_MAX_BACKDATE_MS }), ts_ms: ts };
		const edgeFuture = { ...rotation("evt_edge2", { new: key(9), at: ts + ROTATION_MAX_FUTURE_MS }), ts_ms: ts };
		const derived = signerSetFromRotationEvents(bootstrap, [backdated, tooFar, edgePast, edgeFuture], { authorize: operator });
		expect(derived.applied).toEqual(["evt_edge1", "evt_edge2"]);
		expect(derived.issues.map((issue) => `${issue.reason}:${issue.event_id}`)).toEqual(["effective-time-out-of-bounds:evt_far", "effective-time-out-of-bounds:evt_old"]);
	});

	test("old_pubkey must be valid at the effective time; new_pubkey must not already be valid then", () => {
		const derived = signerSetFromRotationEvents(
			bootstrap,
			[
				rotation("evt_1", { old: C, new: B, at: T0 }), // C was never a signer
				rotation("evt_2", { new: A, at: T0 + DAY }), // A is already valid from then on
				rotation("evt_3", { old: A, new: B, at: T0 + 2 * DAY }), // fine
				rotation("evt_4", { old: A, new: C, at: T0 + 3 * DAY }), // A already retired at +2d
			],
			{ authorize: operator },
		);
		expect(derived.applied).toEqual(["evt_3"]);
		expect(derived.issues.map((issue) => `${issue.reason}:${issue.event_id}`)).toEqual(["new-key-overlaps:evt_2", "old-key-not-valid:evt_1", "old-key-not-valid:evt_4"]);
	});

	test("a retired key may be re-introduced after its window closed", () => {
		const derived = signerSetFromRotationEvents(
			bootstrap,
			[rotation("evt_1", { old: A, new: B, at: T0 }), rotation("evt_2", { old: B, new: A, at: T0 + DAY })],
			{ authorize: operator },
		);
		expect(derived.issues).toEqual([]);
		expect(derived.set.filter((entry) => entry.pubkey === A)).toHaveLength(2);
		expect(acceptsSigner(derived.set, A, T0 + DAY).ok).toBe(true);
		expect(acceptsSigner(derived.set, A, T0 + 1).ok).toBe(false);
	});

	test("a repeated event id is applied once", () => {
		const first = rotation("evt_1", { old: A, new: B, at: T0 });
		const derived = signerSetFromRotationEvents(bootstrap, [first, { ...first }], { authorize: operator });
		expect(derived.applied).toEqual(["evt_1"]);
		expect(derived.issues.map((issue) => issue.reason)).toEqual(["duplicate-event-id"]);
	});

	test("a set that is full refuses another key", () => {
		const full = parseSignerSet(Array.from({ length: SIGNER_SET_MAX_ENTRIES }, (_, i) => ({ pubkey: key(200 + i), valid_from_ms: 0, valid_until_ms: null })));
		const derived = signerSetFromRotationEvents(full, [rotation("evt_1", { new: A, at: T0 })], { authorize: operator });
		expect(derived.set).toHaveLength(SIGNER_SET_MAX_ENTRIES);
		expect(derived.issues.map((issue) => issue.reason)).toEqual(["set-full"]);
	});

	test("payloads read back from the ledger with _ik are accepted", () => {
		const event = rotation("evt_1", { old: A, new: B, at: T0 });
		const stored = { ...event, payload: { ...rotationPayload({ old: A, new: B, at: T0 }), _ik: `anchor-rotate:${B}:${T0}` } };
		const derived = signerSetFromRotationEvents(bootstrap, [stored], { authorize: operator });
		expect(derived.applied).toEqual(["evt_1"]);
	});

	test("an invalid bootstrap set is refused", () => {
		const bad = [
			{ pubkey: A, valid_from_ms: 0, valid_until_ms: null },
			{ pubkey: A, valid_from_ms: 5, valid_until_ms: null },
		] as SignerSet;
		expect(rule(() => signerSetFromRotationEvents(bad, [], { authorize: operator }))).toBe("overlap");
	});
});
