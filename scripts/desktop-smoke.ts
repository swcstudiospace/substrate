#!/usr/bin/env bun
/**
 * Headless desktop_run proof for Phase 30 (DESK-05 / D30-16..D30-20).
 *
 * Run as `bun run smoke:desktop --name p30 [--surface omp] [--unlisted cursor]`
 * against the Phase 16 rehearsal harness
 * (`bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp`).
 * It drives one scripted MCP session over the twin's `/mcp` endpoint with the
 * allowlisted surface's harness token — no model, no quota — types a
 * nonce-coloured marker band into a fresh terminal on the live
 * `substrate-desktop` container, and checks the D30-19 battery:
 *
 * - the returned image block holds >= 1500 pixels of the exact nonce RGB
 *   forming one solid rectangle, and the baseline holds none (D30-17);
 * - each block's sha256 equals the stored file and the event's sha256;
 * - one stored `tool.call` per executed action under `desktop:<run_id>`,
 *   with `text_sha256` equal to the typed text's sha256 and no typed text
 *   or base64 prefix in any payload;
 * - the harness audit file holds the `desktop_run` record fail-closed with
 *   none of either;
 * - an unlisted surface's valid token is refused with no new event, no token
 *   is a 401, and the 6081 root without credentials is a 401;
 * - `recruitment-desktop` inspects identical before and after;
 * - `substrate-desktop.sh status` shows the loopback port, unprivileged,
 *   no socket and the desktop label.
 *
 * The twin's URL and bearers come only from the named instance's
 * `consumer.env` (`${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/`) plus
 * the harness `tokens/<surface>` files; there is no default URL and the
 * process environment is never read for a URL or a bearer. `refuseSmokeUrl`
 * runs before any request, so a production port or a non-loopback host exits
 * 2 with zero requests sent. Reports carry hashes, sizes, counts and
 * booleans only — never a bearer, a password or typed text.
 *
 * The MCP session speaks raw JSON-RPC over fetch (the in-repo script
 * precedent, `scripts/vocabulary-smoke.ts`): bare workspace dependencies do
 * not resolve from `scripts/`, and this avoids lockfile churn for a package
 * the server already pins. The tool-call timeout is the run timeout plus
 * 60 s, above the 120 s run ceiling (D30-16).
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 precondition refused
 * (no consumer.env, a refused target, missing token files, an unreachable
 * twin, or a docker endpoint that cannot be proven local: a failed, timed-out
 * or empty `docker context inspect` refuses, it never proceeds). A stale or
 * absent band is a FAIL line, never a pass (D30-18).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAuditRecord } from "../packages/audit/src/record.ts";
import { decodePng } from "../packages/mcp-server/src/desktop/png.ts";
import { RehearsalRefused, parseShellExports, refuseDockerEndpoint, refuseSmokeUrl, runDirFor } from "./rehearsal.ts";

/** Smoke flags: the harness instance plus the listed and unlisted surfaces. */
export interface SmokeOptions {
	name: string;
	surface: string;
	unlisted: string;
}

/** Parse `--name/--surface/--unlisted`; anything else is a refusal. */
export function parseSmokeArgs(argv: string[]): SmokeOptions {
	let name = "p30";
	let surface = "omp";
	let unlisted = "cursor";
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--name" || token === "--surface" || token === "--unlisted") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new RehearsalRefused(`${token} needs a value`);
			if (token === "--name") name = value;
			else if (token === "--surface") surface = value;
			else unlisted = value;
			i++;
		} else if (token.startsWith("--")) {
			throw new RehearsalRefused(`unknown option ${token}`);
		} else {
			throw new RehearsalRefused(`unexpected argument ${token}`);
		}
	}
	return { name, surface, unlisted };
}

/** Lowercase hex sha256, the only content-derived value the smoke prints. */
export function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * True when a JSON dump (ledger rows) or the JSONL audit text holds typed
 * text. Dumps escape newlines and backslashes, so the raw marker — which ends
 * in a real newline — never appears verbatim even when stored: compare the
 * JSON-escaped form instead.
 */
