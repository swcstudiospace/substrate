#!/usr/bin/env bun
/**
 * Isolated end-to-end proof of the docs plane (DOCS-01/02/03), against a
 * rehearsal twin started with `--ragflow-fixture`.
 *
 *   bun run rehearsal up --name p25 --ragflow-fixture
 *   set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p25/consumer.env"; set +a
 *   bun run smoke:docs
 *   bun run rehearsal down --name p25
 *
 * It sources only `consumer.env` and keeps the harness's guards: it refuses
 * the production port and any host that is not loopback, drives the twin over
 * loopback only, and reads the fake RAGFlow's persisted state file instead of
 * querying a second door. The planted secret is assembled at run time so no
 * secret-shaped literal sits in the repository. It proves, over the real
 * server, `POST /docs/search`, `POST /docs/ingest`, the `docs_search` and
 * `docs_ingest` MCP tools, and `substrate docs ingest`:
 *
 *   a. an ingest through the route, the MCP tool and the CLI answers
 *      `uploaded`; a re-ingest answers `unchanged` with no new fake upload
 *   b. each refusal with nothing reaching the fake — no-source, outside-roots
 *      (receipts, an empty segment, a foreign slug), oversize page and body,
 *      non-text, a planted runtime-assembled secret (the finding names line
 *      and rule; the value is in no response, event, audit or fake state),
 *      anonymous, and an agent-surface token
 *   c. a remote and a local image are stripped from what the fake received
 *   d. `finalize` cuts a version; after six versions five remain, and a search
 *      returns only current-version sections
 *   e. a search honours `limit` with every DOCS-01 field, snippets of at most
 *      1,200 characters, and `untrusted: true`
 *   f. a fake timeout, an error code and malformed JSON each give `results: []`
 *      with the matching reason
 *   g. `POST /events/query` returns the `docs.search` note listing the URLs
 *      plus the `docs.ingest` rows, and the audit file holds the `docs_search`
 *      and `docs_ingest` records
 *
 * Exit 0 when every check passes, 1 on a failure, 2 when the twin is not a
 * ragflow-fixture one.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refuseSmokeUrl } from "./rehearsal.ts";
import { parseKeyValues, toolReply } from "./skills-propose-smoke.ts";
import {
	RAGFLOW_FIXTURE_DATASET,
	RAGFLOW_FIXTURE_SLUG,
} from "../packages/mcp-server/src/rehearsal-ragflow.ts";
import type { FakeRagflowState } from "../packages/mcp-server/src/rehearsal-fake-ragflow.ts";

const DATASET = RAGFLOW_FIXTURE_DATASET;
const SLUG = RAGFLOW_FIXTURE_SLUG;

interface Reply {
	status: number;
	json: Record<string, unknown>;
	text: string;
}

interface LedgerEvent {
	kind: string;
	surface: string;
	payload: Record<string, unknown>;
}

/** A ledger row with the three fields the smoke reads; anything else is not ours to assert. */
function isLedgerEvent(row: unknown): row is LedgerEvent {
	if (typeof row !== "object" || row === null) return false;
	if (!("kind" in row) || typeof row.kind !== "string") return false;
	if (!("surface" in row) || typeof row.surface !== "string") return false;
	if (!("payload" in row) || typeof row.payload !== "object" || row.payload === null) return false;
	return true;
}

