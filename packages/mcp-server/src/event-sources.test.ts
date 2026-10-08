import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "./event.ts";
import { EVENT_SOURCES } from "./event-sources.ts";

/**
 * Proof for the v1.3 event-source table.
 *
 * Every `EVENT_SOURCES` sample must survive `normalizeEvent` — the real
 * write-path gate — unchanged in kind, surface and payload. Coverage, repo
 * and no-content rules hold over the full inventory.
 */

describe("EVENT_SOURCES samples survive the write-path gate", () => {
	for (const row of EVENT_SOURCES) {
		test(`sample of ${row.id} passes normalizeEvent unchanged`, () => {
			const sample = row.sample();
			const stored = normalizeEvent(sample, null);
			expect({ id: row.id, kind: stored.kind, surface: stored.surface }).toEqual({
				id: row.id,
				kind: sample.kind,
				surface: sample.surface,
			});
			// Deep-equal proves the redactor leaves the sample payload intact:
			// hashes stay hashes, never content, never [REDACTED].
			expect({ id: row.id, payload: stored.payload }).toEqual({ id: row.id, payload: sample.payload ?? {} });
		});
	}
});

describe("every roadmap source has at least one row", () => {
	// One prefix per source CONTEXT names, so an emptied table cannot pass:
	// a vacuous EVENT_SOURCES fails here before it fails anywhere else.
	for (const prefix of [
		"herdr.",
		"muse.",
		"cursor.stop",
		"skills.propose",
		"docs.ingest",
		"desktop.",
		"anchor.",
		"teachable.",
	]) {
		test(`prefix ${prefix} has a row`, () => {
			const ids = EVENT_SOURCES.filter((row) => row.id.startsWith(prefix)).map((row) => row.id);
			expect({ prefix, ids: ids.length > 0 ? ids : null }).toEqual({ prefix, ids });
			expect(ids.length).toBeGreaterThan(0);
		});
	}
});

describe("the repo rule", () => {
	test("no periodic row carries repo, and carriesRepo matches the sample", () => {
		for (const row of EVENT_SOURCES) {
			const sample = row.sample();
			// A periodic event carrying repo would crowd that repo's brief
			// (brief.ts lists recent actions per repo), so it is refused here.
			expect({ id: row.id, periodicWithRepo: row.periodic && sample.repo !== undefined }).toEqual({
				id: row.id,
				periodicWithRepo: false,
			});
			expect({ id: row.id, carriesRepo: row.carriesRepo }).toEqual({
				id: row.id,
				carriesRepo: sample.repo !== undefined,
			});
		}
	});
});

describe("the no-content rule", () => {
	test("no sample carries a content-bearing payload key", () => {
		// Sensitive values travel as hashes and lengths only. Exact key names:
		// content_sha256 and text_len stay, because they are the hashed form.
		const BANNED: Record<string, true> = { text: true, content: true, body: true, bytes: true, image: true, png: true };
		for (const row of EVENT_SOURCES) {
			const keys = Object.keys(row.sample().payload ?? {});
			const banned = keys.filter((key) => BANNED[key]);
			expect({ id: row.id, banned }).toEqual({ id: row.id, banned: [] });
		}
	});
});
