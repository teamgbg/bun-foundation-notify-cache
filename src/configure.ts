/**
 * @system notify-cache
 * @status handwritten
 * @edit edit directly
 *
 * Bootloader injection per constitution `configured-primitives`.
 * Consumers (services, daemons) call configure() at startup, providing
 * the NotifyAdapter (their LISTEN client) and the load context (a sql
 * client or whatever the loader closures want).
 *
 * Until configured, caches still work for unit tests via the
 * `notifyAdapter` and `loadContext` options on createNotifyCache directly.
 * Production code goes through configure() so the wiring is centralised.
 */

import type { NotifyAdapter } from "./types.ts";

interface NotifyCacheConfig {
	notifyAdapter: NotifyAdapter | null;
	loadContext: unknown;
}

let _config: NotifyCacheConfig = {
	notifyAdapter: null,
	loadContext: null,
};

export function configure(config: Partial<NotifyCacheConfig>): void {
	_config = { ..._config, ...config };
}

export function getNotifyAdapter(): NotifyAdapter | null {
	return _config.notifyAdapter;
}

export function getLoadContext(): unknown {
	return _config.loadContext;
}
