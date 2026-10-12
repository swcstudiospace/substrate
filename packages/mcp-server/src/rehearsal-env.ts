/**
 * Scratch server environment for the rehearsal harness.
 *
 * `buildRehearsalEnv` is the inverse of `loadConfig`: it emits exactly the
 * keys the server reads, pointed at scratch stores on loopback, with caller-
 * supplied scratch secrets. The harness (`scripts/rehearsal.ts`) imports this
 * module and never names a ledger key itself, which keeps the store lock
 * (`store-lock.test.ts`) green without editing it.
 *
 * Isolation is by construction, not by scrubbing: the returned record starts
 * from an allowlist (`PATH`, `HOME`, `BUN_*`) and only scratch values are
 * added. The parent environment is never spread, the deployment env file is
 * never read, and every store URL must be loopback before it is emitted.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenEnvName } from "./config.ts";
import { SURFACES, isSwarmSurface, type Surface } from "./types.ts";

/**
 * Ledger key names, reached only through these fields so no tracked line
 * ever writes a ledger key before a value.
 */
export const LEDGER_KEYS = {
	url: "GREPTIME_URL",
	user: "GREPTIME_USER",
	password: "GREPTIME_PASSWORD",
	db: "GREPTIME_DB",
} as const;

/**
 * The four server settings the skills fixture adds (`--skills-fixture`). The builder accepts
 * exactly these and refuses a value that leaves the run directory, so a fixture can point the
 * proposer at the instance's own throwaway repository and nowhere else.
 */
export const FIXTURE_ENV_KEYS = [
	"SUBSTRATE_SKILLS_STATE",
	"SUBSTRATE_SKILLS_REPO",
	"SUBSTRATE_SKILLS_REMOTE_URL",
	"SUBSTRATE_SKILLS_GH",
] as const;

/**
 * Server key names for the RAGFlow reach, reached only through these fields
 * so no tracked line ever writes a RAGFlow value next to its key. The twin
 * reads exactly these two (`ragflowFromEnv`); without `--ragflow-fixture`
 * neither is set and the twin has no RAGFlow reach.
 */
export const RAGFLOW_KEYS = {
	url: "RAGFLOW_URL",
	apiKey: "RAGFLOW_API_KEY",
} as const;

/**
 * The owned RAGFlow stand-in for one instance (`--ragflow-fixture`): its
 * loopback URL plus the random scratch key the twin presents to it. The key
 * stays in the server env only — it is never exported to consumers.
 */
export interface RagflowFixtureEnv {
	url: string;
	apiKey: string;
}

/**
 * Fixture-only server docs manifest, explicit and contained: the twin's
 * `SUBSTRATE_DOCS_STATE_FILE` points at this file directly inside the run
 * directory, so a twin can never write the host's records. Consumers reach
 * the same path (never a key) through `REHEARSAL_DOCS_STATE_KEY`.
 */
export const REHEARSAL_DOCS_STATE_FILENAME = "docs-state.json";
/** Consumer locator for the fixture's docs manifest: the own path only, never a key. */
export const REHEARSAL_DOCS_STATE_KEY = "SUBSTRATE_REHEARSAL_DOCS_STATE_FILE";

/** The builder refused an input; the message names surfaces and hosts, never values. */
export class RehearsalEnvError extends Error {}

export interface ScratchPorts {
	/** Scratch MCP server port. */
	mcp: number;
	/** Host port Docker published for the scratch ledger HTTP. */
	ledger: number;
	/** Host port Docker published for scratch Postgres. */
	postgres: number;
}

export interface ScratchSecrets {
	/** Static ledger user created for this run. */
	ledgerUser: string;
	/** Static ledger password created for this run. */
	ledgerPassword: string;
	/** Postgres password created for this run (hex, so it is URL-safe). */
	pgPassword: string;
	/** Audit-chain signing key created for this run. */
	handoffKey: string;
	/** One bearer value per surface that receives a token. */
	surfaceTokens: Partial<Record<Surface, string>>;
}

