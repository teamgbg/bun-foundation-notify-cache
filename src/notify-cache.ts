/**
 * @system notify-cache
 * @status handwritten
 * @edit edit directly
 *
 * NotifyCache<T> — hot in-memory snapshot cache invalidated by Postgres
 * LISTEN/NOTIFY. THE canonical answer per constitution
 * `notify-cache-is-the-only-snapshot-cache`. Closes the daemon-perf
 * class where per-request DB queries dominate request latency.
 *
 * Lifecycle:
 *   uninitialized → loading → ready
 *                    ↓ (NOTIFY arrives or staleAfterMs fires)
 *                 rehydrating → ready
 *                    ↓ (load() throws)
 *                 failed → loading → ready
 *
 * Concurrency:
 *   - Multiple concurrent get() calls during initial load share one
 *     load() promise (no thundering herd at startup).
 *   - Once ready and fresh, get() returns the cached value SYNCHRONOUSLY-like
 *     (Promise.resolve), sub-µs cost.
 *   - When a NOTIFY arrives (a write), the held value is marked stale and a
 *     refresh runs; a get() during that refresh WAITS for the fresh value
 *     rather than returning the pre-write one (invalidate-on-write). Concurrent
 *     gets share the single in-flight refresh — no thundering herd — and a
 *     NOTIFY that lands during a refresh keeps it going for one more reload so
 *     no write is lost.
 *
 * The invalidate-on-write semantics are load-bearing: the prior design served
 * the stale value while rehydrating in the background, so a registry write
 * followed immediately by a codegen run read the PRE-write rows, computed the
 * OLD input hash, and took a cache-skip that shipped a stale artifact. A value
 * past its invalidation is unmakeable as a served value, never patrolled
 * (`prevention-over-detection`).
 *
 * Failure handling:
 *   - If load() throws on FIRST load, get() rejects; subsequent get()
 *     re-tries the load (no permanent poisoning).
 *   - If load() throws on rehydrate, the previous value stays in place;
 *     emit("load-failed") fires; the next NOTIFY or staleAfterMs retry.
 */

import type {
	NotifyAdapter,
	NotifyCacheEvent,
	NotifyCacheOptions,
	NotifyCacheStats,
} from "./types.ts";

export class NotifyCache<T> {
	readonly name: string;
	private readonly load: (ctx: unknown) => Promise<T>;
	private readonly invalidateOn: string[];
	private readonly staleAfterMs: number;
	private readonly emit: (event: NotifyCacheEvent) => void;
	private readonly notifyAdapter: NotifyAdapter | null;
	private readonly loadContext: unknown;

