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
const PUBKEY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
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
	return { memo, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 42, blockTime: 1_790_000_000 };
}

function stubGreptime(worlds: HourWorld[], anchors: Record<number, Record<string, unknown>>) {
	return {
		readEvents: async () => worlds.flatMap((world) => world.rows),
		graphIngest: async () => worlds.flatMap((world) => world.records),
		firstIngestMs: async () => H,
		graphChainLeafHours: async () => [],
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

/** What a test hands the loopback: where to record request bodies, and the `node` member to answer a `node_id` with. */
interface EvidenceServe {
	requests?: string[];
	node?: unknown;
}

/** An isolated loopback whose `POST /evidence` answers with the production bundle. */
async function serveEvidence(substrate: Substrate, rpc: unknown, now: number, serve: EvidenceServe = {}): Promise<string> {
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
				serve.requests?.push(body);
				const parsed = JSON.parse(body) as { graph_id?: unknown; node_id?: unknown };
				const bundle = await buildGraphEvidence(observed, substrate, String(parsed.graph_id), [], undefined, {
					rpc: rpc as never,
					now,
				});
				// The production server adds the `node` member only when the request names a node.
				const answer = typeof parsed.node_id === "string" && "node" in serve ? { ...bundle, node: serve.node } : bundle;
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
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
			addressSignaturePage: async () => [],
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
		const rpc = { getGenesisHash: async () => GENESIS, transactionMemo: async () => memoTx(anchored.memo), addressSignaturePage: async () => [] };
		const base = await serveEvidence(substrate, rpc, H + 4 * HOUR);

		const result = await run(["evidence", "--graph", graph], { SUBSTRATE_URL: base });

		expect(result.exitCode).toBe(0);
		const bundle = JSON.parse(result.stdout) as { anchors: Array<{ period_start: string; status: string }> };
		expect(bundle.anchors.map((anchor) => [anchor.period_start, anchor.status])).toEqual([
			[anchored.iso, "anchored"],
			[open.iso, "pending"],
		]);
	});

	describe("--node", () => {
		const ARTIFACT = {
			node_id: "n1",
			claim: [{ ts: "2026-10-01T10:00:00.000Z", action: "granted" }],
			linear: [
				{ ts: "2026-10-01T10:00:01.000Z", op: "claim", status: "ok", reason: null, blocker_node: null, edge_kind: null },
			],
			notion: [{ ts: "2026-10-01T10:00:02.000Z", op: "page", status: "failed", reason: "rate-limited" }],
			dod: [{ ts: "2026-10-01T10:00:03.000Z", status: "approved", reason: null }],
		};

		/** A clean graph (one anchored hour) whose loopback records each request body. */
		async function cleanServer(graph: string, serve: EvidenceServe): Promise<string> {
			const world = buildHour(H, "sess-ev-n", graph);
			const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
				index: null,
				greptime: stubGreptime([world], { [H]: anchorRow(H, world, "sig-ev-n") }) as never,
			});
			const rpc = { getGenesisHash: async () => GENESIS, transactionMemo: async () => memoTx(world.memo), addressSignaturePage: async () => [] };
			return serveEvidence(substrate, rpc, H + 4 * HOUR, serve);
		}

		test("sends node_id and prints the server's node member", async () => {
			const graph = "ut-cli-ev-node";
			const requests: string[] = [];
			const base = await cleanServer(graph, { requests, node: ARTIFACT });

			const result = await run(["evidence", "--graph", graph, "--node", "n1"], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(0);
			expect(requests.map((raw) => JSON.parse(raw))).toEqual([{ graph_id: graph, format: "json", node_id: "n1" }]);
			const document = JSON.parse(result.stdout) as { graph_id: string; node: unknown };
			expect(document.graph_id).toBe(graph);
			expect(document.node).toEqual(ARTIFACT);
		});

		test("without --node the request is exactly graph_id and format, and no node member is printed", async () => {
			const graph = "ut-cli-ev-nonode";
			const requests: string[] = [];
			const base = await cleanServer(graph, { requests, node: ARTIFACT });

			const result = await run(["evidence", "--graph", graph], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(0);
			expect(requests).toEqual([JSON.stringify({ graph_id: graph, format: "json" })]);
			expect(JSON.parse(result.stdout)).not.toHaveProperty("node");
		});

		test("--node without a value is a usage error and sends nothing", async () => {
			const requests: string[] = [];
			const base = await cleanServer("ut-cli-ev-novalue", { requests });

			const result = await run(["evidence", "--graph", "ut-cli-ev-novalue", "--node"], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("usage: substrate evidence --graph <graph_id> [--node <node_id>]");
			expect(requests).toEqual([]);
		});

		test("--node with --format html is a usage error that names the JSON-only artifact", async () => {
			const requests: string[] = [];
			const base = await cleanServer("ut-cli-ev-html", { requests });

			const result = await run(["evidence", "--graph", "ut-cli-ev-html", "--node", "n1", "--format", "html"], {
				SUBSTRATE_URL: base,
			});

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("the node artifact is part of the JSON document only");
			expect(requests).toEqual([]);
		});

		test("a node answer of { error } writes the document, names the node and the error, and exits 1", async () => {
			const graph = "ut-cli-ev-nodeerr";
			const base = await cleanServer(graph, { node: { error: "the ledger is not configured" } });

			const result = await run(["evidence", "--graph", graph, "--node", "n1"], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("[substrate] node n1: the ledger is not configured");
			const document = JSON.parse(result.stdout) as { graph_id: string; node: unknown };
			expect(document.graph_id).toBe(graph);
			expect(document.node).toEqual({ error: "the ledger is not configured" });
		});

		test("a bundle-only answer (a server that ignores node_id) still writes the document, warns and exits 1", async () => {
			const graph = "ut-cli-ev-oldserver";
			const requests: string[] = [];
			const base = await cleanServer(graph, { requests });

			const result = await run(["evidence", "--graph", graph, "--node", "n1"], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(1);
			expect(requests.map((raw) => JSON.parse(raw))).toEqual([{ graph_id: graph, format: "json", node_id: "n1" }]);
			expect(result.stderr).toContain("[substrate] node n1: the server answered without a node artifact");
			const document = JSON.parse(result.stdout) as { graph_id: string };
			expect(document.graph_id).toBe(graph);
			expect(document).not.toHaveProperty("node");
		});

		test("a node member of the wrong shape is not an evidence bundle", async () => {
			const graph = "ut-cli-ev-nodebad";
			const base = await cleanServer(graph, { node: { node_id: "n1", claim: "granted" } });

			const result = await run(["evidence", "--graph", graph, "--node", "n1"], { SUBSTRATE_URL: base });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("bundle.node.claim must be a list");
			expect(result.stdout).toBe("");
		});
	});
});
