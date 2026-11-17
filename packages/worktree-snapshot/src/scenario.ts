/**
 * A fixed worktree used by the restore tests: state A (the snapshot) and a mutation to state B that
 * touches every kind of change the restore must undo. Imported only by tests.
 */

import { chmodSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, writeFiles } from "./testkit.ts";
import type { SnapshotPolicy } from "./types.ts";

export const SCENARIO_POLICY: SnapshotPolicy = { maxFileBytes: 64 };

/** Paths the policy excludes; a restore must neither write nor delete them. */
export const SCENARIO_EXCLUDED_B: Record<string, string> = {
	".env": "SECRET=b\n",
	"node_modules/pkg/i.js": "i v2\n",
	"big.dat": "y".repeat(120),
	"node_modules/extra.js": "extra\n",
	".env.local": "LOCAL=1\n",
	"app.log": "log line\n",
};

export function writeScenarioA(dir: string): void {
	writeFiles(dir, {
		".gitignore": ".planning/\n",
		"README.md": "readme v1\n",
		"src/main.ts": "main v1\n",
		"src/util.ts": "util v1\n",
		"scripts/run.sh": { content: "#!/bin/sh\n", exec: true },
		"docs/old.md": "old\n",
		link: { link: "README.md" },
		"dir/inner/deep.txt": "deep\n",
		swap: "file now\n",
		"swapdir/child.txt": "child\n",
	});
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "scenario A"]);
	// Untracked at snapshot time, one of them gitignored but on the allowlist.
	writeFiles(dir, { "notes/todo.txt": "todo\n", ".planning/plan.md": "plan v1\n" });
	writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 255, 1, 2, 0, 128]));
	// Excluded by policy in state A as well.
	writeFiles(dir, { ".env": "SECRET=a\n", "node_modules/pkg/i.js": "i v1\n", "big.dat": "x".repeat(100) });
}

/** Mutate the scenario worktree from state A to state B without touching the real index. */
export function mutateToB(dir: string): void {
	writeFiles(dir, { "README.md": "readme v2\n" });
	rmSync(join(dir, "docs", "old.md"));
	renameSync(join(dir, "src", "util.ts"), join(dir, "src", "helpers.ts"));
	chmodSync(join(dir, "src", "main.ts"), 0o755);
	chmodSync(join(dir, "scripts", "run.sh"), 0o644);
	rmSync(join(dir, "link"));
	symlinkSync("src/main.ts", join(dir, "link"));
	rmSync(join(dir, "swap"));
	symlinkSync("README.md", join(dir, "swap"));
	rmSync(join(dir, "swapdir"), { recursive: true });
	writeFileSync(join(dir, "swapdir"), "now a file\n");
	rmSync(join(dir, "dir", "inner", "deep.txt"));
	writeFiles(dir, { "new/created.txt": "created\n", "extra/deep/er.txt": "er\n" });
	rmSync(join(dir, "notes", "todo.txt"));
	writeFiles(dir, { ".planning/plan.md": "plan v2\n" });
	writeFileSync(join(dir, "bin.dat"), Buffer.from([9, 8, 7]));
	writeFiles(dir, SCENARIO_EXCLUDED_B);
}