export function dumpedHoldsTyped(dumped: string, typed: string[]): boolean {
	return typed.some((text) => dumped.includes(JSON.stringify(text).slice(1, -1)));
}

/** An RGB colour derived from the run nonce, readable in `R,G,B` numbers. */
export interface NonceRgb {
	r: number;
	g: number;
	b: number;
}

/**
 * Derive the marker colour from the nonce digest. One channel is forced at
 * or above 0xC0 so the colour cannot hide in the dark wallpaper (D30-17).
 */
export function nonceRgb(nonce: string): NonceRgb {
	const digest = createHash("sha256").update(nonce).digest();
	let r = digest[0] ?? 0;
	let g = digest[1] ?? 0;
	let b = digest[2] ?? 0;
	if (Math.max(r, g, b) < 0xc0) {
		if (r >= g && r >= b) r = 0xc0;
		else if (g >= b) g = 0xc0;
		else b = 0xc0;
	}
	return { r, g, b };
}

/**
 * The typed marker: a shell `printf` whose `\033`/`\n` sequences are typed as
 * backslash characters (no control characters, so `DesktopRunInput`
 * `TYPEABLE` accepts the text) plus one trailing real newline that presses
 * Return. The band it paints is `%48s` of the nonce RGB; the trailing comment
 * names the run and is inert under interactive comments.
 */
export function markerText(nonce: string, rgb: NonceRgb): string {
	return String.raw`printf '\033[48;2;${rgb.r};${rgb.g};${rgb.b}m%48s\033[0m\n' ''  # substrate-smoke-${nonce}` + "\n";
}

/** The bounding box of an exact-RGB pixel set, or null when it is empty. */
export interface BandRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** What `findBand` found: the pixel count, its box, and rectangle solidity. */
export interface BandResult {
	count: number;
	rect: BandRect | null;
	solid: boolean;
}

/**
 * Count pixels exactly equal to `color` and check they form one solid
 * rectangle (count equals the bounding-box area). Exact RGB only: the Xvfb
 * capture path is bit-exact (identity colormap, no compositing), so a
 * near-match would prove a different colour.
 */
export function findBand(rgb: Buffer, width: number, height: number, color: NonceRgb): BandResult {
	let count = 0;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3;
			if (rgb[at] === color.r && rgb[at + 1] === color.g && rgb[at + 2] === color.b) {
				count++;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (count === 0) return { count: 0, rect: null, solid: false };
	const rect: BandRect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
	return { count, rect, solid: count === rect.w * rect.h };
}

/**
 * A response body as JSON, else the last SSE data frame, else null. The
 * stateless twin answers `POST /mcp` either way.
 */
export function parseRpcBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the SSE framing.
	}
	const frames = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	for (const frame of frames.reverse()) {
		try {
			return JSON.parse(frame);
		} catch {
			// Not this frame.
		}
	}
	return null;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** Whole-run deadline seconds for the marker run (D30-05: 1..120). */
const RUN_TIMEOUT_S = 120;
/** Tool-call timeout: the run ceiling plus 60 s, never the 60 s default (D30-16). */
const RUN_CALL_TIMEOUT_MS = (RUN_TIMEOUT_S + 60) * 1000;
/** Screenshot-only refusal probe: a short run, same plus-60 s rule. */
const PROBE_CALL_TIMEOUT_MS = (30 + 60) * 1000;
/** Spawn bound for local `docker`/`bash` calls: fixed argv, no shell. */
const SPAWN_TIMEOUT_MS = 30_000;
/** The marker band pass threshold (D30-17). */
const BAND_MIN_PIXELS = 1500;
/**
 * Marker-run attempts: the nonce colour may already paint the desktop — one
 * matching pixel in a panel or window fails the baseline check even when the
 * marker typed and painted correctly — so a polluted baseline retries with a
 * fresh nonce instead of failing the proof.
 */
