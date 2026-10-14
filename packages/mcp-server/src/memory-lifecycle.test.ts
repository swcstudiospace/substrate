/**
 * `SUBSTRATE_MEMORY_LIFECYCLE`: report (default) or off. A typo stays report
 * and is named. The extra sweep read lists the two ttl classes and deletes nothing.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { DEFAULT_SWEEP_POLICY, formatMemoryLifecycleReport, memoryLifecycleQuery } from "./index-sweep.ts";
import { retainDocumentId } from "./memory-retain.ts";
import type { MemoryEntry } from "./types.ts";

describe("SUBSTRATE_MEMORY_LIFECYCLE", () => {
	test("unset, blank and report are report with no rejection; off is off", () => {
		expect(loadConfig({}).memoryLifecycle).toBe("report");
		expect(loadConfig({}).memoryLifecycleRejected).toBeNull();
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "   " }).memoryLifecycle).toBe("report");
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "   " }).memoryLifecycleRejected).toBeNull();
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "report" }).memoryLifecycle).toBe("report");
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "report" }).memoryLifecycleRejected).toBeNull();
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "off" }).memoryLifecycle).toBe("off");
		expect(loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: "off" }).memoryLifecycleRejected).toBeNull();
	});

	test("enforce and yes stay report and remember the rejected string", () => {
		for (const raw of ["enforce", "yes"]) {
			const config = loadConfig({ SUBSTRATE_MEMORY_LIFECYCLE: raw });
			expect(config.memoryLifecycle).toBe("report");
			expect(config.memoryLifecycleRejected).toBe(raw);
		}
	});
});

describe("memory lifecycle query", () => {
	test("the SQL names both ttl predicates and has no delete", () => {
		const sql = memoryLifecycleQuery(DEFAULT_SWEEP_POLICY, 0).text;
		expect(sql).toContain("ttl = '30d'");
		expect(sql).toContain("ttl = 'graph'");
		expect(sql.toLowerCase()).not.toContain("delete");
	});
});

describe("memory lifecycle report", () => {
	test("a row with a subject prints document_id and omits the subject", () => {
		const subject = "lifecycle-subject-token";
		const row = {
			id: "entry-1",
			scope: "global",
			kind: "fact",
			subject,
			writer: "cursor",
			ttl: "30d",
			idempotency_key: "idem-1",
			created: "2020-01-01T00:00:00.000Z",
			class_count: 1,
		};
		const entry = {
			id: "entry-1",
			scope: "global",
			kind: "fact",
			text: "",
			writer: "cursor",
			subject,
			ttl: "30d",
			created: "2020-01-01T00:00:00.000Z",
			actor: "agent",
			trust: "unverified",
			version: 1,
		} as unknown as MemoryEntry;
		const text = formatMemoryLifecycleReport([row], { batch: 500, hindsight: null });
		expect(text).toContain(retainDocumentId(entry, "idem-1"));
		expect(text).not.toContain(subject);
		expect(text.toLowerCase()).not.toContain("body");
	});

	test("listed ids are capped at batch while the count stays the full number", () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({
			id: `id-${i}`,
			scope: "global",
			kind: "fact",
			subject: "",
			writer: "cursor",
			ttl: "30d",
			idempotency_key: `k-${i}`,
			class_count: 5,
		}));
		const text = formatMemoryLifecycleReport(rows, { batch: 2, hindsight: null });
		expect(text).toContain("candidates      5");
		expect(text).toContain("id-0");
		expect(text).toContain("id-1");
		expect(text).not.toContain("id-2");
		expect(text).toContain("truncated true");
	});
});
