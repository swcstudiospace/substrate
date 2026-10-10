#!/usr/bin/env bun
/**
 * Gated spike runner for Phase 31 (Lane A runtime unknowns).
 *
 * Step 0 re-asserts every RESEARCH.md local fact read-only (/dev/kvm absent,
 * no vmx/svm flags, 6420 served, 7411 free, >=10 GiB free, sandbox image
 * absent, agentos store size note). Any drift fails the run before any gated
 * step (D31-04, D31-06).
 *
 * Steps G1/G2/G3 print their OPERATOR-GATED banner plus the exact shell
 * commands and exit 3 (not-run-by-agent). The executor stops at the first
 * gated step; the operator runs the commands and pastes the record back
 * into 31-SPIKE.md.
 *
 * Phase 16 smoke guard: refuses when SUBSTRATE_URL points at port 7410 or a
 * non-loopback host. Read-only: touches no production unit, pulls no image,
 * writes no substrate row, opens no Linear/Notion call.
 *
 * Usage: `bun scripts/host-spike.ts --check` (CI-safe: step 0 + guards only).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";

/** RESEARCH.md baseline: 10 GiB floor in bytes (D31-07, LANEA-05). */
export const DISK_FLOOR_BYTES = 10_737_418_240;

/** The gated spike never touches the production checkout guard port. */
export const GUARDED_PORT = 7410;
/** Loopback hosts the spike may probe; anything else is refused. */
const LOOPBACK_HOSTS: Record<string, true> = {
	"127.0.0.1": true,
	localhost: true,
	"::1": true,
	"::ffff:127.0.0.1": true,
};

export type Step0Facts = {
	kvmAbsent: boolean;
	cpuFlags: string;
	hasVmxSvm: boolean;
	port6420Served: boolean;
	port7411Free: boolean;
	diskAvailBytes: number | null;
	sandboxImageAbsent: boolean | null;
	agentosStoreBytes: number | null;
};

export type Drift = { fact: string; expected: string; observed: string };

export type Deps = {
	exists: (path: string) => boolean;
	readText: (path: string) => string;
	probeTcp: (host: string, port: number) => Promise<boolean>;
	dfAvailBytes: () => number | null;
	imageAbsent: () => boolean | null;
	storeBytes: () => number | null;
};

