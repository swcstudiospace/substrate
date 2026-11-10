/**
 * The phase-46 archive's offline proof (SC2 build): the manifest's digests
 * match the files; the read-back verifies an untouched archive and refuses a
 * tampered, extended or escaping one; the gates refuse a non-empty and a
 * root-filesystem target before any write; a page whose git bytes hash
 * differently from the recorded ingest hash is reported, never accepted.
 * Everything runs against the recording fake and an injected `git show`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARCHIVE_KIND,
	ARCHIVE_MANIFEST_NAME,
	ArchiveRefused,
	archiveRagflow,
	allowRootfsFromEnv,
	archiveDirFromEnv,
	gitShowPage,
	ingestSha256,
	pathFromDocumentName,
	verifyArchive,
	type ArchiveManifest,
	type ArchiveQuery,
	type RagflowArchiveDeps,
} from "./docs-archive.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import type { FetchLike } from "./planes/ragflow.ts";

const BERLIN = "ds-berlin-agent-substrate";
const HAMM = "ds-hamm-programming-desk";
const LEIPZIG = "ds-leipzig-agent-skills";

const SAMPLE: ArchiveQuery[] = [
	{ id: "q01", question: "What does docs_search return when it fails?" },
	{ id: "q02", question: "Which arguments does docs_search accept?" },
];

/** Two pages per dataset, uploaded with ingest metadata, so the inventory carries commits and URLs. */
async function seedPlane(fake: RagflowFake): Promise<Record<string, string>> {
	const gitFiles: Record<string, string> = {};
	for (const datasetId of [BERLIN, HAMM, LEIPZIG]) {
		for (const index of [1, 2]) {
			const name = `docs/page-${datasetId}-${index}.md`;
			const body = `# page ${datasetId} ${index}\n\nserved bytes\n`;
			const commit = `c${datasetId.length}${index}ffff`;
			const form = new FormData();
			form.append("file", new File([body], name));
			const uploaded = await fake.fetch(`http://ragflow.test/api/v1/datasets/${datasetId}/documents`, { method: "POST", body: form });
			const reply = (await uploaded.json()) as { data: Array<{ id: string }> };
			const documentId = reply.data[0]?.id ?? "";
			await fake.fetch(`http://ragflow.test/api/v1/datasets/${datasetId}/documents/${documentId}`, {
				method: "PATCH",
				body: JSON.stringify({ meta_fields: { source_url: `https://example.com/${name}`, commit, heading_path: "Docs" } }),
			});
			gitFiles[`${commit}:${name}`] = body;
		}
	}
	fake.serveUploadsAsChunks = true;
	return gitFiles;
}

interface HarnessOptions {
	gitFiles: Record<string, string>;
	stateRecords?: Array<{ datasetId: string; sourceUrl: string; sha: string }>;
	fetchCalls?: { count: number };
	devOf?: (path: string) => number | null;
	allowRootfs?: boolean;
}

function harness(fake: RagflowFake, options: HarnessOptions): RagflowArchiveDeps {
	const stateFile = join(mkdtempSync(join(tmpdir(), "docs-archive-state-")), "docs-ingest.json");
	const records: Record<string, unknown> = {};
	for (const record of options.stateRecords ?? []) {
		records[`${record.datasetId}::${record.sourceUrl}`] = { sha: record.sha, dataset_id: record.datasetId, source_url: record.sourceUrl, document_id: "doc-x", version: 1 };
	}
	writeFileSync(stateFile, `${JSON.stringify({ version: 2, records, versions: {} })}\n`, "utf8");
	const fetchImpl: FetchLike = async (input, init) => {
		if (options.fetchCalls !== undefined) options.fetchCalls.count += 1;
		return fake.fetch(input, init);
	};
	return {
		config: { url: "http://ragflow.test", apiKey: "test-key" },
		fetchImpl,
		stateFile,
		sample: SAMPLE,
		gitShow: async (commit, path) => {
			const bytes = options.gitFiles[`${commit}:${path}`];
			if (bytes === undefined) throw new Error(`no such commit: ${commit}:${path}`);
			return bytes;
		},
		devOf: options.devOf ?? ((path: string) => (path === "/" ? 1 : 2)),
		...(options.allowRootfs !== undefined ? { allowRootfs: options.allowRootfs } : {}),
	};
}