export interface BuildRehearsalEnvInput {
	ports: ScratchPorts;
	secrets: ScratchSecrets;
	/** Surfaces that receive a scratch token; empty means the anonymous shape. */
	surfaces: Surface[];
	/** Surface whose token is also listed as an operator's; null for anonymous. */
	operator: Surface | null;
	/** Surfaces allowed to call desktop_run; must be a subset of surfaces. */
	desktopSurfaces: readonly Surface[];
	/** Instance run directory; the audit file lives directly inside it. */
	runDir: string;
	/** Parent environment, read only through the allowlist. */
	parentEnv: Record<string, string | undefined>;
	/** The skills fixture's server settings, when the instance was started with `--skills-fixture`. */
	skillsFixture?: Record<string, string> | null;
	/**
	 * Opt-in tracker fakes for the claim-mirror rehearsal (Phase 23): every
	 * URL must be loopback, and the keys are random scratch, never the host's
	 * `LINEAR_API_KEY`/`NOTION_API_KEY` (the allowlist above never forwards
	 * those). Absent by default; existing rehearsals behave unchanged.
	 */
	trackers?: TrackerBlockInput | null;
	/**
	 * Opt-in RAGFlow stand-in (`--ragflow-fixture`): its loopback URL plus the
	 * random scratch key the twin presents to it. The URL must be loopback;
	 * the key is emitted into the server env only. Absent by default; existing
	 * rehearsals behave unchanged.
	 */
	ragflowFixture?: RagflowFixtureEnv | null;
}

/** Loopback tracker endpoints plus scratch keys, for one mirror rehearsal. */
export interface TrackerBlockInput {
	hermesLinearUrl: string;
	linearApiUrl: string;
	notionApiUrl: string;
}

/**
 * The opt-in tracker block: loopback-guarded fake endpoints plus random
 * scratch keys. The host's tracker keys never reach the output — the builder
 * never reads them, and the values here are generated per call.
 */
function trackerBlock(trackers: TrackerBlockInput): Record<string, string> {
	assertLoopback(trackers.hermesLinearUrl, "HERMES_LINEAR_URL");
	assertLoopback(trackers.linearApiUrl, "LINEAR_API_URL");
	assertLoopback(trackers.notionApiUrl, "NOTION_API_URL");
	return {
		HERMES_LINEAR_URL: trackers.hermesLinearUrl,
		LINEAR_API_URL: trackers.linearApiUrl,
		NOTION_API_URL: trackers.notionApiUrl,
		LINEAR_API_KEY: `rh-linear-${randomBytes(16).toString("hex")}`,
		NOTION_API_KEY: `rh-notion-${randomBytes(16).toString("hex")}`,
	};
}

/** A fixture path value must be absolute and inside the run directory. */
function assertInsideRun(key: string, value: string, runDir: string): void {
	const inside = relative(resolve(runDir), resolve(value));
	if (!isAbsolute(value) || inside.startsWith("..") || isAbsolute(inside)) {
		throw new RehearsalEnvError(`rehearsal env refused: skills fixture ${key} is not inside the run directory`);
	}
}

/**
 * The fixture's settings, checked. Only the four known keys; the state directory, the `gh`
 * script and the remote's path must lie inside the run directory; the remote is a `file://` URL.
 */
function fixtureEnv(fixture: Record<string, string>, runDir: string): Record<string, string> {
	for (const [key, value] of Object.entries(fixture)) {
		if (!(FIXTURE_ENV_KEYS as readonly string[]).includes(key)) {
			throw new RehearsalEnvError(`rehearsal env refused: ${key} is not a skills fixture setting`);
		}
		if (key === "SUBSTRATE_SKILLS_STATE" || key === "SUBSTRATE_SKILLS_GH") assertInsideRun(key, value, runDir);
		if (key === "SUBSTRATE_SKILLS_REMOTE_URL") {
			let path: string;
			try {
				path = fileURLToPath(value);
			} catch {
				throw new RehearsalEnvError("rehearsal env refused: the skills fixture remote is not a file:// URL");
			}
			assertInsideRun(key, path, runDir);
		}
	}
	return fixture;
}

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

