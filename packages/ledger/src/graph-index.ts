/**
 * The per-graph index address (design 73-MEMO-V3-DESIGN.md section 3.2): base58 of SHA-256 over
 * "substrate:graph-index:v1\n" followed by the graph id. It is 32 bytes, holds no key and never signs. Its only job is to
 * appear in the account keys of the graph's v3 pointer transactions, so a paged listing of this address returns that graph's
 * pointers and nothing else.
 */

import { sha256 } from "./merkle.ts";
import { bs58encode } from "./rpc.ts";

const GRAPH_INDEX_DOMAIN = "substrate:graph-index:v1\n";

/** The index address of `graphId` (the stored, normalised graph id). Deterministic; distinct ids give distinct addresses. */
export function graphIndexAddress(graphId: string): string {
	if (typeof graphId !== "string" || graphId.length === 0) throw new Error("graphIndexAddress: graph id is empty");
	return bs58encode(sha256(new TextEncoder().encode(`${GRAPH_INDEX_DOMAIN}${graphId}`)));
}
