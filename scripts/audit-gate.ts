#!/usr/bin/env bun
/**
 * Known-vulnerability gate: fail on any high or critical advisory that is not accepted.
 *
 *   bun scripts/audit-gate.ts [--input <file>]
 *
 * The advisories are `bun audit --json` (run here, or read from `--input`, a saved copy of
 * that output). Bun's `--audit-level` does not filter the JSON, so severity is filtered here.
 * An advisory passes only when `.github/audit-accepted-risk.json` lists the same GHSA id,
 * package, and severity at the version the lockfile installs, and that package is installed at
 * no other version. Any other high or critical advisory fails the gate, including one whose
 * severity has risen since it was accepted. An accepted advisory past its
 * `review_by` date still passes, with a warning. Exit 0 when nothing fails, 1 when something
 * does, 2 on a usage or input error. See docs/ci.md.
 */
import { join } from "node:path";

export interface Advisory {
	id: number;
	url?: string;
	title?: string;
	severity: string;
	vulnerable_versions?: string;
}

/** `bun audit --json`: advisories keyed by package name. */
export type AuditJson = Record<string, Advisory[]>;

export interface AcceptedRisk {
	id: string;
	package: string;
	version: string;
	severity: string;
	reason: string;
	owner: string;
	review_by: string;
}

/** Package name to the set of versions the lockfile installs. */
export type Installed = ReadonlyMap<string, ReadonlySet<string>>;

export interface Finding {
	id: string;
	package: string;
	version: string;
	severity: string;
	title: string;
}

export interface GateResult {
	failing: Finding[];
	accepted: Array<{ finding: Finding; risk: AcceptedRisk }>;
	warnings: string[];
}

const GATING_SEVERITIES: Record<string, true> = { high: true, critical: true };
const RISK_FIELDS = ["id", "package", "version", "severity", "reason", "owner", "review_by"] as const;
const ALLOWLIST_PATH = ".github/audit-accepted-risk.json";

export class GateInputError extends Error {}

/** The GHSA id from the advisory URL, else bun's numeric id. */
export function advisoryId(advisory: Advisory): string {
	return advisory.url?.match(/GHSA(?:-[0-9a-z]{4}){3}/)?.[0] ?? String(advisory.id);
}

/** The one installed version of a package, or undefined when it is absent or installed more than once. */
function exactVersion(installed: Installed, pkg: string): string | undefined {
	const versions = installed.get(pkg);
	return versions?.size === 1 ? [...versions][0] : undefined;
}

/**
 * Splits high and critical advisories into failing and accepted. `today` is `YYYY-MM-DD`; an
 * accepted risk warns once `today` is later than its `review_by`. Pure: no I/O, no clock.
 */
export function filterAdvisories(
	audit: AuditJson,
	installed: Installed,
	accepted: readonly AcceptedRisk[],
	today: string,
): GateResult {
	const result: GateResult = { failing: [], accepted: [], warnings: [] };
	for (const [pkg, advisories] of Object.entries(audit)) {
		for (const advisory of advisories) {
			if (!Object.hasOwn(GATING_SEVERITIES, advisory.severity)) continue;
			const version = exactVersion(installed, pkg);
			const finding: Finding = {
				id: advisoryId(advisory),
				package: pkg,
				version: version ?? ([...(installed.get(pkg) ?? [])].join(", ") || "not in lockfile"),
				severity: advisory.severity,
				title: advisory.title ?? "",
			};
			const risk = version === undefined ? undefined : accepted.find((r) => r.id === finding.id && r.package === pkg && r.version === version && r.severity === finding.severity);
			if (risk === undefined) {
				result.failing.push(finding);
				continue;
			}
			result.accepted.push({ finding, risk });
			if (today > risk.review_by) {
				result.warnings.push(`${risk.id} (${pkg}@${risk.version}): review_by ${risk.review_by} has passed; re-review it, then extend or remove the entry`);
			}
		}
	}
	return result;
}

