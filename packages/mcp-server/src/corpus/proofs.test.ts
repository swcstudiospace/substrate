/**
 * The corpus proof doors over the service layer: an ingest schedules the root event, the proof of a live row verifies against the
 * root the server reports, the gates refuse before anything is read, and `docs_search` carries the cached root only when the corpus
 * is on. A fake manifest, a fake bulk plane and a manual clock: no network, no database, no real delay.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, corpusLeafHex, shortRoot, type CorpusDocument } from "@substrate/corpus";
import { verifyMerkleProofAgainstCommitment } from "@substrate/ledger";
import type { AnchorVerifyPorts } from "../anchor-verify-deps.ts";
import { loadConfig, loadCorpusSettings } from "../config.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import type { EventInput } from "../types.ts";
import type { AnchorVerifier } from "./anchor.ts";
import { CorpusRootKeeper, corpusRoot, type RootClock } from "./root.ts";
import { corpusAnchorReply, corpusIngestReply, corpusProofReply, corpusRootReply, type CorpusServiceDeps } from "./service.ts";
import { FakePlane, FakeStore, makeDocument, makeRow } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";

class ManualClock implements RootClock {
	at = 5_000_000;
	readonly timers: Array<() => void> = [];
	now(): number {
		return this.at;
	}
	setTimer(run: () => void): void {
		this.timers.push(run);
	}
	fire(): void {
		defined(this.timers.shift(), "a scheduled timer")();
	}
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 40; turn++) await Promise.resolve();
}

const UNUSED_PORTS: AnchorVerifyPorts = {
	ledger: null,
	rowToEvent: () => {
		throw new Error("not used");
	},
	rpc: () => {
		throw new Error("not used");
	},
	solana: { pubkey: null, problem: null },
	operatorSurfaces: new Set<string>(),
	nowMs: () => 0,
};

function world(options: { enabled?: boolean; verify?: AnchorVerifier } = {}) {
	const store = new FakeStore();
	const plane = new FakePlane();
	const clock = new ManualClock();
	const rootEvents: EventInput[] = [];
	const otherEvents: EventInput[] = [];
	const roots = new CorpusRootKeeper({
		store: () => store,
		emit: async (event) => {
			rootEvents.push(event);
			return { stored: true };
		},
		clock,
	});
	const deps: CorpusServiceDeps = {
		settings: { ...loadCorpusSettings({}), enabled: options.enabled ?? true },
		vmGuest: false,
		store,
		plane,
		emit: async (event) => void otherEvents.push(event),
		roots,
		anchor: { ports: () => UNUSED_PORTS, verify: options.verify },
	};
	const ingest = (documents: CorpusDocument[], tombstones: Array<{ repo: string; path: string }> = []) => corpusIngestReply(deps, { protocol: CORPUS_PROTOCOL, documents, tombstones }, "claude-code", true);
	return { store, plane, clock, rootEvents, otherEvents, roots, deps, ingest };
}

const DOC_A = makeDocument(REPO, "docs/a.md", "# A\nfirst");
const DOC_B = makeDocument(REPO, "docs/b.md", "# B\nsecond");

describe("an ingest schedules the root event", () => {
	test("one event after the request answered, carrying the root of the manifest the request produced", async () => {
		const { clock, rootEvents, ingest, store } = world();
		const reply = await ingest([DOC_A, DOC_B]);
		expect(reply.ok).toBe(true);
		expect(rootEvents).toEqual([]);
		expect(clock.timers).toHaveLength(1);
		clock.fire();
		await flush();
		const expected = corpusRoot([DOC_A, DOC_B]);
		expect(rootEvents).toHaveLength(1);
		expect(defined(rootEvents[0]).payload).toEqual({ action: "docs.corpus.root", root: expected.root, count: 2, manifest_version: await store.manifestVersion() });
	});

	test("an ingest that changed nothing schedules nothing, and neither does one that only refused", async () => {
		const { clock, ingest } = world();
		await ingest([DOC_A]);
		clock.fire();
		await flush();
		await ingest([DOC_A]);
		const leaky = makeDocument(REPO, "docs/leaky.md", "paste sk-proj-abcdefghij1234567890 here");
		await ingest([leaky]);
		expect(clock.timers).toEqual([]);
	});

	test("a tombstone moves the root, and the event after it covers the remaining documents", async () => {
		const { clock, rootEvents, ingest } = world();
		await ingest([DOC_A, DOC_B]);
		clock.fire();
		await flush();
		clock.at += 10_000;
		await ingest([], [{ repo: REPO, path: "docs/b.md" }]);
		clock.fire();
		await flush();
		expect(rootEvents.map((event) => event.payload?.count)).toEqual([2, 1]);
		expect(defined(rootEvents[1]).payload?.root).toBe(corpusRoot([DOC_A]).root);
	});
});

describe("the root and proof doors", () => {
	test("the proof of a live row verifies against the root the server reports for the same manifest", async () => {
		const { ingest, deps } = world();
		await ingest([DOC_A, DOC_B, makeDocument(REPO, "docs/c.md", "# C")]);
		const rootReply = await corpusRootReply(deps, "claude-code");
		const proofReply = await corpusProofReply(deps, { repo: REPO, path: "docs/b.md" }, "claude-code");
		if (!rootReply.ok || !proofReply.ok) throw new Error("both doors should answer");
		expect(rootReply.body).toMatchObject({ protocol: CORPUS_PROTOCOL, count: 3, skipped: 0 });
		const proof = proofReply.body;
		expect(proof).toMatchObject({ protocol: CORPUS_PROTOCOL, repo: REPO, documentPath: "docs/b.md", sha256: DOC_B.sha256, root: rootReply.body.root, manifestVersion: rootReply.body.manifestVersion, treeSize: 3 });
		expect(proof.leaf).toBe(corpusLeafHex(REPO, "docs/b.md", DOC_B.sha256));
		expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: proof.root, count: 3 })).toBe(true);
	});

	test("a missing document and a tombstoned one are 404 not-in-corpus; a malformed name is 400", async () => {
		const { store, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/live.md" }));
		store.seed(makeRow({ repo: REPO, path: "docs/gone.md", state: "tombstoned" }));
		for (const path of ["docs/missing.md", "docs/gone.md"]) {
			const reply = await corpusProofReply(deps, { repo: REPO, path }, "claude-code");
			expect(reply).toMatchObject({ ok: false, status: 404, body: { reason: "not-in-corpus" } });
		}
		expect(await corpusProofReply(deps, { repo: "not a repo", path: "docs/live.md" }, "claude-code")).toMatchObject({ status: 400, body: { reason: "bad-repo" } });
		expect(await corpusProofReply(deps, { repo: REPO, path: "../etc/passwd" }, "claude-code")).toMatchObject({ status: 400, body: { reason: "bad-path" } });
		expect(await corpusProofReply(deps, { repo: null, path: null }, "claude-code")).toMatchObject({ status: 400, body: { reason: "bad-repo" } });
	});

	test("every door answers 401 to an anonymous caller and 503 corpus.disabled while the flag is off, before anything is read", async () => {
		const open = world();
		const closed = world({ enabled: false });
		closed.store.seed(makeRow({ repo: REPO, path: "docs/live.md" }));
		const doors = (deps: CorpusServiceDeps, surface: "claude-code" | null) => [
			corpusRootReply(deps, surface),
			corpusProofReply(deps, { repo: REPO, path: "docs/live.md" }, surface),
			corpusAnchorReply(deps, "0".repeat(64), surface),
		];
		const anonymous = await Promise.all(doors(open.deps, null));
		expect(anonymous.map((reply) => reply.ok === false && [reply.status, reply.body.reason])).toEqual([
			[401, "unauthenticated"],
			[401, "unauthenticated"],
			[401, "unauthenticated"],
		]);
		const off = await Promise.all(doors(closed.deps, "claude-code"));
		expect(off.map((reply) => reply.ok === false && [reply.status, reply.body.reason])).toEqual([
			[503, "corpus.disabled"],
			[503, "corpus.disabled"],
			[503, "corpus.disabled"],
		]);
		expect(closed.store.leafReads).toBe(0);
	});

	test("the anchor door refuses a root that is not 64 lowercase hex and passes a good one to the verifier's lookup", async () => {
		const { deps } = world();
		for (const root of [null, "abc", "G".repeat(64), "A".repeat(64)]) {
			expect(await corpusAnchorReply(deps, root, "claude-code")).toMatchObject({ ok: false, status: 400, body: { reason: "bad-root" } });
		}
		const answer = await corpusAnchorReply(deps, "0".repeat(64), "claude-code");
		// No ledger on this fake: the answer is a status, never an error.
		expect(answer).toMatchObject({ ok: true, status: 200, body: { status: "unverified", root: "0".repeat(64) } });
	});
});

describe("docs_search names the corpus root it was answered under", () => {
	function substrateOf(corpus: "on" | "off", store: FakeStore, clock: ManualClock): Substrate {
		return new Substrate(loadConfig(corpus === "on" ? { SUBSTRATE_CORPUS: "on" } : {}), { index: null, greptime: null, corpus: { store, plane: new FakePlane(), rootClock: clock } });
	}

	test("with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two", async () => {
		const store = new FakeStore();
		for (const doc of [DOC_A, DOC_B]) store.seed(makeRow({ repo: doc.repo, path: doc.path, sha256: doc.sha256 }));
		const clock = new ManualClock();
		const off = await substrateOf("off", store, clock).searchDocs({ question: "" }, "omp");
		expect("corpus_root" in off || "corpus_count" in off).toBe(false);
		expect(store.leafReads).toBe(0);

		const on = substrateOf("on", store, clock);
		const cold = await on.searchDocs({ question: "" }, "omp");
		// The first reply names the root it read: nothing was cached, and the reply waits for that read.
		const { corpus_root: coldRoot, corpus_count: coldCount, ...coldRest } = cold;
		expect(JSON.stringify(coldRest)).toBe(JSON.stringify(off));
		expect(coldRoot).toBe(shortRoot(corpusRoot([DOC_A, DOC_B]).root));
		expect(coldCount).toBe(2);
		await flush();
		const warm = await on.searchDocs({ question: "" }, "omp");
		const { corpus_root: root, corpus_count: count, ...rest } = warm;
		expect(JSON.stringify(rest)).toBe(JSON.stringify(off));
		expect(root).toBe(shortRoot(corpusRoot([DOC_A, DOC_B]).root));
		expect(count).toBe(2);
		// A further search reads nothing: the root comes from the cache.
		const reads = store.leafReads;
		await on.searchDocs({ question: "" }, "omp");
		expect(store.leafReads).toBe(reads);
	});

	test("a request that moved the manifest drops the cached root, so a reply never names a stale one", async () => {
		const store = new FakeStore();
		store.seed(makeRow({ repo: DOC_A.repo, path: DOC_A.path, sha256: DOC_A.sha256 }));
		const clock = new ManualClock();
		const on = substrateOf("on", store, clock);
		await on.searchDocs({ question: "" }, "omp");
		await flush();
		expect(await on.searchDocs({ question: "" }, "omp")).toMatchObject({ corpus_count: 1 });
		const ingested = await on.corpusIngest({ protocol: CORPUS_PROTOCOL, documents: [DOC_B], tombstones: [] }, "omp", true);
		expect(ingested.ok).toBe(true);
		const during = await on.searchDocs({ question: "" }, "omp");
		expect(during).toMatchObject({ corpus_count: 2, corpus_root: shortRoot(corpusRoot([DOC_A, DOC_B]).root) });
		await flush();
		expect(await on.searchDocs({ question: "" }, "omp")).toMatchObject({ corpus_count: 2, corpus_root: shortRoot(corpusRoot([DOC_A, DOC_B]).root) });
	});
});
