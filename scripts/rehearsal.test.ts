/**
 * The rehearsal harness, driven through its pure guards and through its CLI
 * the way an operator runs it. No test here needs a live daemon: every refusal
 * exits before the first container call, and paths that must reach Docker run
 * against a fake `docker` on PATH that records its argv, never the daemon.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireNameLock,
	withNameLock,
	buildRagflowSpawnArgv,
	buildServerSpawnArgv,
	confirmSpawnedTwin,
	clearDirectory,
	ensurePrivateDir,
	flag,
	freeBytes,
	gitOutput,
	installUpCleanup,
	isPortFree,
	isRagflowFixtureArgv,
	isRagflowFixturePid,
	isTwinHealthy,
	killVerifiedSpawn,
	mayStop,
	parseDockerIds,
	parseDockerPortLine,
	parseDockerRootDir,
	parseDesktopSurfaces,
	parseName,
	parseOperator,
	parseShellExports,
	parseSurfaces,
	pickFreePort,
	pickSmokeToken,
	refuseCheckoutDir,
	refuseDockerEndpoint,
	refuseDockerEnv,
	refuseExtraArgs,
	refuseLedgerUrl,
	refusePort,
	refuseSmokeUrl,
	readStartSeconds,
	resolveContainerRemoval,
	smokeToolResult,
	stopRagflowFake,
	type ProcFacts,
} from "./rehearsal.ts";
import type { Surface } from "../packages/mcp-server/src/types.ts";

const CLI = join(import.meta.dir, "rehearsal.ts");
/** What a real token would be: if the CLI ever printed the environment, this is the string that would leak. */
const SENTINEL = "rh-test-sentinel";

/** Safe-to-stop facts; each refusal test overrides one field. */
function proc(over: Partial<ProcFacts> = {}): ProcFacts {
	return {
		pid: 424242,
		argv: ["/root/.local/share/reflex/bun/bin/bun", "--no-env-file", "packages/mcp-server/src/index.ts"],
		cwd: "/tmp/wt-checkout",
		cgroup: "0::/user.slice/user-0.slice/session-1.scope",
		startSeconds: 1791479652.17,
		listensOn: [17410],
		...over,
	};
}

const STATE = { pid: 424242, checkout: "/tmp/wt-checkout", startSeconds: 1791479652.17 };

function runCli(...args: string[]): { code: number; out: string; err: string } {
	const child = Bun.spawnSync([process.execPath, CLI, ...args], {
		env: { ...process.env, SUBSTRATE_TOKEN: SENTINEL },
	});
	return { code: child.exitCode ?? -1, out: child.stdout.toString(), err: child.stderr.toString() };
}

/**
 * A fake `docker` on PATH: it answers `context` calls with the given endpoint
 * and every listing with an empty store, and records each argv line in the
 * log. Tests that must reach Docker without a live daemon prepend `bin` to
 * PATH and isolate `XDG_RUNTIME_DIR`; an empty log proves Docker was never
 * touched.
 */
function fakeDocker(endpoint = "unix:///var/run/docker.sock"): { dir: string; bin: string; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "rh-fakedocker-"));
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(dir, "calls.log");
	writeFileSync(
		join(bin, "docker"),
		`#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = "context" ]; then echo "${endpoint}"; fi\nexit 0\n`,
	);
	chmodSync(join(bin, "docker"), 0o755);
	return { dir, bin, log };
}

function runIsolated(args: string[], extraEnv: Record<string, string>): { code: number; out: string; err: string } {
	const child = Bun.spawnSync([process.execPath, CLI, ...args], {
		env: { ...process.env, SUBSTRATE_TOKEN: SENTINEL, ...extraEnv },
	});
	return { code: child.exitCode ?? -1, out: child.stdout.toString(), err: child.stderr.toString() };
}

function dockerCalls(log: string): string {
	try {
		return readFileSync(log, "utf8");
	} catch {
		return "";
	}
}

function pidGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

/**
 * A live stand-in for the fake RAGFlow: a Bun process whose argv carries the
 * fixture entry name and an exact `--run-dir` pair, so the identity checks
 * accept it, but which only sleeps instead of serving. Detached like the
 * real fake, so init reaps it and no zombie lingers for the stop poll. The
 * poll below needs real delays: it waits on a live child reaching exec
 * (observed via /proc), which fake timers cannot drive.
 */
async function spawnStubFake(runDir: string): Promise<{ pid: number; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "rh-stubfake-"));
	writeFileSync(join(dir, "rehearsal-fake-ragflow.ts"), "await Promise.withResolvers().promise;\n");
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", join(dir, "rehearsal-fake-ragflow.ts"), "--serve", "--run-dir", runDir, "--port", "19999"],
		{ detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	child.unref();
	for (let i = 0; i < 50 && !isRagflowFixturePid(child.pid, runDir); i++) await Bun.sleep(100);
	return { pid: child.pid, dir };
}

