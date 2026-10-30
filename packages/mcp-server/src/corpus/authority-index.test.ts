/**
 * The authority index: built once per manifest version, rebuilt only when the version moves, fail-open, and bounded in how
 * long a search waits for it.
 */
import { describe, expect, test } from "bun:test";
import { documentKey } from "@substrate/corpus";
import { defined } from "../test-support.ts";
import { AuthorityIndex, FEEDBACK_TTL_MS, VERSION_CHECK_MS, snapshotOf } from "./authority-index.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import type { ActiveRows, ManifestRow } from "./store.ts";
import { FakeStore, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const FRESH = new Date(NOW).toISOString();
const THREE_YEARS_OLD = new Date(NOW - 3 * 365 * 86_400_000).toISOString();

/** A manifest that counts what it is asked and can fail or stall on demand. */
class CountingStore extends FakeStore {
	versionReads = 0;
	rowReads = 0;
	failVersion = false;
	hangVersion = false;
	/** The rows are read before this settles and returned after it: a read that began before a change and ends after it. */
	rowGate: Promise<void> | null = null;
	/** Answers as a manifest bigger than the read cap would: the rows read are flagged as not all of them. */
	forceTruncated = false;
	/** Called once the rows were read and before they are returned, so a test can change the manifest after the read. */
	onRowsRead: (() => void) | null = null;

	override async manifestVersion(): Promise<number> {
		this.versionReads += 1;
		if (this.hangVersion) return new Promise<number>(() => undefined);
		if (this.failVersion) throw new Error("connection lost");
		return super.manifestVersion();
	}

	override async activeRows(limit: number): Promise<ActiveRows> {
		this.rowReads += 1;
		const read = await super.activeRows(limit);
		this.onRowsRead?.();
		if (this.rowGate !== null) await this.rowGate;
		return { rows: read.rows, truncated: read.truncated || this.forceTruncated };
	}
}

function world(options: { reflect?: FakeReflectStore | null; budgetMs?: number } = {}) {
	const clock = { now: NOW };
	const store = new CountingStore();
	const reflect = options.reflect === undefined ? new FakeReflectStore(() => clock.now) : options.reflect;
	const index = new AuthorityIndex({ store: () => store, reflect: () => reflect, now: () => clock.now, ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }) });
	return { clock, store, reflect, index };
}

const seed = (store: FakeStore, path: string, over: Partial<ManifestRow> = {}): void =>
	store.seed(makeRow({ repo: REPO, path, sha256: sha256Hex(path), ingestedAt: FRESH, ...over }));

describe("AuthorityIndex lookup", () => {
	test("answers with authority, stale and the superseding key for an active document, and null for a document the manifest does not hold", async () => {
		const { store, index } = world();
		seed(store, "docs/old.md", { supersededBy: "docs/new.md" });
		seed(store, "docs/new.md");
		const lookup = defined(await index.lookup(), "the lookup");
		const old = defined(lookup(documentKey(REPO, "docs/old.md")), "the superseded document");
		const current = defined(lookup(documentKey(REPO, "docs/new.md")), "the current document");
		expect(old).toMatchObject({ stale: true, supersededBy: documentKey(REPO, "docs/new.md") });
		expect(current).toMatchObject({ stale: false, supersededBy: null });
		expect(old.authority).toBeLessThan(current.authority);
		expect(lookup(documentKey(REPO, "docs/never-ingested.md"))).toBeNull();
	});

	test("a tombstoned row is not a document the index knows", async () => {
		const { store, index } = world();
		seed(store, "docs/gone.md", { state: "tombstoned" });
		expect(defined(await index.lookup(), "the lookup")(documentKey(REPO, "docs/gone.md"))).toBeNull();
	});

	test("an older document scores lower than a fresh one of the same kind, and an unknown age is neither", async () => {
		const { store, index } = world();
		seed(store, "docs/fresh.md");
		seed(store, "docs/ancient.md", { ingestedAt: THREE_YEARS_OLD });
		seed(store, "docs/unknown-age.md", { ingestedAt: null });
		const lookup = defined(await index.lookup(), "the lookup");
		const score = (path: string): number => defined(lookup(documentKey(REPO, path)), path).authority;
		expect(score("docs/ancient.md")).toBeLessThan(score("docs/unknown-age.md"));
		expect(score("docs/unknown-age.md")).toBeLessThan(score("docs/fresh.md"));
	});

	test("a verdict count marks a document stale only once enough readers said so", async () => {
		const { store, reflect, index } = world();
		seed(store, "docs/doubted.md");
		const reflectStore = defined(reflect, "the reflect store");
		for (const session of ["a", "b", "c"]) await reflectStore.upsertFeedback({ documentKey: documentKey(REPO, "docs/doubted.md"), sessionId: session, verdict: "stale", surface: "omp" });
		const lookup = defined(await index.lookup(), "the lookup");
		expect(lookup(documentKey(REPO, "docs/doubted.md"))).toMatchObject({ stale: true, supersededBy: null });
	});
});

