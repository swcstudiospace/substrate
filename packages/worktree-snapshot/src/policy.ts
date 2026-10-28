/**
 * What a snapshot includes. Name-based exclusion (directories, globs, secrets) is decided here from
 * the path alone, before any file is opened, so excluded content is never read or hashed.
 */

import { SnapshotPolicyError } from "./errors.ts";
import type { ResolvedPolicy, SkipReason, SnapshotPolicy } from "./types.ts";

export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Directory names excluded at any depth: VCS metadata, dependency trees and build output. */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
	".git",
	"node_modules",
	".venv",
	"target",
	"dist",
	"build",
	".next",
	".turbo",
	"__pycache__",
];

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = ["*.log"];

/** Basename globs for files that commonly hold credentials. */
export const DEFAULT_SECRET_PATTERNS: readonly string[] = [
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"id_rsa*",
	"id_ed25519*",
	"*.p12",
	"credentials*.json",
	"*.keystore",
];

export const DEFAULT_IGNORED_ALLOWLIST: readonly string[] = [".planning/"];

function assertPatterns(name: string, patterns: readonly string[]): void {
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0") || pattern.startsWith("/")) {
			throw new SnapshotPolicyError(`${name} entries must be non-empty relative patterns without NUL`);
		}
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** Apply defaults and validate. Callers can only add exclusions; the defaults stay on. */
export function resolvePolicy(policy: SnapshotPolicy = {}): ResolvedPolicy {
	const maxFileBytes = policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
		throw new SnapshotPolicyError("maxFileBytes must be a positive safe integer");
	}
	const extraSecretPatterns = policy.extraSecretPatterns ?? [];
	const extraExcludeDirs = policy.extraExcludeDirs ?? [];
	const extraExcludeGlobs = policy.extraExcludeGlobs ?? [];
	const ignoredAllowlist = policy.ignoredAllowlist ?? DEFAULT_IGNORED_ALLOWLIST;
	assertPatterns("extraSecretPatterns", extraSecretPatterns);
	assertPatterns("extraExcludeGlobs", extraExcludeGlobs);
	assertPatterns("extraExcludeDirs", extraExcludeDirs);
	for (const dir of extraExcludeDirs) {
		if (dir.includes("/")) throw new SnapshotPolicyError("extraExcludeDirs entries are single directory names");
	}
	for (const entry of ignoredAllowlist) {
		const segments = entry.split("/").filter((segment) => segment.length > 0);
		if (
			entry.length === 0 ||
			entry.includes("\0") ||
			entry.startsWith("/") ||
			entry.startsWith(":") ||
			segments.length === 0 ||
			segments.some((segment) => segment === "." || segment === ".." || segment.toLowerCase() === ".git")
		) {
			throw new SnapshotPolicyError("ignoredAllowlist entries must be relative paths inside the worktree");
		}
	}
	return {
		maxFileBytes,
		secretPatterns: unique([...DEFAULT_SECRET_PATTERNS, ...extraSecretPatterns]),
		excludeDirs: unique([...DEFAULT_EXCLUDE_DIRS, ...extraExcludeDirs]),
		excludeGlobs: unique([...DEFAULT_EXCLUDE_GLOBS, ...extraExcludeGlobs]),
		ignoredAllowlist: unique(ignoredAllowlist),
	};
}

const regexCache = new Map<string, RegExp>();

/** `*` and `?` stay inside a path segment; `**` crosses segments; everything else is literal. */
function globToRegExp(pattern: string): RegExp {
	const cached = regexCache.get(pattern);
	if (cached) return cached;
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern.charAt(i);
		if (char === "*") {
			if (pattern.charAt(i + 1) === "*") {
				i++;
				if (pattern.charAt(i + 1) === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
	}
	const regex = new RegExp(`^${source}$`, "su");
	regexCache.set(pattern, regex);
	return regex;
}

/** A pattern without a slash matches the basename at any depth; one with a slash matches from the root. */
export function matchesGlob(pattern: string, path: string): boolean {
	if (pattern.includes("/")) return globToRegExp(pattern).test(path);
	const slash = path.lastIndexOf("/");
	return globToRegExp(pattern).test(slash === -1 ? path : path.slice(slash + 1));
}

/**
 * Why a path is excluded by name, or null. `dir` is true when `path` names a directory (a nested
 * repository reported by git with a trailing slash). Always-excluded paths return "excluded" and are
 * dropped silently; secrets return "secret-pattern" and are reported.
 */
export function excludedByName(path: string, policy: ResolvedPolicy, dir = false): SkipReason | "excluded" | null {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	const dirSegments = dir ? segments : segments.slice(0, -1);
	if (dirSegments.some((segment) => policy.excludeDirs.includes(segment))) return "excluded";
	if (policy.excludeGlobs.some((pattern) => matchesGlob(pattern, path))) return "excluded";
	if (policy.secretPatterns.some((pattern) => matchesGlob(pattern, path))) return "secret-pattern";
	return null;
}
