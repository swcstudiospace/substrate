/**
 * The rehearsal harness, driven through its pure guards and through its CLI
 * the way an operator runs it. No test here needs Docker: every refusal exits
 * before the first container call, and the store file is treated as opaque.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildServerSpawnArgv,
	ensurePrivateDir,
	flag,
	gitOutput,
	isPortFree,
	isTwinHealthy,
	killVerifiedSpawn,
	mayStop,
	freeBytes,
	parseDockerPortLine,
	parseDockerRootDir,
	parseName,
	parseOperator,
	parseShellExports,
	parseSurfaces,
	pickFreePort,
	refuseCheckoutDir,
	refuseDockerEnv,
	refuseExtraArgs,
	parseDockerIds,
	refusePort,
	resolveContainerRemoval,
	refuseSmokeUrl,
	smokeToolResult,
	type ProcFacts,
} from "./rehearsal.ts";

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

	test("down with no prior up exits 0 removing nothing", () => {
		const run = runCli("down", "--name", "rh-nobody-here");
		expect(run.code).toBe(0);
		expect(run.out).toContain("nothing to remove");
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

describe("refuseExtraArgs", () => {
	test("accepts known flags and rejects typos and strays", () => {
		expect(refuseExtraArgs(["down", "--name", "x"])).toBeNull();
		expect(refuseExtraArgs(["up", "--name", "x", "--port", "0", "--anonymous"])).toBeNull();
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
