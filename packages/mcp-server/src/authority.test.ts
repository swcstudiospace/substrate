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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ConfigError, configWarnings, isOperator, loadConfig, surfaceForToken, swarmTokenWarnings, tokenConfig, tokenEnvName } from "./config.ts";
import { attributedSurface, claimAttribution, swarmSessionRefusal } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { SURFACES, SWARM_SURFACES, type SubstrateEvent } from "./types.ts";

// Generated for each run, so no token-shaped literal sits in the repository.
const HERMES_TOKEN = `hermes-${randomUUID()}`;
const GROK_TOKEN = `grok-bot-${randomUUID()}`;
const OPERATOR_TOKEN = `operator-${randomUUID()}`;
const NOWHERE_TOKEN = `nowhere-${randomUUID()}`;
const SWARM_A05_TOKEN = `swarm-a05-${randomUUID()}`;
const SWARM_A09_TOKEN = `swarm-a09-${randomUUID()}`;

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
	SUBSTRATE_TOKEN_HERMES: HERMES_TOKEN,
	SUBSTRATE_TOKEN_GROK_BOT: GROK_TOKEN,
	SUBSTRATE_TOKEN_CURSOR: OPERATOR_TOKEN,
	SUBSTRATE_OPERATOR_TOKENS: OPERATOR_TOKEN,
};

