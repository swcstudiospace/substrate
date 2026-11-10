import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingRecordError, MAX_BINDING_BYTES, MAX_BINDING_RECORDS, bindingRecordPath, loadBindingRecord, reclaimDeadBindingRecords, removeBindingRecord, saveBindingRecord, serverIdentity, updateBindingExpiry, type LiveSessionBindingRecord } from "./binding-record.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = (): string => { const root = mkdtempSync(join(tmpdir(), "substrate-binding-")); roots.push(root); return root; };
const record = (id = 1): LiveSessionBindingRecord => ({ version: 1, server_identity: serverIdentity("http://127.0.0.1:7410"), surface: "omp", session_id: `ls_${id.toString(16).padStart(64, "0")}`, session_binding: "a".repeat(64), expires_at: "2026-11-01T01:00:00.000Z" });
const refused = (action: () => unknown, code?: BindingRecordError["code"]): void => {
	try { action(); throw new Error("expected a binding refusal"); }
	catch (error) { expect(error).toBeInstanceOf(BindingRecordError); if (error instanceof BindingRecordError && code !== undefined) expect(error.code).toBe(code); expect(String(error)).not.toContain("a".repeat(64)); }
};
const refusedAsync = async (action: () => Promise<unknown>, code: BindingRecordError["code"]): Promise<void> => {
	try { await action(); throw new Error("expected a binding refusal"); }
	catch (error) { expect(error).toBeInstanceOf(BindingRecordError); if (error instanceof BindingRecordError) expect(error.code).toBe(code); expect(String(error)).not.toContain("a".repeat(64)); }
};

