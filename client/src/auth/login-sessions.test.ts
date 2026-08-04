/**
 * The session store on its own, where the clock can be moved.
 *
 * The route suite proves ownership from the outside, which is where it matters.
 * What it cannot reach is expiry: a half-finished login is a PKCE verifier
 * sitting in memory, and "it goes away eventually" is a claim that needs a
 * clock to test rather than a fifteen-minute test run.
 */

import { describe, expect, it } from "vitest";

import { InMemoryLoginSessionStore } from "./login-sessions.ts";

function makeStore(startAt = 1_000_000) {
  let now = startAt;
  const store = new InMemoryLoginSessionStore({ now: () => now });
  return { store, advance: (ms: number) => (now += ms), at: () => now };
}

const OWNER = "owner-1";

describe("login sessions", () => {
  it("answers for the owner", () => {
    const { store, at } = makeStore();
    const session = store.create({
      ownerId: OWNER,
      provider: "anthropic",
      instruction: { url: "https://example.test/authorize" },
      state: { kind: "paste-code", verifier: "secret" },
      expiresAt: at() + 60_000,
    });

    expect(store.loadOwnedSession(session.id, OWNER)?.id).toBe(session.id);
  });

  it("gives a stranger the same answer as a bad id", () => {
    const { store, at } = makeStore();
    const session = store.create({
      ownerId: OWNER,
      provider: "anthropic",
      instruction: { url: "https://example.test/authorize" },
      state: { kind: "paste-code", verifier: "secret" },
      expiresAt: at() + 60_000,
    });

    expect(store.loadOwnedSession(session.id, "someone-else")).toBeUndefined();
    expect(store.loadOwnedSession("no-such-session", OWNER)).toBeUndefined();
  });

  it("forgets a flow once its deadline passes", () => {
    const { store, advance, at } = makeStore();
    const session = store.create({
      ownerId: OWNER,
      provider: "openai",
      instruction: { url: "https://example.test/device", userCode: "ABCD" },
      state: {
        kind: "device-code",
        pending: {
          deviceAuthId: "d1",
          userCode: "ABCD",
          url: "https://example.test/device",
          instructions: "",
          intervalMs: 5_000,
          deadlineAt: at() + 60_000,
        },
      },
      expiresAt: at() + 60_000,
    });

    advance(59_999);
    expect(store.loadOwnedSession(session.id, OWNER)).toBeDefined();

    advance(2);
    expect(store.loadOwnedSession(session.id, OWNER)).toBeUndefined();
  });

  it("sweeps abandoned flows rather than holding their secrets forever", () => {
    const { store, advance, at } = makeStore();
    const abandoned = store.create({
      ownerId: OWNER,
      provider: "anthropic",
      instruction: { url: "https://example.test/authorize" },
      state: { kind: "paste-code", verifier: "secret" },
      expiresAt: at() + 60_000,
    });

    advance(60_001);
    // Nobody ever came back for it. Starting an unrelated flow is what finally
    // clears it out, which is the only moment the store is running at all.
    store.create({
      ownerId: "owner-2",
      provider: "anthropic",
      instruction: { url: "https://example.test/authorize" },
      state: { kind: "paste-code", verifier: "another" },
      expiresAt: at() + 60_000,
    });

    expect(store.loadOwnedSession(abandoned.id, OWNER)).toBeUndefined();
  });
});