describe("mayStop", () => {
	test("stops the verified twin", () => {
		expect(mayStop(proc(), STATE)).toBeNull();
	});

	test("refuses a pid that differs from state.json", () => {
		expect(mayStop(proc({ pid: 999999 }), STATE)).toContain("pid differs");
	});

	test("refuses a reused pid whose start time moved", () => {
		expect(mayStop(proc({ startSeconds: 1791479999.5 }), STATE)).toContain("reused");
	});

	test("refuses a wrong cmdline", () => {
		expect(mayStop(proc({ argv: ["/usr/bin/bun", "packages/cli/src/index.ts"] }), STATE)).toContain("entry point");
	});

	test("refuses a cwd outside the recorded checkout", () => {
		expect(mayStop(proc({ cwd: "/root/src/repos/agent-substrate" }), STATE)).toContain("cwd");
	});

	test("refuses a process in system.slice", () => {
		expect(mayStop(proc({ cgroup: "0::/system.slice/substrate-mcp.service" }), STATE)).toContain("system.slice");
	});

	test("refuses a process that owns a production port", () => {
		expect(mayStop(proc({ listensOn: [17410, 7410] }), STATE)).toContain("production port");
	});
});

describe("killVerifiedSpawn", () => {
	test("never signals an unverifiable pid", () => {
		expect(killVerifiedSpawn(2 ** 30, "/tmp/wt-checkout", 0)).toBe(false);
	});

	test("never signals a live pid that fails the ownership check", () => {
		expect(killVerifiedSpawn(process.pid, "/tmp/wt-checkout", 0)).toBe(false);
	});
});

describe("isTwinHealthy", () => {
	test("accepts only a fully healthy twin", () => {
		expect(isTwinHealthy({ index: true, ledger: true, writable: true })).toBe(true);
	});

	test("refuses a partially healthy twin", () => {
		expect(isTwinHealthy({ index: true, ledger: false, writable: true })).toBe(false);
		expect(isTwinHealthy({ index: false, ledger: true, writable: true })).toBe(false);
		expect(isTwinHealthy({ index: true, ledger: true, writable: false })).toBe(false);
		expect(isTwinHealthy(null)).toBe(false);
	});
});

describe("refusePort", () => {
	test("refuses the production ports", () => {
		for (const port of [7410, 7411, 6420]) {
			expect(refusePort(port, [])).toContain("reserved");
		}
	});

	test("refuses a port that is already listening", () => {
		expect(refusePort(17410, [17410, 17411])).toContain("listening");
	});

	test("accepts a free scratch port and port 0", () => {
		expect(refusePort(17410, [])).toBeNull();
		expect(refusePort(0, [])).toBeNull();
	});

	test("pickFreePort yields a bindable port outside the reserved set", async () => {
		const picked = await pickFreePort();
		expect(refusePort(picked, [])).toBeNull();
		const srv = createServer();
		await new Promise<void>((resolve) => srv.listen(picked, "127.0.0.1", () => resolve()));
		expect(await isPortFree(picked)).toBe(false);
		await new Promise<void>((resolve) => srv.close(() => resolve()));
		expect(await isPortFree(picked)).toBe(true);
	});
});

describe("parseName", () => {
	test("accepts lower alnum plus dash", () => {
		expect(parseName("default")).toBe("default");
		expect(parseName("wf-16-smoke-2")).toBe("wf-16-smoke-2");
		expect(parseName(undefined)).toBe("default");
	});

	test("refuses upper case, spaces and long names", () => {
		for (const bad of ["Default", "has space", "has_dot", "x".repeat(32), ""]) {
			expect(() => parseName(bad)).toThrow("bad instance name");
		}
	});
});

describe("parseSurfaces", () => {
	test("defaults to the four launch surfaces", () => {
		expect(parseSurfaces(undefined)).toEqual(["claude-code", "cursor", "hermes", "omp"]);
	});

	test("splits and trims a custom list", () => {
		expect(parseSurfaces("hermes, omp")).toEqual(["hermes", "omp"]);
	});

	test("refuses unknown and empty lists", () => {
		expect(() => parseSurfaces("claude-code,nope")).toThrow("unknown surface");
		expect(() => parseSurfaces(" , ")).toThrow("at least one surface");
	});
});

describe("parseOperator", () => {
	test("defaults to the first listed surface", () => {
		expect(parseOperator(undefined, ["cursor", "hermes"], false)).toBe("cursor");
	});

	test("accepts an explicit member surface", () => {
		expect(parseOperator("hermes", ["cursor", "hermes"], false)).toBe("hermes");
	});

	test("anonymous has no operator", () => {
		expect(parseOperator(undefined, ["cursor"], true)).toBeNull();
	});

	test("refuses a swarm surface even when listed", () => {
		expect(() => parseOperator("swarm-a05-be", ["claude-code", "swarm-a05-be"], false)).toThrow("swarm surface");
	});

	test("refuses a swarm surface on the default path too", () => {
		expect(() => parseOperator(undefined, ["swarm-a05-be", "hermes"], false)).toThrow("swarm surface");
	});

	test("refuses a name outside --surfaces", () => {
		expect(() => parseOperator("omp", ["cursor"], false)).toThrow("not in --surfaces");
	});

	test("refuses --anonymous with an explicit --operator", () => {
		expect(() => parseOperator("hermes", ["hermes"], true)).toThrow("conflicts with --operator");
	});
});

describe("parseDesktopSurfaces", () => {
	test("defaults to an empty allowlist", () => {
		expect(parseDesktopSurfaces(undefined, ["omp", "cursor"], false)).toEqual([]);
	});

	test("accepts a valid subset", () => {
		expect(parseDesktopSurfaces("omp", ["omp", "cursor"], false)).toEqual(["omp"]);
		expect(parseDesktopSurfaces("omp, cursor", ["omp", "cursor"], false)).toEqual(["omp", "cursor"]);
	});

	test("refuses a name outside --surfaces", () => {
		expect(() => parseDesktopSurfaces("omp", ["cursor"], false)).toThrow("not in --surfaces");
	});

	test("refuses an unknown surface", () => {
		expect(() => parseDesktopSurfaces("nope", ["omp", "nope" as Surface], false)).toThrow("not a known surface");
	});

	test("refuses --anonymous with an explicit flag", () => {
		expect(() => parseDesktopSurfaces("omp", ["omp"], true)).toThrow("conflicts with --desktop-surfaces");
		expect(parseDesktopSurfaces(undefined, ["omp"], true)).toEqual([]);
	});
});

