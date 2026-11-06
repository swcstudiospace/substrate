// Containment audit (D-01, D-04, D-08, D-12): pure checks over a docker-inspect object and over
// rivet's storage bytes, plus the operator CLI that runs them on the live host. Erasable TypeScript
// (node runs it directly); no rivet import, so audit.test.ts loads it under bun without node_modules.
//
// Credential rule (T-03-06-03): the CLI receives substrate.env through systemd's EnvironmentFile,
// holds the values in memory only to look for them in storage, and prints names, modes and counts.
//
//   node src/audit.ts --sandbox-net <internal|published_loopback> [--sanctioned <NAME>]...

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_LABEL, SANDBOX_NETWORK, type SandboxNetwork, WORKTREES_ROOT, worktreeRootsOf } from "./sandbox-options.ts";

const SECRET_SEGMENTS: Record<string, true> = {
	KEY: true,
	KEYS: true,
	TOKEN: true,
	TOKENS: true,
	SECRET: true,
	SECRETS: true,
	PASSWORD: true,
	PASSWD: true,
	PAT: true,
	CREDENTIAL: true,
	CREDENTIALS: true,
	PRIVATE: true,
	COOKIE: true,
};

/** Values shorter than this are not scanned: too likely to occur in unrelated bytes. */
const MIN_SECRET_LENGTH = 12;

/** A name is secret-bearing when one of its underscore-delimited segments is a credential word (D-08). */
export function secretKey(name: string): boolean {
	return name.split("_").some((segment) => SECRET_SEGMENTS[segment] === true);
}

/**
 * Non-overlapping occurrences of each value's UTF-8 bytes in `data`, keyed by the caller's label.
 * Values under MIN_SECRET_LENGTH are left out of the result entirely; values never appear in it.
 */
export function secretHits(data: Uint8Array, values: Array<{ label: string; value: string }>): Record<string, number> {
	const haystack = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	const hits: Record<string, number> = {};
	for (const { label, value } of values) {
		if (value.length < MIN_SECRET_LENGTH) continue;
		const needle = Buffer.from(value, "utf8");
		let count = 0;
		let at = haystack.indexOf(needle);
		while (at !== -1) {
			count += 1;
			at = haystack.indexOf(needle, at + needle.length);
		}
		hits[label] = count;
	}
	return hits;
}

/** Leak total over unsanctioned labels; sanctioned names reported on their own (0 when absent). */
export function auditTotals(hits: Record<string, number>, sanctioned: readonly string[]): { total: number; sanctioned: Record<string, number> } {
	let total = 0;
	for (const [label, count] of Object.entries(hits)) {
		if (!sanctioned.includes(label)) total += count;
	}
	const named: Record<string, number> = {};
	for (const name of sanctioned) named[name] = hits[name] ?? 0;
	return { total, sanctioned: named };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * D-01 shape of a running sandbox container, from `docker inspect` (T-03-06-05): labelled with the
 * graph id, command port published on 127.0.0.1 only (or not published at all on the internal
 * network), not privileged, no docker socket, only the graph's own worktree writable, token auth on.
 * Returns one `<name>[:detail]` string per violation.
 */
export function containerViolations(inspect: Record<string, unknown>, network: SandboxNetwork, worktreeRoots: readonly string[] = [WORKTREES_ROOT]): string[] {
	const violations: string[] = [];
	const config = asRecord(inspect.Config);
	const host = asRecord(inspect.HostConfig);

	const labels = asRecord(config.Labels);
	const graphId = labels[GRAPH_LABEL];
	if (typeof graphId !== "string" || graphId === "") violations.push("label");
	const ownWorktrees = typeof graphId === "string" && graphId !== "" ? worktreeRoots.map((root) => `${root}/${graphId}`) : null;

	const bindings = asRecord(host.PortBindings);
	let published = 0;
	let badBinding = false;
	for (const [port, list] of Object.entries(bindings)) {
		for (const entry of asArray(list)) {
			published += 1;
			const hostIp = asRecord(entry).HostIp;
			if (hostIp !== "127.0.0.1") {
				badBinding = true;
				violations.push(`port_binding:${port}:${typeof hostIp === "string" && hostIp !== "" ? hostIp : "unbound"}`);
			}
		}
	}
	if (network === "internal") {
		const mode = host.NetworkMode;
		if (mode !== SANDBOX_NETWORK) violations.push(`network_mode:${typeof mode === "string" ? mode : "unset"}`);
		else if (published > 0 && !badBinding) violations.push(`network_mode:published:${published}`);
	}

	if (host.Privileged === true) violations.push("privileged");

	const cmd = asArray(config.Cmd);
	if (cmd.includes("--no-token") || !cmd.includes("--token")) violations.push("token");

	let socket = false;
	for (const bind of asArray(host.Binds)) {
		if (typeof bind !== "string") continue;
		const parts = bind.split(":");
		const hostPath = parts[0] ?? "";
		const containerPath = parts[1] ?? "";
		const mode = parts[2] ?? "rw";
		if (hostPath.includes("docker.sock") || containerPath.includes("docker.sock")) {
			socket = true;
			continue;
		}
		if (mode === "ro") continue;
		// The graph's own worktree is the one writable mount; without a label the root is all that can be checked.
		const worktreeBind =
			containerPath === "/work" && (ownWorktrees !== null ? ownWorktrees.includes(hostPath) : worktreeRoots.some((root) => hostPath.startsWith(`${root}/`)));
		if (worktreeBind) continue;
		violations.push(`writable_bind:${bind}`);
	}
	for (const mount of asArray(inspect.Mounts)) {
		const m = asRecord(mount);
		const source = typeof m.Source === "string" ? m.Source : "";
		const destination = typeof m.Destination === "string" ? m.Destination : "";
		if (source.includes("docker.sock") || destination.includes("docker.sock")) socket = true;
	}
	if (socket) violations.push("docker_sock");

	return violations;
}

type AuditReport = {
	storageMode: string;
	/** Hits per secret-bearing name, sanctioned names included. */
	secretHits: Record<string, number>;
	/** Hits per non-secret configuration name (informational, never a leak). */
	configHits: Record<string, number>;
	sanctioned: readonly string[];
	containers: Array<{ id: string; violations: string[] }>;
};

/** The CLI's whole output: `key=value` lines of names, modes and integers (T-03-06-03). */
export function formatAudit(report: AuditReport): string[] {
	const lines: string[] = [`storage_mode=${report.storageMode}`];
	const totals = auditTotals(report.secretHits, report.sanctioned);
	const secretNames = Object.keys(report.secretHits)
		.filter((name) => !report.sanctioned.includes(name))
		.sort();
	lines.push(`secret_keys=${secretNames.length > 0 ? secretNames.join(",") : "none"}`);
	for (const name of secretNames) lines.push(`secret_hits_${name}=${report.secretHits[name]}`);
	lines.push(`secret_hits_total=${totals.total}`);
	lines.push(`sanctioned_keys=${report.sanctioned.length > 0 ? [...report.sanctioned].join(",") : "none"}`);
	for (const name of report.sanctioned) lines.push(`sanctioned_hits_${name}=${totals.sanctioned[name]}`);
	const configNames = Object.keys(report.configHits).sort();
	lines.push(`config_keys=${configNames.length > 0 ? configNames.join(",") : "none"}`);
	let configTotal = 0;
	for (const name of configNames) {
		lines.push(`config_hits_${name}=${report.configHits[name]}`);
		configTotal += report.configHits[name] ?? 0;
	}
	lines.push(`config_hits_total=${configTotal}`);
	lines.push(`containers_inspected=${report.containers.length}`);
	let violationCount = 0;
	for (const container of report.containers) {
		for (const violation of container.violations) {
			violationCount += 1;
			lines.push(`container_violation=${container.id.slice(0, 12)}:${violation}`);
		}
	}
	lines.push(`container_violations=${violationCount}`);
	return lines;
}

function* regularFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* regularFiles(path);
		else if (entry.isFile()) yield path;
	}
}

