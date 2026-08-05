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
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export type UiAsset = {
  body: Buffer;
  contentType: string;
};

/**
 * The static half of the hub: a directory, served as a single-page app.
 *
 * Anything that is not a file on disk falls back to `index.html` so the page
 * owns its own routes. A request that escapes the UI directory is not a
 * fallback case — it is refused, because a path traversal on a process that
 * holds the desktop is the one bug worth being paranoid about here.
 *
 * Between those two, an extensionless path is tried as `.html`. That is what
 * makes `/orb` and `/chat` second pages rather than the first one served under
 * different URLs: without it every face the product grows would land on
 * `index.html` and have to sort itself out in script, which is a routing
 * decision made in the wrong process.
 *
 * The hub now serves two roots — its own `public/` for chat, the orb, and the
 * vendored modules, then the dashboard's built export. `spaFallback` is what
 * tells them apart: only the dashboard owns "everything else lands on the
 * page", so `public/` is asked without it and a miss there falls through to
 * the next root instead of answering with the wrong app's shell.
 */
export function readUiAsset(
  uiRoot: string,
  urlPath: string,
  options: { spaFallback?: boolean } = {},
): UiAsset | undefined {
  const root = path.resolve(uiRoot);
  const requested = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = path.resolve(root, `.${requested}`);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;

  const file =
    fileAt(candidate) ??
    (path.extname(candidate) ? undefined : fileAt(`${candidate}.html`)) ??
    ((options.spaFallback ?? true) ? fileAt(path.join(root, "index.html")) : undefined);
  if (!file) return undefined;

  return {
    body: fs.readFileSync(file),
    contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
  };
}

/**
 * Whether a dashboard export actually exists at this root. An unbuilt checkout
 * is a normal state — the answer decides between serving the app and serving
 * the sentence that says how to build it.
 */
export function dashboardIsBuilt(dashboardRoot: string): boolean {
  return fs.existsSync(path.join(path.resolve(dashboardRoot), "index.html"));
}

/**
 * What "/" says when the dashboard export is missing: a refusal with the fix
 * in it, never a blank 404. The other faces keep their addresses, and the
 * page says so, because a person landing here mid-setup deserves a map.
 */
export const UNBUILT_DASHBOARD_PAGE = [
  "The dashboard is not built yet.",
  "",
  "Build it with:  cd dashboard && pnpm install && pnpm build",
  "",
  "The chat page is still at /chat, and the orb at /orb.",
].join("\n");

function fileAt(candidate: string): string | undefined {
  if (!fs.existsSync(candidate)) return undefined;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) return fileAt(path.join(candidate, "index.html"));
  return stat.isFile() ? candidate : undefined;
}