async function main(): Promise<number> {
	const env = process.env;
	const base = (env.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
	const refused = base ? refuseSmokeUrl(base) : "SUBSTRATE_URL is not set: source the instance's consumer.env first";
	if (refused !== null) {
		process.stderr.write(`[docs-smoke] ${refused}\n`);
		return 2;
	}
	const need = [
		"SUBSTRATE_REHEARSAL_RAGFLOW_REGISTRY",
		"SUBSTRATE_REHEARSAL_RAGFLOW_STATE",
		"SUBSTRATE_REHEARSAL_RAGFLOW_MODE_FILE",
		"SUBSTRATE_REHEARSAL_TOKENS_DIR",
	];
	const missing = need.filter((key) => !env[key]);
	if (missing.length > 0) {
		process.stderr.write(`[docs-smoke] this twin has no ragflow fixture (${missing.join(", ")} unset): rehearsal up --ragflow-fixture\n`);
		return 2;
	}
	const fakeStatePath = env.SUBSTRATE_REHEARSAL_RAGFLOW_STATE as string;
	const modeFile = env.SUBSTRATE_REHEARSAL_RAGFLOW_MODE_FILE as string;
	const tokensDir = env.SUBSTRATE_REHEARSAL_TOKENS_DIR as string;
	const runDir = dirname(tokensDir);
	const operatorToken = env.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN || env.SUBSTRATE_TOKEN || "";
	const agentSurface = "cursor";
	const agentToken = existsSync(join(tokensDir, agentSurface)) ? readFileSync(join(tokensDir, agentSurface), "utf8").trim() : "";
	if (!operatorToken || !agentToken) {
		process.stderr.write(`[docs-smoke] needs the operator's token and ${join(tokensDir, agentSurface)}; start the twin with the default surfaces\n`);
		return 2;
	}

	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\ndocs smoke — ${new URL(base).host}, dataset ${DATASET}\n\n`);

	const tag = Math.random().toString(16).slice(2, 8);
	const session = `smoke-docs-${tag}`;
	const scratch = mkdtempSync(join(tmpdir(), "docs-smoke-"));
	// Assembled at run time so no secret-shaped literal sits in the repository.
	const secret = `ghp_${"S".repeat(8)}${tag}${"k".repeat(22)}`.slice(0, 40);
	const commit = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex");
	const sourceUrl = (path: string, sha: string): string => `https://github.com/${SLUG}/blob/${sha}/${path}`;

	const headers = (token: string | null): Record<string, string> => ({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	});
	// A route body as an object, else empty: the checks read failures from
	// the status and the kept text, so a non-object body is {} here, never a lie.
	const responseJson = (text: string): Record<string, unknown> => {
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// Not JSON: the text is kept for the check.
		}
		return {};
	};
	const ingest = async (token: string | null, body: Record<string, unknown>): Promise<Reply> => {
		const response = await fetch(`${base}/docs/ingest`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ session_id: session, ...body }),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await response.text();
		return { status: response.status, json: responseJson(text), text };
	};
	const search = async (token: string | null, body: Record<string, unknown>): Promise<Reply> => {
		const response = await fetch(`${base}/docs/search`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ session_id: session, ...body }),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await response.text();
		return { status: response.status, json: responseJson(text), text };
	};
	let rpcId = 0;
	const tool = async (
		token: string | null,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ status: number; reply: { isError: boolean; value: Record<string, unknown> } | null; text: string }> => {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++rpcId,
				method: "tools/call",
				params: { name, arguments: { session_id: session, ...args } },
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await response.text();
		return { status: response.status, reply: toolReply(text), text };
	};
	const cli = async (token: string, file: string, url: string, sha: string): Promise<{ code: number; fields: Record<string, string[]>; text: string }> => {
		const proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"), "docs", "ingest", "--dataset", DATASET, "--file", file, "--source-url", url, "--commit", sha],
			{
				env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", SUBSTRATE_URL: base, SUBSTRATE_TOKEN: token },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, fields: parseKeyValues(out), text: `${out}${err}` };
	};
	// The fake persists its own state shape; the smoke checks the envelope
	// and then reads the module's named type, so a corrupt file fails the
	// proof instead of the parse.
	const fakeState = (): FakeRagflowState | null => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(fakeStatePath, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return null;
			if (!("datasets" in parsed) || !("calls" in parsed)) return null;
			return parsed as FakeRagflowState;
		} catch {
			return null;
		}
	};
	const fakeUploads = (): number => fakeState()?.calls.uploads ?? -1;
	const fakeContents = (): string[] => {
		const state = fakeState();
		if (!state) return [];
		return Object.values(state.datasets).flatMap((dataset) => Object.values(dataset.docs).map((doc) => doc.content));
	};
	const setMode = (mode: Record<string, unknown>): void => {
		writeFileSync(modeFile, `${JSON.stringify(mode)}\n`);
	};
	const manifest = (): { versions: Array<{ commit: string }> } => {
		const parsed: unknown = JSON.parse(readFileSync(join(runDir, "docs", DATASET, "manifest.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("versions" in parsed) || !Array.isArray(parsed.versions)) {
			throw new Error("the docs manifest has no versions list");
		}
		const versions = parsed.versions.filter((entry): entry is { commit: string } =>
			typeof entry === "object" && entry !== null && "commit" in entry && typeof entry.commit === "string",
		);
		return { versions };
	};

	try {
		// ── a. uploaded on each door, unchanged on re-ingest ─────────────
		const shaRoute = commit();
		const routePath = `smoke-${tag}/route.md`;
		const routeBody = {
			dataset: DATASET,
			source_url: sourceUrl(routePath, shaRoute),
			commit: shaRoute,
			content: `# Route page ${tag}\n\nA rehearsal docs smoke page. Marker route-${tag}.\n`,
		};
		let before = fakeUploads();
		const viaRoute = await ingest(operatorToken, routeBody);
		check(viaRoute.status === 200 && viaRoute.json.status === "uploaded", "the route answers uploaded", `${viaRoute.status} ${String(viaRoute.json.status ?? viaRoute.json.error)}`);
		check(typeof viaRoute.json.datasetId === "string" && typeof viaRoute.json.contentSha256 === "string", "the route names the dataset id and the content hash");
		const afterFirst = fakeUploads();
		// The state file does not exist before the first upload; later runs
		// of the smoke against the same twin accumulate, so both shapes count.
		const baseCount = before < 0 ? 0 : before;
		check(afterFirst === baseCount + 1, "the fake recorded exactly one upload", `${before} -> ${afterFirst}`);
		const again = await ingest(operatorToken, routeBody);
		check(again.status === 200 && again.json.status === "unchanged", "a re-ingest answers unchanged", String(again.json.status));
		check(fakeUploads() === afterFirst, "the re-ingest uploaded nothing new at the fake");

		const shaMcp = commit();
		const mcpPath = `smoke-${tag}/mcp.md`;
		before = fakeUploads();
		const viaTool = await tool(operatorToken, "docs_ingest", {
			dataset: DATASET,
			source_url: sourceUrl(mcpPath, shaMcp),
			commit: shaMcp,
			content: `# MCP page ${tag}\n\nA rehearsal docs smoke page. Marker mcp-${tag}.\n`,
		});
		const toolValue = viaTool.reply?.value ?? {};
		check(viaTool.reply !== null && !viaTool.reply.isError && toolValue.status === "uploaded", "the MCP tool answers uploaded", String(toolValue.status ?? toolValue.error ?? viaTool.status));
		check(fakeUploads() === before + 1, "the tool's page reached the fake exactly once");

		const shaCli = commit();
		const cliPath = `smoke-${tag}/cli.md`;
		const cliFile = join(scratch, "cli.md");
		writeFileSync(cliFile, `# CLI page ${tag}\n\nA rehearsal docs smoke page. Marker cli-${tag}.\n`);
		before = fakeUploads();
		const viaCli = await cli(operatorToken, cliFile, sourceUrl(cliPath, shaCli), shaCli);
		check(viaCli.code === 0 && viaCli.fields.status?.[0] === "uploaded", "substrate docs ingest prints status=uploaded and exits 0", viaCli.text.trim().split("\n")[0]);
		check(fakeUploads() === before + 1, "the CLI's page reached the fake exactly once");

		// ── b. refusals, nothing reaching the fake ───────────────────────
		// Every case builds its URL and its commit field from one sha: a
		// mismatched pair would refuse as a mismatch, not the case under test.
		const page = (path: string, content: string): Record<string, unknown> => {
			const sha = commit();
			return { dataset: DATASET, source_url: path ? sourceUrl(path, sha) : "", commit: sha, content };
		};
		const foreignSha = commit();
		const emptySha = commit();
		const refusalCases: Array<[string, Record<string, unknown>, string]> = [
			["no source URL", page("", "body"), "no-source"],
			["receipts are outside the roots", page(`docs/receipts/evil-${tag}.md`, "body"), "outside-roots"],
			[
				"a foreign slug is outside the roots",
				{ dataset: DATASET, source_url: `https://github.com/other/repo/blob/${foreignSha}/guide.md`, commit: foreignSha, content: "body" },
				"outside-roots",
			],
			["a non-text page", page(`smoke-${tag}/binary.png`, "fake png bytes"), "not-text"],
			// An empty path segment is the traversal-adjacent refusal the URL
			// parser cannot normalise away (a literal `..` never survives it).
			[
				"an empty segment is outside the roots",
				{ dataset: DATASET, source_url: `https://github.com/${SLUG}/blob/${emptySha}/smoke-${tag}//escape.md`, commit: emptySha, content: "body" },
				"outside-roots",
			],
		];
		for (const [label, body, reason] of refusalCases) {
			before = fakeUploads();
			const reply = await ingest(operatorToken, body);
			check(reply.status === 400 && reply.json.status === "refused" && reply.json.reason === reason, `${label} is refused as ${reason}`, `${reply.status} ${String(reply.json.reason ?? reply.json.error)}`);
			check(fakeUploads() === before, `${label}: nothing reached the fake`);
		}

		const bigSha = commit();
		before = fakeUploads();
		const oversize = await ingest(operatorToken, {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/big.md`, bigSha),
			commit: bigSha,
			content: `x`.repeat(257 * 1024),
		});
		check(oversize.status === 400 && oversize.json.reason === "too-large", "an oversize page is refused as too-large", `${oversize.status} ${String(oversize.json.reason)}`);
		check(fakeUploads() === before, "the oversize page: nothing reached the fake");

		const hugeSha = commit();
		before = fakeUploads();
		const huge = await ingest(operatorToken, {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/huge.md`, hugeSha),
			commit: hugeSha,
			content: `y`.repeat(1_100_000),
		});
		check(huge.status === 413, "an oversize body is 413", String(huge.status));
		check(fakeUploads() === before, "the oversize body: nothing reached the fake");

		before = fakeUploads();
		const secretSha = commit();
		const planted = await ingest(operatorToken, {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/secret.md`, secretSha),
			commit: secretSha,
			content: `# Secret page ${tag}\n\nUse GITHUB_TOKEN=${secret} to call the API.\n`,
		});
		const findingsRaw: unknown = planted.json.findings;
		const findings: unknown[] = Array.isArray(findingsRaw) ? findingsRaw : [];
		const findingsOk = findings.length > 0 && findings.every((finding) =>
			typeof finding === "object" && finding !== null &&
			"line" in finding && typeof finding.line === "number" &&
			"rule" in finding && typeof finding.rule === "string",
		);
		check(
			planted.status === 400 && planted.json.reason === "secret" && findingsOk,
			"a planted secret is refused with findings naming line and rule",
			JSON.stringify(findings[0] ?? {}),
		);
		check(fakeUploads() === before, "the planted secret: nothing reached the fake");
		const secretSha2 = commit();
		const viaToolSecret = await tool(operatorToken, "docs_ingest", {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/secret2.md`, secretSha2),
			commit: secretSha2,
			content: `token ${secret}\n`,
		});
		check(viaToolSecret.reply?.isError === true, "the same secret through the MCP tool is an error reply too");

		// Anonymous and agent-surface callers never reach the writer.
		before = fakeUploads();
		const anonymousRoute = await ingest(null, routeBody);
		const anonymousSearch = await search(null, { query: "anything" });
		const anonymousMcp = await tool(null, "docs_ingest", routeBody);
		check(anonymousRoute.status === 401, "no token is 401 on /docs/ingest", String(anonymousRoute.status));
		// A tokened twin rejects untokened callers at the gate; the
		// `unauthenticated` reason itself belongs to allowAnonymous runs and
		// is pinned at the service level, not over this wire.
		check(anonymousSearch.status === 401, "no token is 401 on /docs/search", String(anonymousSearch.status));
		check(anonymousMcp.status === 401, "no token is 401 on /mcp", String(anonymousMcp.status));
		const agentRoute = await ingest(agentToken, routeBody);
		const agentTool = await tool(agentToken, "docs_ingest", routeBody);
		check(agentRoute.status === 403, "an agent-surface token is 403 on /docs/ingest", String(agentRoute.status));
		check(agentTool.reply?.isError === true, "an agent-surface token is an error reply on the MCP tool too");
		check(fakeUploads() === before, "no authentication refusal reached the fake");

		// ── c. images stripped from what the fake received ───────────────
		const shaImages = commit();
		const imagesBody = {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/images.md`, shaImages),
			commit: shaImages,
			content: `# Images ${tag}\n\nRemote ![remote alt](https://example.com/pic.png) and local ![local alt](./pic.png) plus <img src="local.png" alt="tagpic"> end.\n`,
		};
		const viaImages = await ingest(operatorToken, imagesBody);
		check(viaImages.status === 200 && viaImages.json.imagesStripped === 3, "three images are stripped", String(viaImages.json.imagesStripped));
		const stored = fakeContents().find((content) => content.includes("remote alt")) ?? "";
		check(stored.length > 0, "the stripped page is what the fake holds");
		check(!stored.includes("![") && !stored.includes("<img"), "no image markup reached the fake");
		check(stored.includes("[image: remote alt]") && stored.includes("[image: local alt]") && stored.includes("[image: tagpic]"), "alt text survives as placeholders");

		// ── d. finalize cuts; six versions keep five ─────────────────────
		const versionedPath = `smoke-${tag}/versioned.md`;
		const commits: string[] = [];
		// Single-token markers: the fake scores on words of four or more
		// characters, so a hyphenated marker would match every round. One
		// token per round keeps each query specific to its version.
		for (let round = 0; round < 6; round += 1) {
			const sha = commit();
			commits.push(sha);
			const marker = round === 0 ? `alpha${tag}` : `vv${round}${tag}`;
			const page = await ingest(operatorToken, {
				dataset: DATASET,
				source_url: sourceUrl(versionedPath, sha),
				commit: sha,
				content: `# Versioned ${tag} round ${round}\n\n${marker} lives here.\n`,
			});
			check(page.status === 200 && (page.json.status === "uploaded" || page.json.status === "unchanged"), `round ${round} ingests`, String(page.json.status));
			const cut = await ingest(operatorToken, { finalize: true, dataset: DATASET, commit: sha, paths_present: [versionedPath] });
			check(cut.status === 200 && cut.json.status === "version-cut", `round ${round} cuts a version`, String(cut.json.status));
		}
		check(manifest().versions.length === 5, "after six versions five remain", `${manifest().versions.length} kept`);
		const oldSearch = await search(operatorToken, { query: `alpha${tag}`, limit: 10 });
		const oldResults: unknown = oldSearch.json.results;
		const oldTexts = JSON.stringify(Array.isArray(oldResults) ? oldResults : []);
		check(!oldTexts.includes(`alpha${tag}`), "a search no longer sees the fallen-out version");
		const currentSearch = await search(operatorToken, { query: `vv5${tag}`, limit: 10 });
		const currentResults: unknown = currentSearch.json.results;
		const currentList: unknown[] = Array.isArray(currentResults) ? currentResults : [];
		const current: unknown = currentList[0];
		const currentCommit = typeof current === "object" && current !== null && "commit" in current ? current.commit : undefined;
		check(currentCommit === commits[5], "a search sees the current version's sections", String(currentCommit));
		// The fake still holds the kept older versions and returns their
		// chunks, and the as-built product enforces current-only by deletion:
		// fallen-out documents are deleted from RAGFlow, kept superseded
		// ones still resolve. So every hit must belong to a kept version —
		// never the fallen-out round 0, never a foreign commit.
		const kept = new Set(commits.slice(1));
		const noFallenOut = currentList.every((entry) =>
			typeof entry === "object" && entry !== null && "commit" in entry && typeof entry.commit === "string" && kept.has(entry.commit),
		);
		check(currentList.length >= 1 && noFallenOut, "no fallen-out version leaks through the search");

		// ── e. limit, fields, snippet cap, untrusted ─────────────────────
		for (const name of ["s1", "s2"]) {
			const sha = commit();
			await ingest(operatorToken, {
				dataset: DATASET,
				source_url: sourceUrl(`smoke-${tag}/${name}.md`, sha),
				commit: sha,
				content: `# ${name} ${tag}\n\nShared searchable-${tag} marker in ${name}.\n`,
			});
		}
		const shaLong = commit();
		await ingest(operatorToken, {
			dataset: DATASET,
			source_url: sourceUrl(`smoke-${tag}/long.md`, shaLong),
			commit: shaLong,
			content: `# Long ${tag}\n\n${`lorem searchable-${tag} `.repeat(120)}\n`,
		});
		const limited = await search(operatorToken, { query: `searchable-${tag}`, limit: 2 });
		const limitedRaw: unknown = limited.json.results;
		const limitedResults: unknown[] = Array.isArray(limitedRaw) ? limitedRaw : [];
		check(limitedResults.length === 2, "a search honours limit", `${limitedResults.length} results`);
		const fieldsOk = limitedResults.every((result) => {
			if (typeof result !== "object" || result === null) return false;
			const ids: unknown = "ids" in result ? result.ids : undefined;
			const idsOk = typeof ids === "object" && ids !== null &&
				"dataset_id" in ids && typeof ids.dataset_id === "string" &&
				"document_id" in ids && typeof ids.document_id === "string" &&
				"chunk_id" in ids && typeof ids.chunk_id === "string";
			return "title" in result && typeof result.title === "string" &&
				"source_url" in result && typeof result.source_url === "string" &&
				"heading_path" in result && Array.isArray(result.heading_path) &&
				"commit" in result && typeof result.commit === "string" &&
				"snippet" in result && typeof result.snippet === "string" && result.snippet.length <= 1200 &&
				"score" in result && typeof result.score === "number" && idsOk;
		});
		check(fieldsOk, "every result carries the DOCS-01 fields with a snippet of at most 1200 characters");
		check(limited.json.untrusted === true && typeof limited.json.notice === "string", "the reply is marked untrusted with its notice");

		// ── f. fake failure modes map to reasons ─────────────────────────
		setMode({ mode: "timeout", sleepMs: 8000 });
		const timedOut = await search(operatorToken, { query: "anything" });
		check(
			Array.isArray(timedOut.json.results) && timedOut.json.results.length === 0 && timedOut.json.reason === "ragflow-timeout",
			"a fake timeout answers results:[] with ragflow-timeout",
			String(timedOut.json.reason),
		);
		setMode({ mode: "error", code: 102, message: "fixture error" });
		const errored = await search(operatorToken, { query: "anything" });
		check(
			Array.isArray(errored.json.results) && errored.json.results.length === 0 && errored.json.reason === "ragflow-error",
			"a fake error code answers results:[] with ragflow-error",
			String(errored.json.reason),
		);
		setMode({ mode: "malformed" });
		const malformed = await search(operatorToken, { query: "anything" });
		check(
			Array.isArray(malformed.json.results) && malformed.json.results.length === 0 && malformed.json.reason === "ragflow-bad-response",
			"malformed JSON answers results:[] with ragflow-bad-response",
			String(malformed.json.reason),
		);
		setMode({ mode: "normal" });
		const recovered = await search(operatorToken, { query: `searchable-${tag}`, limit: 1 });
		const recoveredRaw: unknown = recovered.json.results;
		check(Array.isArray(recoveredRaw) && recoveredRaw.length === 1, "the fake recovers without a restart");

		// ── g. events and audit ──────────────────────────────────────────
		const queried = await fetch(`${base}/events/query`, {
			method: "POST",
			headers: headers(operatorToken),
			body: JSON.stringify({ session_id: session, limit: 200, include_payload: true }),
		});
		const queriedBody: unknown = await queried.json();
		const queriedEvents: unknown = typeof queriedBody === "object" && queriedBody !== null && "events" in queriedBody ? queriedBody.events : undefined;
		const events = (Array.isArray(queriedEvents) ? queriedEvents : []).filter(isLedgerEvent);
		const searches = events.filter((event) => event.payload.action === "docs.search");
		const ingests = events.filter((event) => event.payload.action === "docs.ingest");
		const searchNotes = searches.filter((event) => event.kind === "note");
		check(searchNotes.length >= 1, "a docs.search note is on the trail", `${searchNotes.length} notes`);
		const urlsRaw: unknown = searchNotes[0]?.payload.urls;
		const urls: unknown[] = Array.isArray(urlsRaw) ? urlsRaw : [];
		check(urls.length >= 1 && urls.every((url) => typeof url === "string"), "the search note lists the returned URLs", `${urls.length} urls`);
		check(searches.some((event) => event.kind === "warning" && typeof event.payload.reason === "string"), "search failures are warnings carrying a reason");
		check(ingests.some((event) => event.kind === "note" && event.payload.status === "uploaded"), "a docs.ingest uploaded note is on the trail");
		check(ingests.some((event) => event.kind === "warning" && event.payload.status === "refused"), "ingest refusals are warnings on the trail");
		check(ingests.every((event) => typeof event.surface === "string" && event.surface.length > 0), "every ingest event is attributed to a token surface");

		const auditPath = join(runDir, "mcp-audit.jsonl");
		const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
		const auditRecords = audit.split("\n").filter(Boolean).map((line): { tool: unknown; transport: unknown } => {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null) return { tool: undefined, transport: undefined };
			return {
				tool: "tool" in parsed ? parsed.tool : undefined,
				transport: "transport" in parsed ? parsed.transport : undefined,
			};
		});
		const searches_audited = auditRecords.filter((record) => record.tool === "docs_search");
		const ingests_audited = auditRecords.filter((record) => record.tool === "docs_ingest");
		check(searches_audited.length >= 1 && ingests_audited.length >= 1, "the audit file holds docs_search and docs_ingest records", `${searches_audited.length + ingests_audited.length} records`);
		check(
			auditRecords.some((record) => (record.tool === "docs_search" || record.tool === "docs_ingest") && record.transport === "rest") &&
				auditRecords.some((record) => record.tool === "docs_ingest" && record.transport === "mcp"),
			"the audit file covers both transports",
		);

		// ── the planted secret is nowhere ────────────────────────────────
		const places: Array<[string, string]> = [
			["the route response", planted.text],
			["the MCP response", viaToolSecret.text],
			["the events", JSON.stringify(events)],
			["the audit file", audit],
			["the fake-RAGFlow state", readFileSync(fakeStatePath, "utf8")],
		];
		for (const [where, text] of places) check(!text.includes(secret) && !text.includes(secret.slice(8)), `the planted secret is not in ${where}`);
	} finally {
		try {
			setMode({ mode: "normal" });
		} catch {
			// The mode file lives or dies with the run dir; a failed reset
			// must not mask the proof's own verdict.
		}
		rmSync(scratch, { recursive: true, force: true });
	}

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} checks passed.\n`);
	return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
