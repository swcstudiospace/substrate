/**
 * Tests for the Claude Code deferral dial (DISP-04, T-24-04a).
 *
 * The dial sends nothing: a loopback test double records every byte it
 * receives, and a refused or timed-out dial is `host-unreachable` without
 * giving the issue up. The source self-audit pins the phase boundary —
 * no task route, no host package, no HTTP client in this file.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
	CLAUDE_CODE_HOST,
	CLAUDE_CODE_PORT,
	dialClaudeCodeHost,
	tcpConnect,
	type ClaudeCodeSocket,
} from "./launch-claude-code.ts";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function refusedError(): NodeJS.ErrnoException {
	return Object.assign(new Error(`connect ECONNREFUSED ${CLAUDE_CODE_HOST}:${CLAUDE_CODE_PORT}`), {
		code: "ECONNREFUSED",
	});
}

describe("dial outcome", () => {
	test("a refused dial is host-unreachable", async () => {
		const outcome = await dialClaudeCodeHost({}, { connect: async () => Promise.reject(refusedError()) });
		expect(outcome).toBe("host-unreachable");
	});

	test("a timed-out dial is host-unreachable", async () => {
		const timeout = Object.assign(new Error("claude-code dial timed out"), { code: "ETIMEDOUT" });
		const outcome = await dialClaudeCodeHost({}, { connect: async () => Promise.reject(timeout) });
		expect(outcome).toBe("host-unreachable");
	});

	test("an accepted double that writes a refusal is host-refused", async () => {
		const written: string[] = [];
		const outcome = await dialClaudeCodeHost(
			{},
			{
				connect: async () => {
					// The double answers and refuses without being asked.
					written.push("refused");
					const socket: ClaudeCodeSocket = { close: () => {} };
					return socket;
				},
			},
		);
		expect(outcome).toBe("host-refused");
		expect(written).toEqual(["refused"]);
	});

	test("a closed socket closes the dial without throwing", async () => {
		let closed = 0;
		const outcome = await dialClaudeCodeHost(
			{},
			{
				connect: async () => ({
					close: () => {
						closed += 1;
					},
				}),
			},
		);
		expect(outcome).toBe("host-refused");
		expect(closed).toBe(1);
	});
	});

describe("loopback dial-only proof", () => {
	test("the double receives zero bytes and the dial reports host-refused", async () => {
		const received: Buffer[] = [];
		// TCP delivers bytes before FIN on one connection, so the server-side
		// close observes every byte this dial could have sent — no sleep.
		const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
		const server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => void received.push(chunk));
			socket.on("close", () => onClosed());
			socket.write("refused");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected a bound loopback port");
		const outcome = await dialClaudeCodeHost({ host: "127.0.0.1", port: address.port });
		expect(outcome).toBe("host-refused");
		await closed;
		expect(received).toEqual([]);
	});

	test("a closed loopback port through the real transport is host-unreachable", async () => {
		const probe = createServer();
		servers.push(probe);
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		if (address === null || typeof address === "string") throw new Error("expected a bound loopback port");
		const freed = address.port;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		servers.pop();
		const outcome = await dialClaudeCodeHost({ host: "127.0.0.1", port: freed, timeoutMs: 500 });
		expect(outcome).toBe("host-unreachable");
	});

	test("the production transport sends nothing on connect", async () => {
		const received: Buffer[] = [];
		const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
		const server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => void received.push(chunk));
			socket.on("close", () => onClosed());
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected a bound loopback port");
		const socket = await tcpConnect({ host: "127.0.0.1", port: address.port, timeoutMs: 1000 });
		socket.close();
		await closed;
		expect(received).toEqual([]);
	});
});

describe("phase boundary", () => {
	test("the launcher has no task client, no HTTP body, and no host package", () => {
		const source = readFileSync(new URL("./launch-claude-code.ts", import.meta.url), "utf8");
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|\s)\/\/.*$/gm, "$1");
		for (const token of ["/tasks", "fetch(", "openTask", "packages/host", "POST ", "Docker", "rivet"]) {
			expect(code).not.toContain(token);
		}
	});
});
