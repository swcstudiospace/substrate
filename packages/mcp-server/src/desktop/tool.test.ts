/**
 * desktop_run at the MCP gate (D30-02..04, D30-09, D30-12..13).
 *
 * The tool is driven through a real client over the in-memory transport, with
 * the driver behind a recording fake runner and the ledger behind a stub — the
 * point is the wiring (refusal order, strict schema, image blocks, ledger stop)
 * rather than docker or Greptime.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { EventQuery } from "../greptime.ts";
import { createMcpServer, type McpCaller } from "../mcp.ts";
import { Substrate } from "../service.ts";
import type { SubstrateEvent, Surface } from "../types.ts";
import { createDesktopDriver, DesktopBusy, type BufferRunner, type BufferRunResult } from "./driver.ts";
type TestCaller = Surface | McpCaller | null;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDesktop(): string {
	const dir = mkdtempSync(join(tmpdir(), "desktop-tool-"));
	dirs.push(dir);
	return join(dir, "shots");
}

const res = (stdout: string | Buffer, code = 0, stderr = ""): BufferRunResult => ({
	code,
	stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
	stderr,
});

/** 4x3 test image: pixel (x, y) is RGB (10x+1, 20y+2, 7x+5y+3). Duplicated from driver.test.ts so no test file imports another. */
const W = 4;
const H = 3;
const pixel = (x: number, y: number) => [10 * x + 1, 20 * y + 2, 7 * x + 5 * y + 3] as const;

function xwd(): Buffer {
	const name = Buffer.from("xwdtest\0");
	const unit = 4;
	const bytesPerLine = W * unit + 4;
	const header = Buffer.alloc(100);
	const fields = [100 + name.length, 7, 2, 24, W, H, 0, 0, 32, 0, 32, 32, bytesPerLine, 4, 0xff0000, 0xff00, 0xff, 8, 256, 0, W, H, 0, 0, 0];
	fields.forEach((value, i) => header.writeUInt32BE(value, i * 4));
	const pixels = Buffer.alloc(bytesPerLine * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const [r, g, b] = pixel(x, y);
			pixels.writeUIntLE((r << 16) | (g << 8) | b, y * bytesPerLine + x * unit, unit);
		}
	}
	return Buffer.concat([header, name, pixels]);
}

/** A recording fake: proven local endpoint for the locality probe, geometry 1280x800, a title per call, the synthetic XWD for xwd, "" otherwise. */
function recorder() {
	const calls: string[][] = [];
	const run: BufferRunner = async (argv) => {
		calls.push([...argv]);
		if (argv[1] === "context") return res("unix:///var/run/docker.sock\n");
		if (argv.includes("getdisplaygeometry")) return res("1280 800\n");
		if (argv.includes("getwindowname")) return res("stub-window\n");
		if (argv.includes("xwd")) return res(xwd());
		return res("");
	};
	return { calls, run };
}

const noSleep = async () => {};

/** A ledger stub recording what was appended. */
function ledger(overrides: { insertEvent?: (event: SubstrateEvent) => Promise<void> } = {}) {
	const written: SubstrateEvent[] = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent:
				overrides.insertEvent ??
				(async (event: SubstrateEvent) => {
					written.push(event);
				}),
			queryEvents: async (_query: EventQuery) => [],
			readEvents: async () => [],
		},
	};
}

async function connect(
	ledgerStub: ReturnType<typeof ledger>,
	caller: TestCaller,
	rec: ReturnType<typeof recorder>,
	tmp: string,
	options: { greptimeNull?: boolean; desktopNull?: boolean } = {},
) {
	const config = loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_DESKTOP_DIR: tmp });
	const substrate = new Substrate(
		config,
		{
			index: null,
			greptime: (options.greptimeNull ? null : ledgerStub.greptime) as never,
			...(options.desktopNull ? {} : { desktop: createDesktopDriver({ run: rec.run, dir: tmp, sleep: noSleep }) }),
		},
	);
	const server = createMcpServer(substrate, caller);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, substrate };
}

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

/** A tool's full reply: desktop_run answers with text plus image blocks, so content zero is not enough. */
async function callFull(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	return { isError: result.isError === true, content: result.content as ContentBlock[] };
}

const SHOT = { actions: [{ type: "screenshot" }] };

describe("desktop_run refusals", () => {
	test("an unlisted surface is refused and runs nothing", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, "cursor", rec, tmpDesktop());

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content[0]?.text).toContain("nothing was run");
		expect(rec.calls).toEqual([]);
		expect(stub.written).toEqual([]);
	});

	test("an operator-marked bearer for an unlisted surface is still refused before input", async () => {
		const stub = ledger();
		const rec = recorder();
		// Valid args, so only the allowlist gate can refuse: the operator flag
		// grants nothing at this tool and the token surface stays authoritative.
		const { client } = await connect(stub, { surface: "cursor", isOperator: true }, rec, tmpDesktop());

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(rec.calls).toEqual([]);
		expect(stub.written).toEqual([]);
		expect(content.some((block) => block.type === "image")).toBe(false);
	});

	test("an anonymous caller is refused and runs nothing", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, null, rec, tmpDesktop());

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content[0]?.text).toContain("nothing was run");
		expect(rec.calls).toEqual([]);
		expect(stub.written).toEqual([]);
	});

	test("a surface argument is rejected by the strict schema and runs nothing", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, "omp", rec, tmpDesktop());

		const { isError } = await callFull(client, "desktop_run", { ...SHOT, surface: "omp" });

		expect(isError).toBe(true);
		expect(rec.calls).toEqual([]);
		expect(stub.written).toEqual([]);
	});

	test("no ledger means no run", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, "omp", rec, tmpDesktop(), { greptimeNull: true });

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content[0]?.text).toContain("needs the event ledger");
		expect(content[0]?.text).toContain("nothing was run");
		expect(rec.calls).toEqual([]);
	});

	test("an unwired driver is refused and runs nothing", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, "omp", rec, tmpDesktop(), { desktopNull: true });

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content[0]?.text).toContain("nothing was run");
		expect(rec.calls).toEqual([]);
		expect(stub.written).toEqual([]);
	});

	test("a busy driver is refused naming the active run", async () => {
		const tmp = tmpDesktop();
		const config = loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_DESKTOP_DIR: tmp });
		const busyId = "dr-20261009T000000Z-busy01";
		const substrate = new Substrate(config, {
			index: null,
			greptime: ledger().greptime as never,
			desktop: {
				run: async () => {
					throw new DesktopBusy(busyId);
				},
			},
		});

		const outcome = await substrate.runDesktop(SHOT, "omp");

		expect(outcome).toEqual({ refused: `desktop_run is busy with run ${busyId}; nothing was run` });
	});
});