/**
 * Refuse a store URL whose host is not loopback. The throw names the label
 * and host only: echoing the URL would print an embedded password.
 */
export function assertLoopback(raw: string, label: string): void {
	let host: string;
	try {
		host = new URL(raw).hostname.toLowerCase();
	} catch {
		throw new RehearsalEnvError(`rehearsal env refused: ${label} is not a parseable URL`);
	}
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (LOOPBACK_HOSTS[bare] !== true) {
		throw new RehearsalEnvError(`rehearsal env refused: ${label} host ${bare} is not loopback`);
	}
}

/**
 * Operator is a subset of the surface tokens, and a swarm surface is never
 * an operator. Throws naming the surface only.
 */
export function assertOperatorAllowed(surfaces: readonly Surface[], operator: Surface | null): void {
	if (operator === null) return;
	if (!surfaces.includes(operator)) {
		throw new RehearsalEnvError(`rehearsal env refused: operator surface ${operator} has no surface token`);
	}
	if (isSwarmSurface(operator)) {
		throw new RehearsalEnvError(
			`rehearsal env refused: operator surface ${operator} is a swarm surface and is never an operator`,
		);
	}
}

/**
 * Desktop surfaces are a subset of the surface tokens: a tokenless run would
 * only be refused by the tool. Throws naming the surface only.
 */
export function assertDesktopSurfacesAllowed(surfaces: readonly Surface[], desktopSurfaces: readonly Surface[]): void {
	for (const surface of desktopSurfaces) {
		if (!surfaces.includes(surface)) {
			throw new RehearsalEnvError(`rehearsal env refused: desktop surface ${surface} has no surface token`);
		}
	}
}

function assertKnownSurfaces(surfaces: readonly Surface[]): void {
	for (const surface of surfaces) {
		if (!(SURFACES as readonly string[]).includes(surface)) {
			throw new RehearsalEnvError(`rehearsal env refused: unknown surface ${surface}`);
		}
	}
}

/**
 * Scratch ledger and Postgres connection values. Ledger keys go through the
 * computed fields above; the Postgres URL is assembled from hex secrets only.
 */
function scratchStoreRecords(ports: ScratchPorts, secrets: ScratchSecrets): Record<string, string> {
	const ledgerUrl = `http://127.0.0.1:${ports.ledger}`;
	assertLoopback(ledgerUrl, "ledger");
	const pgUrl = `postgresql://postgres:${secrets.pgPassword}@127.0.0.1:${ports.postgres}/postgres`;
	assertLoopback(pgUrl, "postgres");
	const out: Record<string, string> = {};
	out[LEDGER_KEYS.url] = ledgerUrl;
	out[LEDGER_KEYS.user] = secrets.ledgerUser;
	out[LEDGER_KEYS.password] = secrets.ledgerPassword;
	out[LEDGER_KEYS.db] = "public";
	out.SUBSTRATE_PG_URL = pgUrl;
	return out;
}

/**
 * Build the scratch server environment: allowlisted host values plus exactly
 * the keys `loadConfig` reads. With no surfaces and a null operator the
 * result is the anonymous shape (`allowAnonymous`, zero operator tokens).
 */
