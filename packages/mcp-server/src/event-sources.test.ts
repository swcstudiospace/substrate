/**
 * Round-trip proof for the v1.3 event-source table.
 *
 * Every `EVENT_SOURCES` sample must survive `normalizeEvent` — the real
 * write-path gate — unchanged in kind, surface and payload. A sample that
 * the redactor rewrites or the validator refuses is a mapping the ledger
 * would never store, so it fails here instead of in a later phase's proof.
 */
import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "./event.ts";
import { EVENT_SOURCES } from "./event-sources.ts";

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
