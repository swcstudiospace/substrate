#!/usr/bin/env bun
/**
 * Cache key census (`bun scripts/cache-stats.ts`), uplift-4 S4.
 *
 *   bun scripts/cache-stats.ts [--json] [--url <redis-url>] [--allow-remote]
 *                              [--keys N] [--wall-ms N] [--headroom N]
 *
 * Operator-run and read-only. It answers "what is in the loopback cache, how
 * big is it by key class, and what `maxmemory` does that justify" from the
 * server itself, so the 256 MB in `infra/vps/redis-substrate.conf` rests on a
 * measurement instead of eight keys.
 *
 * Invariants (the tests hold each one):
 * - Commands: `SCAN MATCH substrate:v1:* COUNT 200`, `TYPE`, `STRLEN`, `INFO
 *   memory`, `INFO stats`. Never `GET`/`MGET`/`HGETALL` (no value is read, so
 *   none can be printed), never `DEL`, `FLUSH*`, `EXPIRE`, `CONFIG` or `EVAL`.
 *   `STRLEN` only for a key whose `TYPE` is `string`; a hash (an admission
 *   bucket) or a counter is counted, not sized.
 * - Output names a key class and numbers, never a key and never a value.
 * - Bounded: at most `--keys` keys (default 5000) and `--wall-ms` of wall time
 *   (default 250) spent on the scan. `truncated` says which budget ended it; a
 *   truncated census is a lower bound and is labelled as one.
 * - Refuses a URL whose host is not loopback unless `--allow-remote` is given.
 *   The URL is read from `--url` or `DRAGONFLY_URL` in the process env (never
 *   from a file) and is never printed.
 */
import { RedisClient } from "bun";
import { doctorBearer } from "./doctor-runtime.ts";
import { CACHE_CLASSES, CACHE_PREFIX, classOf, type CacheKeyClass } from "../packages/mcp-server/src/cache.ts";

export const SCAN_COUNT = 200;
export const KEY_BUDGET = 5000;
export const WALL_BUDGET_MS = 250;
export const DEFAULT_HEADROOM = 4;
/** `TYPE`/`STRLEN` go out this many keys at a time, with the wall budget checked between chunks. */
const CHUNK = 50;
const MIB = 1024 * 1024;
const KNOWN_TYPES = ["string", "hash", "list", "set", "zset", "stream", "none"] as const;

/** The one method this script needs; Bun's `RedisClient` has it, a test passes a fake. */
export interface StatsClient {
	send(command: string, args: string[]): Promise<unknown>;
	close?(): void;
}

export type StatsClass = CacheKeyClass | "other";

export interface ClassStats {
	class: StatsClass;
	keys: number;
	/** Keys whose value length was read (`STRLEN`, string type only). */
	sized: number;
	/** Sum of the sized values' lengths in bytes. */
	bytes: number;
	maxBytes: number;
	p99Bytes: number;
	/** Count per Redis type; a type the script does not know is `other`. */
	types: Record<string, number>;
}

export interface Recommendation {
	/** Null when no string value was sized, so there is nothing to recommend from. */
	maxmemory: string | null;
	maxmemoryBytes: number | null;
	inputs: { p99Bytes: number; observedKeys: number; headroom: number; truncated: boolean };
	note: string;
}

/** The process-lifetime cache counters the running `substrate-mcp` reports on `/healthz`; null when it could not be read. */
export interface Ratios {
	hits: number;
	misses: number;
	bypasses: number;
	errors: number;
	coalesced: number | null;
	stale: number | null;
	wouldServeStale: number | null;
	refreshes: number | null;
	/** hits / (hits + misses); null before the first read. */
	hitRatio: number | null;
}

export interface Stats {
	scanned: number;
	truncated: "keys" | "wall" | null;
	wallMs: number;
	classes: ClassStats[];
	server: { usedMemoryBytes: number | null; maxmemoryBytes: number | null; maxmemoryPolicy: string | null; evictedKeys: number | null };
	recommendation: Recommendation;
	/** Filled by `main` from the loopback `/healthz`; `collectStats` leaves it null. */
	ratios: Ratios | null;
	/** Why `ratios` is null when that is known (a refused bearer); null otherwise. */
	ratiosNote: string | null;
}

