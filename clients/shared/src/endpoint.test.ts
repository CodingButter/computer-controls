import { expect, test } from "vitest";

import {
  daemonEndpointFor,
  endpointIsFile,
  freedesktopDaemonEndpoint,
} from "./endpoint.ts";
import { SCHEMA_DIGEST } from "./protocol.generated.ts";

/**
 * Where a client dials, per OS.
 *
 * Every case goes through the adapter with an environment handed in, so the
 * Windows and macOS answers are testable from the Linux machine this is
 * developed on — which is the only reason those adapters can be trusted before
 * anyone runs them.
 */

test("a freedesktop session dials the runtime directory", () => {
  const endpoint = daemonEndpointFor("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });

  expect(endpoint).toBe(`/run/user/1000/mastracode-desktop/daemon-${SCHEMA_DIGEST}.sock`);
});

test("a session that arrives without the runtime variable still finds the socket", () => {
  // A plain ssh login is the common case; the directory is usually there even
  // when the variable is not.
  expect(freedesktopDaemonEndpoint({})).toMatch(
    new RegExp(`^/run/user/\\d+/mastracode-desktop/daemon-${SCHEMA_DIGEST}\\.sock$`),
  );
});

test("macOS has no runtime directory, so the per-user temp directory stands in", () => {
  expect(daemonEndpointFor("darwin", { TMPDIR: "/var/folders/ab/T/" })).toBe(
    `/var/folders/ab/T/mastracode-desktop/daemon-${SCHEMA_DIGEST}.sock`,
  );
});

test("Windows gets a named pipe, which is not a path on disk", () => {
  const endpoint = daemonEndpointFor("win32", {});

  expect(endpoint).toBe(`\\\\.\\pipe\\mastracode-desktop-daemon-${SCHEMA_DIGEST}`);
  // The distinction callers have to respect: nothing may stat, mkdir, or unlink
  // this the way it can a unix socket.
  expect(endpointIsFile("win32")).toBe(false);
  expect(endpointIsFile("linux")).toBe(true);
});

test("the schema digest is in every address, so mismatched builds never meet", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    expect(daemonEndpointFor(platform, {})).toContain(SCHEMA_DIGEST);
  }
});
