/** `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			const item = items[index];
			if (index >= items.length || item === undefined) return;
			results[index] = await fn(item, index);
		}
	};
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
	await Promise.all(workers);
	return results;
}
