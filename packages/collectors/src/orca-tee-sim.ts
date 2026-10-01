#!/usr/bin/env bun
/**
 * Basic Orca tee simulation (endpoint simulation).
 *
 * Orca's hook contract (see CONTEXT) sources endpoint.env and POSTs to
 * http://127.0.0.1:PORT/hook/<agent> with headers + raw json payload.
 *
 * This is a throwaway simulation you can run to test the seam without
 * touching the live ORCA_AGENT_HOOK_ENDPOINT (which would affect every
 * running orca pane). Native floor (grok/herdr/hermes collectors) first.
 *
 * Usage (simulation only):
 *   ORCA_TEE_PORT=34050 bun packages/collectors/src/orca-tee-sim.ts
 * Then manually set a test endpoint.env to point at it for verification.
 *
 * It forwards to real orca (34049) + emits a normalized event.
 * All errors swallowed (fail-open).
 */
import type { EventInput } from "../../mcp-server/src/types.ts";

const PORT = Number(process.env.ORCA_TEE_PORT ?? 34050);
const REAL_ORCA = `http://127.0.0.1:${process.env.ORCA_AGENT_HOOK_PORT ?? 34049}`;
const SUBSTRATE = (process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");

async function emit(ev: EventInput) {
	try {
		await fetch(`${SUBSTRATE}/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(ev),
			signal: AbortSignal.timeout(1500),
		});
	} catch {}
}

async function forward(path: string, headers: Headers, body: string) {
	try {
		await fetch(`${REAL_ORCA}${path}`, {
			method: "POST",
			headers: Object.fromEntries(headers),
			body,
			signal: AbortSignal.timeout(1500),
		});
	} catch {}
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
			const agent = url.pathname.split("/").pop() || "unknown";
			const body = await req.text();
			const meta = req.headers.get("X-Orca-Agent-Hook-Meta") || "";
			// emit a normalized event (surface orca, kind note or tool if parsable)
			const ev: EventInput = {
				surface: "claude-code", // orca surfaces claude/codex/grok/hermes; map to closest or add "orca" if extended
				kind: "note",
				summary: `orca hook ${agent}`,
				payload: { meta: meta.slice(0, 200), len: body.length },
			};
			await emit(ev);
			// forward verbatim
			await forward(url.pathname, req.headers, body);
			return new Response("ok", { status: 200 });
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(`[orca-tee-sim] listening on :${PORT} (forward+emit; simulation only)`);