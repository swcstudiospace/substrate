#!/usr/bin/env bun
/**
 * Verify the MCP audit chain on disk, closed segments and the active file together.
 *
 *   bun run audit:verify [--path <file>]
 *
 * The file is `--path`, else `SUBSTRATE_AUDIT_PATH`. Read-only: the log is never
 * opened for writing (the service is the single writer, and a verifier beside it
 * must not touch its file), no store is asked anything, and nothing a record holds
 * is printed — only counts and positions. It walks `<path>.<first>-<last>.jsonl`
 * segments in sequence order, then the active file, through one `ChainWalker`, and
 * anchors the result to `<path>.checkpoint` so a truncated or removed file reads
 * as missing history rather than as a shorter chain. See docs/mcp-audit.md.
 *
 * Output is one JSON line: `{segments, records, firstSeq, lastSeq, ok}`, plus
 * `unparseable`, `brokenAt` and `reason` when the chain does not verify. Exit 0 when
 * it verifies, 1 when it does not, 2 on a usage error.
 */
import { type AuditReport, verifyAuditSegments } from "../packages/audit/src/log.ts";

export class VerifyUsageError extends Error {}

export interface VerifyOptions {
	path: string;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): VerifyOptions {
	let path: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		switch (arg) {
			case "--path": {
				const value = argv[i + 1];
				if (!value || value.startsWith("--")) throw new VerifyUsageError("--path needs a value");
				path = value;
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				throw new VerifyUsageError(
					"usage: bun run audit:verify [--path <file>]\n\nVerifies the MCP audit chain across every closed segment and the active file.\nExit 0 when the chain verifies, 1 when it does not, 2 on a usage error.",
				);
			default:
				throw new VerifyUsageError(`unknown argument ${arg}`);
		}
	}
	path ??= env.SUBSTRATE_AUDIT_PATH?.trim() || null;
	if (path === null) throw new VerifyUsageError("no audit file: pass --path or set SUBSTRATE_AUDIT_PATH");
	return { path };
}

/** One line, fixed key order, the verdict's fields only. Nothing from a record is in it. */
export function formatReport(report: AuditReport): string {
	const line: Record<string, unknown> = {
		segments: report.segments,
		records: report.records,
		firstSeq: report.firstSeq,
		lastSeq: report.lastSeq,
		ok: report.ok,
	};
	if (!report.ok) {
		line.unparseable = report.unparseable;
		line.brokenAt = report.brokenAt;
		line.reason = report.reason;
	}
	return `${JSON.stringify(line)}\n`;
}

export async function run(argv: readonly string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
	const options = parseArgs(argv, env);
	// No AuditLog here: `open` appends to prove writability, and a verifier beside
	// the single writer must not. The pure verifier reads and judges the same files.
	const report = await verifyAuditSegments(options.path);
	return { code: report.ok ? 0 : 1, out: formatReport(report) };
}

if (import.meta.main) {
	try {
		const { code, out } = await run(process.argv.slice(2), process.env);
		process.stdout.write(out);
		process.exit(code);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "verification failed";
		process.stderr.write(`audit:verify: ${message}\n`);
		process.exit(2);
	}
}
