/**
 * Claude Code deferral dial (DISP-04, T-24-04a).
 *
 * `dispatch:claude-code` routes to the Lane A host, which phase 31 has not
 * built: nothing on this host listens on 7411. This module dials
 * 127.0.0.1:7411 and speaks nothing — no bytes are written, no HTTP request
 * is framed, and the phase-31 task route is never touched. Connection
 * refused or a dial timeout is `host-unreachable`; an accepted connection
 * (only a test double can answer today) is `host-refused`.
 *
 * Neither outcome gives the issue up: the caller posts the once-only
 * marker through the plan 24-01 machinery and keeps the label, so a later
 * tick can dial again once the listener exists. This module never creates
 * a worktree, never spawns, and never imports the host package.
 */

import { connect } from "node:net";

/** Loopback host the future Lane A listener will bind. */
export const CLAUDE_CODE_HOST = "127.0.0.1";
/** Loopback port the future Lane A listener will bind. */
export const CLAUDE_CODE_PORT = 7411;
/** Short dial budget: the listener is either there or it is not. */
export const CLAUDE_CODE_DIAL_TIMEOUT_MS = 1000;

export type ClaudeCodeDialOutcome = "host-unreachable" | "host-refused";

export interface ClaudeCodeDialTarget {
	host: string;
	port: number;
	timeoutMs: number;
}

/** An open dial. The peer may write; this side never does. */
export interface ClaudeCodeSocket {
	close(): void;
}

/**
 * Injectable transport. Production passes the TCP dial below; tests pass a
 * fake or point the dial at a loopback test double, so no test opens a
 * real socket to the Lane A port.
 */
export type ClaudeCodeConnect = (target: ClaudeCodeDialTarget) => Promise<ClaudeCodeSocket>;

/** TCP dial that sends zero bytes and ignores anything the peer writes. */
export function tcpConnect({ host, port, timeoutMs }: ClaudeCodeDialTarget): Promise<ClaudeCodeSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<ClaudeCodeSocket>();
	const socket = connect({ host, port });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(Object.assign(new Error(`claude-code dial timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
	}, timeoutMs);
	socket.once("connect", () => {
		clearTimeout(timer);
		resolve({ close: () => void socket.destroy() });
	});
	socket.once("error", (error) => {
		clearTimeout(timer);
		socket.destroy();
		reject(error);
	});
	socket.on("data", () => {
		// A test double writes its refusal unprompted. Read and drop:
		// the dial must never answer, whatever the peer says.
	});
	return promise;
}

export interface ClaudeCodeDialOptions {
	host?: string;
	port?: number;
	timeoutMs?: number;
}

/**
 * Dial the Lane A host without speaking its protocol. Refused or timed
 * out is `host-unreachable`; accepted is `host-refused`. Never throws for
 * transport failures: any connect error is the unreachable branch.
 */
export async function dialClaudeCodeHost(
	options: ClaudeCodeDialOptions = {},
	deps: { connect?: ClaudeCodeConnect } = {},
): Promise<ClaudeCodeDialOutcome> {
	const runConnect = deps.connect ?? tcpConnect;
	try {
		const socket = await runConnect({
			host: options.host ?? CLAUDE_CODE_HOST,
			port: options.port ?? CLAUDE_CODE_PORT,
			timeoutMs: options.timeoutMs ?? CLAUDE_CODE_DIAL_TIMEOUT_MS,
		});
		try {
			socket.close();
		} catch {
			// Best-effort teardown; the outcome is already decided.
		}
		return "host-refused";
	} catch {
		return "host-unreachable";
	}
}
