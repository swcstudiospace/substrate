/**
 * postEvent against a real loopback stub: outcome classification, the bearer
 * convention, call-time env, and the refused line's exact shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postEvent } from "./emit.ts";
import { isolateSpoolEnv } from "./spool-test-env.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

// Runtime-assembled so no credential shape sits in source (redact-lock rule 4).
const decoy = `ghp_${"a1B2c3D4e5".repeat(4)}`;

const event: EventInput = {
	surface: "grok-build",
	kind: "prompt",
	summary: "summary-marker-never-stored",
	payload: { secret: "payload-marker-never-stored" },
};

interface Seen {
	auth: string | null;
}

function stubServer(handler: (req: Request) => Response | Promise<Response>): {
	url: string;
	seen: Seen[];
	close: () => void;
} {
	const seen: Seen[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			seen.push({ auth: req.headers.get("authorization") });
			return handler(req);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, seen, close: () => server.stop() };
}

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	const patched = (chunk: Uint8Array | string, ...args: unknown[]): boolean => {
		void args;
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	};
	process.stderr.write = patched as typeof process.stderr.write;
	return { lines, restore: () => void (process.stderr.write = original) };
}

const saved = { ...process.env };
let stateDir = "";
let servers: { close: () => void }[] = [];
let stderr: { lines: string[]; restore: () => void } | null = null;

let restoreSpoolEnv: () => void = () => undefined;

beforeEach(() => {
	// The spool is a different test file's subject: an operator's SUBSTRATE_EVENT_SPOOL must not park these failures.
	restoreSpoolEnv = isolateSpoolEnv();
	stateDir = mkdtempSync(join(tmpdir(), "emit-test-"));
	process.env.SUBSTRATE_STATE_DIR = stateDir;
	delete process.env.SUBSTRATE_URL;
	delete process.env.SUBSTRATE_TOKEN;
	delete process.env.SUBSTRATE_TOKEN_FILE;
	// An empty tokens dir, never the host's: without it the resolver falls
	// back to the real /etc/substrate/tokens and provisioned host files
	// leak into bearer assertions. File-resolution cases override per test.
	process.env.SUBSTRATE_TOKENS_DIR = mkdtempSync(join(tmpdir(), "emit-tokens-empty-"));
	stderr = captureStderr();
});

afterEach(() => {
	restoreSpoolEnv();
	for (const server of servers) server.close();
	servers = [];
	stderr?.restore();
	stderr = null;
	for (const key of ["SUBSTRATE_URL", "SUBSTRATE_TOKEN", "SUBSTRATE_TOKEN_FILE", "SUBSTRATE_TOKENS_DIR", "SUBSTRATE_STATE_DIR"] as const) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function track<T extends { close: () => void }>(server: T): T {
	servers.push(server);
	return server;
}

function refusedLines(): Record<string, unknown>[] {
	let body: string;
	try {
		body = readFileSync(join(stateDir, "refused-emits.jsonl"), "utf8");
	} catch {
		return [];
	}
	return body
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
describe("postEvent outcomes", () => {
	test("202 maps to stored", async () => {
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));
		process.env.SUBSTRATE_URL = stub.url;

		const outcome = await postEvent(event, { collector: "grok", source: "grok" });

		expect(outcome).toEqual({ kind: "stored" });
		expect(refusedLines()).toEqual([]);
	});

	test("400, 401 and 403 map to refused", async () => {
		for (const status of [400, 401, 403]) {
			const stub = track(
				stubServer(() => Response.json({ error: `refused with ${status}` }, { status })),
			);
			const outcome = await postEvent(event, { collector: "grok", source: "grok", url: stub.url });

			expect(outcome).toEqual({ kind: "refused", status, error: `refused with ${status}` });
		}
		expect(refusedLines()).toHaveLength(3);
	});

	test("500 and 503 map to failed", async () => {
		for (const status of [500, 503]) {
			const stub = track(stubServer(() => Response.json({ error: "ledger down" }, { status })));
			const outcome = await postEvent(event, { collector: "grok", source: "grok", url: stub.url });

			expect(outcome).toEqual({ kind: "failed", status, error: "ledger down" });
		}
		expect(refusedLines()).toEqual([]);
	});

	test("a closed port maps to failed and never rejects", async () => {
		const outcome = await postEvent(event, {
			collector: "grok",
			source: "grok",
			url: "http://127.0.0.1:9",
			timeoutMs: 1000,
		});

		expect(outcome).toEqual({ kind: "failed", error: "unreachable" });
		expect(refusedLines()).toEqual([]);
	});

	test("a hung server maps to failed once the timeout fires", async () => {
		const stub = track(stubServer(() => new Promise<Response>(() => {})));
		const outcome = await postEvent(event, { collector: "grok", source: "grok", url: stub.url, timeoutMs: 50 });

		expect(outcome).toEqual({ kind: "failed", error: "timeout" });
		expect(refusedLines()).toEqual([]);
	});
});

describe("bearer convention and call-time env", () => {
	test("the authorization header is present only when a token is set", async () => {
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		await postEvent(event, { collector: "t", source: "t", url: stub.url, token: "tok-1" });
		await postEvent(event, { collector: "t", source: "t", url: stub.url, token: "  " });
		process.env.SUBSTRATE_TOKEN = "tok-2";
		await postEvent(event, { collector: "t", source: "t", url: stub.url });
		delete process.env.SUBSTRATE_TOKEN;
		await postEvent(event, { collector: "t", source: "t", url: stub.url });

		expect(stub.seen.map((entry) => entry.auth)).toEqual([
			"Bearer tok-1",
			null,
			"Bearer tok-2",
			null,
		]);
	});

	test("the URL is read at call time, not captured at module load", async () => {
		const first = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));
		const second = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		process.env.SUBSTRATE_URL = first.url;
		expect(await postEvent(event, { collector: "t", source: "t" })).toEqual({ kind: "stored" });
		process.env.SUBSTRATE_URL = second.url;
		expect(await postEvent(event, { collector: "t", source: "t" })).toEqual({ kind: "stored" });

		expect(first.seen).toHaveLength(1);
		expect(second.seen).toHaveLength(1);
	});
});

describe("event-surface bearer resolution (D20-05)", () => {
	function tokensDirWith(surface: string, value: string): string {
		const dir = mkdtempSync(join(tmpdir(), "emit-tokens-"));
		writeFileSync(join(dir, surface), `${value}\n`);
		return dir;
	}

	test("no explicit token sends the event surface file value as Bearer", async () => {
		const dir = tokensDirWith("cursor", "cursor-file-value");
		process.env.SUBSTRATE_TOKENS_DIR = dir;
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		await postEvent({ ...event, surface: "cursor" }, { collector: "t", source: "t", url: stub.url });

		expect(stub.seen.map((entry) => entry.auth)).toEqual(["Bearer cursor-file-value"]);
	});

	test("an explicit token wins over the surface file", async () => {
		const dir = tokensDirWith("cursor", "cursor-file-value");
		process.env.SUBSTRATE_TOKENS_DIR = dir;
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		await postEvent({ ...event, surface: "cursor" }, { collector: "t", source: "t", url: stub.url, token: "explicit-value" });

		expect(stub.seen.map((entry) => entry.auth)).toEqual(["Bearer explicit-value"]);
	});

	test("env SUBSTRATE_TOKEN wins over the surface file", async () => {
		const dir = tokensDirWith("cursor", "cursor-file-value");
		process.env.SUBSTRATE_TOKENS_DIR = dir;
		process.env.SUBSTRATE_TOKEN = "env-value";
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		await postEvent({ ...event, surface: "cursor" }, { collector: "t", source: "t", url: stub.url });

		expect(stub.seen.map((entry) => entry.auth)).toEqual(["Bearer env-value"]);
	});

	test("absent everywhere sends no Authorization header", async () => {
		process.env.SUBSTRATE_TOKENS_DIR = mkdtempSync(join(tmpdir(), "emit-tokens-empty-"));
		const stub = track(stubServer(() => Response.json({ stored: true }, { status: 202 })));

		await postEvent({ ...event, surface: "cursor" }, { collector: "t", source: "t", url: stub.url });

		expect(stub.seen.map((entry) => entry.auth)).toEqual([null]);
		expect(stderr?.lines.join("")).not.toContain("cursor-file-value");
	});
});

describe("refused line", () => {
	test("keys are exact, the error is redacted and truncated, summary and payload never land", async () => {
		const stub = track(
			stubServer(() =>
				Response.json({ error: `unknown kind: nope ${decoy} ${"x".repeat(300)}` }, { status: 400 }),
			),
		);
		await postEvent(event, { collector: "grok", source: "grok", url: stub.url });

		const lines = refusedLines();
		expect(lines).toHaveLength(1);
		const line = lines[0] ?? {};
		expect(Object.keys(line).sort()).toEqual([
			"collector",
			"error",
			"kind",
			"source",
			"status",
			"surface",
			"ts",
		]);
		expect(line).toMatchObject({
			collector: "grok",
			source: "grok",
			kind: "prompt",
			surface: "grok-build",
			status: 400,
		});
		const error = line["error"];
		expect(typeof error).toBe("string");
		expect(error as string).not.toContain(decoy);
		expect((error as string).length).toBeLessThanOrEqual(200);
		const raw = readFileSync(join(stateDir, "refused-emits.jsonl"), "utf8");
		expect(raw).not.toContain("summary-marker-never-stored");
		expect(raw).not.toContain("payload-marker-never-stored");
		expect(raw).not.toContain(decoy);
	});
});
