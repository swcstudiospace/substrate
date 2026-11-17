#!/usr/bin/env bun
/**
 * Read-only production identity check (`bun run identity:check`).
 *
 * Compares the tracked client manifest against the delivery targets on this
 * host and reports, per client, whether its token delivery exists. Exit 0
 * when every live client is provisioned, 1 when a live client would be
 * stranded at switch-on, 2 on usage or an unreadable manifest.
 *
 * It changes nothing: no /etc write, no restart, no request. The default
 * mode is agent-safe: it reads variable names only, stats token files
 * without reading them, and prints names and verdict words only — never a
 * value or a hash. The operator-only --values mode compares values in
 * memory by sha256 equality and still prints only match, missing, mismatch
 * or unchecked per client.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokenConfig, tokenEnvName } from "../packages/mcp-server/src/config.ts";
import { SURFACES, type Surface } from "../packages/mcp-server/src/types.ts";
import { DEFAULT_TOKENS_DIR, firstLine } from "../packages/cli/src/token.ts";

/** Every line this script prints starts here. */
export const IDENTITY_PREFIX = "[identity:check]";

/** Server variables this script recognises as surface tokens. */
const TOKEN_PREFIX = "SUBSTRATE_TOKEN_";

/** The bare client variable: legitimate in a client env, never on the server. */
const BARE_TOKEN = "SUBSTRATE_TOKEN";

/** The server variable holding the operator bearers `isOperator` demands. */
const OPERATOR_LIST = "SUBSTRATE_OPERATOR_TOKENS";

/** The list separator boot accepts inside one server variable. */
const LIST_SPLIT = /[\s,]+/;

/** A shell-looking name; anything else before `=` is not a variable. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Manifest states that report but never fail the check. */
const NON_FAILING_STATE: Record<string, true> = { "after-phase-19": true, "not-installed": true };

export type Delivery =
	| { kind: "tokens-dir" }
	| { kind: "env-file"; path: string; variable: string }
	| { kind: "operator-file"; path: string }
	| { kind: "external"; note: string };

export interface ManifestClient {
	id: string;
	surface: string;
	delivery: Delivery;
	state: string;
	evidence: string;
}

export interface Manifest {
	version: number;
	server_env: string;
	required_server_names: string[];
	clients: ManifestClient[];
	/** Herdr collector env files checked for a shared bare bearer; absent means none. */
	herdr_env_files?: string[];
}

/** True for a client that runs today and must hold a token at switch-on. */
export function isLive(state: string): boolean {
	return state === "live";
}

/** True for a restoring-phase state of the form `dormant:<phase>`. */
export function isDormant(state: string): boolean {
	return /^dormant:\d+$/.test(state);
}

/** A manifest that cannot be checked; the message names paths only. */
export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

/** The manifest JSON before validation; every field is checked below. */
interface RawClient {
	id: unknown;
	surface: unknown;
	delivery: unknown;
	state: unknown;
	evidence: unknown;
}

interface RawDelivery {
	kind: unknown;
	path: unknown;
	variable: unknown;
	note: unknown;
}

interface RawManifest {
	version: unknown;
	server_env: unknown;
	required_server_names: unknown;
	clients: unknown;
	herdr_env_files: unknown;
}

/**
 * Read and validate the manifest. Anything structural — unreadable file,
 * bad JSON, unknown delivery kind or state — throws ManifestError, which
 * main turns into exit 2. Surface membership is a test lock, not a refusal.
 */