export interface CollectOptions {
	now?: () => number;
	keyBudget?: number;
	wallBudgetMs?: number;
	scanCount?: number;
	headroom?: number;
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

function parseScan(reply: unknown): { cursor: string; keys: string[] } {
	if (!Array.isArray(reply) || reply.length < 2) throw new Error("unexpected SCAN reply");
	const keys = Array.isArray(reply[1]) ? reply[1].filter((key): key is string => typeof key === "string") : [];
	return { cursor: String(reply[0]), keys };
}

/** `field:value` lines of an INFO section. Only the named fields are kept. */
function infoFields(text: unknown, names: readonly string[]): Map<string, string> {
	const found = new Map<string, string>();
	if (typeof text !== "string") return found;
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const name = line.slice(0, at);
		if (names.includes(name)) found.set(name, line.slice(at + 1).trim());
	}
	return found;
}

function numberOrNull(raw: string | undefined): number | null {
	if (raw === undefined || raw === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** A command ran past the scan's wall budget. */
class WallExceeded extends Error {}

/** `work`, or `WallExceeded` once `remainingMs` has passed. The timer is unref'd and cleared on every path. */
function raceWall<T>(work: Promise<T>, remainingMs: number): Promise<T> {
	if (remainingMs <= 0) {
		work.catch(() => {});
		return Promise.reject(new WallExceeded());
	}
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new WallExceeded()), remainingMs);
	timer.unref?.();
	work.then(resolve, reject).finally(() => clearTimeout(timer));
	return promise;
}

async function info(client: StatsClient, section: string, names: readonly string[], budgetMs: number): Promise<Map<string, string>> {
	try {
		return infoFields(await raceWall(client.send("INFO", [section]), budgetMs), names);
	} catch {
		return new Map();
	}
}

/**
 * `p99 value bytes × observed keys × headroom`, rounded up to whole MiB. The
 * value length is `STRLEN`, so the per-key overhead of the server is inside
 * the headroom, not the product. A truncated census under-counts the keys.
 */
export function recommend(p99Bytes: number, observedKeys: number, headroom: number, truncated: boolean, sized: number): Recommendation {
	const inputs = { p99Bytes, observedKeys, headroom, truncated };
	if (sized === 0) {
		return { maxmemory: null, maxmemoryBytes: null, inputs, note: "no string value was sized, so there is nothing to recommend from" };
	}
	const bytes = Math.max(MIB, Math.ceil((p99Bytes * observedKeys * headroom) / MIB) * MIB);
	return {
		maxmemory: `${bytes / MIB}mb`,
		maxmemoryBytes: bytes,
		inputs,
		note: truncated
			? "census was truncated: observed keys is a lower bound, so this is a floor"
			: "value bytes only; server per-key overhead is inside the headroom",
	};
}