describe("AuthorityIndex caching", () => {
	test("the rows are read once per manifest version, however many lookups come, and the version once per check interval", async () => {
		const { store, clock, index } = world();
		seed(store, "docs/a.md");
		for (let i = 0; i < 5; i += 1) await index.lookup();
		expect({ versions: store.versionReads, rows: store.rowReads }).toEqual({ versions: 1, rows: 1 });

		clock.now += VERSION_CHECK_MS;
		await index.lookup();
		expect({ versions: store.versionReads, rows: store.rowReads }).toEqual({ versions: 2, rows: 1 });

		seed(store, "docs/b.md");
		clock.now += VERSION_CHECK_MS;
		const lookup = defined(await index.lookup(), "the lookup");
		expect({ versions: store.versionReads, rows: store.rowReads }).toEqual({ versions: 3, rows: 2 });
		expect(lookup(documentKey(REPO, "docs/b.md"))).not.toBeNull();
	});

	test("invalidate makes the next lookup read the manifest again", async () => {
		const { store, index } = world();
		seed(store, "docs/a.md");
		await index.lookup();
		index.invalidate();
		await index.lookup();
		expect(store.rowReads).toBe(2);
	});

	test("the feedback counts are one read per cache interval, and a stored verdict drops them", async () => {
		const { store, clock, reflect, index } = world();
		seed(store, "docs/a.md");
		const reflectStore = defined(reflect, "the reflect store");
		await index.lookup();
		await index.lookup();
		expect(reflectStore.feedbackCountReads).toBe(1);
		clock.now += FEEDBACK_TTL_MS;
		await index.lookup();
		expect(reflectStore.feedbackCountReads).toBe(2);
		index.invalidateFeedback();
		await index.lookup();
		expect(reflectStore.feedbackCountReads).toBe(3);
	});
});

describe("AuthorityIndex clears racing loads", () => {
	test("a manifest read that began before an invalidation and ends after it does not repopulate the cache, and the next lookup reads fresh", async () => {
		const { store, index } = world();
		seed(store, "docs/a.md");
		const gate = Promise.withResolvers<void>();
		const rowsRead = Promise.withResolvers<void>();
		store.rowGate = gate.promise;
		store.onRowsRead = rowsRead.resolve;
		// The load starts now and reads the manifest as it is: one document.
		const racing = index.lookup();
		await rowsRead.promise;
		store.onRowsRead = null;
		seed(store, "docs/b.md");
		index.invalidate();
		gate.resolve();
		await racing;

		const lookup = defined(await index.lookup(), "the lookup after the clear");
		expect(lookup(documentKey(REPO, "docs/b.md"))).not.toBeNull();
		expect(lookup(documentKey(REPO, "docs/a.md"))).not.toBeNull();
		// The old load was not joined: the second lookup ran its own read.
		expect(store.rowReads).toBe(2);
	});

	test("feedback counts read before a verdict was stored are not kept after the verdict dropped them", async () => {
		const { store, reflect, index } = world();
		seed(store, "docs/doubted.md");
		const reflectStore = defined(reflect, "the reflect store");
		const gate = Promise.withResolvers<void>();
		const counted = Promise.withResolvers<void>();
		const read = reflectStore.feedbackCounts.bind(reflectStore);
		reflectStore.feedbackCounts = async (maxKeys) => {
			const counts = await read(maxKeys);
			counted.resolve();
			await gate.promise;
			return counts;
		};
		const racing = index.lookup();
		await counted.promise;
		for (const session of ["a", "b", "c"]) await reflectStore.upsertFeedback({ documentKey: documentKey(REPO, "docs/doubted.md"), sessionId: session, verdict: "stale", surface: "omp" });
		index.invalidateFeedback();
		gate.resolve();
		await racing;

		const lookup = defined(await index.lookup(), "the lookup after the verdicts");
		expect(lookup(documentKey(REPO, "docs/doubted.md"))).toMatchObject({ stale: true });
	});

	test("a failed read that a clear has already outdated does not hold back the next read", async () => {
		const { store, index } = world();
		seed(store, "docs/a.md");
		const gate = Promise.withResolvers<void>();
		store.rowGate = gate.promise;
		const read = store.activeRows.bind(store);
		store.activeRows = async (limit) => {
			const rows = await read(limit);
			if (store.rowReads === 1) throw new Error("connection lost");
			return rows;
		};
		const racing = index.lookup();
		// One turn is not enough: the read must be inside the gate, so the failure belongs to the generation the clear already dropped.
		for (let i = 0; i < 20 && store.rowReads === 0; i += 1) await Promise.resolve();
		expect(store.rowReads).toBe(1);
		index.invalidate();
		gate.resolve();
		await racing;
		expect(defined(await index.lookup(), "the lookup after the clear")(documentKey(REPO, "docs/a.md"))).not.toBeNull();
	});
});

