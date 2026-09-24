import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import { deliverTo, MARKER_END, MARKER_START } from "./muse.ts";

let tmpRepo: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	tmpRepo = mkdtempSync(join(tmpdir(), "muse-collector-test-"));
});

afterEach(() => {
	rmSync(tmpRepo, { recursive: true, force: true });
	globalThis.fetch = originalFetch;
});

interface StubOptions {
	/** Brief text `/brief` returns; null simulates a failed or empty fetch. */
	briefText?: string | null;
}

/** Stubs global fetch for both `/brief` and `/events`; returns captured `/events` bodies. */
function stubFetch({ briefText = "stub brief" }: StubOptions = {}): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const href = String(input);
		if (href.endsWith("/brief")) {
			if (briefText === null) return new Response("", { status: 500 });
			return new Response(briefText, { status: 200 });
		}
		if (href.endsWith("/events")) {
			events.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ id: "evt", ts: new Date().toISOString(), hash: "h" }), { status: 202 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return events;
}

function briefPath(repo: string): string {
	return join(repo, ".substrate", "BRIEF.md");
}

function agentsPath(repo: string): string {
	return join(repo, "AGENTS.md");
}

describe("muse collector", () => {
	test("Test 1: writes .substrate/BRIEF.md with the fetched brief text", async () => {
		stubFetch({ briefText: "STUB BRIEF TEXT" });
		await deliverTo(tmpRepo);
		expect(readFileSync(briefPath(tmpRepo), "utf8")).toBe("STUB BRIEF TEXT");
	});

	test("Test 2: running twice leaves exactly one AGENTS.md marker pair", async () => {
		stubFetch({ briefText: "brief one" });
		await deliverTo(tmpRepo);
		stubFetch({ briefText: "brief two" });
		await deliverTo(tmpRepo);

		const agents = readFileSync(agentsPath(tmpRepo), "utf8");
		expect(agents.split(MARKER_START).length - 1).toBe(1);
		expect(agents.split(MARKER_END).length - 1).toBe(1);
		expect(readFileSync(briefPath(tmpRepo), "utf8")).toBe("brief two");
	});

	test("Test 3: a pre-existing AGENTS.md keeps every original line, block appended not replacing", async () => {
		const original = "# My Repo\n\nHand-written instructions that must survive.\n";
		writeFileSync(agentsPath(tmpRepo), original);
		stubFetch({ briefText: "a brief" });
		await deliverTo(tmpRepo);

		const agents = readFileSync(agentsPath(tmpRepo), "utf8");
		expect(agents.startsWith(original)).toBe(true);
		expect(agents).toContain(MARKER_START);
		expect(agents).toContain(MARKER_END);
	});

	test("Test 4: a failed fetch leaves an existing BRIEF.md untouched rather than truncating it", async () => {
		mkdirSync(join(tmpRepo, ".substrate"), { recursive: true });
		writeFileSync(briefPath(tmpRepo), "OLD BRIEF, still good");
		stubFetch({ briefText: null });
		await deliverTo(tmpRepo);

		expect(readFileSync(briefPath(tmpRepo), "utf8")).toBe("OLD BRIEF, still good");
	});

	test("Test 5: emits a brief.delivered event per repo on success, carrying repo and byte length", async () => {
		const text = "a delivered brief";
		const events = stubFetch({ briefText: text });
		await deliverTo(tmpRepo);

		expect(events.length).toBe(1);
		const [event] = events;
		expect(event?.surface).toBe("muse");
		expect(event?.kind).toBe("brief.delivered");
		expect(event?.repo).toBe(tmpRepo);
		expect((event?.payload as Record<string, unknown>)?.bytes).toBe(Buffer.byteLength(text));
	});

	test("Test 5b: no brief.delivered event is emitted on a failed fetch", async () => {
		const events = stubFetch({ briefText: null });
		await deliverTo(tmpRepo);
		expect(events.length).toBe(0);
	});

	test("Test 6: a tskey- style token in the brief is redacted before it is written", async () => {
		const secret = "tskey-abcDEF123456ghiJKL";
		const raw = `internal note: token=${secret} keep it safe`;
		stubFetch({ briefText: raw });
		await deliverTo(tmpRepo);

		const written = readFileSync(briefPath(tmpRepo), "utf8");
		expect(written).not.toContain(secret);
		expect(written).toBe(redact(raw));
	});
});
