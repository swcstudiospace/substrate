import { describe, expect, test } from "bun:test";
import { CORPUS_EMPTY_ROOT, compareEntries, corpusLeafHex } from "@substrate/corpus";
import { merkleProofHex, merkleRootHex, verifyMerkleProofAgainstCommitment } from "@substrate/ledger";
import { defined } from "../test-support.ts";
import type { EventInput } from "../types.ts";
import { buildCorpusTree, CORPUS_ROOT_ACTION, CORPUS_ROOT_SESSION, CorpusRootKeeper, corpusRoot, repositoryProof, repositoryRoot, type RootClock, type RootRow } from "./root.ts";
import { FakeStore, makeRow, sha256Hex } from "./testkit.ts";
import type { ActiveLeaves } from "./store.ts";

const REPO = "swcstudiospace/agent-substrate";

function rowsOf(count: number): RootRow[] {
	return Array.from({ length: count }, (_, index) => ({ repo: REPO, path: `docs/doc-${String(index).padStart(3, "0")}.md`, sha256: sha256Hex(`body ${index}`) }));
}

/** A deterministic shuffle, so the order test does not depend on Math.random. */
function shuffled<T>(items: readonly T[]): T[] {
	const copy = [...items];
	let state = 12_345;
	for (let index = copy.length - 1; index > 0; index--) {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		const other = state % (index + 1);
		const held = defined(copy[index], "swap source");
		copy[index] = defined(copy[other], "swap target");
		copy[other] = held;
	}
	return copy;
}

