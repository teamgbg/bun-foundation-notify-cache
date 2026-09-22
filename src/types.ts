/**
 * @system notify-cache
 * @status handwritten
 * @edit edit directly
 *
 * Type contracts for @teamscala/notify-cache. The primitive is a hot
 * in-memory snapshot cache whose invalidation is driven by Postgres
 * LISTEN/NOTIFY — closing the canonical pattern from constitution
 * `notify-cache-is-the-only-snapshot-cache`.
 */

export interface NotifyCacheStats {
	name: string;
	state: "uninitialized" | "loading" | "ready" | "rehydrating" | "failed";
	/** True while the held value has been invalidated (a NOTIFY / passed ceiling) and a refresh has not yet settled it fresh. */
	stale: boolean;
	lastLoadAt: number | null;
	lastLoadDurationMs: number | null;
	hits: number;
	misses: number;
	invalidations: number;
	failedLoads: number;
	enabled: boolean;
}

export type NotifyCacheEventKind =
	| "loaded"
	| "invalidated"
	| "rehydrated"
	| "load-failed"
	| "disabled"
	| "enabled";

export interface NotifyCacheEvent {
	cache: string;
	kind: NotifyCacheEventKind;
	durationMs?: number;
	error?: string;
	channel?: string;
}

/**
 * Minimal contract for the LISTEN connection. Consumers inject an
 * adapter wrapping their own Postgres client (postgres.js, pg, etc.)
 * so notify-cache stays driver-agnostic and DB-tier-agnostic.
 */
export interface NotifyAdapter {
	/**
	 * Subscribe to a Postgres NOTIFY channel. The handler is called with
	 * the payload (or empty string if no payload). Returns an
	 * unsubscribe function.
	 */
	listen(
		channel: string,
		handler: (payload: string) => void,
	): Promise<() => Promise<void>>;
}

export interface NotifyCacheOptions<T> {
	/** Unique name in the process. `<package>:<purpose>` convention. */
	name: string;
	/**
	 * Loader called to populate the cache. Receives an opaque "context"
	 * value injected by the bootloader via configure() — typically a
	 * postgres client. Consumer controls what flows in via configure().
	 */
	load: (ctx: unknown) => Promise<T>;
	/** Postgres NOTIFY channels that should trigger a rehydrate. */
	invalidateOn: string[];
	/**
	 * Optional ceiling on staleness. If no NOTIFY fires within this
	 * window, the next `get()` triggers a forced reload. Default: 0
	 * (disabled — invalidation is purely event-driven).
	 */
	staleAfterMs?: number;
	/** Optional event sink for observability. */
	emit?: (event: NotifyCacheEvent) => void;
	/**
	 * Initial enabled state. `false` means `get()` always loads fresh
	 * — useful for troubleshooting cache poisoning. Default: true.
	 */
	enabled?: boolean;
}
