#!/usr/bin/env node
/**
 * Prove: an unpermitted application is invisible until the user says otherwise.
 *
 * The claim has five steps and only the first three can be taken by a machine:
 *
 *   1. With Discord unpermitted, the daemon's census does not offer it.
 *   2. Asked to act on Discord, the hub says it has no permission yet, and names
 *      the page where that is fixed.
 *   3. Permitting Discord through the same route the page uses rewrites the
 *      user's own config file, and the daemon's ceiling follows it — no restart,
 *      no socket call, no agent-facing widening.
 *   4. The launcher is cured and the application is restarted. A human does this
 *      half: nothing here kills a running program.
 *   5. Discord's window reads as a real tree rather than a title.
 *
 * So this script stops at the human step and says so. A partial run is an honest
 * artifact; a partial run reported as a pass is a lie with a filename.
 *
 * Usage:
 *   node scripts/prove-permissions-live.mjs [--base http://127.0.0.1:4111]
 *                                           [--app Discord]
 *                                           [--out docs/proofs/...md]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  console.error(
    "This measures a live hub and a live daemon. A test environment boots a hub that opens neither.",
  );
  process.exit(2);
}

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const BASE = flag("base", "http://127.0.0.1:4111").replace(/\/$/, "");
const APP = flag("app", "Discord");
const OUT = flag(
  "out",
  "docs/proofs/an-unpermitted-application-is-invisible-until-the-user-says-otherwise.md",
);
const CONFIG_PATH = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "mastracode-desktop",
  "config.json",
);

/** Every measurement, in order, exactly as it was observed. */
const steps = [];

function record(step) {
  steps.push(step);
  const mark = step.held === undefined ? "·" : step.held ? "✓" : "✗";
  console.log(`${mark} ${step.name}: ${step.measured}`);
}

