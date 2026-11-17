/**
 * The staged sandbox drop-ins of uplift-5 U5-2 (`infra/vps/<unit>.service.d/30-sandbox.conf.example`),
 * checked offline: every unit has one with a declared class and ceiling, none uses a directive the
 * runbook rejects, every directive is a real one the doctor can verify, the header's transient-test
 * command matches the file, and, where `systemd-analyze security --offline` exists, the unit plus its
 * drop-in scores at or under the declared ceiling and below the unit without it.
 *
 * Nothing here starts a unit, calls systemctl or reads the host: the analyzer is given files copied into a
 * scratch directory. When the analyzer cannot do an offline score (systemd older than 252, or absent) the
 * exposure tests are SKIPPED and a warning says so; they never pass silently.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sectionDirectives } from "./doctor-runtime.ts";
import { parseExposure, parseSandboxExample, SANDBOX_DIRECTIVES, SANDBOX_EXAMPLE_SUFFIX, type SandboxSpec } from "./doctor-sandbox.ts";

const infraDir = join(import.meta.dir, "..", "infra", "vps");
/** The live score every unit shared before these drop-ins (uplift-5 U5-2 brief, `systemd-analyze security`, 2026-10-14). */
const BASELINE = 8.1;

interface Staged {
	unit: string;
	file: string;
	text: string;
	spec: SandboxSpec;
}

const services = readdirSync(infraDir)
	.filter((n) => n.startsWith("substrate-") && n.endsWith(".service"))
	.sort();

function stagedFor(service: string): Staged | null {
	const dir = join(infraDir, `${service}.d`);
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(SANDBOX_EXAMPLE_SUFFIX));
	} catch {
		return null;
	}
	const file = names[0];
	if (file === undefined) return null;
	const text = readFileSync(join(dir, file), "utf8");
	return { unit: service, file: join(dir, file), text, spec: parseSandboxExample(file, text) };
}

const staged = services.map((s) => stagedFor(s));

/** Directive names the runbook REJECTS, and why (docs/runbooks/vps-hardening.md "Rejected directives"). */
const REJECTED: Readonly<Record<string, string>> = {
	MemoryDenyWriteExecute: "bun's JIT needs writable+executable pages",
	User: "bun lives under /root/.local; a non-root user cannot execute it",
	DynamicUser: "implies a non-root user",
	SystemCallFilter: "the bun, node and python3 syscall sets are unmeasured; a wrong filter kills the process",
	SystemCallLog: "belongs with a syscall filter",
	PrivateNetwork: "units reach Railway, Greptile and loopback services",
	IPAddressDeny: "units reach Railway and Tailscale endpoints",
	IPAddressAllow: "units reach Railway and Tailscale endpoints",
	PrivateDevices: "host and docker socket paths are unmeasured",
};

/** Capabilities the units rely on: file ownership and permission overrides, identity changes and signals. */
const KEPT_CAPABILITIES = ["CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER", "CAP_CHOWN", "CAP_SETUID", "CAP_SETGID", "CAP_KILL"];

/** System trees a ReadWritePaths= entry must never cover: they are the point of ProtectSystem=strict. */
const SYSTEM_TREES = new Set(["/", "/usr", "/etc", "/boot", "/var", "/opt", "/srv", "/bin", "/sbin", "/lib"]);

function directivesOf(spec: SandboxSpec, name: string): string[] {
	return spec.directives.filter(([n]) => n === name).map(([, v]) => v);
}

