/**
 * Tests for the host substrate proxy: the bearer is attached on the host, the VM's own
 * Authorization is dropped, and only POST-able /mcp is forwarded. The bearer value below is a
 * fixture; the assertions check header presence and the `Bearer ` scheme only.
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSubstrateProxy } from "./substrate-proxy.ts";

const FIXTURE_BEARER = "fixture-host-bearer";

function listen(server: Server): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	return promise;
}

function close(server: Server): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	return promise;
}

type Seen = { method: string | undefined; url: string | undefined; authorization: string | undefined; body: string };

async function withUpstream(run: (port: number, seen: Seen[]) => Promise<void>): Promise<void> {
	const seen: Seen[] = [];
	const upstream = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
			res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	const port = await listen(upstream);
	try {
		await run(port, seen);
	} finally {
		await close(upstream);
	}
}

async function withProxy(upstreamPort: number, run: (port: number) => Promise<void>): Promise<void> {
	const proxy = createSubstrateProxy({
		upstream: `http://127.0.0.1:${upstreamPort}/mcp`,
		bearer: FIXTURE_BEARER,
		log: () => {},
	});
	const port = await listen(proxy);
	try {
		await run(port);
	} finally {
		await close(proxy);
	}
}

describe("substrate proxy", () => {
	test("attaches the host bearer and drops any VM-supplied Authorization", async () => {
		await withUpstream(async (upstreamPort, seen) => {
			await withProxy(upstreamPort, async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: "Bearer vm-supplied" },
					body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
				});
				expect(res.status).toBe(200);
				expect(res.headers.get("x-upstream")).toBe("yes");
				expect(await res.json()).toEqual({ ok: true });
			});
			expect(seen).toHaveLength(1);
			expect(seen[0]?.authorization).toBe(`Bearer ${FIXTURE_BEARER}`);
			expect(seen[0]?.method).toBe("POST");
			expect(seen[0]?.url).toBe("/mcp");
			expect(seen[0]?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
		});
	});

	test("refuses any path other than /mcp without contacting the upstream", async () => {
		await withUpstream(async (upstreamPort, seen) => {
			await withProxy(upstreamPort, async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/admin`, { method: "POST", body: "{}" });
				expect(res.status).toBe(404);
			});
			expect(seen).toHaveLength(0);
		});
	});

	test("answers 502 when the upstream is unreachable", async () => {
		const deadUpstream = createServer();
		const deadPort = await listen(deadUpstream);
		await close(deadUpstream);
		await withProxy(deadPort, async (port) => {
			const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
			expect(res.status).toBe(502);
		});
	});
});
