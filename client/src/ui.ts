import fs from "node:fs";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export type UiAsset = {
  body: Buffer;
  contentType: string;
};

/**
 * The static half of the hub: one directory, served as a single-page app.
 *
 * Anything that is not a file on disk falls back to `index.html` so the page
 * owns its own routes. A request that escapes the UI directory is not a
 * fallback case — it is refused, because a path traversal on a process that
 * holds the desktop is the one bug worth being paranoid about here.
 *
 * Between those two, an extensionless path is tried as `.html`. That is what
 * makes `/orb` a second page rather than the first one served under a different
 * URL: without it every face the product grows would land on `index.html` and
 * have to sort itself out in script, which is a routing decision made in the
 * wrong process.
 */
export function readUiAsset(uiRoot: string, urlPath: string): UiAsset | undefined {
  const root = path.resolve(uiRoot);
  const requested = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = path.resolve(root, `.${requested}`);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;

  const file =
    fileAt(candidate) ??
    (path.extname(candidate) ? undefined : fileAt(`${candidate}.html`)) ??
    fileAt(path.join(root, "index.html"));
  if (!file) return undefined;

  return {
    body: fs.readFileSync(file),
    contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
  };
}

function fileAt(candidate: string): string | undefined {
  if (!fs.existsSync(candidate)) return undefined;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) return fileAt(path.join(candidate, "index.html"));
  return stat.isFile() ? candidate : undefined;
}