export async function collectStats(client: StatsClient, options: CollectOptions = {}): Promise<Stats> {
	const now = options.now ?? Date.now;
	const keyBudget = options.keyBudget ?? KEY_BUDGET;
	const wallBudgetMs = options.wallBudgetMs ?? WALL_BUDGET_MS;
	const scanCount = options.scanCount ?? SCAN_COUNT;
	const headroom = options.headroom ?? DEFAULT_HEADROOM;
	const started = now();

	const seen = new Set<string>();
	const sizes = new Map<StatsClass, number[]>();
	const keys = new Map<StatsClass, number>();
	const types = new Map<StatsClass, Record<string, number>>();
	let truncated: "keys" | "wall" | null = null;
	let cursor = "0";
	// Every command races what is left of the wall budget, so a server that stops answering ends the scan at the budget.
	const left = () => wallBudgetMs - (now() - started);

	try {
		scan: do {
			if (left() <= 0) {
				truncated = "wall";
				break;
			}
			const page = parseScan(await raceWall(client.send("SCAN", [cursor, "MATCH", `${CACHE_PREFIX}:*`, "COUNT", String(scanCount)]), left()));
			cursor = page.cursor;
			// SCAN may return a key more than once; a key is counted once.
			const fresh = [...new Set(page.keys)].filter((key) => !seen.has(key));
			for (let at = 0; at < fresh.length; at += CHUNK) {
				if (seen.size >= keyBudget) {
					truncated = "keys";
					break scan;
				}
				if (left() <= 0) {
					truncated = "wall";
					break scan;
				}
				const chunk = fresh.slice(at, at + Math.min(CHUNK, keyBudget - seen.size));
				const kinds = await raceWall(Promise.all(chunk.map((key) => client.send("TYPE", [key]).catch(() => "none"))), left());
				const lengths = await raceWall(
					Promise.all(
						chunk.map((key, index) =>
							kinds[index] === "string" ? client.send("STRLEN", [key]).then((value) => Number(value), () => Number.NaN) : Promise.resolve(Number.NaN),
						),
					),
					left(),
				);
				chunk.forEach((key, index) => {
					seen.add(key);
					const klass: StatsClass = classOf(key) ?? "other";
					keys.set(klass, (keys.get(klass) ?? 0) + 1);
					const kind = String(kinds[index]);
					const bucket = types.get(klass) ?? {};
					const typeName = (KNOWN_TYPES as readonly string[]).includes(kind) ? kind : "other";
					bucket[typeName] = (bucket[typeName] ?? 0) + 1;
					types.set(klass, bucket);
					const length = lengths[index] as number;
					if (Number.isFinite(length) && length >= 0) {
						const list = sizes.get(klass) ?? [];
						list.push(length);
						sizes.set(klass, list);
					}
				});
			}
			if (seen.size >= keyBudget && cursor !== "0") truncated = "keys";
		} while (cursor !== "0" && truncated === null);
	} catch (cause) {
		// A command that outlived the budget ends the census as truncated; any other failure is the server's and propagates.
		if (!(cause instanceof WallExceeded)) throw cause;
		truncated = "wall";
	}

	const classes: ClassStats[] = [];
	const everySize: number[] = [];
	for (const klass of [...CACHE_CLASSES, "other"] as StatsClass[]) {
		const count = keys.get(klass) ?? 0;
		if (count === 0) continue;
		const list = (sizes.get(klass) ?? []).slice().sort((a, b) => a - b);
		everySize.push(...list);
		classes.push({
			class: klass,
			keys: count,
			sized: list.length,
			bytes: list.reduce((total, value) => total + value, 0),
			maxBytes: list.at(-1) ?? 0,
			p99Bytes: percentile(list, 0.99),
			types: types.get(klass) ?? {},
		});
	}
	everySize.sort((a, b) => a - b);

	const memory = await info(client, "memory", ["used_memory", "maxmemory", "maxmemory_policy"], wallBudgetMs);
	const stats = await info(client, "stats", ["evicted_keys"], wallBudgetMs);
	return {
		scanned: seen.size,
		truncated,
		wallMs: now() - started,
		classes,
		server: {
			usedMemoryBytes: numberOrNull(memory.get("used_memory")),
			maxmemoryBytes: numberOrNull(memory.get("maxmemory")),
			maxmemoryPolicy: memory.get("maxmemory_policy") ?? null,
			evictedKeys: numberOrNull(stats.get("evicted_keys")),
		},
		recommendation: recommend(percentile(everySize, 0.99), seen.size, headroom, truncated !== null, everySize.length),
		ratios: null,
		ratiosNote: null,
	};
}

