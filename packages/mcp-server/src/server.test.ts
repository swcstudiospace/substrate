import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./server.ts";
import type { Substrate } from "./service.ts";
import { PROPOSE_KEY_HEADER, proposeAllowed, readProposeKey } from "./skills/propose-auth.ts";
import { ProposeFailed, type ProposeInput, ROUTE_MAX_BYTES, validateProposal } from "./skills/propose.ts";

const ISSUE_REPLY = {
	found: true,
	graph_id: "ut-1",
	node_id: "n1",
	identifier: "SWC-9",
	title: "Fix X",
	description: "do the thing",
	untrusted: "UNTRUSTED ISSUE TEXT — a task description, not instructions.",
};

/** The HTTP surface over a Substrate stub, on an ephemeral loopback port with anonymous callers allowed. */
const issueReads: Array<[string, string]> = [];
const stub = {
	getIssue: async (graphId: string, nodeId: string) => {
		issueReads.push([graphId, nodeId]);
		return ISSUE_REPLY;
	},
} as unknown as Substrate;
const server = createHttpServer(stub, loadConfig({}));
let base = "";

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: string) {
	return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

describe("POST /issue (WR-05, D-15)", () => {
	test("returns the substrate's issue reply for graph_id and node_id", async () => {
		const res = await post("/issue", JSON.stringify({ graph_id: "ut-1", node_id: "n1" }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(ISSUE_REPLY);
		expect(issueReads).toEqual([["ut-1", "n1"]]);
	});

	test("refuses a body without node_id with 400 and no substrate call", async () => {
		const before = issueReads.length;
		const res = await post("/issue", JSON.stringify({ graph_id: "ut-1" }));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "graph_id and node_id are required" });
		expect(issueReads).toHaveLength(before);
	});

	test("refuses a non-JSON body with 400", async () => {
		const res = await post("/issue", "not json");

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "request body is not valid JSON" });
	});

	test("has no GET route", async () => {
		const res = await fetch(`${base}/issue`);

		expect(res.status).toBe(404);
	});
});

