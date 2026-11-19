/**
 * The corpus Merkle root (v1.7 phase 69): one RFC 6962 root over the ACTIVE manifest rows, the inclusion proof of one row, and
 * the keeper that caches the root per manifest version and records it as a ledger event.
 *
 * The tree is the ledger's own (`@substrate/ledger` `merkleRootHex` and `merkleProofHex`, never reimplemented). A leaf is
 * `corpusLeafHex(repo, path, sha256)`; leaves are sorted by `(repo, path)` by code unit, so the root depends on what the manifest
 * holds and never on the order rows were written or read. The manifest with no active row has the defined root
 * `CORPUS_EMPTY_ROOT` (RFC 6962's hash of the empty tree); it is never emitted.
 *
 * The root event rides the existing hourly anchor: it is an ordinary `note` in the ledger, and the hour it lands in is anchored
 * by the anchor job like any other. Nothing here sends a transaction or writes a memo.
 */
import { CORPUS_EMPTY_ROOT, compareEntries, corpusLeafHex, leafRefusal, shortRoot } from "@substrate/corpus";
import { merkleProofHex, merkleRootHex } from "@substrate/ledger";
import type { EventInput } from "../types.ts";
import type { CorpusStore, ManifestLeaf, ManifestState } from "./store.ts";

/** The `payload.action` of the root event. A reserved action: only the server (or an operator) writes it. */
export const CORPUS_ROOT_ACTION = "docs.corpus.root";

/** The ledger session every root event is written in, so a reader finds them without scanning a whole surface. */
export const CORPUS_ROOT_SESSION = "corpus-root";

/**
 * The most active rows one root is made from. A manifest past this has no root and says so (`too-large`) instead of a root over
 * a prefix that would look complete. The store reads one row more than this to know.
 */
export const MAX_CORPUS_LEAVES = 100_000;

/** A row the root may cover. A row whose `state` is not `active` is left out. */
export type RootRow = ManifestLeaf & { state?: ManifestState };

interface TreeLeaf extends ManifestLeaf {
	leaf: string;
}

/** The active rows as leaves in tree order, and how many active rows could not be encoded. */
export interface CorpusTree {
	ordered: TreeLeaf[];
	/** One bad row never fails the root: a malformed sha256 or an ill-formed name is skipped and counted here. */
	skipped: number;
}

