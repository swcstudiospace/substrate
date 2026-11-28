/**
 * Phase 100 (F1) fake tests: cache-aside STATE ingest with last-good fallback.
 * Fake `fetchImpl` only — no live LightRAG server.
 */
import { describe, expect, test } from "bun:test";
import type { LightragConfig } from "./config.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import {
	emptyStateIngestFile,
	ingestStateReflectDocument,
	type StateIngestFile,
	type StateIngestStore,
	type StateReflectDocument,
} from "./state-ingest.ts";

const CONFIG: LightragConfig = { url: "http://lightrag.test", apiKey: "k" };
const SHA = "c".repeat(64);
const NOW = 1_700_000_000_000;

function doc(overrides: Partial<StateReflectDocument> = {}): StateReflectDocument {
	return {
		name: "STATE.md",
		content: "# STATE\nfresh",
		source_url: "file:///wt/.planning/STATE.md",
		commit: "deadbeef",
		graph_id: "checkout-a",
		phase: "state",
		provenance: { worktree: "/wt", project: "agent-substrate", agent: "substrate", session: "planning-refresh", event: "planning-changed", content_hash: SHA },
		...overrides,
	};
}

function memoryStore(seed: StateIngestFile = emptyStateIngestFile()): StateIngestStore & { current: StateIngestFile } {
	const holder = { current: seed };
	return {
		get current(): StateIngestFile {
			return holder.current;
		},
		async load(): Promise<StateIngestFile> {
			return holder.current;
		},
		async save(file: StateIngestFile): Promise<void> {
			holder.current = file;
		},
	};
}

/** A scripted LightRAG fake: route handlers answer per pathname. */
function fakeFetch(routes: Record<string, (url: string, init?: RequestInit) => Response>, calls: string[]): FetchLike {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
		const handler = routes[new URL(url).pathname];
		if (!handler) return Response.json({ status: "error", message: "no fake route" }, { status: 500 });
		return handler(url, init);
	};
}

const okUpload = (trackId: string) => () => Response.json({ status: "success", track_id: trackId });
// Colon-free names take the multipart `/documents/upload` route; names with a
// colon take `/documents/text`. The fakes cover both.
const okMultipart = (trackId: string) => () => Response.json({ status: "success", track_id: trackId });
const okTrack = (ids: string[]) => () =>
	Response.json({ track_id: "trk-1", documents: ids.map((id) => ({ id, status: "success", file_path: "STATE.md" })), total_count: ids.length });
const okScan = () => Response.json({ status: "success" });
const idlePipeline = () => Response.json({ busy: false });

const opts = { sleep: async (): Promise<void> => {}, nowMs: () => NOW };

describe("ingestStateReflectDocument", () => {
	test("success updates last-good and the freshness timestamp", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch(
			{ "/documents/upload": okMultipart("trk-1"), "/documents/text": okUpload("trk-1"), "/documents/track_status/trk-1": okTrack(["doc-1"]), "/documents/scan": okScan, "/documents/pipeline_status": idlePipeline },
			calls,
		);
		const store = memoryStore();
		const outcome = await ingestStateReflectDocument(CONFIG, doc(), fetch, store, opts);
		expect(outcome).toEqual({ ok: true, track_id: "trk-1", doc_ids: ["doc-1"] });
		expect(store.current.last_good_state_reflect).toEqual({
			track_id: "trk-1",
			doc_ids: ["doc-1"],
			ingested_at: new Date(NOW).toISOString(),
			commit: "deadbeef",
			graph_id: "checkout-a",
			phase: "state",
		});
		expect(store.current.last_attempt).toEqual({ at: new Date(NOW).toISOString(), ok: true, reason: null });
	});

	test("failure keeps last-good, stamps the attempt, and never throws", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch({ "/documents/upload": () => Response.json({ status: "error", message: "boom" }), "/documents/text": () => Response.json({ status: "error", message: "boom" }) }, calls);
		const store = memoryStore({
			last_good_state_reflect: { track_id: "trk-0", doc_ids: ["doc-0"], ingested_at: new Date(NOW - 60_000).toISOString(), commit: "old", graph_id: "g", phase: "p" },
			last_attempt: null,
		});
		const outcome = await ingestStateReflectDocument(CONFIG, doc(), fetch, store, opts);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.last_good?.track_id).toBe("trk-0");
		expect(store.current.last_good_state_reflect?.track_id).toBe("trk-0");
		expect(store.current.last_attempt).toEqual({ at: new Date(NOW).toISOString(), ok: false, reason: expect.stringContaining("boom") });
	});

	test("409 same-name retries once after delete-first of the prior doc ids", async () => {
		const calls: string[] = [];
		let uploads = 0;
		const fetch = fakeFetch(
			{
				"/documents/upload": () => {
					uploads += 1;
					return uploads === 1 ? Response.json({ detail: "same name" }, { status: 409 }) : Response.json({ status: "success", track_id: "trk-2" });
				},
				"/documents/text": () => Response.json({ status: "success", track_id: "trk-2" }),
				"/documents/delete_document": () => Response.json({ status: "deletion_started" }),
				"/documents/track_status/trk-2": okTrack(["doc-2"]),
				"/documents/scan": okScan,
				"/documents/pipeline_status": idlePipeline,
			},
			calls,
		);
		const store = memoryStore({
			last_good_state_reflect: { track_id: "trk-1", doc_ids: ["doc-1"], ingested_at: new Date(NOW - 60_000).toISOString(), commit: "old", graph_id: "g", phase: "p" },
			last_attempt: null,
		});
		const outcome = await ingestStateReflectDocument(CONFIG, doc(), fetch, store, opts);
		expect(outcome).toEqual({ ok: true, track_id: "trk-2", doc_ids: ["doc-2"] });
		expect(calls.filter((call) => call === "DELETE /documents/delete_document")).toHaveLength(1);
		expect(store.current.last_good_state_reflect?.track_id).toBe("trk-2");
	});

	test("409 with no prior doc ids fails with last-good intact", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch({ "/documents/upload": () => Response.json({ detail: "same name" }, { status: 409 }), "/documents/text": () => Response.json({ detail: "same name" }, { status: 409 }) }, calls);
		const store = memoryStore();
		const outcome = await ingestStateReflectDocument(CONFIG, doc(), fetch, store, opts);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("409");
		expect(outcome.last_good).toBeNull();
	});

	test("track_status that never lists documents is a poll-timeout failure", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch(
			{ "/documents/upload": okMultipart("trk-9"), "/documents/text": okUpload("trk-9"), "/documents/track_status/trk-9": okTrack([]), "/documents/scan": okScan, "/documents/pipeline_status": idlePipeline },
			calls,
		);
		const store = memoryStore();
		const outcome = await ingestStateReflectDocument(CONFIG, doc(), fetch, store, { ...opts, maxTrackPolls: 2 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("track_status");
		expect(store.current.last_good_state_reflect).toBeNull();
	});

	test("missing T0 provenance refuses before any network I/O", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch({}, calls);
		const store = memoryStore();
		const outcome = await ingestStateReflectDocument(CONFIG, doc({ provenance: { worktree: "", project: "", event: "", content_hash: "zzz" } }), fetch, store, opts);
		expect(outcome.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
