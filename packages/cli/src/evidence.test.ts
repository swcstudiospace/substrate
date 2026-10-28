/**
 * `substrate evidence` driven through the real CLI process (Phase 41, E-D1 and D41-5).
 *
 * The command is spawned against an isolated loopback that serves bundles from the production
 * `buildGraphEvidence`, over a stub ledger and a fake devnet read-back. What is asserted is the
 * contract a script sees: an hour devnet cannot confirm exits 1 and names itself, while anchored
 * and pending hours exit 0.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { formatMemo, merkleRootHex } from "../../ledger/src/index.ts";
import { loadConfig } from "../../mcp-server/src/config.ts";
import { normalizeEvent } from "../../mcp-server/src/event.ts";
import { buildGraphEvidence, createObservability } from "../../mcp-server/src/observe.ts";
import { Substrate } from "../../mcp-server/src/service.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");
const H = Date.UTC(2026, 9, 1, 10);
const HOUR = 3_600_000;
const PUBKEY = "TestPubkey1111111111111111111111111111111";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** One closed hour of fixture: its store rows, ingest records, and the digest they imply. */
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
			{ surface: "omp", kind: "note", summary: `ev-${hour}-${i}`, session_id: session, graph_id: graph, actor: "agent" },
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

const closers: Array<() => void> = [];
afterAll(() => {
	for (const close of closers) close();
});

/** An isolated loopback whose `POST /evidence` answers with the production bundle. */
async function serveEvidence(substrate: Substrate, rpc: unknown, now: number): Promise<string> {
	const observed = createObservability(loadConfig({}));
	await observed.start();
	closers.push(() => observed.stop());
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/evidence") {
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
				const bundle = await buildGraphEvidence(observed, substrate, String(parsed.graph_id), [], undefined, {
					rpc: rpc as never,
					now,
				});
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(bundle));
			})();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

/**
 * Spawned asynchronously, not with `spawnSync`: the loopback under test listens in this
 * process, and a blocked event loop would starve it.
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

describe("substrate evidence", () => {
	test("an hour devnet cannot confirm exits 1, names that hour, and is marked unverified in the bundle", async () => {
		const graph = "ut-cli-ev-unverified";
		const world = buildHour(H, "sess-ev-u", graph);
		const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
			index: null,
			greptime: stubGreptime([world], { [H]: anchorRow(H, world, "sig-ev-u") }) as never,
		});
		const rpc = {
			getGenesisHash: async () => GENESIS,
			transactionMemo: async (): Promise<never> => {
				throw new Error("devnet unreachable");
			},
		};
		const base = await serveEvidence(substrate, rpc, H + 5 * HOUR);

		const result = await run(["evidence", "--graph", graph], { SUBSTRATE_URL: base });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`could not be verified against devnet: ${world.iso}`);
		const bundle = JSON.parse(result.stdout) as { anchors: Array<{ status: string; tx_sig?: string }> };
		expect(bundle.anchors).toEqual([expect.objectContaining({ status: "unverified", tx_sig: "sig-ev-u" })]);
	});

	test("anchored and pending hours exit 0, and the bundle lists both", async () => {
		const graph = "ut-cli-ev-ok";
		const anchored = buildHour(H, "sess-ev-a", graph);
		const open = buildHour(H + HOUR, "sess-ev-b", graph);
		const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
			index: null,
			greptime: stubGreptime([anchored, open], { [H]: anchorRow(H, anchored, "sig-ev-ok") }) as never,
		});
		const rpc = { getGenesisHash: async () => GENESIS, transactionMemo: async () => memoTx(anchored.memo) };
		const base = await serveEvidence(substrate, rpc, H + 4 * HOUR);

		const result = await run(["evidence", "--graph", graph], { SUBSTRATE_URL: base });

		expect(result.exitCode).toBe(0);
		const bundle = JSON.parse(result.stdout) as { anchors: Array<{ period_start: string; status: string }> };
		expect(bundle.anchors.map((anchor) => [anchor.period_start, anchor.status])).toEqual([
			[anchored.iso, "anchored"],
			[open.iso, "pending"],
		]);
	});
});
