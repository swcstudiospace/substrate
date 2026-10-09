/**
 * A recording stand-in for `gh`, for the rehearsal harness's skills fixture (D21-21).
 *
 * The skill proposer runs real `git` against a throwaway repository and calls `gh` only for
 * the three pull request questions it asks: create one, view one, list the open ones for a
 * branch. This answers exactly those from a JSON state file, with URLs under the configured
 * library's slug, and refuses everything else, so the harness can never reach GitHub or
 * quietly grow a second use. Every invocation is recorded first, so a proof can count the
 * `pr create` calls it made.
 *
 * The decisions are `fakeGh`, a pure function of the argv and the state. `runFakeGh` adds the
 * file, and `fakeGhScript` is the one-line executable the engine spawns as `gh`: the engine
 * hands its children an allowlisted environment, so the state path is baked into the script
 * rather than passed through one.
 */
import { renameSync, readFileSync, writeFileSync } from "node:fs";

export interface FakePr {
	number: number;
	url: string;
	head: string;
	base: string;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
}

export interface FakeGhState {
	next: number;
	prs: FakePr[];
	/** Every invocation's argv, in order, supported or not. */
	calls: string[][];
}

export interface FakeGhResult {
	code: number;
	stdout: string;
	stderr: string;
}

export const EMPTY_STATE: FakeGhState = { next: 1, prs: [], calls: [] };

/** This module's own path, so the installed script can import the one implementation. */
export const FAKE_GH_MODULE = import.meta.path;

function flag(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

const fail = (code: number, stderr: string): FakeGhResult => ({ code, stdout: "", stderr: `${stderr}\n` });

/** Answer one `gh` invocation, recording it in `state` (which is updated in place). */
export function fakeGh(argv: readonly string[], state: FakeGhState): FakeGhResult {
	state.calls.push([...argv]);
	const [group, verb, target] = argv;
	if (group !== "pr") return fail(2, `fake gh: unsupported command ${argv.slice(0, 2).join(" ")}`);

	if (verb === "create") {
		const repo = flag(argv, "--repo");
		const head = flag(argv, "--head");
		const title = flag(argv, "--title");
		if (!repo || !head || title === undefined) return fail(2, "fake gh: pr create needs --repo, --head and --title");
		const number = state.next++;
		const url = `https://github.com/${repo}/pull/${number}`;
		state.prs.push({ number, url, head, base: flag(argv, "--base") ?? "main", title, state: "OPEN" });
		return { code: 0, stdout: `${url}\n`, stderr: "" };
	}

	if (verb === "view") {
		const pr = state.prs.find((candidate) => candidate.url === target);
		if (!pr) return fail(1, `no pull requests found for ${String(target)}`);
		return { code: 0, stdout: `${JSON.stringify({ state: pr.state, url: pr.url, number: pr.number })}\n`, stderr: "" };
	}

	if (verb === "list") {
		const repo = flag(argv, "--repo");
		const head = flag(argv, "--head");
		if (!repo || !head) return fail(2, "fake gh: pr list needs --repo and --head");
		const open = state.prs
			.filter((pr) => pr.head === head && pr.state === "OPEN" && pr.url.startsWith(`https://github.com/${repo}/pull/`))
			.map((pr) => ({ url: pr.url, number: pr.number }));
		return { code: 0, stdout: `${JSON.stringify(open)}\n`, stderr: "" };
	}

	return fail(2, `fake gh: unsupported command pr ${String(verb)}`);
}

/** Read the state file; a missing or unreadable one is the empty state. */
export function readState(statePath: string): FakeGhState {
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<FakeGhState>;
		return { next: parsed.next ?? 1, prs: parsed.prs ?? [], calls: parsed.calls ?? [] };
	} catch {
		return { next: 1, prs: [], calls: [] };
	}
}

/** Write the state through a temp file and a rename, so a reader never sees half of it. */
export function writeState(statePath: string, state: FakeGhState): void {
	const temp = `${statePath}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, statePath);
}

/** What the installed script runs: answer on stdout and stderr, return the exit code. */
export function runFakeGh(argv: readonly string[], statePath: string): number {
	const state = readState(statePath);
	const result = fakeGh(argv, state);
	writeState(statePath, state);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.code;
}

/** The executable the engine spawns as `gh`: bun by absolute path, this module, this state file. */
export function fakeGhScript({ bun, statePath }: { bun: string; statePath: string }): string {
	return (
		`#!${bun}\n` +
		`import { runFakeGh } from ${JSON.stringify(FAKE_GH_MODULE)};\n` +
		`process.exit(runFakeGh(process.argv.slice(2), ${JSON.stringify(statePath)}));\n`
	);
}
