/**
 * DOCS-03 lifecycle proof (I-03): the actual product callers, end to end.
 *
 * Every test drives `Substrate.ingestDocs` / `Substrate.searchDocs` over
 * the recording RAGFlow fake — the same methods the MCP tools and the
 * REST routes call into — and asserts on served replies, plane uploads
 * and emitted events. Promotion, staging, pins, degradation and restart
 * recovery are all owned by the service; nothing is hand-wired.
 *
 * Rules under proof: a pin advances only for a whole corpus (every
 * staged part present); failures, mismatches, changed retries and
 * identical refreshes keep the prior pin; the same commit never mints a
 * second generation; only a completed `skills-sync` refresh from the
 * substrate surface marks the sync live; citations carry the pin commit
 * only for chunks from the pinned documents, and a replaced document
 * reads unpinned (no physical delete exists — U02 stays an operator gap).
 *
 * Fixture scope: upload-backed retrieval stands in for the plane index,
 * so assertions target commit/pin-age/URLs/events — not content echo.
 * Real content round-trip stays operator-gated (G3 in
 * `docs/runbooks/docs-proof.md`). Uploads poll the fake's instant parse;
 * upload tests carry explicit timeouts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { Substrate } from "./service.ts";

const RAGFLOW_ENV = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" };
const ROOTS_ENV = { SUBSTRATE_DOCS_INGEST_ROOTS: "docs/,README.md,.planning/PROJECT.md,agent-skills/" };
const FF_NEW = "2222222222222222222222222222222222222222";
const FF_NEXT = "3333333333333333333333333333333333333333";

interface SeenEvent {
	kind: string;
	payload: Record<string, unknown>;
}

function serviceWith(fake: RagflowFake, env: Record<string, string> = {}): { live: Substrate; events: SeenEvent[] } {
	fake.serveUploadsAsChunks = true;
	const events: SeenEvent[] = [];
	const live = new Substrate(loadConfig({ ...RAGFLOW_ENV, ...ROOTS_ENV, ...env }), { index: null, greptime: null, ragflowFetch: fake.fetch }, {
		emitted: (sample) => {
			events.push({ kind: sample.kind, payload: sample.payload });
		},
	});
	return { live, events };
}

const versionNotes = (events: SeenEvent[]): SeenEvent[] =>
	events.filter((event) => event.kind === "note" && event.payload["action"] === "docs.ingest" && "version" in event.payload);

const notLiveWarnings = (events: SeenEvent[]): SeenEvent[] =>
	events.filter((event) => event.kind === "warning" && event.payload["reason"] === "skills-sync-not-live");

const SKILL_PAGE = {
	path: "agent-skills/review/SKILL.md",
	source_url: "https://example.com/agent-skills/review",
	body: "Review skills live in this skill, served through the substrate.",
};

const skillsSyncRefresh = (commit: string, part: number, parts: number): Record<string, unknown> => ({
	id: `skills-sync:${commit}`,
	part,
	parts,
	trigger: "skills-sync",
});

function expectUnpinned(chunks: Array<{ commit?: string }>): void {
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks.every((chunk) => typeof chunk.commit === "string" && chunk.commit.includes("unpinned"))).toBe(true);
}

describe("docs lifecycle through the substrate service", () => {
	test("a committed ingest promotes a version only its documents cite", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const outcome = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results.every((result) => result.status === "ingested")).toBe(true);
		expect(versionNotes(events)).toHaveLength(1);

		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((chunk) => chunk.commit === FF_NEW)).toBe(true);

		// Stale chunks outside the pinned documents never cite the pin.
		fake.serveUploadsAsChunks = false;
		const stale = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expectUnpinned(stale.chunks);
	}, 30_000);

	test("identical bytes and reused commits record no new generation", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const first = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const again = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results.every((result) => result.status === "unchanged")).toBe(true);
		const changed = await live.ingestDocs(
			{ dataset: "agent-skills", commit: FF_NEW, pages: [{ ...SKILL_PAGE, body: "Review skills live here now, revised." }] },
			"substrate",
		);
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(versionNotes(events)).toHaveLength(1);

		// The replaced document left the pin: only its original cites it.
		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		const pinned = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-1");
		const superseded = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-2");
		expect(pinned.length).toBeGreaterThan(0);
		expect(pinned.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
		expectUnpinned(superseded);
	}, 30_000);

	test("a refused ingest keeps the prior served pin", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const first = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const refused = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEXT,
				pages: [{ ...SKILL_PAGE, body: "paste sk-proj-abcdefghij1234567890 into the corpus" }],
			},
			"substrate",
		);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("secret-findings");
		expect(versionNotes(events)).toHaveLength(1);

		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
	}, 30_000);

	test("changed corpora promote monotonic versions and serve the newest", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const first = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const second = await live.ingestDocs(
			{ dataset: "agent-skills", commit: FF_NEXT, pages: [{ ...SKILL_PAGE, body: "Review skills live here now, revised." }] },
			"substrate",
		);
		if (!second.ok) throw new Error(`expected replace: ${second.reason}`);
		expect(versionNotes(events).map((event) => event.payload["version"])).toEqual(["v1", "v2"]);

		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		const current = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-2");
		const stale = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-1");
		expect(current.length).toBeGreaterThan(0);
		expect(current.every((chunk) => chunk.commit === FF_NEXT)).toBe(true);
		expectUnpinned(stale);
	}, 30_000);

	test("only a completed substrate skills-sync refresh marks the sync live", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expect(notLiveWarnings(events)).toHaveLength(1);

		// An ordinary ingest promotes the pin but leaves the sync not-live.
		const plain = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (!plain.ok) throw new Error(`expected ingest: ${plain.reason}`);
		const degraded = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expect(degraded.chunks.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
		expect(degraded.chunks.every((chunk) => chunk.pin_age_ms !== undefined)).toBe(true);
		expect(notLiveWarnings(events)).toHaveLength(1);

		// The marked refresh completes the evidence and flips the sync live.
		const marked = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEXT,
				pages: [{ ...SKILL_PAGE, body: "Review skills after the fast-forward." }],
				refresh: skillsSyncRefresh(FF_NEXT, 1, 1),
			},
			"substrate",
		);
		if (!marked.ok) throw new Error(`expected refresh: ${marked.reason}`);
		expect(versionNotes(events).map((event) => event.payload["version"])).toEqual(["v1", "v2"]);
		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		const current = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-2");
		const stale = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-1");
		expect(current.length).toBeGreaterThan(0);
		expect(current.every((chunk) => chunk.commit === FF_NEXT)).toBe(true);
		expect(current.every((chunk) => chunk.pin_age_ms === undefined)).toBe(true);
		expectUnpinned(stale);
		expect(notLiveWarnings(events)).toHaveLength(1);
	}, 30_000);

	test("a skills-sync marker from another surface promotes without going live", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		const marked = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEW,
				pages: [SKILL_PAGE],
				refresh: skillsSyncRefresh(FF_NEW, 1, 1),
			},
			"omp",
		);
		if (!marked.ok) throw new Error(`expected refresh: ${marked.reason}`);
		expect(versionNotes(events)).toHaveLength(1);
		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expect(reply.chunks.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
		expect(reply.chunks.every((chunk) => chunk.pin_age_ms !== undefined)).toBe(true);
		expect(notLiveWarnings(events)).toHaveLength(1);
	}, 30_000);

	test("a part arriving after restart still completes one whole-corpus pin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docs-lifecycle-service-"));
		try {
			const file = join(dir, "docs-state.json");
			const env = { SUBSTRATE_DOCS_STATE_FILE: file };
			const fake = new RagflowFake();
			const first = serviceWith(fake, env);
			const part = await first.live.ingestDocs(
				{
					dataset: "agent-skills",
					commit: FF_NEW,
					pages: [SKILL_PAGE],
					refresh: skillsSyncRefresh(FF_NEW, 1, 2),
				},
				"substrate",
			);
			if (!part.ok) throw new Error(`expected part: ${part.reason}`);
			expect(versionNotes(first.events)).toHaveLength(0);

			const second = serviceWith(fake, env);
			const rest = await second.live.ingestDocs(
				{
					dataset: "agent-skills",
					commit: FF_NEW,
					pages: [{ path: "agent-skills/review/notes.md", source_url: "https://example.com/agent-skills/notes", body: "Second part notes." }],
					refresh: skillsSyncRefresh(FF_NEW, 2, 2),
				},
				"substrate",
			);
			if (!rest.ok) throw new Error(`expected completion: ${rest.reason}`);
			expect(versionNotes(second.events)).toHaveLength(1);
			expect(fake.uploads).toHaveLength(2);

			const reply = await second.live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
			expect(reply.chunks.length).toBe(2);
			expect(reply.chunks.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
			expect(notLiveWarnings(second.events)).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("an inconsistent part is refused before uploading and keeps the pin", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const part = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEW,
				pages: [SKILL_PAGE],
				refresh: skillsSyncRefresh(FF_NEW, 1, 2),
			},
			"substrate",
		);
		if (!part.ok) throw new Error(`expected part: ${part.reason}`);
		const uploadsBefore = fake.uploads.length;
		const mismatch = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEXT,
				pages: [SKILL_PAGE],
				refresh: skillsSyncRefresh(FF_NEW, 2, 2),
			},
			"substrate",
		);
		if (mismatch.ok) throw new Error("expected a mismatch refusal");
		expect(mismatch.reason).toBe("refresh-mismatch");
		expect(fake.uploads).toHaveLength(uploadsBefore);
		expect(versionNotes(events)).toHaveLength(0);

		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expectUnpinned(reply.chunks);
	}, 30_000);

	test("the same URL with different bytes across parts is refused and keeps the pin", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const id = `skills-sync:${FF_NEW}`;
		const first = await live.ingestDocs(
			{ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE], refresh: { id, part: 1, parts: 2, trigger: "skills-sync" } },
			"substrate",
		);
		if (!first.ok) throw new Error(`expected part: ${first.reason}`);
		const conflict = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEW,
				pages: [{ ...SKILL_PAGE, body: "Same URL, different bytes, other part." }],
				refresh: { id, part: 2, parts: 2, trigger: "skills-sync" },
			},
			"substrate",
		);
		if (conflict.ok) throw new Error("expected a url-changed refusal");
		expect(conflict.reason).toBe("refresh-url-changed");
		expect(versionNotes(events)).toHaveLength(0);
		const warnings = events.filter((event) => event.kind === "warning" && event.payload["reason"] === "refresh-url-changed");
		expect(warnings).toHaveLength(1);

		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		expectUnpinned(reply.chunks);
	}, 30_000);

	test("a retried part with different bytes is refused and keeps the prior pin", async () => {
		const fake = new RagflowFake();
		const { live, events } = serviceWith(fake);
		const id = `skills-sync:${FF_NEW}`;
		const first = await live.ingestDocs(
			{ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE], refresh: { id, part: 1, parts: 2, trigger: "skills-sync" } },
			"substrate",
		);
		if (!first.ok) throw new Error(`expected part: ${first.reason}`);
		const changed = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEW,
				pages: [{ ...SKILL_PAGE, body: "Different bytes under the same part." }],
				refresh: { id, part: 1, parts: 2, trigger: "skills-sync" },
			},
			"substrate",
		);
		if (changed.ok) throw new Error("expected a part-changed refusal");
		expect(changed.reason).toBe("refresh-part-changed");
		expect(versionNotes(events)).toHaveLength(0);

		const retry = await live.ingestDocs(
			{ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE], refresh: { id, part: 1, parts: 2, trigger: "skills-sync" } },
			"substrate",
		);
		if (!retry.ok) throw new Error(`expected identical retry: ${retry.reason}`);
		const rest = await live.ingestDocs(
			{
				dataset: "agent-skills",
				commit: FF_NEW,
				pages: [{ path: "agent-skills/review/notes.md", source_url: "https://example.com/agent-skills/notes", body: "Second part notes." }],
				refresh: { id, part: 2, parts: 2, trigger: "skills-sync" },
			},
			"substrate",
		);
		if (!rest.ok) throw new Error(`expected completion: ${rest.reason}`);
		expect(versionNotes(events)).toHaveLength(1);
		const reply = await live.searchDocs({ question: "what skills exist?", datasets: ["agent-skills"] }, "omp");
		const current = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-3" || chunk.document_id === "doc-upload-4");
		const stale = reply.chunks.filter((chunk) => chunk.document_id === "doc-upload-1" || chunk.document_id === "doc-upload-2");
		expect(current.length).toBe(2);
		expect(current.every((chunk) => chunk.commit === FF_NEW)).toBe(true);
		expectUnpinned(stale);
	}, 60_000);

	test("anonymous and guest writes stay fail-closed with no plane upload", async () => {
		const fake = new RagflowFake();
		const { live } = serviceWith(fake);
		const denied = await live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, null);
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");

		const guest = serviceWith(fake, { SUBSTRATE_VM_GUEST: "1" });
		const refused = await guest.live.ingestDocs({ dataset: "agent-skills", commit: FF_NEW, pages: [SKILL_PAGE] }, "substrate");
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("vm-guest");
		expect(fake.uploads).toHaveLength(0);

		const bare = new Substrate(loadConfig({}), { index: null, greptime: null });
		const degraded = await bare.searchDocs({ question: "what skills exist?" }, "omp");
		expect(degraded).toMatchObject({ chunks: [], degraded: true, reason: "ragflow-not-configured" });
	});
});