/** Equal keys fall back to the hash, so even a duplicated key sorts the same way on every read. */
export function buildCorpusTree(rows: readonly RootRow[]): CorpusTree {
	const ordered: TreeLeaf[] = [];
	let skipped = 0;
	for (const row of rows) {
		if (row.state === "tombstoned") continue;
		if (leafRefusal(row.repo, row.path, row.sha256) !== null) {
			skipped += 1;
			continue;
		}
		ordered.push({ repo: row.repo, path: row.path, sha256: row.sha256, leaf: corpusLeafHex(row.repo, row.path, row.sha256) });
	}
	ordered.sort((a, b) => compareEntries(a, b) || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
	return { ordered, skipped };
}

function rootOf(ordered: readonly TreeLeaf[]): string {
	return ordered.length === 0 ? CORPUS_EMPTY_ROOT : merkleRootHex(ordered.map((entry) => entry.leaf));
}

/** The root over the active rows, the number of leaves it covers, and the active rows it could not cover. */
export function corpusRoot(rows: readonly RootRow[]): { root: string; count: number; skipped: number } {
	const { ordered, skipped } = buildCorpusTree(rows);
	return { root: rootOf(ordered), count: ordered.length, skipped };
}

/** One document's inclusion proof against the root of the tree it was taken from. */
export interface CorpusInclusion {
	sha256: string;
	leaf: string;
	index: number;
	treeSize: number;
	path: string[];
	root: string;
}

/** The proof of `(repo, path)` in `tree`, or null when the tree holds no such document. */
export function inclusionOf(tree: CorpusTree, repo: string, path: string): CorpusInclusion | null {
	const index = tree.ordered.findIndex((entry) => entry.repo === repo && entry.path === path);
	const found = tree.ordered[index];
	if (found === undefined) return null;
	const proof = merkleProofHex(
		tree.ordered.map((entry) => entry.leaf),
		index,
	);
	return { sha256: found.sha256, leaf: found.leaf, index, treeSize: proof.size, path: proof.path, root: rootOf(tree.ordered) };
}

/** The proof of one document among `rows`, or null when it is not an active row. */
export function corpusProof(rows: readonly RootRow[], repo: string, path: string): CorpusInclusion | null {
	return inclusionOf(buildCorpusTree(rows), repo, path);
}

/** The root of one manifest version. */
export interface CorpusRootSnapshot {
	root: string;
	count: number;
	manifestVersion: number;
	skipped: number;
}

export type CorpusRootAnswer = { ok: true; snapshot: CorpusRootSnapshot } | { ok: false; reason: "too-large" };

/** One read of the manifest: the snapshot and the tree it was made from (what a proof needs). */
export type CorpusRootRead = { ok: true; snapshot: CorpusRootSnapshot; tree: CorpusTree } | { ok: false; reason: "too-large" };

/** The keeper's clock; a test passes a manual one. */
export interface RootClock {
	setTimer(run: () => void, ms: number): void;
}

/** The real clock. The timer is unref'd, so a pending root event never holds the process open (one still waiting at shutdown is dropped). */
export const systemRootClock: RootClock = {
	setTimer: (run, ms) => {
		setTimeout(run, ms).unref();
	},
};

export interface CorpusRootKeeperDeps {
	/** The manifest, or null while the corpus is off or there is no index. Read on each use. */
	store: () => CorpusStore | null;
	/** Resolves with `stored: false` when the ledger could not take the event (it does not always throw). */
	emit: (event: EventInput) => Promise<{ stored: boolean }>;
	clock?: RootClock | undefined;
}

/**
 * Caches the root of the current manifest version and records it in the ledger after the manifest changed.
 *
 * - The cache holds one snapshot, valid while no change has been noted since it was read (`generation`). The routes also compare
 *   it with the manifest's version, so a write this process did not note is not served as current.
 * - An ingest brackets its writes with `writeStarted()` and `writeSettled()`. While one is in flight the cache is empty and no read
 *   is cached, so a search never names a root the batches already saved have outdated.
 * - A root is recorded only when no ingest is writing: the event a changing sync owes follows that ingest's `writeSettled`, which
 *   re-arms an event a timer found deferred.
 * - `manifestChanged()` bumps the generation and owes one root event for the change. The event is written off the request that
 *   noted the change, on a timer with no delay, and it reads the manifest when its turn comes, so it carries the state at that
 *   time. Each changing sync owes its own event, and writes run one at a time. A failure of any kind is swallowed: a root event
 *   never fails an ingest, and a lost event is not retried (the next change writes its own).
 * - `peek()` never reads: it is what `docs_search` uses.
 */
export class CorpusRootKeeper {
	private readonly clock: RootClock;
	private generation = 0;
	private cached: (CorpusRootSnapshot & { generation: number }) | null = null;
	private reading: { generation: number; promise: Promise<CorpusRootRead> } | null = null;
	private timerPending = false;
	/** The ingests whose writes have started and not settled. */
	private writers = 0;
	/** Changing syncs whose root event is not written yet: one event each. The count survives a timer that fired during an ingest. */
	private owed = 0;
	/** The one root write in flight, and whether another was asked for while it ran. */
	private emitting: Promise<void> | null = null;
	private emitAgain = false;

	constructor(private readonly deps: CorpusRootKeeperDeps) {
		this.clock = deps.clock ?? systemRootClock;
	}

	/** The cached root of the current manifest, or null when none is cached. Never reads the manifest. */
	peek(): CorpusRootSnapshot | null {
		const cached = this.cached;
		if (this.writers > 0 || cached === null || cached.generation !== this.generation) return null;
		const { generation: _generation, ...snapshot } = cached;
		return snapshot;
	}

	/** Reads the manifest (sharing a read already in flight for this generation) and caches the root. Rejects when the store does. */
	read(): Promise<CorpusRootRead> {
		const store = this.deps.store();
		if (store === null) return Promise.reject(new Error("the corpus manifest is not available"));
		if (this.reading !== null && this.reading.generation === this.generation) return this.reading.promise;
		const generation = this.generation;
		const promise = this.load(store, generation).finally(() => {
			if (this.reading?.promise === promise) this.reading = null;
		});
		this.reading = { generation, promise };
		return promise;
	}

	private async load(store: CorpusStore, generation: number): Promise<CorpusRootRead> {
		const { manifestVersion, leaves, truncated } = await store.activeLeaves(MAX_CORPUS_LEAVES);
		if (truncated) return { ok: false, reason: "too-large" };
		const tree = buildCorpusTree(leaves);
		const snapshot: CorpusRootSnapshot = { root: rootOf(tree.ordered), count: tree.ordered.length, manifestVersion, skipped: tree.skipped };
		// A change noted while this read ran makes it stale for the next caller, but it is still the true root of the version it names.
		// While an ingest is writing, the manifest is between versions, so nothing read now is kept.
		if (generation === this.generation && this.writers === 0) this.cached = { ...snapshot, generation };
		return { ok: true, snapshot, tree };
	}

	/** The root of the current manifest version: the cache while it matches the manifest's version, else one read. Rejects when the store does. */
	async current(): Promise<CorpusRootAnswer> {
		const store = this.deps.store();
		if (store === null) throw new Error("the corpus manifest is not available");
		const cached = this.cached;
		if (cached !== null && cached.generation === this.generation && cached.manifestVersion === (await store.manifestVersion())) {
			const { generation: _generation, ...snapshot } = cached;
			return { ok: true, snapshot };
		}
		return this.read();
	}

	/** An ingest is about to write: the cached root is forgotten and stays unavailable until {@link writeSettled}. */
	writeStarted(): void {
		this.writers += 1;
		this.generation += 1;
	}

	/** That ingest finished or failed. When it may have changed the manifest, one root event is scheduled. Never throws. */
	writeSettled(changed: boolean): void {
		this.writers = Math.max(0, this.writers - 1);
		if (changed) this.manifestChanged();
		else {
			this.generation += 1;
			// An event an earlier ingest owed may have been deferred by this one; its timer is gone, so it is armed again here.
			if (this.writers === 0 && this.owed > 0) this.scheduleEmit();
		}
	}

	/** The manifest changed: forget the cached root and owe one root event for it. Returns at once and never throws. */
	manifestChanged(): void {
		this.generation += 1;
		this.owed += 1;
		this.scheduleEmit();
	}

	/** Arms the one timer the owed root events wait on: at once, off the request that noted the change. */
	private scheduleEmit(): void {
		if (this.deps.store() === null || this.timerPending || this.owed === 0) return;
		this.timerPending = true;
		this.clock.setTimer(() => {
			this.timerPending = false;
			void this.emitRoot();
		}, 0);
	}

	/**
	 * At most one root write runs. A request that arrives meanwhile is remembered, and once the running write ends it runs in turn.
	 */
	private async emitRoot(): Promise<void> {
		if (this.emitting !== null) {
			this.emitAgain = true;
			return;
		}
		this.emitting = this.emitOnce().finally(() => {
			this.emitting = null;
			if (this.emitAgain) {
				this.emitAgain = false;
				this.scheduleEmit();
			}
		});
		await this.emitting;
	}

	/** Writes one root event per owed change, each carrying the manifest as it reads when its turn comes. Never throws. */
	private async emitOnce(): Promise<void> {
		while (this.owed > 0) {
			// While an ingest writes, the manifest is between versions: nothing is recorded now, and `writeSettled` owes the event after it.
			if (this.writers > 0) return;
			let read: CorpusRootRead | null = null;
			try {
				read = await this.read();
			} catch {
				// An unreadable manifest: this change's event is lost, and the next change writes its own.
			}
			if (this.writers > 0) return;
			this.owed -= 1;
			if (read === null || !read.ok || read.snapshot.count === 0) continue;
			const { root, count, manifestVersion } = read.snapshot;
			// A write the ledger refused (`stored: false`) or threw is not retried: the next change writes its own event.
			try {
				await this.deps.emit({
					surface: "substrate",
					kind: "note",
					summary: `corpus root ${shortRoot(root)} over ${count} documents (manifest ${manifestVersion})`,
					session_id: CORPUS_ROOT_SESSION,
					payload: { action: CORPUS_ROOT_ACTION, root, count, manifest_version: manifestVersion },
				});
			} catch {
				// A ledger that threw: this change's event is lost. A failed write never fails an ingest.
			}
		}
	}
}