export function loadManifest(path: string): Manifest {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new ManifestError(`cannot read manifest ${path}`);
	}
	let raw: RawManifest;
	try {
		raw = JSON.parse(text) as RawManifest;
	} catch {
		throw new ManifestError(`manifest ${path} is not JSON`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw) || raw.version !== 1) {
		throw new ManifestError(`manifest ${path} needs version 1`);
	}
	if (typeof raw.server_env !== "string" || raw.server_env === "") {
		throw new ManifestError(`manifest ${path} needs a server_env path`);
	}
	if (!Array.isArray(raw.required_server_names) || !raw.required_server_names.every((n: unknown) => typeof n === "string")) {
		throw new ManifestError(`manifest ${path} needs required_server_names`);
	}
	if (!Array.isArray(raw.clients)) throw new ManifestError(`manifest ${path} needs a clients array`);
	const clients: ManifestClient[] = raw.clients.map((entry: unknown, index: number) => {
		const where = `manifest ${path} client ${index}`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new ManifestError(`${where} needs an object`);
		}
		const item = entry as RawClient;
		if (typeof item.id !== "string" || item.id === "") {
			throw new ManifestError(`${where} needs an id`);
		}
		if (typeof item.surface !== "string" || item.surface === "") {
			throw new ManifestError(`${where} (${item.id}) needs a surface`);
		}
		if (typeof item.evidence !== "string" || item.evidence === "") {
			throw new ManifestError(`${where} (${item.id}) needs evidence`);
		}
		const state = item.state;
		if (typeof state !== "string" || (!isLive(state) && NON_FAILING_STATE[state] !== true && !isDormant(state))) {
			throw new ManifestError(`${where} (${item.id}) needs a known state`);
		}
		if (typeof item.delivery !== "object" || item.delivery === null || Array.isArray(item.delivery)) {
			throw new ManifestError(`${where} (${item.id}) needs a delivery`);
		}
		const delivery = item.delivery as RawDelivery;
		switch (delivery.kind) {
			case "tokens-dir":
				return { id: item.id, surface: item.surface, delivery: { kind: "tokens-dir" }, state, evidence: item.evidence };
			case "env-file":
				if (typeof delivery.path !== "string" || typeof delivery.variable !== "string") {
					throw new ManifestError(`${where} (${item.id}) env-file needs path and variable`);
				}
				return {
					id: item.id,
					surface: item.surface,
					delivery: { kind: "env-file", path: delivery.path, variable: delivery.variable },
					state,
					evidence: item.evidence,
				};
			case "operator-file":
				if (typeof delivery.path !== "string") {
					throw new ManifestError(`${where} (${item.id}) operator-file needs a path`);
				}
				return {
					id: item.id,
					surface: item.surface,
					delivery: { kind: "operator-file", path: delivery.path },
					state,
					evidence: item.evidence,
				};
			case "external":
				if (typeof delivery.note !== "string") {
					throw new ManifestError(`${where} (${item.id}) external needs a note`);
				}
				return {
					id: item.id,
					surface: item.surface,
					delivery: { kind: "external", note: delivery.note },
					state,
					evidence: item.evidence,
				};
			default:
				throw new ManifestError(`${where} (${item.id}) has an unknown delivery kind`);
		}
	});
	const requiredNames = raw.required_server_names as string[];
	const herdrEnvFiles = raw.herdr_env_files;
	if (herdrEnvFiles !== undefined) {
		if (!Array.isArray(herdrEnvFiles) || !herdrEnvFiles.every((entry: unknown) => typeof entry === "string" && entry !== "")) {
			throw new ManifestError(`manifest ${path} needs herdr_env_files as an array of non-empty strings`);
		}
	}
	return {
		version: 1,
		server_env: raw.server_env,
		required_server_names: requiredNames,
		clients,
		...(herdrEnvFiles === undefined ? {} : { herdr_env_files: herdrEnvFiles as string[] }),
	};
}

/** One parsed variable: its definition count and whether the last was empty. */
export interface NameEntry {
	count: number;
	empty: boolean;
}

/**
 * Classify one raw line for both parsers. Returns null for a line that is
 * not a definition: blank, comment, continuation fragment, or no valid name.
 * The value half is passed through untouched; names-only callers drop it at
 * once and never store it.
 */
function splitEnvLine(raw: string): { name: string; rest: string } | null {
	const line = raw.trim();
	if (line === "" || line.startsWith("#") || line.startsWith(";")) return null;
	let body = line;
	if (/^export\s+/.test(body)) body = body.replace(/^export\s+/, "");
	const eq = body.indexOf("=");
	if (eq <= 0) return null;
	const name = body.slice(0, eq).trim();
	if (!KEY_PATTERN.test(name)) return null;
	return { name, rest: body.slice(eq + 1) };
}

/** True when a value half holds nothing assignable. */
function isEmptyValue(rest: string): boolean {
	const trimmed = rest.trim();
	return trimmed === "" || trimmed === '""' || trimmed === "''";
}

/**
 * Variable names only from systemd EnvironmentFile syntax. A line after one
 * ending in `\` is a continuation fragment and is skipped, never parsed as
 * a key — otherwise part of a value would surface as a name. Only the name,
 * the definition count and the emptiness survive; the value half is dropped
 * at parse time and never stored in the returned structure.
 */
