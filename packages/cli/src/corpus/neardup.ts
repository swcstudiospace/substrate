/**
 * The candidates of `substrate corpus plan --neardup` (v1.7 phase 64): the documents the plan would add, update, change or rename
 * that sit in a file this machine can read, each cut to the excerpt `POST /corpus/neardup` takes. The scan hashed the whole file;
 * the excerpt is only the start of it, which is where a document says what it is.
 *
 * Nothing here decides what happens to a document. The answer is advisory and only printed.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CORPUS_PROTOCOL, MAX_NEARDUP_ITEMS, MAX_NEARDUP_TEXT_CHARS, compareEntries, documentKey, type CorpusEntry, type CorpusNeardupRequest, type CorpusPlanResponse, type NeardupItem } from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";

/** Four bytes is the most one UTF-16 code unit of the excerpt can take in UTF-8, so this many bytes always hold the excerpt. */
export const NEARDUP_EXCERPT_BYTES = MAX_NEARDUP_TEXT_CHARS * 4;

/**
 * Reads at most `maxBytes` from the start of a file. A reader may return fewer only at the end of the file. `expectedSize` is the
 * size the scan recorded: a reader that can check it refuses a file that is not that size any more.
 */
type PrefixReader = (path: string, maxBytes: number, expectedSize?: number) => Uint8Array;

/**
 * The first `maxBytes` of a file and no more: the descriptor is closed on every path and the buffer is never larger than the
 * bytes asked for, so a file accepted through a large `--max-bytes` costs no more than a small one.
 */
export function readFilePrefix(path: string, maxBytes: number, expectedSize?: number): Uint8Array {
	// The scan refused symbolic links, and that was a while ago: a document replaced by a link while the plan was being made would be
	// followed here and its target's first characters sent to the server. So the file is opened without following a link (and without
	// blocking on a pipe), and it has to still be the regular file of the size the scan saw. A platform without `O_NOFOLLOW` keeps
	// the other two checks.
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (expectedSize !== undefined && stat.size !== expectedSize) throw new Error("the file changed since the scan");
		const buffer = new Uint8Array(Math.max(0, Math.floor(maxBytes)));
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			filled += read;
		}
		return buffer.subarray(0, filled);
	} finally {
		closeSync(fd);
	}
}

/** The reader to use: an injected prefix reader, else an injected whole-file reader cut to the budget, else the disk. */
export function prefixReaderOf(readPrefix: PrefixReader | undefined, readFile: ((path: string) => Uint8Array) | undefined): PrefixReader {
	if (readPrefix !== undefined) return readPrefix;
	if (readFile !== undefined) return (path, maxBytes) => readFile(path).subarray(0, maxBytes);
	return readFilePrefix;
}

/**
 * The bytes without a UTF-8 sequence cut short at the end. A prefix of a longer file can end inside a multi-byte character,
 * and decoding that would put a replacement character into the excerpt that is not in the file.
 */
export function withoutPartialTail(bytes: Uint8Array): Uint8Array {
	const end = bytes.length;
	for (let back = 1; back <= 3 && back <= end; back++) {
		const byte = bytes[end - back] ?? 0;
		if ((byte & 0xc0) === 0x80) continue;
		const needed = byte >= 0xf0 && byte <= 0xf7 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return needed > back ? bytes.subarray(0, end - back) : bytes;
	}
	return bytes;
}

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
 * sequence becomes U+FFFD, as in the ingest. A cut between the two halves of a surrogate pair drops the half. Bytes that fill
 * the whole {@link NEARDUP_EXCERPT_BYTES} budget may be the start of a longer file, so a sequence cut short at their end is
 * dropped rather than decoded to a replacement character the file does not contain.
 */
export function excerptOf(bytes: Uint8Array): string {
	const cut = bytes.subarray(0, NEARDUP_EXCERPT_BYTES);
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(cut.length >= NEARDUP_EXCERPT_BYTES ? withoutPartialTail(cut) : cut);
	if (text.length <= MAX_NEARDUP_TEXT_CHARS) return text;
	const last = text.charCodeAt(MAX_NEARDUP_TEXT_CHARS - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_NEARDUP_TEXT_CHARS - 1 : MAX_NEARDUP_TEXT_CHARS);
}

/**
 * Walks the local candidates in `(repo, path)` order, reading the start of each through `readPrefix` (never more than
 * {@link NEARDUP_EXCERPT_BYTES}) until `max` excerpts are held. A file that cannot be read is counted and skipped, never fatal,
 * and does not use up the limit.
 */
export function selectNeardupItems(plan: CorpusPlanResponse, inventory: Inventory, readPrefix: PrefixReader, max: number): NeardupSelection {
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
			items.push({ repo: entry.repo, path: entry.path, text: excerptOf(readPrefix(location, NEARDUP_EXCERPT_BYTES, entry.bytes)) });
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
