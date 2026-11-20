import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Process-boundary tests for the one-shot anchor entry point
 * (`anchor-run.ts`, D28-11 / ANCHOR-04, validation gap G1).
 *
 * These run the REAL entry process with a scrubbed environment — `env -i`
 * clears every inherited variable, so no real `GREPTIME_*`, `SOLANA_*`,
 * `SUBSTRATE_*`, token, key path, or config value can reach the child, and
 * the child cwd is an empty scratch dir so no repo `.env` file is loaded.
 * A trap `solana` on the child's PATH records any CLI invocation; absence
 * of the marker proves the child never reached a send path.
 *
 * Missing config must exit 2 with usage before any Runner, store, or RPC
 * port is constructed — hence no send, no write, and no request are
 * possible on these paths, and the trap proves it.
 */
const ANCHOR_RUN = new URL("./anchor-run.ts", import.meta.url).pathname;

interface EntryResult {
	code: number;
	stdout: string;
	stderr: string;
	cliInvoked: boolean;
}

async function runEntry(args: string[], extraEnv: Record<string, string> = {}): Promise<EntryResult> {
	const home = mkdtempSync(join(tmpdir(), "p28-anchor-run-"));
	const bin = join(home, "bin");
	mkdirSync(bin);
	const marker = join(home, "cli-invoked");
	// Any CLI invocation — `solana` or `solana-keygen` — leaves the marker.
	// Quoted via JSON so the tmp path cannot break out of the literal.
	for (const name of ["solana", "solana-keygen"]) {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
		chmodSync(join(bin, name), 0o700);
	}
	const childEnv = [
		"env",
		"-i",
		`PATH=${bin}:/usr/bin:/bin`,
		`HOME=${home}`,
		`XDG_CONFIG_HOME=${join(home, ".config")}`,
		`XDG_CACHE_HOME=${join(home, ".cache")}`,
		`XDG_RUNTIME_DIR=${home}`,
		...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
		process.execPath,
		ANCHOR_RUN,
		...args,
	];
	const proc = Bun.spawn(childEnv, { cwd: home, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		code,
		stdout,
		stderr,
		cliInvoked: existsSync(marker),
	};
}

describe("anchor-run entry process boundary", () => {
	test("missing GREPTIME_URL exits 2 with usage and no CLI/store/RPC effect", async () => {
		const result = await runEntry([]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("GREPTIME_URL");
		expect(result.stderr).toContain("usage:");
		expect(result.cliInvoked).toBe(false);
	});

	test("GREPTIME_URL without identity exits 2 naming the key settings", async () => {
		let requests = 0;
		const trap = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => { requests += 1; return new Response("unexpected store call", { status: 500 }); },
		});
		try {
			const env: Record<string, string> = {};
			env["GREPTIME_URL"] = trap.url.href;
			const result = await runEntry([], env);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("SOLANA_ANCHOR_KEYPAIR");
			expect(result.stderr).toContain("SOLANA_ANCHOR_PUBKEY");
			expect(result.stderr).toContain("usage:");
			expect(result.cliInvoked).toBe(false);
			expect(requests).toBe(0);
		} finally {
			trap.stop(true);
		}
	});

	test("a refused SOLANA_RPC_URL exits 2 naming the key, with no CLI call and no request", async () => {
		let requests = 0;
		const trap = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => { requests += 1; return new Response("unexpected store call", { status: 500 }); },
		});
		try {
			for (const url of [
				"https://api.mainnet-beta.solana.com",
				"https://API.TESTNET.solana.com/devnet",
				"https://user:s3cret@api.devnet.solana.com",
				"ftp://api.devnet.solana.com",
			]) {
				const env: Record<string, string> = {};
				env["GREPTIME_URL"] = trap.url.href;
				env["SOLANA_ANCHOR_KEYPAIR"] = "/nonexistent/keypair.json";
				env["SOLANA_ANCHOR_PUBKEY"] = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
				env["SOLANA_RPC_URL"] = url;
				const result = await runEntry([], env);
				expect(result.code).toBe(2);
				expect(result.stderr).toContain("SOLANA_RPC_URL");
				expect(result.stderr).toContain("usage:");
				expect(result.stderr).not.toContain("s3cret");
				expect(result.cliInvoked).toBe(false);
				expect(requests).toBe(0);
			}
		} finally {
			trap.stop(true);
		}
	}, 30_000);

	test("an unknown flag exits 2 with usage", async () => {
		const result = await runEntry(["--bogus"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--bogus");
		expect(result.stderr).toContain("usage:");
		expect(result.cliInvoked).toBe(false);
	});
});
