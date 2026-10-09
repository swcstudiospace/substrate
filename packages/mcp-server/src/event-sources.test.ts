import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeEvent } from "./event.ts";
import { EVENT_SOURCES, SILENT_SOURCES } from "./event-sources.ts";
import { SURFACES } from "./types.ts";
/**
 * Proof for the v1.3 event-source table.
 *
 * Every `EVENT_SOURCES` sample must survive `normalizeEvent` — the real
 * write-path gate — unchanged in kind, surface and payload, and the reviewed
 * document `docs/event-vocabulary.md` must name the same sources, kinds and
 * actions as this table, so the two cannot drift.
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

describe("each sample matches its own row", () => {
	for (const row of EVENT_SOURCES) {
		test(`sample of ${row.id} carries its row's kind, action and runtime`, () => {
			const sample = row.sample();
			const payload = sample.payload ?? {};
			expect({ id: row.id, kind: sample.kind }).toEqual({ id: row.id, kind: row.kind });
			if (row.actions) {
				expect(row.actions as readonly unknown[]).toContain(payload["action"]);
			} else {
				expect({ id: row.id, action: payload["action"] ?? null }).toEqual({ id: row.id, action: null });
			}
			if (row.runtime) {
				expect({ id: row.id, runtime: payload["runtime"] }).toEqual({ id: row.id, runtime: row.runtime });
			} else {
				expect({ id: row.id, runtime: payload["runtime"] ?? null }).toEqual({ id: row.id, runtime: null });
			}
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
		"skills.sync",
		"docs.ingest",
		"desktop.",
		"anchor.",
		"teachable.",
		"dispatch.",
		"lanea.",
		"mirror.",
		"dod.",
		"lease.",
	]) {
		test(`prefix ${prefix} has a row`, () => {
			const ids = EVENT_SOURCES.filter((row) => row.id.startsWith(prefix)).map((row) => row.id);
			expect({ prefix, ids: ids.length > 0 ? ids : null }).toEqual({ prefix, ids });
			expect(ids.length).toBeGreaterThan(0);
		});
	}
});

describe("the surface rule", () => {
	test("each row's sample surface satisfies its declared rule", () => {
		// A row declaring `{ fixed: "substrate" }` while sampling `cursor`,
		// or declaring `"caller"` while sampling `substrate`, passes every
		// other assertion — so the rule admits the sample here, explicitly.
		for (const row of EVENT_SOURCES) {
			const surface = row.sample().surface;
			if (typeof row.surface === "string") {
				if (row.surface === "herdr-agent") {
					// Phase 19's fixed table maps the detected agent onto
					// SURFACES: a sample naming a raw herdr id, or the rule
					// name itself, is a bug.
					expect([...SURFACES]).toContain(surface);
					expect(surface).not.toBe("herdr-agent");
				} else {
					// caller, memory-writer, lease-holder: the concrete sample surface.
					expect(["claude-code", "hermes"]).toContain(surface);
				}
			} else {
				expect({ id: row.id, surface }).toEqual({ id: row.id, surface: row.surface.fixed });
			}
		}
	});
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

describe("docs/event-vocabulary.md equals the table", () => {
	const DOC = join(import.meta.dir, "..", "..", "..", "docs", "event-vocabulary.md");

	function parseMarkedTable(markdown: string): Array<Record<string, string>> {
		const start = markdown.indexOf("<!-- event-sources:start -->");
		const end = markdown.indexOf("<!-- event-sources:end -->");
		if (start < 0 || end < start) throw new Error("event-sources markers missing");
		const rows = markdown
			.slice(start, end)
			.split("\n")
			.filter((line) => line.trimStart().startsWith("|"));
		const [header, , ...body] = rows;
		const keys = (header ?? "")
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((cell) => cell.trim().replace(/`/g, ""));
		return body.map((line) => {
			const values = line
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim().replace(/`/g, ""));
			return Object.fromEntries(values.map((value, i) => [keys[i] ?? `col${i}`, value]));
		});
	}

	test("the marked table names exactly the table's ids", () => {
		const docRows = parseMarkedTable(readFileSync(DOC, "utf8"));
		const docIds = [...docRows.map((row) => row["id"] ?? "")].sort();
		const tableIds = [...EVENT_SOURCES.map((row) => row.id), ...SILENT_SOURCES.map((row) => row.id)].sort();
		expect({ docIds }).toEqual({ docIds: tableIds });
	});

	test("each doc row carries its row's kind, surface, actions and runtime", () => {
 		const docRows = parseMarkedTable(readFileSync(DOC, "utf8"));
 		const byId = new Map(docRows.map((row) => [row["id"], row]));
 		for (const row of EVENT_SOURCES) {
 			const doc = byId.get(row.id);
 			expect({ id: row.id, kind: doc?.["kind"], surface: doc?.["surface"], actions: doc?.["action"] }).toEqual({
 				id: row.id,
 				kind: row.kind,
 				surface: typeof row.surface === "string" ? row.surface : row.surface.fixed,
 				actions: row.actions ? [...row.actions].join(", ") : "—",
 			});
 			expect({ id: row.id, runtime: doc?.["runtime"] }).toEqual({ id: row.id, runtime: row.runtime ?? "—" });
 		}
 		// Silent sources deliberately emit nothing: the doc holds an em dash.
		for (const row of SILENT_SOURCES) {
			const doc = byId.get(row.id);
			expect({ id: row.id, kind: doc?.["kind"], surface: doc?.["surface"], actions: doc?.["action"] }).toEqual({
				id: row.id,
				kind: "—",
				surface: "—",
				actions: "—",
			});
		}
	});
});