const MAX_NONCE_ATTEMPTS = 3;

/** True while another nonce is worth trying after a polluted baseline. */
export function shouldRetryNonce(baselineCount: number, attempt: number, logClean: boolean): boolean {
	// A failed closing `type "exit"` still returns a normal reply: retrying on
	// colour would let a later success mask the terminal left open, so only a
	// fully successful attempt earns another nonce.
	return baselineCount !== 0 && logClean && attempt < MAX_NONCE_ATTEMPTS;
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** One bearer file from the harness tokens dir; missing or empty refuses. */
function readTokenFile(path: string, name: string, surface: string): string {
	const text = readText(path);
	const bearer = (text ?? "").trim();
	if (bearer === "") throw new RehearsalRefused(`no harness token for surface ${surface} in instance ${name}`);
	return bearer;
}

interface Spawned {
	ok: boolean;
	out: string;
	err: string;
}

/**
 * One local subprocess call: fixed argv, no shell, bounded, with an explicit
 * env of PATH and HOME only — never the inherited tokens.
 */
function runArgv(argv: string[], timeoutMs: number): Spawned {
	const env: Record<string, string> = {};
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
	try {
		const run = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env });
		return { ok: run.exitCode === 0, out: run.stdout.toString(), err: run.stderr.toString() };
	} catch (cause) {
		return { ok: false, out: "", err: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** `recruitment-desktop` is inspect-only for the whole proof (T-30-12). */
const RECRUITMENT_INSPECT = [
	"docker",
	"container",
	"inspect",
	"--format",
	"{{.Id}} {{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}}",
	"recruitment-desktop",
] as const;

function inspectRecruitment(): string | null {
	const run = runArgv([...RECRUITMENT_INSPECT], SPAWN_TIMEOUT_MS);
	if (!run.ok) return null;
	return run.out.trim();
}

/** The same endpoint read the lifecycle script and the desktop driver use. */
const DOCKER_ENDPOINT_PROBE = ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] as const;
/** A hung docker client must not hang the smoke: the probe is bounded. */
const LOCALITY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Refuse unless the probe PROVES a local unix socket. A probe that failed or
 * timed out, or that answered nothing, proves nothing, so it refuses instead
 * of letting the smoke drive a possibly remote engine. Returns the reason, or
 * null when the endpoint is local.
 */
export function refuseUnprovenDockerLocality(probe: { ok: boolean; out: string }): string | null {
	if (!probe.ok) return "could not prove the local docker endpoint: the docker context probe failed or timed out; refusing";
	return refuseDockerEndpoint(probe.out);
}

/** `status` key=value lines from the lifecycle script, run from this checkout. */
function desktopStatus(): Record<string, string> | null {
	const script = join(import.meta.dir, "..", "infra", "desktop", "substrate-desktop.sh");
	const run = runArgv(["bash", script, "status"], SPAWN_TIMEOUT_MS);
	if (!run.ok) return null;
	const out: Record<string, string> = {};
	for (const line of run.out.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

interface HttpAttempt {
	status: number | null;
	text: string;
}

async function postJson(url: string, token: string, body: unknown, timeoutMs: number): Promise<HttpAttempt> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { status: res.status, text: await res.text() };
	} catch (cause) {
		return { status: null, text: cause instanceof Error ? cause.message : String(cause) };
	}
}

async function getStatus(url: string, token: string, timeoutMs: number): Promise<number | null> {
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
		await res.arrayBuffer();
		return res.status;
	} catch {
		return null;
	}
}

/** One MCP `content` block: text carries the run JSON, image the PNG bytes. */
interface ToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** A parsed `tools/call` result: an error flag plus the content blocks. */
interface ToolReply {
	isError: boolean;
	content: ToolContent[];
}

interface ToolCall {
	status: number | null;
	reply: ToolReply | null;
	rpcError: string | null;
}