describe("private live binding records", () => {
	test("canonical server identity rejects hidden credentials and request state", () => {
		expect(serverIdentity("http://LOCALHOST:80///")).toBe(serverIdentity("http://localhost"));
		for (const url of ["http://user:secret@localhost", "http://localhost/?token=x", "http://localhost/#secret", "file:///tmp/a"]) refused(() => serverIdentity(url), "invalid");
	});
	test("publishes a0600 record in0700 directory, leaves no temp or lock, and selects exact context", () => {
		const dir = join(directory(), "new");
		const value = record();
		const path = saveBindingRecord(value, { directory: dir });
		expect(path).toBe(bindingRecordPath(value.server_identity, value.surface, value.session_id, { directory: dir }));
		expect(lstatSync(dir).mode & 0o777).toBe(0o700);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(loadBindingRecord(path, value)).toEqual(value);
		expect(readdirSync(dir)).toEqual([path.split("/").at(-1) as string]);
		for (const expected of [{ ...value, surface: "claude-code" }, { ...value, server_identity: "b".repeat(64) }, record(2)]) refused(() => loadBindingRecord(path, expected), "invalid");
	});
	test("refuses overwrite and existing corrupt targets without credential repair", () => {
		const dir = directory(); const value = record();
		const path = saveBindingRecord(value, { directory: dir });
		refused(() => saveBindingRecord({ ...value, session_binding: "b".repeat(64) }, { directory: dir }), "invalid");
		expect(loadBindingRecord(path, value)).toEqual(value);
		writeFileSync(path, "not-json", { mode: 0o600 });
		refused(() => loadBindingRecord(path, value), "invalid");
		refused(() => saveBindingRecord(value, { directory: dir }), "invalid");
		expect(readFileSync(path, "utf8")).toBe("not-json");
	});
	test("rejects unsafe existing directory and file modes, symlinks, hardlinks and oversized files", () => {
		const dir = directory(); const value = record(); const path = saveBindingRecord(value, { directory: dir });
		chmodSync(path, 0o644); refused(() => loadBindingRecord(path, value), "invalid"); chmodSync(path, 0o600);
		chmodSync(dir, 0o755); refused(() => loadBindingRecord(path, value), "invalid"); refused(() => saveBindingRecord(record(2), { directory: dir }), "invalid"); chmodSync(dir, 0o700);
		const alias = join(dir, "alias"); symlinkSync(path, alias); refused(() => loadBindingRecord(alias, value), "invalid");
		const hard = join(dir, "hard"); linkSync(path, hard); refused(() => loadBindingRecord(path, value), "invalid"); rmSync(hard);
		writeFileSync(path, "x".repeat(MAX_BINDING_BYTES + 1)); refused(() => loadBindingRecord(path, value), "invalid");
		const linkedDir = join(directory(), "linked"); symlinkSync(dir, linkedDir); refused(() => loadBindingRecord(join(linkedDir, path.split("/").at(-1) as string), value), "invalid");
	});
	test("checks ancestors above a sticky directory before writing credentials", () => {
		const root = directory();
		const unsafe = join(root, "unsafe");
		const sticky = join(unsafe, "sticky");
		mkdirSync(unsafe, { mode: 0o777 });
		chmodSync(unsafe, 0o777);
		mkdirSync(sticky, { mode: 0o1777 });
		chmodSync(sticky, 0o1777);
		const dir = join(sticky, "records");
		refused(() => saveBindingRecord(record(), { directory: dir }), "invalid");
		expect(readdirSync(dir)).toEqual([]);
	});
	test("rejects strict record grammar and unknown fields, without interpreting expiry as authority", () => {
		const dir = directory(); const value = record(); const path = saveBindingRecord(value, { directory: dir });
		for (const changed of [{ ...value, version: 2 }, { ...value, session_id: "historical" }, { ...value, session_binding: "z".repeat(64) }, { ...value, extra: true }, { ...value, expires_at: "bad" }]) {
			writeFileSync(path, JSON.stringify(changed)); refused(() => loadBindingRecord(path, value), "invalid");
		}
		writeFileSync(path, JSON.stringify({ ...value, expires_at: "2000-01-01T00:00:00Z" }));
		expect(loadBindingRecord(path, value).expires_at).toBe("2000-01-01T00:00:00Z");
	});
	test("existing target and directory reservations refuse rather than take over stale locks", () => {
		const dir = directory(); const value = record(); const path = bindingRecordPath(value.server_identity, value.surface, value.session_id, { directory: dir });
		writeFileSync(`${path}.lock`, "", { mode: 0o600 });
		refused(() => saveBindingRecord(value, { directory: dir }), "unavailable"); expect(existsSync(`${path}.lock`)).toBe(true); expect(existsSync(path)).toBe(false);
		rmSync(`${path}.lock`); writeFileSync(join(dir, ".directory.lock"), "", { mode: 0o600 });
		refused(() => saveBindingRecord(record(2), { directory: dir }), "unavailable"); expect(existsSync(join(dir, ".directory.lock"))).toBe(true);
	});
	test("directory cap refuses without evicting another credential and close safely frees a slot", () => {
		const dir = directory();
		for (let i = 1; i <= MAX_BINDING_RECORDS; i++) saveBindingRecord(record(i), { directory: dir });
		refused(() => saveBindingRecord(record(MAX_BINDING_RECORDS + 1), { directory: dir }), "unavailable");
		expect(readdirSync(dir).length).toBe(MAX_BINDING_RECORDS);
		const first = record(); const path = bindingRecordPath(first.server_identity, first.surface, first.session_id, { directory: dir });
		removeBindingRecord(path, first); saveBindingRecord(record(MAX_BINDING_RECORDS + 1), { directory: dir });
		expect(readdirSync(dir).length).toBe(MAX_BINDING_RECORDS);
	});
	test("expiry updates preserve exact proof; mismatched updates and removal cannot touch a sibling", () => {
		const dir = directory(); const value = record(); const path = saveBindingRecord(value, { directory: dir });
		const expires = "2026-11-01T02:00:00.000Z";
		updateBindingExpiry(path, value, expires); expect(loadBindingRecord(path, value)).toEqual({ ...value, expires_at: expires });
		const wrong = { ...value, session_binding: "b".repeat(64) };
		refused(() => updateBindingExpiry(path, wrong, expires), "invalid"); refused(() => removeBindingRecord(path, wrong), "invalid");
		expect(loadBindingRecord(path, value).session_binding).toBe(value.session_binding);
		const sibling = saveBindingRecord(record(2), { directory: dir }); removeBindingRecord(path, value);
		expect(existsSync(path)).toBe(false); expect(existsSync(sibling)).toBe(true);
	});
	test("an explicitly missing record never silently chooses another", () => {
		const dir = directory(); saveBindingRecord(record(2), { directory: dir });
		refused(() => loadBindingRecord(join(dir, "missing"), record()), "missing");
	});
	test("a dead record is cleared so a full directory takes a new session, and the rest stay untouched", async () => {
		const dir = directory();
		for (let i = 1; i <= MAX_BINDING_RECORDS; i++) saveBindingRecord(record(i), { directory: dir });
		const dead = record(1); const sibling = record(2); const seen: string[] = [];
		expect(await reclaimDeadBindingRecords(dir, async (value) => { seen.push(value.session_id); return value.session_id === dead.session_id; })).toBe(1);
		expect(seen.length).toBe(MAX_BINDING_RECORDS);
		expect(existsSync(bindingRecordPath(dead.server_identity, dead.surface, dead.session_id, { directory: dir }))).toBe(false);
		expect(lstatSync(bindingRecordPath(sibling.server_identity, sibling.surface, sibling.session_id, { directory: dir })).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).length).toBe(MAX_BINDING_RECORDS - 1);
		saveBindingRecord(record(MAX_BINDING_RECORDS + 1), { directory: dir });
		expect(readdirSync(dir).length).toBe(MAX_BINDING_RECORDS);
		refused(() => saveBindingRecord(record(MAX_BINDING_RECORDS + 2), { directory: dir }), "unavailable");
	});
	test("a live record is never cleared, so a full directory still refuses a second live open", async () => {
		const dir = directory();
		for (let i = 1; i <= MAX_BINDING_RECORDS; i++) saveBindingRecord(record(i), { directory: dir });
		expect(await reclaimDeadBindingRecords(dir, async () => false)).toBe(0);
		refused(() => saveBindingRecord(record(MAX_BINDING_RECORDS + 1), { directory: dir }), "unavailable");
		expect(readdirSync(dir).length).toBe(MAX_BINDING_RECORDS);
	});
	test("local expiry alone never clears a record, and an absent directory has nothing to clear", async () => {
		const dir = directory(); const value = { ...record(1), expires_at: "2000-01-01T00:00:00.000Z" };
		const path = saveBindingRecord(value, { directory: dir });
		expect(await reclaimDeadBindingRecords(dir, async () => false)).toBe(0);
		expect(loadBindingRecord(path, value)).toEqual(value);
		expect(await reclaimDeadBindingRecords(join(directory(), "absent"), async () => true)).toBe(0);
	});
	test("corrupt and misfiled records are explicit invalid errors, never dead", async () => {
		const dir = directory(); const seen: string[] = [];
		const dead = async (value: LiveSessionBindingRecord): Promise<boolean> => { seen.push(value.session_id); return true; };
		const corrupt = bindingRecordPath(record(1).server_identity, "omp", record(1).session_id, { directory: dir });
		writeFileSync(corrupt, "not-json", { mode: 0o600 });
		await refusedAsync(() => reclaimDeadBindingRecords(dir, dead), "invalid");
		expect(readFileSync(corrupt, "utf8")).toBe("not-json");
		rmSync(corrupt);
		const misfiled = bindingRecordPath(record(2).server_identity, "omp", record(2).session_id, { directory: dir });
		writeFileSync(misfiled, JSON.stringify(record(3)), { mode: 0o600 });
		await refusedAsync(() => reclaimDeadBindingRecords(dir, dead), "invalid");
		expect(existsSync(misfiled)).toBe(true);
		expect(seen).toEqual([]);
	});
	test("an unanswered authority check keeps its record and stops the sweep", async () => {
		const dir = directory(); const value = record(1); const path = saveBindingRecord(value, { directory: dir });
		await expect(reclaimDeadBindingRecords(dir, async () => { throw new Error("session-unavailable"); })).rejects.toThrow("session-unavailable");
		expect(loadBindingRecord(path, value)).toEqual(value);
	});
});
