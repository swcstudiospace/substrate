/** Narrows a value a test already knows is present (an indexed element, a Map hit, a find result) and fails the test with a clear message when it is not. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

/**
 * Clear the Hindsight variables for one test and return the restore. `hindsightFromEnv()` reads the live process environment at
 * call time, so a URL and key already present there (exported by the shell, or left by another suite in the same `bun test`
 * process) make every memory write, search and health probe reach a plane the test never set up. A test that means "Hindsight
 * unconfigured" clears them itself rather than inheriting them.
 */
export function withoutHindsightEnv(): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS", "HINDSIGHT_BANK", "HINDSIGHT_BANK_PREFIX"];
	const saved = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) delete process.env[name];
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}
