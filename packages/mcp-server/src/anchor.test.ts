/**
 * The anchor job, against injected stubs: no real CLI, RPC or store.
 *
 * Each case pins one cell of the adopt/send/alarm/exit matrix from D28-06…
 * D28-08: adoption sends nothing, a root mismatch alarms and exits 1,
 * per-hour digest failures continue, systemic failures stop the run.
 */
import { describe, expect, test } from "bun:test";
import { formatMemo, formatMemoV2, headsRoot, parseMemo } from "@substrate/ledger";
import { GreptimeError, type GraphChainLeafRow, INGEST_LAG_MS } from "./greptime.ts";
import {
	ADDRESS_MEMO_LIMIT,
	ANCHOR_LOOKBACK_MS,
	buildGraphHeads,
	DEVNET_GENESIS_HASH,
	MAX_HOURS_PER_RUN,
	UsageError,
	parseAnchorArgs,
	runAnchorJob,
	type AnchorDeps,
	type AnchorEnv,
	type ChainMember,
} from "./anchor.ts";
import { headRecordsFromLeaves } from "./event.ts";
import type { NewAnchor } from "./greptime.ts";
import type { EmitResult, HourDigest } from "./service.ts";
import type { EventInput } from "./types.ts";
const H10 = Date.UTC(2026, 8, 26, 10);
const HOUR = 3_600_000;
const NOW = H10 + HOUR + INGEST_LAG_MS + 60_000;
const PUBKEY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const SIG = "5".repeat(87);
const ROOT = "a".repeat(64);
const OTHER_ROOT = "b".repeat(64);

const ENV: AnchorEnv = {
	rpcUrl: "https://api.devnet.solana.com",
	keypairPath: "/etc/substrate/anchor-keypair.json",
	pubkey: PUBKEY,
	cli: "/root/.local/share/solana/install/active_release/bin/solana",
};

function digest(hour: number, root: string | null = ROOT, count = 3): HourDigest {
	return {
		period_start: new Date(hour).toISOString(),
		period_end: new Date(hour + HOUR).toISOString(),
		event_count: count,
		event_ids: root === null ? [] : ["evt_1", "evt_2", "evt_3"].slice(0, count),
		root,
		memo: root === null ? null : formatMemo({ periodStartMs: hour, rootHex: root, count }),
	};
}

const hashOf = (id: string): string => new Bun.CryptoHasher("sha256").update(id).digest("hex");

/** The member rows `eventsByIds` answers with: one graph and one session, a chain in id order. */
function memberRows(ids: readonly string[]): ChainMember[] {
	return ids.map((id) => {
		const n = Number(id.slice("evt_".length));
		return { id, hash: hashOf(id), prev: n > 1 ? hashOf(`evt_${n - 1}`) : null, graph_id: "graph-a", session_id: "session-1" };
	});
}

interface Emitted {
	surface: string;
	kind: string;
	session_id?: string;
	payload?: Record<string, unknown>;
	repo?: string;
}

function deps(
	overrides: Partial<AnchorDeps> & {
		digests?: Map<number, HourDigest | Error>;
		/** The member rows `eventsByIds` answers with; by default each id is one event of one chain. */
		eventRows?: (ids: readonly string[]) => ChainMember[];
		/** What `insertGraphChainLeaves` throws, so a test can fail the leaves write. */
		leavesError?: Error;
	} = {},
): {
	deps: AnchorDeps;
	emitted: Emitted[];
	inserts: Array<Record<string, unknown>>;
	invocations: string[][];
	leafInserts: GraphChainLeafRow[];
} {
	const emitted: Emitted[] = [];
	const inserts: Array<Record<string, unknown>> = [];
	const invocations: string[][] = [];
	const leafInserts: GraphChainLeafRow[] = [];
	const { digests, eventRows = memberRows, leavesError, ...rest } = overrides;
	// What the stub CLI was last asked to send: the read-back answers with
	// that memo, the way a real RPC answers with what the signature carries.
	// This keeps the stub independent of digest call order (the job peeks
	// digests ahead of the sends).
	let lastSentMemo = "";
	const full: AnchorDeps = {
		greptime: {
			firstIngestMs: async () => H10,
			anchorsBetween: async () => [],
			anchorForPeriod: async () => null,
			insertAnchor: async (row: NewAnchor) => {
				inserts.push({ ...row });
			},
			eventsByIds: async (ids: readonly string[]) => eventRows(ids),
			insertGraphChainLeaves: async (rows: GraphChainLeafRow[]) => {
				if (leavesError !== undefined) throw leavesError;
				leafInserts.push(...rows);
			},
		} as unknown as AnchorDeps["greptime"],
		substrate: {
			hourDigest: async (hour: number) => {
				const stubbed = digests?.get(hour);
				if (stubbed instanceof Error) throw stubbed;
				return stubbed ?? digest(hour);
			},
			emit: async (input: EventInput) => {
				emitted.push(input as Emitted);
				return { stored: true, event: input } as unknown as EmitResult;
			},
		} as unknown as AnchorDeps["substrate"],
		runner: async (argv: readonly string[]) => {
			invocations.push([...argv]);
			if (argv[1] === "pubkey") return { code: 0, stdout: `${PUBKEY}\n`, stderr: "" };
			const flag = argv.indexOf("--with-memo");
			lastSentMemo = flag >= 0 ? String(argv[flag + 1] ?? "") : "";
			return { code: 0, stdout: `{"signature":"${SIG}"}`, stderr: "" };
		},
		rpc: {
			transactionMemo: async () => ({
				memo: lastSentMemo || formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 }),
				payer: PUBKEY,
				payerSigned: true,
				err: null,
				fee: 5000,
				slot: 42,
				blockTime: 1_790_000_000,
			}),
			addressMemos: async () => [],
			balance: async () => 1_000_000,
			getGenesisHash: async () => DEVNET_GENESIS_HASH,
		},
		env: ENV,
		clock: () => NOW,
		...rest,
	};
	return { deps: full, emitted, inserts, invocations, leafInserts };
}

