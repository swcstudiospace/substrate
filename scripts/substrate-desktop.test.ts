/**
 * Lifecycle-script gates without Docker (D30-15).
 *
 * `infra/desktop/substrate-desktop.sh` only ever runs `docker`, `df` and
 * `openssl`, so this suite points PATH at a stub dir holding executable bash
 * stubs for exactly those three programs. Each stub appends its argv to
 * `$STUB_LOG` and answers from env knobs (`STUB_DF_AVAIL`, `STUB_IMAGE`,
 * `STUB_CONTAINER`, `STUB_ENDPOINT` for the `context inspect` locality probe),
 * plus `1280 800` geometry for the getdisplaygeometry call.
 * Every spawn uses an explicit env (stub PATH, stub knobs,
 * `SUBSTRATE_DESKTOP_ENV_FILE` pointed into a temp dir) and never spreads
 * `process.env`, so no token reaches the script and a root run never writes
 * `/etc`. The root check is exercised as written: the `up`/`status` cases run
 * only as root, and the non-root refusal runs de-privileged via setpriv.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "infra", "desktop", "substrate-desktop.sh");
const GATE_BYTES = 10737418240;

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
	if [ -z "$STUB_IMAGE" ]; then STUB_IMAGE=present; fi
	if [ -z "$STUB_ENDPOINT" ]; then STUB_ENDPOINT=local; fi
	if [ -z "$STUB_CONTAINER" ]; then STUB_CONTAINER=absent; fi
	case "$1 $2" in
	"context inspect")
		case "$STUB_ENDPOINT" in
		remote) echo "tcp://other-host:2375" ;;
		broken) exit 1 ;;
		empty) : ;;
		hang) exec sleep 30 ;;
		# A client that ignores SIGTERM: the ignore is inherited by the sleep, so
		# only the forced kill after the grace period can end it.
		ignore-term) trap '' TERM; sleep 30 ;;
		*) echo "unix:///var/run/docker.sock" ;;
		esac
		;;
"image inspect")
	[ "$STUB_IMAGE" = "present" ]
	;;
"container inspect")
	if [ "$3" = "--format" ]; then
		case "$4" in
		*Config.Labels*)
			case "$STUB_CONTAINER" in
			labelled-running | labelled-stopped) echo "desktop" ;;
			*) echo "other" ;;
			esac
			;;
		*Config.Image*) echo "linuxserver/webtop:ubuntu-xfce" ;;
		*State.Running*)
			[ "$STUB_CONTAINER" = "labelled-running" ] && echo "true" || echo "false"
			;;
		*RestartPolicy*) echo "unless-stopped" ;;
		*HostConfig.Privileged*) echo "false" ;;
		*NetworkSettings*) echo "127.0.0.1:6081->3000/tcp" ;;
		*Type*) echo "volume:substrate-desktop-config->/config" ;;
		*Source*) echo "/var/lib/docker/volumes/substrate-desktop-config/_data" ;;
		*.Id*) echo "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
		*) echo "" ;;
		esac
		exit 0
	fi
	[ "$STUB_CONTAINER" != "absent" ]
	;;
exec*)
	case "$*" in
	*getdisplaygeometry*)
		if [ "$STUB_GEOMETRY" = "hang" ]; then sleep 30; fi
		echo "1280 800"
		;;
	*) echo "" ;;
	esac
	exit 0
	;;
*)
	exit 0
	;;
esac
`;

const DF_STUB = String.raw`#!/usr/bin/env bash
echo "df $*" >>"$STUB_LOG"
printf '%s\n' "Avail" "$STUB_DF_AVAIL"
`;

const OPENSSL_STUB = `#!/usr/bin/env bash
echo "openssl $*" >>"$STUB_LOG"
printf '%s' "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
`;

/** Password the openssl stub deterministically yields after the tr/head pipe. */
const STUB_PASSWORD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";

