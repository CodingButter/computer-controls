import { describe, expect, it } from "vitest";

import { PUSH_CLIENT_ID, serviceSource, ServiceNotRunning, type ServiceHandle } from "./source.ts";

class FakeService implements ServiceHandle {
  running = true;
  daemonListening = false;
  attachAttempts = 0;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  answer: unknown = { revision: 7, changes: [], complete: true };

  async attachIfListening(): Promise<boolean> {
    this.attachAttempts += 1;
    this.running = this.daemonListening;
    return this.daemonListening;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    return this.answer as T;
  }
}

describe("the push lane's view of the service", () => {
  it("refuses to start a service nobody asked for", async () => {
    const service = new FakeService();
    service.running = false;
    const source = serviceSource(service);
    await expect(source.revision()).rejects.toBeInstanceOf(ServiceNotRunning);
    await expect(source.since(0)).rejects.toBeInstanceOf(ServiceNotRunning);
    expect(service.calls).toEqual([]);
  });

  it("attaches to a daemon that is already listening", async () => {
    // The lane may join a service that exists; it may not bring one into being.
    // This is the case that carries a delta to a turn which asked the desktop
    // for nothing.
    const service = new FakeService();
    service.running = false;
    service.daemonListening = true;
    await expect(serviceSource(service).revision()).resolves.toBe(7);
    expect(service.attachAttempts).toBe(1);
  });

  it("polls under the same client id the tools act under", async () => {
    // Attribution is computed per asker. Polling under a different id would
    // report the model's own actions back to it as somebody else's news.
    const service = new FakeService();
    const source = serviceSource(service);
    await source.revision();
    await source.since(3);
    expect(service.calls.map(call => call.method)).toEqual(["getRevision", "getDeltaSince"]);
    for (const call of service.calls) {
      expect(call.params.clientId).toBe(PUSH_CLIENT_ID);
    }
    expect(service.calls[1]?.params.sinceRevision).toBe(3);
  });

  it("unwraps the revision the service reports", async () => {
    const service = new FakeService();
    service.answer = { revision: 42 };
    await expect(serviceSource(service).revision()).resolves.toBe(42);
  });
});