describe("refuseCheckoutDir", () => {
	test("refuses the production checkout, allows a worktree", () => {
		expect(refuseCheckoutDir("/root/src/repos/agent-substrate")).toContain("production checkout");
		expect(refuseCheckoutDir("/root/src/worktrees/agent-substrate-v13-phase")).toBeNull();
	});
});

describe("refuseSmokeUrl", () => {
	test("refuses :7410 even on loopback", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:7410")).toContain(":7410");
	});

	test("refuses non-loopback hosts on any port", () => {
		expect(refuseSmokeUrl("http://10.0.0.5:17410")).toContain("non-loopback");
		expect(refuseSmokeUrl("http://example.com:17410")).toContain("non-loopback");
	});

	test("accepts loopback twins and rejects garbage", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:17410")).toBeNull();
		expect(refuseSmokeUrl("http://localhost:17410")).toBeNull();
		expect(refuseSmokeUrl("not a url")).toContain("unparseable");
	});

	test("refuses every production port and accepts bracketed IPv6 loopback", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:7411")).toContain("production");
		expect(refuseSmokeUrl("http://127.0.0.1:6420")).toContain("production");
		expect(refuseSmokeUrl("http://[::1]:17410")).toBeNull();
	});
});

describe("refuseLedgerUrl", () => {
	test("refuses non-loopback ledgers on any port", () => {
		// The fake-chain proof writes fake signatures into `anchors`: a live
		// ledger must never see them.
		expect(refuseLedgerUrl("https://greptime.example.com:4000")).toContain("non-loopback");
		expect(refuseLedgerUrl("http://10.0.0.5:4000")).toContain("non-loopback");
	});

	test("accepts scratch loopback ledgers and rejects garbage", () => {
		expect(refuseLedgerUrl("http://127.0.0.1:49832")).toBeNull();
		expect(refuseLedgerUrl("http://localhost:4000")).toBeNull();
		expect(refuseLedgerUrl("http://[::1]:4000")).toBeNull();
		expect(refuseLedgerUrl("not a url")).toContain("unparseable");
	});
});

describe("parseShellExports", () => {
	test("round-trips exports with quotes and escapes", () => {
		const record = parseShellExports(
			"export BETA='second'\nexport ALPHA='first'\nexport QUOTED='a'\\''b'\nexport EMPTY=''\n# a comment\n",
		);
		expect(record).toEqual({ ALPHA: "first", BETA: "second", QUOTED: "a'b", EMPTY: "" });
	});
});

