import { describe } from "bun:test";
import { MemoryCrossRepoStore } from "./cross-repo-fake.ts";
import { crossRepoStoreContract } from "./cross-repo-store.testkit.ts";

describe("the in-memory cross-repo store", () => {
	crossRepoStoreContract(() => ({ store: new MemoryCrossRepoStore(), key: (label) => `mem-${label}` }));
});