/** Installed versions from `bun.lock` text: every `"<key>": ["<name>@<version>", ...]` entry. */
export function installedVersions(lock: string): Map<string, Set<string>> {
	const installed = new Map<string, Set<string>>();
	for (const match of lock.matchAll(/^\s*"[^"]+": \["([^"]+)"/gm)) {
		const spec = match[1] ?? "";
		const at = spec.lastIndexOf("@");
		if (at <= 0) continue;
		const name = spec.slice(0, at);
		const versions = installed.get(name) ?? new Set<string>();
		versions.add(spec.slice(at + 1));
		installed.set(name, versions);
	}
	return installed;
}

/** Parses and checks the allowlist file. Throws `GateInputError` when a field is missing or malformed. */
export function parseAllowlist(text: string): AcceptedRisk[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new GateInputError(`${ALLOWLIST_PATH} is not valid JSON`);
	}
	const accepted = (data as { accepted?: unknown } | null)?.accepted;
	if (!Array.isArray(accepted)) throw new GateInputError(`${ALLOWLIST_PATH} needs an "accepted" array`);
	for (const entry of accepted) {
		for (const field of RISK_FIELDS) {
			const value = (entry as Record<string, unknown> | null)?.[field];
			if (typeof value !== "string" || value === "") throw new GateInputError(`${ALLOWLIST_PATH}: entry is missing ${field}`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test((entry as AcceptedRisk).review_by)) {
			throw new GateInputError(`${ALLOWLIST_PATH}: review_by must be YYYY-MM-DD (${(entry as AcceptedRisk).id})`);
		}
	}
	return accepted as AcceptedRisk[];
}

export function formatReport(result: GateResult, reported: number): string {
	const lines: string[] = [];
	for (const { finding, risk } of result.accepted) {
		lines.push(`accepted  ${finding.id}  ${finding.package}@${finding.version}  ${finding.severity}  owner ${risk.owner}  review_by ${risk.review_by}`);
	}
	for (const finding of result.failing) {
		lines.push(`FAIL      ${finding.id}  ${finding.package}@${finding.version}  ${finding.severity}  ${finding.title}  (not in ${ALLOWLIST_PATH})`);
	}
	for (const warning of result.warnings) lines.push(`warning: ${warning}`);
	lines.push(`audit gate: ${result.failing.length} unlisted high or critical, ${result.accepted.length} accepted, ${reported} advisories reported`);
	return `${lines.join("\n")}\n`;
}

function parseAuditJson(text: string): AuditJson {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new GateInputError("the audit output is not JSON");
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) throw new GateInputError("the audit output is not an object");
	for (const [pkg, advisories] of Object.entries(data)) {
		if (!Array.isArray(advisories)) throw new GateInputError(`the audit output: ${pkg} is not an array`);
		for (const [index, advisory] of advisories.entries()) checkAdvisory(advisory, `${pkg}[${index}]`);
	}
	return data as AuditJson;
}

/** Checks the fields `filterAdvisories` reads, so a malformed record fails here instead of being skipped. */
function checkAdvisory(advisory: unknown, where: string): void {
	if (typeof advisory !== "object" || advisory === null || Array.isArray(advisory)) throw new GateInputError(`the audit output: ${where} is not an object`);
	const record = advisory as Record<string, unknown>;
	if (typeof record.id !== "number") throw new GateInputError(`the audit output: ${where} has no numeric id`);
	if (typeof record.severity !== "string") throw new GateInputError(`the audit output: ${where} has no severity`);
	for (const field of ["url", "title"] as const) {
		if (record[field] !== undefined && typeof record[field] !== "string") throw new GateInputError(`the audit output: ${where}.${field} is not a string`);
	}
}

async function readAudit(input: string | undefined, root: string): Promise<AuditJson> {
	if (input !== undefined) return parseAuditJson(await Bun.file(input).text());
	// `bun audit` exits 1 when it finds advisories; the JSON on stdout is the verdict, so the exit code is ignored.
	const proc = Bun.spawn([process.execPath, "audit", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	if (stdout.trim() === "") throw new GateInputError(`bun audit printed nothing: ${stderr.trim()}`);
	return parseAuditJson(stdout);
}

export async function main(argv: readonly string[], root = join(import.meta.dir, "..")): Promise<number> {
	let input: string | undefined;
	if (argv.length === 2 && argv[0] === "--input") input = argv[1];
	else if (argv.length > 0) {
		process.stderr.write("usage: bun scripts/audit-gate.ts [--input <file>]\n");
		return 2;
	}
	try {
		const audit = await readAudit(input, root);
		const lock = await Bun.file(join(root, "bun.lock")).text();
		const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text());
		const reported = Object.values(audit).reduce((sum, advisories) => sum + advisories.length, 0);
		const result = filterAdvisories(audit, installedVersions(lock), allowlist, new Date().toISOString().slice(0, 10));
		process.stdout.write(formatReport(result, reported));
		return result.failing.length > 0 ? 1 : 0;
	} catch (error) {
		if (!(error instanceof GateInputError)) throw error;
		process.stderr.write(`audit-gate: ${error.message}\n`);
		return 2;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
