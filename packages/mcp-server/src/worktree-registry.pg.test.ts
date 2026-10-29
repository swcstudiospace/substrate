/**
 * The worktree registry's SQL, proven against a real Postgres with the same cases the in-memory adapter passes
 * (`worktree-registry.testkit.ts`). These skip unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test worktree-registry.pg
 *
 * The table is the real migration. Every host and repo is namespaced to one run by a marker, and every host a case
 * touched is swept at the end by a report from the far future, so a shared database is left as it was found.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";
import { worktreeStoreContract } from "./worktree-registry.testkit.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-wt-${Date.now().toString(36)}`;

const describeLive = PG_URL ? describe : describe.skip;

describeLive("the worktree registry against a live index", () => {
	let index: IndexStore;
	const hosts = new Set<string>();

	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		const registry = index.worktreeRegistry();
		const farFuture = new Date("2100-01-01T00:00:00.000Z");
		for (const host of hosts) {
			// An empty report from the far future sweeps everything the host left behind.
			await registry.report({ host, reportedAt: farFuture, seenAt: farFuture, ttlS: 60, worktrees: [] }).catch(() => undefined);
		}
		await index.close().catch(() => undefined);
	});

	worktreeStoreContract(() => ({
		store: index.worktreeRegistry(),
		host: (label) => {
			const host = `${MARKER}-${label}`;
			hosts.add(host);
			return host;
		},
		repo: (label) => `${MARKER}/${label}`,
	}));
});
