import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diagnose,
	entryFromExecStart,
	isDevCheckout,
	listReleaseTree,
	loadUnits,
	parseDisableAssignments,
	parseUnit,
	readEnabledState,
	RELEASE_CURRENT,
	SHARED_ENV_FILE,
} from "./doctor-units.ts";

const repoRoot = join(import.meta.dir, "..");

const MCP_ENTRY = "packages/mcp-server/src/index.ts";
const GROK_ENTRY = "packages/collectors/src/grok.ts";

function treeOf(...paths: string[]): Set<string> {
	return new Set(paths);
}

describe("entryFromExecStart", () => {
	test("the bun binary is the interpreter and the ts path is the entry", () => {
		expect(entryFromExecStart("/root/.local/share/reflex/bun/bin/bun packages/mcp-server/src/index.ts")).toEqual({
			kind: "path",
			path: MCP_ENTRY,
			absolute: false,
		});
		expect(entryFromExecStart("/root/.local/share/reflex/bun/bin/bun packages/collectors/src/grok.ts --watch")).toEqual({
			kind: "path",
			path: GROK_ENTRY,
			absolute: false,
		});
	});

	test("a python -m module is the entry, and flags after it are not", () => {
		expect(entryFromExecStart("/usr/bin/python3 -m substrate_dispatcher")).toEqual({
			kind: "module",
			module: "substrate_dispatcher",
		});
		expect(entryFromExecStart("/usr/bin/python3 -m substrate_miner bridge --once")).toEqual({
			kind: "module",
			module: "substrate_miner",
		});
	});

	test("an absolute entry under current is repo-relative, and .. is refused", () => {
		expect(entryFromExecStart(`${RELEASE_CURRENT}/${MCP_ENTRY}`)).toEqual({
			kind: "path",
			path: MCP_ENTRY,
			absolute: true,
		});
		expect(entryFromExecStart("/root/.local/share/reflex/bun/bin/bun ../../etc/passwd")).toBeNull();
	});
});

describe("isDevCheckout", () => {
	test("the mutable checkout is a dev checkout and the release pointer is not", () => {
		expect(isDevCheckout("/root/src/repos/agent-substrate")).toBe(true);
		expect(isDevCheckout("/root/src/repos/agent-substrate/")).toBe(true);
		expect(isDevCheckout(RELEASE_CURRENT)).toBe(false);
		expect(isDevCheckout("/opt/agent-substrate/releases/0123456789abcdef0123456789abcdef01234567")).toBe(false);
	});
});

