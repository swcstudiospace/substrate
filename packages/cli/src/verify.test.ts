/**
 * `substrate verify` driven through the real CLI process.
 *
 * The command is spawned as `bun packages/cli/src/index.ts verify <graph>`
 * against an isolated loopback that serves verdicts computed by the
 * production `Substrate.verifyGraph` over local store rows and RPC answers —
 * never a handcrafted copy of the expected JSON. What is asserted is the
 * consumer contract from D28-19: exit codes, the hour naming the failure,
 * and which stream the line lands on. Roots, counts and signatures are
 * preserved through the shared verdict; their exact rendering beyond the
 * named lines is the CLI's business, not this test's.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { formatMemo, merkleRootHex } from "../../ledger/src/index.ts";
import { loadConfig } from "../../mcp-server/src/config.ts";
import { normalizeEvent } from "../../mcp-server/src/event.ts";
import { Substrate } from "../../mcp-server/src/service.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");
const H = Date.UTC(2026, 9, 1, 10);
const HOUR = 3_600_000;
const PUBKEY = "TestPubkey1111111111111111111111111111111";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** One closed hour of fixture: the store rows, the ingest records, and the digest they imply. */
interface HourWorld {
	hour: number;
	iso: string;
	rows: Array<Record<string, unknown>>;
	leaves: Array<{ event_id: string; ingested_at: number; hash: string }>;
	records: Array<{ event_id: string; event_ts: number; ingested_at: number }>;
	root: string;
	memo: string;
}

/** Two chained events in one closed hour, built through the real hash path. */
function buildHour(hour: number, session: string, graph: string): HourWorld {
	let prev: string | null = null;
	const events = [0, 1].map((i) => {
		const event = normalizeEvent(
			{ surface: "omp", kind: "note", summary: `cli-${hour}-${i}`, session_id: session, graph_id: graph, actor: "agent" },
			prev,
		);
		prev = event.hash;
		return event;
	});
	const root = merkleRootHex(events.map((event) => event.hash));
	return {
		hour,
		iso: new Date(hour).toISOString(),
		rows: events.map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) })),
		leaves: events.map((event, i) => ({ event_id: event.id, ingested_at: hour + 1000 * (i + 1), hash: event.hash })),
		records: events.map((event, i) => ({
			event_id: event.id,
			event_ts: Date.parse(event.ts),
			ingested_at: hour + 1000 * (i + 1),
		})),
		root,
		memo: formatMemo({ periodStartMs: hour, rootHex: root, count: events.length }),
	};
}

function anchorRow(hour: number, world: Pick<HourWorld, "root" | "memo">, txSig: string) {
	return {
		period_start: new Date(hour).toISOString(),
		period_end: new Date(hour + HOUR).toISOString(),
		root: world.root,
		event_count: 2,
		memo: world.memo,
		tx_sig: txSig,
		signer: PUBKEY,
		cluster: "devnet",
		slot: 42,
		anchored_at: new Date(hour + 5 * HOUR).toISOString(),
	};
}

function memoTx(memo: string) {
	return { memo, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 42, blockTime: null };
}

function stubGreptime(worlds: HourWorld[], anchors: Record<number, Record<string, unknown>>) {
	return {
		readEvents: async () => worlds.flatMap((world) => world.rows),
		graphIngest: async () => worlds.flatMap((world) => world.records),
		firstIngestMs: async () => H,
		hourLeaves: async (startMs: number) => {
			const found = worlds.find((world) => world.hour === startMs);
			if (!found) throw new Error(`no fixture hour for ${String(startMs)}`);
			return found.leaves;
		},
		anchorForPeriod: async (startMs: number) => anchors[startMs] ?? null,
	};
}

/** An isolated loopback whose /verify answers come from the real verifier. */
const closers: Array<() => void> = [];
afterAll(() => {
	for (const close of closers) close();
});