/** Read one `content` block's string fields after proving each is a string. */
function readBlock(block: unknown): ToolContent | null {
	if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
	if (!("type" in block) || typeof block.type !== "string") return null;
	const item: ToolContent = { type: block.type };
	if ("text" in block && typeof block.text === "string") item.text = block.text;
	if ("data" in block && typeof block.data === "string") item.data = block.data;
	if ("mimeType" in block && typeof block.mimeType === "string") item.mimeType = block.mimeType;
	return item;
}

async function callTool(
	base: string,
	bearer: string,
	id: number,
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<ToolCall> {
	const attempt = await postJson(`${base}/mcp`, bearer, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, timeoutMs);
	if (attempt.status === null) return { status: null, reply: null, rpcError: attempt.text };
	const body: unknown = parseRpcBody(attempt.text);
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { status: attempt.status, reply: null, rpcError: "unparseable tool reply" };
	}
	if ("error" in body && body.error !== undefined) {
		const err: unknown = body.error;
		const message =
			err !== null && typeof err === "object" && !Array.isArray(err) && "message" in err && typeof err.message === "string"
				? err.message
				: "tool rpc error";
		return { status: attempt.status, reply: null, rpcError: message };
	}
	if (!("result" in body)) return { status: attempt.status, reply: null, rpcError: "tool reply has no result" };
	const result: unknown = body.result;
	if (result === null || typeof result !== "object" || Array.isArray(result)) {
		return { status: attempt.status, reply: null, rpcError: "tool reply has no result object" };
	}
	if (!("content" in result) || !Array.isArray(result.content)) {
		return { status: attempt.status, reply: null, rpcError: "tool reply has no content array" };
	}
	const content: ToolContent[] = [];
	for (const block of result.content) {
		const item = readBlock(block);
		if (item === null) return { status: attempt.status, reply: null, rpcError: "tool reply holds a malformed block" };
		content.push(item);
	}
	const isError = "isError" in result && result.isError === true;
	return { status: attempt.status, reply: { isError, content }, rpcError: null };
}

/** One stored screenshot: the reply's metadata plus the block's PNG bytes. */
interface StoredShot {
	path: string;
	sha256: string;
	image: Buffer;
}

/** A ledger row with only the fields the smoke compares. */
interface LedgerRow {
	id: unknown;
	session_id: unknown;
	kind: unknown;
	surface: unknown;
	payload?: unknown;
}

/** Read one ledger row's compared fields after proving each is present. */
function readRow(row: unknown): LedgerRow | null {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
	if (!("id" in row) || !("session_id" in row) || !("kind" in row) || !("surface" in row)) return null;
	const out: LedgerRow = { id: row.id, session_id: row.session_id, kind: row.kind, surface: row.surface };
	if ("payload" in row) out.payload = row.payload;
	return out;
}

async function querySession(base: string, bearer: string, session: string): Promise<LedgerRow[] | null> {
	const attempt = await postJson(
		`${base}/events/query`,
		bearer,
		{ session_id: session, include_payload: true, limit: 100, order: "asc" },
		REQUEST_TIMEOUT_MS,
	);
	if (attempt.status !== 200) return null;
	const body: unknown = parseRpcBody(attempt.text);
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	if (!("events" in body) || !Array.isArray(body.events)) return null;
	const rows: LedgerRow[] = [];
	for (const row of body.events) {
		const item = readRow(row);
		if (item === null) return null;
		rows.push(item);
	}
	return rows;
}

/**
 * Ids of every stored `desktop_run` tool.call for one surface, oldest first.
 * The refusal probe must prove no new event anywhere: a mistakenly run action
 * would carry a fresh run id, hence a different session, so re-querying the
 * marker session alone would miss it.
 */