describe("diagnose fixtures", () => {
	test("the pre-fix collector text is a dev checkout that loads every substrate secret", () => {
		// This is the unit text on 6417c92. The live-tree test below fails while
		// infra/vps still has it, and this fixture keeps the regression after the edit.
		const unit = parseUnit(
			"substrate-collector-grok.service",
			`[Service]
EnvironmentFile=${SHARED_ENV_FILE}
WorkingDirectory=/root/src/repos/agent-substrate
ExecStart=/root/.local/share/reflex/bun/bin/bun ${GROK_ENTRY} --watch
Restart=always
`,
		);
		const findings = diagnose([unit], treeOf(GROK_ENTRY));
		expect(findings.map((finding) => finding.code)).toEqual(["dev-checkout", "shared-env"]);
	});

	test("an absolute entry under a nested working directory is not joined twice", () => {
		const unit = parseUnit(
			"substrate-mcp.service",
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}/packages/mcp-server
ExecStart=${RELEASE_CURRENT}/${MCP_ENTRY}
Restart=always
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		expect(diagnose([unit], treeOf(MCP_ENTRY))).toEqual([]);
		const relative = parseUnit(
			"substrate-mcp.service",
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}/packages/mcp-server
ExecStart=/root/.local/share/reflex/bun/bin/bun src/index.ts
Restart=always
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		expect(diagnose([relative], treeOf(MCP_ENTRY))).toEqual([]);
	});

	test("a release unit with its own env file has no findings", () => {
		const unit = parseUnit(
			"substrate-collector-grok.service",
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/root/.local/share/reflex/bun/bin/bun ${GROK_ENTRY} --watch
Restart=always
EnvironmentFile=/etc/substrate/collector-grok.env
`,
		);
		expect(diagnose([unit], treeOf(GROK_ENTRY))).toEqual([]);
	});

	test("a missing entry and Restart=always on a disable switch are both findings", () => {
		const unit = parseUnit(
			"substrate-dispatcher.service",
			`[Service]
Environment="SUBSTRATE_DISPATCH_DISABLED=1"
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/usr/bin/python3 -m substrate_dispatcher
Restart=always
EnvironmentFile=/etc/substrate/dispatcher.env
`,
		);
		const findings = diagnose([unit], treeOf());
		expect(findings.map((finding) => finding.code)).toEqual(["missing-entry", "restart-loop"]);
		expect(findings[1]?.detail).toContain("SUBSTRATE_DISPATCH_DISABLED=1");
	});

	test("Restart=on-failure with the disable switch does not loop, and Restart=always on an enabled unit does not", () => {
		const oneshot = parseUnit(
			"substrate-dispatcher.service",
			`[Service]
Environment=SUBSTRATE_DISPATCH_DISABLED=1
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/usr/bin/python3 -m substrate_dispatcher
Restart=on-failure
EnvironmentFile=/etc/substrate/dispatcher.env
`,
		);
		expect(diagnose([oneshot], treeOf("packages/dispatcher/src/substrate_dispatcher/__main__.py")).map((f) => f.code)).toEqual(
			[],
		);
		const enabled = parseUnit(
			"substrate-mcp.service",
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/root/.local/share/reflex/bun/bin/bun ${MCP_ENTRY}
Restart=always
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		expect(diagnose([enabled], treeOf(MCP_ENTRY), new Map([["substrate-mcp.service", "enabled"]]))).toEqual([]);
	});

	test("systemd disabled or masked with Restart=always is a restart loop", () => {
		const unit = parseUnit(
			"substrate-dispatcher.service",
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/usr/bin/python3 -m substrate_dispatcher
Restart=always
EnvironmentFile=/etc/substrate/dispatcher.env
`,
		);
		const tree = treeOf("packages/dispatcher/src/substrate_dispatcher/__main__.py");
		for (const state of ["disabled", "masked", "disabled-runtime"]) {
			const findings = diagnose([unit], tree, readEnabledState(`substrate-dispatcher.service ${state}`));
			expect(findings.map((finding) => finding.code)).toEqual(["restart-loop"]);
		}
	});

	test("a drop-in resets the shared env file and overrides WorkingDirectory", () => {
		const unit = parseUnit(
			"substrate-collector-grok.service",
			`[Service]
EnvironmentFile=${SHARED_ENV_FILE}
WorkingDirectory=/root/src/repos/agent-substrate
ExecStart=/root/.local/share/reflex/bun/bin/bun ${GROK_ENTRY} --watch
Restart=always
`,
			[
				`[Service]
EnvironmentFile=
EnvironmentFile=/etc/substrate/collector-grok.env
WorkingDirectory=${RELEASE_CURRENT}
`,
			],
		);
		expect(diagnose([unit], treeOf(GROK_ENTRY))).toEqual([]);
		expect(unit.environmentFiles).toEqual(["/etc/substrate/collector-grok.env"]);
		expect(unit.workingDirectory).toBe(RELEASE_CURRENT);
	});

	test("a relative env file can carry the disable switch, and an absolute one is not opened", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-units-"));
		writeFileSync(join(dir, "dispatcher.env"), "SUBSTRATE_DISPATCH_DISABLED=1\nPLANE_SECRET=should-not-surface\n");
		writeFileSync(
			join(dir, "substrate-dispatcher.service"),
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/usr/bin/python3 -m substrate_dispatcher
Restart=always
EnvironmentFile=dispatcher.env
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		const units = loadUnits(dir, true);
		const findings = diagnose(units, treeOf("packages/dispatcher/src/substrate_dispatcher/__main__.py"));
		expect(findings.map((finding) => finding.code)).toEqual(["restart-loop"]);
		expect(findings[0]?.detail).toContain("SUBSTRATE_DISPATCH_DISABLED=1");
		expect(JSON.stringify(findings)).not.toContain("PLANE_SECRET");
		expect(JSON.stringify(findings)).not.toContain("should-not-surface");
		expect(parseDisableAssignments("SUBSTRATE_DISPATCH_DISABLED=1\nOTHER=secret\n").has("OTHER")).toBe(false);
	});

	test("a non-substrate unit in the same directory is ignored", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-units-"));
		writeFileSync(
			join(dir, "ssh.service"),
			`[Service]
WorkingDirectory=/root/src/repos/agent-substrate
Restart=always
ExecStart=/usr/sbin/sshd
`,
		);
		writeFileSync(
			join(dir, "substrate-mcp.service"),
			`[Service]
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/root/.local/share/reflex/bun/bin/bun ${MCP_ENTRY}
Restart=always
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		expect(loadUnits(dir).map((unit) => unit.name)).toEqual(["substrate-mcp.service"]);
	});

	test("comments, blank lines and a continued ExecStart still parse", () => {
		const unit = parseUnit(
			"substrate-mcp.service",
			`# comment
[Unit]
Description=ignored

[Service]
# still a comment
WorkingDirectory=${RELEASE_CURRENT}
ExecStart=/root/.local/share/reflex/bun/bin/bun \\
  ${MCP_ENTRY}
Restart=always
EnvironmentFile=${SHARED_ENV_FILE}
`,
		);
		expect(unit.execStart).toContain(MCP_ENTRY);
		expect(diagnose([unit], treeOf(MCP_ENTRY))).toEqual([]);
	});
});

describe("repo units", () => {
	test("infra/vps substrate units all run from the release with their own env files at HEAD", () => {
		const units = loadUnits(join(repoRoot, "infra/vps"));
		expect(units.map((unit) => unit.name).sort()).toEqual([
			"substrate-alert@.service",
			"substrate-anchor.service",
			"substrate-collector-grok.service",
			"substrate-collector-herdr.service",
			"substrate-collector-muse.service",
			"substrate-corpus-sync.service",
			"substrate-corpus-watch.service",
			"substrate-dispatcher.service",
			"substrate-docs-canary.service",
			"substrate-doctor.service",
			"substrate-host.service",
			"substrate-index-archive.service",
			"substrate-index-sweep.service",
			"substrate-ledger-archive.service",
			"substrate-mcp.service",
			"substrate-skills-bridge.service",
			"substrate-skills-sync.service",
		]);
		for (const unit of units) {
			expect(unit.workingDirectory).toBe(RELEASE_CURRENT);
		}
		const mcp = units.find((unit) => unit.name === "substrate-mcp.service");
		expect(mcp?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		// The anchor job is a store client in the server's trust domain, not a
		// collector: it loads the shared env on the pinned release and raises
		// no finding of its own (D28-02).
		const anchor = units.find((unit) => unit.name === "substrate-anchor.service");
		expect(anchor?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(anchor?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(anchor?.restart).toBeNull();
		// The index sweep is the same kind of unit as the anchor (D28-02 shape):
		// shared env on the pinned release, oneshot, dry-run pinned on the unit
		// rather than in substrate.env, so the server never carries a delete switch.
		const sweep = units.find((unit) => unit.name === "substrate-index-sweep.service");
		expect(sweep?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(sweep?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(sweep?.restart).toBeNull();
		expect(sweep?.environment.get("SUBSTRATE_INDEX_SWEEP")).toBe("dry-run");
		// The runtime doctor (uplift-3 N1) has the anchor's shape: shared env on
		// the pinned release, oneshot, no Restart=. Its emit switch is a commented
		// line on its own drop-in, so a fresh install reports and never posts.
		const doctor = units.find((unit) => unit.name === "substrate-doctor.service");
		expect(doctor?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(doctor?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(doctor?.restart).toBeNull();
		expect(doctor?.environment.has("SUBSTRATE_DOCTOR_EMIT")).toBe(false);
		// The docs canary (uplift-4 S7) is the doctor's shape: shared env on the
		// pinned release, oneshot, and both opt-in lines commented on its drop-in, so
		// a fresh install refuses (exit 2) and posts nothing.
		const canary = units.find((unit) => unit.name === "substrate-docs-canary.service");
		expect(canary?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(canary?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(canary?.restart).toBeNull();
		expect(canary?.environment.has("SUBSTRATE_DOCS_CANARY")).toBe(false);
		expect(canary?.environment.has("SUBSTRATE_DOCS_CANARY_MANIFEST")).toBe(false);

		// The failure alert (uplift-4 S3) is a oneshot host job like the doctor: shared
		// env on the pinned release, no Restart=, and it runs the alert script with the
		// failed unit as its instance (%i: the escaped form would turn `-` into `/`).
		const alert = units.find((unit) => unit.name === "substrate-alert@.service");
		expect(alert?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(alert?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(alert?.restart).toBeNull();
		expect(alert?.execStart).toContain("scripts/substrate-alert.ts %i");
		expect(alert?.execStart).not.toContain("%I");
		// The watchdog is an operator-installed EXAMPLE drop-in, never part of the
		// main unit: Type=notify with the flag off would block startup.
		const mcpText = readFileSync(join(repoRoot, "infra/vps/substrate-mcp.service"), "utf8");
		expect(mcpText).not.toContain("Type=notify");
		expect(mcpText).not.toContain("WatchdogSec");
		expect(mcpText).toContain("MemorySwapMax=0");
		const example = readFileSync(join(repoRoot, "infra/vps/substrate-mcp.service.d/20-watchdog.conf.example"), "utf8");
		for (const line of ["Type=notify", "WatchdogSec=30", "TimeoutStartSec=60", "NotifyAccess=all", "OnFailure=substrate-alert@%n.service", "Environment=SUBSTRATE_WATCHDOG=1"]) {
			expect(example).toContain(line);
		}
		expect(example).toContain("operator-");
		expect(example).toContain("blocks startup");
		// The alert is told how the unit stopped by systemd itself ($SERVICE_RESULT, passed in the
		// instance name), never left to a `systemctl show` read that races the restart.
		expect(example).toContain("ExecStopPost=-/usr/bin/systemctl start --no-block substrate-alert@%n:${SERVICE_RESULT}.service");
		expect(example).toContain("OnFailure= ALONE NEVER FIRES");
		expect(example).toContain("PRECONDITION");
		expect(example).toContain("watchdog.ts");
		// The ledger archive (uplift-3 N6) is the same shape again: shared env on the
		// pinned release, oneshot, and the archive directory on the unit's drop-in
		// rather than hard-coded, so an unset path refuses instead of writing to root.
		const archive = units.find((unit) => unit.name === "substrate-ledger-archive.service");
		expect(archive?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(archive?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(archive?.restart).toBeNull();
		expect(archive?.execStart).toContain("ledger archive --out ${SUBSTRATE_LEDGER_ARCHIVE_DIR}");
		// The index archive (uplift-4 S2) is the same shape: shared env, oneshot, and the directory on the drop-in so an unset path refuses by name.
		const indexArchive = units.find((unit) => unit.name === "substrate-index-archive.service");
		expect(indexArchive?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(indexArchive?.environmentFiles).toEqual([SHARED_ENV_FILE]);
		expect(indexArchive?.restart).toBeNull();
		expect(indexArchive?.execStart).toContain("index archive --out ${SUBSTRATE_INDEX_ARCHIVE_DIR}");
		// The archive holds accepted memory text: private files whatever the code does, and the example mount dependency sits in [Unit], where systemd reads it.
		const indexUnitText = readFileSync(join(repoRoot, "infra/vps/substrate-index-archive.service"), "utf8");
		expect(indexUnitText).toMatch(/^UMask=0077$/m);
		expect(indexUnitText.indexOf("UMask=0077")).toBeGreaterThan(indexUnitText.indexOf("[Service]"));
		const indexDropIn = readFileSync(join(repoRoot, "infra/vps/substrate-index-archive.service.d/10-environment.conf"), "utf8");
		const exampleAt = indexDropIn.indexOf("#   RequiresMountsFor=");
		expect(exampleAt).toBeGreaterThan(-1);
		expect(indexDropIn.slice(0, exampleAt).trimEnd().split("\n").at(-1)).toBe("#   [Unit]");
		// The lane-B cutover (infra/vps/README.md operator step 4) moved herdr and
		// muse onto the release tree with collector-only env files, like grok. Each
		// unit loads exactly the file the identity manifest delivers its token to, so
		// identity:check and the running collector read the same file.
		const manifest = JSON.parse(readFileSync(join(repoRoot, "infra/identity/clients.json"), "utf8")) as {
			clients: { id: string; delivery: { path?: string } }[];
			herdr_env_files: string[];
		};
		const deliveredTo = (id: string) => manifest.clients.find((client) => client.id === id)?.delivery.path ?? "";
		const expected = {
			grok: deliveredTo("collector-grok"),
			herdr: manifest.herdr_env_files[0] ?? "",
			muse: deliveredTo("writer-muse"),
		} as const;
		expect(expected).toEqual({
			grok: "/etc/substrate/collector-grok.env",
			herdr: "/etc/substrate/substrate-collector-herdr.env",
			muse: "/etc/substrate/substrate-collector-muse.env",
		});
		for (const name of ["grok", "herdr", "muse"] as const) {
			const unit = units.find((candidate) => candidate.name === `substrate-collector-${name}.service`);
			expect(unit?.environmentFiles).toEqual([expected[name]]);
			expect(unit?.environmentFiles).not.toContain(SHARED_ENV_FILE);
		}
		// Phase 22 skills units (SKILL-02/SKILL-03): shared env plus the per-unit
		// file the identity manifest delivers the bearer to, by name — the value
		// lives only on the host, never in this repo (D22-10, D20-07).
		const skillsExpected = {
			"substrate-skills-sync.service": deliveredTo("skills-sync"),
			"substrate-skills-bridge.service": deliveredTo("bridge"),
		} as const;
		expect(skillsExpected).toEqual({
			"substrate-skills-sync.service": "/etc/substrate/substrate-skills-sync.env",
			"substrate-skills-bridge.service": "/etc/substrate/substrate-bridge.env",
		});
		for (const [unitName, perUnit] of Object.entries(skillsExpected)) {
			const unit = units.find((candidate) => candidate.name === unitName);
			expect(unit?.environmentFiles).toEqual([SHARED_ENV_FILE, perUnit]);
		}
		// Phase 24 dispatcher (DISP-01/DISP-08): the Python loop runs from the
		// pinned release like every other unit, with only its per-unit file —
		// the manifest delivers SUBSTRATE_TOKEN_SUBSTRATE there, by name.
		const dispatcher = units.find((unit) => unit.name === "substrate-dispatcher.service");
		expect(dispatcher?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(dispatcher?.environmentFiles).toEqual([deliveredTo("dispatcher")]);
		expect(deliveredTo("dispatcher")).toBe("/etc/substrate/substrate-dispatcher.env");
		// Phase 31 host (LANEA-01): node runs the .ts sources from the pinned
		// release like every other unit, with only its per-unit file — the
		// manifest delivers SUBSTRATE_TOKEN_SUBSTRATE there, by name. Staged
		// only: install/restart is OPERATOR-GATED G4.
		const host = units.find((unit) => unit.name === "substrate-host.service");
		expect(host?.workingDirectory).toBe(RELEASE_CURRENT);
		expect(host?.environmentFiles).toEqual([deliveredTo("substrate-host")]);
		expect(deliveredTo("substrate-host")).toBe("/etc/substrate/substrate-host.env");
	});

	test("the dry-run command reports no findings and does not claim it wrote anything", () => {
		const result = spawnSync("bun", ["scripts/doctor-units.ts", "--dry-run"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("unit doctor: no findings");
		expect(result.stderr).toContain("unit doctor: dry-run");
		expect(result.stdout).not.toContain("wrote");
	});
});

describe("release tree", () => {
	test("listReleaseTree stays inside the directory and skips node_modules", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-release-"));
		mkdirSync(join(dir, "packages/mcp-server/src"), { recursive: true });
		mkdirSync(join(dir, "node_modules/left-out"), { recursive: true });
		writeFileSync(join(dir, MCP_ENTRY), "");
		writeFileSync(join(dir, "node_modules/left-out/index.js"), "");
		const tree = listReleaseTree(dir);
		expect(tree.has(MCP_ENTRY)).toBe(true);
		expect([...tree].some((path) => path.includes("node_modules"))).toBe(false);

		const outside = mkdtempSync(join(tmpdir(), "doctor-outside-"));
		writeFileSync(join(outside, "secret.ts"), "");
		symlinkSync(outside, join(dir, "escape"));
		const escaped = listReleaseTree(dir);
		expect([...escaped].some((path) => path.includes("secret.ts"))).toBe(false);

		symlinkSync(MCP_ENTRY, join(dir, "entry.ts"));
		mkdirSync(join(dir, "nested"));
		symlinkSync("..", join(dir, "nested/up"));
		symlinkSync(".", join(dir, "loop"));
		const linked = listReleaseTree(dir);
		expect(linked.has("entry.ts")).toBe(true);
		expect(linked.has(MCP_ENTRY)).toBe(true);
		expect([...linked].some((path) => path.includes("secret.ts"))).toBe(false);
	});

	test("listReleaseTree records files reached through an in-tree directory link", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-alias-"));
		mkdirSync(join(dir, "packages/mcp-server/src"), { recursive: true });
		writeFileSync(join(dir, MCP_ENTRY), "");
		symlinkSync("packages/mcp-server", join(dir, "alias"));
		symlinkSync(".", join(dir, "loop"));
		const tree = listReleaseTree(dir);
		expect(tree.has("alias/src/index.ts")).toBe(true);
		expect(tree.has(MCP_ENTRY)).toBe(true);
	});
});