async function serveVerify(substrate: Substrate, rpc: unknown, now: number): Promise<string> {
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/verify") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			void (async () => {
				const parsed = JSON.parse(body) as { graph_id?: unknown };
				const verdict = await substrate.verifyGraph(String(parsed.graph_id), { rpc: rpc as never, now });
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(verdict));
			})();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

/**
 * Spawned asynchronously, not with `spawnSync`: the loopback under test
 * listens in this process, and a blocked event loop would starve it — the
 * command would report the substrate unreachable, a failure shaped exactly
 * like a broken CLI.
 */
async function run(args: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn(["bun", CLI, ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("substrate verify", () => {
	test("an intact chain with a mismatched anchor exits 1 naming that hour", async () => {
		const graph = "ut-cli-mismatch";
		const world = buildHour(H, "sess-cli-m", graph);
		// The events are untouched, so the per-session chain still verifies;
		// only the anchor's root disagrees with the recompute.
		const other = formatMemo({ periodStartMs: H, rootHex: "0".repeat(64), count: 2 });
		const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
			index: null,
			greptime: stubGreptime([world], { [H]: anchorRow(H, world, "sig-cli-mismatch") }) as never,
		});
		const rpc = { getGenesisHash: async () => GENESIS, transactionMemo: async () => memoTx(other) };
		const base = await serveVerify(substrate, rpc, H + 5 * HOUR);

		const result = await run(["verify", graph], { SUBSTRATE_URL: base, SUBSTRATE_VERIFY_TIMEOUT_MS: "10000" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(`chain intact for ${graph}`);
		expect(result.stdout).toContain(`hour ${world.iso} does not match its anchor:`);
	});

	test("an hour devnet cannot check exits 1 on stderr naming that hour", async () => {
		const graph = "ut-cli-unverified";
		const world = buildHour(H, "sess-cli-u", graph);
		const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
			index: null,
			greptime: stubGreptime([world], { [H]: anchorRow(H, world, "sig-cli-u") }) as never,
		});
		const rpc = {
			getGenesisHash: async () => GENESIS,
			transactionMemo: async (): Promise<never> => {
				throw new Error("devnet unreachable");
			},
		};
		const base = await serveVerify(substrate, rpc, H + 5 * HOUR);

		const result = await run(["verify", graph], { SUBSTRATE_URL: base, SUBSTRATE_VERIFY_TIMEOUT_MS: "10000" });

		expect(result.exitCode).toBe(1);
		// The cause text crosses from devnet untrusted and redacted; only the
		// named prefix is the contract.
		expect(result.stderr).toContain(`[substrate] verify could not check devnet for ${world.iso}:`);
	});

	test("anchored plus pending hours exit 0", async () => {
		const graph = "ut-cli-ok";
		const anchored = buildHour(H, "sess-cli-a", graph);
		const open = buildHour(H + HOUR, "sess-cli-b", graph);
		const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
			index: null,
			greptime: stubGreptime([anchored, open], { [H]: anchorRow(H, anchored, "sig-cli-ok") }) as never,
		});
		const rpc = { getGenesisHash: async () => GENESIS, transactionMemo: async () => memoTx(anchored.memo) };
		const base = await serveVerify(substrate, rpc, H + 4 * HOUR);

		const result = await run(["verify", graph], { SUBSTRATE_URL: base, SUBSTRATE_VERIFY_TIMEOUT_MS: "10000" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`${anchored.iso} anchored sig-cli-ok`);
		expect(result.stdout).toContain(`${open.iso} pending`);
	});

	test("refuses without a graph id", async () => {
		const result = await run(["verify"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("usage");
	});

	test("fails loudly when the substrate is not running", async () => {
		const result = await run(["verify", "ut-cli-gone"], {
			SUBSTRATE_URL: "http://127.0.0.1:1",
			SUBSTRATE_VERIFY_TIMEOUT_MS: "300",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unreachable");
	});
});
