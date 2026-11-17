/** Narrows a value a test already knows is present (an indexed element, a Map hit, a find result) and fails the test with a clear message when it is not. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}