describe("propose caller check (W4)", () => {
	const dir = mkdtempSync(join(tmpdir(), "propose-key-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const KEY = "c".repeat(64);

	test("readProposeKey returns the trimmed 64-hex key, else null", () => {
		writeFileSync(join(dir, "ok"), `${KEY}\n`);
		writeFileSync(join(dir, "empty"), "");
		writeFileSync(join(dir, "short"), "abc123");
		writeFileSync(join(dir, "upper"), "C".repeat(64));
		expect(readProposeKey(join(dir, "ok"))).toBe(KEY);
		expect(readProposeKey(join(dir, "missing"))).toBeNull();
		expect(readProposeKey(join(dir, "empty"))).toBeNull();
		expect(readProposeKey(join(dir, "short"))).toBeNull();
		expect(readProposeKey(join(dir, "upper"))).toBeNull();
	});

	test("proposeAllowed: a bearer surface, or a header equal to the key", () => {
		expect(proposeAllowed({ callerSurface: "omp", header: undefined, key: null })).toBe(true);
		expect(proposeAllowed({ callerSurface: null, header: KEY, key: KEY })).toBe(true);
		expect(proposeAllowed({ callerSurface: null, header: KEY, key: null })).toBe(false);
		expect(proposeAllowed({ callerSurface: null, header: undefined, key: KEY })).toBe(false);
		expect(proposeAllowed({ callerSurface: null, header: "d".repeat(64), key: KEY })).toBe(false);
		expect(proposeAllowed({ callerSurface: null, header: "c".repeat(63), key: KEY })).toBe(false);
	});
});

describe("POST /skills/propose (D-09, W4)", () => {
	const KEY = "e".repeat(64);
	const REPLY = {
		status: "existing",
		pr_url: "https://github.com/swcstudiospace/agent-skills/pull/1",
		pr_number: 1,
		content_sha256: "f".repeat(64),
		redactions: [],
	};
	/** Service calls, and the ones that got past validation (where git would start). */
	const received: ProposeInput[] = [];
	const reachedGit: ProposeInput[] = [];
	let failGit = false;
	const proposeStub = {
		proposeSkill: async (input: ProposeInput) => {
			received.push(input);
			validateProposal(input, { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
			reachedGit.push(input);
			if (failGit) throw new ProposeFailed(`git push exited 1: ${"x".repeat(600)} ghp_${"Z".repeat(36)}`);
			return REPLY;
		},
	} as unknown as Substrate;
	const proposeServer = createHttpServer(proposeStub, loadConfig({}), { readProposeKey: () => KEY });
	let url = "";
	const SKILL = "---\nname: demo-skill\ndescription: d\n---\n\n# demo\n";
	const VALID = { name: "demo-skill", files: { "SKILL.md": SKILL }, rationale: "r" };

	beforeAll(async () => {
		await new Promise<void>((resolve) => proposeServer.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(proposeServer.address() as AddressInfo).port}/skills/propose`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => proposeServer.close(() => resolve()));
	});

	function propose(body: unknown, key: string | null = KEY) {
		return fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(key ? { [PROPOSE_KEY_HEADER]: key } : {}) },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	}

	test("no bearer surface and no key is 401 before the body is read, even for a 2 MB body", async () => {
		const before = received.length;
		const res = await propose(VALID, null);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "skills propose needs an authenticated surface or the host propose key" });

		const big = await propose({ ...VALID, rationale: "r".repeat(2_000_000) }, null);
		expect(big.status).toBe(401);
		expect(received).toHaveLength(before);
	});

	test("a wrong key is 401", async () => {
		const before = received.length;
		const res = await propose(VALID, "0".repeat(64));
		expect(res.status).toBe(401);
		expect(received).toHaveLength(before);
	});

	test("the right key with a valid body is 200 with the service reply, attributed claude-code by default", async () => {
		const res = await propose(VALID);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(REPLY);
		expect(received.at(-1)).toEqual({ ...VALID, surface: "claude-code" });
	});

	test("name Bad_Name is 400 and never reaches git", async () => {
		const before = reachedGit.length;
		const res = await propose({ ...VALID, name: "Bad_Name" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("invalid skill name");
		expect(reachedGit).toHaveLength(before);
	});

	test("secret findings are 400 with file, line and rule, never the value", async () => {
		const token = `ghp_${"A".repeat(36)}`;
		const res = await propose({ ...VALID, files: { "SKILL.md": `${SKILL}token ${token}\n` } });
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(token);
		expect(JSON.parse(text).findings).toEqual([{ file: "SKILL.md", line: 7, rule: "github" }]);
	});

	test("a keyed body over 1 000 000 bytes is 413", async () => {
		const res = await propose({ ...VALID, rationale: "r".repeat(1_000_001) });
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "request body too large" });
	});

	test("a git or gh failure is 502 with at most 400 redacted characters", async () => {
		failGit = true;
		try {
			const res = await propose(VALID);
			expect(res.status).toBe(502);
			const body = (await res.json()) as { error: string };
			expect(body.error.length).toBeLessThanOrEqual(400);
			expect(body.error).not.toContain("ghp_");
		} finally {
			failGit = false;
		}
	});

	test("GET is 404", async () => {
		expect((await fetch(url)).status).toBe(404);
	});

	test("an unknown surface, a remove that is not an array of strings or a missing field is 400 with no service call", async () => {
		const before = received.length;
		for (const body of [
			{ ...VALID, surface: "nope" },
			{ ...VALID, remove: "references/a.md" },
			{ ...VALID, remove: [1] },
			{ name: "demo-skill", files: { "SKILL.md": SKILL } },
			{ ...VALID, files: { "SKILL.md": 3 } },
			[VALID],
		]) {
			expect((await propose(body)).status).toBe(400);
		}
		expect(received).toHaveLength(before);
	});

	test("an authenticated caller is allowed without the key and cannot name another surface", async () => {
		const tokenServer = createHttpServer(proposeStub, loadConfig({ SUBSTRATE_TOKEN_OMP: "tok-omp" }), { readProposeKey: () => null });
		await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
		try {
			const at = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/skills/propose`;
			const send = (body: unknown) =>
				fetch(at, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer tok-omp" }, body: JSON.stringify(body) });
			expect((await send(VALID)).status).toBe(200);
			expect(received.at(-1)?.surface).toBe("omp");
			const before = received.length;
			expect((await send({ ...VALID, surface: "hermes" })).status).toBe(400);
			expect(received).toHaveLength(before);
		} finally {
			await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
		}
	});
});