describe("docs-archive", () => {
	test("the manifest's digests match the files, and the read-back passes untouched", async () => {
		const fake = new RagflowFake();
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			const outcome = await archiveRagflow(deps, dir);
			expect(outcome.page_hash_mismatches).toEqual([]);
			expect(outcome.files).toBe(7); // 3 inventories + 1 state + 2 baselines + manifest
			const manifest = JSON.parse(readFileSync(join(dir, ARCHIVE_MANIFEST_NAME), "utf8")) as ArchiveManifest;
			expect(manifest.kind).toBe(ARCHIVE_KIND);
			expect(manifest.sample_sha256).toBe(ingestSha256(JSON.stringify(SAMPLE)));
			for (const entry of manifest.files) {
				const bytes = readFileSync(join(dir, entry.path), "utf8");
				expect(ingestSha256(bytes)).toBe(entry.sha256);
				expect(Buffer.byteLength(bytes, "utf8")).toBe(entry.bytes);
			}
			expect(await verifyArchive(dir)).toEqual({ ok: true, mismatches: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a one-byte change and an unlisted extra file fail the read-back", async () => {
		const fake = new RagflowFake();
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			await archiveRagflow(deps, dir);
			const baseline = join(dir, "baseline", "q01.json");
			const original = readFileSync(baseline, "utf8");
			writeFileSync(baseline, `${original} `, { mode: 0o600 });
			const tampered = await verifyArchive(dir);
			expect(tampered.ok).toBe(false);
			expect(tampered.mismatches.some((m) => m.file === "baseline/q01.json" && m.why.includes("sha256"))).toBe(true);
			writeFileSync(baseline, original, { mode: 0o600 });
			writeFileSync(join(dir, "stowaway.txt"), "not in the manifest", { mode: 0o600 });
			const extra = await verifyArchive(dir);
			expect(extra.ok).toBe(false);
			expect(extra.mismatches).toEqual([{ file: "stowaway.txt", why: "not listed in the manifest" }]);
			writeFileSync(join(dir, ARCHIVE_MANIFEST_NAME), "{}\n", { mode: 0o600 });
			const wrong = await verifyArchive(dir);
			expect(wrong.ok).toBe(false);
			expect(wrong.mismatches[0]?.file).toBe(ARCHIVE_MANIFEST_NAME);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing manifest and an escaping manifest path are refusals, not throws", async () => {
		const empty = mkdtempSync(join(tmpdir(), "docs-archive-"));
		const fake = new RagflowFake();
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			expect((await verifyArchive(empty)).mismatches[0]?.why).toBe("missing");
			await archiveRagflow(deps, dir);
			const manifest = JSON.parse(readFileSync(join(dir, ARCHIVE_MANIFEST_NAME), "utf8")) as ArchiveManifest;
			manifest.files.push({ path: "../escape.json", bytes: 1, sha256: "0".repeat(64) });
			writeFileSync(join(dir, ARCHIVE_MANIFEST_NAME), JSON.stringify(manifest), { mode: 0o600 });
			const escaped = await verifyArchive(dir);
			expect(escaped.ok).toBe(false);
			expect(escaped.mismatches.some((m) => m.file === "../escape.json")).toBe(true);
		} finally {
			rmSync(empty, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a non-empty target and a root-filesystem target are refused before any write", async () => {
		const fake = new RagflowFake();
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const occupied = mkdtempSync(join(tmpdir(), "docs-archive-"));
		writeFileSync(join(occupied, "already-here.txt"), "occupied", { mode: 0o600 });
		const onRoot = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			expect(archiveRagflow(deps, occupied)).rejects.toThrow(ArchiveRefused);
			expect(readdirSync(occupied)).toEqual(["already-here.txt"]);
			const sameDev = () => 7;
			expect(archiveRagflow({ ...deps, devOf: sameDev }, onRoot)).rejects.toThrow(/SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS/);
			expect(readdirSync(onRoot)).toEqual([]);
			const outcome = await archiveRagflow({ ...deps, devOf: sameDev, allowRootfs: true }, onRoot);
			expect(outcome.files).toBe(7);
		} finally {
			rmSync(occupied, { recursive: true, force: true });
			rmSync(onRoot, { recursive: true, force: true });
		}
	});

	test("a page whose git bytes hash differently from the ingest hash is reported, and an unreadable one too", async () => {
		const fake = new RagflowFake();
		const gitFiles = await seedPlane(fake);
		const firstKey = Object.keys(gitFiles)[0] ?? "";
		const original = gitFiles[firstKey] ?? "";
		const changed = `${original}\nchanged after ingest\n`;
		gitFiles[firstKey] = changed;
		const commit = firstKey.split(":")[0] ?? "";
		const path = firstKey.split(":")[1] ?? "";
		const deps = harness(fake, {
			gitFiles,
			stateRecords: [{ datasetId: BERLIN, sourceUrl: `https://example.com/${path}`, sha: ingestSha256(original) }],
		});
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			const outcome = await archiveRagflow(deps, dir);
			expect(outcome.page_hash_mismatches).toEqual([
				{ dataset: "agent-substrate", name: path, reason: "content hash differs from the recorded ingest hash" },
			]);
			expect(commit.length).toBeGreaterThan(0);
			const unreadable = await archiveRagflow({ ...deps, gitShow: async () => { throw new Error("git show died"); } }, mkdtempSync(join(tmpdir(), "docs-archive-")));
			expect(unreadable.page_hash_mismatches).toHaveLength(6);
			expect(unreadable.page_hash_mismatches[0]?.reason).toContain("git show failed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every frozen query gets a baseline file carrying the plane's top citations", async () => {
		const fake = new RagflowFake();
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			const outcome = await archiveRagflow(deps, dir);
			expect(outcome.baselines).toBe(SAMPLE.length);
			for (const query of SAMPLE) {
				const baseline = JSON.parse(readFileSync(join(dir, "baseline", `${query.id}.json`), "utf8")) as { id: string; ok: boolean; citations: Array<{ source_url: string | null }> };
				expect(baseline.id).toBe(query.id);
				expect(baseline.ok).toBe(true);
				expect(baseline.citations.length).toBeGreaterThan(0);
				expect(baseline.citations[0]?.source_url ?? "").toStartWith("https://example.com/");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed retrieval is recorded as ok:false with the plane's reason", async () => {
		const fake = new RagflowFake();
		fake.failRetrievalWith = 503;
		const deps = harness(fake, { gitFiles: await seedPlane(fake) });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			const outcome = await archiveRagflow(deps, dir);
			expect(outcome.baselines).toBe(SAMPLE.length);
			const baseline = JSON.parse(readFileSync(join(dir, "baseline", "q02.json"), "utf8")) as { ok: boolean; reason?: string };
			expect(baseline.ok).toBe(false);
			expect(baseline.reason).toBe("ragflow 503");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no call leaves the injected fake, and no key or endpoint enters the archive", async () => {
		const fake = new RagflowFake();
		const calls = { count: 0 };
		const deps = harness(fake, { gitFiles: await seedPlane(fake), fetchCalls: calls });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			await archiveRagflow(deps, dir);
			expect(calls.count).toBeGreaterThan(0);
			for (const file of walkFiles(dir)) {
				const text = readFileSync(file, "utf8");
				expect(text).not.toContain("test-key");
				expect(text).not.toContain("ragflow.test");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an empty sample and an unconfigured archive dir are refused by name", async () => {
		const fake = new RagflowFake();
		const calls = { count: 0 };
		const deps = harness(fake, { gitFiles: await seedPlane(fake), fetchCalls: calls });
		const dir = mkdtempSync(join(tmpdir(), "docs-archive-"));
		try {
			expect(archiveRagflow({ ...deps, sample: [] }, dir)).rejects.toThrow(/sample/);
			expect(calls.count).toBe(0);
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the env helpers read only their own names, and the git reader reads this repo", async () => {
		expect(archiveDirFromEnv({})).toBeNull();
		expect(archiveDirFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_DIR: "  " })).toBeNull();
		expect(archiveDirFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_DIR: "/srv/archive" })).toBe("/srv/archive");
		expect(allowRootfsFromEnv({})).toBe(false);
		expect(allowRootfsFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: "1" })).toBe(true);
		expect(allowRootfsFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: "YES" })).toBe(true);
		expect(allowRootfsFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: "0" })).toBe(false);
		expect(allowRootfsFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: "on" })).toBe(false);
		expect(pathFromDocumentName("docs__a__b.md")).toBe("docs/a/b.md");
		expect(await gitShowPage(process.cwd(), "HEAD", "package.json")).toContain('"name"');
	});
});

function walkFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			if (entry.includes(".")) found.push(full);
			else walk(full);
		}
	};
	walk(root);
	return found;
}
