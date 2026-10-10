/**
 * Plan 25-02 Task 1: docs_ingest gates plus hash idempotency against the
 * fake. All six refusals fail closed with locator-only warning events;
 * unchanged hashes skip, changed hashes replace; images strip and count.
 */
import { describe, expect, test } from "bun:test";
import {
	ingestDocs,
	stripRemoteImages,
	type IngestDeps,
	type IngestInput,
	type IngestOutcome,
	type IngestRecord,
} from "./docs-ingest.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import type { EventInput } from "./types.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function harness(
	fake: RagflowFake,
	over: Partial<Pick<IngestDeps, "surface" | "vmGuest" | "roots" | "config">> = {},
) {
	const events: EventInput[] = [];
	const seen = new Map<string, IngestRecord>();
	const deps: IngestDeps = {
		config: CONFIG,
		emit: async (event: EventInput): Promise<unknown> => {
			events.push(event);
			return { stored: false };
		},
		surface: "omp",
		seen,
		fetchImpl: fake.fetch,
		...over,
	};
	const ingest = (input: IngestInput): Promise<IngestOutcome> => ingestDocs(deps, input);
	return { events, seen, ingest };
}

const PAGE = {
	path: "docs/data-planes.md",
	source_url: "https://example.com/agent-substrate/data-planes",
	body: "The substrate is the only door to the data planes.",
};

describe("docs_ingest gates", () => {
	test("ingests a clean page with metadata and a note event", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", commit: "abc123", pages: [PAGE] });
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.status).toBe("ingested");
		expect(fake.uploads).toHaveLength(1);
		expect(fake.uploads[0]?.metadata).toMatchObject({
			source_url: PAGE.source_url,
			commit: "abc123",
		});
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.payload).toMatchObject({ action: "docs.ingest", dataset_id: "ds-berlin-agent-substrate" });
	});

	test("refuses on a redactor finding and never uploads", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: "paste sk-proj-abcdefghij1234567890 here" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("secret-findings");
		expect(outcome.rules).toContain("openai-proj");
		expect(fake.uploads).toHaveLength(0);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.ingest", status: "refused" });
		expect(JSON.stringify(warnings[0]?.payload)).not.toContain("sk-proj-");
	});

	test("refuses a page without a source URL", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [{ path: PAGE.path, body: PAGE.body }] });
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("no-source-url");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a path outside the configured roots", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, path: "../secrets.txt" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("outside-roots");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a page over 1 MB and a call over 5 MB", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const big = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: `x${"y".repeat(1_000_000)}` }],
		});
		if (big.ok) throw new Error("expected a page refusal");
		expect(big.reason).toBe("page-too-large");

		const pages = [1, 2, 3, 4, 5, 6].map((n) => ({ ...PAGE, path: `docs/page-${n}.md`, body: `z${"y".repeat(900_000)}` }));
		const wide = await ingest({ dataset: "agent-substrate", pages });
		if (wide.ok) throw new Error("expected a call refusal");
		expect(wide.reason).toBe("call-too-large");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses unauthenticated callers and VM guests before any network call", async () => {
		const anonymous = new RagflowFake();
		const anonymousHarness = harness(anonymous, { surface: null });
		const denied = await anonymousHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");
		expect(anonymous.requests).toHaveLength(0);

		const guest = new RagflowFake();
		const guestHarness = harness(guest, { vmGuest: true });
		const refused = await guestHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("vm-guest");
		expect(guest.requests).toHaveLength(0);
	});
});

describe("docs_ingest idempotency and images", () => {
	test("skips unchanged hashes and replaces changed ones", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const again = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results[0]?.status).toBe("unchanged");
		expect(fake.uploads).toHaveLength(1);

		const changed = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] });
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
	});

	test("strips remote images pre-upload and counts them", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [
				{
					...PAGE,
					body: 'See <img src="https://example.com/logo.png"> and ![arch](https://example.com/a.png) plus ![local](./b.png).',
				},
			],
		});
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.stripped_images).toBe(2);
		expect(fake.uploads[0]?.content).not.toContain("https://example.com/logo.png");
		expect(fake.uploads[0]?.content).toContain("./b.png");
	});

	test("a parse that never finishes is a timeout refusal", async () => {
		const fake = new RagflowFake();
		fake.parseBehavior = "never";
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (outcome.ok) throw new Error("expected a timeout");
		expect(outcome.reason).toBe("parse-timeout");
	});
});

describe("stripRemoteImages", () => {
	test("counts tags and markdown images, keeps local paths", () => {
		const stripped = stripRemoteImages('A <img src="http://x/y.png"> B ![c](https://x/z.png) D ![e](./f.png)');
		expect(stripped.stripped).toBe(2);
		expect(stripped.body).toContain("./f.png");
	});
});
