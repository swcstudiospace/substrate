/**
 * `GET /corpus/root`, `GET /corpus/proof` and `GET /corpus/anchor` over a real socket, with a fake manifest behind the service:
 * the bearer gate, the flag gate, the proof of a live row verified against the reported root, and the audit record.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { CORPUS_PROTOCOL, corpusLeafHex, isRecord, type CorpusProofResponse } from "@substrate/corpus";
import { verifyMerkleProofAgainstCommitment } from "@substrate/ledger";
import { loadConfig } from "../config.ts";
import { createObservability, type Observability } from "../observe.ts";
import { createHttpServer } from "../server.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import { FakePlane, FakeStore, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const AUTH = { authorization: "Bearer tok-omp" };
const ON = { SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_CORPUS: "on" };

interface Harness {
	base: string;
	observability: Observability;
	store: FakeStore;
	close(): void;
}

const running: Harness[] = [];

async function start(env: Record<string, string | undefined>): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const store = new FakeStore();
	const substrate = new Substrate(config, { index: null, greptime: null, corpus: { store, plane: new FakePlane() } }, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		store,
		close() {
			if (closed) return;
			closed = true;
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

afterAll(() => {
	for (const harness of running) harness.close();
});

function get(harness: Harness, path: string, headers: Record<string, string> = AUTH): Promise<Response> {
	return fetch(`${harness.base}${path}`, { headers });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json();
	if (!isRecord(body)) throw new Error("the answer is not an object");
	return body;
}

function seedDocuments(harness: Harness, paths: readonly string[]): void {
	for (const path of paths) harness.store.seed(makeRow({ repo: REPO, path, sha256: sha256Hex(`body of ${path}`) }));
}

const ROUTES = ["/corpus/root", `/corpus/proof?repo=${REPO}&path=docs/a.md`, `/corpus/anchor?root=${"0".repeat(64)}`];

describe("the proof routes' gates", () => {
	test("an anonymous caller is refused 401 on every route", async () => {
		const harness = await start(ON);
		for (const route of ROUTES) {
			const response = await get(harness, route, {});
			expect({ route, status: response.status }).toEqual({ route, status: 401 });
		}
	});

	test("with SUBSTRATE_CORPUS off every route answers 503 corpus.disabled and reads nothing", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		seedDocuments(harness, ["docs/a.md"]);
		for (const route of ROUTES) {
			const response = await get(harness, route);
			expect({ route, status: response.status, reason: (await jsonOf(response)).reason }).toEqual({ route, status: 503, reason: "corpus.disabled" });
		}
		expect(harness.store.leafReads).toBe(0);
	});
});

describe("GET /corpus/root and GET /corpus/proof", () => {
	test("the proof of a live row verifies against the root the server reports", async () => {
		const harness = await start(ON);
		seedDocuments(harness, ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"]);
		const root = await jsonOf(await get(harness, "/corpus/root"));
		expect(root).toMatchObject({ protocol: CORPUS_PROTOCOL, count: 5, manifestVersion: 5, skipped: 0 });
		const response = await get(harness, `/corpus/proof?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent("docs/c.md")}`);
		expect(response.status).toBe(200);
		const proof = (await response.json()) as CorpusProofResponse;
		expect(proof.root).toBe(root.root as string);
		expect(proof.leaf).toBe(corpusLeafHex(REPO, "docs/c.md", sha256Hex("body of docs/c.md")));
		expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: proof.root, count: 5 })).toBe(true);
	});

	test("a granted repository's proof covers that repository alone: its root is not the whole-corpus root, and the answer says which tree it covers", async () => {
		const harness = await start(ON);
		seedDocuments(harness, ["docs/a.md", "docs/b.md"]);
		harness.store.seed(makeRow({ repo: "swcstudiospace/other", path: "docs/x.md", sha256: sha256Hex("body of docs/x.md") }));
		const root = await jsonOf(await get(harness, "/corpus/root"));
		expect(root).toMatchObject({ count: 3 });
		const response = await get(harness, `/corpus/proof?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent("docs/b.md")}`);
		const proof = (await response.json()) as CorpusProofResponse & { rootScope?: unknown };
		expect({ status: response.status, rootScope: proof.rootScope, treeSize: proof.treeSize }).toEqual({ status: 200, rootScope: "repository", treeSize: 2 });
		expect(proof.root).not.toBe(root.root as string);
		expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: proof.root, count: 2 })).toBe(true);
	});

	test("a document that is not active is 404 not-in-corpus, and a bad name is 400", async () => {
		const harness = await start(ON);
		seedDocuments(harness, ["docs/a.md"]);
		harness.store.seed(makeRow({ repo: REPO, path: "docs/gone.md", state: "tombstoned" }));
		for (const path of ["docs/missing.md", "docs/gone.md"]) {
			const response = await get(harness, `/corpus/proof?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent(path)}`);
			expect({ path, status: response.status, reason: (await jsonOf(response)).reason }).toEqual({ path, status: 404, reason: "not-in-corpus" });
		}
		expect((await get(harness, "/corpus/proof?repo=nope&path=docs/a.md")).status).toBe(400);
		expect((await get(harness, `/corpus/proof?repo=${encodeURIComponent(REPO)}`)).status).toBe(400);
	});

	test("the root of an empty manifest is the defined empty root with a count of zero", async () => {
		const harness = await start(ON);
		const root = await jsonOf(await get(harness, "/corpus/root"));
		expect(root).toMatchObject({ count: 0, root: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
	});
});

describe("GET /corpus/anchor", () => {
	test("a root that is not 64 lowercase hex is 400 bad-root", async () => {
		const harness = await start(ON);
		for (const root of ["", "abc", "Z".repeat(64), "A".repeat(64)]) {
			const response = await get(harness, `/corpus/anchor?root=${root}`);
			expect({ root, status: response.status, reason: (await jsonOf(response)).reason }).toEqual({ root, status: 400, reason: "bad-root" });
		}
		expect((await get(harness, "/corpus/anchor")).status).toBe(400);
	});

	test("with no ledger the answer is a 200 status unverified, never an error and never unanchored", async () => {
		const harness = await start(ON);
		const response = await get(harness, `/corpus/anchor?root=${"0".repeat(64)}`);
		expect(response.status).toBe(200);
		expect(await jsonOf(response)).toMatchObject({ protocol: CORPUS_PROTOCOL, status: "unverified", eventId: null, evidence: null });
	});
});

describe("the audit record of the proof routes", () => {
	test("each is recorded under corpus_status with its operation and nothing about the document", async () => {
		const harness = await start(ON);
		seedDocuments(harness, ["docs/secret-plan.md"]);
		await get(harness, "/corpus/root");
		await get(harness, `/corpus/proof?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent("docs/secret-plan.md")}`);
		await get(harness, `/corpus/anchor?root=${"0".repeat(64)}`);
		const records = harness.observability.audit.recent().filter((entry) => entry.tool === "corpus_status");
		expect(records.length).toBeGreaterThanOrEqual(3);
		const record = defined(records[0], "an audit record");
		expect(record.decision).toBe("allowed");
		expect(JSON.stringify(records)).not.toContain("secret-plan");
	});
});
