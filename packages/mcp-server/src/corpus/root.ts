/**
 * The corpus Merkle root (v1.7 phase 69): one RFC 6962 root over the ACTIVE manifest rows, the inclusion proof of one row, and
 * the keeper that caches the root per manifest version and records it as a ledger event.
 *
 * The tree is the ledger's own (`@substrate/ledger` `merkleRootHex` and `merkleProofHex`, never reimplemented). A leaf is
 * `corpusLeafHex(repo, path, sha256)`; leaves are sorted by `(repo, path)` by code unit, so the root depends on what the manifest
 * holds and never on the order rows were written or read. The manifest with no active row has the defined root
 * `CORPUS_EMPTY_ROOT` (RFC 6962's hash of the empty tree); it is never emitted.
 *
 * A proof served to a caller is taken over one repository's rows only (`repositoryTreeOf`), so the root it names is that repository's
 * root, not the whole-corpus root `corpusRoot` makes and the ledger anchors. The whole-corpus tree and its root are unchanged.
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

/** At most one root event per this many milliseconds; a change that lands inside the window is coalesced into the next event. */
export const ROOT_EMIT_MIN_INTERVAL_MS = 5_000;

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
	/** Repository of each skipped active row, so a grant can count its own skips and no other repository's. */
	skippedRepos: readonly string[];
}