export function parseEnvNames(text: string): Map<string, NameEntry> {
	const out = new Map<string, NameEntry>();
	let continued = false;
	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (continued) {
			continued = trimmed.endsWith("\\");
			continue;
		}
		const split = splitEnvLine(raw);
		continued = trimmed.endsWith("\\");
		if (split === null) continue;
		const prev = out.get(split.name);
		out.set(split.name, { count: (prev?.count ?? 0) + 1, empty: isEmptyValue(split.rest) });
	}
	return out;
}

/**
 * Values from the same syntax, operator-only. Last definition wins, like
 * systemd, with matching surrounding quotes stripped. Kept separate from
 * the names parser so names-only mode never holds a value past one line.
 */
export function parseEnvValues(text: string): Map<string, string> {
	const out = new Map<string, string>();
	let continued = false;
	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (continued) {
			continued = trimmed.endsWith("\\");
			continue;
		}
		const split = splitEnvLine(raw);
		continued = trimmed.endsWith("\\");
		if (split === null) continue;
		let value = split.rest.trim();
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		out.set(split.name, value);
	}
	return out;
}

/** What a stat-only look at a token file can say. */
export interface FileStat {
	isFile: boolean;
	mode: number;
	uid: number;
	size: number;
}

/** Names-only verdict over one token file: stated from stat, never read. */
export type TokensFileState = "ok" | "missing" | "not-regular" | "empty" | "bad-mode" | "bad-owner";

/** Names-only verdict over a token file: never read, only stated. */
export function tokensFileVerdict(stat: FileStat | null): TokensFileState {
	if (stat === null) return "missing";
	if (!stat.isFile) return "not-regular";
	if (stat.size === 0) return "empty";
	if ((stat.mode & 0o777) !== 0o600) return "bad-mode";
	if (stat.uid !== 0) return "bad-owner";
	return "ok";
}

function tokensDetail(verdict: TokensFileState): string {
	switch (verdict) {
		case "ok":
			return "token file present";
		case "missing":
			return "token file missing";
		case "not-regular":
			return "token path is not a regular file";
		case "empty":
			return "token file is empty";
		case "bad-mode":
			return "token file mode is not 0600";
		case "bad-owner":
			return "token file is not root-owned";
	}
}

/** A leading `~` resolves against HOME; anything else passes through. */
export function expandHome(path: string, home: string = process.env.HOME ?? "/root"): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** The host surface this script touches: injected so tests never need /etc. */
export interface HostReads {
	readText: (path: string) => string | null;
	statFile: (path: string) => FileStat | null;
}

export type ClientStatus = "ok" | "missing" | "external" | "match" | "mismatch" | "unchecked";

export interface ClientVerdict {
	id: string;
	surface: string;
	state: string;
	status: ClientStatus;
	/** Names and verdict words only — never a value or a hash. */
	detail: string;
}

export interface ServerNameStatus {
	name: string;
	present: boolean;
	empty: boolean;
}

export interface IdentityReport {
	manifestPath: string;
	serverEnv: string;
	tokensDir: string;
	valuesMode: boolean;
	clients: ClientVerdict[];
	serverNames: ServerNameStatus[];
	unexpected: string[];
	warnings: string[];
	/** Boot-style contradictions; names of variables only, never values. */
	errors: string[];
	strandedLive: string[];
	/**
	 * Rollout-scoped absent names: the globals plus live-client surfaces
	 * that hold nothing assignable. Other manifest rows still list under
	 * serverNames for visibility but never fail the pass.
	 */
	missing: string[];
	pass: boolean;
}

/** Every server variable name the manifest expects to see. */
export function expectedServerNames(manifest: Manifest): Set<string> {
	const out = new Set<string>(manifest.required_server_names);
	for (const client of manifest.clients) {
		// Surface membership is a test lock, not a refusal: an unknown surface
		// still yields its deterministic variable name, so the report shows it
		// as missing instead of silently dropping the client.
		out.add(tokenEnvName(client.surface as Surface));
	}
	return out;
}

/**
 * Server names the rollout needs: the global settings plus the token
 * variable of every live-client surface. `not-installed`, dormant and
 * `after-phase-19` rows stay in the full listing for visibility but never
 * fail the verdict: uninstalled workspaces provision on install, dormant
 * phases restore in their own window, and the collector cutover is gated
 * procedurally by the runbook's step 1.
 */
