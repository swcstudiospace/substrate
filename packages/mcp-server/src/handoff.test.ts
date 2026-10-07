import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { canonicalJson, normalizeEvent } from "./event.ts";
import {
	HANDOFF_ALG,
	buildHandoff,
	handoffGaps,
	handoffSummary,
	signHandoff,
	verifyHandoff,
	type HandoffPacket,
} from "./handoff.ts";
import { REDACTED } from "./redact.ts";

const KEYS = new Map([["k1", "a-signing-key-from-substrate-env"]]);
const SIGNER = { key_id: "k1", key: "a-signing-key-from-substrate-env" };

function packet(overrides: Partial<Parameters<typeof buildHandoff>[0]> = {}): HandoffPacket {
	return buildHandoff({
		from: { surface: "grok-bot", session_id: "sess-grok" },
		to: { surface: "hermes", session_id: null },
		goal: "finish n2: the lease CAS path in index-store",
		files: ["packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/lease.ts"],
		dod: ["bun test green", "two agents cannot both hold n2"],
		blockers: ["needs SUBSTRATE_PG_URL to run the live exclusivity test"],
		graph_id: "ut-1",
		node_id: "n2",
		linear_identifier: "SPE-4792",
		repo: "swcstudiospace/agent-substrate",
		branch: "claude/spe-4792",
		prev_event_hash: "a".repeat(64),
		...overrides,
	});
}

describe("the packet schema", () => {
	test("carries goal, files, DoD, blockers and prev_event_hash", () => {
		const built = packet();

		expect(built.goal).toBe("finish n2: the lease CAS path in index-store");
		expect(built.files).toEqual([
			"packages/mcp-server/src/index-store.ts",
			"packages/mcp-server/src/lease.ts",
		]);
		expect(built.dod).toEqual(["bun test green", "two agents cannot both hold n2"]);
		expect(built.blockers).toEqual(["needs SUBSTRATE_PG_URL to run the live exclusivity test"]);
		expect(built.prev_event_hash).toBe("a".repeat(64));
		expect(built.version).toBe(1);
		expect(built.handoff_id).toMatch(/^hof_[0-9a-f]{32}$/);
	});

	test("a goal is required; everything else may be absent", () => {
		expect(() => buildHandoff({ from: { surface: "omp", session_id: null }, to: { surface: "hermes", session_id: null }, goal: "  " })).toThrow(
			"needs a goal",
		);
		const thin = buildHandoff({
			from: { surface: "omp", session_id: null },
			to: { surface: "hermes", session_id: null },
			goal: "take over",
		});
		expect(thin.files).toEqual([]);
		expect(thin.dod).toEqual([]);
		expect(thin.blockers).toEqual([]);
		expect(thin.prev_event_hash).toBeNull();
	});

	test("redacts every free-text field before it is signed", () => {
		// The packet is signed and then appended to a log nothing can rewrite, so a
		// credential in a goal has exactly one chance to be caught: here.
		// The credential shapes here are deliberately not `GREPTIME_*`: the store
		// lock scans every tracked file for those, and it is right to — a fixture is
		// not worth an exemption in the one test that keeps secrets out of the repo.
		const built = packet({
			goal: "resume the deploy with PGPASSWORD=hunter2",
			blockers: ["waiting on LINEAR_API_KEY=lin_api_abcdefghijklmnopqrstuvwx"],
			notes: "ssh key: -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
		});

		expect(built.goal).toBe(`resume the deploy with PGPASSWORD=${REDACTED}`);
		expect(built.blockers[0]).toContain(REDACTED);
		expect(built.blockers[0]).not.toContain("lin_api_abcdefghij");
		expect(built.notes).toBe("ssh key: [REDACTED_PEM]");
	});

	test("reports what is thin rather than refusing to record it", () => {
		const gaps = handoffGaps(
			buildHandoff({ from: { surface: "omp", session_id: null }, to: { surface: "hermes", session_id: null }, goal: "take over" }),
		);
		expect(gaps.join(" ")).toContain("Definition of Done");
		expect(gaps.join(" ")).toContain("prev_event_hash");
		expect(handoffGaps(packet())).toEqual([]);
	});

	test("summarises to one line naming the receiver and the blocker count", () => {
		expect(handoffSummary(packet())).toBe(
			"handoff to hermes: finish n2: the lease CAS path in index-store (1 blocker)",
		);
	});
});

