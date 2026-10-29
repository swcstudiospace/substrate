import { describe, expect, test } from "bun:test";
import { Coalescer } from "./coalesce.ts";
import { defined } from "./test-support.ts";
import { createWatcher, type WatchFactory, type WatchTarget } from "./watch.ts";

interface FakeWatch {
	dir: string;
	closed: boolean;
	emit: (filename: string | null) => void;
	fail: (error: Error) => void;
}

function fakeFactory(options: { failAfter?: number; code?: string } = {}): { factory: WatchFactory; watches: FakeWatch[]; attempts: () => number } {
	const watches: FakeWatch[] = [];
	let attempts = 0;
	const factory: WatchFactory = (dir, listener, onError) => {
		attempts += 1;
		if (options.failAfter !== undefined && attempts > options.failAfter) {
			throw Object.assign(new Error("no watches left"), { code: options.code ?? "ENOSPC" });
		}
		const watch: FakeWatch = { dir, closed: false, emit: listener, fail: onError };
		watches.push(watch);
		return {
			close: () => {
				watch.closed = true;
			},
		};
	};
	return { factory, watches, attempts: () => attempts };
}

function targets(count: number, repo = "Acme/A"): WatchTarget[] {
	return Array.from({ length: count }, (_, i) => ({ repo, dir: `/work/a/d${i}` }));
}

describe("createWatcher", () => {
	test("a change event marks its repository and reads nothing; temporary editor files are ignored", () => {
		const fake = fakeFactory();
		const changes: Array<[string, number]> = [];
		let now = 1000;
		createWatcher({
			dirs: [{ repo: "Acme/A", dir: "/work/a" }, { repo: "Acme/B", dir: "/work/b" }],
			onChange: (repo, at) => changes.push([repo, at]),
			watchFactory: fake.factory,
			clock: () => now++,
			max: 10,
		});

		const [a, b] = fake.watches;
		defined(a).emit("guide.md");
		defined(b).emit(null);
		defined(a).emit("guide.md.swp");
		defined(a).emit("new-dir");
		defined(a).emit("README.MD");

		expect(changes).toEqual([["Acme/A", 1000], ["Acme/B", 1001], ["Acme/A", 1002], ["Acme/A", 1003]]);
	});

	test("a burst of events through the watcher and the coalescer is one sync", () => {
		const fake = fakeFactory();
		const coalescer = new Coalescer({ debounceMs: 2000, maxWaitMs: 30_000 });
		let now = 0;
		createWatcher({
			dirs: targets(1),
			onChange: (repo, at) => coalescer.signal(repo, "watch", at),
			watchFactory: fake.factory,
			clock: () => now,
			max: 10,
		});
		for (now = 0; now < 500; now += 50) defined(fake.watches[0]).emit("a.md");

		expect(coalescer.due(450 + 1999)).toEqual([]);
		expect(coalescer.due(450 + 2000)).toHaveLength(1);
	});

	test("watches at most `max` directories and reports the rest as unwatched", () => {
		const fake = fakeFactory();
		const watcher = createWatcher({ dirs: targets(5), onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 3 });
		expect(watcher.state()).toEqual({ watching: 3, unwatched: 2, degraded: null });
		expect(fake.watches.map((watch) => watch.dir)).toEqual(["/work/a/d0", "/work/a/d1", "/work/a/d2"]);
	});

	test("a directory listed twice is watched once", () => {
		const fake = fakeFactory();
		createWatcher({ dirs: [...targets(2), ...targets(2)], onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 10 });
		expect(fake.attempts()).toBe(2);
	});

	test("the inotify limit closes every watch and leaves the command in sweep-only mode", () => {
		const fake = fakeFactory({ failAfter: 2 });
		const watcher = createWatcher({ dirs: targets(5), onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 10 });

		expect(watcher.state()).toEqual({ watching: 0, unwatched: 5, degraded: "inotify-limit" });
		expect(fake.watches.every((watch) => watch.closed)).toBe(true);
		// Later replacements do not try again: the host is out of watches.
		const attempts = fake.attempts();
		expect(watcher.replace(targets(3)).degraded).toBe("inotify-limit");
		expect(fake.attempts()).toBe(attempts);
	});

	test("EMFILE counts as the limit too, and a limit error raised later by a live watch degrades the watcher", () => {
		const emfile = fakeFactory({ failAfter: 0, code: "EMFILE" });
		expect(createWatcher({ dirs: targets(1), onChange: () => undefined, watchFactory: emfile.factory, clock: () => 0, max: 10 }).state().degraded).toBe("inotify-limit");

		const fake = fakeFactory();
		const watcher = createWatcher({ dirs: targets(2), onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 10 });
		defined(fake.watches[0]).fail(Object.assign(new Error("limit"), { code: "ENOSPC" }));
		expect(watcher.state()).toEqual({ watching: 0, unwatched: 2, degraded: "inotify-limit" });
	});

	test("any other watch failure never throws: that directory is left to the sweep", () => {
		const fake = fakeFactory({ failAfter: 1, code: "ENOENT" });
		const watcher = createWatcher({ dirs: targets(3), onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 10 });
		expect(watcher.state()).toEqual({ watching: 1, unwatched: 2, degraded: null });
		expect(() => defined(fake.watches[0]).fail(new Error("the directory was removed"))).not.toThrow();
	});

	test("replace swaps the watched set and close closes everything", () => {
		const fake = fakeFactory();
		const watcher = createWatcher({ dirs: targets(2), onChange: () => undefined, watchFactory: fake.factory, clock: () => 0, max: 10 });
		const first = [...fake.watches];

		expect(watcher.replace(targets(1, "Acme/B")).watching).toBe(1);
		expect(first.every((watch) => watch.closed)).toBe(true);

		watcher.close();
		expect(fake.watches.every((watch) => watch.closed)).toBe(true);
		expect(watcher.state().watching).toBe(0);
	});
});