export function renderTable(stats: Stats): string {
	const rows = [["class", "keys", "sized", "bytes", "p99", "max", "types"]];
	for (const entry of stats.classes) {
		rows.push([
			entry.class,
			String(entry.keys),
			String(entry.sized),
			String(entry.bytes),
			String(entry.p99Bytes),
			String(entry.maxBytes),
			Object.entries(entry.types)
				.map(([name, count]) => `${name}:${count}`)
				.join(","),
		]);
	}
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
	const { recommendation: rec, server } = stats;
	lines.push(
		"",
		`scanned ${stats.scanned} keys in ${stats.wallMs} ms${stats.truncated ? ` (truncated: ${stats.truncated} budget)` : ""}`,
		`server: used_memory=${server.usedMemoryBytes ?? "?"} maxmemory=${server.maxmemoryBytes ?? "?"} policy=${server.maxmemoryPolicy ?? "?"} evicted_keys=${server.evictedKeys ?? "?"}`,
		`recommended maxmemory: ${rec.maxmemory ?? "none"}  = p99 ${rec.inputs.p99Bytes} B x ${rec.inputs.observedKeys} keys x headroom ${rec.inputs.headroom}`,
		`  ${rec.note}`,
		stats.ratios === null
			? (stats.ratiosNote ?? "ratios: unavailable (the running substrate-mcp /healthz was not read)")
			: `ratios (process lifetime, /healthz): hit ${stats.ratios.hits} miss ${stats.ratios.misses} bypass ${stats.ratios.bypasses} error ${stats.ratios.errors} coalesced ${stats.ratios.coalesced ?? "?"} stale ${stats.ratios.stale ?? "?"} would_serve_stale ${stats.ratios.wouldServeStale ?? "?"} refresh ${stats.ratios.refreshes ?? "?"} hit ratio ${stats.ratios.hitRatio === null ? "n/a" : stats.ratios.hitRatio.toFixed(3)}`,
	);
	return lines.join("\n");
}

