/**
 * The verified archive (uplift-3 N6), against an in-memory ledger that pages
 * like `GreptimeClient.exportWindow`: a day archives to four files that verify;
 * any byte flipped, any root edited and any fork is named by kind; the gates
 * refuse before a byte is written; and the runner's exit codes are the ones
 * the timer and the operator act on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merkleRootHex } from "@substrate/ledger";
import { normalizeEvent } from "./event.ts";
import type { AnchorRow, ExportCursor, ExportPage, ExportWindowQuery } from "./greptime.ts";
import {
	archivedDays,
	archiveFiles,
	archiveNote,
	archiveWindow as archiveWindowOn,
	ArchiveRefused,
	daysToArchive,
	devReader,
	dayWindow,
	formatCoverage,
	formatVerifyReport,
	freeKbOf,
	isDayClosed,
	LedgerUsageError,
	newestClosedDay,
	parseLedgerArgs,
	pendingNoteDays,
	pendingNoteFile,
	readPendingNote,
	recordArchiveNote,
	refusedMount,
	refusedOutDir,
	releaseShaOf,
	retryPendingNotes,
	verifyArchive,
} from "./ledger-archive.ts";
import type { ArchiveManifest, ArchiveOptions, DevReader, NoteOutcome } from "./ledger-archive.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DAY = "2026-10-12";
const H10 = Date.UTC(2026, 9, 12, 10);
const H11 = Date.UTC(2026, 9, 12, 11);
/** 03:30 the next day: the day closed at 00:05. */
const NOW = Date.UTC(2026, 9, 13, 3, 30);