describe("desktop_run success", () => {
	test("returns one text block plus image blocks with matching hashes", async () => {
		const stub = ledger();
		const rec = recorder();
		const tmp = tmpDesktop();
		const { client } = await connect(stub, "omp", rec, tmp);

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(false);
		expect(content[0]?.type).toBe("text");
		const reply = JSON.parse(content[0]?.text ?? "") as {
			run_id: string;
			screenshots: Array<{ path: string; width: number; height: number; sha256: string }>;
			log: unknown[];
		};
		expect(reply.screenshots).toHaveLength(1);
		const shot = reply.screenshots[0]!;
		const images = content.slice(1);
		expect(images).toHaveLength(1);
		expect(images[0]?.type).toBe("image");
		expect(images[0]?.mimeType).toBe("image/png");
		const bytes = Buffer.from(images[0]?.data ?? "", "base64");
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(shot.sha256);

		// The stored file carries the same bytes the caller got.
		const stored = readFileSync(shot.path);
		expect(createHash("sha256").update(stored).digest("hex")).toBe(shot.sha256);

		// One tool.call event per executed action, under the run session, hashes only.
		expect(stub.written).toHaveLength(1);
		expect(stub.written[0]).toMatchObject({
			kind: "tool.call",
			surface: "omp",
			session_id: `desktop:${reply.run_id}`,
		});
		expect(JSON.stringify(stub.written)).not.toContain("iVBOR");
	});

	test("an event that is not stored stops the run with no image blocks", async () => {
		const stub = ledger({
			insertEvent: async () => {
				throw new Error("ledger down");
			},
		});
		const rec = recorder();
		const { client } = await connect(stub, "omp", rec, tmpDesktop());

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content).toHaveLength(1);
		const reply = JSON.parse(content[0]?.text ?? "") as { run_id: string; log: unknown[]; error: string };
		expect(typeof reply.run_id).toBe("string");
		expect(reply.error).toContain("event not stored");
		expect(content.some((block) => block.type === "image")).toBe(false);
	});

	test("an operator-marked bearer for a listed surface runs as its token surface", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, { surface: "omp", isOperator: true }, rec, tmpDesktop());

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(false);
		expect(rec.calls.length).toBeGreaterThan(0);
		expect(stub.written).toHaveLength(1);
		expect(stub.written[0]).toMatchObject({ kind: "tool.call", surface: "omp" });
		expect(content.some((block) => block.type === "image")).toBe(true);
	});
});

describe("desktop_run driver errors", () => {
	test("a driver throw after partial input is redacted, bounded and carries no images", async () => {
		const stub = ledger();
		const rec = recorder();
		const tmp = tmpDesktop();
		// Assembled at runtime so no credential-shaped literal sits in source;
		// the shared redactor must still strip it from the tool error.
		const secret = `${"sk-ant"}-${"a1".repeat(15)}`;
		const failure = new Error(`driver exploded ${secret} ${"x".repeat(600)}`);
		const config = loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_DESKTOP_DIR: tmp });
		const substrate = new Substrate(config, {
			index: null,
			greptime: stub.greptime as never,
			desktop: {
				run: async () => {
					await rec.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 1000);
					throw failure;
				},
			},
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const { isError, content } = await callFull(client, "desktop_run", SHOT);

		expect(isError).toBe(true);
		expect(content).toHaveLength(1);
		expect(content[0]?.type).toBe("text");
		const text = content[0]?.text ?? "";
		expect(text).not.toContain(secret);
		// The 400-character bound applies to the redacted error value inside
		// the JSON tool reply, not the reply envelope itself.
		const body: unknown = JSON.parse(text);
		if (!body || typeof body !== "object" || !("error" in body) || typeof body.error !== "string") {
			throw new Error("expected a JSON tool reply carrying a string error");
		}
		expect(body.error.length).toBeLessThanOrEqual(400);
		expect(content.some((block) => block.type === "image")).toBe(false);
		// Partial input effects are observable, so this error path is not a
		// pre-run refusal with zero effects.
		expect(rec.calls.length).toBeGreaterThan(0);
	});
});

describe("desktop_run registration", () => {
	test("the tool is listed with a strict schema", async () => {
		const stub = ledger();
		const rec = recorder();
		const { client } = await connect(stub, "omp", rec, tmpDesktop());

		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "desktop_run");

		expect(tool).toBeDefined();
		// A listed agent can type a terminal command or click a delete button,
		// so the tool must advertise itself as destructive.
		expect(tool?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
		expect((tool?.inputSchema as { additionalProperties?: unknown } | undefined)?.additionalProperties).toBe(false);
	});
});