describe("coverage", () => {
	test("every substrate unit has a staged sandbox drop-in with a declared class and ceiling", () => {
		expect(services.length).toBeGreaterThanOrEqual(15);
		const problems: string[] = [];
		for (const [i, entry] of staged.entries()) {
			const unit = services[i] ?? "?";
			if (entry === null) {
				problems.push(`${unit}: no ${SANDBOX_EXAMPLE_SUFFIX} under ${unit}.d`);
				continue;
			}
			if (entry.spec.class === null) problems.push(`${unit}: missing "# sandbox-class: A|B"`);
			if (entry.spec.ceiling === null || entry.spec.ceiling >= BASELINE) problems.push(`${unit}: "# exposure-ceiling:" missing or not below ${BASELINE}`);
			if (entry.spec.file !== "30-sandbox.conf") problems.push(`${unit}: installs as ${entry.spec.file}, expected 30-sandbox.conf (10 and 20 are taken)`);
		}
		expect(problems).toEqual([]);
	});
});

describe("rejected directives and class rules", () => {
	test("no example uses a rejected directive, an Exec* action or a docker prune", () => {
		const problems: string[] = [];
		for (const entry of staged) {
			if (entry === null) continue;
			for (const [name] of entry.spec.directives) {
				if (Object.hasOwn(REJECTED, name)) problems.push(`${entry.unit}: ${name} (${REJECTED[name]})`);
				if (/^Exec/.test(name)) problems.push(`${entry.unit}: ${name} runs a command; a sandbox drop-in must only restrict`);
			}
			if (/prune/i.test(entry.text)) problems.push(`${entry.unit}: mentions prune; substrate reports docker space, it never frees it`);
		}
		expect(problems).toEqual([]);
	});

	test("Class B keeps ProtectHome=false; Class A is read-only home; both end up with ProtectSystem=strict", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			expect(directivesOf(entry.spec, "ProtectSystem")).toEqual(["strict"]);
			const home = directivesOf(entry.spec, "ProtectHome");
			if (entry.spec.class === "B") expect({ unit: entry.unit, home }).toEqual({ unit: entry.unit, home: ["false"] });
			else expect({ unit: entry.unit, home }).toEqual({ unit: entry.unit, home: ["read-only"] });
		}
	});

	test("the four units that write inside operator git repos are Class B; the stateless ones are Class A", () => {
		const classOf = (service: string): SandboxSpec["class"] => staged[services.indexOf(service)]?.spec.class ?? null;
		for (const service of ["substrate-collector-muse.service", "substrate-dispatcher.service", "substrate-collector-herdr.service", "substrate-host.service"]) {
			expect({ service, class: classOf(service) }).toEqual({ service, class: "B" });
		}
		for (const service of ["substrate-mcp.service", "substrate-anchor.service", "substrate-doctor.service", "substrate-alert@.service", "substrate-collector-grok.service"]) {
			expect({ service, class: classOf(service) }).toEqual({ service, class: "A" });
		}
	});

	test("CapabilityBoundingSet is a deny list that keeps the file-permission, identity and signal capabilities", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			const sets = directivesOf(entry.spec, "CapabilityBoundingSet");
			expect(sets).toHaveLength(1);
			const value = sets[0] ?? "";
			// An empty set (drop everything) or an allow list would strip CAP_DAC_OVERRIDE from a root unit.
			expect({ unit: entry.unit, denyList: value.startsWith("~CAP_") }).toEqual({ unit: entry.unit, denyList: true });
			const denied = value.replace(/^~/, "").split(/\s+/);
			for (const kept of KEPT_CAPABILITIES) expect({ unit: entry.unit, kept, denied: denied.includes(kept) }).toEqual({ unit: entry.unit, kept, denied: false });
			for (const cap of denied) expect(cap).toMatch(/^CAP_[A-Z_]+$/);
		}
	});

	test("ReadWritePaths are absolute, never a system tree, and a Class A unit never opens /root", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			const paths = directivesOf(entry.spec, "ReadWritePaths").flatMap((v) => v.split(/\s+/).filter((p) => p !== ""));
			for (const raw of paths) {
				const path = raw.replace(/^[-+]+/, "");
				expect({ unit: entry.unit, path, absolute: path.startsWith("/") }).toEqual({ unit: entry.unit, path, absolute: true });
				expect({ unit: entry.unit, path, system: SYSTEM_TREES.has(path.replace(/\/+$/, "") || "/") }).toEqual({ unit: entry.unit, path, system: false });
				if (entry.spec.class === "A") expect({ unit: entry.unit, path, home: path === "/root" || path.startsWith("/root/") }).toEqual({ unit: entry.unit, path, home: false });
			}
		}
	});

	test("the archive units open their archive mount and nothing else, without the optional `-` prefix", () => {
		for (const [service, mount] of [
			["substrate-index-archive.service", "/mnt/index-archive"],
			["substrate-ledger-archive.service", "/mnt/ledger-archive"],
		] as const) {
			const paths = staged[services.indexOf(service)]?.spec.directives.filter(([n]) => n === "ReadWritePaths").map(([, v]) => v);
			expect({ service, paths }).toEqual({ service, paths: [mount] });
		}
	});
});