async function hub(pathname, init) {
  const response = await fetch(`${BASE}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function readConfig() {
  try {
    return readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    return `<unreadable: ${error.message}>`;
  }
}

function rowFor(view, name) {
  const rows = view?.applications ?? [];
  return rows.find((row) => row.name.toLowerCase() === name.toLowerCase());
}

async function main() {
  const startedAt = new Date().toISOString();

  // Environment first: a measurement without the machine it was taken on is a
  // number without units.
  const health = await hub("/api/health");
  if (health.status !== 200) {
    console.error(`The hub at ${BASE} did not answer /api/health (${health.status}).`);
    process.exit(3);
  }

  // --- Step 1: the census with the application unpermitted ---------------
  const before = await hub("/api/permissions");
  if (before.status !== 200) {
    console.error(`/api/permissions answered ${before.status}: ${JSON.stringify(before.body)}`);
    process.exit(3);
  }
  const rowBefore = rowFor(before.body, APP);
  const modeBefore = before.body.mode;
  const wasPermitted = rowBefore?.permitted ?? false;

  if (wasPermitted) {
    // The arc starts from unpermitted. Put it back, and say that we did.
    await hub(`/api/permissions/${encodeURIComponent(APP)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permitted: false }),
    });
  }
  const unpermitted = await hub("/api/permissions");
  const rowUnpermitted = rowFor(unpermitted.body, APP);
  record({
    name: `${APP} is unpermitted`,
    measured: `mode=${unpermitted.body.mode} permitted=${rowUnpermitted?.permitted} readable=${rowUnpermitted?.readable} running=${rowUnpermitted?.running}`,
    held: rowUnpermitted?.permitted === false,
    detail: {
      modeAtStart: modeBefore,
      permittedAtStart: wasPermitted,
      restoredToUnpermitted: wasPermitted,
    },
  });

  // --- Step 2: the hub says it has no permission yet ----------------------
  const asked = await hub("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: `List the windows that ${APP} currently has open.`,
    }),
  });
  const reply = typeof asked.body === "string" ? asked.body : (asked.body.reply ?? JSON.stringify(asked.body));
  const namesTheApp = new RegExp(APP, "i").test(reply);
  const namesTheRemedy = /permission/i.test(reply);
  record({
    name: "the answer says there is no permission yet",
    measured: `status=${asked.status} namesApp=${namesTheApp} namesPermission=${namesTheRemedy}`,
    held: asked.status === 200 && namesTheApp && namesTheRemedy,
    detail: { reply },
  });

  // --- Step 3: permitting it rewrites the user's file, ceiling follows ----
  const configBefore = readConfig();
  const put = await hub(`/api/permissions/${encodeURIComponent(APP)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permitted: true }),
  });
  const configAfter = readConfig();
  const parsed = (() => {
    try {
      return JSON.parse(configAfter);
    } catch {
      return undefined;
    }
  })();
  const namedInFile = JSON.stringify(parsed?.scopes?.applications ?? []).toLowerCase().includes(APP.toLowerCase());

  // The reload is lazy: the daemon re-reads the file on the next request. So the
  // proof of the reload is the next answer, not a log line.
  const after = await hub("/api/permissions");
  const rowAfter = rowFor(after.body, APP);
  record({
    name: "permitting it changes the ceiling without a restart",
    measured: `put=${put.status} mode=${after.body.mode} inFile=${namedInFile} permitted=${rowAfter?.permitted} readable=${rowAfter?.readable}`,
    held: put.status === 200 && namedInFile && rowAfter?.permitted === true,
    detail: {
      configPath: CONFIG_PATH,
      modeBefore: JSON.parse(configBefore || "{}")?.scopes?.permissionsMode ?? "<absent>",
      modeAfter: parsed?.scopes?.permissionsMode,
      applicationsCount: (parsed?.scopes?.applications ?? []).length,
    },
  });

  // --- Step 4: the human half ---------------------------------------------
  const cure = await hub("/api/permissions/cure", { method: "POST" });
  const cureBody = cure.body ?? {};
  record({
    name: "the launcher is cured",
    measured: `cured=${JSON.stringify(cureBody.cured ?? [])} alreadyCured=${JSON.stringify((cureBody.alreadyCured ?? []).map((entry) => entry.name ?? entry))}`,
    held: cure.status === 200,
    detail: cureBody,
  });

  const readable = rowFor(after.body, APP)?.readable === true;
  record({
    name: `${APP} reads as a real tree`,
    measured: readable
      ? "readable now (it was launched from a cured shortcut)"
      : "NOT MEASURED — waiting on a human: the application must be restarted from its cured launcher",
    held: readable ? true : undefined,
  });

  const partial = steps.some((step) => step.held === undefined);
  const failed = steps.some((step) => step.held === false);

  const lines = [
    "# An unpermitted application is invisible until the user says otherwise",
    "",
    `- Measured: ${startedAt}`,
    `- Hub: ${BASE}`,
    `- Application: ${APP}`,
    `- Config: \`${CONFIG_PATH}\``,
    "",
    failed
      ? "**The claim did not hold.** The failing measurement is marked below."
      : partial
        ? "**Partial run.** Every machine-checkable step held. The remaining step needs a person to restart the application from its cured launcher, and this script does not kill running programs."
        : "**The claim holds.**",
    "",
    "## Measurements",
    "",
    "| Step | Result | Measured |",
    "| --- | --- | --- |",
    ...steps.map(
      (step) =>
        `| ${step.name} | ${step.held === undefined ? "waiting on a human" : step.held ? "held" : "did not hold"} | ${step.measured.replace(/\|/g, "\\|")} |`,
    ),
    "",
    "## Detail",
    "",
    "```json",
    JSON.stringify(steps, undefined, 2),
    "```",
    "",
    "The script arranged none of this. It asked the hub the same questions the",
    "page asks, wrote through the same route the page writes through, and copied",
    "down what came back.",
    "",
  ];

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, lines.join("\n"), "utf8");
  console.log(`\nArtifact: ${OUT}`);

  if (failed) process.exit(1);
  if (partial) {
    console.log("\nwaiting on HUMAN: Jamie must restart " + APP + " from its cured launcher.");
    process.exit(4);
  }
}

await main();