function defaultDfAvailBytes(): number | null {
	try {
		const out = execFileSync("df", ["--output=avail", "-B1", "/"], { encoding: "utf8", timeout: 10_000 });
		const lines = out.trim().split("\n");
		const last = lines[lines.length - 1]?.trim() ?? "";
		const value = Number(last);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function defaultImageAbsent(): boolean | null {
	try {
		execFileSync("docker", ["image", "inspect", "substrate-sandbox:0.1"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
		return false;
	} catch (cause) {
		const message = String(cause);
		if (/No such image/i.test(message)) return true;
		return null;
	}
}

function defaultStoreBytes(): number | null {
	try {
		const out = execFileSync("du", ["-sb", "/var/lib/substrate/agentos"], { encoding: "utf8", timeout: 15_000 });
		const value = Number(out.split(/\s/)[0]);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function defaultProbeTcp(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host, port });
	const done = (open: boolean) => {
		socket.destroy();
		resolve(open);
	};
	socket.setTimeout(3000);
	socket.once("connect", () => done(true));
	socket.once("timeout", () => done(false));
	socket.once("error", () => done(false));
	return promise;
}

export const LIVE_DEPS: Deps = {
	exists: existsSync,
	readText: (path) => readFileSync(path, "utf8"),
	probeTcp: defaultProbeTcp,
	dfAvailBytes: defaultDfAvailBytes,
	imageAbsent: defaultImageAbsent,
	storeBytes: defaultStoreBytes,
};

/** Step 0: gather the read-only facts. No writes, no installs, no docker pulls. */
export async function runStep0(deps: Deps = LIVE_DEPS): Promise<Step0Facts> {
	const kvmAbsent = !deps.exists("/dev/kvm");
	let cpuFlags = "";
	try {
		cpuFlags = deps.readText("/proc/cpuinfo");
	} catch {
		cpuFlags = "";
	}
	const flagLine = cpuFlags
		.split("\n")
		.find((line) => line.startsWith("flags"))
		?.split(":")[1]
		?.split(/\s+/)
		.filter((flag) => flag === "vmx" || flag === "svm")
		.join(" ") ?? "";
	const port6420Served = await deps.probeTcp("127.0.0.1", 6420);
	const port7411Free = !(await deps.probeTcp("127.0.0.1", 7411));
	return {
		kvmAbsent,
		cpuFlags: flagLine,
		hasVmxSvm: flagLine !== "",
		port6420Served,
		port7411Free,
		diskAvailBytes: deps.dfAvailBytes(),
		sandboxImageAbsent: deps.imageAbsent(),
		agentosStoreBytes: deps.storeBytes(),
	};
}

/** Compare step-0 facts against the RESEARCH.md baseline; any entry stops the gated tail. */
export function findDrifts(facts: Step0Facts): Drift[] {
	const drifts: Drift[] = [];
	if (!facts.kvmAbsent) drifts.push({ fact: "/dev/kvm", expected: "absent", observed: "present" });
	if (facts.hasVmxSvm) drifts.push({ fact: "cpu flags", expected: "no vmx/svm", observed: facts.cpuFlags });
	if (!facts.port6420Served)
		drifts.push({ fact: "127.0.0.1:6420", expected: "served by rivet engine", observed: "connect refused" });
	if (!facts.port7411Free)
		drifts.push({ fact: "127.0.0.1:7411", expected: "free", observed: "listener present" });
	if (facts.diskAvailBytes === null) drifts.push({ fact: "disk avail", expected: "readable df output", observed: "unreadable" });
	else if (facts.diskAvailBytes < DISK_FLOOR_BYTES)
		drifts.push({
			fact: "disk avail",
			expected: `>= ${DISK_FLOOR_BYTES}`,
			observed: `${facts.diskAvailBytes}`,
		});
	if (facts.sandboxImageAbsent === false)
		drifts.push({ fact: "substrate-sandbox:0.1", expected: "absent", observed: "present (build already done?)" });
	if (facts.sandboxImageAbsent === null)
		drifts.push({ fact: "substrate-sandbox:0.1", expected: "inspectable", observed: "docker inspect unreadable" });
	return drifts;
}

/**
 * Phase 16 smoke guard: SUBSTRATE_URL must name a loopback host and must not
 * name the guarded production port. Returns the refusal, or null when probing
 * the given URL is allowed.
 */
export function guardTarget(raw: string | undefined): string | null {
	const value = (raw ?? "").trim() || "http://127.0.0.1:7411";
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return `refusing: SUBSTRATE_URL ${JSON.stringify(value)} is not a URL`;
	}
	if (LOOPBACK_HOSTS[parsed.hostname] !== true) {
		return `refusing: SUBSTRATE_URL host ${JSON.stringify(parsed.hostname)} is not loopback`;
	}
	const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
	if (Number(port) === GUARDED_PORT) {
		return `refusing: SUBSTRATE_URL must not point at guarded port ${GUARDED_PORT}`;
	}
	return null;
}

export type GatedStep = {
	id: "G1" | "G2" | "G3";
	title: string;
	preconditions: string[];
	commands: string[];
	record: string[];
};

/** The three OPERATOR-GATED steps: exact commands from RESEARCH.md spike design. */
export function gatedSteps(): GatedStep[] {
	return [
		{
			id: "G1",
			title: "Dependency footprint (npm ci in a scratch copy)",
			preconditions: [
				"step 0 drift-free (re-run --check)",
				`df avail >= ${DISK_FLOOR_BYTES} bytes (10 GiB floor)`,
				"scratch dir only: /tmp/host-spike-<date> (never the repo dir)",
			],
			commands: [
				"cp -r packages/host /tmp/host-spike-<date>/host",
				"cd /tmp/host-spike-<date>/host && time npm ci",
				"du -sb /tmp/host-spike-<date>/host",
				"node -e \"import('@rivet-dev/agentos').then(() => console.log('agentos resolves'))\"",
			],
			record: ["npm tree bytes (precedent ~2.2 GB)", "npm ci wall time", "agentos import resolves: yes/no"],
		},
		{
			id: "G2",
			title: "Engine share (connect to the existing loopback engine)",
			preconditions: [
				"G1 green (scratch install resolves agentos)",
				"127.0.0.1:6420 served (step 0)",
				"the other project's engine container keeps running untouched",
			],
			commands: [
				"cd /tmp/host-spike-<date>/host && node -e \"<open one session on scratch graph id via the shared 127.0.0.1:6420 engine>\"",
				"docker inspect gcs-rivet-rivet-engine-1 --format '{{.State.Health.Status}}'",
				"fallback (same gate, second run): spawn a loopback engine on a free port and open one session there",
			],
			record: [
				"shared engine serves the host actor: yes/no (+ refusal text)",
				"fallback engine result (only when the shared engine refuses)",
				"engine container still healthy after the session",
				"unit engine env fixed by this outcome (D31-04)",
			],
		},
		{
			id: "G3",
			title: "No-KVM boot (one VM open, echo prompt, dispose)",
			preconditions: [
				"G2 green (an engine serves the host actor)",
				"no sandbox container (image absent); no substrate writes; no Linear/Notion calls",
			],
			commands: [
				"cd /tmp/host-spike-<date>/host && node -e \"<one VM open on the scratch graph>\"",
				"<prompt the session with an echo-only text prompt>",
				"<dispose the VM, unload the session>",
			],
			record: [
				"boot verdict: pass (no KVM needed) or gap (exact /dev/kvm demand text)",
				"dispose-hook execution: yes/no",
				"fresh-vs-stale behavior note",
			],
		},
	];
}

/** Cleanup contract: dispose, unload, remove scratch, re-verify shared state. */
export function cleanupCommands(): string[] {
	return [
		"<dispose the spike VM>",
		"<unload the spike session>",
		"rm -rf /tmp/host-spike-<date>",
		"docker inspect gcs-rivet-rivet-engine-1 --format '{{.State.Health.Status}}'",
		"bun scripts/host-spike.ts --check",
	];
}

export function formatFacts(facts: Step0Facts): string {
	const disk = facts.diskAvailBytes === null ? "unreadable" : `${facts.diskAvailBytes} bytes`;
	const image =
		facts.sandboxImageAbsent === null ? "unreadable" : facts.sandboxImageAbsent ? "absent" : "present";
	const store = facts.agentosStoreBytes === null ? "unreadable" : `${facts.agentosStoreBytes} bytes`;
	return [
		`kvm: ${facts.kvmAbsent ? "absent" : "PRESENT"}`,
		`cpu vmx/svm: ${facts.hasVmxSvm ? `PRESENT (${facts.cpuFlags})` : "absent"}`,
		`127.0.0.1:6420: ${facts.port6420Served ? "served" : "refused"}`,
		`127.0.0.1:7411: ${facts.port7411Free ? "free" : "OCCUPIED"}`,
		`disk avail: ${disk} (floor ${DISK_FLOOR_BYTES})`,
		`substrate-sandbox:0.1: ${image}`,
		`agentos store: ${store}`,
	].join("\n");
}

if (import.meta.main) {
	const checkOnly = process.argv.includes("--check");
	const refusal = guardTarget(process.env.SUBSTRATE_URL);
	if (refusal) {
		process.stderr.write(`[host-spike] ${refusal}\n`);
		process.exit(2);
	}
	const facts = await runStep0();
	process.stdout.write(`[host-spike] step 0 facts (read-only)\n${formatFacts(facts)}\n`);
	const drifts = findDrifts(facts);
	if (drifts.length > 0) {
		for (const drift of drifts) {
			process.stdout.write(`[host-spike] DRIFT ${drift.fact}: expected ${drift.expected}; observed ${drift.observed}\n`);
		}
		process.exit(1);
	}
	if (checkOnly) {
		process.stdout.write("[host-spike] step 0 clean (--check: no gated step runs here)\n");
		process.exit(0);
	}
	const [next] = gatedSteps();
	if (!next) throw new Error("no gated steps defined");
	process.stdout.write(`[host-spike] OPERATOR-GATED ${next.id}: ${next.title}\n`);
	for (const precondition of next.preconditions) process.stdout.write(`[host-spike]   precondition: ${precondition}\n`);
	for (const command of next.commands) process.stdout.write(`[host-spike]   run: ${command}\n`);
	for (const field of next.record) process.stdout.write(`[host-spike]   record: ${field}\n`);
	process.stdout.write(`[host-spike] stopping: ${next.id} needs operator approval (exit 3)\n`);
	process.exit(3);
}