const made: string[] = [];
afterAll(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isRoot(): boolean {
	try {
		const child = Bun.spawnSync(["id", "-u"], { stdout: "pipe", stderr: "ignore" });
		return child.exitCode === 0 && child.stdout.toString().trim() === "0";
	} catch {
		return false;
	}
}
const IS_ROOT = isRoot();

type ContainerKnob = "absent" | "labelled-running" | "labelled-stopped" | "foreign";
type Knobs = {
	dfAvail?: string;
	image?: "present" | "absent";
	container?: ContainerKnob;
	endpoint?: "local" | "remote" | "broken" | "empty" | "hang" | "ignore-term";
	geometry?: "ok" | "hang";
};

interface Rig {
	stubDir: string;
	workdir: string;
	logFile: string;
	envFile: string;
}
type RunResult = { code: number; out: string; err: string; log: string; envFile: string };

function makeRig(): Rig {
	const stubDir = mkdtempSync(join(tmpdir(), "substrate-desktop-stub-"));
	made.push(stubDir);
	writeFileSync(join(stubDir, "docker"), DOCKER_STUB, { mode: 0o755 });
	writeFileSync(join(stubDir, "df"), DF_STUB, { mode: 0o755 });
	writeFileSync(join(stubDir, "openssl"), OPENSSL_STUB, { mode: 0o755 });
	const workdir = mkdtempSync(join(tmpdir(), "substrate-desktop-run-"));
	made.push(workdir);
	const logFile = join(workdir, "stub.log");
	writeFileSync(logFile, "");
	return { stubDir, workdir, logFile, envFile: join(workdir, "substrate-desktop.env") };
}

function baseEnv(rig: Rig, knobs: Knobs): Record<string, string> {
	return {
		PATH: `${rig.stubDir}:/usr/bin:/bin`,
		STUB_LOG: rig.logFile,
		STUB_DF_AVAIL: knobs.dfAvail ?? "20000000000",
		STUB_IMAGE: knobs.image ?? "present",
		STUB_CONTAINER: knobs.container ?? "absent",
		STUB_ENDPOINT: knobs.endpoint ?? "local",
		STUB_GEOMETRY: knobs.geometry ?? "ok",
		SUBSTRATE_DESKTOP_ENV_FILE: rig.envFile,
	};
}

function runScript(sub: string, knobs: Knobs = {}, extraEnv: Record<string, string> = {}): RunResult {
	const rig = makeRig();
	const child = Bun.spawnSync(["bash", SCRIPT, sub], {
		env: { ...baseEnv(rig, knobs), ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: child.exitCode ?? -1,
		out: child.stdout.toString(),
		err: child.stderr.toString(),
		log: readFileSync(rig.logFile, "utf8"),
		envFile: rig.envFile,
	};
}

function dockerLines(log: string): string[] {
	return log
		.split("\n")
		.filter((line) => line.startsWith("docker "));
}

/**
 * D30-14: the script never stops, removes or pulls anything and names no
 * other container. The only `pull` token allowed anywhere is `--pull never`.
 */
function assertCleanArgv(log: string): void {
	for (const line of log.split("\n").filter((l) => l.length > 0)) {
		expect(line).not.toMatch(/recruitment/i);
		const withoutPullNever = line.split("--pull never").join("");
		expect(withoutPullNever).not.toMatch(/\b(?:rm|stop|kill|pull)\b/);
	}
}

const itRoot = IS_ROOT ? test : test.skip;

describe("substrate-desktop.sh up", () => {
	itRoot("creates the container with the locked run argv", () => {
		const r = runScript("up", { container: "absent" });
		expect(r.code).toBe(0);
		const runs = dockerLines(r.log).filter((line) => line.startsWith("docker run "));
		expect(runs).toHaveLength(1);
		const argv = runs[0] ?? "";
		expect(argv).toContain("--pull never");
		expect(argv).toContain("-p 127.0.0.1:6081:3000");
		expect(argv).toContain("--label org.swcstudio.substrate.role=desktop");
		expect(argv).toContain("-v substrate-desktop-config:/config");
		expect(argv).toContain("--shm-size 1g");
		expect(argv).not.toContain("--privileged");
		expect(argv).not.toContain("docker.sock");
		expect(argv).not.toContain("--network host");
		expect(argv).not.toMatch(/-v\s+\//);
		assertCleanArgv(r.log);
	});

	itRoot("starts a stopped labelled container instead of running", () => {
		const r = runScript("up", { container: "labelled-stopped" });
		expect(r.code).toBe(0);
		expect(dockerLines(r.log).some((line) => line === "docker start substrate-desktop")).toBe(true);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("leaves a running labelled container alone", () => {
		const r = runScript("up", { container: "labelled-running" });
		expect(r.code).toBe(0);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses a same-named container without the desktop label", () => {
		const r = runScript("up", { container: "foreign" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("refusing to touch");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses a missing image without pulling", () => {
		const r = runScript("up", { image: "absent" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("refusing to pull");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses below 10 GiB free before any docker call", () => {
		const r = runScript("up", { dfAvail: String(GATE_BYTES - 1) });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("bytes free");
		expect(dockerLines(r.log)).toEqual([]);
		assertCleanArgv(r.log);
	});

	itRoot("accepts exactly 10 GiB free", () => {
		const r = runScript("up", { dfAvail: String(GATE_BYTES) });
		expect(r.code).toBe(0);
		assertCleanArgv(r.log);
	});

	itRoot("refuses a remote context endpoint before run or start", () => {
		const r = runScript("up", { endpoint: "remote" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("refusing non-local docker endpoint");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses a non-local DOCKER_HOST before run or start", () => {
		const r = runScript("up", {}, { DOCKER_HOST: "tcp://other-host:2375" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("refusing non-local DOCKER_HOST");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses a non-local docker context before run or start", () => {
		const r = runScript("up", {}, { DOCKER_CONTEXT: "remote-engine" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("refusing non-local docker context");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("a failed endpoint probe refuses before any later docker call", () => {
		const r = runScript("up", { endpoint: "broken" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("could not prove the local docker endpoint");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker start "))).toBe(false);
		expect(dockerLines(r.log).some((line) => line.startsWith("docker image "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("a hung endpoint probe is bounded and refuses", () => {
		const start = Date.now();
		const r = runScript("up", { endpoint: "hang" }, { SUBSTRATE_DESKTOP_PROBE_TIMEOUT_S: "1" });
		expect(Date.now() - start).toBeLessThan(15_000);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("could not prove the local docker endpoint");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("a probe that ignores SIGTERM is force-killed and refuses", () => {
		const start = Date.now();
		const r = runScript(
			"up",
			{ endpoint: "ignore-term" },
			{ SUBSTRATE_DESKTOP_PROBE_TIMEOUT_S: "1", SUBSTRATE_DESKTOP_PROBE_KILL_AFTER_S: "1" },
		);
		// The stub sleeps 30 s and shrugs off SIGTERM; without the kill-after the
		// script would wait the full sleep.
		expect(Date.now() - start).toBeLessThan(15_000);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("could not prove the local docker endpoint");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("refuses an unreadable endpoint without locality proof", () => {
		const r = runScript("up", { endpoint: "empty" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("without locality proof");
		expect(dockerLines(r.log).some((line) => line.startsWith("docker run "))).toBe(false);
		assertCleanArgv(r.log);
	});

	itRoot("a hanging geometry read cannot outlive the readiness window", () => {
		const start = Date.now();
		const r = runScript("up", { container: "absent", geometry: "hang" }, { SUBSTRATE_DESKTOP_GEOMETRY_WAIT_S: "2" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("display not 1280 800");
		expect(Date.now() - start).toBeLessThan(30_000);
		assertCleanArgv(r.log);
	});

	itRoot("generates the env file once, mode 600, never echoed", () => {
		const r = runScript("up", { container: "absent" });
		expect(r.code).toBe(0);
		expect(statSync(r.envFile).mode & 0o777).toBe(0o600);
		const body = readFileSync(r.envFile, "utf8");
		expect(body).toBe(`CUSTOM_USER=substrate\nPASSWORD=${STUB_PASSWORD}\n`);
		expect(r.out).not.toContain(STUB_PASSWORD);
		expect(r.err).not.toContain(STUB_PASSWORD);
	});

	itRoot("keeps a pre-existing env file without calling openssl", () => {
		const rig = makeRig();
		const sentinel = `CUSTOM_USER=substrate\nPASSWORD=${"z".repeat(32)}\n`;
		writeFileSync(rig.envFile, sentinel, { mode: 0o600 });
		const knobs: Knobs = {};
		const child = Bun.spawnSync(["bash", SCRIPT, "up"], {
			env: baseEnv(rig, knobs),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		expect(readFileSync(rig.envFile, "utf8")).toBe(sentinel);
		const log = readFileSync(rig.logFile, "utf8");
		expect(log.split("\n").some((line) => line.startsWith("openssl "))).toBe(false);
		assertCleanArgv(log);
	});
});

describe("substrate-desktop.sh status", () => {
	itRoot("reports exists=false when the container is absent", () => {
		const r = runScript("status", { container: "absent" });
		expect(r.code).toBe(0);
		expect(r.out).toContain("exists=false");
	});

	itRoot("reports the locked status keys for a running container", () => {
		const r = runScript("status", { container: "labelled-running" });
		expect(r.code).toBe(0);
		for (const line of [
			"exists=true",
			"running=true",
			"restart=unless-stopped",
			"ports=127.0.0.1:6081->3000",
			"geometry=1280x800",
			"image=linuxserver/webtop:ubuntu-xfce",
			"label_role=desktop",
			"privileged=false",
			"mounts=volume:substrate-desktop-config->/config",
			"docker_socket_mounted=false",
		]) {
			expect(r.out).toContain(line);
		}
	});
});

describe("substrate-desktop.sh without root", () => {
	const setpriv = Bun.which("setpriv");
	const canDrop = IS_ROOT && setpriv !== null;
	const itDrop = canDrop ? test : test.skip;

	itDrop("up refuses without root", () => {
		const rig = makeRig();
		chmodSync(rig.workdir, 0o755);
		const copy = join(rig.workdir, "substrate-desktop-copy.sh");
		writeFileSync(copy, readFileSync(SCRIPT, "utf8"), { mode: 0o644 });
		const child = Bun.spawnSync(
			[setpriv ?? "setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "/bin/bash", copy, "up"],
			{
				env: {
					PATH: "/usr/bin:/bin",
					STUB_LOG: rig.logFile,
					SUBSTRATE_DESKTOP_ENV_FILE: rig.envFile,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.exitCode).toBe(1);
		expect(child.stderr.toString()).toContain("must run as root");
	});

	if (!IS_ROOT) {
		test("up refuses without root", () => {
			const r = runScript("up");
			expect(r.code).toBe(1);
			expect(r.err).toContain("must run as root");
		});
	}
});

describe("substrate-desktop.sh lint", () => {
	test("bash -n exits 0", () => {
		const child = Bun.spawnSync(["bash", "-n", SCRIPT], { stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode).toBe(0);
		expect(child.stderr.toString()).toBe("");
	});

	test("unknown subcommand exits 2 with usage", () => {
		const rig = makeRig();
		const child = Bun.spawnSync(["bash", SCRIPT, "bogus"], {
			env: baseEnv(rig, {}),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(2);
		expect(child.stderr.toString()).toContain("usage:");
	});

	test("shellcheck exits 0", () => {
		const shellcheck = Bun.which("shellcheck");
		if (shellcheck === null) return;
		const child = Bun.spawnSync([shellcheck, SCRIPT], { stdout: "pipe", stderr: "pipe" });
		expect(`${child.stdout.toString()}${child.stderr.toString()}`).toBe("");
		expect(child.exitCode).toBe(0);
	});
});