export function buildRehearsalEnv(input: BuildRehearsalEnvInput): Record<string, string> {
	assertKnownSurfaces(input.surfaces);
	assertOperatorAllowed(input.surfaces, input.operator);
	assertDesktopSurfacesAllowed(input.surfaces, input.desktopSurfaces);
	const env: Record<string, string> = {};
	if (input.parentEnv.PATH !== undefined) env.PATH = input.parentEnv.PATH;
	if (input.parentEnv.HOME !== undefined) env.HOME = input.parentEnv.HOME;
	for (const [key, value] of Object.entries(input.parentEnv)) {
		if (value !== undefined && key.startsWith("BUN_")) env[key] = value;
	}
	env.SUBSTRATE_HOST = "127.0.0.1";
	env.SUBSTRATE_PORT = String(input.ports.mcp);
	Object.assign(env, scratchStoreRecords(input.ports, input.secrets));
	for (const surface of input.surfaces) {
		const token = input.secrets.surfaceTokens[surface];
		if (!token) {
			throw new RehearsalEnvError(`rehearsal env refused: no token for surface ${surface}`);
		}
		env[tokenEnvName(surface)] = token;
	}
	if (input.operator !== null) {
		const token = input.secrets.surfaceTokens[input.operator];
		if (!token) {
			throw new RehearsalEnvError(`rehearsal env refused: no token for surface ${input.operator}`);
		}
		env.SUBSTRATE_OPERATOR_TOKENS = token;
	}
	env.SUBSTRATE_AUDIT_PATH = join(input.runDir, "mcp-audit.jsonl");
	env.SUBSTRATE_DESKTOP_DIR = join(input.runDir, "desktop");
	if (input.desktopSurfaces.length > 0) env.SUBSTRATE_DESKTOP_SURFACES = input.desktopSurfaces.join(",");
	env.SUBSTRATE_HANDOFF_KEY = input.secrets.handoffKey;
	// Always inside the run directory, so a twin can never write the host's skills state; without a
	// fixture there is no mirror there, and a proposal fails before any git or gh call.
	env.SUBSTRATE_SKILLS_STATE = join(input.runDir, "skills");
	// A crashed `--skills-fixture` leaves a mirror in this run dir. Starting again without the
	// flag would keep that mirror and point its origin at the production library.
	if (!input.skillsFixture && existsSync(join(input.runDir, "skills", "mirror.git", "HEAD"))) {
		throw new RehearsalEnvError(
			"rehearsal env refused: this run dir still has a skills fixture mirror; pass --skills-fixture or choose a new name",
		);
	}
	if (input.skillsFixture) {
		Object.assign(env, fixtureEnv(input.skillsFixture, input.runDir));
		// The proposer's git and gh children inherit HOME. An empty directory inside the run
		// keeps a host `url.*.insteadOf` (and the operator's gh credentials) out of a fixture
		// proof. A rehearsal without a fixture keeps the operator home so production gh still
		// finds its credentials.
		const home = join(input.runDir, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		env.HOME = home;
	}
	if (input.trackers) Object.assign(env, trackerBlock(input.trackers));
	if (input.ragflowFixture) {
		assertLoopback(input.ragflowFixture.url, "RAGFLOW_URL");
		if (input.ragflowFixture.apiKey.length === 0) {
			throw new RehearsalEnvError("rehearsal env refused: the RAGFlow fixture key is empty");
		}
		env[RAGFLOW_KEYS.url] = input.ragflowFixture.url;
		env[RAGFLOW_KEYS.apiKey] = input.ragflowFixture.apiKey;
		// Fixture-only docs manifest: explicit, contained in the run dir, so
		// the twin's pins never touch the host's records. A crashed run's
		// stale manifest must not survive: its document ids name uploads a
		// dead stand-in served, so a fresh run starts empty.
		env.SUBSTRATE_DOCS_STATE_FILE = join(input.runDir, REHEARSAL_DOCS_STATE_FILENAME);
		rmSync(env.SUBSTRATE_DOCS_STATE_FILE, { force: true });
	}
	return env;
}

export interface ScratchStoresInput {
	ports: ScratchPorts;
	secrets: ScratchSecrets;
}

export interface ConsumerEnvInput {
	/** Scratch MCP port the twin listens on. */
	mcpPort: number;
	/** Bearer value of the first non-swarm surface; the client's whole credential. */
	firstToken: string;
	/** Bearer value of the operator surface, for the smoke to drive. Empty under `--anonymous`. */
	operatorToken: string;
	/** Instance run directory; per-surface token files live in `tokens/`. */
	runDir: string;
	/** Instance name, so a proof states which twin it drove. */
	name: string;
	/** Scratch Postgres URL the live index tests run against. */
	testPgUrl: string;
	/** The skills fixture's paths, for the proof that drives it; absent without `--skills-fixture`. */
	skills?: { state: string; origin: string; ghState: string; repo: string } | null;
	/**
	 * The RAGFlow stand-in locator, for the proof that drives it; absent
	 * without `--ragflow-fixture`. Names the loopback endpoint, the readiness
	 * marker and the fixture pid — never the plane key.
	 */
	ragflowFixture?: { url: string; pid: number } | null;
	/**
	 * Fixture-only docs manifest path, for the proof that reads its own
	 * pins; absent by default so existing rehearsals behave unchanged. The
	 * path only, never a key, and always inside `runDir`.
	 */
	docsStateFile?: string | null;
}

/**
 * The `stores.env` record: scratch ledger and Postgres connection values for
 * the proofs that legitimately hold a store client. Same computed-key shape
 * as the server env.
 */
export function storesEnvRecord(input: ScratchStoresInput): Record<string, string> {
	return scratchStoreRecords(input.ports, input.secrets);
}

/**
 * The `consumer.env` contract: everything a proof needs, and deliberately no
 * ledger key — clients reach the ledger only through the twin. With the skills fixture it also
 * names the fixture's paths; with the RAGFlow fixture it names the stand-in's
 * endpoint, readiness marker and pid (never the plane key). SUBSTRATE_TOKEN
 * is always the first non-swarm surface's token; the operator token rides
 * separately so an `--operator` twin never disguises it as the credential.
 */
export function consumerEnvRecord(input: ConsumerEnvInput): Record<string, string> {
	// Short locals, never long names: a 16+ character identifier after the
	// client token key would trip the store lock's token scan.
	const token = input.firstToken;
	const opToken = input.operatorToken;
	const out: Record<string, string> = {};
	out.SUBSTRATE_URL = `http://127.0.0.1:${input.mcpPort}`;
	out.SUBSTRATE_TOKEN = token;
	out.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN = opToken;
	out.SUBSTRATE_REHEARSAL_TOKENS_DIR = join(input.runDir, "tokens");
	out.SUBSTRATE_REHEARSAL_NAME = input.name;
	out.SUBSTRATE_TEST_PG_URL = input.testPgUrl;
	if (input.skills) {
		out.SUBSTRATE_REHEARSAL_SKILLS_STATE = input.skills.state;
		out.SUBSTRATE_REHEARSAL_SKILLS_ORIGIN = input.skills.origin;
		out.SUBSTRATE_REHEARSAL_SKILLS_GH_STATE = input.skills.ghState;
		out.SUBSTRATE_REHEARSAL_SKILLS_REPO = input.skills.repo;
	}
	if (input.ragflowFixture) {
		out.SUBSTRATE_RAGFLOW_FIXTURE_URL = input.ragflowFixture.url;
		out.SUBSTRATE_RAGFLOW_FIXTURE_READY = "1";
		out.SUBSTRATE_RAGFLOW_FIXTURE_PID = String(input.ragflowFixture.pid);
	}
	if (input.docsStateFile !== undefined && input.docsStateFile !== null) {
		// The own path only, never a key, and always inside the run dir.
		assertInsideRun(REHEARSAL_DOCS_STATE_KEY, input.docsStateFile, input.runDir);
		out[REHEARSAL_DOCS_STATE_KEY] = input.docsStateFile;
	}
	return out;
}

/**
 * Render an env record as sourceable `export` lines: one
 * `export KEY='value'` per line, keys sorted, single quotes escaped.
 */
export function toShellExports(record: Record<string, string>): string {
	return (
		Object.entries(record)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`)
			.join("\n") + "\n"
	);
}