const scratch = mkdtempSync(join(tmpdir(), "substrate-ledger-archive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh out dir under the scratch root, outside any checkout. */
function outDir(name: string): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** `df -Pk` output for the archive volume with this many kilobytes free, in the two-line POSIX shape. */
function dfWith(availKb: number): string {
	return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdz 100000000 1000 ${availKb} 1% /mnt/x\n`;
}

/** A `df` for the free-space floor: the same reading wherever it is asked. */
function mountedDf(availKb = 50 * 1024 * 1024): (path: string) => string {
	return () => dfWith(availKb);
}

/**
 * A host with the archive volume mounted, as `st_dev` tells it: the root disk
 * (device 1) holds `/` and the release root; every other path (the scratch
 * dirs stand in for paths under the mount) is the volume's device 2.
 */
const mountedDev: DevReader = (path) => (path === "/" || path.startsWith("/opt/agent-substrate") ? 1 : 2);

/** `archiveWindow` on that host unless a test says otherwise. */
function archiveWindow(greptime: { exportWindow(query: ExportWindowQuery): Promise<ExportPage> }, options: ArchiveOptions): Promise<ArchiveManifest> {
	return archiveWindowOn(greptime, { dev: mountedDev, ...options });
}

/** An event as the chain stores it; `prev` links it to the session's tip. */
function event(session: string, prev: string | null, summary: string, ts: number): SubstrateEvent {
	return normalizeEvent(
		{ surface: "claude-code", kind: "note", summary, session_id: session, repo: "swcstudiospace/agent-substrate", ts: new Date(ts).toISOString() },
		prev,
	);
}

interface Fixture {
	events: SubstrateEvent[];
	/** First ingest record per event id, epoch ms. */
	ingest: Map<string, number>;
	anchors: AnchorRow[];
}

/** Two hours of ingest: s1 and s2 interleave in hour 10, s1 continues in hour 11; receipts for both hours over the real roots. */
function fixture(): Fixture {
	const a1 = event("s1", null, "s1 first", H10 + 1_000);
	const b1 = event("s2", null, "s2 first", H10 + 1_000);
	const a2 = event("s1", a1.hash, "s1 second", H10 + 2_000);
	const b2 = event("s2", b1.hash, "s2 second", H10 + 3_000);
	const a3 = event("s1", a2.hash, "s1 third", H11 + 500);
	const events = [a1, b1, a2, b2, a3];
	const ingest = new Map<string, number>([
		[a1.id, H10 + 1_100],
		[b1.id, H10 + 1_100],
		[a2.id, H10 + 2_100],
		[b2.id, H10 + 3_100],
		[a3.id, H11 + 600],
	]);
	const leaves = (hour: number): string[] =>
		events
			.filter((e) => Math.floor((ingest.get(e.id) ?? 0) / 3_600_000) * 3_600_000 === hour)
			.sort((x, y) => (ingest.get(x.id) ?? 0) - (ingest.get(y.id) ?? 0) || (x.id < y.id ? -1 : 1))
			.map((e) => e.hash);
	const receipt = (hour: number): AnchorRow => ({
		period_start: new Date(hour).toISOString(),
		period_end: new Date(hour + 3_600_000).toISOString(),
		root: merkleRootHex(leaves(hour)),
		event_count: leaves(hour).length,
		memo: "memo",
		tx_sig: "sig",
		signer: "signer",
		cluster: "devnet",
		slot: 1,
		anchored_at: new Date(hour + 3_900_000).toISOString(),
		stale_hashes: null,
	});
	return { events, ingest, anchors: [receipt(H10), receipt(H11)] };
}

/** A ledger that pages the fixture the way the real seam does: `(ts, id)` keyset, a limit, ingest by id, anchors every page. */
function ledgerOf(fx: Fixture): { exportWindow(query: ExportWindowQuery): Promise<ExportPage>; calls: ExportWindowQuery[] } {
	const calls: ExportWindowQuery[] = [];
	const rows = fx.events
		.map((e) => ({ ...e, ts: Date.parse(e.ts), payload: JSON.stringify(e.payload) }))
		.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	return {
		calls,
		async exportWindow(query) {
			calls.push(query);
			const from = Date.parse(query.from);
			const to = Date.parse(query.to);
			const limit = query.limit ?? 500;
			const after = query.after;
			const page = rows
				.filter((r) => r.ts >= from && r.ts < to)
				.filter((r) => !after || r.ts > Date.parse(after.ts) || (r.ts === Date.parse(after.ts) && r.id > after.id))
				.slice(0, limit);
			const last = page[page.length - 1];
			return {
				events: page.map((r) => ({ ...r })),
				ingest: page.flatMap((r) => {
					const at = fx.ingest.get(r.id);
					return at === undefined ? [] : [{ event_id: r.id, ingested_at: new Date(at).toISOString(), event_ts: new Date(r.ts).toISOString() }];
				}),
				anchors: fx.anchors,
				next: page.length === limit && last ? { ts: new Date(last.ts).toISOString(), id: last.id } : null,
			};
		},
	};
}

const okDf = mountedDf();

describe("archiveWindow", () => {
	test("archives a closed day to four files in bounded pages, and the archive verifies", async () => {
		const fx = fixture();
		const ledger = ledgerOf(fx);
		const dir = outDir("good");
		const manifest = await archiveWindow(ledger, { day: DAY, outDir: dir, pageSize: 2, now: () => NOW, df: okDf, cwd: ROOT, releaseSha: "abc1234" });

		const files = archiveFiles(DAY);
		expect(readdirSync(dir).sort()).toEqual([files.anchors, files.events, files.ingest, files.manifest].sort());
		expect(ledger.calls.length).toBe(3);
		// The second page resumes after the first page's last row — one of the two
		// events that share the first millisecond, whichever id sorts higher.
		expect(ledger.calls[1]?.after?.ts).toBe(fx.events[0]?.ts ?? "");
		expect(ledger.calls[2]?.after?.id).toBe(fx.events[3]?.id ?? "");
		expect(manifest).toMatchObject({
			day: DAY,
			counts: { events: 5, ingest: 5, ingestMissing: 0, anchors: 2 },
			releaseSha: "abc1234",
			writtenAt: new Date(NOW).toISOString(),
		});
		expect(Object.keys(manifest.hourlyRoots)).toEqual([new Date(H10).toISOString(), new Date(H11).toISOString()]);
		expect(manifest.hourlyRoots[new Date(H10).toISOString()]).toBe(fx.anchors[0]?.root ?? "");
		expect(manifest.chainTip).toBe(fx.events[4]?.hash ?? "");
		expect(manifest.last).toEqual({ ts: fx.events[4]?.ts ?? "", id: fx.events[4]?.id ?? "" });
		expect(Object.keys(manifest.sha256).sort()).toEqual([files.anchors, files.events, files.ingest].sort());
		// Every event line is the hashed shape, one per line.
		const lines = readFileSync(join(dir, files.events), "utf8").trim().split("\n");
		expect(lines).toHaveLength(5);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ kind: "note", payload: {}, prev: null });

		const report = verifyArchive(dir, DAY);
		expect(report.mismatches).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.hours).toEqual({ verified: 2, partial: 0, unanchored: 0, mismatched: 0 });
		expect(formatVerifyReport(report)).toContain(`verify ${DAY} in ${dir}: ok`);
		expect(archivedDays(dir)).toEqual([DAY]);
	});

	test("a flipped byte in the events file is a sha256 and a hash mismatch naming the event", async () => {
		const fx = fixture();
		const dir = outDir("flipped");
		await archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		const path = join(dir, archiveFiles(DAY).events);
		writeFileSync(path, readFileSync(path, "utf8").replace("s1 second", "s1 sec0nd"));

		const report = verifyArchive(dir, DAY);
		expect(report.ok).toBe(false);
		expect(report.mismatches.map((m) => m.kind)).toEqual(["sha256", "hash"]);
		expect(report.mismatches[1]).toMatchObject({ kind: "hash", event: fx.events[2]?.id });
		expect(formatVerifyReport(report)).toContain(`hash     an event's hash does not match its contents (${fx.events[2]?.id}): hash `);
	});

	test("an edited hourly root in the manifest is a root mismatch naming the hour, and nothing else", async () => {
		const dir = outDir("root");
		await archiveWindow(ledgerOf(fixture()), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		const path = join(dir, archiveFiles(DAY).manifest);
		const manifest = JSON.parse(readFileSync(path, "utf8")) as { hourlyRoots: Record<string, string> };
		manifest.hourlyRoots[new Date(H11).toISOString()] = "0".repeat(64);
		writeFileSync(path, JSON.stringify(manifest));

		const report = verifyArchive(dir, DAY);
		expect(report.mismatches).toEqual([
			{ kind: "root", hour: new Date(H11).toISOString(), detail: expect.stringContaining("differs from manifest") },
		]);
		// The receipt still agrees with the files: the manifest is what was tampered with.
		expect(report.hours.verified).toBe(2);
	});

	test("a fork — two events claiming one prev — is a chain mismatch; a prev outside the window is not", async () => {
		const fx = fixture();
		const a1 = fx.events[0] as SubstrateEvent;
		const forked = event("s1", a1.hash, "s1 second, again", H10 + 2_500);
		// And a session continuing from yesterday: its prev is not in this archive.
		const continued = event("s3", "e".repeat(64), "s3 continues", H10 + 4_000);
		fx.events.push(forked, continued);
		fx.ingest.set(forked.id, H10 + 2_600);
		fx.ingest.set(continued.id, H10 + 4_100);
		const dir = outDir("fork");
		await archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });

		const report = verifyArchive(dir, DAY);
		const chain = report.mismatches.filter((m) => m.kind === "chain");
		expect(chain).toHaveLength(1);
		expect(chain[0]?.detail).toContain("fork");
		expect(report.mismatches.some((m) => m.event === continued.id)).toBe(false);
		// Hour 10 now holds more members than its receipt counted: partial, not a mismatch.
		expect(report.hours).toMatchObject({ partial: 1, verified: 1 });
	});

	test("a receipt whose root differs at equal count is an anchor mismatch; a missing receipt is unanchored", async () => {
		const fx = fixture();
		const bad = fx.anchors[1] as AnchorRow;
		fx.anchors = [{ ...bad, root: "1".repeat(64) }];
		const dir = outDir("receipt");
		await archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });

		const report = verifyArchive(dir, DAY);
		expect(report.mismatches).toEqual([{ kind: "anchor", hour: new Date(H11).toISOString(), detail: expect.stringContaining("receipt") }]);
		expect(report.hours).toEqual({ verified: 0, partial: 0, unanchored: 1, mismatched: 1 });
	});

	test("a missing or unparseable archive is reported, never thrown", () => {
		const dir = outDir("absent");
		expect(verifyArchive(dir, DAY).mismatches).toEqual([{ kind: "missing", file: archiveFiles(DAY).manifest, detail: expect.stringContaining("no manifest") }]);
		writeFileSync(join(dir, archiveFiles(DAY).manifest), "{not json");
		expect(verifyArchive(dir, DAY).mismatches[0]?.kind).toBe("manifest");
		expect(verifyArchive(join(scratch, "never-made"), DAY).ok).toBe(false);
	});

	test("refuses before writing: a filesystem below the floor, an unreadable df, the working tree, the release root, a checkout, an unclosed day, an archived day", async () => {
		const fx = fixture();
		const dir = outDir("refused");
		const low = archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: mountedDf(4 * 1024 * 1024), cwd: ROOT });
		await expect(low).rejects.toThrow(ArchiveRefused);
		await expect(low).rejects.toThrow("SUBSTRATE_DEPLOY_MIN_FREE_GB=5");
		// An unreadable df refuses at the floor by name; a floor of 0 disables it, as it does for the deploy script.
		await expect(archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: () => null, cwd: ROOT })).rejects.toThrow("cannot read free space");
		// An unreadable stat refuses at the mount gate: no proof the path is a dedicated mount.
		await expect(archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, dev: () => null, cwd: ROOT })).rejects.toThrow("dedicated mount");
		const ledger = ledgerOf(fx);
		await archiveWindow(ledger, { day: DAY, outDir: dir, now: () => NOW, df: () => null, minFreeGb: 0, cwd: ROOT });
		expect(ledger.calls.length).toBeGreaterThan(0);
		// Now the day is archived: a second run refuses rather than rewriting a verified file.
		await expect(archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT })).rejects.toThrow("already archived");

		const untouched = ledgerOf(fx);
		for (const out of [ROOT, join(ROOT, "archive"), "/opt/agent-substrate/current/archive", "/"]) {
			await expect(archiveWindow(untouched, { day: DAY, outDir: out, now: () => NOW, df: okDf, cwd: ROOT })).rejects.toThrow(ArchiveRefused);
		}
		// The repo is a checkout even when the command runs from elsewhere.
		expect(refusedOutDir(ROOT, { cwd: scratch })).toContain("checkout");
		expect(refusedOutDir(join(scratch, "fine"), { cwd: ROOT })).toBeNull();
		await expect(archiveWindow(untouched, { day: "2026-10-13", outDir: outDir("open"), now: () => NOW, df: okDf, cwd: ROOT })).rejects.toThrow("not closed");
		await expect(archiveWindow(untouched, { day: "13/10/2026", outDir: outDir("bad-day"), now: () => NOW, df: okDf, cwd: ROOT })).rejects.toThrow("YYYY-MM-DD");
		expect(untouched.calls).toEqual([]);
		expect(readdirSync(outDir("open"))).toEqual([]);
	});

	test("refuses a directory on the root filesystem — an unmounted archive volume — before creating it, unless the rootfs override is set", async () => {
		const fx = fixture();
		// The configured path's parent exists on the root disk; the volume is not mounted.
		const parent = outDir("unmounted");
		const dir = join(parent, "ledger-archive");
		const asked: string[] = [];
		const onRootDisk: DevReader = (path) => {
			asked.push(path);
			return 1;
		};
		const untouched = ledgerOf(fx);
		const refused = archiveWindow(untouched, { day: DAY, outDir: dir, now: () => NOW, df: okDf, dev: onRootDisk, cwd: ROOT });
		await expect(refused).rejects.toThrow(ArchiveRefused);
		await expect(refused).rejects.toThrow("root filesystem");
		await expect(refused).rejects.toThrow("SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1");
		// Asked of the existing parent, never of the directory it would have created — which it did not.
		expect(asked[0]).toBe(parent);
		expect(existsSync(dir)).toBe(false);
		expect(untouched.calls).toEqual([]);

		// A volume mounted somewhere else but on the release root's device is the same mistake.
		const releaseRoot = outDir("release-root");
		const sharesRelease: DevReader = (path) => (path === "/" ? 1 : 7);
		expect(refusedMount(dir, { cwd: ROOT, dev: sharesRelease, releaseRoot })).toContain("release root");
		// A different device passes, the release root being on the root disk. No df is consulted: two tmpfs
		// or overlay mounts carry the same df name and are different filesystems, and the device number says so.
		const volumeOnly: DevReader = (path) => (path === "/" || path === releaseRoot ? 1 : 7);
		expect(refusedMount(dir, { cwd: ROOT, dev: volumeOnly, releaseRoot })).toBeNull();
		// An unreadable stat is not proof: refuse.
		expect(refusedMount(dir, { cwd: ROOT, dev: () => null, releaseRoot })).toContain("cannot read the filesystem");
		// The real reader answers a number for a path that exists and `null` for one that does not.
		expect(typeof devReader("/")).toBe("number");
		expect(devReader(join(scratch, "never-made"))).toBeNull();

		// The override is for a deliberate one-disk test: the directory is then created and the day archives.
		const manifest = await archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, dev: onRootDisk, allowRootfs: true, cwd: ROOT });
		expect(manifest.counts.events).toBe(5);
		expect(existsSync(join(dir, archiveFiles(DAY).manifest))).toBe(true);
	});

	test("two same-session events claiming a predecessor from another day are a fork, not a continuation", async () => {
		const fx = fixture();
		const yesterday = "e".repeat(64);
		const one = event("s3", yesterday, "s3 continues", H10 + 4_000);
		const two = event("s3", yesterday, "s3 continues, again", H10 + 4_500);
		fx.events.push(one, two);
		fx.ingest.set(one.id, H10 + 4_100);
		fx.ingest.set(two.id, H10 + 4_600);
		const dir = outDir("external-fork");
		await archiveWindow(ledgerOf(fx), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });

		const report = verifyArchive(dir, DAY);
		const chain = report.mismatches.filter((m) => m.kind === "chain");
		expect(chain).toEqual([{ kind: "chain", event: two.id, detail: expect.stringContaining("fork") }]);
		expect(chain[0]?.detail).toContain(one.id);
	});

	test("a refused ledger note leaves a retry marker beside the manifest, a later run sends only the note, and success clears the marker without touching the day files", async () => {
		const dir = outDir("note-retry");
		const manifest = await archiveWindow(ledgerOf(fixture()), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		const files = archiveFiles(DAY);
		const dayFiles = [files.events, files.ingest, files.anchors, files.manifest];
		const snapshot = (): string[] => dayFiles.map((name) => readFileSync(join(dir, name), "utf8"));
		const before = snapshot();

		// The ledger refuses the note: files stay, a marker records what to resend.
		const refused: NoteOutcome = { stored: false, error: "greptime unreachable" };
		const first = await recordArchiveNote(dir, manifest, async () => refused, () => NOW);
		expect(first.stored).toBe(false);
		expect(pendingNoteDays(dir)).toEqual([DAY]);
		expect(readPendingNote(dir, DAY)).toEqual({
			day: DAY,
			note: archiveNote(manifest),
			attempts: 1,
			lastError: "greptime unreachable",
			firstAttemptAt: new Date(NOW).toISOString(),
		});
		// The marker is not mistaken for an archive: the day still has exactly its manifest, and no `.part` survives.
		expect(archivedDays(dir)).toEqual([DAY]);
		expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);
		expect(daysToArchive({ firstDay: DAY, until: DAY, dir })).toEqual([]);

		// Still refused on the next run: the same note is resent, attempts climb, the first failure time stays.
		const sent: EventInput[] = [];
		const stillDown = await retryPendingNotes(dir, async (input) => {
			sent.push(input);
			return refused;
		});
		expect(stillDown).toEqual({ sent: [], pending: [{ day: DAY, attempts: 2, lastError: "greptime unreachable" }] });
		expect(readPendingNote(dir, DAY)?.firstAttemptAt).toBe(new Date(NOW).toISOString());
		expect(existsSync(join(dir, pendingNoteFile(DAY)))).toBe(true);

		// The ledger is back: the note goes out once, byte for byte what the first attempt would have sent, and the marker is gone.
		const recovered = await retryPendingNotes(dir, async (input) => {
			sent.push(input);
			return { stored: true };
		});
		expect(recovered).toEqual({ sent: [DAY], pending: [] });
		expect(sent).toEqual([archiveNote(manifest), archiveNote(manifest)]);
		expect(pendingNoteDays(dir)).toEqual([]);
		expect(existsSync(join(dir, pendingNoteFile(DAY)))).toBe(false);
		// A run with nothing pending sends nothing.
		expect(await retryPendingNotes(dir, async () => ({ stored: true }))).toEqual({ sent: [], pending: [] });

		// None of it rewrote the completed day.
		expect(snapshot()).toEqual(before);
		expect(verifyArchive(dir, DAY).ok).toBe(true);
	});

	test("a note stored on the first attempt leaves no marker, and a stored resend through recordArchiveNote clears an old one; an unreadable marker stays pending", async () => {
		const dir = outDir("note-clear");
		const manifest = await archiveWindow(ledgerOf(fixture()), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		expect((await recordArchiveNote(dir, manifest, async () => ({ stored: true }))).stored).toBe(true);
		expect(pendingNoteDays(dir)).toEqual([]);

		await recordArchiveNote(dir, manifest, async () => ({ stored: false }), () => NOW);
		expect(pendingNoteDays(dir)).toEqual([DAY]);
		expect(readPendingNote(dir, DAY)?.lastError).toBeNull();
		await recordArchiveNote(dir, manifest, async () => ({ stored: true }));
		expect(pendingNoteDays(dir)).toEqual([]);

		// A marker that does not parse cannot be resent from: it is reported pending, never silently dropped.
		writeFileSync(join(dir, pendingNoteFile(DAY)), "{not json");
		const outcome = await retryPendingNotes(dir, async () => ({ stored: true }));
		expect(outcome.sent).toEqual([]);
		expect(outcome.pending).toEqual([{ day: DAY, attempts: 0, lastError: "marker does not parse" }]);
		expect(existsSync(join(dir, pendingNoteFile(DAY)))).toBe(true);
	});

	test("the marker is on disk before the note is sent, so a throwing emit leaves it; one bad marker does not stop the others being sent", async () => {
		const dir = outDir("note-throw");
		const manifest = await archiveWindow(ledgerOf(fixture()), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		const marker = join(dir, pendingNoteFile(DAY));
		// Present while the emit is in flight: a process killed here still owes the note.
		let seenDuring = false;
		const thrown = await recordArchiveNote(
			dir,
			manifest,
			async () => {
				seenDuring = existsSync(marker);
				throw new Error("invalid input");
			},
			() => NOW,
		);
		expect(seenDuring).toBe(true);
		expect(thrown).toEqual({ stored: false, error: "invalid input" });
		expect(readPendingNote(dir, DAY)).toMatchObject({ attempts: 1, lastError: "invalid input", firstAttemptAt: new Date(NOW).toISOString() });
		expect(verifyArchive(dir, DAY).ok).toBe(true);

		// An older day whose marker parses but whose note the ledger will not take: emit throws for it.
		const other = "2026-10-11";
		const bad = { surface: "substrate", kind: "note", summary: "ledger archive 2026-10-11: bad" };
		writeFileSync(
			join(dir, pendingNoteFile(other)),
			JSON.stringify({ day: other, note: bad, attempts: 3, lastError: null, firstAttemptAt: new Date(NOW).toISOString() }),
		);
		const outcome = await retryPendingNotes(dir, async (input) => {
			if (input.summary.includes("bad")) throw new Error("emit refused the summary");
			return { stored: true };
		});
		// The loop went past it: this day's note was sent, the bad one is pending with its attempts counted.
		expect(outcome.sent).toEqual([DAY]);
		expect(outcome.pending).toEqual([{ day: other, attempts: 4, lastError: "emit refused the summary" }]);
		expect(pendingNoteDays(dir)).toEqual([other]);
		expect(existsSync(marker)).toBe(false);
	});

	test("a failed page leaves no data file behind, only nothing", async () => {
		const dir = outDir("crash");
		const broken = {
			async exportWindow(): Promise<ExportPage> {
				throw new Error("greptime unreachable");
			},
		};
		await expect(archiveWindow(broken, { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT })).rejects.toThrow("unreachable");
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("days, windows and the floor reading", () => {
	test("a day closes at midnight plus the ingest lag, and yesterday is the newest closed day after that", () => {
		expect(dayWindow(DAY)).toEqual({ from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" });
		expect(isDayClosed(DAY, Date.UTC(2026, 9, 13, 0, 4))).toBe(false);
		expect(isDayClosed(DAY, Date.UTC(2026, 9, 13, 0, 5))).toBe(true);
		expect(newestClosedDay(Date.UTC(2026, 9, 13, 0, 4))).toBeNull();
		expect(newestClosedDay(NOW)).toBe(DAY);
		expect(() => dayWindow("2026-02-30")).toThrow(ArchiveRefused);
	});

	test("daysToArchive lists every day up to --until without a manifest, ascending", () => {
		const dir = outDir("days");
		writeFileSync(join(dir, "manifest-2026-10-10.json"), "{}");
		expect(daysToArchive({ firstDay: "2026-10-09", until: "2026-10-12", dir })).toEqual(["2026-10-09", "2026-10-11", "2026-10-12"]);
		expect(daysToArchive({ firstDay: "2026-10-13", until: "2026-10-12", dir })).toEqual([]);
	});

	test("freeKbOf reads the fourth field of df's second line and nothing else", () => {
		expect(freeKbOf(dfWith(12345))).toBe(12345);
		expect(freeKbOf("")).toBeNull();
		expect(freeKbOf(null)).toBeNull();
		expect(freeKbOf("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sdz 1 1 lots 1% /\n")).toBeNull();
	});

	test("releaseShaOf names the release only from a releases/<sha> tree", () => {
		const releases = join(scratch, "releases", "0123abcd");
		mkdirSync(releases, { recursive: true });
		expect(releaseShaOf(releases)).toBe("0123abcd");
		expect(releaseShaOf(scratch)).toBeUndefined();
		expect(releaseShaOf(join(scratch, "missing"))).toBeUndefined();
	});
});

describe("the runner's grammar", () => {
	test("parses each subcommand and refuses what the runner cannot act on", () => {
		expect(parseLedgerArgs(["coverage", "--json"])).toEqual({ command: "coverage", json: true });
		expect(parseLedgerArgs(["archive", "--until", DAY, "--out", "/mnt/a", "--page-size", "100"])).toEqual({
			command: "archive",
			until: DAY,
			out: "/mnt/a",
			pageSize: 100,
			json: false,
		});
		expect(parseLedgerArgs(["archive"])).toEqual({ command: "archive", until: undefined, out: undefined, pageSize: undefined, json: false });
		expect(parseLedgerArgs(["verify-archive", "/mnt/a", "--day", DAY])).toEqual({ command: "verify-archive", dir: "/mnt/a", day: DAY, json: false });
		for (const argv of [
			[],
			["prune"],
			["coverage", "extra"],
			["archive", "--out", ""],
			["archive", "--out"],
			["archive", "--until", "yesterday"],
			["archive", "--page-size", "0"],
			["archive", "--apply"],
			["verify-archive"],
			["verify-archive", "/a", "/b"],
		]) {
			expect(() => parseLedgerArgs(argv)).toThrow(LedgerUsageError);
		}
		expect(() => parseLedgerArgs(["archive", "--out", ""])).toThrow("SUBSTRATE_LEDGER_ARCHIVE_DIR");
	});

	test("formatCoverage lists the uncovered hours and the last archive", () => {
		const text = formatCoverage(
			{ newestAnchoredHour: "2026-10-12T10:00:00.000Z", lagHours: 2, uncoveredHours: ["2026-10-12T11:00:00.000Z"], more: false, lastArchiveWindow: null },
			2,
		);
		expect(text).toContain("anchor lag            2 h");
		expect(text).toContain("uncovered hours       1 (limit 2)");
		expect(text).toContain("    2026-10-12T11:00:00.000Z");
		expect(text).toContain("none recorded");
	});

	test("formatVerifyReport prints one fixed sentence per mismatch kind, then where and the detail", () => {
		const report = {
			ok: false,
			day: DAY,
			dir: "/mnt/a",
			counts: { events: 5, ingest: 5, anchors: 2 },
			hours: { verified: 1, partial: 0, unanchored: 0, mismatched: 1 },
			mismatches: [
				{ kind: "sha256" as const, file: "events-2026-10-12.ndjson", detail: "sha256 aa differs from manifest bb" },
				{ kind: "count" as const, file: "ingest-2026-10-12.ndjson", detail: "6 lines, manifest counts 5" },
				{ kind: "hash" as const, event: "evt_1", detail: "hash cc does not match contents (dd)" },
				{ kind: "chain" as const, event: "evt_2", detail: "session s1: prev ee… is also claimed by evt_1 (fork)" },
				{ kind: "root" as const, hour: "2026-10-12T11:00:00.000Z", detail: "recomputed ff differs from manifest 00" },
				{ kind: "anchor" as const, hour: "2026-10-12T11:00:00.000Z", detail: "recomputed ff differs from the receipt 11 at equal count 1" },
			],
		};
		const lines = formatVerifyReport(report).split("\n");
		expect(lines[0]).toBe(`verify ${DAY} in /mnt/a: 6 mismatches`);
		expect(lines.slice(3, 9)).toEqual([
			"  sha256   a file's digest differs from the manifest (events-2026-10-12.ndjson): sha256 aa differs from manifest bb",
			"  count    a file's line count differs from the manifest (ingest-2026-10-12.ndjson): 6 lines, manifest counts 5",
			"  hash     an event's hash does not match its contents (evt_1): hash cc does not match contents (dd)",
			"  chain    the chain does not link (evt_2): session s1: prev ee… is also claimed by evt_1 (fork)",
			"  root     an hourly root differs from the manifest (2026-10-12T11:00:00.000Z): recomputed ff differs from manifest 00",
			"  anchor   an hourly root differs from its receipt (2026-10-12T11:00:00.000Z): recomputed ff differs from the receipt 11 at equal count 1",
		]);
	});
});

describe("ledger-run.ts as a process", () => {
	const RUNNER = join(import.meta.dir, "ledger-run.ts");
	function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
		const result = Bun.spawnSync({
			cmd: [process.execPath, RUNNER, ...args],
			env: { PATH: process.env.PATH ?? "", ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	}

	test("verify-archive exits 0 on a good archive and 2 once a byte is flipped, with no ledger configured", async () => {
		const dir = outDir("process");
		await archiveWindow(ledgerOf(fixture()), { day: DAY, outDir: dir, now: () => NOW, df: okDf, cwd: ROOT });
		const good = run(["verify-archive", dir, "--json"]);
		expect(good.status).toBe(0);
		expect(JSON.parse(good.stdout.trim())).toMatchObject({ ok: true, day: DAY });

		const path = join(dir, archiveFiles(DAY).ingest);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"event_id":"evt_ghost","ingested_at":"2026-10-12T10:00:00.000Z","event_ts":"2026-10-12T10:00:00.000Z"}\n`);
		const bad = run(["verify-archive", dir]);
		expect(bad.status).toBe(2);
		expect(bad.stdout).toContain("sha256");
		expect(bad.stdout).toContain("evt_ghost");

		expect(run(["verify-archive", outDir("empty")]).status).toBe(1);
	});

	test("usage and refusals exit 2 before touching anything", () => {
		expect(run(["prune"]).status).toBe(2);
		expect(run(["archive", "--out", ""]).stderr).toContain("SUBSTRATE_LEDGER_ARCHIVE_DIR");
		// No ledger in the environment: coverage and archive refuse with usage.
		const coverage = run(["coverage"]);
		expect(coverage.status).toBe(2);
		expect(coverage.stderr).toContain("GREPTIME_URL");
		expect(run(["archive", "--out", outDir("no-ledger")]).status).toBe(2);
		expect(existsSync(join(outDir("no-ledger"), archiveFiles(DAY).manifest))).toBe(false);
	});
});