describe("signing", () => {
	test("a signed packet verifies", () => {
		const signed = signHandoff(packet(), SIGNER);
		expect(signed.signature?.alg).toBe(HANDOFF_ALG);
		expect(signed.signature?.key_id).toBe("k1");
		expect(signed.signature?.value).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyHandoff(signed, KEYS)).toEqual({ ok: true, key_id: "k1" });
	});

	test("every field is covered: changing any one of them breaks the signature", () => {
		const signed = signHandoff(packet(), SIGNER);
		const tampered: Array<[string, HandoffPacket]> = [
			["goal", { ...signed, goal: "do something else entirely" }],
			["files", { ...signed, files: [...signed.files, "packages/host/src/secret.ts"] }],
			["dod", { ...signed, dod: [] }],
			["blockers", { ...signed, blockers: [] }],
			["prev_event_hash", { ...signed, prev_event_hash: "b".repeat(64) }],
			["node_id", { ...signed, node_id: "n9" }],
			["to", { ...signed, to: { surface: "muse", session_id: null } }],
			["from", { ...signed, from: { surface: "muse", session_id: "sess-grok" } }],
			["repo", { ...signed, repo: "swcstudiospace/somewhere-else" }],
			["ts", { ...signed, ts: new Date(0).toISOString() }],
			["truncated", { ...signed, truncated: { files: 12 } }],
			["lease_handover", { ...signed, lease_handover: !signed.lease_handover }],
		];

		for (const [field, packetWith] of tampered) {
			expect(verifyHandoff(packetWith, KEYS), `tampering with ${field} was not caught`).toEqual({
				ok: false,
				reason: "bad-signature",
			});
		}
	});

	test("the signature header is covered too — it cannot be back-dated or re-pointed", () => {
		const signed = signHandoff(packet(), SIGNER);
		const header = signed.signature!;

		expect(verifyHandoff({ ...signed, signature: { ...header, signed_at: new Date(0).toISOString() } }, KEYS)).toEqual({
			ok: false,
			reason: "bad-signature",
		});
		// Re-pointing at the other key fails on the key id being part of the body,
		// not merely on the key being different.
		const twoKeys = new Map([...KEYS, ["k0", "a-signing-key-from-substrate-env"]]);
		expect(verifyHandoff({ ...signed, signature: { ...header, key_id: "k0" } }, twoKeys)).toEqual({
			ok: false,
			reason: "bad-signature",
		});
	});

	test("an unsigned packet is reported as unsigned, not as valid", () => {
		expect(verifyHandoff(packet(), KEYS)).toEqual({ ok: false, reason: "unsigned" });
		expect(signHandoff(packet(), null).signature).toBeNull();
	});

	test("a packet signed with a key the verifier does not have names the key it wants", () => {
		const signed = signHandoff(packet(), { key_id: "k7", key: "some-other-key" });
		expect(verifyHandoff(signed, KEYS)).toEqual({ ok: false, reason: "unknown-key", detail: "k7" });
	});

	test("rotation: the retired key still verifies what it signed", () => {
		// The point of key_id. Packets already in the append-only ledger must not
		// become unverifiable the day a key is rotated.
		const old = signHandoff(packet(), { key_id: "k0", key: "the-old-key" });
		const fresh = signHandoff(packet(), SIGNER);
		const during = new Map([
			["k0", "the-old-key"],
			["k1", "a-signing-key-from-substrate-env"],
		]);

		expect(verifyHandoff(old, during).ok).toBe(true);
		expect(verifyHandoff(fresh, during).ok).toBe(true);
		// And after the old key is dropped, the old packet fails loudly rather than quietly.
		expect(verifyHandoff(old, KEYS)).toEqual({ ok: false, reason: "unknown-key", detail: "k0" });
	});

	test("a packet signed before lease_handover, carrying the old lease id field, still verifies", () => {
		// Packets in the append-only ledger were signed over `handover_lease_id` and
		// cannot be re-signed. Verification recomputes over the packet as stored, so
		// the field the builder no longer writes is still covered where it exists.
		const { lease_handover: _dropped, ...current } = packet();
		// The shape the pre-v1.2 builder produced, which the current type only reads.
		const legacy = { ...current, handover_lease_id: "lse_0123456789abcdef0123456789abcdef" } as unknown as HandoffPacket;
		const stored = JSON.parse(JSON.stringify(signHandoff(legacy, SIGNER))) as HandoffPacket;

		expect(verifyHandoff(stored, KEYS)).toEqual({ ok: true, key_id: "k1" });
		expect(verifyHandoff({ ...stored, handover_lease_id: "lse_forged" }, KEYS)).toEqual({ ok: false, reason: "bad-signature" });
	});

	test("an unknown algorithm is refused rather than assumed", () => {
		const signed = signHandoff(packet(), SIGNER);
		expect(verifyHandoff({ ...signed, signature: { ...signed.signature!, alg: "none" as never } }, KEYS)).toEqual({
			ok: false,
			reason: "unknown-alg",
			detail: "none",
		});
	});

	test("with no keys configured, verification says so instead of passing", () => {
		expect(verifyHandoff(signHandoff(packet(), SIGNER), new Map())).toEqual({ ok: false, reason: "no-keys-configured" });
	});

	test("garbage is malformed, not a crash", () => {
		expect(verifyHandoff(null, KEYS)).toEqual({ ok: false, reason: "malformed" });
		expect(verifyHandoff("a packet", KEYS)).toEqual({ ok: false, reason: "malformed" });
		expect(verifyHandoff({ signature: { alg: HANDOFF_ALG, key_id: 3, value: 7 } }, KEYS)).toEqual({
			ok: false,
			reason: "malformed",
		});
		expect(verifyHandoff({ signature: { alg: HANDOFF_ALG, key_id: "k1", value: "zz" } }, KEYS)).toEqual({
			ok: false,
			reason: "bad-signature",
		});
	});
});

