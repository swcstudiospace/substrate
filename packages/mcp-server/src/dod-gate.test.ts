import { describe, expect, test } from "bun:test";
import { CONNECTOR_COMPLETE_PATH, runDodGate, type DodEvidence, type DodGateDeps } from "./dod-gate.ts";
import type { Mirror, MirrorContext } from "./mirror.ts";
import { defined } from "./test-support.ts";

const LEASE_ID = "lease-planted-9f8e7d6c5b4a";

function ctx(): MirrorContext {
	return {
		graphId: "g1",
		nodeId: "n1",
		holder: "hermes",
		sessionId: "sess-1",
		epoch: 3,
		linearRef: "uuid-issue-1",
		notionPage: null,
	};
}

const DOD: DodEvidence = { summary: "All checks green", tests_pass: true, review_pass: true };

interface ConnectorCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** A Mirror stand-in with scripted Linear states (one per read) and review failures. */
function fakeMirrorGate(states: Array<{ name: string; type: string } | null>, reviewFailures: boolean) {
	const calls: string[] = [];
	const queue = [...states];
	const mirror = {
		linearState: async () => {
			calls.push("linearState");
			return queue.shift() ?? null;
		},
		review: async () => {
			calls.push("review");
			return reviewFailures
				? [{ target: "notion" as const, op: "review" as const, reason: "notion 502: upstream" }]
				: [];
		},
	} as unknown as Mirror;
	return { calls, mirror };
}

/** A connector stand-in recording requests and answering from a script. */
function fakeConnector(
	respond: (call: ConnectorCall) => Response | Promise<Response>,
	hooks?: { onCall?: () => void },
) {
	const calls: ConnectorCall[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers ?? {});
		const parsed = JSON.parse(String(init.body)) as ConnectorCall["body"];
		const call: ConnectorCall = { url, headers: Object.fromEntries(headers.entries()), body: parsed };
		calls.push(call);
		hooks?.onCall?.();
		return respond(call);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}
function deps(
	mirror: Mirror,
	fetchImpl: typeof fetch,
	opts?: { hermesLinearUrl?: string; timeoutMs?: number },
): DodGateDeps {
	return {
		mirror,
		fetchImpl,
		hermesLinearUrl: opts?.hermesLinearUrl ?? "http://127.0.0.1:8792",
		timeoutMs: opts?.timeoutMs ?? 35000,
	};
}

describe("evidence-free completions never reach the connector", () => {
	test("no dod means no connector call and dod-required with the lease kept", async () => {
		const { calls: mirrorCalls, mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { calls, fetchImpl } = fakeConnector(() => Response.json({ completed: true }));

		const result = await runDodGate(deps(mirror, fetchImpl), ctx());

		expect(calls).toHaveLength(0);
		expect(result).toEqual({
			gate: "refused",
			reason: "dod-required",
			detail: expect.stringContaining("needs dod"),
			mirrorFailures: [],
		});
		// The review mirror still ran ahead of the refusal.
		expect(mirrorCalls).toEqual(["linearState", "review"]);
	});
});

describe("versioned connector fixture (hermes-linear-connector@6e532fe)", () => {
	test("the request carries issue, summary and evidence with no auth", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { calls, fetchImpl } = fakeConnector(() =>
			Response.json({ completed: true, reason: "ok", linear_issue_id: "uuid-issue-1" }),
		);

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result.gate).toBe("approved");
		expect(calls).toHaveLength(1);
		expect(defined(calls[0], "call").url).toBe(`http://127.0.0.1:8792${CONNECTOR_COMPLETE_PATH}`);
		expect(defined(calls[0], "call").body).toEqual({
			linear_issue_id: "uuid-issue-1",
			summary: "All checks green",
			tests_pass: true,
			review_pass: true,
		});
		expect(defined(calls[0], "call").headers).not.toHaveProperty("Authorization");
	});

	test("only an explicit completed:true approves; completed:false is dod-refused with the reason", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { fetchImpl } = fakeConnector(() =>
			Response.json({ completed: false, reason: "tests did not pass", linear_issue_id: "uuid-issue-1" }),
		);

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result).toMatchObject({ gate: "refused", reason: "dod-refused", detail: "tests did not pass" });
	});

	test("a 502 engine error is dod-unavailable with the capped body", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { fetchImpl } = fakeConnector(() => new Response("engine blew up", { status: 502 }));

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result).toMatchObject({ gate: "refused", reason: "dod-unavailable" });
		if (result.gate === "refused") {
			expect(result.detail).toContain("502");
			expect(result.detail.length).toBeLessThanOrEqual(300);
		}
	});

	test("unreachable and malformed replies are dod-unavailable, never approval", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const unreachable = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect((await runDodGate(deps(mirror, unreachable), ctx(), DOD)).gate).toBe("refused");

		const malformedJson = fakeConnector(() => new Response("not json{", { status: 200 }));
		const noFlag = fakeConnector(() => Response.json({ reason: "hmm" }));
		for (const fake of [malformedJson, noFlag]) {
			const result = await runDodGate(deps(mirror, fake.fetchImpl), ctx(), DOD);
			expect(result).toMatchObject({ gate: "refused", reason: "dod-unavailable" });
		}
	});
});

