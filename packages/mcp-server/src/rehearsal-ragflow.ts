/**
 * The RAGFlow fixture for the rehearsal harness (D25-24): everything the docs
 * plane touches, built inside one instance's run directory.
 *
 *   <run>/ragflow-fixture/registry.json   the fixture registry: one dataset,
 *       `harness-docs`, whose slug and roots the smoke owns — no product slug
 *   <run>/ragflow-fixture/mode.json       the fake's scriptable mode
 *       (`normal`, `timeout`, `error`, `malformed`, `http-error`); the smoke
 *       rewrites it to prove each failure reason without a restart
 *   <run>/ragflow-fixture/state.json      what the fake received, persisted on
 *       every mutation, so the smoke asserts stripping and secrecy by reading
 *       a file, never by querying a second door
 *   <run>/docs                            `SUBSTRATE_DOCS_STATE`: the manifest
 *       lives here, never at the production default
 *
 * The builder refuses a run directory that is not absolute or whose derived
 * paths would leave it. The fixture is deleted and rebuilt on every call, so
 * a crashed `up` can never make the next proof answer `unchanged`. Nothing
 * here names a host, a token or a production path: the fake's URL is filled
 * in by `scripts/rehearsal.ts` once it has picked the loopback port.
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { RAGFLOW_FIXTURE_ENV_KEYS } from "./rehearsal-env.ts";
import type { DatasetEntry } from "./docs/registry.ts";

/** The one dataset the fixture registry holds: the smoke owns its slug and roots. */
export const RAGFLOW_FIXTURE_DATASET = "harness-docs";

/** Slug the smoke's `source_url`s carry; no product slug appears in a fixture. */
export const RAGFLOW_FIXTURE_SLUG = "rehearsal/docs-fixture";

/** Embedding model recorded on fixture datasets: inert, never provisioned. */
export const RAGFLOW_FIXTURE_EMBEDDING_MODEL = "fixture-embedding-model";

/** Client timeout inside the fixture: short enough that `timeout` mode proves fast. */
export const RAGFLOW_FIXTURE_TIMEOUT_MS = 3000;

export interface RagflowFixture {
	/** What the scratch server is started with, in addition to its usual environment. */
	env: Record<(typeof RAGFLOW_FIXTURE_ENV_KEYS)[number], string>;
	/** The fixture registry file `SUBSTRATE_DOCS_DATASETS` points at. */
	registryFile: string;
	/** The fake's scriptable mode file. */
	modeFile: string;
	/** What the fake received, persisted on every mutation. */
	stateFile: string;
	/** The manifest directory `SUBSTRATE_DOCS_STATE` points at. */
	stateDir: string;
	/** The registry entry the smoke ingests into. */
	entry: DatasetEntry;
}

/** The directories an instance's docs state and fixture live in, and the refusal for a run directory that cannot hold them. */
export function ragflowFixturePaths(runDir: string): { stateDir: string; fixture: string } {
	if (!isAbsolute(runDir)) throw new Error(`ragflow fixture refused: run directory ${runDir} is not absolute`);
	const stateDir = join(runDir, "docs");
	const fixture = join(runDir, "ragflow-fixture");
	for (const path of [stateDir, fixture]) {
		const inside = relative(resolve(runDir), resolve(path));
		if (inside.startsWith("..") || isAbsolute(inside)) {
			throw new Error(`ragflow fixture refused: ${path} is outside the run directory`);
		}
	}
	return { stateDir, fixture };
}

export interface BuildRagflowFixtureOptions {
	/** The fake's loopback URL, filled in once the harness picked the port. */
	url: string;
	/** Bearer the client sends; the fake accepts and ignores it. */
	apiKey: string;
}

/** Delete and rebuild the fixture inside `runDir`. */
export function buildRagflowFixture(runDir: string, options: BuildRagflowFixtureOptions): RagflowFixture {
	const { stateDir, fixture } = ragflowFixturePaths(runDir);
	rmSync(stateDir, { recursive: true, force: true });
	rmSync(fixture, { recursive: true, force: true });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	mkdirSync(fixture, { recursive: true, mode: 0o700 });
	const entry: DatasetEntry = {
		name: RAGFLOW_FIXTURE_DATASET,
		slug: RAGFLOW_FIXTURE_SLUG,
		include: ["**/*"],
		// Receipts are a "Never" for RAGFlow in the data-planes table — the
		// fixture pins the exclusion the smoke then tries to violate.
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
	};
	const registryFile = join(fixture, "registry.json");
	const modeFile = join(fixture, "mode.json");
	writeFileSync(registryFile, `${JSON.stringify([entry], null, 2)}\n`, { mode: 0o600 });
	writeFileSync(modeFile, `${JSON.stringify({ mode: "normal" }, null, 2)}\n`, { mode: 0o600 });
	return {
		env: {
			RAGFLOW_URL: options.url,
			RAGFLOW_API_KEY: options.apiKey,
			SUBSTRATE_DOCS_STATE: stateDir,
			SUBSTRATE_DOCS_DATASETS: registryFile,
			SUBSTRATE_DOCS_EMBEDDING_MODEL: RAGFLOW_FIXTURE_EMBEDDING_MODEL,
			SUBSTRATE_RAGFLOW_TIMEOUT_MS: String(RAGFLOW_FIXTURE_TIMEOUT_MS),
		},
		registryFile,
		modeFile,
		stateFile: join(fixture, "state.json"),
		stateDir,
		entry,
	};
}