/** Equal keys fall back to the hash, so even a duplicated key sorts the same way on every read. */
export function buildCorpusTree(rows: readonly RootRow[]): CorpusTree {
	const ordered: TreeLeaf[] = [];
	const skippedRepos: string[] = [];
	for (const row of rows) {
		if (row.state === "tombstoned") continue;
		if (leafRefusal(row.repo, row.path, row.sha256) !== null) {
			skippedRepos.push(row.repo);
			continue;
		}
		ordered.push({ repo: row.repo, path: row.path, sha256: row.sha256, leaf: corpusLeafHex(row.repo, row.path, row.sha256) });
	}
	ordered.sort((a, b) => compareEntries(a, b) || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
	return { ordered, skipped: skippedRepos.length, skippedRepos };
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
export function inclusionOf(tree: Pick<CorpusTree, "ordered">, repo: string, path: string): CorpusInclusion | null {
	const index = tree.ordered.findIndex((entry) => entry.repo === repo && entry.path === path);
	const found = tree.ordered[index];
	if (found === undefined) return null;
	const proof = merkleProofHex(
		tree.ordered.map((entry) => entry.leaf),
		index,
	);
	return { sha256: found.sha256, leaf: found.leaf, index, treeSize: proof.size, path: proof.path, root: rootOf(tree.ordered) };
}

/**
 * One repository's leaves in tree order: the whole-corpus tree's entries for `repo`, and no other. The tree is sorted by
 * `(repo, path, sha256)`, so the filtered entries keep the same order. A repository's root and proofs are the RFC 6962 tree over
 * these leaves alone, so they depend on that repository's rows and on no other repository's. The whole-corpus tree is not changed.
 */
export function repositoryTreeOf(tree: CorpusTree, repo: string): Pick<CorpusTree, "ordered"> {
	return { ordered: tree.ordered.filter((entry) => entry.repo === repo) };
}

/** The root over one repository's active rows alone, and how many of them it covers. The whole-corpus root is {@link corpusRoot}. */
export function repositoryRoot(rows: readonly RootRow[], repo: string): { root: string; count: number } {
	const { ordered } = repositoryTreeOf(buildCorpusTree(rows), repo);
	return { root: rootOf(ordered), count: ordered.length };
}
/**
 * The root, leaf count and skipped rows of `repos` alone. Another repository's leaves and skips are not in the result, so
 * they cannot move this root or this count. The whole-corpus root is {@link corpusRoot}.
 */
export function grantRootOf(tree: CorpusTree, repos: ReadonlySet<string>): { root: string; count: number; skipped: number } {
	const ordered = tree.ordered.filter((entry) => repos.has(entry.repo));
	let skipped = 0;
	for (const repo of tree.skippedRepos) if (repos.has(repo)) skipped += 1;
	return { root: rootOf(ordered), count: ordered.length, skipped };
}

/** The proof of one document of `repo` against that repository's root, or null when it is not an active row of `repo`. */
export function repositoryProof(rows: readonly RootRow[], repo: string, path: string): CorpusInclusion | null {
	return inclusionOf(repositoryTreeOf(buildCorpusTree(rows), repo), repo, path);
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
	now(): number;
	setTimer(run: () => void, ms: number): void;
}

/** The real clock. The timer is unref'd, so a pending root event never holds the process open (one still waiting at shutdown is dropped). */
export const systemRootClock: RootClock = {
	now: () => Date.now(),
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
 * - A root is recorded only when no ingest is writing (the event follows `writeSettled`, which re-arms an event a timer found
 *   deferred) and only when it differs from the root written last, so a state is recorded once however the batches were ordered
 *   and an unchanged manifest writes nothing.
 * - `manifestChanged()` bumps the generation and schedules one root event. Events are coalesced: at most one per
 *   {@link ROOT_EMIT_MIN_INTERVAL_MS}, and the one that goes out reads the manifest when its timer fires, so the latest state wins.
 *   The timer runs after the request that noted the change has answered, and a failure of any kind is swallowed: a root event
 *   never fails an ingest. A root event lost to a failure is written by the next change.
 * - `peek()` never reads: it is what `docs_search` uses.
 */
export class CorpusRootKeeper {
	private readonly clock: RootClock;
	private generation = 0;
	private cached: (CorpusRootSnapshot & { generation: number }) | null = null;
	private reading: { generation: number; promise: Promise<CorpusRootRead> } | null = null;
	private timerPending = false;
	/** When the last root write was attempted: the five-second window runs from there, rerun or not. */
	private lastWriteMs: number | null = null;
	/** The root the ledger holds last. A root is compared, not its version: concurrent batches may commit out of order, so a final state can share the version of an earlier read. */
	private lastEmittedRoot: string | null = null;
	/** The ingests whose writes have started and not settled. */
	private writers = 0;
	/** A root event is owed: the manifest changed and no root written or judged unneeded since. It survives a timer that fired during an ingest. */
	private owed = false;
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

	/** Starts the computation the cache is missing, off the caller's path. Never throws; a failed read leaves the cache empty. */
	warm(): void {
		if (this.writers > 0 || this.peek() !== null || this.deps.store() === null) return;
		this.read().then(
			() => undefined,
			() => undefined,
		);
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
			if (this.writers === 0 && this.owed) this.scheduleEmit();
		}
	}

	/** The manifest changed: forget the cached root and schedule one root event. Returns at once and never throws. */
	manifestChanged(): void {
		this.generation += 1;
		this.owed = true;
		this.scheduleEmit();
	}

	/** Arms the one timer a root event waits on: at once, or when the window since the last write attempt has passed. */
	private scheduleEmit(): void {
		if (this.deps.store() === null || this.timerPending) return;
		const wait = this.lastWriteMs === null ? 0 : Math.max(0, this.lastWriteMs + ROOT_EMIT_MIN_INTERVAL_MS - this.clock.now());
		this.timerPending = true;
		this.clock.setTimer(() => {
			this.timerPending = false;
			void this.emitRoot();
		}, wait);
	}

	/**
	 * At most one root write runs. A request that arrives meanwhile is remembered, and once the running write ends it waits out the
	 * window from that write's start like any other, so slow writes cannot make the next ones arrive closer than the interval.
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

	private async emitOnce(): Promise<void> {
		try {
			// While an ingest writes, the manifest is between versions: nothing is recorded now, and `writeSettled` owes the event after it.
			if (this.writers > 0) return;
			const read = await this.read();
			if (this.writers > 0) return;
			this.owed = false;
			if (!read.ok || read.snapshot.count === 0 || read.snapshot.root === this.lastEmittedRoot) return;
			const { root, count, manifestVersion } = read.snapshot;
			this.lastWriteMs = this.clock.now();
			const written = await this.deps.emit({
				surface: "substrate",
				kind: "note",
				summary: `corpus root ${shortRoot(root)} over ${count} documents (manifest ${manifestVersion})`,
				session_id: CORPUS_ROOT_SESSION,
				payload: { action: CORPUS_ROOT_ACTION, root, count, manifest_version: manifestVersion },
			});
			// A write the ledger refused is not a root it holds: the next event for this state must go out again.
			if (written.stored) this.lastEmittedRoot = root;
		} catch {
			// The ingest this follows already answered; a root that did not reach the ledger is written by the next change.
		}
	}
}
