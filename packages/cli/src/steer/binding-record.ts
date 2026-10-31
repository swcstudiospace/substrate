import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const LIVE_SESSION_ID_PATTERN = /^ls_[0-9a-f]{64}$/;
export const SESSION_BINDING_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_BINDING_BYTES = 4096;
export const MAX_BINDING_RECORDS = 256;
export interface LiveSessionBindingRecord {
	version: 1;
	server_identity: string;
	surface: string;
	session_id: string;
	session_binding: string;
	expires_at: string;
}
export type BindingExpected = Pick<LiveSessionBindingRecord, "server_identity" | "surface" | "session_id">;
export interface BindingRecordOptions { directory?: string; path?: string }
export class BindingRecordError extends Error {
	constructor(readonly code: "missing" | "invalid" | "unavailable") {
		super(code === "missing" ? "the selected private binding record is missing" : code === "invalid" ? "the selected private binding record is unsafe, invalid or does not match" : "the selected private binding record cannot be persisted or locked");
	}
}

/** Reject URL credentials and hidden request state; hash the canonical configured endpoint, never a bearer. */
export function serverIdentity(url: string): string {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || url.includes("?") || url.includes("#") || /^[a-z]+:\/\/[^/]*@/i.test(url)) throw new Error();
		return createHash("sha256").update(parsed.toString().replace(/\/+$/, "")).digest("hex");
	} catch { throw new BindingRecordError("invalid"); }
}

export function bindingRecordPath(server: string, surface: string, session: string, options: BindingRecordOptions = {}): string {
	if (!/^[0-9a-f]{64}$/.test(server) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(surface) || !LIVE_SESSION_ID_PATTERN.test(session)) throw new BindingRecordError("invalid");
	if (options.path !== undefined) return resolve(options.path);
	const digest = createHash("sha256").update(JSON.stringify([server, surface, session])).digest("hex");
	return join(options.directory ?? join(homedir(), ".local", "state", "substrate", "live-sessions"), `${digest}.json`);
}

function checked(value: unknown, expected: BindingExpected): LiveSessionBindingRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BindingRecordError("invalid");
	const rec = value as Record<string, unknown>;
	const fields = ["version", "server_identity", "surface", "session_id", "session_binding", "expires_at"];
	if (Object.keys(rec).length !== fields.length || fields.some((key) => !Object.hasOwn(rec, key)) || rec.version !== 1 ||
		rec.server_identity !== expected.server_identity || !/^[0-9a-f]{64}$/.test(expected.server_identity) ||
		rec.surface !== expected.surface || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expected.surface) ||
		rec.session_id !== expected.session_id || !LIVE_SESSION_ID_PATTERN.test(expected.session_id) ||
		typeof rec.session_binding !== "string" || !SESSION_BINDING_PATTERN.test(rec.session_binding) ||
		typeof rec.expires_at !== "string" || !Number.isFinite(Date.parse(rec.expires_at))) throw new BindingRecordError("invalid");
	return { version: 1, server_identity: expected.server_identity, surface: expected.surface, session_id: expected.session_id, session_binding: rec.session_binding, expires_at: rec.expires_at };
}

function secureDirectory(path: string, create: boolean): void {
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	const uid = process.getuid?.();
	let current = resolve(path);
	for (;;) {
		const stat = lstatSync(current);
		const trustedSticky = (stat.mode & 0o1000) !== 0 && stat.uid === 0;
		if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !trustedSticky) || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) throw new BindingRecordError("invalid");
		if (current === resolve(path) && ((stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid))) throw new BindingRecordError("invalid");
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

function readBindingRecord(path: string, expected: BindingExpected): { record: LiveSessionBindingRecord; dev: number; ino: number } {
	let fd: number | undefined;
	try {
		secureDirectory(dirname(path), false);
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid !== undefined && stat.uid !== process.getuid()) || stat.size > MAX_BINDING_BYTES) throw new BindingRecordError("invalid");
		const buffer = Buffer.alloc(MAX_BINDING_BYTES + 1);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		if (size > MAX_BINDING_BYTES) throw new BindingRecordError("invalid");
		const record = checked(JSON.parse(buffer.subarray(0, size).toString("utf8")), expected);
		const identity = { dev: stat.dev, ino: stat.ino };
		assertSameFile(path, identity);
		return { record, ...identity };
	} catch (error) {
		if (error instanceof BindingRecordError) throw error;
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new BindingRecordError("missing");
		throw new BindingRecordError("invalid");
	} finally { if (fd !== undefined) closeSync(fd); }
}

function assertSameFile(path: string, identity: { dev: number; ino: number }): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new BindingRecordError("invalid");
}

export function loadBindingRecord(path: string, expected: BindingExpected): LiveSessionBindingRecord {
	return readBindingRecord(path, expected).record;
}

function locked<T>(path: string, action: () => T): T {
	const lock = `${path}.lock`;
	let fd: number | undefined;
	try {
		secureDirectory(dirname(path), true);
		fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		return action();
	} catch (error) {
		if (error instanceof BindingRecordError) throw error;
		throw new BindingRecordError("unavailable");
	} finally {
		if (fd !== undefined) { closeSync(fd); unlinkSync(lock); }
	}
}

function publish(path: string, record: LiveSessionBindingRecord): void {
	const temp = `${path}.${randomBytes(16).toString("hex")}.tmp`;
	let fd: number | undefined;
	let created = false;
	try {
		const body = JSON.stringify(record);
		if (Buffer.byteLength(body) > MAX_BINDING_BYTES) throw new BindingRecordError("invalid");
		fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		created = true;
		writeFileSync(fd, body);
		fsyncSync(fd);
		closeSync(fd); fd = undefined;
		renameSync(temp, path); created = false;
		const directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (created) unlinkSync(temp);
	}
}

export function saveBindingRecord(record: LiveSessionBindingRecord, options: BindingRecordOptions = {}): string {
	const valid = checked(record, record);
	const path = bindingRecordPath(record.server_identity, record.surface, record.session_id, options);
	return locked(join(dirname(path), ".directory"), () => locked(path, () => {
		try { lstatSync(path); throw new BindingRecordError("invalid"); }
		catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
		if (readdirSync(dirname(path)).filter((name) => name !== ".directory.lock" && name !== `${basename(path)}.lock`).length >= MAX_BINDING_RECORDS) throw new BindingRecordError("unavailable");
		publish(path, valid);
		return path;
	}));
}

export function updateBindingExpiry(path: string, expected: LiveSessionBindingRecord, expiresAt: string): void {
	locked(path, () => {
		const current = readBindingRecord(path, expected);
		if (current.record.session_binding !== expected.session_binding) throw new BindingRecordError("invalid");
		const updated = checked({ ...current.record, expires_at: expiresAt }, expected);
		assertSameFile(path, current);
		publish(path, updated);
	});
}

export function removeBindingRecord(path: string, expected: LiveSessionBindingRecord): void {
	locked(path, () => {
		const current = readBindingRecord(path, expected);
		if (current.record.session_binding !== expected.session_binding) throw new BindingRecordError("invalid");
		assertSameFile(path, current);
		unlinkSync(path);
	});
}