describe("AuthorityIndex partial reads", () => {
	const OLD_TIME = "2026-01-01T00:00:00.000Z";

	function copies(store: FakeStore): void {
		seed(store, "docs/guide.md", { repo: "local/old", ingestedAt: OLD_TIME, sha256: sha256Hex("old-guide") });
		seed(store, "docs/guide.md", { repo: "local/new", ingestedAt: FRESH, sha256: sha256Hex("new-guide") });
	}

	test("a pair of copies is labelled when the read is complete, and left alone when the read cap cut the rows", async () => {
		const complete = world();
		copies(complete.store);
		const full = defined(await complete.index.lookup(), "the lookup");
		expect(full(documentKey("local/old", "docs/guide.md"))).toMatchObject({ stale: true, supersededBy: documentKey("local/new", "docs/guide.md") });

		const cut = world();
		copies(cut.store);
		cut.store.forceTruncated = true;
		const partial = defined(await cut.index.lookup(), "the lookup");
		// The third copy may be beyond the cap: neither copy is called stale on the evidence of the two that were read.
		expect(partial(documentKey("local/old", "docs/guide.md"))).toMatchObject({ stale: false, supersededBy: null });
		expect(partial(documentKey("local/new", "docs/guide.md"))).toMatchObject({ stale: false, supersededBy: null });
	});

	test("an explicit marker still flags in a partial snapshot, and the snapshot says it is partial", () => {
		const marked = makeRow({ repo: REPO, path: "docs/old.md", sha256: sha256Hex("old"), ingestedAt: FRESH, supersededBy: "docs/new.md" });
		const target = makeRow({ repo: REPO, path: "docs/new.md", sha256: sha256Hex("new"), ingestedAt: FRESH });
		const partial = snapshotOf(1, { rows: [marked, target], truncated: true }, NOW);
		expect(partial.partial).toBe(true);
		expect(partial.superseded.get(documentKey(REPO, "docs/old.md"))).toBe(documentKey(REPO, "docs/new.md"));
		expect(snapshotOf(1, { rows: [marked, target], truncated: false }, NOW).partial).toBe(false);
	});
});

describe("AuthorityIndex fail-open", () => {
	test("with no manifest there is no lookup", async () => {
		const index = new AuthorityIndex({ store: () => null, reflect: () => null, now: () => NOW });
		expect(await index.lookup()).toBeNull();
	});

	test("a manifest that fails to read gives no lookup, and is asked again only after the interval, not once per search", async () => {
		const { store, clock, index } = world();
		seed(store, "docs/a.md");
		store.failVersion = true;
		expect(await index.lookup()).toBeNull();
		expect(await index.lookup()).toBeNull();
		expect(store.versionReads).toBe(1);
		store.failVersion = false;
		clock.now += VERSION_CHECK_MS;
		expect(await index.lookup()).not.toBeNull();
	});

	test("a manifest that fails after a good read keeps serving the last snapshot", async () => {
		const { store, clock, index } = world();
		seed(store, "docs/a.md");
		await index.lookup();
		store.failVersion = true;
		clock.now += VERSION_CHECK_MS;
		const lookup = defined(await index.lookup(), "the held snapshot");
		expect(lookup(documentKey(REPO, "docs/a.md"))).not.toBeNull();
	});

	test("feedback that cannot be read leaves every document without feedback, never without a lookup", async () => {
		const { store, reflect, index } = world();
		seed(store, "docs/a.md");
		defined(reflect, "the reflect store").failCounts = true;
		const lookup = defined(await index.lookup(), "the lookup");
		expect(lookup(documentKey(REPO, "docs/a.md"))).toMatchObject({ stale: false });
	});

	test("with no feedback table every document has no feedback", async () => {
		const { store, index } = world({ reflect: null });
		seed(store, "docs/a.md");
		expect(defined(await index.lookup(), "the lookup")(documentKey(REPO, "docs/a.md"))).not.toBeNull();
	});

	test("a manifest that never answers costs a search its budget and no more: the lookup is null", async () => {
		const { store, index } = world({ budgetMs: 5 });
		seed(store, "docs/a.md");
		store.hangVersion = true;
		expect(await index.lookup()).toBeNull();
	});
});
