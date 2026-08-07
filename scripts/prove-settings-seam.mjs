#!/usr/bin/env node
/**
 * Proves that the Settings page and the hub route agree, and that saving
 * through the page cannot lose a key the page does not draw.
 *
 * The question this settles: the write path lives in the client package and the
 * three lenses live in the dashboard package, and each is tested against its
 * own fixtures. A disagreement between them — a renamed field in the response,
 * an edit body the route would refuse, a key the page thinks it owns and does
 * not — passes both suites and fails only on a real machine, silently, in the
 * direction of somebody's configuration file.
 *
 * Neither test lane can see that seam, because neither package may import the
 * other: the client's tsconfig covers `src` alone, and the dashboard is a
 * static export with no server. So the proof is a third thing that imports
 * both, serves the real route over real HTTP against a real file, and drives it
 * with the dashboard's own client and parser.
 *
 * Runs under plain node, never under vitest, and needs no credentials, no
 * daemon and no desktop — unlike the live proofs beside it, this one is
 * repeatable anywhere, which is the point of writing it down rather than
 * checking it once by hand.
 *
 * Usage: node scripts/prove-settings-seam.mjs
 * Exits non-zero when the claim does not hold, because that is still an answer.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CLAIM =
  "the Settings page's lenses and the hub's configuration route agree, and no save loses an undrawn key";

const { serve } = await import(
  join(ROOT, "client/node_modules/@hono/node-server/dist/index.mjs")
);
const { buildDesktopConfigApp } = await import(join(ROOT, "client/src/desktop-config/routes.ts"));
const { parseDesktopConfig } = await import(join(ROOT, "dashboard/src/lib/hub/desktop-config.ts"));

/**
 * The field keys the lenses draw, lifted from the panel by reading it rather
 * than by copying it. The component itself cannot be imported here — it is TSX
 * with a bundler alias — and a second hand-written list would be the very drift
 * this script exists to catch.
 */
const PANEL = await readFile(join(ROOT, "dashboard/src/components/settings/settings.tsx"), "utf8");
const DRAWN_KEYS = [...PANEL.matchAll(/^\s*key: "([^"]+)",$/gm)].map((match) => match[1]);

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const dir = await mkdtemp(join(tmpdir(), "settings-seam-"));
const file = join(dir, "config.json");

/**
 * A configuration as a real one looks after a while: fields the page draws, the
 * registry the Permissions page owns, a key from a version this build has never
 * seen, and one a person wrote by hand.
 */
const ORIGINAL = {
  scopes: {
    operationClasses: ["observe", "edit"],
    applications: ["Discord"],
    blockedApplications: ["bitwarden"],
    somethingFromNextYear: { nested: true },
  },
  aKeyNobodyHasTaughtThisPageAbout: 42,
};
await writeFile(file, JSON.stringify(ORIGINAL, null, 2));

const server = serve({ fetch: buildDesktopConfigApp({ file }).fetch, port: 0 });
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/desktop-config`;

// 1. The read, through the parser the page actually uses.
const view = parseDesktopConfig(await (await fetch(base)).json());
check("the route's response parses with the dashboard's own parser", view.path === file && view.exists);
check("the daemon's vocabulary arrives whole", view.vocabulary.operationClasses.length === 5, view.vocabulary);
check("the daemon's defaults arrive", view.defaults.idleExpirySeconds === 1800, view.defaults);
check(
  "every field the lenses draw is a key the route will accept",
  DRAWN_KEYS.length > 0 && DRAWN_KEYS.every((key) => view.owns.includes(key)),
  { drawn: DRAWN_KEYS, owns: view.owns },
);

// 2. The write, in the page's exact body shape.
async function put(edits) {
  const response = await fetch(base, {
    method: "PUT",
    body: JSON.stringify({ edits }),
    headers: { "content-type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
}

const saved = await put({ "scopes.permissionsMode": "per-application" });
check("the body shape the page sends is the body shape the route reads", saved.status === 200, saved.body);

for (const edits of [
  { "scopes.idleExpirySeconds": 900 },
  { "scopes.confirmClasses": ["submit", "destructive"] },
  { audit: false },
  { sensitiveApplications: ["bitwarden", "keepassxc"] },
]) {
  const answer = await put(edits);
  if (answer.status !== 200) check(`saving ${Object.keys(edits)[0]}`, false, answer.body);
}

// 3. The claim itself: five saves later, everything undrawn is untouched.
const after = JSON.parse(await readFile(file, "utf8"));
check("the hand-written top-level key survived five saves", after.aKeyNobodyHasTaughtThisPageAbout === 42);
check(
  "the registry the Permissions page owns survived",
  JSON.stringify(after.scopes.applications) === '["Discord"]' &&
    JSON.stringify(after.scopes.blockedApplications) === '["bitwarden"]',
  after.scopes,
);
check(
  "a nested key from a version this page has never seen survived",
  after.scopes.somethingFromNextYear?.nested === true,
  after.scopes,
);
check(
  "and the edits themselves landed",
  after.scopes.permissionsMode === "per-application" && after.audit === false && after.scopes.idleExpirySeconds === 900,
  after,
);

// 4. The two refusals the page must show rather than paper over.
const unowned = await put({ "scopes.applications": ["Anything"] });
check("a key no lens owns is refused rather than dropped", unowned.status === 400, unowned);
check(
  "and the refusal names the key, so the page can show a sentence",
  String(unowned.body.error).includes("scopes.applications"),
  unowned.body,
);

await writeFile(file, "{ not json");
check("a file that will not parse answers 409, the page's refused state", (await fetch(base)).status === 409);
check("and reading it did not overwrite it", (await readFile(file, "utf8")) === "{ not json");

server.close();

console.log(`\n${failures === 0 ? "PROVED" : "REFUTED"}: ${CLAIM}`);
process.exit(failures === 0 ? 0 : 1);
