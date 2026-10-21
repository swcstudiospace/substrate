/**
 * Data-plane endpoint classifier (Phase 48, D48-a).
 *
 * Pins each class for representative URLs, the loopback rule for every plane,
 * the allow list match on host and port, and the malformed-entry error, which
 * names SUBSTRATE_DB_PROXY_ALLOW and never echoes the entry.
 */
import { describe, expect, test } from "bun:test";
import { type DbPlane, classifyEndpoint, parseProxyAllow } from "./db-endpoints.ts";

const PLANES: readonly DbPlane[] = ["greptime", "postgres", "dragonfly"];
const NONE = parseProxyAllow(undefined);
const LISTED = parseProxyAllow("example.test:5432");

function parseMessage(raw: string): string {
	let message = "";
	try {
		parseProxyAllow(raw);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	return message;
}

describe("classifyEndpoint", () => {
	test("produces each class for a representative URL", () => {
		expect(classifyEndpoint("postgres", "postgres://127.0.0.1:5432/substrate", NONE)).toBe("loopback");
		expect(classifyEndpoint("postgres", "postgres://example.test:5432/substrate", LISTED)).toBe("proxy");
		expect(classifyEndpoint("postgres", "postgres://other.example.test:5432/substrate", LISTED)).toBe("direct");
	});

	test("an unparseable URL is direct", () => {
		for (const plane of PLANES) {
			for (const url of ["not a url", "postgres://", "localhost:5432", "http://exa mple.test:80/", "://no-scheme"]) {
				expect(classifyEndpoint(plane, url, LISTED)).toBe("direct");
			}
		}
	});

	test("an undefined or empty URL is direct for every plane", () => {
		for (const plane of PLANES) {
			expect(classifyEndpoint(plane, undefined, LISTED)).toBe("direct");
			expect(classifyEndpoint(plane, "", LISTED)).toBe("direct");
		}
	});

	test("a loopback URL is loopback for every plane, whatever the scheme", () => {
		const urls = [
			"http://localhost:4000",
			"https://127.0.0.2:4000/v1",
			"postgres://127.10.0.1:5432/substrate",
			"redis://[::1]:6379",
			"rediss://LOCALHOST:6379",
			"postgresql://[0:0:0:0:0:0:0:1]:5432/substrate",
		];
		for (const plane of PLANES) {
			for (const url of urls) {
				expect(classifyEndpoint(plane, url, NONE)).toBe("loopback");
			}
		}
	});

	test("an allowlisted host and port is proxy, and the same host on another port is direct", () => {
		const allow = parseProxyAllow("Example.TEST:5432, example.test:443");
		expect(classifyEndpoint("postgres", "postgres://EXAMPLE.test:5432/substrate", allow)).toBe("proxy");
		expect(classifyEndpoint("postgres", "postgres://example.test:6432/substrate", allow)).toBe("direct");
		expect(classifyEndpoint("greptime", "https://example.test", allow)).toBe("proxy");
		expect(classifyEndpoint("greptime", "https://example.test:8443", allow)).toBe("direct");
		expect(classifyEndpoint("dragonfly", "rediss://example.test:6379", allow)).toBe("direct");
	});

	test("the scheme does not decide the class", () => {
		expect(classifyEndpoint("dragonfly", "http://example.test:5432", LISTED)).toBe("proxy");
		expect(classifyEndpoint("greptime", "rediss://127.0.0.1:4000", NONE)).toBe("loopback");
	});

	test("an empty allow set classifies every remote endpoint as direct", () => {
		for (const plane of PLANES) {
			expect(classifyEndpoint(plane, "postgres://example.test:5432/substrate", NONE)).toBe("direct");
		}
	});
});

describe("parseProxyAllow", () => {
	test("undefined and empty values parse to an empty set", () => {
		expect(parseProxyAllow(undefined).size).toBe(0);
		expect(parseProxyAllow("").size).toBe(0);
		expect(parseProxyAllow("   ").size).toBe(0);
	});

	test("entries are trimmed, the host is lowercased and the key is host:port", () => {
		const allow = parseProxyAllow(" Example.TEST:5432 , other.example.test:06379 ");
		expect([...allow].sort()).toEqual(["example.test:5432", "other.example.test:6379"]);
	});

	test("a malformed entry throws an error that names the variable and not the entry", () => {
		const malformed = [
			"zq-marker.example.test",
			"zq-marker.example.test:0",
			"zq-marker.example.test:65536",
			"zq-marker.example.test:port",
			"https://zq-marker.example.test:5432",
			"zq-marker.example.test:5432/path",
			"zq-marker.example.test:5432@user",
		];
		for (const entry of malformed) {
			const message = parseMessage(`example.test:5432,${entry}`);
			expect(message).toContain("SUBSTRATE_DB_PROXY_ALLOW");
			expect(message).toContain("entry 2");
			expect(message).not.toContain("zq-marker");
			expect(message).not.toContain(entry);
		}
	});

	test("an empty entry between commas is malformed and named by index", () => {
		const message = parseMessage("example.test:5432,,other.example.test:5432");
		expect(message).toContain("SUBSTRATE_DB_PROXY_ALLOW");
		expect(message).toContain("entry 2");
	});
});