function parseArgs(argv: readonly string[]): { sanctioned: string[]; network: SandboxNetwork } {
	const sanctioned: string[] = [];
	let network: SandboxNetwork | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--sanctioned") {
			const name = argv[i + 1];
			if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("--sanctioned needs an env var NAME");
			sanctioned.push(name);
			i += 1;
		} else if (arg === "--sandbox-net") {
			const value = argv[i + 1];
			if (value !== "internal" && value !== "published_loopback") throw new Error("--sandbox-net must be internal or published_loopback");
			network = value;
			i += 1;
		} else {
			throw new Error(`unknown argument ${JSON.stringify(arg)}`);
		}
	}
	if (network === null) throw new Error("--sandbox-net is required (03-01-SPIKE.md sandbox_net)");
	return { sanctioned, network };
}

function runCli(): void {
	const { sanctioned, network } = parseArgs(process.argv.slice(2));
	const storage = process.env.RIVETKIT_STORAGE_PATH?.trim() || "/var/lib/substrate/agentos";
	const storageMode = (statSync(storage).mode & 0o777).toString(8);

	const scanned: Array<{ label: string; value: string }> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH || value.startsWith("/")) continue;
		scanned.push({ label: name, value });
	}
	const totalsByLabel: Record<string, number> = {};
	for (const { label } of scanned) totalsByLabel[label] = 0;
	for (const path of regularFiles(storage)) {
		const hits = secretHits(readFileSync(path), scanned);
		for (const [label, count] of Object.entries(hits)) totalsByLabel[label] = (totalsByLabel[label] ?? 0) + count;
	}
	const secret: Record<string, number> = {};
	const config: Record<string, number> = {};
	for (const [label, count] of Object.entries(totalsByLabel)) {
		if (secretKey(label) || sanctioned.includes(label)) secret[label] = count;
		else config[label] = count;
	}
	for (const name of sanctioned) secret[name] = secret[name] ?? 0;

	const ids = execFileSync("docker", ["ps", "-q", "--filter", `label=${GRAPH_LABEL}`], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const containers: AuditReport["containers"] = [];
	for (const id of ids) {
		const parsed: unknown = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }));
		const inspect = asRecord(asArray(parsed)[0]);
		containers.push({ id, violations: containerViolations(inspect, network, worktreeRootsOf(process.env)) });
	}

	for (const line of formatAudit({ storageMode, secretHits: secret, configHits: config, sanctioned, containers })) {
		process.stdout.write(`${line}\n`);
	}
}

// ratchet-entrypoint: runs only when executed directly, so the CLI may exit with a status code.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		runCli();
	} catch (cause) {
		process.stderr.write(`[substrate-host audit] ${cause instanceof Error ? cause.message : String(cause)}\n`);
		process.exit(2);
	}
}
