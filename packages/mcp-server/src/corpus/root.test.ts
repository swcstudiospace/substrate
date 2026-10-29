import { describe, expect, test } from "bun:test";
import { CORPUS_EMPTY_ROOT, compareEntries, corpusLeafHex } from "@substrate/corpus";
import { merkleRootHex, verifyMerkleProofAgainstCommitment } from "@substrate/ledger";
import { defined } from "../test-support.ts";
import type { EventInput } from "../types.ts";
import { buildCorpusTree, CORPUS_ROOT_ACTION, CORPUS_ROOT_SESSION, CorpusRootKeeper, corpusProof, corpusRoot, ROOT_EMIT_MIN_INTERVAL_MS, type RootClock, type RootRow } from "./root.ts";
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
});

describe("corpusProof", () => {
	test("every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index", () => {
		for (const size of [1, 2, 3, 5, 8, 9]) {
			const rows = rowsOf(size);
			const { root } = corpusRoot(rows);
			for (const index of new Set([0, Math.floor(size / 2), size - 1])) {
				const row = defined(rows[index], "row");
				const proof = defined(corpusProof(rows, row.repo, row.path), `proof of ${row.path}`);
				expect(proof).toMatchObject({ index, treeSize: size, root, sha256: row.sha256, leaf: corpusLeafHex(row.repo, row.path, row.sha256) });
				expect(verifyMerkleProofAgainstCommitment(proof.leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, { rootHex: root, count: size })).toBe(true);
			}
		}
	});

	test("a tampered sibling, leaf or index fails", () => {
		const rows = rowsOf(5);
		const row = defined(rows[2], "row");
		const proof = defined(corpusProof(rows, row.repo, row.path), "proof");
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
		expect(corpusProof(rows, REPO, "docs/gone.md")).toBeNull();
		expect(corpusProof(rows, REPO, "docs/never.md")).toBeNull();
		expect(corpusProof([], REPO, "docs/doc-000.md")).toBeNull();
	});
});

/** A clock that runs a timer only when the test says so. */
class ManualClock implements RootClock {
	at = 1_000_000;
	readonly timers: Array<{ run: () => void; ms: number }> = [];
	now(): number {
		return this.at;
	}
	setTimer(run: () => void, ms: number): void {
		this.timers.push({ run, ms });
	}
	fire(): void {
		defined(this.timers.shift(), "a scheduled timer").run();
	}
}

/** Lets every pending promise step settle: the keeper's work is in-memory, so no real time is needed. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 25; turn++) await Promise.resolve();
}

function harness(store: FakeStore | null = new FakeStore(), emitFails = false) {
	const clock = new ManualClock();
	const emitted: EventInput[] = [];
	const keeper = new CorpusRootKeeper({
		store: () => store,
		emit: async (event) => {
			if (emitFails) throw new Error("ledger unavailable");
			emitted.push(event);
		},
		clock,
	});
	return { clock, emitted, keeper, store };
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

	test("changes inside the window are coalesced into one event that carries the latest state", async () => {
		const { clock, emitted, keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 2);
		keeper.manifestChanged();
		manifest.seed(makeRow({ repo: REPO, path: "docs/late.md", sha256: sha256Hex("late") }));
		keeper.manifestChanged();
		keeper.manifestChanged();
		expect(clock.timers).toHaveLength(1);
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(1);
		expect(defined(emitted[0]).payload).toMatchObject({ count: 3, manifest_version: 3 });
	});

	test("the next event waits out the rest of the five-second window, and one change never writes two", async () => {
		const { clock, emitted, keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 1);
		keeper.manifestChanged();
		clock.fire();
		await flush();
		clock.at += 1_000;
		manifest.seed(makeRow({ repo: REPO, path: "docs/next.md", sha256: sha256Hex("next") }));
		keeper.manifestChanged();
		expect(clock.timers.map((timer) => timer.ms)).toEqual([ROOT_EMIT_MIN_INTERVAL_MS - 1_000]);
		clock.at += ROOT_EMIT_MIN_INTERVAL_MS - 1_000;
		clock.fire();
		await flush();
		expect(emitted.map((event) => event.payload?.manifest_version)).toEqual([1, 2]);
		// A change noted with no manifest write is the same version: nothing more is written.
		keeper.manifestChanged();
		clock.at += ROOT_EMIT_MIN_INTERVAL_MS;
		clock.fire();
		await flush();
		expect(emitted).toHaveLength(2);
	});

	test("the empty manifest is never emitted", async () => {
		const { clock, emitted, keeper } = harness();
		keeper.manifestChanged();
		clock.fire();
		await flush();
		expect(emitted).toEqual([]);
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
		recovering.clock.at += ROOT_EMIT_MIN_INTERVAL_MS;
		recovering.keeper.manifestChanged();
		recovering.clock.fire();
		await flush();
		expect(recovering.emitted).toHaveLength(1);
	});

	test("with no manifest (the corpus is off) a change schedules nothing and a search warms nothing", () => {
		const { clock, keeper } = harness(null);
		keeper.manifestChanged();
		keeper.warm();
		expect(clock.timers).toEqual([]);
		expect(keeper.peek()).toBeNull();
	});

	test("peek never reads the manifest; warm fills the cache for the current version, and a change empties it", async () => {
		const { keeper, store } = harness();
		const manifest = defined(store);
		seed(manifest, 3);
		expect(keeper.peek()).toBeNull();
		expect(manifest.leafReads).toBe(0);
		keeper.warm();
		await flush();
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
