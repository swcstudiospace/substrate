/**
 * The loopback fake RAGFlow, driven in-process through the real
 * `RagflowClient` — the proof the fake speaks the client's exact dialect.
 * No test here touches a real RAGFlow; every URL is a `startFakeRagflow`
 * loopback server that closes after the test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagflowClient } from "./docs/ragflow.ts";
import {
	emptyFakeState,
	readRagflowMode,
	startFakeRagflow,
	type FakeRagflowHandle,
} from "./rehearsal-fake-ragflow.ts";

const made: string[] = [];
const handles: FakeRagflowHandle[] = [];
afterEach(() => {
	for (const handle of handles.splice(0)) handle.close();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-ragflow-"));
	made.push(dir);
	return dir;
}

function clientFor(handle: FakeRagflowHandle, timeoutMs = 5000): RagflowClient {
	return new RagflowClient({ url: handle.url, apiKey: "fixture-key", timeoutMs, problem: null });
}

describe("dataset and document round trip", () => {
	test("ensure, upload, list, parse, update, retrieval, delete", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		const client = clientFor(handle);
		const id = await client.ensureDataset("harness-docs");
		expect((await client.listDatasets()).some((row) => row.id === id && row.name === "harness-docs")).toBe(true);
		const uploaded = await client.uploadDocuments(id, [{ filename: "guide.md", content: "hello smoke marker" }]);
		expect(uploaded).toHaveLength(1);
		const docId = uploaded[0]?.documentId ?? "";
		expect(docId.length).toBeGreaterThan(0);
		const before = await client.listDocuments(id);
		expect(before.find((doc) => doc.id === docId)?.run).toBe("UNSTART");
		await client.parseDocuments(id, [docId]);
		expect((await client.listDocuments(id)).find((doc) => doc.id === docId)?.run).toBe("DONE");
		await client.updateDocument(id, docId, { name: "renamed.md", metaFields: { source_url: "u", commit: "c" } });
		const updated = (await client.listDocuments(id)).find((doc) => doc.id === docId);
		expect(updated?.name).toBe("renamed.md");
		expect(updated?.metaFields.source_url).toBe("u");
		const hits = await client.retrieval({ question: "smoke marker", datasetIds: [id], pageSize: 5 });
		expect(hits).toHaveLength(1);
		expect(hits[0]?.documentId).toBe(docId);
		expect(hits[0]?.datasetId).toBe(id);
		expect(hits[0]?.content).toBe("hello smoke marker");
		await client.deleteDocuments(id, [docId]);
		expect(await client.listDocuments(id)).toHaveLength(0);
	});

	test("retrieval honours page_size and scores the marker first", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		const client = clientFor(handle);
		const id = await client.ensureDataset("sized");
		await client.uploadDocuments(id, [
			{ filename: "a.md", content: "unrelated filler text here" },
			{ filename: "b.md", content: "unrelated filler text here" },
			{ filename: "c.md", content: "the sought marker phrase lives here" },
		]);
		const hits = await client.retrieval({ question: "sought marker phrase", datasetIds: [id], pageSize: 2 });
		expect(hits).toHaveLength(2);
		expect(hits[0]?.content).toContain("sought marker phrase");
	});
});

describe("scriptable failure modes", () => {
	test("error mode answers a non-zero code", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		handle.setMode({ mode: "error", code: 102, message: "fixture error" });
		await expect(clientFor(handle).listDatasets()).rejects.toThrow("ragflow error 102");
		handle.setMode(null);
		expect(await clientFor(handle).listDatasets()).toEqual([]);
	});

	test("malformed mode answers non-JSON", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		handle.setMode({ mode: "malformed" });
		await expect(clientFor(handle).listDatasets()).rejects.toThrow("ragflow returned non-JSON");
		handle.setMode(null);
		expect(await clientFor(handle).listDatasets()).toEqual([]);
	});

	test("http-error mode answers a non-2xx status", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		handle.setMode({ mode: "http-error", status: 500 });
		await expect(clientFor(handle).listDatasets()).rejects.toThrow("ragflow 500");
		handle.setMode(null);
		expect(await clientFor(handle).listDatasets()).toEqual([]);
	});

	test("timeout mode outlasts the client budget", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		handle.setMode({ mode: "timeout", sleepMs: 400 });
		await expect(clientFor(handle, 50).listDatasets()).rejects.toThrow("ragflow timeout");
		handle.setMode(null);
		expect(await clientFor(handle).listDatasets()).toEqual([]);
	});
});

describe("run-dir state and mode file", () => {
	test("mutations persist to state.json for the smoke to read", async () => {
		const runDir = tempDir();
		const handle = startFakeRagflow({ runDir });
		handles.push(handle);
		const client = clientFor(handle);
		const id = await client.ensureDataset("persisted");
		await client.uploadDocuments(id, [{ filename: "guide.md", content: "kept content" }]);
		const raw = readFileSync(join(runDir, "ragflow-fixture", "state.json"), "utf8");
		const persisted = JSON.parse(raw) as { datasets: Record<string, { docs: Record<string, { content: string }> }>; calls: { uploads: number } };
		const docs = Object.values(persisted.datasets).flatMap((dataset) => Object.values(dataset.docs));
		expect(docs.some((doc) => doc.content === "kept content")).toBe(true);
		expect(persisted.calls.uploads).toBe(1);
	});

	test("mode.json scripts the fake without a restart", async () => {
		const runDir = tempDir();
		const handle = startFakeRagflow({ runDir });
		handles.push(handle);
		const modeFile = join(runDir, "ragflow-fixture", "mode.json");
		writeFileSync(modeFile, `${JSON.stringify({ mode: "error", code: 777, message: "from file" })}\n`);
		await expect(clientFor(handle).listDatasets()).rejects.toThrow("ragflow error 777");
		writeFileSync(modeFile, `${JSON.stringify({ mode: "normal" })}\n`);
		expect(await clientFor(handle).listDatasets()).toEqual([]);
	});

	test("readRagflowMode falls back to normal on a missing or broken file", () => {
		expect(readRagflowMode(join(tempDir(), "absent.json"), null).mode).toBe("normal");
		const runDir = tempDir();
		const broken = join(runDir, "mode.json");
		writeFileSync(broken, "not json{");
		expect(readRagflowMode(broken, null).mode).toBe("normal");
		expect(readRagflowMode(broken, { mode: "error" }).mode).toBe("error");
	});
});

describe("isolation", () => {
	test("the fake binds loopback only", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		expect(new URL(handle.url).hostname).toBe("127.0.0.1");
	});

	test("unknown paths answer a non-zero code, never a stack trace", async () => {
		const handle = startFakeRagflow();
		handles.push(handle);
		const res = await fetch(`${handle.url}/api/v1/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code?: number };
		expect(body.code).toBe(404);
	});
});
