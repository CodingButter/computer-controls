import { expect, test } from "vitest";

import { venvPython } from "./platform.ts";
import { daemonSocketPath } from "./supervisor.ts";

/**
 * What the supervisor knows about the machine it is on. The per-OS addresses
 * themselves are proven in `clients/shared/src/endpoint.test.ts`, where they
 * now live; what remains here is the supervisor's own two questions.
 */

test("an operator naming a socket outranks every OS convention", () => {
  const previous = process.env.MASTRACODE_DESKTOP_SOCKET;
  process.env.MASTRACODE_DESKTOP_SOCKET = "/tmp/chosen.sock";
  try {
    expect(daemonSocketPath()).toBe("/tmp/chosen.sock");
  } finally {
    if (previous === undefined) delete process.env.MASTRACODE_DESKTOP_SOCKET;
    else process.env.MASTRACODE_DESKTOP_SOCKET = previous;
  }
});

test("the virtualenv interpreter is where each OS actually puts it", () => {
  expect(venvPython("/repo/comcon", "linux")).toBe("/repo/comcon/.venv/bin/python");
  // The one difference between a working spawn and a confusing "virtualenv is
  // missing" on Windows.
  expect(venvPython("/repo/comcon", "win32")).toContain("Scripts");
});
