#!/usr/bin/env node
/**
 * Proves which kind of OpenAI credential the voice lane will actually accept.
 *
 * The question this settles: signing in with a ChatGPT account mints a token
 * through the Codex device flow, and the SDK hands that token back as the
 * provider's API key. Whether OpenAI's speech endpoints accept it is a
 * different question from whether the chat models do, and no unit test can
 * answer it — past the request is OpenAI's own authorization, so the only way
 * to know is to ask it.
 *
 * Runs under plain node, never under vitest, and not only because there is
 * nothing to assert: the SDK substitutes a placeholder credential when it sees
 * a test environment, which would make a real token look broken.
 *
 * Usage: node scripts/prove-voice-credential.mjs [--out docs/proofs/<name>.md]
 * Exits non-zero when the claim does not hold, because that is still an answer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, release, type as osType } from "node:os";

const SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const SPEECH_MODEL = "tts-1";
const SPEAKER = "nova";
const PHRASE = "The voice lane is awake.";
const PROVIDER = "openai-codex";

const CLAIM =
  "a credential minted by the ChatGPT device flow authenticates OpenAI's speech endpoints";

const outFlag = process.argv.indexOf("--out");
const OUT =
  outFlag === -1
    ? "docs/proofs/which-credential-the-voice-lane-accepts.md"
    : process.argv[outFlag + 1];

for (const leak of ["VITEST", "NODE_ENV"]) {
  if (process.env[leak]) {
    console.error(
      `refusing to run with ${leak} set: a test environment makes the SDK ` +
        `substitute a placeholder credential, and the result would be a lie.`,
    );
    process.exit(2);
  }
}

function authFile() {
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "mastracode", "auth.json");
}

/** Reads stored credentials without ever printing one. */
function storedCredentials() {
  const path = authFile();
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { path, kinds: [], error: error.message };
  }

  const kinds = [];
  const oauth = raw[PROVIDER];
  if (oauth?.access) {
    kinds.push({
      kind: "chatgpt-oauth",
      how: `auth.json ${PROVIDER}.access`,
      key: oauth.access,
    });
  }
  const pasted = raw[`apikey:${PROVIDER}`] ?? raw["apikey:openai"];
  if (typeof pasted === "string" && pasted) {
    kinds.push({ kind: "api-key", how: "auth.json apikey:*", key: pasted });
  }
  if (process.env.OPENAI_API_KEY) {
    kinds.push({
      kind: "api-key",
      how: "OPENAI_API_KEY",
      key: process.env.OPENAI_API_KEY,
    });
  }
  return { path, kinds };
}

/** Describes a credential by shape alone. A token is never printed. */
function shapeOf(key) {
  return `${key.length} chars, starts ${JSON.stringify(key.slice(0, 3))}, ends ${JSON.stringify(key.slice(-2))}`;
}

const MP3_HEADERS = [
  [0x49, 0x44, 0x33], // ID3
  [0xff, 0xfb],
  [0xff, 0xf3],
  [0xff, 0xf2],
];

function looksLikeMp3(bytes) {
  return MP3_HEADERS.some((header) =>
    header.every((byte, index) => bytes[index] === byte),
  );
}

async function roundTrip({ kind, how, key }) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        voice: SPEAKER,
        input: PHRASE,
        response_format: "mp3",
      }),
    });
  } catch (error) {
    return {
      kind,
      how,
      shape: shapeOf(key),
      accepted: false,
      status: "no response",
      detail: error.message,
      ms: Date.now() - started,
    };
  }

  const ms = Date.now() - started;
  if (!response.ok) {
    const text = await response.text();
    return {
      kind,
      how,
      shape: shapeOf(key),
      accepted: false,
      status: `${response.status} ${response.statusText}`,
      detail: text.slice(0, 400).replace(/\s+/g, " "),
      ms,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    kind,
    how,
    shape: shapeOf(key),
    accepted: true,
    status: `${response.status} ${response.statusText}`,
    detail: `${bytes.length} bytes, mp3 header ${looksLikeMp3(bytes) ? "present" : "ABSENT"}`,
    audible: looksLikeMp3(bytes) && bytes.length > 0,
    ms,
  };
}

