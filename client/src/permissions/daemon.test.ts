import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { findDaemonSocket } from "./daemon.ts";

/**
 * Socket discovery has to survive both daemon shapes that exist in the wild:
 * a shared daemon on daemon-<digest>.sock and a supervised session daemon on
 * mc-<pid>.sock. The permissions page only asks an observe-class question, so
 * either will do — but a discovery that only knew the shared name rendered
 * "daemon unreachable" on a machine where a session daemon was answering fine.
 */

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function runtimeWith(...sockets: string[]): NodeJS.ProcessEnv {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perm-daemon-"));
  fs.mkdirSync(path.join(tmp, "mastracode-desktop"));
  for (const name of sockets) {
    fs.writeFileSync(path.join(tmp, "mastracode-desktop", name), "");
  }
  return { XDG_RUNTIME_DIR: tmp };
}

test("an explicit MASTRACODE_DESKTOP_SOCKET wins outright", () => {
  expect(findDaemonSocket({ MASTRACODE_DESKTOP_SOCKET: "/tmp/explicit.sock" })).toBe(
    "/tmp/explicit.sock",
  );
});

test("a shared daemon socket is found by its daemon- prefix", () => {
  const env = runtimeWith("daemon-abc123.sock");
  expect(findDaemonSocket(env)).toMatch(/daemon-abc123\.sock$/);
});

test("a session daemon socket is found when no shared daemon exists", () => {
  const env = runtimeWith("mc-728799.sock");
  expect(findDaemonSocket(env)).toMatch(/mc-728799\.sock$/);
});

test("the shared daemon is preferred when both shapes exist", () => {
  const env = runtimeWith("mc-728799.sock", "daemon-abc123.sock");
  expect(findDaemonSocket(env)).toMatch(/daemon-abc123\.sock$/);
});

test("no sockets at all means no daemon, not an error", () => {
  const env = runtimeWith();
  expect(findDaemonSocket(env)).toBeUndefined();
});
