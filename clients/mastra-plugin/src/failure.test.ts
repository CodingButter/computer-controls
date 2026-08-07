import { describe, expect, it } from "vitest";

import { DesktopServiceError } from "./client.ts";
import { describeFailure, staleDaemonHint } from "./index.ts";

describe("service failures reaching the model", () => {
  it("carries the reason a startup failed, not just that it failed", () => {
    // The real one: the socket was held by an older service that was still alive
    // and answering, so the new one refused to bind. Reported as a bare exit code,
    // this took a process listing and a manual socket probe to diagnose.
    const error = new DesktopServiceError(
      "BACKEND_UNAVAILABLE",
      "The desktop service exited with code 1 before it was ready",
      {
        stderr: [
          "Traceback (most recent call last):",
          '  File "server.py", line 563, in main',
          "    server.start()",
          "desktop_service.errors.DesktopError: another desktop service is already",
          "listening on /run/user/1000/mastracode-desktop/mc-1.sock",
        ].join("\n"),
      },
    );

    expect(() => describeFailure(error)).toThrowError(/already/);
  });

  it("says nothing extra when there is nothing extra to say", () => {
    const error = new DesktopServiceError("WINDOW_NOT_FOUND", "No window 'win-1'");
    expect(() => describeFailure(error)).toThrowError("[WINDOW_NOT_FOUND] No window 'win-1'");
  });

  it("leaves errors it does not understand alone", () => {
    const error = new TypeError("something else entirely");
    expect(() => describeFailure(error)).toThrowError(error);
  });
});

describe("a method the running service has never heard of", () => {
  // The real one, and it cost forty minutes: the capture backend had been
  // written, tested and was sitting on disk, while the daemon everything
  // attached to had been running since before it existed. The tool call failed
  // with METHOD_NOT_FOUND against types that swore the method was there.

  it("names the stale daemon when the digests disagree", () => {
    const hint = staleDaemonHint("aaaa1111", "bbbb2222");
    expect(hint).toMatch(/aaaa1111/);
    expect(hint).toMatch(/bbbb2222/);
    expect(hint).toMatch(/restart/i);
  });

  it("treats a service too old to answer as older, not as unknown", () => {
    // A service that predates the field cannot report its digest, and that
    // silence is not ambiguity: only an older build fails to send it.
    expect(staleDaemonHint(undefined, "bbbb2222")).toMatch(/restart/i);
  });

  it("says nothing when the digests agree", () => {
    // Then the missing method is a real bug and a confident guess about stale
    // processes would send the reader in the wrong direction.
    expect(staleDaemonHint("same", "same")).toBe("");
  });
});