describe("directives are real and match the transient test in the header", () => {
	test("every directive name is one the doctor can verify against systemctl show (no typos)", () => {
		const known = new Set(SANDBOX_DIRECTIVES);
		const unknown: string[] = [];
		for (const entry of staged) {
			if (entry === null) continue;
			for (const [name] of entry.spec.directives) if (!known.has(name)) unknown.push(`${entry.unit}: ${name}`);
		}
		expect(unknown).toEqual([]);
	});

	test("the systemd-run command in each header carries exactly the file's directives (plus a throwaway state directory)", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			const fromHeader = headerCommandProperties(entry.text);
			const fromFile = entry.spec.directives.map(([n, v]) => `${n}=${v}`);
			const extra = fromHeader.filter((p) => !fromFile.includes(p));
			expect({ unit: entry.unit, missing: fromFile.filter((p) => !fromHeader.includes(p)) }).toEqual({ unit: entry.unit, missing: [] });
			expect({ unit: entry.unit, extra }).toEqual({ unit: entry.unit, extra: extra.filter((p) => p === "StateDirectory=u5-sandbox-test") });
		}
	});

	test("no header test command uses the shared state directory: a transient StateDirectory=substrate would reset /var/lib/substrate to mode 0755", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			const props = headerCommandProperties(entry.text);
			expect({ unit: entry.unit, shared: props.filter((p) => /^StateDirectory(Mode)?=/.test(p) && p !== "StateDirectory=u5-sandbox-test") }).toEqual({ unit: entry.unit, shared: [] });
			// A throwaway directory is only useful if the probe checks it, and is only safe if the header says to remove it.
			if (props.includes("StateDirectory=u5-sandbox-test")) {
				expect(entry.text).toContain("test -w /var/lib/u5-sandbox-test");
				expect(entry.text).toContain("rm -rf /var/lib/u5-sandbox-test");
			}
		}
	});

	test("headerCommandProperties reads quoted values and line continuations (the helper this check relies on)", () => {
		const text = "# x\n#   systemd-run --pipe \\\n#     -p A=b \\\n#     -p 'C=~D E' \\\n#     /bin/true\n[Service]\n";
		expect(headerCommandProperties(text)).toEqual(["A=b", "C=~D E"]);
	});
});

