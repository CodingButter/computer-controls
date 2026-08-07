/**
 * The push lane's view of the desktop service.
 *
 * ## Why this never starts the service
 *
 * Every tool in this plugin starts the service on demand — the model asked for
 * something, so the thing that answers should exist. The push lane must not
 * work that way. It runs on every turn of every session, including the ones
 * that will never touch the desktop, and a plugin that spawns a daemon merely
 * because it loaded is bad company to keep.
 *
 * So the lane attaches to a service that is already running and is silent
 * otherwise. Two things count as already running: a private service some tool
 * call started earlier in this session, and a shared daemon that was listening
 * before this client existed. Attaching to the second one is what lets a delta
 * reach the model on a turn where nothing was asked of the desktop at all.
 */
import type { DeltaLike, DesktopSource } from "./desktop-signal-provider.ts";

/** The slice of the supervisor this needs, narrow enough to fake in tests. */
export interface ServiceHandle {
  readonly running: boolean;
  /** Connect to a service that already exists. Never starts one. */
  attachIfListening?(): Promise<boolean>;
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Raised when the service is not up. Caught by the provider's fail-soft poll. */
export class ServiceNotRunning extends Error {
  constructor() {
    super("The desktop service is not running; the push lane stays quiet.");
  }
}

/**
 * Identifies this client to the service.
 *
 * Attribution is computed per asker, so the id the push lane polls under must
 * be the same one the tools act under — otherwise this lane would report the
 * model's own actions back to it as somebody else's news.
 */
export const PUSH_CLIENT_ID = "mastracode";

export function serviceSource(service: ServiceHandle): DesktopSource {
  const ask = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (!service.running && !(await service.attachIfListening?.())) throw new ServiceNotRunning();
    return await service.request<T>(method, { ...params, clientId: PUSH_CLIENT_ID });
  };

  return {
    async revision(): Promise<number> {
      const result = await ask<{ revision: number }>("getRevision", {});
      return result.revision;
    },
    async since(revision: number): Promise<DeltaLike> {
      return await ask<DeltaLike>("getDeltaSince", { sinceRevision: revision });
    },
  };
}
