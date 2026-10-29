/**
 * The candidates of `substrate corpus plan --neardup` (v1.7 phase 64): the documents the plan would add, update, change or rename
 * that sit in a file this machine can read, each cut to the excerpt `POST /corpus/neardup` takes. The scan hashed the whole file;
 * the excerpt is only the start of it, which is where a document says what it is.
 *
 * Nothing here decides what happens to a document. The answer is advisory and only printed.
 */
import { CORPUS_PROTOCOL, MAX_NEARDUP_ITEMS, MAX_NEARDUP_TEXT_CHARS, compareEntries, documentKey, type CorpusEntry, type CorpusNeardupRequest, type CorpusPlanResponse, type NeardupItem } from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";

/** Four bytes is the most one UTF-16 code unit of the excerpt can take in UTF-8, so this many bytes always hold the excerpt. */
const EXCERPT_BYTES = MAX_NEARDUP_TEXT_CHARS * 4;

/** Plan actions whose document would be written to the docs plane. A tombstone has no document to compare. */
const WRITTEN_ACTIONS: readonly string[] = ["add", "update", "change", "rename"];

export interface NeardupSelection {
	/** The excerpts to send, in `(repo, path)` order, at most the limit. */
	items: NeardupItem[];
	/** Planned documents in a local file, before the limit. */
	candidates: number;
	/** Local candidates never looked at because the limit was reached first. */
	overLimit: number;
	/** Planned documents that came from GitHub: a plan does not read those, so they cannot be compared. */
	github: number;
	/** Local candidates whose file could not be read. */
	unreadable: number;
}

/**
 * The first {@link MAX_NEARDUP_TEXT_CHARS} characters of the bytes, decoded as UTF-8. A byte-order mark is kept and an invalid
 * sequence becomes U+FFFD, as in the ingest. A cut between the two halves of a surrogate pair drops the half.
 */
export function excerptOf(bytes: Uint8Array): string {
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, EXCERPT_BYTES));
	if (text.length <= MAX_NEARDUP_TEXT_CHARS) return text;
	const last = text.charCodeAt(MAX_NEARDUP_TEXT_CHARS - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_NEARDUP_TEXT_CHARS - 1 : MAX_NEARDUP_TEXT_CHARS);
}

/**
 * Walks the local candidates in `(repo, path)` order, reading each through `readFile` until `max` excerpts are held. A file that
 * cannot be read is counted and skipped, never fatal, and does not use up the limit.
 */
export function selectNeardupItems(plan: CorpusPlanResponse, inventory: Inventory, readFile: (path: string) => Uint8Array, max: number): NeardupSelection {
	const byKey = new Map(inventory.entries.map((entry) => [documentKey(entry.repo, entry.path), entry]));
	const wanted = new Set<string>();
	for (const item of plan.items) if (WRITTEN_ACTIONS.includes(item.action)) wanted.add(documentKey(item.repo, item.path));
	let github = 0;
	let unreadable = 0;
	const local: Array<{ entry: CorpusEntry; location: string }> = [];
	for (const key of wanted) {
		const entry = byKey.get(key);
		if (entry === undefined) {
			unreadable += 1;
			continue;
		}
		if (entry.source === "github") {
			github += 1;
			continue;
		}
		const location = inventory.paths.get(key);
		if (location === undefined) unreadable += 1;
		else local.push({ entry, location });
	}
	local.sort((a, b) => compareEntries(a.entry, b.entry));
	const limit = Math.min(max, MAX_NEARDUP_ITEMS);
	const items: NeardupItem[] = [];
	let examined = 0;
	for (const { entry, location } of local) {
		if (items.length >= limit) break;
		examined += 1;
		try {
			items.push({ repo: entry.repo, path: entry.path, text: excerptOf(readFile(location)) });
		} catch {
			// The file went away or became unreadable since the scan; it is counted as not compared and the run goes on.
			unreadable += 1;
		}
	}
	return { items, candidates: local.length, overLimit: local.length - examined, github, unreadable };
}

export function neardupRequest(items: NeardupItem[], threshold: number | undefined): CorpusNeardupRequest {
	return { protocol: CORPUS_PROTOCOL, items, ...(threshold === undefined ? {} : { threshold }) };
}