async function queryDesktopIds(base: string, bearer: string, surface: string): Promise<string[] | null> {
	const attempt = await postJson(
		`${base}/events/query`,
		bearer,
		{ surface, kind: "tool.call", include_payload: true, limit: 100, order: "asc" },
		REQUEST_TIMEOUT_MS,
	);
	if (attempt.status !== 200) return null;
	const body: unknown = parseRpcBody(attempt.text);
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	if (!("events" in body) || !Array.isArray(body.events)) return null;
	const ids: string[] = [];
	for (const row of body.events) {
		const item = readRow(row);
		if (item === null) return null;
		const payload: unknown = item.payload;
		if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "tool" in payload && payload.tool === "desktop_run") {
			ids.push(String(item.id));
		}
	}
	return ids;
}

/** Read one screenshot entry's path and sha after proving each field. */
function readShot(entry: unknown): { path: string; sha256: string } | null {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
	if (!("path" in entry) || typeof entry.path !== "string") return null;
	if (!("sha256" in entry) || typeof entry.sha256 !== "string") return null;
	if (!("width" in entry) || typeof entry.width !== "number") return null;
	if (!("height" in entry) || typeof entry.height !== "number") return null;
	return { path: entry.path, sha256: entry.sha256 };
}

/** The run JSON the tool answers as its text block (images travel separately). */
function readRunText(raw: string): { runId: string; shots: unknown[]; log: unknown[] } {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { runId: "", shots: [], log: [] };
	const runId = "run_id" in parsed && typeof parsed.run_id === "string" ? parsed.run_id : "";
	const shots = "screenshots" in parsed && Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
	const log = "log" in parsed && Array.isArray(parsed.log) ? parsed.log : [];
	return { runId, shots, log };
}

/** One marker run plus its decoded band evidence, before any verdict. */
interface MarkerAttempt {
	replyOk: boolean;
	rpcError: string | null;
	marker: string;
	exitText: string;
	actionCount: number;
	text: { runId: string; shots: unknown[]; log: unknown[] };
	stored: StoredShot[];
	decoded: boolean;
	band: BandResult;
	baseline: BandResult;
	blockSizes: string;
}

/** Run the marker once with a fresh nonce and decode both blocks. */
async function markerAttempt(base: string, bearer: string): Promise<MarkerAttempt> {
	const nonce = randomBytes(4).toString("hex");
	const rgb = nonceRgb(nonce);
	const marker = markerText(nonce, rgb);
	const exitText = "exit\n";
	process.stdout.write(`marker nonce ${nonce} rgb ${rgb.r},${rgb.g},${rgb.b} marker ${marker.length} chars\n`);

	const run = {
		actions: [
			{ type: "screenshot" },
			{ type: "key", keys: "ctrl+alt+t", settle_ms: 5000 },
			{ type: "type", text: marker, settle_ms: 1500 },
			{ type: "screenshot" },
			{ type: "type", text: exitText },
		],
		timeout: RUN_TIMEOUT_S,
	};
	const call = await callTool(base, bearer, 1, "desktop_run", run, RUN_CALL_TIMEOUT_MS);
	const empty: MarkerAttempt = {
		replyOk: false,
		rpcError: call.rpcError,
		marker,
		exitText,
		actionCount: run.actions.length,
		text: { runId: "", shots: [], log: [] },
		stored: [],
		decoded: false,
		band: { count: 0, rect: null, solid: false },
		baseline: { count: 0, rect: null, solid: false },
		blockSizes: "no blocks",
	};
	if (call.reply === null || call.reply.isError) return empty;
	const textBlock = call.reply.content.find((block) => block.type === "text");
	const imageBlocks = call.reply.content.filter((block) => block.type === "image" && typeof block.data === "string");
	const text = readRunText(textBlock?.text ?? "null");

	const stored: StoredShot[] = [];
	for (const entry of text.shots) {
		if (stored.length >= 2) break;
		const shot = readShot(entry);
		const block = imageBlocks[stored.length];
		if (shot === null || block?.data === undefined) break;
		let image: Buffer | null = null;
		try {
			image = Buffer.from(block.data, "base64");
		} catch {
			image = null;
		}
		if (image === null) break;
		stored.push({ path: shot.path, sha256: shot.sha256, image });
	}

	let band: BandResult = { count: 0, rect: null, solid: false };
	let baseline: BandResult = { count: 0, rect: null, solid: false };
	let decoded = false;
	let blockSizes = "no blocks";
	const firstStored = stored[0];
	const secondStored = stored[1];
	if (firstStored !== undefined && secondStored !== undefined) {
		blockSizes = `${firstStored.image.length}/${secondStored.image.length} bytes`;
		try {
			const first = decodePng(firstStored.image);
			const second = decodePng(secondStored.image);
			baseline = findBand(first.rgb, first.width, first.height, rgb);
			band = findBand(second.rgb, second.width, second.height, rgb);
			decoded = true;
		} catch {
			decoded = false;
		}
	}
	return { replyOk: true, rpcError: null, marker, exitText, actionCount: run.actions.length, text, stored, decoded, band, baseline, blockSizes };
}

