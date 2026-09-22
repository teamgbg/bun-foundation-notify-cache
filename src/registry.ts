/**
 * @system notify-cache
 * @status handwritten
 * @edit edit directly
 *
 * Process-global notify-cache registry singleton. Mirrors CacheRegistry
 * / WorkerPoolRegistry / WatchdogRegistry per `cache-is-the-only-cache`
 * precedent. Every NotifyCache auto-registers on construction for
 * central visibility (operator can list, disable, stats() all caches).
 */

import type { NotifyCache } from "./notify-cache.ts";
import type { NotifyCacheStats } from "./types.ts";

class NotifyCacheRegistry {
	private readonly caches = new Map<string, NotifyCache<unknown>>();

	register(cache: NotifyCache<unknown>): void {
		if (this.caches.has(cache.name)) {
			throw new Error(
				`NotifyCache "${cache.name}" is already registered in this process`,
			);
		}
		this.caches.set(cache.name, cache);
	}

	get<T>(name: string): NotifyCache<T> | undefined {
		return this.caches.get(name) as NotifyCache<T> | undefined;
	}

	getAll(): NotifyCacheStats[] {
		return Array.from(this.caches.values()).map((c) => c.stats());
	}

	disable(name: string): void {
		this.caches.get(name)?.disable();
	}

	enable(name: string): void {
		this.caches.get(name)?.enable();
	}

	async detachAll(): Promise<void> {
		for (const cache of this.caches.values()) {
			await cache.detach();
		}
	}
}

export const notifyCacheRegistry = new NotifyCacheRegistry();
