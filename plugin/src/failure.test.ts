import { describe, expect, it } from "vitest";

import { DesktopServiceError } from "./client.ts";
import { describeFailure } from "./index.ts";

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