describe("the lease in a packet", () => {
	test("records that the sender meant to hand its lease over, never the id", () => {
		// Every agent can replay a packet through `coord_handoff_list`, and the id is
		// the token that releases or completes the node.
		const handing = packet({ handover_lease_id: "lse_0123456789abcdef0123456789abcdef" });
		const keeping = packet();

		expect(handing.lease_handover).toBe(true);
		expect(keeping.lease_handover).toBe(false);
		expect(canonicalJson(signHandoff(handing, SIGNER))).not.toContain("lse_0123456789abcdef0123456789abcdef");
		expect(handing).not.toHaveProperty("handover_lease_id");
	});
});

describe("replayable from the packet alone", () => {
	test("the signature survives the round trip through the event payload", () => {
		// The property the whole design rests on. `normalizeEvent` redacts and caps
		// the payload on ingest, so a packet signed before that and read back after
		// it must be byte-identical — otherwise every stored handoff would fail
		// verification and nobody would find out until the first replay.
		const signed = signHandoff(packet(), SIGNER);

		const event = normalizeEvent(
			{ surface: "grok-bot", kind: "handoff", summary: handoffSummary(signed), payload: { handoff: signed } },
			null,
		);
		const stored = event.payload.handoff as HandoffPacket;

		expect(canonicalJson(stored)).toBe(canonicalJson(signed));
		expect(verifyHandoff(stored, KEYS)).toEqual({ ok: true, key_id: "k1" });
	});

	test("a large packet is trimmed before signing, so the stored packet is the signed one", () => {
		const signed = signHandoff(
			packet({
				files: Array.from({ length: 200 }, (_, i) => `packages/mcp-server/src/generated/module-${i}-${"x".repeat(120)}.ts`),
				notes: "y".repeat(1200),
			}),
			SIGNER,
		);

		// Fitted under the payload cap, so `normalizeEvent` does not replace it.
		const event = normalizeEvent(
			{ surface: "grok-bot", kind: "handoff", summary: "handoff", payload: { handoff: signed } },
			null,
		);
		expect(event.payload._dropped).toBeUndefined();
		expect(verifyHandoff(event.payload.handoff, KEYS)).toEqual({ ok: true, key_id: "k1" });

		// And the trimming is recorded in the signed body rather than being silent.
		expect(signed.truncated?.files).toBeGreaterThan(0);
		expect(signed.files.length).toBeLessThan(200);
		// The parts that make a handoff actionable are the last to go.
		expect(signed.dod).toEqual(["bun test green", "two agents cannot both hold n2"]);
		expect(signed.blockers).toHaveLength(1);
	});

	test("a Grok to Hermes handoff replays with nothing but the packet", () => {
		// The proof the work order asks for: the receiver reads the packet out of the
		// ledger and knows who handed off, what to do, where, when it is done, what
		// is in the way, and which event trail it continues.
		const signed = signHandoff(packet(), SIGNER);
		const replayed = JSON.parse(JSON.stringify(signed)) as HandoffPacket;

		expect(verifyHandoff(replayed, KEYS).ok).toBe(true);
		expect(replayed.from.surface).toBe("grok-bot");
		expect(replayed.to.surface).toBe("hermes");
		expect(replayed.repo).toBe("swcstudiospace/agent-substrate");
		expect(replayed.branch).toBe("claude/spe-4792");
		expect(replayed.graph_id).toBe("ut-1");
		expect(replayed.node_id).toBe("n2");
		expect(replayed.linear_identifier).toBe("SPE-4792");
		expect(replayed.prev_event_hash).toBe("a".repeat(64));
		expect(handoffGaps(replayed)).toEqual([]);
	});
});

describe("signing keys from the environment", () => {
	test("no key configured means no signing, and that is a legible state", () => {
		const config = loadConfig({});
		expect(config.handoffKeyId).toBeNull();
		expect(config.handoffKeys.size).toBe(0);
	});

	test("the live key signs and the retired key still verifies", () => {
		const config = loadConfig({
			SUBSTRATE_HANDOFF_KEY: "new-key",
			SUBSTRATE_HANDOFF_KEY_ID: "2026-09",
			SUBSTRATE_HANDOFF_KEY_PREV: "old-key",
			SUBSTRATE_HANDOFF_KEY_PREV_ID: "2026-06",
		});

		expect(config.handoffKeyId).toBe("2026-09");
		expect([...config.handoffKeys.keys()].sort()).toEqual(["2026-06", "2026-09"]);
	});

	test("ids that collide leave the live key in place, not the retired one", () => {
		const config = loadConfig({ SUBSTRATE_HANDOFF_KEY: "new-key", SUBSTRATE_HANDOFF_KEY_PREV: "old-key", SUBSTRATE_HANDOFF_KEY_PREV_ID: "k1" });
		expect(config.handoffKeys.get("k1")).toBe("new-key");
	});
});
