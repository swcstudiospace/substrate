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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configWarnings, isOperator, loadConfig, surfaceForToken, swarmTokenWarnings, tokenEnvName } from "./config.ts";
import { attributedSurface } from "./mcp.ts";
import { Substrate } from "./service.ts";
import { SURFACES, SWARM_SURFACES, type SubstrateEvent } from "./types.ts";

/**
 * An operator credential is a *surface* token that is also listed as an
 * operator's — `cursor` here, the surface a human on the host commits as.
 *
 * Not a separate class of credential, and that is the point: a token that
 * authenticated while naming no surface would reach the authoring routes with
 * no identity, and each of those falls back to the request body, so it could
 * have signed a handoff as any agent it named.
 */
const TOKENS = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
	SUBSTRATE_TOKEN_CURSOR: "tok-operator",
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
};

describe("isOperator", () => {
	test("a surface token is not an operator token", () => {
		const config = loadConfig(TOKENS);
		expect(surfaceForToken(config, "Bearer tok-hermes")).toBe("hermes");
		expect(isOperator(config, "Bearer tok-hermes")).toBe(false);
		expect(isOperator(config, "Bearer tok-grok")).toBe(false);
	});

	test("an operator token is, and still names its surface", () => {
		const config = loadConfig(TOKENS);
		expect(isOperator(config, "Bearer tok-operator")).toBe(true);
		// So a forced release is always attributable to whoever used it.
		expect(surfaceForToken(config, "Bearer tok-operator")).toBe("cursor");
	});

	test("several operators may be configured", () => {
		const config = loadConfig({
			...TOKENS,
			SUBSTRATE_TOKEN_CURSOR: "tok-a",
			SUBSTRATE_TOKEN_MUSE: "tok-b",
			SUBSTRATE_TOKEN_PI: "tok-c",
			SUBSTRATE_OPERATOR_TOKENS: "tok-a, tok-b ,tok-c",
		});
		for (const token of ["tok-a", "tok-b", "tok-c"]) expect(isOperator(config, `Bearer ${token}`)).toBe(true);
		expect(isOperator(config, "Bearer tok-d")).toBe(false);
	});

	test("an operator token that names no surface is reported at boot, not left silent", () => {
		// It could never authenticate — the HTTP surface requires a token that names
		// a surface — so it would look configured and do nothing.
		const stranded = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes", SUBSTRATE_OPERATOR_TOKENS: "tok-nowhere" });
		expect(configWarnings(stranded)).toHaveLength(1);
		expect(configWarnings(stranded)[0]).toContain("cannot authenticate");

		expect(configWarnings(loadConfig(TOKENS))).toEqual([]);
		expect(configWarnings(loadConfig({}))).toEqual([]);
	});

	test("with no surface tokens at all, the warning says the opposite — because the opposite is true", () => {
		// A warning has to describe the running deployment. Here `allowAnonymous`
		// lets every caller in and the operator token *does* work, so telling an
		// operator it "cannot authenticate" would send them to fix the wrong thing —
		// and the thing actually worth knowing is that nothing else is gated.
		const anonymous = loadConfig({ SUBSTRATE_OPERATOR_TOKENS: "tok-operator" });
		const warnings = configWarnings(anonymous);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("accepted unauthenticated");
		expect(warnings[0]).not.toContain("cannot authenticate");
		// And the claim it makes is the one the code actually implements.
		expect(anonymous.allowAnonymous).toBe(true);
		expect(isOperator(anonymous, "Bearer tok-operator")).toBe(true);
		expect(isOperator(anonymous, null)).toBe(false);
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

describe("the swarm surfaces", () => {
	test("are the 15 agents, in A01..A15 order, after the original 11", () => {
		expect(SWARM_SURFACES).toHaveLength(15);
		expect(SURFACES).toHaveLength(26);
		expect(SURFACES.slice(11)).toEqual([...SWARM_SURFACES]);
		expect(SWARM_SURFACES[0]).toBe("swarm-a01-orch");
		expect(SWARM_SURFACES[4]).toBe("swarm-a05-be");
		expect(SWARM_SURFACES[14]).toBe("swarm-a15-doc");
	});

	test("each one's token env name resolves back to that surface", () => {
		for (const surface of SWARM_SURFACES) {
			const config = loadConfig({ [tokenEnvName(surface)]: `tok-${surface}` });
			expect(surfaceForToken(config, `Bearer tok-${surface}`)).toBe(surface);
		}
		expect(tokenEnvName("swarm-a05-be")).toBe("SUBSTRATE_TOKEN_SWARM_A05_BE");
	});

	test(".env.example lists a blank SUBSTRATE_TOKEN_* line for every one", () => {
		const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8").split("\n");
		for (const surface of SWARM_SURFACES) {
			expect(example).toContain(`${tokenEnvName(surface)}=`);
		}
	});
});

describe("swarmTokenWarnings", () => {
	test("a bare local run is silent", () => {
		expect(swarmTokenWarnings(loadConfig({}))).toEqual([]);
	});

	test("a deployment with tokens names every swarm surface that has none", () => {
		const warnings = swarmTokenWarnings(loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes" }));
		expect(warnings).toHaveLength(1);
		for (const surface of SWARM_SURFACES) expect(warnings[0]).toContain(tokenEnvName(surface));
		expect(warnings[0]).toContain("15 swarm surfaces");
		// Never a token value.
		expect(warnings[0]).not.toContain("tok-hermes");
	});

	test("lists only the ones still missing, and is silent when none are", () => {
		const some = loadConfig({
			SUBSTRATE_TOKEN_HERMES: "tok-hermes",
			SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-a05",
		});
		const warnings = swarmTokenWarnings(some);
		expect(warnings[0]).toContain("14 swarm surfaces");
		expect(warnings[0]).not.toContain("SUBSTRATE_TOKEN_SWARM_A05_BE");
		expect(warnings[0]).toContain("SUBSTRATE_TOKEN_SWARM_A09_REV");

		const all = Object.fromEntries(SWARM_SURFACES.map((surface) => [tokenEnvName(surface), `tok-${surface}`]));
		expect(swarmTokenWarnings(loadConfig(all))).toEqual([]);
	});
});

describe("attributedSurface", () => {
	test("a swarm token cannot act as another swarm surface", () => {
		const result = attributedSurface("swarm-a05-be", "swarm-a09-rev");
		expect(result).toEqual({ refused: "this token is swarm-a05-be and cannot act as swarm-a09-rev" });
	});

	test("a swarm token cannot act as a non-swarm surface either", () => {
		expect("refused" in attributedSurface("swarm-a05-be", "hermes")).toBe(true);
	});

	test("a swarm token naming itself, or nothing, is itself", () => {
		expect(attributedSurface("swarm-a05-be", "swarm-a05-be")).toEqual({ surface: "swarm-a05-be" });
		expect(attributedSurface("swarm-a05-be", undefined)).toEqual({ surface: "swarm-a05-be" });
		expect(attributedSurface("swarm-a05-be", null)).toEqual({ surface: "swarm-a05-be" });
	});

	test("every other caller keeps the long-standing supplied-first behaviour", () => {
		// The deliberate boundary: collectors and hooks emit for the surfaces they
		// observe, and an anonymous local run has no token to name it.
		expect(attributedSurface("cursor", "hermes")).toEqual({ surface: "hermes" });
		expect(attributedSurface("cursor", "swarm-a09-rev")).toEqual({ surface: "swarm-a09-rev" });
		expect(attributedSurface("cursor", undefined)).toEqual({ surface: "cursor" });
		expect(attributedSurface(null, "hermes")).toEqual({ surface: "hermes" });
		expect(attributedSurface(null, undefined)).toEqual({ surface: "claude-code" });
	});
});
