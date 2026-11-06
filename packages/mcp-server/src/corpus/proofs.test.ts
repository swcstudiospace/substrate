/**
 * The corpus proof doors over the service layer: an ingest schedules the root event, the proof of a live row verifies against the
 * root the server reports, the gates refuse before anything is read, and `docs_search` carries the cached root only when the corpus
 * is on. A fake manifest, a fake bulk plane and a manual clock: no network, no database, no real delay.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { CORPUS_PROTOCOL, corpusLeafHex, shortRoot, type CorpusDocument } from "@substrate/corpus";
import { verifyMerkleProofAgainstCommitment } from "@substrate/ledger";
import type { AnchorVerifyPorts } from "../anchor-verify-deps.ts";
import { loadConfig, loadCorpusSettings } from "../config.ts";
import { normalizeEvent } from "../event.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import type { EventInput } from "../types.ts";
import type { AnchorVerifier } from "./anchor.ts";
import { CORPUS_ROOT_ACTION, CorpusRootKeeper, corpusRoot, type RootClock } from "./root.ts";
import { corpusAnchorReply, corpusIngestReply, corpusProofReply, corpusRootReply, type CorpusServiceDeps } from "./service.ts";
import { FakePlane, FakeStore, makeDocument, makeRow } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";

interface ArmedTimer {
	run: () => void;
	due: number;
}

class ManualClock implements RootClock {
	at = 5_000_000;
	/** The timers armed and not yet run, in the order they were set. A cancelled one still runs and does nothing. */
	readonly timers: ArmedTimer[] = [];
	now(): number {
		return this.at;
	}
	setTimer(run: () => void, ms: number): void {
		this.timers.push({ run, due: this.at + ms });
	}
	fire(): void {
		defined(this.timers.shift(), "a scheduled timer").run();
	}
	/** Runs every timer due by `untilMs`, earliest first, moving the clock to each one's due time; then the clock stands at `untilMs`. */
	async runUntil(untilMs: number): Promise<void> {
		for (let next = this.nextDue(untilMs); next !== null; next = this.nextDue(untilMs)) {
			this.timers.splice(this.timers.indexOf(next), 1);
			this.at = Math.max(this.at, next.due);
			next.run();
			await flush();
		}
		this.at = Math.max(this.at, untilMs);
	}
	private nextDue(untilMs: number): ArmedTimer | null {
		let best: ArmedTimer | null = null;
		for (const timer of this.timers) if (timer.due <= untilMs && (best === null || timer.due < best.due)) best = timer;
		return best;
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
	listGraphPointers: () => {
		throw new Error("not used");
	},
	confirmPointer: () => {
		throw new Error("not used");
	},
};

type RootOutcome = "stored" | "refused" | "throw" | "buffered";