/** The `-p NAME=value` arguments of the `systemd-run` command written in a header comment. */
function headerCommandProperties(text: string): string[] {
	const comment = text
		.split("\n")
		.filter((l) => l.startsWith("#"))
		.map((l) => l.replace(/^#\s?/, ""));
	const start = comment.findIndex((l) => l.trimStart().startsWith("systemd-run "));
	if (start < 0) return [];
	let command = "";
	for (const line of comment.slice(start)) {
		const piece = line.trim();
		if (piece.endsWith("\\")) {
			command += `${piece.slice(0, -1)} `;
			continue;
		}
		command += piece;
		break;
	}
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	for (const ch of command) {
		if (ch === "'") quoted = !quoted;
		else if (/\s/.test(ch) && !quoted) {
			if (current !== "") tokens.push(current);
			current = "";
		} else current += ch;
	}
	if (current !== "") tokens.push(current);
	return tokens.flatMap((t, i) => (tokens[i - 1] === "-p" ? [t] : []));
}


// ── Writable-path coverage ───────────────────────────────────────────────────

/**
 * Every path each unit's code writes under `/var/lib/substrate` (and the operator-owned trees class B
 * writes), with the source that writes it. The unit file's `Environment=` values are added to this table by
 * the test, so a new `Environment=...=/var/lib/substrate/...` line is covered automatically; this table is
 * for paths the CODE chooses by default. Keep it in step with the "Per unit" table of the runbook.
 */
const WRITES: ReadonlyArray<{ unit: string; path: string; source: string }> = [
	{ unit: "substrate-mcp.service", path: "/var/lib/substrate/mcp-audit.jsonl", source: "SUBSTRATE_AUDIT_PATH, packages/mcp-server/src/config.ts:646" },
	{ unit: "substrate-mcp.service", path: "/var/lib/substrate/slo-checkpoint.json", source: "packages/mcp-server/src/config.ts:433, observe.ts:431" },
	{ unit: "substrate-mcp.service", path: "/var/lib/substrate/skills/proposals.jsonl", source: "packages/mcp-server/src/skills/propose.ts:36-41" },
	{ unit: "substrate-mcp.service", path: "/var/lib/substrate/desktop/run", source: "packages/mcp-server/src/config.ts:588, desktop/driver.ts:406" },
	{ unit: "substrate-collector-grok.service", path: "/var/lib/substrate/grok-offsets.json", source: "packages/collectors/src/grok.ts:32" },
	{ unit: "substrate-collector-herdr.service", path: "/var/lib/substrate/herdr-offsets.json", source: "packages/collectors/src/herdr-state.ts:90" },
	{ unit: "substrate-collector-muse.service", path: "/var/lib/substrate/muse-offsets.json", source: "packages/collectors/src/muse.ts:38,74-76" },
	{ unit: "substrate-collector-muse.service", path: "/root/src/repos/some-repo/.git/info/exclude", source: "packages/collectors/src/muse.ts:310-331" },
	{ unit: "substrate-docs-canary.service", path: "/var/lib/substrate/docs-canary-last.json", source: "scripts/docs-golden.ts:398,629-630" },
	{ unit: "substrate-doctor.service", path: "/var/lib/substrate/doctor-last.json", source: "scripts/doctor-runtime.ts DEFAULT_STATE_FILE" },
	{ unit: "substrate-skills-sync.service", path: "/var/lib/substrate/skills/refresh-pending.json", source: "packages/projector/src/skills-sync.ts:86,137-140" },
	{ unit: "substrate-skills-sync.service", path: "/var/lib/substrate/phase4-baseline/projector/run", source: "packages/projector/src/skills.ts:105,284-301" },
	{ unit: "substrate-skills-sync.service", path: "/var/lib/substrate/skills/projector-warned.json", source: "packages/projector/src/skills.ts:106,372-377" },
	{ unit: "substrate-skills-sync.service", path: "/root/agent-skills/.git/FETCH_HEAD", source: "packages/projector/src/skills-sync.ts:225-267 (git fetch, merge)" },
	{ unit: "substrate-skills-sync.service", path: "/root/.claude/skills/x", source: "packages/projector/src/skills.ts:83" },
	{ unit: "substrate-skills-sync.service", path: "/root/.cursor/skills/x", source: "packages/projector/src/skills.ts:97" },
	{ unit: "substrate-skills-bridge.service", path: "/var/lib/substrate/miner/bridge-log.jsonl", source: "packages/miner/src/substrate_miner/bridge.py:45-46" },
	{ unit: "substrate-skills-bridge.service", path: "/root/.hermes/pending/skills/x", source: "packages/miner/src/substrate_miner/bridge.py:42" },
	{ unit: "substrate-skills-bridge.service", path: "/root/agent-skills/x", source: "packages/miner/src/substrate_miner/bridge.py:44" },
	{ unit: "substrate-skills-bridge.service", path: "/root/.omp/agent/substrate-pending/x", source: "packages/miner/src/substrate_miner/bridge.py:52" },
	{ unit: "substrate-skills-bridge.service", path: "/root/.grok/plugin-data/skill-autonomy/pending/x", source: "packages/miner/src/substrate_miner/bridge.py:53" },
	{ unit: "substrate-dispatcher.service", path: "/var/lib/substrate/dispatcher/lock", source: "packages/dispatcher/src/substrate_dispatcher/launcher.py:29" },
	{ unit: "substrate-dispatcher.service", path: "/var/lib/substrate/worktrees/gid", source: "packages/dispatcher/src/substrate_dispatcher/worktree.py:21" },
	{ unit: "substrate-dispatcher.service", path: "/root/src/repos/agent-substrate/.git/worktrees/gid", source: "packages/dispatcher/src/substrate_dispatcher/worktree.py:22,134-147" },
	{ unit: "substrate-dispatcher.service", path: "/root/.hermes/sessions/x", source: "launcher.py:191 (HOME=/root for the Hermes child)" },
	{ unit: "substrate-host.service", path: "/var/lib/substrate/agentos/tasks/x.json", source: "RIVETKIT_STORAGE_PATH, packages/host/src/main.ts:64" },
	{ unit: "substrate-host.service", path: "/var/lib/substrate/worktrees/gid", source: "packages/host/src/sandbox-options.ts:12" },
	{ unit: "substrate-host.service", path: "/root/.claude/x", source: "packages/host/src/mcp-proxy.ts:219-225 (HOME=/root OAuth store refresh)" },
	{ unit: "substrate-index-archive.service", path: "/mnt/index-archive/snapshot", source: "packages/mcp-server/src/index-archive.ts:422" },
	{ unit: "substrate-ledger-archive.service", path: "/mnt/ledger-archive/day", source: "packages/mcp-server/src/ledger-archive.ts:434" },
	// anchor, index-sweep and alert@ write no file of their own; anchor and sweep still declare the state directory.
];

function readUnit(service: string): { base: string; dropIns: string[] } {
	const dir = join(infraDir, `${service}.d`);
	const dropIns: string[] = [];
	try {
		for (const name of readdirSync(dir).sort()) if (name.endsWith(".conf")) dropIns.push(readFileSync(join(dir, name), "utf8"));
	} catch {
		// No drop-in directory.
	}
	return { base: readFileSync(join(infraDir, service), "utf8"), dropIns };
}

/** Whether `path` is inside `root` (equal or below). */
function inside(path: string, root: string): boolean {
	const clean = root.replace(/\/+$/, "");
	return path === clean || path.startsWith(`${clean}/`);
}

/** The directories the unit can write once the example is installed: base StateDirectory/LogsDirectory plus the example's ReadWritePaths. */
function writableRoots(service: string, spec: SandboxSpec): string[] {
	const { base, dropIns } = readUnit(service);
	const roots: string[] = ["/tmp", "/var/tmp"];
	for (const text of [base, ...dropIns]) {
		for (const [key, value] of sectionDirectives(text, "Service")) {
			if (key === "StateDirectory") roots.push(...value.split(/\s+/).filter((v) => v !== "").map((v) => `/var/lib/${v}`));
			if (key === "LogsDirectory") roots.push(...value.split(/\s+/).filter((v) => v !== "").map((v) => `/var/log/${v}`));
			if (key === "RuntimeDirectory") roots.push(...value.split(/\s+/).filter((v) => v !== "").map((v) => `/run/${v}`));
		}
	}
	for (const [name, value] of spec.directives) {
		if (name === "ReadWritePaths") roots.push(...value.split(/\s+/).filter((v) => v !== "").map((v) => v.replace(/^[-+]+/, "")));
	}
	// Class B with ProtectHome=false keeps /root writable only where ReadWritePaths= says so (ProtectSystem=strict).
	return roots;
}

/** `Environment=`/ExecStart values that name a path under /var/lib or /mnt: the unit's own declared write targets. */
function declaredWritePaths(service: string): string[] {
	const { base, dropIns } = readUnit(service);
	const found: string[] = [];
	for (const text of [base, ...dropIns]) {
		for (const [key, value] of sectionDirectives(text, "Service")) {
			if (key !== "Environment" && key !== "ExecStart") continue;
			for (const m of value.matchAll(/(?:^|[=\s"'])(\/(?:var\/lib|mnt)\/[^\s"']+)/g)) if (m[1] !== undefined) found.push(m[1]);
		}
	}
	return found;
}

describe("writable paths survive ProtectSystem=strict", () => {
	test("every path a unit declares or its code writes is under a base StateDirectory=/LogsDirectory= or an example ReadWritePaths=", () => {
		const uncovered: string[] = [];
		for (const [i, service] of services.entries()) {
			const entry = staged[i];
			if (entry === null || entry === undefined) continue;
			const roots = writableRoots(service, entry.spec);
			const want = [
				...declaredWritePaths(service).map((path) => ({ path, source: "Environment=/ExecStart= of the unit" })),
				...WRITES.filter((w) => w.unit === service),
			];
			for (const { path, source } of want) {
				if (!roots.some((root) => inside(path, root))) uncovered.push(`${service}: ${path} (${source}) is read-only under ProtectSystem=strict`);
			}
		}
		expect(uncovered).toEqual([]);
	});

	test("the audit shows the table is not vacuous: every unit with a base StateDirectory= or a state write is named, and a missing grant is caught", () => {
		// The pre-fix skills-sync example granted /root paths only and the base unit has no StateDirectory=,
		// so these three code paths were read-only. Re-run the check against exactly that shape.
		const { base, dropIns } = readUnit("substrate-skills-sync.service");
		expect(base).not.toMatch(/^StateDirectory=/m);
		expect(dropIns.join("")).not.toMatch(/StateDirectory=/);
		const preFix = parseSandboxExample("30-sandbox.conf.example", "[Service]\nProtectSystem=strict\nProtectHome=false\nReadWritePaths=-/root/agent-skills -/root/.claude\n");
		const roots = writableRoots("substrate-skills-sync.service", preFix);
		const stateWrites = WRITES.filter((w) => w.unit === "substrate-skills-sync.service" && w.path.startsWith("/var/lib/substrate"));
		expect(stateWrites.length).toBe(3);
		for (const w of stateWrites) expect(roots.some((root) => inside(w.path, root))).toBe(false);
		// And the shipped example does cover them.
		const shipped = staged[services.indexOf("substrate-skills-sync.service")];
		const shippedRoots = writableRoots("substrate-skills-sync.service", shipped?.spec ?? preFix);
		for (const w of stateWrites) expect(shippedRoots.some((root) => inside(w.path, root))).toBe(true);
	});

	test("a unit that shares /var/lib/substrate never grants it through StateDirectory= in an example (the 0755 default would reopen the audit directory)", () => {
		for (const entry of staged) {
			if (entry === null) continue;
			expect(entry.spec.directives.filter(([n]) => n === "StateDirectory" || n === "StateDirectoryMode")).toEqual([]);
		}
	});
});

// ── Offline exposure ─────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "u5-s2-sandbox-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `systemd-analyze security --offline=true <unit file>`: the overall score, or null when the analyzer cannot. */
function offlineScore(unitPath: string): number | null {
	try {
		const run = Bun.spawnSync(["systemd-analyze", "security", "--offline=true", unitPath, "--no-pager"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
		if (run.exitCode !== 0) return null;
		return parseExposure(run.stdout.toString())?.score ?? null;
	} catch {
		return null;
	}
}

/** The unit and its real `*.conf` drop-ins in `dir`, with the example installed as `30-sandbox.conf` when `withSandbox`. */
function assemble(service: string, dir: string, withSandbox: boolean): string {
	mkdirSync(join(dir, `${service}.d`), { recursive: true });
	copyFileSync(join(infraDir, service), join(dir, service));
	for (const name of readdirSync(join(infraDir, `${service}.d`))) {
		if (name.endsWith(".conf")) copyFileSync(join(infraDir, `${service}.d`, name), join(dir, `${service}.d`, name));
	}
	const entry = staged[services.indexOf(service)];
	if (withSandbox && entry !== null && entry !== undefined) copyFileSync(entry.file, join(dir, `${service}.d`, entry.spec.file));
	return join(dir, service);
}

const probe = services[0] === undefined ? null : offlineScore(assemble(services[0], join(scratch, "probe"), false));
const offlineSupported = probe !== null;
if (!offlineSupported) {
	console.warn("sandbox-dropins: `systemd-analyze security --offline=true` is unavailable or too old (needs systemd 252+); the exposure-ceiling tests are SKIPPED, not passed");
}

describe("offline exposure (systemd-analyze security --offline=true)", () => {
	test.skipIf(!offlineSupported)("the analyzer scores the shipped unit without its drop-in as EXPOSED (7 or more)", () => {
		// Premise of every ceiling below: the unit alone is EXPOSED. If the shipped hardening block changes, revisit them.
		expect(probe ?? 0).toBeGreaterThanOrEqual(7);
	});

	for (const [i, service] of services.entries()) {
		test.skipIf(!offlineSupported)(`${service} with its drop-in scores at or under its declared ceiling and below the unit alone`, () => {
			const entry = staged[i];
			expect(entry).not.toBeNull();
			const ceiling = entry?.spec.ceiling ?? 0;
			const without = offlineScore(assemble(service, join(scratch, `${service}-base`), false));
			const withDropIn = offlineScore(assemble(service, join(scratch, `${service}-hardened`), true));
			expect(without).not.toBeNull();
			expect(withDropIn).not.toBeNull();
			expect(withDropIn ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(ceiling);
			expect(withDropIn ?? Number.POSITIVE_INFINITY).toBeLessThan(without ?? 0);
			if (entry?.spec.class === "A") expect(withDropIn ?? Number.POSITIVE_INFINITY).toBeLessThan(BASELINE);
		});

		test.skipIf(!offlineSupported)(`${service}: systemd's own parser accepts every line of the drop-in (no unknown key, no bad value)`, () => {
			const path = assemble(service, join(scratch, `${service}-verify`), true);
			const run = Bun.spawnSync(["systemd-analyze", "verify", path], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
			const complaints = `${run.stdout.toString()}${run.stderr.toString()}`
				.split("\n")
				.filter((l) => l.includes("30-sandbox.conf"));
			expect(complaints).toEqual([]);
		});
	}
});

describe("corpus units", () => {
	test("state directories are the two corpus subdirectories, matching ReadWritePaths", () => {
		for (const name of ["substrate-corpus-watch.service", "substrate-corpus-sync.service"]) {
			const text = readFileSync(join(infraDir, name), "utf8");
			expect(text).not.toMatch(/^StateDirectory=substrate$/m);
			expect(text).toContain("StateDirectory=substrate/corpus-mirrors\n");
			expect(text).toContain("StateDirectory=substrate/corpus-hints\n");
			expect(text).not.toContain("StateDirectory=substrate/corpus-mirrors substrate/corpus-hints");
			expect(text).toContain("ReadWritePaths=/var/lib/substrate/corpus-mirrors /var/lib/substrate/corpus-hints");
		}
	});
});
