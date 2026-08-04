import path from "node:path";
import { expect, test } from "vitest";

import { readUiAsset } from "./ui.ts";

const uiRoot = path.resolve(import.meta.dirname, "..", "public");

test("no path escapes the ui directory", () => {
  // Each of these names a real file outside the UI directory. None of them may
  // ever come back as that file's bytes, however the path is spelled.
  for (const attempt of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "//../package.json"]) {
    const body = readUiAsset(uiRoot, attempt)?.body.toString() ?? "";
    expect(body).not.toContain("computer-controls-client");
  }
});

test("an unknown path falls back to the page so the SPA owns its routes", () => {
  const asset = readUiAsset(uiRoot, "/threads/abc");
  expect(asset?.contentType).toBe("text/html; charset=utf-8");
  expect(asset?.body.toString()).toContain("<title>computer controls</title>");
});
