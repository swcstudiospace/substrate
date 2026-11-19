/**
 * The cross-repository operation log's SQL, proven against a real Postgres with the same cases the in-memory adapter passes
 * (`cross-repo-store.testkit.ts`). These skip unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test cross-repo-store.pg
 *
 * The tables are the real migration (step 44). Every key is namespaced to one run by a marker, so a shared database keeps
 * the rows the cases wrote; point the variable at a disposable database.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";
import { crossRepoStoreContract } from "./cross-repo-store.testkit.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-xr-${Date.now().toString(36)}`;

const describeLive = PG_URL ? describe : describe.skip;

describeLive("the cross-repo store against a live index", () => {
	let index: IndexStore;

	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
	});

	afterAll(async () => {
		await index.close().catch(() => undefined);
	});

	crossRepoStoreContract(() => ({
		store: index.crossRepoStore(),
		key: (label) => `${MARKER}-${label}`,
	}));
});
