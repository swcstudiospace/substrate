/**
 * Single-instance guard (DISP-01).
 *
 * Holds `flock(2)` `LOCK_EX | LOCK_NB` on the lock file for the life of the
 * returned handle via `bun:ffi` against Linux libc, copying the rehearsal
 * constants in scripts/rehearsal.ts. A busy lock reports `held: false` so the
 * caller can exit 0 before any Linear call; the kernel drops the lock when
 * the holder's descriptor closes, including on kill.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";

export const DEFAULT_DISPATCHER_LOCK_FILE = "/var/lib/substrate/dispatcher.lock";

/** Linux `flock(2)` operations. `LOCK_EX | LOCK_NB` fails instead of waiting. */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
/** Linux `EAGAIN`: the non-blocking lock is already held. */
const EAGAIN = 11;

interface FlockLib {
	flock(fd: number, operation: number): number;
	errno(): number;
}

let flockLib: FlockLib | null = null;

function dispatcherFlock(): FlockLib {
	if (flockLib !== null) return flockLib;
	const lib = dlopen("libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	const opened: FlockLib = {
		flock: (fd, operation) => lib.symbols.flock(fd, operation),
		errno: () => {
			const loc = lib.symbols.__errno_location();
			return loc === null ? 0 : read.i32(loc, 0);
		},
	};
	flockLib = opened;
	return opened;
}

export interface DispatcherLock {
	/** False when another process holds the lock: exit 0 without entering the tick. */
	held: boolean;
	/** Idempotent. Drops the flock and closes the descriptor. */
	release(): void;
}

/** Acquire the dispatcher lock. Never blocks. Creates the file (not the host dir contract) when missing. */
export function acquireDispatcherLock(lockPath: string = DEFAULT_DISPATCHER_LOCK_FILE): DispatcherLock {
	mkdirSync(dirname(lockPath), { recursive: true });
	const lib = dispatcherFlock();
	const fd = openSync(lockPath, "a");
	if (lib.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		const err = lib.errno();
		try {
			closeSync(fd);
		} catch {
			// The lock was not taken; a close failure changes nothing.
		}
		if (err === EAGAIN) {
			return {
				held: false,
				release() {},
			};
		}
		throw new Error(`could not lock dispatcher lock ${lockPath} (errno ${err})`);
	}
	let released = false;
	return {
		held: true,
		release() {
			if (released) return;
			released = true;
			try {
				lib.flock(fd, LOCK_UN);
			} finally {
				try {
					closeSync(fd);
				} catch {
					// Closing is what frees the lock if the unlock call failed.
				}
			}
		},
	};
}