export async function main(argv: string[]): Promise<number> {
	const opts = parseSmokeArgs(argv);
	const runDir = runDirFor(opts.name);
	const envText = readText(join(runDir, "consumer.env"));
	if (envText === null) throw new RehearsalRefused(`no consumer.env for instance ${opts.name}: run rehearsal up first`);
	const record = parseShellExports(envText);
	const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	if (!base) throw new RehearsalRefused(`consumer.env for ${opts.name} has no twin url`);
	const refused = refuseSmokeUrl(base);
	if (refused !== null) throw new RehearsalRefused(refused);
	const tokensDir = record["SUBSTRATE_REHEARSAL_TOKENS_DIR"] ?? "";
	if (!tokensDir) throw new RehearsalRefused(`consumer.env for ${opts.name} has no harness tokens dir`);
	const bearer = readTokenFile(join(tokensDir, opts.surface), opts.name, opts.surface);
	const unlistedBearer = readTokenFile(join(tokensDir, opts.unlisted), opts.name, opts.unlisted);

	const results: boolean[] = [];
	const check = (ok: boolean, what: string, detail?: string): void => {
		results.push(ok);
		process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
	};
	process.stdout.write(`\n[desktop-smoke] ${opts.name} surface ${opts.surface} unlisted ${opts.unlisted}\n\n`);

	// Every docker call below (the recruitment inspect and the lifecycle script's
	// status) must hit the local engine, and the smoke types into a live
	// desktop: refuse before any request unless the endpoint is proven local.
	const locality = refuseUnprovenDockerLocality(runArgv([...DOCKER_ENDPOINT_PROBE], LOCALITY_PROBE_TIMEOUT_MS));
	if (locality !== null) throw new RehearsalRefused(locality);

	const health = await getStatus(`${base}/healthz`, bearer, REQUEST_TIMEOUT_MS);
	if (health !== 200) throw new RehearsalRefused(`twin at ${base} is not answering /healthz`);

	const before = inspectRecruitment();
	check(before !== null, "recruitment-desktop inspect before", before === null ? "inspect failed" : `${before.length} bytes read`);

	const status = desktopStatus();
	check(status !== null, "substrate-desktop.sh status answers", status === null ? "status failed" : `${Object.keys(status).length} keys`);

	let chosen: MarkerAttempt | null = null;
	let rpcError: string | null = null;
	for (let attempt = 1; attempt <= MAX_NONCE_ATTEMPTS; attempt++) {
		const current = await markerAttempt(base, bearer);
		if (!current.replyOk) {
			rpcError = current.rpcError;
			break;
		}
		chosen = current;
		const logClean =
			current.text.log.length === current.actionCount &&
			current.text.log.every((entry) => typeof entry === "object" && entry !== null && "ok" in entry && entry.ok === true);
		if (!shouldRetryNonce(current.baseline.count, attempt, logClean)) break;
		process.stdout.write(`nonce colour already on screen (baseline ${current.baseline.count}); retrying with a fresh nonce\n`);
	}
	check(chosen !== null, "marker run accepted", chosen === null ? (rpcError ?? "no reply") : "run answered");
	if (chosen === null) {
		const passed = results.filter(Boolean).length;
		process.stdout.write(`\n${passed}/${results.length} smoke checks passed\n`);
		return 1;
	}
	const { text, stored, decoded, band, baseline, blockSizes, marker, exitText, actionCount } = chosen;
	check(text.runId !== "" && text.shots.length === 2 && text.log.length === actionCount, "run text names id plus 2 shots and 5 log entries", `shots ${text.shots.length} log ${text.log.length}`);
	// The reply log must show every planned action succeeded: a failed final
	// `type "exit"` still stores its event and returns both screenshots, so the
	// events check alone would pass with the terminal left open.
	const logOk =
		text.log.length === actionCount &&
		text.log.every((entry) => typeof entry === "object" && entry !== null && "ok" in entry && entry.ok === true);
	check(logOk, "every planned action reports ok in the run log", `${text.log.length}/${actionCount} entries`);

	check(stored.length === 2, "both image blocks decode from base64", `${stored.length}/2`);

	check(decoded, "both blocks decode as PNG", blockSizes);
	check(
		decoded && band.count >= BAND_MIN_PIXELS && band.solid && baseline.count === 0,
		"band in returned block, none in baseline",
		decoded ? `band ${band.count} ${band.rect === null ? "no-rect" : `${band.rect.w}x${band.rect.h}`} solid ${band.solid} baseline ${baseline.count}` : "no pixels",
	);

	for (const [i, shot] of stored.entries()) {
		let fileBytes: Buffer | null = null;
		try {
			fileBytes = readFileSync(shot.path);
		} catch {
			fileBytes = null;
		}
		const blockSha = sha256Hex(shot.image);
		check(blockSha === shot.sha256, `shot ${i} block sha equals reply sha`, `${blockSha.slice(0, 12)}…`);
		check(fileBytes !== null && sha256Hex(fileBytes) === shot.sha256, `shot ${i} stored file equals reply sha`, fileBytes === null ? "file unreadable" : `${fileBytes.length} bytes`);
	}

	const session = `desktop:${text.runId}`;
	const rows = text.runId === "" ? null : await querySession(base, bearer, session);
	const typed = [marker, exitText];
	// The expected digest per action index: type actions name the exact typed
	// text's sha, screenshots the verified block's sha — never any hash from
	// the run, and each row must match its own index.
	const expectedDigest: Array<{ action: string; sha: string | null }> = [
		{ action: "screenshot", sha: stored[0]?.sha256 ?? null },
		{ action: "key", sha: null },
		{ action: "type", sha: sha256Hex(marker) },
		{ action: "screenshot", sha: stored[1]?.sha256 ?? null },
		{ action: "type", sha: sha256Hex(exitText) },
	];
	let eventsOk = false;
	if (rows !== null && rows.length === actionCount && stored.length === 2) {
		eventsOk = rows.every((row, i) => {
			if (row.kind !== "tool.call" || row.session_id !== session || row.surface !== opts.surface) return false;
			const payload: unknown = row.payload;
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
			if (!("tool" in payload) || payload.tool !== "desktop_run") return false;
			if (!("run_id" in payload) || payload.run_id !== text.runId) return false;
			if (!("i" in payload) || payload.i !== i) return false;
			// A failed final `type "exit"` still stores its event: the smoke must
			// not pass with the terminal left open.
			if (!("ok" in payload) || payload.ok !== true) return false;
			const expected = expectedDigest[i];
			if (expected === undefined || !("action" in payload) || payload.action !== expected.action) return false;
			if (expected.action === "type" && "text_sha256" in payload && typeof payload.text_sha256 === "string") {
				return payload.text_sha256 === expected.sha;
			}
			if (expected.action === "screenshot" && "sha256" in payload && typeof payload.sha256 === "string") {
				return payload.sha256 === expected.sha;
			}
			return expected.action === "key";
		});
		const dumped = JSON.stringify(rows);
		if (dumpedHoldsTyped(dumped, typed) || dumped.includes("iVBOR")) eventsOk = false;
	}
	check(eventsOk, "one stored tool.call per action with hashes only", rows === null ? "query failed" : `${rows.length}/${actionCount} rows`);

	const idsBefore = await queryDesktopIds(base, bearer, opts.surface);
	const probe = await callTool(base, unlistedBearer, 2, "desktop_run", { actions: [{ type: "screenshot" }], timeout: 30 }, PROBE_CALL_TIMEOUT_MS);
	const probeText = probe.reply?.content.find((block) => block.type === "text")?.text ?? "";
	const probeRefused = probe.reply !== null && probe.reply.isError && probeText.includes("not enabled");
	check(probeRefused, "unlisted token refused", probe.reply === null ? (probe.rpcError ?? "no reply") : `isError ${probe.reply.isError}`);
	const idsAfter = await queryDesktopIds(base, bearer, opts.surface);
	const refusalClean =
		idsBefore !== null && idsAfter !== null && idsBefore.length === idsAfter.length && idsBefore.every((id, i) => idsAfter[i] === id);
	check(refusalClean, "refusal stored no new desktop event on the surface", idsBefore === null || idsAfter === null ? "query failed" : `${idsBefore.length}→${idsAfter.length} events`);

	const noToken = await postJson(`${base}/mcp`, "", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "desktop_run", arguments: { actions: [{ type: "screenshot" }] } } }, REQUEST_TIMEOUT_MS);
	check(noToken.status === 401, "no token 401", `status ${noToken.status ?? "unreachable"}`);

	check((await getStatus("http://127.0.0.1:6081/", "", REQUEST_TIMEOUT_MS)) === 401, "6081 root without credentials 401", "no credentials sent");

	const after = inspectRecruitment();
	check(after !== null && after === before, "recruitment-desktop inspect identical after", after === null ? "inspect failed" : "id status timestamps equal");

	check(
		status !== null && status["ports"] === "127.0.0.1:6081->3000" && status["privileged"] === "false" && status["docker_socket_mounted"] === "false" && status["label_role"] === "desktop",
		"status shows loopback port, unprivileged, no socket, desktop label",
		status === null ? "no status" : `ports ${status["ports"] ?? "?"} privileged ${status["privileged"] ?? "?"} socket ${status["docker_socket_mounted"] ?? "?"} label ${status["label_role"] ?? "?"}`,
	);

	const auditText = readText(join(runDir, "mcp-audit.jsonl"));
	let auditBroken = true;
	let desktopCount = 0;
	if (auditText !== null) {
		auditBroken = false;
		for (const line of auditText.split("\n")) {
			if (!line.includes('"desktop_run"')) continue;
			desktopCount++;
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(line);
			} catch {
				auditBroken = true;
				continue;
			}
			if (!isAuditRecord(parsed) || parsed.tool !== "desktop_run" || parsed.mode !== "fail-closed") {
				auditBroken = true;
				continue;
			}
			if (!Array.isArray(parsed.arg_keys) || !parsed.arg_keys.every((key) => key === "actions" || key === "timeout")) auditBroken = true;
		}
		if (desktopCount === 0) auditBroken = true;
		if (dumpedHoldsTyped(auditText, typed) || auditText.includes("iVBOR")) auditBroken = true;
	}
	check(!auditBroken, "audit holds fail-closed desktop_run with no content", auditText === null ? "audit file unreadable" : `${desktopCount} desktop_run records`);

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} smoke checks passed\n`);
	return passed === results.length ? 0 : 1;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(cause) => {
			if (cause instanceof RehearsalRefused) {
				process.stderr.write(`[desktop-smoke] refused: ${cause.message}.\n`);
				process.exit(2);
			}
			throw cause;
		},
	);
}