function osName() {
  try {
    return execFileSync("bash", ["-lc", ". /etc/os-release && echo $PRETTY_NAME"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return `${osType()} ${release()}`;
  }
}

const { path, kinds, error } = storedCredentials();

if (kinds.length === 0) {
  console.error(
    `No OpenAI credential found (looked in ${path}${error ? `: ${error}` : ""}, and in OPENAI_API_KEY).`,
  );
  console.error(
    `This proof needs a machine where an OpenAI account is connected. ` +
      `Nothing was written: an artifact for a run that did not happen is worse than no artifact.`,
  );
  process.exit(3);
}

const results = [];
for (const credential of kinds) {
  const result = await roundTrip(credential);
  results.push(result);
  console.log(
    `${result.kind} via ${result.how}: ${result.accepted ? "ACCEPTED" : "REFUSED"} (${result.status})`,
  );
}

const chatgpt = results.find((r) => r.kind === "chatgpt-oauth");
const holds = Boolean(chatgpt?.accepted && chatgpt?.audible);
const untested = !chatgpt;

const rows = results
  .map(
    (r) =>
      `| ${r.kind} | ${r.how} | ${r.accepted ? "yes" : "NO"} | \`${r.status}\` | ${r.detail} | ${r.ms} ms |`,
  )
  .join("\n");

const verdict = untested
  ? "THE CLAIM WAS NOT TESTED — no ChatGPT-account credential was present"
  : holds
    ? "THE CLAIM HOLDS"
    : "THE CLAIM DOES NOT HOLD";

const consequence = holds
  ? `Signing in with a ChatGPT account is enough for the whole product: the same
login that gives the agent its brain also gives it a mouth and ears.`
  : untested
    ? `Unknown, and deliberately recorded as unknown. Until this runs on a machine
with a ChatGPT-account login, the client must keep treating both credential kinds
as possible, which is why the credential's kind is carried rather than flattened
into a bare string.`
    : `A ChatGPT account is not enough for voice. The voice lane needs a platform
API key, which makes the pasted-key path load-bearing rather than a convenience:
a person who signed in with ChatGPT alone must be told, in the UI, that voice
needs one more thing.`;

const artifact = `# Proof: ${CLAIM.replace(/^a /, "which ")}

Generated by \`scripts/prove-voice-credential.mjs\`. Not hand-written, and not
reachable by a unit test: past the request is OpenAI's own authorization, and the
only way to know whether a credential is accepted is to spend it.

**Verdict: ${verdict}**

## Environment

| | |
|---|---|
| Measured | ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC |
| Operating system | ${osName()} |
| Node | ${process.version} |
| Endpoint | \`POST ${SPEECH_ENDPOINT}\` |
| Model | \`${SPEECH_MODEL}\`, speaker \`${SPEAKER}\` |
| Credential source | \`${path}\` |

## What was asked of the run

The same request, once per credential the machine holds. Tokens are described by
shape only; none is printed here or anywhere else by the script.

| Credential kind | Where it came from | Accepted | Status | What came back | Took |
|---|---|---|---|---|---|
${rows}

## Credential shapes

${results.map((r) => `- ${r.kind} (${r.how}): ${r.shape}`).join("\n")}

## What this means for the client

${consequence}

## What this does not say

One endpoint, one moment. Speech was asked because it is the cheapest of the
three; transcription and the realtime socket authorize separately and could
answer differently. A refusal recorded here is a refusal by OpenAI, not proof
that the credential is malformed — the shapes above are printed so that the two
can be told apart.
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, artifact);
console.log(`\nWrote ${OUT}`);
console.log(verdict);

process.exit(holds ? 0 : 1);