describe("spawn argv", () => {
	test("carries --no-env-file and the entry point", () => {
		const argv = buildServerSpawnArgv();
		expect(argv).toContain("--no-env-file");
		expect(argv.at(-1)).toBe("packages/mcp-server/src/index.ts");
		expect(argv[0]).toBe(process.execPath);
	});

	test("is exactly bun, the no-autoload flag and the entry point, with no value slot", () => {
		// Secrets reach the twin through its spawn env only; the argv has nowhere to carry one.
		const argv = buildServerSpawnArgv();
		expect(argv).toEqual([process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"]);
		for (const arg of argv) expect(arg).not.toContain("=");
	});

	test("every docker -e names a variable and never carries a value", () => {
		// Docker secrets travel by env name with the spawn env; `-e KEY=value` would put them in argv.
		const source = readFileSync(join(import.meta.dir, "rehearsal.ts"), "utf8");
		const next = [...source.matchAll(/"-e",\s*(\S+)/g)].map((m) => m[1] ?? "");
		expect(next.length).toBeGreaterThanOrEqual(2);
		for (const token of next) expect(token).toMatch(/^"[A-Z][A-Z0-9_]*",$/);
	});
});

describe("parseDockerPortLine", () => {
	test("reads docker port output", () => {
		expect(parseDockerPortLine("127.0.0.1:49832\n")).toEqual({ host: "127.0.0.1", port: 49832 });
		expect(parseDockerPortLine("garbage")).toBeNull();
	});
});

describe("flag", () => {
	test("reads a value, reports absence, and never swallows the next flag", () => {
		expect(flag(["down", "--name", "wf-1"], "--name")).toBe("wf-1");
		expect(flag(["down"], "--name")).toBeUndefined();
		expect(flag(["down", "--name"], "--name")).toBeNull();
		expect(flag(["up", "--operator", "--anonymous"], "--operator")).toBeNull();
	});
});

describe("ensurePrivateDir", () => {
	test("creates a 0700 dir and repairs a wider mode", () => {
		const base = mkdtempSync(join(tmpdir(), "rh-priv-"));
		try {
			const dir = join(base, "run");
			ensurePrivateDir(dir);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			chmodSync(dir, 0o755);
			ensurePrivateDir(dir);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("refuses a symlink and a plain file", () => {
		const base = mkdtempSync(join(tmpdir(), "rh-priv-"));
		try {
			const link = join(base, "link");
			symlinkSync(base, link);
			expect(() => ensurePrivateDir(link)).toThrow("not a real directory");
			const file = join(base, "file");
			writeFileSync(file, "x");
			expect(() => ensurePrivateDir(file)).toThrow("not a real directory");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("CLI refusals", () => {
	test("bare invocation exits 2 with usage", () => {
		const run = runCli();
		expect(run.code).toBe(2);
		expect(run.err).toContain("usage: rehearsal");
		expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
	});

	test("--port 7410 exits 2 without touching Docker", () => {
		const run = runCli("up", "--name", "rh-refuse-port", "--port", "7410");
		expect(run.code).toBe(2);
		expect(run.err).toContain("reserved");
		expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
	});

	test("up refuses a live pid it cannot verify before removing containers", () => {
		const base = mkdtempSync(join(tmpdir(), "rh-live-unverified-"));
		const fake = fakeDocker();
		writeFileSync(
			join(fake.bin, "ss"),
			"#!/bin/sh\nexit 1\n",
		);
		chmodSync(join(fake.bin, "ss"), 0o755);
		const name = "rh-live-unverified";
		const runDir = join(base, "substrate-rehearsal", name);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(runDir, "state.json"),
			JSON.stringify({ pid: process.pid, checkout: "/tmp/wt-checkout", startSeconds: 1 }),
		);
		try {
			const run = runIsolated(["up", "--name", name, "--port", "0", "--anonymous"], {
				XDG_RUNTIME_DIR: base,
				PATH: fake.bin,
				DOCKER_HOST: "unix:///nonexistent.sock",
				DOCKER_CONTEXT: "",
			});
			expect(run.code).toBe(2);
			expect(run.err).toContain("could not be verified");
			expect(run.err).toContain(String(process.pid));
			expect(dockerCalls(fake.log)).toBe("");
			expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(fake.dir, { recursive: true, force: true });
		}
	});

	test("a swarm --operator exits 2 without touching Docker", () => {
		const run = runCli("up", "--name", "rh-refuse-op", "--operator", "swarm-a05-be");
		expect(run.code).toBe(2);
		expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
	});

	test("down --name with no value exits 2 instead of stopping default", () => {
		const run = runCli("down", "--name");
		expect(run.code).toBe(2);
		expect(run.err).toContain("--name needs a value");
	});

	test("down with no prior up exits 0 removing nothing without a live daemon", () => {
		// Daemon-independent: the fake answers the locality probe and the
		// empty listing, while DOCKER_HOST names a socket that does not
		// exist — a pass proves the real daemon was never needed.
		const base = mkdtempSync(join(tmpdir(), "rh-down-fresh-"));
		const fake = fakeDocker();
		try {
			const run = runIsolated(["down", "--name", "rh-nobody-here"], {
				XDG_RUNTIME_DIR: base,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
				DOCKER_HOST: "unix:///nonexistent.sock",
				DOCKER_CONTEXT: "",
			});
			expect(run.code).toBe(0);
			expect(run.out).toContain("nothing to remove");
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(fake.dir, { recursive: true, force: true });
		}
	});

	test("down with an unreachable daemon fails non-zero instead of reporting 0 removed", () => {
		// The listing failure must refuse (keeping state), never read as
		// "nothing to remove": the fake answers the locality probe, then
		// fails every store call the way a dead daemon does.
		const base = mkdtempSync(join(tmpdir(), "rh-down-dead-"));
		const dir = mkdtempSync(join(tmpdir(), "rh-fakedocker-"));
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const log = join(dir, "calls.log");
		writeFileSync(
			join(bin, "docker"),
			`#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = "context" ]; then echo "unix:///var/run/docker.sock"; exit 0; fi\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n`,
		);
		chmodSync(join(bin, "docker"), 0o755);
		try {
			const run = runIsolated(["down", "--name", "rh-nobody-here"], {
				XDG_RUNTIME_DIR: base,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				DOCKER_HOST: "",
				DOCKER_CONTEXT: "",
			});
			expect(run.code).toBe(2);
			expect(run.err).toContain("could not list");
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("smokeToolResult", () => {
	test("fails a refused registration even with JSON text", () => {
		const refused = {
			status: 200,
			contentType: "application/json",
			body: { result: { isError: true, content: [{ text: JSON.stringify({ error: "refused" }) }] } },
		};
		expect(smokeToolResult(refused)).toBeNull();
	});

	test("passes a successful tool result through", () => {
		const ok = {
			status: 200,
			contentType: "application/json",
			body: { result: { content: [{ text: JSON.stringify({ claimed: true }) }] } },
		};
		expect(smokeToolResult(ok)).toEqual({ claimed: true });
	});
});

describe("gitOutput", () => {
	test("returns '' for successful empty output, null only on failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "rh-git-"));
		try {
			const git = (...args: string[]): void => {
				const run = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
				if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
			};
			git("init", "-q");
			git("config", "user.email", "rh-test@example.com");
			git("config", "user.name", "rh-test");
			writeFileSync(join(dir, "f.txt"), "x\n");
			git("add", "f.txt");
			git("commit", "-qm", "seed");
			// A clean checkout prints dirty=false, not dirty=unknown.
			expect(gitOutput(dir, ["status", "--porcelain=v1"])).toBe("");
			const sha = gitOutput(dir, ["log", "-1", "--pretty=%H"]);
			expect(sha).not.toBeNull();
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
			expect(gitOutput(dir, ["rev-parse", "no-such-ref"])).toBeNull();
			expect(gitOutput(join(dir, "missing"), ["status", "--porcelain=v1"])).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("refuseDockerEnv", () => {
	test("accepts an unset or local daemon and refuses remote ones", () => {
		expect(refuseDockerEnv({})).toBeNull();
		expect(refuseDockerEnv({ DOCKER_HOST: "unix:///var/run/docker.sock" })).toBeNull();
		expect(refuseDockerEnv({ DOCKER_CONTEXT: "default" })).toBeNull();
		expect(refuseDockerEnv({ DOCKER_HOST: "tcp://192.0.2.10:2375" })).toContain("DOCKER_HOST");
		expect(refuseDockerEnv({ DOCKER_HOST: "ssh://root@db.example.com" })).toContain("DOCKER_HOST");
		expect(refuseDockerEnv({ DOCKER_CONTEXT: "vps-remote" })).toContain("context");
	});

	test("a remote DOCKER_HOST refuses before any container call", () => {
		const run = Bun.spawnSync([process.execPath, CLI, "down", "--name", "rh-remote-daemon"], {
			env: { ...process.env, SUBSTRATE_TOKEN: SENTINEL, DOCKER_HOST: "tcp://192.0.2.10:2375" },
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain("DOCKER_HOST");
	});
});

describe("refuseDockerEndpoint", () => {
	test("only local unix sockets pass", () => {
		expect(refuseDockerEndpoint("unix:///var/run/docker.sock")).toBeNull();
		expect(refuseDockerEndpoint("  unix:///run/user/1000/docker.sock\n")).toBeNull();
		expect(refuseDockerEndpoint("tcp://192.0.2.10:2375")).toContain("non-local docker endpoint");
		expect(refuseDockerEndpoint("ssh://root@db.example.com")).toContain("non-local docker endpoint");
		expect(refuseDockerEndpoint("npipe:////./pipe/docker_engine")).toContain("non-local docker endpoint");
		expect(refuseDockerEndpoint("  \n")).toContain("could not read the docker endpoint");
	});

	for (const sub of ["down", "status"]) {
		test(`${sub} against a remote context endpoint refuses before listing containers`, () => {
			const base = mkdtempSync(join(tmpdir(), "rh-remote-ctx-"));
			const fake = fakeDocker("tcp://192.0.2.10:2375");
			try {
				const run = runIsolated([sub, "--name", "rh-remote-ctx"], {
					XDG_RUNTIME_DIR: base,
					PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
					DOCKER_HOST: "",
					DOCKER_CONTEXT: "",
				});
				expect(run.code).toBe(2);
				expect(run.err).toContain("non-local docker endpoint");
				// The gate ran `context inspect` and stopped: exactly one docker
				// call, and it is the locality probe, not `ps` or `rm`.
				const lines = dockerCalls(fake.log).split("\n").filter((l) => l.length > 0);
				expect(lines).toHaveLength(1);
				expect(lines[0]).toContain("context inspect");
			} finally {
				rmSync(base, { recursive: true, force: true });
				rmSync(fake.dir, { recursive: true, force: true });
			}
		});
	}
});

describe("refuseExtraArgs", () => {
	test("accepts known flags and rejects typos and strays", () => {
		expect(refuseExtraArgs(["down", "--name", "x"])).toBeNull();
		expect(refuseExtraArgs(["up", "--name", "x", "--port", "0", "--anonymous"])).toBeNull();
		// The skills fixture is a bare flag too; a typo of it is refused, never ignored.
		expect(refuseExtraArgs(["up", "--name", "x", "--skills-fixture"])).toBeNull();
		expect(refuseExtraArgs(["up", "--name", "x", "--skills-fixtures"])).toBe("unknown option --skills-fixtures");
		expect(refuseExtraArgs(["up", "--skills-fixture", "extra"])).toBe("unexpected argument extra");
		expect(refuseExtraArgs(["up", "--desktop-surfaces", "omp"])).toBeNull();
		// The ragflow fixture rides the same bare-flag shape.
		expect(refuseExtraArgs(["up", "--name", "x", "--ragflow-fixture"])).toBeNull();
		expect(refuseExtraArgs(["up", "--name", "x", "--ragflow-fixtures"])).toBe("unknown option --ragflow-fixtures");
		expect(refuseExtraArgs(["down", "--nmae", "other"])).toContain("--nmae");
		expect(refuseExtraArgs(["down", "--name", "x", "extra"])).toContain("extra");
		expect(refuseExtraArgs(["smoke", "--verbose"])).toContain("--verbose");
	});

	test("a mistyped --name never stops the default instance", () => {
		const run = runCli("down", "--nmae", "other");
		expect(run.code).toBe(2);
		expect(run.err).toContain("--nmae");
	});
});

describe("ragflow fixture helpers", () => {
	test("the fake spawn argv names the fixture script, the run dir and the port", () => {
		const argv = buildRagflowSpawnArgv("/tmp/wt-checkout", "/tmp/run/p25", 19380);
		expect(argv[0]).toBe(process.execPath);
		expect(argv).toContain("--no-env-file");
		expect(argv).toContain(join("/tmp/wt-checkout", "packages/mcp-server/src/rehearsal-fake-ragflow.ts"));
		expect(argv).toContain("--serve");
		expect(argv).toContain("/tmp/run/p25");
		expect(argv).toContain("19380");
		expect(argv).not.toContain("7410");
	});

	test("isRagflowFixturePid refuses a foreign or missing pid", () => {
		expect(isRagflowFixturePid(1, "/tmp/run/p25")).toBe(false);
		expect(isRagflowFixturePid(999999999, "/tmp/run/p25")).toBe(false);
	});
});

describe("isRagflowFixtureArgv", () => {
	const argv = (runDir: string): string[] => [
		"/root/.local/bin/bun",
		"--no-env-file",
		"/wt/packages/mcp-server/src/rehearsal-fake-ragflow.ts",
		"--serve",
		"--run-dir",
		runDir,
		"--port",
		"19380",
	];

	test("matches the exact fixture argv", () => {
		expect(isRagflowFixtureArgv(argv("/tmp/run/p25"), "/tmp/run/p25")).toBe(true);
	});

	test("a sibling run dir that extends this one does not match", () => {
		// .../a is a substring of .../a2, so a substring check would let
		// `down` kill another run's fake after a pid reuse.
		expect(isRagflowFixtureArgv(argv("/tmp/run/a2"), "/tmp/run/a")).toBe(false);
		expect(isRagflowFixtureArgv(argv("/tmp/run/a"), "/tmp/run/a2")).toBe(false);
	});

	test("refuses a foreign argv", () => {
		expect(isRagflowFixtureArgv(["/usr/bin/bun", "--no-env-file", "packages/mcp-server/src/index.ts"], "/tmp/run/p25")).toBe(false);
		expect(isRagflowFixtureArgv(["bun", "--no-env-file", "/wt/rehearsal-fake-ragflow"], "/tmp/run/p25")).toBe(false);
		expect(
			isRagflowFixtureArgv(["bun", "--no-env-file", "/wt/rehearsal-fake-ragflow.ts", "--serve", "--run-dir"], "/tmp/run/p25"),
		).toBe(false);
	});
});

describe("stopRagflowFake", () => {
	test("a reused pid with a different start time is never signalled", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "rh-fakerun-"));
		const stub = await spawnStubFake(runDir);
		try {
			expect(isRagflowFixturePid(stub.pid, runDir)).toBe(true);
			expect(() => stopRagflowFake(stub.pid, runDir, 1)).toThrow("reused");
			// The refusal came before any signal: the fake is still alive.
			expect(pidGone(stub.pid)).toBe(false);
		} finally {
			try {
				stopRagflowFake(stub.pid, runDir);
			} catch {
				// A refusal means the pid is gone or not ours; never escalate blindly.
			}
			if (!pidGone(stub.pid) && isRagflowFixturePid(stub.pid, runDir)) {
				try {
					process.kill(stub.pid, "SIGKILL");
				} catch {
					// Gone between the check and the signal.
				}
			}
			rmSync(runDir, { recursive: true, force: true });
			rmSync(stub.dir, { recursive: true, force: true });
		}
		// Spawns a live stub; real child death observed via the signal probe,
		// which fake timers cannot drive.
	}, 30000);

	test("the saved start time lets the real fake stop", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "rh-fakerun-"));
		const stub = await spawnStubFake(runDir);
		try {
			const start = readStartSeconds(stub.pid);
			expect(start).not.toBeNull();
			stopRagflowFake(stub.pid, runDir, start as number);
			// Real child death observed via the signal probe, which fake timers cannot drive.
			for (let i = 0; i < 50 && !pidGone(stub.pid); i++) await Bun.sleep(100);
			expect(pidGone(stub.pid)).toBe(true);
		} finally {
			if (!pidGone(stub.pid) && isRagflowFixturePid(stub.pid, runDir)) {
				try {
					process.kill(stub.pid, "SIGKILL");
				} catch {
					// Gone between the check and the signal.
				}
			}
			rmSync(runDir, { recursive: true, force: true });
			rmSync(stub.dir, { recursive: true, force: true });
		}
		// Spawns a live stub; real child death observed via the signal probe,
		// which fake timers cannot drive.
	}, 30000);

	test("down with a provisional fake-only state stops the fake without signalling pid 0", async () => {
		// A `down` that finds pid 0 (up killed during the fake readiness
		// wait) stops the recorded fake, removes the run dir and exits 0.
		const base = mkdtempSync(join(tmpdir(), "rh-down-prov-"));
		const fake = fakeDocker();
		const name = "rh-prov-fake";
		const runDir = join(base, "substrate-rehearsal", name);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const stub = await spawnStubFake(runDir);
		writeFileSync(
			join(runDir, "state.json"),
			JSON.stringify({ name, pid: 0, startSeconds: 0, checkout: "/tmp/wt-checkout", ragflowFixture: true, ragflowPid: stub.pid }),
		);
		try {
			const run = runIsolated(["down", "--name", name], {
				XDG_RUNTIME_DIR: base,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
				DOCKER_HOST: "unix:///nonexistent.sock",
				DOCKER_CONTEXT: "",
			});
			expect(run.code).toBe(0);
			expect(run.out).toContain("twin never started");
			// Real child death observed via the signal probe, which fake timers cannot drive.
			for (let i = 0; i < 50 && !pidGone(stub.pid); i++) await Bun.sleep(100);
			expect(pidGone(stub.pid)).toBe(true);
			expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
		} finally {
			if (!pidGone(stub.pid) && isRagflowFixturePid(stub.pid, runDir)) {
				try {
					process.kill(stub.pid, "SIGKILL");
				} catch {
					// Gone between the check and the signal.
				}
			}
			rmSync(base, { recursive: true, force: true });
			rmSync(fake.dir, { recursive: true, force: true });
			rmSync(stub.dir, { recursive: true, force: true });
		}
		// Spawns a live stub plus a full CLI run; real child death observed
		// via the signal probe, which fake timers cannot drive.
	}, 30000);

	test("up after a twin crash stops the recorded fake before rebuilding", async () => {
		// A crashed `up` leaves a dead twin pid plus a live fake; the next
		// `up` rebuilds and must stop the recorded fake first
		// (identity-checked) or the rebuild overwrites the saved pid and
		// `down` can never stop the orphan.
		const base = mkdtempSync(join(tmpdir(), "rh-up-crashed-"));
		const fake = fakeDocker();
		const name = "rh-crashed-fake";
		const runDir = join(base, "substrate-rehearsal", name);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const stub = await spawnStubFake(runDir);
		writeFileSync(
			join(runDir, "state.json"),
			JSON.stringify({ name, pid: 2 ** 30, startSeconds: 1, checkout: "/tmp/wt-checkout", ragflowFixture: true, ragflowPid: stub.pid }),
		);
		try {
			const run = runIsolated(["up", "--name", name, "--port", "0", "--anonymous"], {
				XDG_RUNTIME_DIR: base,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
				DOCKER_HOST: "unix:///nonexistent.sock",
				DOCKER_CONTEXT: "",
			});
			// The rebuild refuses later: the fake `docker` never answers
			// `info`, so the data-root floor proof fails — after the stop
			// block under test has run. The recorded fake must already be
			// stopped by then.
			expect(run.code).toBe(2);
			expect(run.err).toContain("could not read Docker's data root");
			// Real child death observed via the signal probe, which fake timers cannot drive.
			for (let i = 0; i < 50 && !pidGone(stub.pid); i++) await Bun.sleep(100);
			expect(pidGone(stub.pid)).toBe(true);
			expect(`${run.out}${run.err}`).not.toContain(SENTINEL);
		} finally {
			if (!pidGone(stub.pid) && isRagflowFixturePid(stub.pid, runDir)) {
				try {
					process.kill(stub.pid, "SIGKILL");
				} catch {
					// Gone between the check and the signal.
				}
			}
			rmSync(base, { recursive: true, force: true });
			rmSync(fake.dir, { recursive: true, force: true });
			rmSync(stub.dir, { recursive: true, force: true });
		}
		// Spawns a live stub plus a full CLI run; real child death observed
		// via the signal probe, which fake timers cannot drive.
	}, 30000);
});

describe("resolveContainerRemoval", () => {
	const ok = (out: string): { ok: boolean; out: string; err: string } => ({ ok: true, out, err: "" });
	const fail = (err: string): { ok: boolean; out: string; err: string } => ({ ok: false, out: "", err });

	test("empty listing removes nothing without an rm call", () => {
		expect(parseDockerIds("  \n")).toEqual([]);
		expect(resolveContainerRemoval("x", ok(""), null, null)).toBe(0);
	});

	test("a failed ps refuses instead of reporting 0 removed", () => {
		expect(() => resolveContainerRemoval("x", fail("Cannot connect"), null, null)).toThrow("could not list");
	});

	test("a failed rm refuses with docker's error and keeps state", () => {
		expect(() => resolveContainerRemoval("x", ok("abc123\n"), fail("Error: No such container"), null)).toThrow(
			/No such container.*keeping state/,
		);
	});

	test("survivors in the verify listing refuse", () => {
		expect(() => resolveContainerRemoval("x", ok("abc123\n"), ok("abc123\n"), ok("abc123\n"))).toThrow(
			/survived removal/,
		);
	});

	test("a clean removal reports the truthful count", () => {
		expect(resolveContainerRemoval("x", ok("a\nb\n"), ok("a\nb\n"), ok(""))).toBe(2);
	});
});

describe("docker data-root disk guard", () => {
	test("parses the DockerRootDir line and reads free bytes", () => {
		expect(parseDockerRootDir("/var/lib/docker\n")).toBe("/var/lib/docker");
		expect(parseDockerRootDir("  \n")).toBeNull();
		expect(parseDockerRootDir("")).toBeNull();
		const free = freeBytes(tmpdir());
		expect(free).not.toBeNull();
		expect(free as number).toBeGreaterThan(0);
		expect(freeBytes(join(tmpdir(), "rh-no-such-dir-xyz"))).toBeNull();
	});
});

describe("clearDirectory", () => {
	test("a restarted run drops stale token files but keeps the dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "rh-tokens-"));
		try {
			ensurePrivateDir(dir);
			writeFileSync(join(dir, "cursor"), "stale\n");
			writeFileSync(join(dir, "swarm-a01-orch"), "stale\n");
			clearDirectory(dir);
			expect(readdirSync(dir)).toEqual([]);
			expect(statSync(dir).isDirectory()).toBe(true);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pickSmokeToken", () => {
	test("the smoke drives the operator token and falls back to the first surface", () => {
		expect(pickSmokeToken({ SUBSTRATE_TOKEN: "first", SUBSTRATE_REHEARSAL_OPERATOR_TOKEN: "op" })).toBe("op");
		expect(pickSmokeToken({ SUBSTRATE_TOKEN: "first", SUBSTRATE_REHEARSAL_OPERATOR_TOKEN: "" })).toBe("first");
		expect(pickSmokeToken({ SUBSTRATE_TOKEN: "first" })).toBe("first");
		expect(pickSmokeToken({})).toBe("");
	});
});

describe("acquireNameLock", () => {
	test("one name is exclusive, another name is not, and a throw releases", async () => {
		const base = mkdtempSync(join(tmpdir(), "rh-lock-"));
		try {
			const runA = join(base, "substrate-rehearsal", "a");
			const runB = join(base, "substrate-rehearsal", "b");
			const first = acquireNameLock(runA, "a");
			expect(() => acquireNameLock(runA, "a")).toThrow("locked by another operation");
			// A second name takes its own lock while the first is held.
			const other = acquireNameLock(runB, "b");
			other.release();
			other.release();
			first.release();
			acquireNameLock(runA, "a").release();

			// A leftover directory and a dead pid are not a lock: the kernel
			// already dropped the flock when the holder exited.
			const lockDir = `${runA}.lock`;
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(join(lockDir, "owner"), "2147483647\n");
			acquireNameLock(runA, "a").release();

			await expect(withNameLock(runA, "a", async () => {
				expect(() => acquireNameLock(runA, "a")).toThrow("locked by another operation");
				throw new Error("boom");
			})).rejects.toThrow("boom");
			acquireNameLock(runA, "a").release();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

/**
 * The lock precedes every store touch: with the lock held elsewhere, each
 * subcommand must refuse before reading state or invoking Docker. The fake
 * `docker` answers locality and listing calls with an empty store and records
 * every invocation, so an empty log proves the refusal came first.
 */
describe("per-name lock precedes every store touch", () => {
	for (const args of [
		["down", "--name", "rh-locked"],
		["up", "--name", "rh-locked", "--port", "0"],
		["status", "--name", "rh-locked"],
		["smoke", "--name", "rh-locked"],
	]) {
		test(`${args[0]} while the lock is held refuses without calling docker`, () => {
			const base = mkdtempSync(join(tmpdir(), "rh-lock-precede-"));
			const fake = fakeDocker();
			const held = acquireNameLock(join(base, "substrate-rehearsal", "rh-locked"), "rh-locked");
			try {
				const run = runIsolated(args, {
					XDG_RUNTIME_DIR: base,
					PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
				});
				expect(run.code).toBe(2);
				expect(run.err).toContain("locked by another operation");
				expect(dockerCalls(fake.log)).toBe("");
			} finally {
				held.release();
				rmSync(base, { recursive: true, force: true });
				rmSync(fake.dir, { recursive: true, force: true });
			}
		});
	}

	test("a different name is not blocked and still reaches docker", () => {
		const base = mkdtempSync(join(tmpdir(), "rh-lock-other-"));
		const fake = fakeDocker();
		const held = acquireNameLock(join(base, "substrate-rehearsal", "rh-locked"), "rh-locked");
		try {
			const other = runIsolated(["down", "--name", "rh-other"], {
				XDG_RUNTIME_DIR: base,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
			});
			expect(other.code).toBe(0);
			expect(other.out).toContain("nothing to remove");
			expect(other.err).not.toContain("locked");
			const calls = dockerCalls(fake.log);
			expect(calls).not.toBe("");
			const same = runIsolated(["down", "--name", "rh-locked"], {
				XDG_RUNTIME_DIR: base,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
			});
			expect(same.code).toBe(2);
			expect(same.err).toContain("locked by another operation");
			expect(dockerCalls(fake.log)).toBe(calls);
		} finally {
			held.release();
			rmSync(base, { recursive: true, force: true });
			rmSync(fake.dir, { recursive: true, force: true });
		}
	});
});

describe("confirmSpawnedTwin", () => {
	const deps = (over: {
		alive?: boolean;
		start?: number | null;
		ports?: number[] | null;
	} = {}): { alive: (pid: number) => boolean; startOf: (pid: number) => number | null; listensOn: (pid: number) => number[] | null } => ({
		alive: () => over.alive ?? true,
		startOf: () => over.start ?? 1791479652.17,
		listensOn: () => (over.ports === undefined ? [17410] : over.ports),
	});

	test("confirms the live owner and refuses strangers", () => {
		expect(confirmSpawnedTwin(424242, 17410, 1791479652.17, deps())).toBeNull();
		expect(confirmSpawnedTwin(424242, 17410, 1791479652.17, deps({ alive: false }))).toContain("is gone");
		expect(confirmSpawnedTwin(424242, 17410, 1791479000, deps())).toContain("reused");
		expect(confirmSpawnedTwin(424242, 17410, 1791479652.17, deps({ ports: [9999] }))).toContain("does not own port");
		expect(confirmSpawnedTwin(424242, 17410, 1791479652.17, deps({ ports: null }))).toContain("could not read");
	});
});

describe("installUpCleanup", () => {
	test("arms interruption handlers and disarms them", () => {
		const intBefore = process.listenerCount("SIGINT");
		const termBefore = process.listenerCount("SIGTERM");
		let cleaned = 0;
		const disarm = installUpCleanup(() => { cleaned++; });
		expect(process.listenerCount("SIGINT")).toBe(intBefore + 1);
		expect(process.listenerCount("SIGTERM")).toBe(termBefore + 1);
		expect(cleaned).toBe(0);
		disarm();
		expect(process.listenerCount("SIGINT")).toBe(intBefore);
		expect(process.listenerCount("SIGTERM")).toBe(termBefore);
		disarm(); // Double disarm is safe.
	});
});