describe("isOperator", () => {
	test("a surface token is not an operator token", () => {
		const config = loadConfig(TOKENS);
		expect(surfaceForToken(config, `Bearer ${HERMES_TOKEN}`)).toBe("hermes");
		expect(isOperator(config, `Bearer ${HERMES_TOKEN}`)).toBe(false);
		expect(isOperator(config, `Bearer ${GROK_TOKEN}`)).toBe(false);
	});

	test("an operator token is, and still names its surface", () => {
		const config = loadConfig(TOKENS);
		expect(isOperator(config, `Bearer ${OPERATOR_TOKEN}`)).toBe(true);
		// So a forced release is always attributable to whoever used it.
		expect(surfaceForToken(config, `Bearer ${OPERATOR_TOKEN}`)).toBe("cursor");
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
		const stranded = loadConfig({ SUBSTRATE_TOKEN_HERMES: HERMES_TOKEN, SUBSTRATE_OPERATOR_TOKENS: NOWHERE_TOKEN });
		expect(configWarnings(stranded)).toHaveLength(1);
		expect(configWarnings(stranded)[0]).toContain("cannot authenticate");
		expect(isOperator(stranded, `Bearer ${NOWHERE_TOKEN}`)).toBe(false);

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

	test("a swarm token is never an operator, even when it is listed as one", () => {
		// Fail closed: one swarm agent able to force another's node is the advisory
		// lease again, and the list is a configuration someone can get wrong.
		const config = loadConfig({
			...TOKENS,
			SUBSTRATE_TOKEN_SWARM_A05_BE: SWARM_A05_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: `${OPERATOR_TOKEN},${SWARM_A05_TOKEN}`,
		});

		expect(isOperator(config, `Bearer ${SWARM_A05_TOKEN}`)).toBe(false);
		expect(isOperator(config, `Bearer ${OPERATOR_TOKEN}`)).toBe(true);
	});

	test("and boot says which swarm surface was listed, without printing its token", () => {
		const config = loadConfig({
			...TOKENS,
			SUBSTRATE_TOKEN_SWARM_A05_BE: SWARM_A05_TOKEN,
			SUBSTRATE_TOKEN_SWARM_A09_REV: SWARM_A09_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: `${OPERATOR_TOKEN},${SWARM_A05_TOKEN}`,
		});
		const warnings = configWarnings(config);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("swarm-a05-be");
		expect(warnings[0]).not.toContain("swarm-a09-rev");
		expect(warnings[0]).not.toContain(SWARM_A05_TOKEN);
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
	test("are the swarm agents, in A01..A30 order, after the original 11, with substrate last", () => {
		expect(SURFACES.slice(11, 11 + SWARM_SURFACES.length)).toEqual([...SWARM_SURFACES]);
		expect(SURFACES.at(-1)).toBe("substrate");
		expect(SWARM_SURFACES[0]).toBe("swarm-a01-orch");
		expect(SWARM_SURFACES[4]).toBe("swarm-a05-be");
		expect(SWARM_SURFACES.at(-1)).toBe("swarm-a30-custody");
	});

	test("each one's token env name resolves back to that surface", () => {
		for (const surface of SWARM_SURFACES) {
			const config = loadConfig({ [tokenEnvName(surface)]: `tok-${surface}` });
			expect(surfaceForToken(config, `Bearer tok-${surface}`)).toBe(surface);
		}
		expect(tokenEnvName("swarm-a05-be")).toBe("SUBSTRATE_TOKEN_SWARM_A05_BE");
	});

	test("the substrate surface resolves its token env name back to itself", () => {
		expect(tokenEnvName("substrate")).toBe("SUBSTRATE_TOKEN_SUBSTRATE");
		const config = loadConfig({ SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate" });
		expect(surfaceForToken(config, "Bearer tok-substrate")).toBe("substrate");
	});

	test(".env.example lists a blank SUBSTRATE_TOKEN_* line for every one", () => {
		const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8").split("\n");
		for (const surface of SURFACES) {
			expect(example).toContain(`${tokenEnvName(surface)}=`);
		}
	});
});

describe("a substrate token is its surface", () => {
	test("attributedSurface binds it exactly like a swarm token", () => {
		// Own surface or nothing resolves to itself; naming another surface is
		// refused, never silently re-attributed — a job emitting as another
		// surface would corrupt attribution the same way a swarm agent would.
		expect(attributedSurface("substrate", "substrate")).toEqual({ surface: "substrate" });
		expect(attributedSurface("substrate", null)).toEqual({ surface: "substrate" });
		expect(attributedSurface("substrate", undefined)).toEqual({ surface: "substrate" });
		const refused = attributedSurface("substrate", "claude-code");
		expect("refused" in refused ? refused.refused : "").toContain("cannot act as claude-code");
	});

	test("every other non-swarm caller keeps body-first attribution", () => {
		// The collectors rely on this: one token legitimately emits for the
		// surfaces it observes, including the host-job surface.
		expect(attributedSurface("hermes", "substrate")).toEqual({ surface: "substrate" });
		expect(attributedSurface("hermes", "grok-bot")).toEqual({ surface: "grok-bot" });
		expect(attributedSurface(null, "substrate")).toEqual({ surface: "substrate" });
	});

	test("POST /events: the substrate token stores as itself, is refused as another surface", async () => {
		const written: SubstrateEvent[] = [];
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async () => "tip-hash",
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
		};
		const env = { SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate", SUBSTRATE_TOKEN_HERMES: "tok-hermes" };
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: greptime as never }, observability.observer);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const postEvent = (token: string, body: Record<string, unknown>) =>
				fetch(`${base}/events`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
					body: JSON.stringify({ kind: "note", summary: "anchor check", ...body }),
				});

			const own = await postEvent("tok-substrate", { surface: "substrate" });
			expect(own.status).toBe(202);

			const cross = await postEvent("tok-substrate", { surface: "claude-code" });
			const crossBody = (await cross.json()) as { error: string };
			expect(cross.status).toBe(403);
			expect(crossBody.error).toContain("cannot act as claude-code");

			// A non-swarm, non-substrate token keeps body-first attribution and
			// can still post a host-job row — which is what the smoke relies on.
			const borrowed = await postEvent("tok-hermes", { surface: "substrate" });
			expect(borrowed.status).toBe(202);

			expect(written.map((event) => event.surface)).toEqual(["substrate", "substrate"]);
		} finally {
			server.close();
			observability.stop();
		}
	});
});

describe("swarmTokenWarnings", () => {
	test("a bare local run is silent", () => {
		expect(swarmTokenWarnings(loadConfig({}))).toEqual([]);
	});

	test("a deployment with tokens names every swarm surface that has none", () => {
		const warnings = swarmTokenWarnings(loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes" }));
		expect(warnings).toHaveLength(2);
		for (const surface of SWARM_SURFACES) expect(warnings[0]).toContain(tokenEnvName(surface));
		expect(warnings[0]).toContain(`${SWARM_SURFACES.length} swarm surfaces`);
		// Never a token value.
		expect(warnings[0]).not.toContain("tok-hermes");
		// And the host-job surface is named beside the swarm seats.
		expect(warnings[1]).toContain("SUBSTRATE_TOKEN_SUBSTRATE");
		expect(warnings[1]).not.toContain("tok-hermes");
	});

	test("a missing substrate token warns on its own once the swarm seats are filled", () => {
		const env = Object.fromEntries(SWARM_SURFACES.map((surface) => [tokenEnvName(surface), `tok-${surface}`]));
		const warnings = swarmTokenWarnings(loadConfig(env));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SUBSTRATE_TOKEN_SUBSTRATE");
	});

	test("lists only the ones still missing, and is silent when none are", () => {
		const some = loadConfig({
			SUBSTRATE_TOKEN_HERMES: "tok-hermes",
			SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-a05",
		});
		const warnings = swarmTokenWarnings(some);
		expect(warnings[0]).toContain(`${SWARM_SURFACES.length - 1} swarm surfaces`);
		expect(warnings[0]).not.toContain("SUBSTRATE_TOKEN_SWARM_A05_BE");
		expect(warnings[0]).toContain("SUBSTRATE_TOKEN_SWARM_A09_REV");

		const all = Object.fromEntries(
			[...SWARM_SURFACES, "substrate" as const].map((surface) => [tokenEnvName(surface), `tok-${surface}`]),
		);
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

describe("claimAttribution", () => {
	test("a non-swarm token cannot claim as a swarm surface", () => {
		expect(claimAttribution("hermes", "swarm-a05-be")).toEqual({
			refused: "this token is hermes and cannot claim as swarm-a05-be",
		});
	});

	test("a swarm token claims as itself, and is refused as anyone else", () => {
		expect(claimAttribution("swarm-a05-be", undefined)).toEqual({ surface: "swarm-a05-be" });
		expect(claimAttribution("swarm-a05-be", "swarm-a05-be")).toEqual({ surface: "swarm-a05-be" });
		expect("refused" in claimAttribution("swarm-a05-be", "swarm-a09-rev")).toBe(true);
	});

	test("a non-swarm token naming another non-swarm surface, and an anonymous run, are unchanged", () => {
		expect(claimAttribution("cursor", "hermes")).toEqual({ surface: "hermes" });
		expect(claimAttribution(null, "swarm-a09-rev")).toEqual({ surface: "swarm-a09-rev" });
		expect(claimAttribution(null, undefined)).toEqual({ surface: "claude-code" });
	});
});

describe("swarmSessionRefusal", () => {
	const GRAPH = "ut-mg3k2p-1a2b3c4d";

	test("<AGENT>@<replica>:<graph_id> naming the token's own agent is accepted", () => {
		expect(swarmSessionRefusal("swarm-a05-be", `A05@r1:${GRAPH}`, GRAPH)).toBeNull();
		expect(swarmSessionRefusal("swarm-a15-doc", `A15@host-2.pod_7:${GRAPH}`, GRAPH)).toBeNull();
		expect(swarmSessionRefusal("swarm-a05-be", `A05@${"r".repeat(64)}:${GRAPH}`, GRAPH)).toBeNull();
	});

	test("a session naming another agent is refused", () => {
		expect(swarmSessionRefusal("swarm-a05-be", `A09@r1:${GRAPH}`, GRAPH)).toContain("must name agent A05");
		expect(swarmSessionRefusal("swarm-a05-be", `a05@r1:${GRAPH}`, GRAPH)).toContain("must name agent A05");
	});

	test("a replica outside [A-Za-z0-9._-]{1,64} is refused", () => {
		for (const replica of ["", "r 1", "r/1", "r@1", "rép", "r".repeat(65)]) {
			expect(swarmSessionRefusal("swarm-a05-be", `A05@${replica}:${GRAPH}`, GRAPH), replica).not.toBeNull();
		}
	});

	test("the graph must equal graph_id, not merely look like one", () => {
		expect(swarmSessionRefusal("swarm-a05-be", "A05@r1:ut-mg3k2p-00000000", GRAPH)).toContain("must end in");
		expect(swarmSessionRefusal("swarm-a05-be", `A05@r1:${GRAPH}x`, GRAPH)).toContain("must end in");
		expect(swarmSessionRefusal("swarm-a05-be", "A05@r1:", GRAPH)).toContain("must end in");
		// Equality, not a pattern: a graph id the uplift never minted is fine if it is this claim's.
		expect(swarmSessionRefusal("swarm-a05-be", "A05@r1:ut-1", "ut-1")).toBeNull();
	});

	test("a session that is not in the shape at all is refused", () => {
		for (const session of ["sess-1", "A05", "A05@r1", `A05:${GRAPH}`, ""]) {
			expect(swarmSessionRefusal("swarm-a05-be", session, GRAPH), session).toContain(`A05@<replica>:${GRAPH}`);
		}
	});
});

describe("a surface token variable holds a list", () => {
	test("each entry resolves to the variable's surface", () => {
		const config = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-h1,tok-h2" });
		expect(surfaceForToken(config, "Bearer tok-h1")).toBe("hermes");
		expect(surfaceForToken(config, "Bearer tok-h2")).toBe("hermes");
		expect(surfaceForToken(config, "Bearer tok-h1,tok-h2")).toBeNull();
	});

	test("entries split on commas, spaces and newlines, trimmed with empties dropped", () => {
		const tokens = tokenConfig({ SUBSTRATE_TOKEN_CURSOR: "tok-c1, tok-c2\ntok-c3  ,, \ntok-c4" });
		expect([...tokens.keys()].sort()).toEqual(["tok-c1", "tok-c2", "tok-c3", "tok-c4"]);
		for (const token of tokens.keys()) expect(tokens.get(token)).toBe("cursor");
	});

	test("a repeat under one variable is silently one entry", () => {
		const tokens = tokenConfig({ SUBSTRATE_TOKEN_CURSOR: "tok-c1, tok-c1" });
		expect(tokens.size).toBe(1);
		expect(tokens.get("tok-c1")).toBe("cursor");
	});

	test("one value under two surfaces throws naming both variables, never the value", () => {
		const env = { SUBSTRATE_TOKEN_HERMES: "tok-h1, tok-both", SUBSTRATE_TOKEN_CURSOR: "tok-c1, tok-both" };
		let thrown: unknown;
		try {
			tokenConfig(env);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ConfigError);
		const message = (thrown as ConfigError).message;
		expect(message).toContain("SUBSTRATE_TOKEN_HERMES");
		expect(message).toContain("SUBSTRATE_TOKEN_CURSOR");
		expect(message).not.toContain("tok-both");
		expect(() => loadConfig(env)).toThrow(ConfigError);
	});

	test("a variable naming no surface throws naming it", () => {
		let thrown: unknown;
		try {
			tokenConfig({ SUBSTRATE_TOKEN_DESK_GATEWAY: "tok-gw" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ConfigError);
		expect((thrown as ConfigError).message).toContain("SUBSTRATE_TOKEN_DESK_GATEWAY");
		expect((thrown as ConfigError).message).not.toContain("tok-gw");
	});

	test("the shipped example boots: every name it declares is a surface", () => {
		const root = join(import.meta.dir, "..", "..", "..");
		const env: Record<string, string> = {};
		for (const raw of readFileSync(join(root, ".env.example"), "utf8").split("\n")) {
			const line = raw.trim();
			if (line === "" || line.startsWith("#")) continue;
			const at = line.indexOf("=");
			expect(at).toBeGreaterThan(0);
			env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
		expect(Object.keys(env).length).toBeGreaterThan(0);
		expect(() => tokenConfig(env)).not.toThrow();
	});

	test("a single value is unchanged", () => {
		const config = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes" });
		expect(surfaceForToken(config, "Bearer tok-hermes")).toBe("hermes");
		expect(config.tokens.size).toBe(1);
	});

	test("a list entry also named as operator is an operator", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: "tok-c1, tok-op",
			SUBSTRATE_OPERATOR_TOKENS: "tok-op",
		});
		expect(surfaceForToken(config, "Bearer tok-op")).toBe("cursor");
		expect(isOperator(config, "Bearer tok-op")).toBe(true);
		expect(isOperator(config, "Bearer tok-c1")).toBe(false);
	});
});