	private value: T | undefined;
	private state: NotifyCacheStats["state"] = "uninitialized";
	private loadingPromise: Promise<T> | null = null;
	/**
	 * In-flight refresh after an invalidation. `get()` awaits this while the held
	 * value is stale so it receives the FRESH value, never the pre-write one
	 * (invalidate-on-write). Null once a refresh settles.
	 */
	private freshPromise: Promise<T> | null = null;
	/**
	 * True once a NOTIFY (write) or a passed staleAfterMs ceiling has invalidated
	 * the held value and the refresh has not yet settled with no further
	 * invalidation. Drives the refresh loop's no-lost-wakeup check: cleared at
	 * the start of each load attempt and re-set by any NOTIFY landing during it,
	 * so a write that arrives mid-refresh triggers exactly one more reload.
	 */
	private stale = false;
	/** Most recent invalidation reason, surfaced in the load-failed event. */
	private lastRefreshReason: "notify" | "stale-timeout" | "get" = "get";
	private lastLoadAt: number | null = null;
	private lastLoadDurationMs: number | null = null;
	private hits = 0;
	private misses = 0;
	private invalidations = 0;
	private failedLoads = 0;
	private enabled: boolean;
	private unsubscribers: Array<() => Promise<void>> = [];
	private staleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		options: NotifyCacheOptions<T> & {
			notifyAdapter?: NotifyAdapter | null;
			loadContext?: unknown;
		},
	) {
		this.name = options.name;
		this.load = options.load;
		this.invalidateOn = options.invalidateOn;
		this.staleAfterMs = options.staleAfterMs ?? 0;
		this.emit = options.emit ?? (() => {});
		this.notifyAdapter = options.notifyAdapter ?? null;
		this.loadContext = options.loadContext ?? null;
		this.enabled = options.enabled ?? true;
	}

	/**
	 * Hot path. Returns the cached value when it is fresh; loads on first call;
	 * and — when the held value has been invalidated by a NOTIFY (write) or has
	 * passed its staleAfterMs ceiling — WAITS for a fresh load rather than
	 * returning the stale value (invalidate-on-write).
	 */
	async get(): Promise<T> {
		// Bypass: always-load mode (operator-disabled for troubleshooting).
		if (!this.enabled) {
			this.misses++;
			return this.load(this.loadContext);
		}

		// Missed-NOTIFY ceiling: if no NOTIFY has arrived within staleAfterMs the
		// held value may be stale (a dropped LISTEN connection). Force a refresh so
		// the next served value is fresh. NOTIFY (invalidate-on-write) is the
		// mechanism; staleAfterMs is only the safety net.
		if (
			this.state === "ready" &&
			this.staleAfterMs > 0 &&
			this.lastLoadAt !== null &&
			Date.now() - this.lastLoadAt > this.staleAfterMs
		) {
			this.markStaleAndRefresh("stale-timeout");
		}

		// Fast path: a fresh, held value that is not mid-refresh.
		if (this.state === "ready") {
			this.hits++;
			return this.value as T;
		}

		this.misses++;
		// A refresh is in flight: await the fresh value it produces — NEVER serve
		// a value older than the last invalidating write. Concurrent gets share
		// this single promise (no thundering herd).
		if (this.freshPromise) return this.freshPromise;
		// First load, recovery from a failed first load, or a load in flight:
		// ensureLoaded dedups concurrent callers onto a single load().
		return this.ensureLoaded();
	}

	private async ensureLoaded(): Promise<T> {
		if (this.loadingPromise) return this.loadingPromise;
		this.state = "loading";
		const start = Date.now();
		this.loadingPromise = (async () => {
			try {
				const value = await this.load(this.loadContext);
				this.value = value;
				this.stale = false;
				this.lastLoadAt = Date.now();
				this.lastLoadDurationMs = this.lastLoadAt - start;
				this.state = "ready";
				this.emit({
					cache: this.name,
					kind: "loaded",
					durationMs: this.lastLoadDurationMs,
				});
				return value;
			} catch (err) {
				this.failedLoads++;
				this.state = "failed";
				const message = err instanceof Error ? err.message : String(err);
				this.emit({
					cache: this.name,
					kind: "load-failed",
					error: message,
				});
				throw err;
			} finally {
				this.loadingPromise = null;
			}
		})();
		return this.loadingPromise;
	}

	/**
	 * Mark the held value stale (a write invalidated it) and start a refresh if
	 * one is not already in flight. Idempotent: a second call while a refresh
	 * runs leaves `stale` true so the running refresh performs one more reload to
	 * capture the later write (no lost wakeup).
	 */
	private markStaleAndRefresh(reason: "notify" | "stale-timeout" | "get"): void {
		this.stale = true;
		this.lastRefreshReason = reason;
		if (this.freshPromise) return; // a refresh is already running; stale stays true → it loops
		this.freshPromise = this.runRefreshLoop();
	}

	/**
	 * Refresh loop: reload until a load completes with no invalidation having
	 * arrived during it, then publish the fresh value. Returns the fresh value
	 * (or the prior value on failure) so a `get()` awaiting `freshPromise`
	 * receives it. This is the construction fix for the silent stale-read class:
	 * a value marked stale is reloaded before it is ever served again, so codegen
	 * can never read a registry snapshot older than the last write to it.
	 */
	private async runRefreshLoop(): Promise<T> {
		// If the initial load is still in flight, let it populate value/state
		// first, then reload to capture the invalidation (avoids a concurrent
		// double-load on a first-load-during-write race).
		if (this.loadingPromise) {
			try {
				await this.loadingPromise;
			} catch {
				/* initial load failed — fall through; the loop will retry */
			}
		}
		while (true) {
			// Optimistic: clear stale for this attempt. A NOTIFY landing during the
			// await below re-sets it, keeping the loop going for one more reload so
			// that write is captured (no lost wakeup).
			this.stale = false;
			this.state = "rehydrating";
			const start = Date.now();
			try {
				const value = await this.load(this.loadContext);
				this.value = value;
				this.lastLoadAt = Date.now();
				this.lastLoadDurationMs = this.lastLoadAt - start;
				if (!this.stale) {
					// No invalidation arrived during the load → value is fresh.
					this.state = "ready";
					this.freshPromise = null;
					this.emit({
						cache: this.name,
						kind: "rehydrated",
						durationMs: this.lastLoadDurationMs,
					});
					return value;
				}
				// A NOTIFY arrived during the load — reload to capture it.
				continue;
			} catch (err) {
				// Rehydrate failure leaves the prior value in place — no poisoning.
				// Reset stale so a failing upstream does not block every subsequent
				// get() on a refresh that keeps failing; the next NOTIFY or
				// staleAfterMs retries.
				this.failedLoads++;
				this.state = "ready"; // previous value remains usable
				this.stale = false;
				this.freshPromise = null;
				const message = err instanceof Error ? err.message : String(err);
				this.emit({
					cache: this.name,
					kind: "load-failed",
					error: `rehydrate(${this.lastRefreshReason}) failed: ${message}`,
				});
				return this.value as T;
			}
		}
	}

	/**
	 * Bind the cache to its NOTIFY channels. Called once at startup
	 * after configure(). Adapter is injected via constructor options or
	 * read from the configured bootloader; absence makes the cache
	 * purely interval-driven (or load-once if staleAfterMs is 0).
	 */
	async attach(): Promise<void> {
		if (!this.notifyAdapter) return;
		for (const channel of this.invalidateOn) {
			const unsubscribe = await this.notifyAdapter.listen(channel, () => {
				this.invalidations++;
				// Invalidate-on-write: the held value is now older than this write.
				// Mark it stale and refresh so the next get() returns the post-write
				// value, never the pre-write one.
				this.markStaleAndRefresh("notify");
				this.emit({
					cache: this.name,
					kind: "invalidated",
					channel,
				});
			});
			this.unsubscribers.push(unsubscribe);
		}
	}

	async detach(): Promise<void> {
		for (const unsub of this.unsubscribers) {
			try {
				await unsub();
			} catch {}
		}
		this.unsubscribers = [];
		if (this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
		}
	}

	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;
		this.emit({ cache: this.name, kind: "disabled" });
	}

	enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		this.emit({ cache: this.name, kind: "enabled" });
	}

	stats(): NotifyCacheStats {
		return {
			name: this.name,
			state: this.state,
			stale: this.stale,
			lastLoadAt: this.lastLoadAt,
			lastLoadDurationMs: this.lastLoadDurationMs,
			hits: this.hits,
			misses: this.misses,
			invalidations: this.invalidations,
			failedLoads: this.failedLoads,
			enabled: this.enabled,
		};
	}
}
