/**
 * The authority index: built once per manifest version, rebuilt only when the version moves, fail-open, and bounded in how
 * long a search waits for it.
 */
import { describe, expect, test } from "bun:test";
import { documentKey } from "@substrate/corpus";
import { defined } from "../test-support.ts";
import { AuthorityIndex, FEEDBACK_TTL_MS, VERSION_CHECK_MS } from "./authority-index.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import type { ManifestRow } from "./store.ts";
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

	override async manifestVersion(): Promise<number> {
		this.versionReads += 1;
		if (this.hangVersion) return new Promise<number>(() => undefined);
		if (this.failVersion) throw new Error("connection lost");
		return super.manifestVersion();
	}

	override async activeRows(limit: number): Promise<ManifestRow[]> {
		this.rowReads += 1;
		return super.activeRows(limit);
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