function flipLastHexCharacter(hex: string): string {
	return `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
}

describe("corpusRoot", () => {
	test("is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in", () => {
		const rows = rowsOf(7);
		const expected = merkleRootHex([...rows].sort(compareEntries).map((row) => corpusLeafHex(row.repo, row.path, row.sha256)));
		const forward = corpusRoot(rows);
		expect(forward).toEqual({ root: expected, count: 7, skipped: 0 });
		expect(corpusRoot([...rows].reverse())).toEqual(forward);
		expect(corpusRoot(shuffled(rows))).toEqual(forward);
	});

	test("sorts by code unit, not by locale: an uppercase path sorts before a lowercase one", () => {
		const rows: RootRow[] = [
			{ repo: REPO, path: "b.md", sha256: sha256Hex("b") },
			{ repo: REPO, path: "B.md", sha256: sha256Hex("B") },
		];
		const first = defined(buildCorpusTree(rows).ordered[0], "first leaf");
		expect(first.path).toBe("B.md");
	});

	test("a changed hash, path or repository changes the root", () => {
		const rows = rowsOf(4);
		const base = corpusRoot(rows).root;
		const changedHash = rows.map((row, index) => (index === 2 ? { ...row, sha256: sha256Hex("edited") } : row));
		const changedPath = rows.map((row, index) => (index === 2 ? { ...row, path: "docs/renamed.md" } : row));
		const changedRepo = rows.map((row, index) => (index === 2 ? { ...row, repo: "swcstudiospace/other" } : row));
		const added = [...rows, { repo: REPO, path: "docs/extra.md", sha256: sha256Hex("extra") }];
		for (const variant of [changedHash, changedPath, changedRepo, added, rows.slice(1)]) expect(corpusRoot(variant).root).not.toBe(base);
	});

	test("only active rows are covered: a tombstoned row is not a leaf", () => {
		const active = rowsOf(3);
		const withTombstone: RootRow[] = [...active, { repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone"), state: "tombstoned" }];
		expect(corpusRoot(withTombstone)).toEqual(corpusRoot(active));
	});

	test("the manifest with no active row has the defined empty root, and is not a one-leaf tree", () => {
		expect(corpusRoot([])).toEqual({ root: CORPUS_EMPTY_ROOT, count: 0, skipped: 0 });
		expect(corpusRoot([{ repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone"), state: "tombstoned" }]).root).toBe(CORPUS_EMPTY_ROOT);
	});

	test("one row that cannot be encoded is skipped and counted, and never fails the root", () => {
		const good = rowsOf(3);
		const bad: RootRow = { repo: REPO, path: "docs/bad.md", sha256: "not-a-hash" };
		expect(corpusRoot([...good, bad])).toEqual({ ...corpusRoot(good), skipped: 1 });
	});

	test("the whole-corpus root and its leaves are the values pinned before per-repository proofs existed", () => {
		const rows: RootRow[] = [
			{ repo: "swcstudiospace/alpha", path: "docs/a.md", sha256: sha256Hex("a") },
			{ repo: "swcstudiospace/alpha", path: "docs/b.md", sha256: sha256Hex("b") },
			{ repo: "swcstudiospace/beta", path: "docs/a.md", sha256: sha256Hex("a") },
			{ repo: "swcstudiospace/beta", path: "docs/c.md", sha256: sha256Hex("c"), state: "active" },
			{ repo: "local/gamma", path: "notes/x.md", sha256: sha256Hex("x"), state: "tombstoned" },
			{ repo: "local/gamma", path: "notes/y.md", sha256: "NOT-HEX" },
			{ repo: "local/gamma", path: "notes/z.md", sha256: sha256Hex("z"), state: "active" },
		];
		expect(corpusRoot(rows)).toEqual({ root: "6421f2e47324f00f741670895145cb4e44aca8e275c861adf7ac7de4a5d13c35", count: 5, skipped: 1 });
		expect(corpusRoot(rows.slice(0, 1)).root).toBe("baecc4c1daadf023927bb2141a625eb8a20fae52b5c48389ecfe95c7f37ec689");
		expect(buildCorpusTree(rows).ordered.map((entry) => entry.leaf)).toEqual([
			"99a1d742ea09b3affcd1f7bc64c28ed9c14a55a1e30cd239c000f87ce6d68599",
			"4f9c422941337680ef7bedec2d36168e40493b25284827962883fb20ce9de078",
			"80a1653f1f01c32cafd1e6a1bc7f0dcbdbb1068a300bd94f0d1028f81f1f1691",
			"212d8a4b5e88fcfe0867c816e02d44c72bcf8e2c5395890de2f2ac95ec441c1d",
			"db1900eeb592910c5f5cb1030f13c671419708707be5ef6e6d48d764d0c0acc7",
		]);
	});
});

describe("repositoryProof", () => {
	test("every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index", () => {
		for (const size of [1, 2, 3, 5, 8, 9]) {
			const rows = rowsOf(size);
			const { root } = corpusRoot(rows);
			for (const index of new Set([0, Math.floor(size / 2), size - 1])) {
				const row = defined(rows[index], "row");
				const proof = defined(repositoryProof(rows, row.repo, row.path), `proof of ${row.path}`);
				expect(proof).toMatchObject({ index, treeSize: size, root, sha256: row.sha256, leaf: corpusLeafHex(row.repo, row.path, row.sha256) });
				expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: root, count: size })).toBe(true);
			}
		}
	});

	test("a tampered sibling, leaf or index fails", () => {
		const rows = rowsOf(5);
		const row = defined(rows[2], "row");
		const proof = defined(repositoryProof(rows, row.repo, row.path), "proof");
		const commitment = { rootHex: proof.root, count: proof.treeSize };
		const sibling = defined(proof.path[0], "first sibling");
		const tamperedPath = [flipLastHexCharacter(sibling), ...proof.path.slice(1)];
		expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: tamperedPath }, commitment)).toBe(false);
		const otherLeaf = corpusLeafHex(row.repo, "docs/not-here.md", row.sha256);
		expect(verifyMerkleProofAgainstCommitment(otherLeaf, { index: proof.index, size: proof.treeSize, path: proof.path }, commitment)).toBe(false);
		expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: 3, size: proof.treeSize, path: proof.path }, commitment)).toBe(false);
	});

	test("a missing document and a tombstoned one have no proof", () => {
		const rows: RootRow[] = [...rowsOf(3), { repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone"), state: "tombstoned" }];
		expect(repositoryProof(rows, REPO, "docs/gone.md")).toBeNull();
		expect(repositoryProof(rows, REPO, "docs/never.md")).toBeNull();
		expect(repositoryProof([], REPO, "docs/doc-000.md")).toBeNull();
	});

	const OTHER = "swcstudiospace/other";

	/** Five documents of REPO and six of OTHER: OTHER's leaves must never appear in REPO's proofs. */
	function twoRepos(): RootRow[] {
		const others = Array.from({ length: 6 }, (_, index) => ({ repo: OTHER, path: `docs/o-${index}.md`, sha256: sha256Hex(`other ${index}`) }));
		return [...rowsOf(5), ...others];
	}

	/** The leaves of one repository in tree order, built here without the module under test. */
	function leavesOf(rows: readonly RootRow[], repo: string): string[] {
		return rows
			.filter((row) => row.repo === repo)
			.sort(compareEntries)
			.map((row) => corpusLeafHex(row.repo, row.path, row.sha256));
	}

	/** The proof of every active document of `repo`. */
	function proofsOf(rows: readonly RootRow[], repo: string) {
		return rows.filter((row) => row.repo === repo).map((row) => defined(repositoryProof(rows, repo, row.path), `proof of ${row.path}`));
	}

	test("a repository's root is the RFC 6962 root over its own leaves, and each of its proofs verifies against it", () => {
		const rows = twoRepos();
		for (const repo of [REPO, OTHER]) {
			const leaves = leavesOf(rows, repo);
			const root = merkleRootHex(leaves);
			expect(repositoryRoot(rows, repo)).toEqual({ root, count: leaves.length });
			for (const row of rows.filter((candidate) => candidate.repo === repo)) {
				const proof = defined(repositoryProof(rows, repo, row.path), `proof of ${row.path}`);
				expect(proof).toMatchObject({ treeSize: leaves.length, root, sha256: row.sha256, leaf: corpusLeafHex(row.repo, row.path, row.sha256) });
				expect(leaves[proof.index]).toBe(proof.leaf);
				expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: root, count: leaves.length })).toBe(true);
			}
		}
	});

	test("first, middle and last documents of repositories of 1, 2, 3, 5, 8 and 9 documents prove against their own root", () => {
		for (const size of [1, 2, 3, 5, 8, 9]) {
			const others = Array.from({ length: 4 }, (_, index) => ({ repo: OTHER, path: `docs/o-${index}.md`, sha256: sha256Hex(`other ${index}`) }));
			const rows = [...rowsOf(size), ...others];
			const root = merkleRootHex(leavesOf(rows, REPO));
			for (const index of new Set([0, Math.floor(size / 2), size - 1])) {
				const row = defined(rows[index], "row");
				const proof = defined(repositoryProof(rows, REPO, row.path), `proof of ${row.path}`);
				expect({ size, position: proof.index, treeSize: proof.treeSize, root: proof.root }).toEqual({ size, position: index, treeSize: size, root });
				expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: root, count: size })).toBe(true);
			}
		}
	});

	test("repository A's audit path holds no hash derived from repository B's rows, and is exactly the path over A's leaves alone", () => {
		const rows = twoRepos();
		// B's leaf values, and the RFC 6962 hash of each (`merkleRootHex` of one leaf is that hash): neither may appear in A's path.
		const otherLeaves = leavesOf(rows, OTHER);
		const forbidden = new Set([...otherLeaves, ...otherLeaves.map((leaf) => merkleRootHex([leaf]))]);
		const ownLeaves = leavesOf(rows, REPO);
		for (const proof of proofsOf(rows, REPO)) {
			expect(proof.path.filter((hash) => forbidden.has(hash))).toEqual([]);
			expect(proof.path).toEqual(merkleProofHex(ownLeaves, proof.index).path);
		}
	});

	test("repository A's root and proofs do not change when repository B's rows change", () => {
		const rows = twoRepos();
		const changed: RootRow[] = [
			...rows.filter((row) => row.repo === REPO),
			...rows.filter((row) => row.repo === OTHER).map((row, index): RootRow => {
				if (index === 0) return { ...row, sha256: sha256Hex("edited") };
				if (index === 5) return { ...row, state: "tombstoned" };
				return row;
			}),
			{ repo: OTHER, path: "docs/new.md", sha256: sha256Hex("new") },
		];
		expect(repositoryRoot(changed, REPO)).toEqual(repositoryRoot(rows, REPO));
		expect(proofsOf(changed, REPO)).toEqual(proofsOf(rows, REPO));
		// The whole-corpus root does move, so the equality above is not vacuous.
		expect(corpusRoot(changed).root).not.toBe(corpusRoot(rows).root);
	});

	test("a document of another repository, a tombstoned one and a malformed one have no proof in this repository", () => {
		const rows = twoRepos();
		expect(repositoryProof(rows, REPO, "docs/o-0.md")).toBeNull();
		const withExtras: RootRow[] = [
			...rows,
			{ repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone"), state: "tombstoned" },
			{ repo: REPO, path: "docs/bad.md", sha256: "not-a-hash" },
		];
		expect(repositoryProof(withExtras, REPO, "docs/gone.md")).toBeNull();
		expect(repositoryProof(withExtras, REPO, "docs/bad.md")).toBeNull();
		expect(repositoryRoot(withExtras, REPO)).toEqual(repositoryRoot(rows, REPO));
	});
});

/** A clock that runs a timer only when the test says so. */
class ManualClock implements RootClock {
	at = 1_000_000;
	readonly timers: Array<{ run: () => void; ms: number }> = [];
	setTimer(run: () => void, ms: number): void {
		this.timers.push({ run, ms });
	}
	fire(): void {
		defined(this.timers.shift(), "a scheduled timer").run();
	}
}

/** Lets every pending promise step settle: the keeper's work is in-memory, so no real time is needed. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 200; turn++) await Promise.resolve();
}

function harness(store: FakeStore | null = new FakeStore(), emitFails = false) {
	const clock = new ManualClock();
	const emitted: EventInput[] = [];
	const ledger = { stored: true };
	const keeper = new CorpusRootKeeper({
		store: () => store,
		emit: async (event) => {
			if (emitFails) throw new Error("ledger unavailable");
			emitted.push(event);
			return { stored: ledger.stored };
		},
		clock,
	});
	return { clock, emitted, keeper, ledger, store };
}

function seed(store: FakeStore, count: number): void {
	for (const row of rowsOf(count)) store.seed(makeRow({ repo: row.repo, path: row.path, sha256: row.sha256 }));
}

describe("CorpusRootKeeper", () => {
	test("a change schedules one root event, written after the timer, with the root, the count and the manifest version", async () => {
		const { clock, emitted, keeper, store } = harness();
		seed(defined(store), 4);
		keeper.manifestChanged();
		expect(clock.timers.map((timer) => timer.ms)).toEqual([0]);
		expect(emitted).toEqual([]);
		clock.fire();
		await flush();
		const event = defined(emitted[0], "the root event");
		expect(emitted).toHaveLength(1);
		expect(event).toMatchObject({ surface: "substrate", kind: "note", session_id: CORPUS_ROOT_SESSION });
		expect(event.payload).toEqual({ action: CORPUS_ROOT_ACTION, root: corpusRoot(rowsOf(4)).root, count: 4, manifest_version: 4 });
		expect(event.summary).toContain(corpusRoot(rowsOf(4)).root.slice(0, 12));
	});

	test("two changing syncs that land before the timer runs each owe and write their own event, on one timer", async () => {
		const { clock, emitted, keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 2);
		keeper.manifestChanged();
		manifest.seed(makeRow({ repo: REPO, path: "docs/late.md", sha256: sha256Hex("late") }));
		keeper.manifestChanged();
		expect(clock.timers).toHaveLength(1);
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(2);
		expect(emitted.map((event) => event.payload?.manifest_version)).toEqual([3, 3]);
	});

	test("a changing sync writes its event at once, not after a window, and a change with no manifest write still owes one", async () => {
		const { clock, emitted, keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 1);
		keeper.manifestChanged();
		clock.fire();
		await flush();
		manifest.seed(makeRow({ repo: REPO, path: "docs/next.md", sha256: sha256Hex("next") }));
		keeper.manifestChanged();
		expect(clock.timers.map((timer) => timer.ms)).toEqual([0]);
		clock.fire();
		await flush();
		expect(emitted.map((event) => event.payload?.manifest_version)).toEqual([1, 2]);
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(3);
	});

	test("the empty manifest is never emitted", async () => {
		const { clock, emitted, keeper } = harness();
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toEqual([]);
	});

	test("a write the ledger refused is not retried: the next changing sync writes its own event", async () => {
		const { clock, emitted, keeper, ledger, store } = harness();
		seed(defined(store), 2);
		ledger.stored = false;
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(1);
		ledger.stored = true;
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted.map((event) => event.payload?.count)).toEqual([2, 2]);
		expect(clock.timers).toEqual([]);
	});

	test("from the first write of an ingest to its end the cached root is unavailable and nothing read meanwhile is kept", async () => {
		const { keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 3);
		await keeper.read();
		expect(defined(keeper.peek(), "the cached root").count).toBe(3);
		keeper.writeStarted();
		expect(keeper.peek()).toBeNull();
		// A batch already saved its rows; the manifest is between versions.
		manifest.seed(makeRow({ repo: REPO, path: "docs/batch.md", sha256: sha256Hex("batch") }));
		const during = await keeper.read();
		expect(during.ok && during.snapshot.count).toBe(4);
		await keeper.current();
		expect(keeper.peek()).toBeNull();
		keeper.writeSettled(true);
		expect(keeper.peek()).toBeNull();
		await keeper.read();
		expect(defined(keeper.peek(), "the settled root").count).toBe(4);
	});

	test("a root event an earlier ingest owes is written after a later ingest that changed nothing settles", async () => {
		const { clock, emitted, keeper, store } = harness();
		seed(defined(store), 2);
		// The earlier ingest changed the manifest; its timer is pending.
		keeper.manifestChanged();
		keeper.writeStarted();
		// The timer fires while a later ingest writes: nothing is recorded, and the timer is spent.
		clock.fire();
		await flush();
		expect(emitted).toEqual([]);
		expect(clock.timers).toEqual([]);
		// That ingest changed nothing, but the event is still owed, so settling arms it again.
		keeper.writeSettled(false);
		expect(clock.timers).toHaveLength(1);
		clock.fire();
		await flush();
		expect(emitted.map((event) => event.payload?.count)).toEqual([2]);
		// Once written, a later unchanged ingest owes nothing.
		keeper.writeStarted();
		keeper.writeSettled(false);
		expect(clock.timers).toEqual([]);
	});

	test("an ingest that changed nothing leaves the root recomputable and writes no event", async () => {
		const { clock, emitted, keeper, store } = harness();
		seed(defined(store), 2);
		keeper.writeStarted();
		keeper.writeSettled(false);
		expect(clock.timers).toEqual([]);
		await keeper.read();
		expect(defined(keeper.peek(), "the root").count).toBe(2);
		expect(emitted).toEqual([]);
	});

	test("a root write is never overlapped: a change noted while one runs writes its own event after it", async () => {
		const clock = new ManualClock();
		const store = new FakeStore();
		const emitted: EventInput[] = [];
		const releases: Array<() => void> = [];
		const keeper = new CorpusRootKeeper({
			store: () => store,
			emit: (event) => {
				const { promise, resolve } = Promise.withResolvers<{ stored: boolean }>();
				emitted.push(event);
				releases.push(() => resolve({ stored: true }));
				return promise;
			},
			clock,
		});
		seed(store, 2);
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(1);
		// A newer change noted while the first write runs waits for it: one root write at a time.
		store.seed(makeRow({ repo: REPO, path: "docs/newer.md", sha256: sha256Hex("newer") }));
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(1);
		defined(releases.shift(), "the first write").call(undefined);
		await flush();
		expect(emitted.map((event) => event.payload?.manifest_version)).toEqual([2, 3]);
		defined(releases.shift(), "the second write").call(undefined);
		await flush();
		expect(emitted).toHaveLength(2);
	});

	test("nothing is recorded while an ingest is writing; the events it and an earlier sync owe are written after it settles", async () => {
		const { clock, emitted, keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 2);
		keeper.manifestChanged();
		keeper.writeStarted();
		manifest.seed(makeRow({ repo: REPO, path: "docs/batch-1.md", sha256: sha256Hex("batch 1") }));
		// The timer fires while this ingest is writing: nothing is recorded, and both changes stay owed.
		clock.fire();
		await flush();
		expect(emitted).toEqual([]);
		manifest.seed(makeRow({ repo: REPO, path: "docs/batch-2.md", sha256: sha256Hex("batch 2") }));
		keeper.writeSettled(true);
		clock.fire();
		await flush();
		// Two changing syncs, two events, each read once the writes had settled.
		expect(emitted.map((event) => event.payload?.count)).toEqual([4, 4]);
	});

	test("every changing sync writes its own event, even when its root is the same as the last one written", async () => {
		const { clock, emitted, keeper, store } = harness();
		seed(defined(store), 2);
		keeper.manifestChanged();
		clock.fire();
		await flush();
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted.map((event) => event.payload?.count)).toEqual([2, 2]);
		expect(emitted.map((event) => event.payload?.root)).toEqual([corpusRoot(rowsOf(2)).root, corpusRoot(rowsOf(2)).root]);
	});

	test("a manifest too large for a root is not emitted and says so on read", async () => {
		class TooLarge extends FakeStore {
			override async activeLeaves(): Promise<ActiveLeaves> {
				return { manifestVersion: 9, leaves: [], truncated: true };
			}
		}
		const { clock, emitted, keeper } = harness(new TooLarge());
		expect(await keeper.read()).toEqual({ ok: false, reason: "too-large" });
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toEqual([]);
		expect(keeper.peek()).toBeNull();
	});

	test("a failing ledger or manifest never throws out of the timer and a later change still writes", async () => {
		const failing = harness(new FakeStore(), true);
		seed(defined(failing.store), 2);
		failing.keeper.manifestChanged();
		failing.clock.fire();
		await flush();
		expect(failing.emitted).toEqual([]);

		class Unreadable extends FakeStore {
			failing = true;
			override async activeLeaves(limit: number): Promise<ActiveLeaves> {
				if (this.failing) throw new Error("connection lost");
				return super.activeLeaves(limit);
			}
		}
		const unreadable = new Unreadable();
		seed(unreadable, 2);
		const recovering = harness(unreadable);
		recovering.keeper.manifestChanged();
		recovering.clock.fire();
		await flush();
		expect(recovering.emitted).toEqual([]);
		unreadable.failing = false;
		recovering.keeper.manifestChanged();
		recovering.clock.fire();
		await flush();
		expect(recovering.emitted).toHaveLength(1);
	});

	test("with no manifest (the corpus is off) a change schedules nothing and nothing is cached", () => {
		const { clock, keeper } = harness(null);
		keeper.manifestChanged();
		expect(clock.timers).toEqual([]);
		expect(keeper.peek()).toBeNull();
	});

	test("peek never reads the manifest; a read fills it, and a change empties it", async () => {
		const { keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 3);
		expect(keeper.peek()).toBeNull();
		expect(manifest.leafReads).toBe(0);
		await keeper.read();
		expect(keeper.peek()).toEqual({ root: corpusRoot(rowsOf(3)).root, count: 3, manifestVersion: 3, skipped: 0 });
		expect(manifest.leafReads).toBe(1);
		keeper.manifestChanged();
		expect(keeper.peek()).toBeNull();
	});

	test("current serves the cache while the manifest's version is the one cached, and re-reads when another writer moved it", async () => {
		const { keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 2);
		await keeper.current();
		await keeper.current();
		expect(manifest.leafReads).toBe(1);
		manifest.seed(makeRow({ repo: REPO, path: "docs/other-writer.md", sha256: sha256Hex("other") }));
		const answer = await keeper.current();
		expect(manifest.leafReads).toBe(2);
		expect(answer).toMatchObject({ ok: true, snapshot: { count: 3, manifestVersion: 3 } });
	});

	test("concurrent reads of one generation share one manifest read", async () => {
		const { keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 2);
		await Promise.all([keeper.read(), keeper.read(), keeper.read()]);
		expect(manifest.leafReads).toBe(1);
	});
});
