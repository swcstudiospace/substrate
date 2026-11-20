#!/usr/bin/env bun
/**
 * The PARITY_GATE CLI (SOTA-02, Phase 46, T3): `bun scripts/parity-gate.ts --part A|B`. Read-only: it reads the docs state
 * file, lists the plane's documents (`POST /documents/paginated`), and asks the frozen sample of `/query`. It writes
 * nothing to any store.
 *
 * Exit codes: 0 the part passed; 1 the part failed, or the plane could not be read; 2 the arguments are bad, or
 * `LIGHTRAG_URL` is unset, in which case no socket is opened.
 *
 * The reach is read by `lightragFromEnv` (config.ts), the one LightRAG reader. The output carries counts, the mode and
 * per-query hit flags only: never a key, a host, a document id, or a source URL. A plane failure is printed as its
 * category (`reasonCategory`, parity-run.ts), because transport text can carry the plane's address.
 */
import { runParity } from "../packages/mcp-server/src/parity-run.ts";

if (import.meta.main) {
	const outcome = await runParity(process.argv.slice(2), process.env);
	process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
	process.exitCode = outcome.exitCode;
}
