// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { createNotifyCache } from "./create-notify-cache.ts";
import { notifyCacheRegistry } from "./registry.ts";
import type { NotifyAdapter, NotifyCacheEvent } from "./types.ts";

function uniqueName(prefix: string): string {
	return `${prefix}:${Math.random().toString(36).slice(2)}`;
}

/** In-memory NotifyAdapter that lets tests fire synthetic NOTIFYs. */
function makeFakeAdapter() {
	const handlers = new Map<string, Set<(payload: string) => void>>();
	return {
		fire(channel: string, payload = "") {
			const set = handlers.get(channel);
			if (set) for (const h of set) h(payload);
		},
		listenerCount(channel: string) {
			return handlers.get(channel)?.size ?? 0;
		},
		adapter: {
			async listen(
				channel: string,
				handler: (payload: string) => void,
			): Promise<() => Promise<void>> {
				if (!handlers.has(channel)) handlers.set(channel, new Set());
				handlers.get(channel)?.add(handler);
				return async () => {
					handlers.get(channel)?.delete(handler);
				};
			},
		} satisfies NotifyAdapter,
	};
}

test("first get() loads, subsequent get() returns cached", async () => {
	let loadCount = 0;
	const cache = createNotifyCache<number>({
		name: uniqueName("t1"),
		invalidateOn: [],
		load: async () => {
			loadCount++;
			return 42;
		},
	});
	expect(await cache.get()).toBe(42);
	expect(await cache.get()).toBe(42);
	expect(await cache.get()).toBe(42);
	expect(loadCount).toBe(1);
	const stats = cache.stats();
	expect(stats.hits).toBe(2);
	expect(stats.misses).toBe(1);
});

test("NOTIFY triggers rehydrate; get() awaits the fresh value (invalidate-on-write)", async () => {
	const { adapter, fire } = makeFakeAdapter();
	let loadCount = 0;
	let resolveRehydrate: { fn: ((v: number) => void) | null } = { fn: null };
	const cache = createNotifyCache<number>({
		name: uniqueName("t2"),
		invalidateOn: ["foo_changed"],
		notifyAdapter: adapter,
		load: async () => {
			loadCount++;
			if (loadCount === 1) return 100;
			return new Promise<number>((resolve) => {
				resolveRehydrate.fn = resolve;
			});
		},
	});
	// Initial load.
	expect(await cache.get()).toBe(100);
	expect(loadCount).toBe(1);

	// Wait for attach() to complete.
	await new Promise((r) => setTimeout(r, 10));

	// Fire NOTIFY → rehydrate starts but is blocked on the promise. get() must NOT
	// return the pre-write value (100) — it waits for the fresh value, so a write
	// followed immediately by a read can never observe the stale snapshot.
	fire("foo_changed");
	await new Promise((r) => setTimeout(r, 10));
	expect(loadCount).toBe(2); // rehydrate started

	const getResult = cache.get();
	await new Promise((r) => setTimeout(r, 10));

	// Complete the rehydrate with the POST-write value.
	if (resolveRehydrate.fn) resolveRehydrate.fn(200);
	expect(await getResult).toBe(200); // fresh, never the stale 100
	expect(await cache.get()).toBe(200);
});

test("concurrent first-load calls share a single load() invocation", async () => {
	let loadCount = 0;
	const cache = createNotifyCache<string>({
		name: uniqueName("t3"),
		invalidateOn: [],
		load: async () => {
			loadCount++;
			await new Promise((r) => setTimeout(r, 50));
			return "value";
		},
	});
	const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
	expect(results).toEqual(["value", "value", "value"]);
	expect(loadCount).toBe(1);
});

test("staleAfterMs forces reload when no NOTIFY arrives", async () => {
	let loadCount = 0;
	const cache = createNotifyCache<number>({
		name: uniqueName("t4"),
		invalidateOn: [],
		staleAfterMs: 50,
		load: async () => {
			loadCount++;
			return loadCount;
		},
	});
	expect(await cache.get()).toBe(1);
	await new Promise((r) => setTimeout(r, 80));
	// Past the ceiling: get() must NOT return the expired value — it reloads and
	// returns the fresh one (the ceiling is a hard freshness bound, not a
	// background-refresh hint that keeps serving stale).
	expect(await cache.get()).toBe(2);
});

