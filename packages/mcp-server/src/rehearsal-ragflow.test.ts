/**
 * The RAGFlow fixture builder: everything the docs plane touches, deleted and
 * rebuilt inside one instance's run directory. No test here names a host, a
 * token or a production path.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAGFLOW_FIXTURE_ENV_KEYS } from "./rehearsal-env.ts";
import {
	buildRagflowFixture,
	ragflowFixturePaths,
	RAGFLOW_FIXTURE_DATASET,
	RAGFLOW_FIXTURE_EMBEDDING_MODEL,
	RAGFLOW_FIXTURE_SLUG,
	RAGFLOW_FIXTURE_TIMEOUT_MS,
} from "./rehearsal-ragflow.ts";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ragflow-fixture-"));
	made.push(dir);
	return dir;
}

describe("ragflowFixturePaths", () => {
	test("keeps the state dir and the fixture inside the run", () => {
		const runDir = tempDir();
		const paths = ragflowFixturePaths(runDir);
		expect(paths.stateDir).toBe(join(runDir, "docs"));
		expect(paths.fixture).toBe(join(runDir, "ragflow-fixture"));
	});

	test("refuses a relative run directory", () => {
		expect(() => ragflowFixturePaths("relative/run")).toThrow("not absolute");
	});
});

describe("buildRagflowFixture", () => {
	test("writes the registry, the mode file and exactly the six env keys", () => {
		const runDir = tempDir();
		const fixture = buildRagflowFixture(runDir, { url: "http://127.0.0.1:9", apiKey: "k" });
		expect(Object.keys(fixture.env).sort()).toEqual([...RAGFLOW_FIXTURE_ENV_KEYS].sort());
		expect(fixture.env.RAGFLOW_URL).toBe("http://127.0.0.1:9");
		expect(fixture.env.SUBSTRATE_DOCS_STATE).toBe(join(runDir, "docs"));
		expect(fixture.env.SUBSTRATE_DOCS_DATASETS).toBe(join(runDir, "ragflow-fixture", "registry.json"));
		expect(fixture.env.SUBSTRATE_DOCS_EMBEDDING_MODEL).toBe(RAGFLOW_FIXTURE_EMBEDDING_MODEL);
		expect(fixture.env.SUBSTRATE_RAGFLOW_TIMEOUT_MS).toBe(String(RAGFLOW_FIXTURE_TIMEOUT_MS));
		const registry = JSON.parse(readFileSync(fixture.registryFile, "utf8")) as Array<Record<string, unknown>>;
		expect(registry).toHaveLength(1);
		expect(registry[0]?.name).toBe(RAGFLOW_FIXTURE_DATASET);
		expect(registry[0]?.slug).toBe(RAGFLOW_FIXTURE_SLUG);
		expect(registry[0]?.exclude).toContain("docs/receipts/**");
		expect(JSON.parse(readFileSync(fixture.modeFile, "utf8"))).toEqual({ mode: "normal" });
		expect(fixture.entry.name).toBe(RAGFLOW_FIXTURE_DATASET);
	});

	test("the registry holds no product slug", () => {
		const runDir = tempDir();
		const fixture = buildRagflowFixture(runDir, { url: "http://127.0.0.1:9", apiKey: "k" });
		const raw = readFileSync(fixture.registryFile, "utf8");
		for (const slug of ["agent-substrate", "agent-skills", "programming-desk", "kanbanos", "desklanes", "clippyos", "auctioning"]) {
			expect(raw).not.toContain(slug);
		}
	});

	test("a rebuild clears a stale manifest and fixture", () => {
		const runDir = tempDir();
		const first = buildRagflowFixture(runDir, { url: "http://127.0.0.1:9", apiKey: "k" });
		writeFileSyncMarker(first);
		const second = buildRagflowFixture(runDir, { url: "http://127.0.0.1:9", apiKey: "k" });
		expect(() => readFileSync(join(second.stateDir, "stale.json"), "utf8")).toThrow();
		expect(JSON.parse(readFileSync(second.modeFile, "utf8"))).toEqual({ mode: "normal" });
	});
});

function writeFileSyncMarker(fixture: { stateDir: string }): void {
	writeFileSync(join(fixture.stateDir, "stale.json"), "{}\n");
}