/** Loopback only: `localhost`, `::1`, or an address in `127.0.0.0/8`. A DNS name that merely starts with `127.` is not. */
export function isLoopbackUrl(raw: string): boolean {
	let host: string;
	try {
		host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	} catch {
		return false;
	}
	if (host === "localhost" || host === "::1") return true;
	const octets = host.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** What `fetch` answers that this script reads. A test passes a fake. */
export type HealthzFetch = (
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

/** Said by name when `/healthz` refuses the request, instead of a silent null. */
export const HEALTHZ_AUTH_NOTE = "ratios unavailable: /healthz needs a bearer; set SUBSTRATE_TOKEN or SUBSTRATE_TOKEN_FILE";

const HEALTHZ_TIMEOUT_MS = 250;

function counter(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The cache counters from the loopback `/healthz`: one read-only GET with a short
 * timeout, with `Authorization: Bearer` when `bearer` is set (the server applies its
 * bearer check to `/healthz`). Null on any failure (not running, slow, not JSON, no cache
 * block), never an error; a 401/403 also calls `onUnavailable` with `HEALTHZ_AUTH_NOTE`.
 * The bearer goes only into the header: never a URL, never output.
 */
export async function fetchRatios(
	url: string,
	fetcher: HealthzFetch,
	timeoutMs = HEALTHZ_TIMEOUT_MS,
	bearer: string | null = null,
	onUnavailable?: (reason: string) => void,
): Promise<Ratios | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		const response = await fetcher(url, { signal: controller.signal, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) onUnavailable?.(HEALTHZ_AUTH_NOTE);
			return null;
		}
		const body = (await response.json()) as { cache?: Record<string, unknown> } | null;
		const cache = body?.cache;
		if (!cache || typeof cache !== "object") return null;
		const hits = counter(cache.hits);
		const misses = counter(cache.misses);
		const bypasses = counter(cache.bypasses);
		const errors = counter(cache.errors);
		if (hits === null || misses === null || bypasses === null || errors === null) return null;
		return {
			hits,
			misses,
			bypasses,
			errors,
			coalesced: counter(cache.coalesced),
			stale: counter(cache.stale),
			wouldServeStale: counter(cache.wouldServeStale),
			refreshes: counter(cache.refreshes),
			hitRatio: hits + misses === 0 ? null : hits / (hits + misses),
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

interface Parsed {
	json: boolean;
	url: string | undefined;
	healthzUrl: string;
	allowRemote: boolean;
	keys: number;
	wallMs: number;
	headroom: number;
	help: boolean;
}

function positive(raw: string | undefined, fallback: number, max: number): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : fallback;
}

function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Parsed {
	const parsed: Parsed = {
		json: false,
		url: env.DRAGONFLY_URL?.trim() || undefined,
		healthzUrl: `${(env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "")}/healthz`,
		allowRemote: false,
		keys: KEY_BUDGET,
		wallMs: WALL_BUDGET_MS,
		headroom: DEFAULT_HEADROOM,
		help: false,
	};
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		if (flag === "--json") parsed.json = true;
		else if (flag === "--allow-remote") parsed.allowRemote = true;
		else if (flag === "--help" || flag === "-h") parsed.help = true;
		else if (flag === "--url") parsed.url = argv[(at += 1)]?.trim() || undefined;
		else if (flag === "--keys") parsed.keys = positive(argv[(at += 1)], KEY_BUDGET, 100_000);
		else if (flag === "--wall-ms") parsed.wallMs = positive(argv[(at += 1)], WALL_BUDGET_MS, 10_000);
		else if (flag === "--healthz-url") parsed.healthzUrl = argv[(at += 1)]?.trim() || parsed.healthzUrl;
		else if (flag === "--headroom") parsed.headroom = positive(argv[(at += 1)], DEFAULT_HEADROOM, 100);
		// The argument is never echoed: a positional `redis://:password@host` must not reach the output.
		else throw new Error("unknown argument");
	}
	return parsed;
}

const USAGE =
	"usage: bun scripts/cache-stats.ts [--json] [--url <redis-url>] [--healthz-url <url>] [--allow-remote] [--keys N] [--wall-ms N] [--headroom N]";

export interface MainDeps {
	connect?: (url: string) => Promise<StatsClient>;
	now?: () => number;
	out?: (line: string) => void;
	fetch?: HealthzFetch;
	/** The bearer for `/healthz`; the default resolves it like the doctor (first entry of a token list, token file, tokens dir). */
	bearer?: (env: Record<string, string | undefined>) => string | null;
	err?: (line: string) => void;
}

async function connectBun(url: string): Promise<StatsClient> {
	const client = new RedisClient(url, { connectionTimeout: 250, idleTimeout: 0, autoReconnect: false, maxRetries: 0, enableOfflineQueue: false });
	await client.connect();
	return client;
}

/** Exit code: 0 printed, 1 the server could not be read, 2 usage or refused URL. */
export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env, deps: MainDeps = {}): Promise<number> {
	const out = deps.out ?? ((line: string) => console.log(line));
	const err = deps.err ?? ((line: string) => console.error(line));
	let args: Parsed;
	try {
		args = parseArgs(argv, env);
	} catch (cause) {
		err(`${cause instanceof Error ? cause.message : String(cause)}\n${USAGE}`);
		return 2;
	}
	if (args.help) {
		out(USAGE);
		return 0;
	}
	if (args.url === undefined) {
		err(`no cache URL: set DRAGONFLY_URL in the environment or pass --url\n${USAGE}`);
		return 2;
	}
	if (!args.allowRemote && !isLoopbackUrl(args.url)) {
		err("refusing a non-loopback cache URL; pass --allow-remote to read a remote server");
		return 2;
	}
	let client: StatsClient | null = null;
	try {
		client = await (deps.connect ?? connectBun)(args.url);
		const stats = await collectStats(client, { now: deps.now, keyBudget: args.keys, wallBudgetMs: args.wallMs, headroom: args.headroom });
		// The running service's own counters, only from a loopback URL unless the operator allowed remote reads.
		if (args.allowRemote || isLoopbackUrl(args.healthzUrl)) {
			const bearer = (deps.bearer ?? doctorBearer)(env);
			stats.ratios = await fetchRatios(args.healthzUrl, deps.fetch ?? ((url, init) => fetch(url, init)), HEALTHZ_TIMEOUT_MS, bearer, (reason) => {
				stats.ratiosNote = reason;
			});
		}
		out(args.json ? JSON.stringify(stats, null, 2) : renderTable(stats));
		return 0;
	} catch (cause) {
		// The URL can carry a password; the message never names it.
		err(`cache-stats failed: ${(cause instanceof Error ? cause.message : String(cause)).replace(/\b(?:redis|rediss):\/\/\S+/gi, "redis://<redacted>")}`);
		return 1;
	} finally {
		try {
			client?.close?.();
		} catch {
			// The socket is already gone.
		}
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