function world(options: { enabled?: boolean; verify?: AnchorVerifier; rootOutcome?: (attempt: number) => RootOutcome } = {}) {
	const store = new FakeStore();
	const plane = new FakePlane();
	const clock = new ManualClock();
	const rootEvents: EventInput[] = [];
	/** The clock time of each root write attempt, and the root events the ledger took. */
	const attemptTimes: number[] = [];
	const landed: EventInput[] = [];
	/** Root events the ledger buffered: the buffer lands them later, when it writes them. */
	const buffer: EventInput[] = [];
	const logged: string[] = [];
	const otherEvents: EventInput[] = [];
	const outcome: (attempt: number) => RootOutcome = options.rootOutcome ?? (() => "stored");
	const roots = new CorpusRootKeeper({
		store: () => store,
		emit: async (event) => {
			rootEvents.push(event);
			attemptTimes.push(clock.at);
			const result = outcome(rootEvents.length);
			if (result === "throw") throw new Error("ledger down: password=hunter2");
			if (result === "refused") return { stored: false };
			if (result === "buffered") {
				buffer.push(event);
				return { stored: false, buffered: true };
			}
			landed.push(event);
			return { stored: true };
		},
		clock,
		log: (line) => void logged.push(line),
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
	const ingest = (documents: CorpusDocument[], tombstones: Array<{ repo: string; path: string }> = []) =>
		corpusIngestReply(deps, { protocol: CORPUS_PROTOCOL, documents, tombstones, ...(tombstones.length > 0 ? { scope: { coverage: [{ repo: REPO, source: "fs" as const }], maxTier: 3 as const } } : {}) }, "claude-code");
	return { store, plane, clock, rootEvents, otherEvents, roots, deps, ingest, attemptTimes, landed, buffer, logged };
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

/** A service with the corpus on or off, over the fake manifest and the manual clock. */
function substrateOf(corpus: "on" | "off", store: FakeStore, clock: ManualClock): Substrate {
	return new Substrate(loadConfig(corpus === "on" ? { SUBSTRATE_CORPUS: "on" } : {}), { index: null, greptime: null, corpus: { store, plane: new FakePlane(), rootClock: clock } });
}

describe("docs_search names the corpus root it was answered under", () => {
	test("with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two", async () => {
		const store = new FakeStore();
		for (const doc of [DOC_A, DOC_B]) store.seed(makeRow({ repo: doc.repo, path: doc.path, sha256: doc.sha256 }));
		const clock = new ManualClock();
		const off = await substrateOf("off", store, clock).searchDocs({ question: "" }, "omp");
		expect("corpus_root" in off || "corpus_count" in off).toBe(false);
		expect(store.leafReads).toBe(0);

		const on = substrateOf("on", store, clock);
		const cold = await on.searchDocs({ question: "" }, "omp");
		// Nothing is cached yet: the search did not wait for a root, so the fields are left out.
		expect(JSON.stringify(cold)).toBe(JSON.stringify(off));
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
		const ingested = await on.corpusIngest({ protocol: CORPUS_PROTOCOL, documents: [DOC_B], tombstones: [] }, "omp");
		expect(ingested.ok).toBe(true);
		const during = await on.searchDocs({ question: "" }, "omp");
		expect("corpus_root" in during).toBe(false);
		await flush();
		expect(await on.searchDocs({ question: "" }, "omp")).toMatchObject({ corpus_count: 2, corpus_root: shortRoot(corpusRoot([DOC_A, DOC_B]).root) });
	});
});

describe("shutdown writes the root event still owed (v1.7 phase 69)", () => {
	test("drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more", async () => {
		const store = new FakeStore();
		const clock = new ManualClock();
		const on = substrateOf("on", store, clock);
		const written: EventInput[] = [];
		spyOn(on, "emit").mockImplementation(async (event) => {
			written.push(event);
			return { event: normalizeEvent(event, null), stored: true };
		});
		const rootEvents = () => written.filter((event) => event.payload?.action === CORPUS_ROOT_ACTION);
		const reply = await on.corpusIngest({ protocol: CORPUS_PROTOCOL, documents: [DOC_A, DOC_B], tombstones: [] }, "omp");
		expect(reply.ok).toBe(true);
		// The change is owed inside the five-second window: its timer is armed and has not fired.
		expect(clock.timers).toHaveLength(1);
		expect(rootEvents()).toEqual([]);

		await on.drainCorpusRoots(1_000);
		expect(rootEvents()).toHaveLength(1);
		expect(defined(rootEvents()[0], "the root event").payload).toEqual({ action: CORPUS_ROOT_ACTION, root: corpusRoot([DOC_A, DOC_B]).root, count: 2, manifest_version: await store.manifestVersion() });

		// The timer the drain left behind runs later and writes nothing; a second drain has nothing owed and writes nothing.
		clock.fire();
		await flush();
		expect(rootEvents()).toHaveLength(1);
		await on.drainCorpusRoots(1_000);
		expect(rootEvents()).toHaveLength(1);
	});
});

describe("a root the ledger refused is retried with backoff (v1.7 phase 69, PROOF-02)", () => {
	test("a root write that fails once is retried five seconds later, and lands exactly once", async () => {
		const { clock, attemptTimes, landed, ingest } = world({ rootOutcome: (attempt) => (attempt === 1 ? "refused" : "stored") });
		const start = clock.at;
		await ingest([DOC_A, DOC_B]);
		await clock.runUntil(start + 120_000);
		expect(attemptTimes.map((at) => at - start)).toEqual([0, 5_000]);
		expect(landed).toHaveLength(1);
		expect(defined(landed[0]).payload).toMatchObject({ action: CORPUS_ROOT_ACTION, root: corpusRoot([DOC_A, DOC_B]).root, count: 2 });
	});

	test("a root write that keeps failing does not spin: in 120 s it is tried once and retried four times, and none lands", async () => {
		const { clock, attemptTimes, landed, ingest } = world({ rootOutcome: () => "refused" });
		const start = clock.at;
		await ingest([DOC_A, DOC_B]);
		await clock.runUntil(start + 120_000);
		// The waits after refusals one to four are 5, 10, 20 and 40 s, so the attempts fall at 0, 5, 15, 35 and 75 s. The next wait is capped at 60 s, so it is due at 135 s, after the window.
		expect(attemptTimes.map((at) => at - start)).toEqual([0, 5_000, 15_000, 35_000, 75_000]);
		expect(landed).toEqual([]);
	});

	test("after a stored write that followed refusals, a change waits the five-second window, and a refusal after it backs off from five seconds again", async () => {
		const { clock, attemptTimes, landed, ingest } = world({ rootOutcome: (attempt) => (attempt === 1 || attempt === 2 || attempt === 4 ? "refused" : "stored") });
		const start = clock.at;
		await ingest([DOC_A, DOC_B]);
		await clock.runUntil(start + 15_000);
		expect(attemptTimes.map((at) => at - start)).toEqual([0, 5_000, 15_000]);
		expect(landed).toHaveLength(1);
		// The two refusals had built a backoff of 10 s; the stored write cleared it, so a change now waits only the window.
		await ingest([makeDocument(REPO, "docs/c.md", "# C")]);
		expect(defined(clock.timers[clock.timers.length - 1]).due - clock.at).toBe(5_000);
		await clock.runUntil(start + 30_000);
		// The refusal at 20 s backs off from five seconds (retry at 25 s), not from the 10 s it would be after two refusals.
		expect(attemptTimes.map((at) => at - start)).toEqual([0, 5_000, 15_000, 20_000, 25_000]);
		expect(landed.map((event) => event.payload?.count)).toEqual([2, 3]);
	});

	test("each distinct failure code is reported to stderr once, with the repository count and the code, and never the thrown message", async () => {
		const { clock, logged, ingest } = world({ rootOutcome: (attempt) => (attempt === 1 ? "refused" : "throw") });
		const start = clock.at;
		await ingest([DOC_A, DOC_B]);
		await clock.runUntil(start + 40_000);
		// Attempts at 0 s (refused), 5 s, 15 s and 35 s (thrown): two distinct codes, so two lines.
		expect(logged).toHaveLength(2);
		expect(logged[0]).toContain("code=not-stored");
		expect(logged[1]).toContain("code=threw");
		for (const line of logged) {
			expect(line).toContain("repositories=1");
			expect(line).not.toContain("hunter2");
			expect(line).not.toContain("docs/");
		}
	});

	test("a root the server buffered is not written again, so the ledger holds one root", async () => {
		const { clock, rootEvents, attemptTimes, buffer, landed, ingest } = world({ rootOutcome: () => "buffered" });
		const start = clock.at;
		await ingest([DOC_A, DOC_B]);
		await clock.runUntil(start + 120_000);
		// The server took the first copy: it is attempted once, and no retry is armed for it.
		expect(attemptTimes.map((at) => at - start)).toEqual([0]);
		expect(clock.timers).toEqual([]);
		// The buffer lands that copy later. The ledger holds one root: no second root event is emitted and no retry is armed.
		landed.push(...buffer.splice(0));
		await clock.runUntil(start + 240_000);
		expect(rootEvents).toHaveLength(1);
		expect(clock.timers).toEqual([]);
		expect(landed).toHaveLength(1);
		expect(defined(landed[0]).payload).toMatchObject({ action: CORPUS_ROOT_ACTION, root: corpusRoot([DOC_A, DOC_B]).root, count: 2 });
	});
});