describe("timeout settles by reading Linear state", () => {
	function timeoutFetch(): typeof fetch {
		return (async () => {
			const error = new Error("The operation timed out");
			error.name = "TimeoutError";
			throw error;
		}) as unknown as typeof fetch;
	}

	test("Linear Done after a timeout approves without trusting the missing reply", async () => {
		const { calls, mirror } = fakeMirrorGate(
			[
				{ name: "In Review", type: "started" },
				{ name: "Done", type: "completed" },
			],
			false,
		);

		const result = await runDodGate(deps(mirror, timeoutFetch()), ctx(), DOD);

		expect(result).toEqual({ gate: "approved", alreadyDone: true, mirrorFailures: [] });
		expect(calls.filter((c) => c === "linearState").length).toBeGreaterThanOrEqual(2);
	});

	test("Linear still open after a timeout refuses with dod-unavailable", async () => {
		const { mirror } = fakeMirrorGate([{ name: "In Review", type: "started" }, { name: "In Review", type: "started" }], false);

		const result = await runDodGate(deps(mirror, timeoutFetch(), { timeoutMs: 50 }), ctx(), DOD);

		expect(result).toMatchObject({ gate: "refused", reason: "dod-unavailable" });
		if (result.gate === "refused") expect(result.detail).toContain("50ms");
	});
});

describe("unreadable Linear state refuses before any tracker write", () => {
	test("a failed state read is dod-unavailable with no review mirror and no connector call", async () => {
		const calls: string[] = [];
		const mirror = {
			linearState: async () => {
				calls.push("linearState");
				throw new Error("linear 502: upstream");
			},
			review: async () => {
				calls.push("review");
				return [];
			},
		} as unknown as Mirror;
		const { calls: connectorCalls, fetchImpl } = fakeConnector(() => Response.json({ completed: true }));

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result).toEqual({
			gate: "refused",
			reason: "dod-unavailable",
			detail: expect.stringContaining("unreadable"),
			mirrorFailures: [],
		});
		expect(calls).toEqual(["linearState"]);
		expect(connectorCalls).toHaveLength(0);
	});
});

describe("already-Done skips review and the connector", () => {
	test("Linear completed at step 2 approves with no further tracker or connector calls", async () => {
		const { calls, mirror } = fakeMirrorGate([{ name: "Done", type: "completed" }], false);
		const { calls: connectorCalls, fetchImpl } = fakeConnector(() => Response.json({ completed: true }));

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result).toEqual({ gate: "approved", alreadyDone: true, mirrorFailures: [] });
		expect(calls).toEqual(["linearState"]);
		expect(connectorCalls).toHaveLength(0);
	});
});

describe("review failures warn and continue", () => {
	test("a review mirror failure rides along while the gate still approves", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], true);
		const { fetchImpl } = fakeConnector(() => Response.json({ completed: true }));

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result.gate).toBe("approved");
		if (result.gate === "approved") {
			expect(result.mirrorFailures).toEqual([
				{ target: "notion", op: "review", reason: "notion 502: upstream" },
			]);
		}
	});
});

describe("gate leak hygiene", () => {
	test("the planted lease id appears in no connector request", async () => {
		// The planted id is never placed in the MirrorContext by construction;
		// this proves none of it reaches the wire anyway.
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { calls, fetchImpl } = fakeConnector(() => Response.json({ completed: true }));

		await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(LEASE_ID).toContain("lease-");
		expect(JSON.stringify(calls)).not.toContain(LEASE_ID);
	});
});

describe("connector body failures refuse the gate", () => {
	test("headers followed by a broken body are dod-unavailable, never a throw", async () => {
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const { fetchImpl } = fakeConnector(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("socket hangup mid-body"));
						},
					}),
				),
		);

		const result = await runDodGate(deps(mirror, fetchImpl), ctx(), DOD);

		expect(result).toEqual({
			gate: "refused",
			reason: "dod-unavailable",
			detail: expect.stringContaining("body unreadable"),
			mirrorFailures: [],
		});
	});
});

describe("upstream error text is redacted before the cap", () => {
	test("connector bodies and reasons never forward credential-shaped text", async () => {
		const secret = `api_key: ${"k7".repeat(12)}`;
		const { mirror } = fakeMirrorGate([{ name: "Doing", type: "started" }], false);
		const refusedFetch = fakeConnector(() => Response.json({ completed: false, reason: `denied: ${secret}` }));
		const refused = await runDodGate(deps(mirror, refusedFetch.fetchImpl), ctx(), DOD);
		if (refused.gate !== "refused") throw new Error("expected a refusal");
		expect(refused.detail).not.toContain("k7".repeat(12));

		const errorFetch = fakeConnector(() => new Response(`boom ${secret}`, { status: 502 }));
		const errored = await runDodGate(deps(mirror, errorFetch.fetchImpl), ctx(), DOD);
		if (errored.gate !== "refused") throw new Error("expected a refusal");
		expect(errored.detail).toContain("502");
		expect(errored.detail).not.toContain("k7".repeat(12));
	});
});
