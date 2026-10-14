import { describe, expect, test } from "bun:test";
import { refusedScratchUrl } from "../packages/mcp-server/src/index-archive.ts";
import {
	INDEX_ARCHIVE_MOUNT,
	indexDrillEnabled,
	refuseIndexDrillOutDir,
	refuseIndexDrillSource,
	rehearsalHooksEnabled,
} from "./rehearsal.ts";

describe("index archive drill flags and guards", () => {
	test("only the exact string 1 enables the drill", () => {
		expect(indexDrillEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "1" })).toBe(true);
		expect(indexDrillEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "0" })).toBe(false);
		expect(indexDrillEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "true" })).toBe(false);
		expect(indexDrillEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "yes" })).toBe(false);
		expect(indexDrillEnabled({})).toBe(false);
		expect(indexDrillEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "" })).toBe(false);
	});

	test("rehearsal hooks are on for either flag and off otherwise", () => {
		expect(rehearsalHooksEnabled({})).toBe(false);
		expect(rehearsalHooksEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "1" })).toBe(true);
		expect(rehearsalHooksEnabled({ SUBSTRATE_GATE_CHAOS_PLANES: "1" })).toBe(true);
		expect(rehearsalHooksEnabled({ SUBSTRATE_GATE_INDEX_DRILL: "0", SUBSTRATE_GATE_CHAOS_PLANES: "yes" })).toBe(false);
	});

	test("the guard refuses /mnt/index-archive and a non-loopback URL", () => {
		expect(refuseIndexDrillOutDir(INDEX_ARCHIVE_MOUNT)).not.toBeNull();
		expect(refuseIndexDrillOutDir(`${INDEX_ARCHIVE_MOUNT}/index-20261014T031500Z`)).not.toBeNull();
		expect(refuseIndexDrillOutDir("/tmp/index-drill-abc")).toBeNull();
		const remote = refuseIndexDrillSource("postgres://postgres:secret@db.internal:5432/postgres");
		expect(remote).not.toBeNull();
		expect(remote).not.toContain("secret");
		expect(refuseIndexDrillSource("postgres://postgres:secret@127.0.0.1:5432/postgres")).toBeNull();
	});

	test("refusedScratchUrl is null when only the database name differs and non-null when source is compared to itself", () => {
		const source = "postgres://postgres:secret@127.0.0.1:5432/postgres";
		const scratch = "postgres://postgres:secret@127.0.0.1:5432/gate_idx_gate";
		expect(refusedScratchUrl(scratch, source)).toBeNull();
		const same = refusedScratchUrl(source, source);
		expect(same).not.toBeNull();
		expect(same).not.toContain("secret");
	});
});
