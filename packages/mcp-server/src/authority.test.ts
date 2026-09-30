/**
 * What a caller may assert about itself, and what the transport decides for it.
 *
 * Two things in this design stop being true the moment a caller can set them:
 *
 *   - **who signed a handoff.** A signature over a body-supplied sender is a
 *     forgery with a valid seal on it — worse than no signature, because a
 *     receiver has been given a reason to believe it.
 *   - **who may take a node off its holder.** Every surface token is equally
 *     privileged, so a `force` any peer can use makes every lease advisory
 *     again for anyone who chooses.
 *
 * Both are therefore decided from the bearer token before any argument is read,
 * and these are the tests that say so.
 */
import { describe, expect, test } from "bun:test";
import { isOperator, loadConfig, surfaceForToken } from "./config.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

const TOKENS = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
};

describe("isOperator", () => {
	test("a surface token is not an operator token", () => {
		const config = loadConfig(TOKENS);
		expect(surfaceForToken(config, "Bearer tok-hermes")).toBe("hermes");
		expect(isOperator(config, "Bearer tok-hermes")).toBe(false);
		expect(isOperator(config, "Bearer tok-grok")).toBe(false);
	});

	test("an operator token is", () => {
		expect(isOperator(loadConfig(TOKENS), "Bearer tok-operator")).toBe(true);
	});

	test("several operators may be configured", () => {
		const config = loadConfig({ ...TOKENS, SUBSTRATE_OPERATOR_TOKENS: "tok-a, tok-b ,tok-c" });
		for (const token of ["tok-a", "tok-b", "tok-c"]) expect(isOperator(config, `Bearer ${token}`)).toBe(true);
		expect(isOperator(config, "Bearer tok-d")).toBe(false);
	});

	test("no token, or an unknown one, is not an operator once tokens exist", () => {
		const config = loadConfig(TOKENS);
		expect(isOperator(config, null)).toBe(false);
		expect(isOperator(config, "Bearer ")).toBe(false);
		expect(isOperator(config, "Bearer nonsense")).toBe(false);
	});

	test("a bare local run is its own operator", () => {
		// No surface tokens at all means the machine's owner is the only caller —
		// `allowAnonymous` already says so — and there is no second agent to protect
		// the lease from. Requiring a token here would lock an operator out of their
		// own host.
		const config = loadConfig({});
		expect(config.allowAnonymous).toBe(true);
		expect(isOperator(config, null)).toBe(true);
	});

	test("but configuring operator tokens ends that, even with no surface tokens", () => {
		// Otherwise adding operator tokens to a deployment would widen access rather
		// than narrow it, which is the wrong direction for a lever like this.
		const config = loadConfig({ SUBSTRATE_OPERATOR_TOKENS: "tok-operator" });
		expect(isOperator(config, null)).toBe(false);
		expect(isOperator(config, "Bearer tok-operator")).toBe(true);
	});

	test("operator tokens are not surfaces, so an operator cannot emit as one", () => {
		expect(surfaceForToken(loadConfig(TOKENS), "Bearer tok-operator")).toBeNull();
	});
});

describe("the signed sender is the authenticated caller", () => {
	function ledger() {
		const written: SubstrateEvent[] = [];
		return {
			written,
			greptime: {
				ensureAppendMode: async () => true,
				lastHash: async () => "tip-hash",
				insertEvent: async (event: SubstrateEvent) => {
					written.push(event);
				},
			},
		};
	}

	const body = {
		to: { surface: "hermes" as const, session_id: null },
		goal: "take over n2",
		graph_id: "ut-1",
		node_id: "n2",
	};

	test("a packet signed for one surface does not verify as another", () => {
		// The property the binding protects. Even without the binding, a receiver
		// checking the signature learns only that the substrate signed *something*:
		// the sender is inside the signed body, so it is the binding at the entry
		// point that has to be right.
		const { greptime } = ledger();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_HANDOFF_KEY: "k" }), { index: null, greptime: greptime as never });

		return substrate
			.handoff({ ...body, from: { surface: "grok-bot", session_id: "sess-grok" } })
			.then((result) => {
				expect(result.packet.from.surface).toBe("grok-bot");
				expect(substrate.verifyHandoffPacket(result.packet).ok).toBe(true);
				// Rewriting the sender after the fact is caught, which is what makes the
				// entry-point binding the only thing that decides identity.
				expect(
					substrate.verifyHandoffPacket({ ...result.packet, from: { surface: "hermes", session_id: "sess-grok" } }),
				).toEqual({ ok: false, reason: "bad-signature" });
			});
	});

	test("the substrate signs whatever sender it is handed, so the transport must bind it", async () => {
		// Stated as a test because it is the reason `from` is not an MCP argument and
		// why the REST route prefers the token's surface: this layer cannot tell a
		// true sender from a false one, so the layer that knows has to decide.
		const { greptime } = ledger();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_HANDOFF_KEY: "k" }), { index: null, greptime: greptime as never });

		const impersonated = await substrate.handoff({ ...body, from: { surface: "muse", session_id: "sess-x" } });

		expect(impersonated.packet.from.surface).toBe("muse");
		expect(impersonated.signed).toBe(true);
	});

	test("the anchor comes from the ledger, and a caller cannot substitute one", async () => {
		const { greptime } = ledger();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_HANDOFF_KEY: "k" }), { index: null, greptime: greptime as never });

		const result = await substrate.handoff({
			...body,
			from: { surface: "grok-bot", session_id: "sess-grok" },
			prev_event_hash: "f".repeat(64),
		} as never);

		expect(result.packet.prev_event_hash).toBe("tip-hash");
	});
});