test("rehydrate failure preserves the previous value", async () => {
	const { adapter, fire } = makeFakeAdapter();
	const events: NotifyCacheEvent[] = [];
	let mode: "ok" | "fail" = "ok";
	const cache = createNotifyCache<string>({
		name: uniqueName("t5"),
		invalidateOn: ["any"],
		notifyAdapter: adapter,
		load: async () => {
			if (mode === "fail") throw new Error("upstream down");
			return "fresh";
		},
		emit: (e) => events.push(e),
	});
	expect(await cache.get()).toBe("fresh");

	await new Promise((r) => setTimeout(r, 10));
	mode = "fail";
	fire("any");
	await new Promise((r) => setTimeout(r, 30));

	// Previous value still served.
	expect(await cache.get()).toBe("fresh");
	expect(events.some((e) => e.kind === "load-failed")).toBe(true);
	expect(cache.stats().failedLoads).toBeGreaterThanOrEqual(1);
});

test("disable() makes get() bypass cache and call load() each time", async () => {
	let loadCount = 0;
	const cache = createNotifyCache<number>({
		name: uniqueName("t6"),
		invalidateOn: [],
		load: async () => {
			loadCount++;
			return loadCount;
		},
	});
	expect(await cache.get()).toBe(1);
	expect(await cache.get()).toBe(1); // cached
	cache.disable();
	expect(await cache.get()).toBe(2); // bypass
	expect(await cache.get()).toBe(3); // bypass
});

test("registry exposes every constructed cache via getAll()", async () => {
	const name = uniqueName("t7");
	createNotifyCache<number>({
		name,
		invalidateOn: [],
		load: async () => 7,
	});
	const all = notifyCacheRegistry.getAll();
	expect(all.some((s) => s.name === name)).toBe(true);
});

test("duplicate cache name throws at registration", () => {
	const name = uniqueName("t8");
	createNotifyCache<number>({
		name,
		invalidateOn: [],
		load: async () => 0,
	});
	expect(() =>
		createNotifyCache<number>({
			name,
			invalidateOn: [],
			load: async () => 0,
		}),
	).toThrow();
});

test("attach() subscribes to every channel in invalidateOn", async () => {
	const { adapter, listenerCount } = makeFakeAdapter();
	createNotifyCache<number>({
		name: uniqueName("t9"),
		invalidateOn: ["a_changed", "b_changed"],
		notifyAdapter: adapter,
		load: async () => 0,
	});
	await new Promise((r) => setTimeout(r, 10));
	expect(listenerCount("a_changed")).toBe(1);
	expect(listenerCount("b_changed")).toBe(1);
});

/**
 * The construction-fix proof for codegen's silent stale-skip.
 *
 * codegen's per-row skip keys on an `inputHash` computed from the registry rows
 * the engine reads (run.ts). Those rows are served by a notify-cache snapshot
 * of active `registry_entries`. Before the fix, `get()` returned the stale
 * (pre-write) value while rehydrating in the background, so a registry write
 * followed immediately by a codegen run read the PRE-write rows, computed the
 * OLD input hash, and took a cache-skip that shipped a stale artifact —
 * reporting only `skipped` with no reason. Measured 2026-08-01:
 * `@teamscala/dev-mcp-boot` was added to a `service_install` row and stayed
 * absent from the generated package.json across three forced regenerations,
 * then appeared with no further row change (the signature of a stale read
 * resolving once its rehydrate finally landed).
 *
 * This pins the invariant that closes the class: a write's NOTIFY marks the
 * snapshot stale, so the very next `get()` returns the POST-write value. With
 * fresh rows the input hash moves, the cache-skip does not fire, and no stale
 * artifact ships. If this regresses, codegen's stale-skip regresses with it.
 */
test("write (NOTIFY) then get() returns the post-write value, never the pre-write one", async () => {
	const { adapter, fire } = makeFakeAdapter();
	let current = 1;
	const cache = createNotifyCache<number>({
		name: uniqueName("write-then-read"),
		invalidateOn: ["row_changed"],
		notifyAdapter: adapter,
		load: async () => current,
	});
	expect(await cache.get()).toBe(1);
	await new Promise((r) => setTimeout(r, 10)); // attach

	// The write: mutate the source, then emit the invalidating NOTIFY.
	current = 2;
	fire("row_changed");

	// The read immediately after the write observes the post-write value.
	expect(await cache.get()).toBe(2);
});
