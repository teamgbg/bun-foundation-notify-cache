/**
 * @system notify-cache
 * @status handwritten
 * @edit edit directly
 *
 * Factory entry point. Mirrors createCache / createWorkerPool /
 * createWatchdog. Auto-registers in the central registry and (if a
 * NotifyAdapter is wired via configure()) attaches LISTEN subscribers
 * during the first get() call.
 */

import { getLoadContext, getNotifyAdapter } from "./configure.ts";
import { NotifyCache } from "./notify-cache.ts";
import { notifyCacheRegistry } from "./registry.ts";
import type { NotifyAdapter, NotifyCacheOptions } from "./types.ts";

export function createNotifyCache<T>(
	options: NotifyCacheOptions<T> & {
		notifyAdapter?: NotifyAdapter | null;
		loadContext?: unknown;
	},
): NotifyCache<T> {
	const cache = new NotifyCache<T>({
		...options,
		notifyAdapter: options.notifyAdapter ?? getNotifyAdapter(),
		loadContext: options.loadContext ?? getLoadContext(),
	});
	notifyCacheRegistry.register(cache);
	// Best-effort attach. The cache works without it (purely interval-driven
	// or load-once). Errors surface via the emit() callback.
	void cache.attach().catch(() => {});
	return cache;
}