function written(emitted: Emitted[]) {
	return emitted.filter((e) => e.payload?.action === "anchor" && e.kind === "note");
}

function failed(emitted: Emitted[]) {
	return emitted.filter((e) => e.payload?.action === "anchor" && e.kind === "warning");
}

describe("runAnchorJob candidates and exits", () => {
	test("nothing to anchor when the store holds no ingest record", async () => {
		const { deps: d, invocations, inserts } = deps({
			greptime: { firstIngestMs: async () => null } as unknown as AnchorDeps["greptime"],
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
	});

	test("empty hours are skipped and never written", async () => {
		const { deps: d, emitted, inserts, invocations } = deps({ digests: new Map([[H10, digest(H10, null, 0)]]) });
		const result = await runAnchorJob(d);
		expect(result.code).toBe(0);
		expect(inserts).toEqual([]);
		expect(emitted).toEqual([]);
		expect(invocations).toEqual([]);
	});

	test("hours before the coverage start are never candidates", async () => {
		const seen: number[] = [];
		const { deps: d } = deps({
			greptime: {
				firstIngestMs: async () => H10 + HOUR,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => null,
				insertAnchor: async () => {},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
			substrate: {
				hourDigest: async (hour: number) => {
					seen.push(hour);
					return digest(hour);
				},
				emit: async () => ({}) as never,
			} as unknown as AnchorDeps["substrate"],
		});
		await runAnchorJob(d);
		expect(seen.every((h) => h >= H10 + HOUR)).toBe(true);
	});

	test("already-anchored hours are never written again", async () => {
		const { deps: d, inserts } = deps({
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [
					{
						period_start: new Date(H10).toISOString(),
						period_end: new Date(H10 + HOUR).toISOString(),
						root: ROOT,
						event_count: 3,
						memo: "m",
						tx_sig: "old",
						signer: PUBKEY,
						cluster: "devnet",
						slot: 1,
						anchored_at: new Date(H10).toISOString(),
						stale_hashes: null,
					},
				],
				anchorForPeriod: async () => null,
				insertAnchor: async (row: NewAnchor) => {
					inserts.push({ ...row });
				},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
		});
		await runAnchorJob(d);
		expect(inserts.every((row) => row.period_start !== new Date(H10).toISOString())).toBe(true);
	});

	test("at most 24 hours anchor per run, ascending", async () => {
		const early = H10 - 30 * HOUR;
		const seen: number[] = [];
		let lastSentMemo = "";
		const { deps: d } = deps({
			clock: () => NOW,
			greptime: {
				firstIngestMs: async () => early,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => null,
				insertAnchor: async () => {},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
			substrate: {
				hourDigest: async (hour: number) => {
					seen.push(hour);
					return digest(hour);
				},
				emit: async () => ({ stored: true }) as never,
			} as unknown as AnchorDeps["substrate"],
			runner: async (argv: readonly string[]) => {
				if (argv[1] === "pubkey") return { code: 0, stdout: `${PUBKEY}\n`, stderr: "" };
				const flag = argv.indexOf("--with-memo");
				lastSentMemo = flag >= 0 ? String(argv[flag + 1] ?? "") : "";
				return { code: 0, stdout: `{"signature":"${SIG}"}`, stderr: "" };
			},
			rpc: {
				transactionMemo: async () => ({
					memo: lastSentMemo,
					payer: PUBKEY,
					payerSigned: true,
					err: null,
					fee: 5000,
					slot: 42,
					blockTime: 1,
				}),
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(seen).toHaveLength(MAX_HOURS_PER_RUN);
		expect([...seen].sort((a, b) => a - b)).toEqual(seen);
		expect(result.anchored).toBe(MAX_HOURS_PER_RUN);
	});

	test("a store failure reading coverage stops the run", async () => {
		const { deps: d, invocations } = deps({
			greptime: {
				firstIngestMs: async () => {
					throw new Error("down");
				},
			} as unknown as AnchorDeps["greptime"],
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(invocations).toEqual([]);
	});

	test("a long empty gap does not starve later non-empty hours", async () => {
		// 24 empty hours then one holding events: the empties never take a
		// row, so the budget must still reach the hour after the gap.
		const late = H10 + 24 * HOUR;
		const empties = new Map<number, HourDigest | Error>();
		for (let h = H10; h < late; h += HOUR) empties.set(h, digest(h, null, 0));
		const { deps: d, inserts } = deps({
			clock: () => late + HOUR + INGEST_LAG_MS + 60_000,
			digests: empties,
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 1, adopted: 0, failed: 0 });
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.period_start).toBe(new Date(late).toISOString());
	});
});

describe("runAnchorJob send path", () => {
	test("a fresh hour sends through the D-06 argv and writes the 11-column row", async () => {
		const { deps: d, emitted, inserts, invocations } = deps();
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 1, adopted: 0, failed: 0 });
		expect(invocations).toHaveLength(2);
		const keygen = invocations[0] ?? [];
		expect(keygen.slice(1)).toEqual(["pubkey", ENV.keypairPath]);
		const send = invocations[1] ?? [];
		expect(send[0]).toBe(ENV.cli);
		expect(send).toContain("--with-memo");
		expect(send).toContain("--keypair");
		expect(send).toContain(ENV.keypairPath);
		expect(send).toContain("--url");
		expect(send).toContain(ENV.rpcUrl);
		expect(send).toContain("--commitment");
		expect(send).toContain("confirmed");
		const row = inserts[0] ?? {};
		for (const column of [
			"period_start",
			"period_end",
			"root",
			"event_count",
			"memo",
			"tx_sig",
			"signer",
			"cluster",
			"slot",
			"anchored_at",
		]) {
			expect(row[column]).toBeDefined();
		}
		expect(row).toMatchObject({ root: ROOT, event_count: 3, tx_sig: SIG, signer: PUBKEY, cluster: "devnet", slot: 42 });
		const notes = written(emitted);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({
			surface: "substrate",
			kind: "note",
			session_id: "anchor:2026-09-26T10",
			payload: { action: "anchor", runtime: "anchor", adopted: false },
		});
		expect(notes[0]).not.toHaveProperty("repo");
	});

	test("a failed read-back sends nothing to the store", async () => {
		const { deps: d, emitted, inserts } = deps({
			rpc: {
				transactionMemo: async () => ({
					memo: formatMemo({ periodStartMs: H10, rootHex: OTHER_ROOT, count: 3 }),
					payer: PUBKEY,
					payerSigned: true,
					err: null,
					fee: 5000,
					slot: 43,
					blockTime: 1,
				}),
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "send-failed" });
	});

	test("a nonzero CLI exit stops the run with send-failed", async () => {
		const { deps: d, emitted, inserts } = deps({
			runner: async (argv: readonly string[]) =>
				argv[1] === "pubkey"
					? { code: 0, stdout: `${PUBKEY}\n`, stderr: "" }
					: { code: 1, stdout: "", stderr: "oops" },
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "send-failed" });
	});

	test("a row the sweep missed plus an aged-out memo never resends", async () => {
		// Crash variant: the send-path map says absent (the row landed after
		// the anchors-window read) and the memo aged out of the 100-signature
		// listing, so checkAdopt reads none. The durable re-check finds the
		// row and the hour is left alone, never anchored twice.
		const anchored = {
			period_start: new Date(H10).toISOString(),
			period_end: new Date(H10 + HOUR).toISOString(),
			root: ROOT,
			event_count: 3,
			memo: "m",
			tx_sig: "old",
			signer: PUBKEY,
			cluster: "devnet",
			slot: 1,
			anchored_at: new Date(H10).toISOString(),
			stale_hashes: null,
		};
		const { deps: d, emitted, inserts, invocations } = deps({
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => anchored,
				insertAnchor: async () => {
					throw new Error("must never write an anchored hour again");
				},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(emitted).toEqual([]);
	});
});

describe("runAnchorJob adopt and alarm", () => {
	function confirmingRpc(memo: string, slot = 77) {
		return {
			transactionMemo: async () => ({
				memo,
				payer: PUBKEY,
				payerSigned: true,
				err: null,
				fee: 5000,
				slot,
				blockTime: 1,
			}),
			addressMemos: async () => [{ signature: SIG, memo, err: null, slot }],
			balance: async () => 1_000_000,
			getGenesisHash: async () => DEVNET_GENESIS_HASH,
		};
	}

	test("same root and count adopts: row with the found tx_sig and slot, nothing sent", async () => {
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 });
		const { deps: d, emitted, inserts, invocations } = deps({ rpc: confirmingRpc(memo) });
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 1, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts[0]).toMatchObject({ tx_sig: SIG, slot: 77, root: ROOT, event_count: 3 });
		expect(written(emitted)[0]?.payload).toMatchObject({ adopted: true, tx_sig: SIG });
	});

	test("a different root alarms, writes the row as found, and exits 1", async () => {
		const memo = formatMemo({ periodStartMs: H10, rootHex: OTHER_ROOT, count: 3 });
		const errors: string[] = [];
		const originalWrite = process.stderr.write;
		// Narrowed to the write's string form: the job only writes strings.
		process.stderr.write = ((chunk: string) => {
			errors.push(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			const { deps: d, emitted, inserts, invocations } = deps({ rpc: confirmingRpc(memo) });
			const result = await runAnchorJob(d);
			expect(result.code).toBe(1);
			expect(invocations).toEqual([]);
			expect(inserts[0]).toMatchObject({ tx_sig: SIG, root: OTHER_ROOT });
			expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "root-mismatch" });
			expect(errors.some((line) => line.includes(`[anchor] ALARM ${new Date(H10).toISOString()}`))).toBe(true);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	test("a root mismatch alarms but later hours still anchor", async () => {
		const later = H10 + HOUR;
		const badSig = "6".repeat(87);
		const goodSig = "7".repeat(87);
		const badMemo = formatMemo({ periodStartMs: H10, rootHex: OTHER_ROOT, count: 3 });
		const goodMemo = formatMemo({ periodStartMs: later, rootHex: ROOT, count: 3 });
		const confirmed = (memo: string, slot: number) => ({
			memo,
			payer: PUBKEY,
			payerSigned: true,
			err: null,
			fee: 5000,
			slot,
			blockTime: 1,
		});
		const { deps: d, emitted, inserts, invocations } = deps({
			clock: () => later + HOUR + INGEST_LAG_MS + 60_000,
			rpc: {
				transactionMemo: async (signature: string) =>
					signature === badSig ? confirmed(badMemo, 77) : signature === goodSig ? confirmed(goodMemo, 78) : null,
				addressMemos: async () => [
					{ signature: badSig, memo: badMemo, err: null, slot: 77 },
					{ signature: goodSig, memo: goodMemo, err: null, slot: 78 },
				],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.adopted).toBe(1);
		expect(invocations).toEqual([]);
		expect(inserts).toHaveLength(2);
		expect(inserts[0]).toMatchObject({ period_start: new Date(H10).toISOString(), tx_sig: badSig });
		expect(inserts[1]).toMatchObject({ period_start: new Date(later).toISOString(), tx_sig: goodSig });
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "root-mismatch" });
	});

	test("a hint for another hour never blocks the send", async () => {
		const otherMemo = formatMemo({ periodStartMs: H10 + HOUR, rootHex: ROOT, count: 3 });
		const sentMemo = formatMemoV2({
			periodStartMs: H10,
			rootHex: ROOT,
			count: 3,
			headsRootHex: headsRoot(buildGraphHeads(memberRows(["evt_1", "evt_2", "evt_3"]), H10).records),
		});
		const hintSig = "6".repeat(87);
		const { deps: d, inserts, invocations } = deps({
			rpc: {
				transactionMemo: async (signature: string) =>
					signature === hintSig
						? null
						: {
								memo: sentMemo,
								payer: PUBKEY,
								payerSigned: true,
								err: null,
								fee: 5000,
								slot: 42,
								blockTime: 1,
							},
				addressMemos: async () => [{ signature: hintSig, memo: otherMemo, err: null, slot: 1 }],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.anchored).toBe(1);
		expect(invocations.length).toBeGreaterThan(0);
		expect(inserts[0]?.tx_sig).toBeDefined();
	});

	test("a period-matching hint whose transaction cannot be read stops the run", async () => {
		// The memo may already anchor this hour (a send followed by a lost
		// row write): sending again would anchor it twice, so the run stops
		// with rpc-unreadable instead.
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 });
		const hintSig = "6".repeat(87);
		const { deps: d, emitted, inserts, invocations } = deps({
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [{ signature: hintSig, memo, err: null, slot: 1 }],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.anchored).toBe(0);
		expect(result.failed).toBe(1);
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "rpc-unreadable" });
	});
});

describe("runAnchorJob failures", () => {
	test("24 digest-failed hours do not prevent a later healthy hour from being selected", async () => {
		// Damaged hours are reported and skipped during the peek, so they
		// must not fill the 24-slot budget and starve the hour after them.
		const late = H10 + MAX_HOURS_PER_RUN * HOUR;
		const damaged = new Map<number, HourDigest | Error>();
		for (let h = H10; h < late; h += HOUR) {
			damaged.set(h, new GreptimeError("hour member evt_1 has no event row"));
		}
		const { deps: d, emitted, inserts, invocations } = deps({
			clock: () => late + HOUR + INGEST_LAG_MS + 60_000,
			digests: damaged,
		});
		const result = await runAnchorJob(d);
		expect(result.failed).toBe(MAX_HOURS_PER_RUN);
		expect(result.anchored).toBe(1);
		expect(result.code).toBe(1);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.period_start).toBe(new Date(late).toISOString());
		expect(failed(emitted)).toHaveLength(MAX_HOURS_PER_RUN);
		expect(failed(emitted).every((event) => event.payload?.reason === "digest-failed")).toBe(true);
		expect(invocations.filter((argv) => argv.includes("--with-memo"))).toHaveLength(1);
	});

	test("a dry-run digest failure does not spend a candidate slot", async () => {
		const late = H10 + HOUR;
		const lines: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return write(chunk as never);
		}) as typeof process.stdout.write;
		try {
			const { deps: d, emitted, inserts, invocations } = deps({
				options: { dryRun: true },
				clock: () => late + HOUR + INGEST_LAG_MS + 60_000,
				digests: new Map<number, HourDigest | Error>([[H10, new GreptimeError("hour member evt_1 has no event row")]]),
			});
			const result = await runAnchorJob(d);
			expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
			expect(invocations).toEqual([]);
			expect(inserts).toEqual([]);
			expect(emitted).toEqual([]);
			expect(lines.some((line) => line.includes(`would fail ${new Date(H10).toISOString()} (digest-failed)`))).toBe(true);
			expect(lines.some((line) => line.includes(`would anchor ${new Date(late).toISOString()}`))).toBe(true);
		} finally {
			process.stdout.write = write;
		}
	});

	test("a per-hour digest failure continues to the next hour", async () => {
		const later = H10 + HOUR;
		const { deps: d, emitted } = deps({
			clock: () => later + HOUR + INGEST_LAG_MS + 60_000,
			digests: new Map<number, HourDigest | Error>([[H10, new GreptimeError("hour member evt_1 has no event row")]]),
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.anchored).toBe(1);
		expect(failed(emitted)[0]?.payload).toMatchObject({
			period_start: new Date(H10).toISOString(),
			reason: "digest-failed",
		});
	});

	test("a store failure reading the digest stops the run as store-failed", async () => {
		// The ledger is unreadable, not the hour bad: later hours may hold
		// cached digests, so continuing could send again while the store is
		// down and lose another row.
		const later = H10 + HOUR;
		const { deps: d, emitted, inserts, invocations } = deps({
			clock: () => later + HOUR + INGEST_LAG_MS + 60_000,
			digests: new Map<number, HourDigest | Error>([[H10, new Error("greptime unreachable: connection refused")]]),
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.anchored).toBe(0);
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({
			period_start: new Date(H10).toISOString(),
			reason: "store-failed",
		});
	});

	test("a lost anchor.failed warning stops the run", async () => {
		// H10 holds bad hour data, but its warning never reaches the store;
		// H11 is closed and would send, and must never be touched after the
		// store already failed one write.
		const later = H10 + HOUR;
		const { deps: d, emitted, invocations } = deps({
			clock: () => later + HOUR + INGEST_LAG_MS + 60_000,
			substrate: {
				hourDigest: async (hour: number) => {
					if (hour === H10) throw new GreptimeError("hour member evt_1 has no event row");
					return digest(hour);
				},
				emit: async (input: EventInput) => {
					emitted.push(input as never);
					return { stored: false, event: input } as unknown as EmitResult;
				},
			} as unknown as AnchorDeps["substrate"],
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.anchored).toBe(0);
		expect(invocations).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({
			period_start: new Date(H10).toISOString(),
			reason: "digest-failed",
		});
	});

	test("a store failure on the pre-send row re-check stops without sending", async () => {
		// checkAdopt reads none and the sweep map says absent, but the
		// durable row cannot be read: fail closed before any send.
		const { deps: d, emitted, inserts, invocations } = deps({
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => {
					throw new Error("unreachable");
				},
				insertAnchor: async () => {},
			} as unknown as AnchorDeps["greptime"],
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.anchored).toBe(0);
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});

	test("wrong cluster stops before the first send", async () => {
		const { deps: d, emitted, invocations } = deps({
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpYbfX66U2GJkSnp6vn33VqDv",
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		// D28-07 order: the keygen pubkey check runs before the genesis gate,
		// so one invocation happened but no transfer was ever built.
		expect(invocations).toHaveLength(1);
		expect(invocations[0]?.[1]).toBe("pubkey");
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "wrong-cluster" });
	});

	test("signer mismatch stops before the first send", async () => {
		const { deps: d, emitted, invocations } = deps({
			runner: async (argv) => {
				invocations.push([...argv]);
				return argv[1] === "pubkey"
					? { code: 0, stdout: "11111111111111111111111111111111\n", stderr: "" }
					: { code: 0, stdout: `{"signature":"${SIG}"}`, stderr: "" };
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(invocations.filter((a) => a[1] === "transfer")).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "signer-mismatch" });
	});

	test("an unfunded key stops before the first send", async () => {
		const { deps: d, emitted, invocations } = deps({
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [],
				balance: async () => 100,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(invocations).toEqual([expect.arrayContaining(["pubkey"])]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "unfunded" });
	});

	test("an unreadable RPC during adopt stops the run", async () => {
		const { deps: d, emitted, invocations } = deps({
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => {
					throw new Error("connection refused");
				},
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(invocations).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "rpc-unreadable" });
	});

	test("a store failure on insert stops the run", async () => {
		let insertReached = false;
		const { deps: d, emitted } = deps({
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => null,
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
				insertAnchor: async () => {
					insertReached = true;
					throw new Error("insert refused");
				},
			} as unknown as AnchorDeps["greptime"],
		});
		const result = await runAnchorJob(d);
		expect(insertReached).toBe(true);
		expect(result.code).toBe(1);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});

	test("a send whose anchor note is not stored fails without resending", async () => {
		const { deps: d, emitted, inserts, invocations } = deps({
			substrate: {
				hourDigest: async (hour: number) => digest(hour),
				emit: async (input: EventInput) => {
					emitted.push(input as never);
					return { stored: false, event: input } as unknown as EmitResult;
				},
			} as unknown as AnchorDeps["substrate"],
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.anchored).toBe(0);
		expect(result.failed).toBe(1);
		// The row is written but the transaction goes out once: one pubkey
		// check plus one transfer, then the run stops on the lost note.
		expect(invocations).toHaveLength(2);
		expect(invocations.filter((argv) => argv.includes("--with-memo"))).toHaveLength(1);
		expect(inserts).toHaveLength(1);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});

	test("an adoption whose anchor note is not stored stops the run", async () => {
		// H10 adopts but its note is lost; H11 is closed and would send, and
		// must never be touched after the store already failed one write.
		const later = H10 + HOUR;
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 });
		let lastSentMemo = "";
		const { deps: d, emitted, inserts, invocations } = deps({
			clock: () => later + HOUR + INGEST_LAG_MS + 60_000,
			substrate: {
				hourDigest: async (hour: number) => digest(hour),
				emit: async (input: EventInput) => {
					emitted.push(input as never);
					return { stored: false, event: input } as unknown as EmitResult;
				},
			} as unknown as AnchorDeps["substrate"],
			runner: async (argv: readonly string[]) => {
				invocations.push([...argv]);
				if (argv[1] === "pubkey") return { code: 0, stdout: `${PUBKEY}\n`, stderr: "" };
				const flag = argv.indexOf("--with-memo");
				lastSentMemo = flag >= 0 ? String(argv[flag + 1] ?? "") : "";
				return { code: 0, stdout: `{"signature":"${SIG}"}`, stderr: "" };
			},
			rpc: {
				transactionMemo: async () => ({
					memo: lastSentMemo || memo,
					payer: PUBKEY,
					payerSigned: true,
					err: null,
					fee: 5000,
					slot: 77,
					blockTime: 1,
				}),
				addressMemos: async () => [{ signature: SIG, memo, err: null, slot: 77 }],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.adopted).toBe(0);
		expect(result.failed).toBe(1);
		expect(invocations).toEqual([]);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.period_start).toBe(new Date(H10).toISOString());
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});
});

describe("runAnchorJob constants", () => {
	test("bounds match the plan", () => {
		expect(MAX_HOURS_PER_RUN).toBe(24);
		expect(ANCHOR_LOOKBACK_MS).toBe(7 * 24 * 3_600_000);
		expect(ADDRESS_MEMO_LIMIT).toBe(100);
		expect(INGEST_LAG_MS).toBe(300_000);
	});
});

describe("parseAnchorArgs", () => {
	test("empty argv means a full sweep", () => {
		expect(parseAnchorArgs([])).toEqual({});
	});

	test("--dry-run previews without sending", async () => {
		expect(parseAnchorArgs(["--dry-run"])).toEqual({ dryRun: true });
		const { deps: d, emitted, inserts, invocations } = deps({ options: { dryRun: true } });
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(emitted).toEqual([]);
	});

	test("--period names one whole UTC hour", () => {
		expect(parseAnchorArgs(["--period", "2026-09-26T10:00:00.000Z"])).toEqual({ onlyPeriodMs: H10 });
		expect(() => parseAnchorArgs(["--period"])).toThrow(UsageError);
		expect(() => parseAnchorArgs(["--period", "2026-09-26T10:30:00.000Z"])).toThrow(UsageError);
		expect(() => parseAnchorArgs(["--period", "not-a-time"])).toThrow(UsageError);
		expect(() => parseAnchorArgs(["--bogus"])).toThrow(UsageError);
	});

	test("a --period re-run over an anchored hour adopts without touching the row", async () => {
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 });
		const anchored = {
			period_start: new Date(H10).toISOString(),
			period_end: new Date(H10 + HOUR).toISOString(),
			root: ROOT,
			event_count: 3,
			memo,
			tx_sig: SIG,
			signer: PUBKEY,
			cluster: "devnet",
			slot: 77,
			anchored_at: new Date(H10).toISOString(),
			stale_hashes: null,
		};
		const { deps: d, emitted, inserts, invocations } = deps({
			options: { onlyPeriodMs: H10 },
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [anchored],
				anchorForPeriod: async () => anchored,
				insertAnchor: async (row: NewAnchor) => {
					inserts.push({ ...row });
				},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
			rpc: {
				transactionMemo: async () => ({
					memo,
					payer: PUBKEY,
					payerSigned: true,
					err: null,
					fee: 5000,
					slot: 77,
					blockTime: 1,
				}),
				addressMemos: async () => [{ signature: SIG, memo, err: null, slot: 77 }],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 1, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(written(emitted)[0]?.payload).toMatchObject({ adopted: true, tx_sig: SIG });
	});

	test("a --period re-run older than the lookback never anchors twice", async () => {
		// The sweep window only reaches back seven days, and the memo has
		// fallen out of the 100 recent signatures: without consulting that
		// hour's row directly, the job would send a second anchor over it.
		const old = H10 - 30 * 24 * HOUR;
		const memo = formatMemo({ periodStartMs: old, rootHex: ROOT, count: 3 });
		const anchored = {
			period_start: new Date(old).toISOString(),
			period_end: new Date(old + HOUR).toISOString(),
			root: ROOT,
			event_count: 3,
			memo,
			tx_sig: SIG,
			signer: PUBKEY,
			cluster: "devnet",
			slot: 77,
			anchored_at: new Date(old).toISOString(),
			stale_hashes: null,
		};
		const { deps: d, emitted, inserts, invocations } = deps({
			options: { onlyPeriodMs: old },
			greptime: {
				firstIngestMs: async () => old,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => anchored,
				insertAnchor: async (row: NewAnchor) => {
					inserts.push({ ...row });
				},
				eventsByIds: async (ids: readonly string[]) => memberRows(ids),
				insertGraphChainLeaves: async () => {},
			} as unknown as AnchorDeps["greptime"],
			rpc: {
				transactionMemo: async () => null,
				addressMemos: async () => [],
				balance: async () => 1_000_000,
				getGenesisHash: async () => DEVNET_GENESIS_HASH,
			},
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(emitted).toEqual([]);
	});

	test("a failed --period row read stops before any adopt or send", async () => {
		const { deps: d, emitted, inserts, invocations } = deps({
			options: { onlyPeriodMs: H10 },
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [],
				anchorForPeriod: async () => {
					throw new Error("unreachable");
				},
				insertAnchor: async (row: NewAnchor) => {
					inserts.push({ ...row });
				},
			} as unknown as AnchorDeps["greptime"],
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});

	test("a matching memo on another cluster is not adopted", async () => {
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 });
		const { deps: d, emitted, inserts, invocations } = deps({
			rpc: {
				transactionMemo: async () => ({
					memo,
					payer: PUBKEY,
					payerSigned: true,
					err: null,
					fee: 5000,
					slot: 77,
					blockTime: 1,
				}),
				addressMemos: async () => [{ signature: SIG, memo, err: null, slot: 77 }],
				balance: async () => 1_000_000,
				getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpYbfX66U2GJkSnp6vn33VqDv",
			},
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.adopted).toBe(0);
		expect(inserts).toEqual([]);
		expect(invocations).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "wrong-cluster" });
	});

	test("a dry-run store failure writes no warning", async () => {
		const { deps: d, emitted, inserts, invocations } = deps({
			options: { dryRun: true },
			digests: new Map<number, HourDigest | Error>([[H10, new Error("store down")]]),
		});
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(result.failed).toBe(1);
		expect(emitted).toEqual([]);
		expect(inserts).toEqual([]);
		expect(invocations).toEqual([]);
	});
});

describe("anchor heads (D73-01, D73-02)", () => {
	const member = (id: string, prev: string | null, graph: string | null = "graph-a", session: string | null = "session-1"): ChainMember => ({
		id,
		hash: hashOf(id),
		prev,
		graph_id: graph,
		session_id: session,
	});
	const chain = [member("evt_1", null), member("evt_2", hashOf("evt_1")), member("evt_3", hashOf("evt_2"))];

	test("the same hour gives the same heads and leaves every time", () => {
		expect(buildGraphHeads(chain, H10)).toStrictEqual(buildGraphHeads(chain, H10));
	});

	test("two sessions of one graph give two records, each with its own chain", () => {
		const { records, leaves } = buildGraphHeads([...chain, member("evt_4", null, "graph-a", "session-2")], H10);
		expect(records.map((record) => record.sessionId)).toEqual(["session-1", "session-2"]);
		expect(records[0]).toMatchObject({ count: 3, headEventId: "evt_3", headHashHex: hashOf("evt_3") });
		expect(records[1]).toMatchObject({ count: 1, headEventId: "evt_4" });
		expect(leaves.filter((leaf) => leaf.session_id === "session-2")).toHaveLength(1);
	});

	test("a permuted read order gives identical heads and leaves, forks included", () => {
		// evt_a and evt_b both claim no predecessor: inChainOrder would start from whichever it meets first.
		const a = member("evt_a", null);
		const b = member("evt_b", null);
		const c = member("evt_c", hashOf("evt_a"));
		const expected = buildGraphHeads([a, b, c], H10);
		for (const order of [
			[b, c, a],
			[c, a, b],
			[a, c, b],
		]) {
			expect(buildGraphHeads(order, H10)).toStrictEqual(expected);
		}
		expect(buildGraphHeads([...chain].reverse(), H10)).toStrictEqual(buildGraphHeads(chain, H10));
	});

	test("a graph-less event gets no head and no leaf", () => {
		const { records, leaves } = buildGraphHeads([...chain, member("evt_9", null, null, null)], H10);
		expect(records).toHaveLength(1);
		expect(leaves).toHaveLength(3);
	});

	test("the anchor and the verifier derive the same head records from the same leaves", () => {
		const { records, leaves } = buildGraphHeads(chain, H10);
		expect(headRecordsFromLeaves(leaves, H10)).toStrictEqual(records);
	});

	test("an hour with events anchors a v2 memo carrying the heads root", async () => {
		const { deps: d, inserts, leafInserts } = deps();
		const result = await runAnchorJob(d);
		expect(result.anchored).toBe(1);
		const { records } = buildGraphHeads(chain, H10);
		expect(parseMemo(String(inserts[0]?.memo))).toStrictEqual({
			periodStartMs: H10,
			rootHex: ROOT,
			count: 3,
			headsRootHex: headsRoot(records),
		});
		expect(leafInserts).toHaveLength(3);
	});

	test("an hour no graph owns anchors the v1 memo and writes no leaves", async () => {
		const { deps: d, inserts, leafInserts } = deps({
			eventRows: (ids) => memberRows(ids).map((row) => ({ ...row, graph_id: null })),
		});
		const result = await runAnchorJob(d);
		expect(result.anchored).toBe(1);
		expect(inserts[0]?.memo).toBe(formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 }));
		expect(leafInserts).toEqual([]);
	});

	test("a leaves write failure stops the anchor: no row is written", async () => {
		const { deps: d, emitted, inserts } = deps({ leavesError: new GreptimeError("ledger down") });
		const result = await runAnchorJob(d);
		expect(result.code).toBe(1);
		expect(inserts).toEqual([]);
		expect(failed(emitted)[0]?.payload).toMatchObject({ reason: "store-failed" });
	});

	test("an empty hour writes neither leaves nor a row", async () => {
		const { deps: d, inserts, leafInserts, invocations } = deps({ digests: new Map([[H10, digest(H10, null, 0)]]) });
		await runAnchorJob(d);
		expect(inserts).toEqual([]);
		expect(leafInserts).toEqual([]);
		expect(invocations).toEqual([]);
	});
});

describe("anchored hours and the heads read", () => {
	test("an already-anchored hour whose member rows cannot be read does not fail the run", async () => {
		const anchored = {
			period_start: new Date(H10).toISOString(),
			period_end: new Date(H10 + HOUR).toISOString(),
			root: ROOT,
			event_count: 3,
			memo: formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 3 }),
			tx_sig: SIG,
			signer: PUBKEY,
			cluster: "devnet",
			slot: 77,
			anchored_at: new Date(H10).toISOString(),
			stale_hashes: null,
		};
		const { deps: d, emitted, inserts, invocations } = deps({
			greptime: {
				firstIngestMs: async () => H10,
				anchorsBetween: async () => [anchored],
				anchorForPeriod: async () => anchored,
				insertAnchor: async () => {
					throw new Error("must never write an anchored hour again");
				},
				eventsByIds: async () => {
					throw new GreptimeError("member rows unreadable");
				},
				insertGraphChainLeaves: async () => {
					throw new Error("must never write leaves for an anchored hour");
				},
			} as unknown as AnchorDeps["greptime"],
		});
		const result = await runAnchorJob(d);
		expect(result).toEqual({ code: 0, anchored: 0, adopted: 0, failed: 0 });
		expect(invocations).toEqual([]);
		expect(inserts).toEqual([]);
		expect(emitted).toEqual([]);
	});
});
