/**
 * Who may spend the owner's GitHub credential through POST /skills/propose and the MCP tool
 * skills_propose (checker W4): an authenticated bearer surface, or a host process that can read
 * the root-only propose key and sends it as a header. A Phase-3 rivet VM guest reaches
 * 127.0.0.1:7410 anonymously with no headers and cannot read /var/lib/substrate, so it is
 * refused before anything reaches git. The CLI proposes in-process and needs no key.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Surface } from "../types.ts";

export const PROPOSE_KEY_FILE = process.env.SUBSTRATE_PROPOSE_KEY_FILE ?? "/var/lib/substrate/skills/propose.key";
export const PROPOSE_KEY_HEADER = "x-substrate-propose-key";
const KEY_RE = /^[0-9a-f]{64}$/;

/** The key (64 lowercase hex) read on every call, so a rotation needs no restart; null when missing or malformed. */
export function readProposeKey(path: string = PROPOSE_KEY_FILE): string | null {
	let key: string;
	try {
		key = readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
	return KEY_RE.test(key) ? key : null;
}

/** A bearer surface, or a header equal to the key (constant-time over equal lengths). */
export function proposeAllowed(input: {
	callerSurface: Surface | null;
	header: string | string[] | null | undefined;
	key: string | null;
}): boolean {
	if (input.callerSurface !== null) return true;
	if (input.key === null || typeof input.header !== "string") return false;
	const given = Buffer.from(input.header, "utf8");
	const want = Buffer.from(input.key, "utf8");
	return given.length === want.length && timingSafeEqual(given, want);
}