export function rolloutServerNames(manifest: Manifest): Set<string> {
	const out = new Set<string>(manifest.required_server_names);
	for (const client of manifest.clients) {
		if (isLive(client.state)) out.add(tokenEnvName(client.surface as Surface));
	}
	return out;
}

/** Rollout-scoped absent names, sorted: missing or empty at parse time. */
function missingRolloutNames(manifest: Manifest, section: ServerSection): string[] {
	const byName = new Map(section.serverNames.map((entry) => [entry.name, entry]));
	return [...rolloutServerNames(manifest)]
		.filter((name) => {
			const entry = byName.get(name);
			return entry === undefined || !entry.present || entry.empty;
		})
		.sort();
}

interface ServerSection {
	serverNames: ServerNameStatus[];
	unexpected: string[];
	warnings: string[];
}

/** The names half of the server section, shared by both modes. */
function serverSection(manifest: Manifest, names: Map<string, NameEntry>, serverEnv: string): ServerSection {
	const expected = expectedServerNames(manifest);
	const serverNames: ServerNameStatus[] = [...expected]
		.sort()
		.map((name) => {
			const entry = names.get(name);
			return { name, present: entry !== undefined, empty: entry?.empty === true };
		});
	const unexpected = [...names.keys()].filter((name) => name.startsWith(TOKEN_PREFIX) && !expected.has(name)).sort();
	const warnings: string[] = [];
	if (names.get(BARE_TOKEN) !== undefined) {
		warnings.push(
			`${BARE_TOKEN} names a value in ${serverEnv}; one surface token there would send out under a single surface`,
		);
	}
	for (const [name, entry] of [...names.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (entry.count > 1 && (expected.has(name) || name.startsWith(TOKEN_PREFIX))) {
			warnings.push(`${name} is defined ${entry.count} times in ${serverEnv}; the last wins`);
		}
	}
	return { serverNames, unexpected, warnings };
}
/**
 * Names-only boot check: a server variable no surface owns refuses boot, so
 * it fails names mode the same way tokenConfig fails values mode. Names only,
 * never values.
 */
function unknownSurfaceErrors(names: Map<string, NameEntry>): string[] {
	const out: string[] = [];
	for (const name of [...names.keys()].sort()) {
		if (name.startsWith(TOKEN_PREFIX) && surfaceOfVariable(name) === null) {
			out.push(
				`${name} names no known surface; remove it or rename it to the SUBSTRATE_TOKEN_<SURFACE> of the surface its value authenticates as`,
			);
		}
	}
	return out;
}
/**
 * Herdr's effective env files must not carry the shared bare bearer: per the
 * collector runbook that value would override every per-surface file. Names
 * only — the value half is dropped at parse time and never reaches output.
 */
function herdrErrors(herdrEnv: Array<{ path: string; text: string | null }>): string[] {
	const out: string[] = [];
	for (const entry of herdrEnv) {
		if (entry.text === null) continue;
		if (parseEnvNames(entry.text).has(BARE_TOKEN)) {
			out.push(`shared bearer ${BARE_TOKEN} in ${entry.path}; herdr resolves per surface, remove it`);
		}
	}
	return out;
}

/**
 * Wrapped assignments the line parsers cannot see whole: a trailing
 * backslash leaves a partial value in the map while the loader may see
 * another, so comparing would approve or refuse the wrong set. Fail loudly
 * instead; the runbook only ever writes one line per variable.
 */
function wrappedAssignmentErrors(text: string, path: string): string[] {
	const out: string[] = [];
	text.split("\n").forEach((raw, index) => {
		if (raw.trim().endsWith("\\")) {
			out.push(`wrapped assignment at ${path} line ${index + 1}; unwrap it to one line before the restart`);
		}
	});
	return out;
}

/**
 * Names-only check over injected reads. Token files are stated, never read;
 * env files keep names only. External deliveries report their note and pass:
 * they live in another repo or the operator's procedure, so this script can
 * name them but cannot strand on them. Unknown server suffixes, a shared
 * bare bearer in a herdr file, or a missing rollout name still fail the pass.
 */
export function checkNames(
	manifest: Manifest,
	reads: HostReads,
	serverEnv: string,
	tokensDir: string,
	herdrEnv: Array<{ path: string; text: string | null }> = [],
): IdentityReport {
	const serverText = reads.readText(serverEnv);
	const names = serverText === null ? new Map<string, NameEntry>() : parseEnvNames(serverText);
	const section = serverSection(manifest, names, serverEnv);
	const warnings = [...section.warnings];
	if (serverText === null) warnings.push(`unreadable ${serverEnv}; every live client is stranded until it exists`);
	const clients: ClientVerdict[] = manifest.clients.map((client) => {
		const delivery = client.delivery;
		switch (delivery.kind) {
			case "tokens-dir": {
				const verdict = tokensFileVerdict(reads.statFile(join(tokensDir, client.surface)));
				return {
					id: client.id,
					surface: client.surface,
					state: client.state,
					status: verdict === "ok" ? "ok" : "missing",
					detail: tokensDetail(verdict),
				};
			}
			case "env-file": {
				const text = reads.readText(delivery.path);
				if (text === null) {
					return { id: client.id, surface: client.surface, state: client.state, status: "missing", detail: `unreadable ${delivery.path}` };
				}
				const entry = parseEnvNames(text).get(delivery.variable);
				if (entry === undefined) {
					return {
						id: client.id,
						surface: client.surface,
						state: client.state,
						status: "missing",
						detail: `no ${delivery.variable} in ${delivery.path}`,
					};
				}
				if (entry.empty) {
					return {
						id: client.id,
						surface: client.surface,
						state: client.state,
						status: "missing",
						detail: `${delivery.variable} is empty in ${delivery.path}`,
					};
				}
				return {
					id: client.id,
					surface: client.surface,
					state: client.state,
					status: "ok",
					detail: `names ${delivery.variable} in ${delivery.path}`,
				};
			}
			case "operator-file": {
				const verdict = tokensFileVerdict(reads.statFile(expandHome(delivery.path)));
				return {
					id: client.id,
					surface: client.surface,
					state: client.state,
					status: verdict === "ok" ? "ok" : "missing",
					detail: tokensDetail(verdict),
				};
			}
			case "external":
				return { id: client.id, surface: client.surface, state: client.state, status: "external", detail: delivery.note };
			default: {
				const unhandled: never = delivery;
				throw new Error(`unhandled client delivery: ${JSON.stringify(unhandled)}`);
			}
		}
	});
	const strandedLive = clients.filter((c) => isLive(c.state) && c.status !== "ok" && c.status !== "external").map((c) => c.id);
	const errors = [
		...unknownSurfaceErrors(names),
		...herdrErrors(herdrEnv),
		...(serverText === null ? [] : wrappedAssignmentErrors(serverText, serverEnv)),
	];
	const missing = missingRolloutNames(manifest, section);
	return {
		manifestPath: "",
		serverEnv,
		tokensDir,
		valuesMode: false,
		clients,
		serverNames: section.serverNames,
		unexpected: section.unexpected,
		warnings,
		errors,
		strandedLive,
		missing,
		pass: strandedLive.length === 0 && errors.length === 0 && missing.length === 0,
	};
}

/** sha256 of one value; the hex never leaves this module in output. */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A server variable suffix back to its surface, or null when unknown. */
function surfaceOfVariable(key: string): string | null {
	if (!key.startsWith(TOKEN_PREFIX)) return null;
	const surface = key.slice(TOKEN_PREFIX.length).toLowerCase().replace(/_/g, "-");
	return (SURFACES as readonly string[]).includes(surface) ? surface : null;
}

/** Split one server list the way boot does: commas and whitespace, empties dropped. */
function splitList(raw: string): string[] {
	return raw
		.split(LIST_SPLIT)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Operator-only values comparison over injected maps. Each client value is
 * hashed and tested for membership in its surface set: match when present,
 * mismatch when present under another surface or none, missing when absent.
 * An `operator-file` delivery additionally needs the operator list: like
 * `isOperator`, a bearer outside it cannot force, so surface membership
 * alone is a mismatch. External deliveries report unchecked and never fail.
 * The report still carries the names section plus boot's own validator
 * errors, so a duplicated value or an unknown suffix fails before the
 * restart. A shared bare bearer in a herdr file, a wrapped assignment, or
 * a missing rollout name fails the same way. `serverText` is the raw file
 * the values were read from; without it wrapped lines go undetected.
 */
export function checkValues(
	manifest: Manifest,
	serverValues: Map<string, string>,
	clientValues: Map<string, string | null>,
	serverEnv: string,
	tokensDir: string,
	herdrEnv: Array<{ path: string; text: string | null }> = [],
	serverText: string | null = null,
): IdentityReport {
	const record: Record<string, string> = Object.fromEntries(serverValues);
	let errors: string[] = [];
	try {
		tokenConfig(record);
	} catch (error) {
		errors = [error instanceof Error ? error.message : String(error)];
	}
	const names = new Map<string, NameEntry>();
	for (const [name, value] of serverValues) names.set(name, { count: 1, empty: isEmptyValue(value) });
	const section = serverSection(manifest, names, serverEnv);
	const serverHashes = new Map<string, Set<string>>();
	for (const [key, value] of serverValues) {
		const surface = surfaceOfVariable(key);
		if (surface === null) continue;
		let set = serverHashes.get(surface);
		if (!set) {
			set = new Set<string>();
			serverHashes.set(surface, set);
		}
		for (const entry of splitList(value)) set.add(sha256Hex(entry));
	}
	const operatorHashes = new Set<string>();
	const operatorRaw = serverValues.get(OPERATOR_LIST);
	if (operatorRaw !== undefined) {
		for (const entry of splitList(operatorRaw)) operatorHashes.add(sha256Hex(entry));
	}
	const clients: ClientVerdict[] = manifest.clients.map((client) => {
		if (client.delivery.kind === "external") {
			return { id: client.id, surface: client.surface, state: client.state, status: "unchecked", detail: client.delivery.note };
		}
		if (!clientValues.has(client.id)) {
			return { id: client.id, surface: client.surface, state: client.state, status: "unchecked", detail: "no value supplied" };
		}
		const value = clientValues.get(client.id);
		if (value === null || value === undefined || value === "") {
			return { id: client.id, surface: client.surface, state: client.state, status: "missing", detail: "no value delivered" };
		}
		const digest = sha256Hex(value);
		if (client.delivery.kind === "operator-file") {
			const held = serverHashes.get(client.surface)?.has(digest) === true && operatorHashes.has(digest);
			return held
				? { id: client.id, surface: client.surface, state: client.state, status: "match", detail: "value is in the surface and operator lists" }
				: { id: client.id, surface: client.surface, state: client.state, status: "mismatch", detail: "value is not in the surface and operator lists" };
		}
		const set = serverHashes.get(client.surface);
		if (set?.has(digest)) {
			return { id: client.id, surface: client.surface, state: client.state, status: "match", detail: "value is in the surface list" };
		}
		return { id: client.id, surface: client.surface, state: client.state, status: "mismatch", detail: "value is not in the surface list" };
	});
	const strandedLive = clients
		.filter((c) => isLive(c.state) && (c.status === "missing" || c.status === "mismatch"))
		.map((c) => c.id);
	const allErrors = [
		...errors,
		...herdrErrors(herdrEnv),
		...(serverText === null ? [] : wrappedAssignmentErrors(serverText, serverEnv)),
	];
	const missing = missingRolloutNames(manifest, section);
	return {
		manifestPath: "",
		serverEnv,
		tokensDir,
		valuesMode: true,
		clients,
		serverNames: section.serverNames,
		unexpected: section.unexpected,
		warnings: section.warnings,
		errors: allErrors,
		strandedLive,
		missing,
		pass: strandedLive.length === 0 && allErrors.length === 0 && missing.length === 0,
	};
}

/** The report as human lines or JSON; both carry names and verdicts only. */
export function formatReport(report: IdentityReport, json: boolean): string {
	if (json) {
		return (
			JSON.stringify(
				{
					pass: report.pass,
					valuesMode: report.valuesMode,
					serverEnv: report.serverEnv,
					tokensDir: report.tokensDir,
					strandedLive: report.strandedLive,
					missing: report.missing,
					serverNames: report.serverNames,
					unexpected: report.unexpected,
					warnings: report.warnings,
					errors: report.errors,
				},
				null,
				2,
			) + "\n"
		);
	}
	const lines: string[] = [];
	lines.push(`${IDENTITY_PREFIX} ${report.clients.length} clients from ${report.manifestPath}`);
	const present = report.serverNames.filter((n) => n.present && !n.empty).length;
	lines.push(`${IDENTITY_PREFIX} server ${report.serverEnv}: ${present}/${report.serverNames.length} names present`);
	for (const name of report.unexpected) lines.push(`${IDENTITY_PREFIX} unexpected ${name}`);
	for (const warning of report.warnings) lines.push(`${IDENTITY_PREFIX} warning: ${warning}`);
	for (const error of report.errors) lines.push(`${IDENTITY_PREFIX} server refused: ${error}`);
	for (const client of report.clients) {
		lines.push(`${IDENTITY_PREFIX} ${client.id} ${client.surface} ${client.state} ${client.status} — ${client.detail}`);
	}
	// The not-ready line names rollout blockers only: other manifest rows
	// still list under serverNames above but never contradict a PASS.
	if (report.errors.length > 0 || report.missing.length > 0) {
		const reasons = [...report.errors, ...report.missing.map((name) => `missing ${name}`)];
		lines.push(`${IDENTITY_PREFIX} server not ready: ${reasons.join("; ")}`);
	}
	lines.push(
		report.pass
			? `${IDENTITY_PREFIX} PASS`
			: report.strandedLive.length > 0
				? `${IDENTITY_PREFIX} FAIL — ${report.strandedLive.length} live client(s) stranded: ${report.strandedLive.join(", ")}`
				: `${IDENTITY_PREFIX} FAIL`,
	);
	return lines.join("\n") + "\n";
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function statOrNull(path: string): FileStat | null {
	try {
		const info = statSync(path);
		return { isFile: info.isFile(), mode: info.mode, uid: info.uid, size: info.size };
	} catch {
		return null;
	}
}

function usage(message?: string): number {
	if (message) process.stderr.write(`${IDENTITY_PREFIX} ${message}\n`);
	process.stderr.write(
		`usage: identity-check.ts [--values] [--json] [--manifest <path>] [--server-env <path>] [--tokens-dir <path>]\n`,
	);
	return 2;
}

/**
 * Flag parsing plus read-only gathering. Returns 0, 1 or 2 and never
 * throws for bad input — usage problems return 2 rather than exiting, so
 * tests can call main directly. Only the `import.meta.main` jump exits.
 */
export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`usage: identity-check.ts [--values] [--json] [--manifest <path>] [--server-env <path>] [--tokens-dir <path>]\n`);
		return 0;
	}
	let values = false;
	let json = false;
	let manifestPath = "infra/identity/clients.json";
	let serverEnvOverride: string | null = null;
	let tokensDirOverride: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--values") values = true;
		else if (arg === "--json") json = true;
		else if (arg === "--manifest" || arg === "--server-env" || arg === "--tokens-dir") {
			const raw = argv[i + 1];
			if (raw === undefined || raw === "") return usage(`${arg} needs a path`);
			i++;
			if (arg === "--manifest") manifestPath = raw;
			else if (arg === "--server-env") serverEnvOverride = raw;
			else tokensDirOverride = raw;
		} else {
			return usage(`unknown argument: ${arg}`);
		}
	}
	let manifest: Manifest;
	try {
		manifest = loadManifest(manifestPath);
	} catch (error) {
		process.stderr.write(`${IDENTITY_PREFIX} ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const serverEnv = serverEnvOverride ?? manifest.server_env;
	const tokensDir = tokensDirOverride ?? DEFAULT_TOKENS_DIR;
	const reads: HostReads = { readText: readTextOrNull, statFile: statOrNull };
	const herdrEnv = (manifest.herdr_env_files ?? []).map((path) => ({ path, text: readTextOrNull(path) }));
	let report: IdentityReport;
	if (!values) {
		report = checkNames(manifest, reads, serverEnv, tokensDir, herdrEnv);
	} else {
		const serverText = readTextOrNull(serverEnv);
		const serverValues = serverText === null ? new Map<string, string>() : parseEnvValues(serverText);
		const clientValues = new Map<string, string | null>();
		for (const client of manifest.clients) {
			const delivery = client.delivery;
			if (delivery.kind === "external") continue;
			if (delivery.kind === "tokens-dir") {
				clientValues.set(client.id, firstLine(join(tokensDir, client.surface)));
			} else if (delivery.kind === "env-file") {
				const text = readTextOrNull(delivery.path);
				clientValues.set(client.id, text === null ? null : (parseEnvValues(text).get(delivery.variable) ?? null));
			} else {
				clientValues.set(client.id, firstLine(expandHome(delivery.path)));
			}
		}
		report = checkValues(manifest, serverValues, clientValues, serverEnv, tokensDir, herdrEnv, serverText);
	}
	report.manifestPath = manifestPath;
	process.stdout.write(formatReport(report, json));
	return report.pass ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
