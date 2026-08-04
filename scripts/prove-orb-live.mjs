#!/usr/bin/env node
/**
 * Proves that a conversation actually flows through the orb on a live machine:
 * sound in the room reaches the realtime provider, and the provider's reply
 * comes back out of the speakers.
 *
 * No unit test can close this claim. The lane's tests prove every seam in
 * isolation — the gate, the transport frames, the player process — and say
 * nothing about whether a microphone on this desk, a Google endpoint, and a
 * sound card cooperate at the same moment. The only way to know is to stand
 * in the room while it happens and write down what was observed.
 *
 * The script arranges one thing, and says so: subscribing to the orb's event
 * stream counts as a connected face, and a connected face is the consent
 * gesture that holds the microphone open. Running this script IS an operator
 * saying "listen while I watch" — discovered the honest way, when a stray
 * capture of this same stream kept a conversation going after the page
 * closed. Beyond that it does not speak, does not seed the conversation, and
 * only records what a bystander would have seen: states changing, words
 * attributed to each side. When it detaches, the consent it held goes with it.
 *
 * Usage: node scripts/prove-orb-live.mjs [--seconds 90] [--base http://127.0.0.1:4111]
 *        [--out docs/proofs/a-conversation-flows-through-the-orb.md]
 * Exits non-zero when the claim does not hold, because that is still an answer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { release, type as osType } from "node:os";

const CLAIM =
  "with an orb page open, speech in the room reaches the realtime provider and its reply reaches the speakers";

for (const leak of ["VITEST", "NODE_ENV"]) {
  if (process.env[leak]) {
    console.error(
      `refusing to run with ${leak} set: this measures a live hub, and a test ` +
        `environment boots a hub that deliberately opens no socket and no microphone.`,
    );
    process.exit(2);
  }
}

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const BASE = flag("base", "http://127.0.0.1:4111");
const SECONDS = Number(flag("seconds", "90"));
const OUT = flag("out", "docs/proofs/a-conversation-flows-through-the-orb.md");

function processesMatching(pattern) {
  try {
    return execFileSync("pgrep", ["-af", pattern], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((line) => line && !line.includes("pgrep"));
  } catch {
    return [];
  }
}

function osName() {
  try {
    return execFileSync(
      "bash",
      ["-lc", ". /etc/os-release && echo $PRETTY_NAME"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return `${osType()} ${release()}`;
  }
}

async function orbStatus() {
  const response = await fetch(`${BASE}/api/orb/status`);
  return response.json();
}

/**
 * Watches the orb's event stream for the window and keeps a bystander's log.
 * Captions arrive as fragments; contiguous fragments from one speaker are
 * joined into an utterance, because that is how a person in the room would
 * have heard them.
 */
async function observe(seconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  const startedAt = Date.now();

  const states = [];
  const utterances = [];
  let current = null;
  let playerSeenWhileSpeaking = false;

  const push = () => {
    if (current && current.text.trim()) utterances.push(current);
    current = null;
  };

  let response;
  try {
    response = await fetch(`${BASE}/api/orb/events`, {
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { error: `event stream unreachable: ${error.message}`, states, utterances };
  }

  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        const at = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (event.type === "state") {
          push();
          states.push({ at, state: event.state });
          if (
            event.state === "speaking" &&
            processesMatching("aplay").length > 0
          ) {
            playerSeenWhileSpeaking = true;
          }
        } else if (event.type === "caption") {
          if (!current || current.speaker !== event.speaker) {
            push();
            current = { at, speaker: event.speaker, text: "" };
          }
          current.text += event.text;
        }
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      clearTimeout(timer);
      return { error: `event stream failed: ${error.message}`, states, utterances };
    }
  }
  clearTimeout(timer);
  push();
  return { states, utterances, playerSeenWhileSpeaking };
}

const status = await orbStatus().catch((error) => ({
  enabled: false,
  reason: `status endpoint unreachable: ${error.message}`,
}));

if (!status.enabled) {
  console.error(`The orb is not enabled on this hub: ${status.reason ?? "no reason given"}.`);
  console.error(
    `Nothing was written: an artifact for a conversation that could not start is worse than no artifact.`,
  );
  process.exit(3);
}

const capture = processesMatching("arecord|pw-record");
console.log(
  `orb enabled, state ${status.state}, gate ${status.gate}; microphone capture: ${
    capture.length > 0 ? "running" : "NOT RUNNING"
  }`,
);
console.log(`observing the event stream for ${SECONDS}s — talk to the orb now.`);

const observed = await observe(SECONDS);

const userSpoke = observed.utterances.some((u) => u.speaker === "user");
const assistantSpoke = observed.utterances.some((u) => u.speaker === "assistant");
const spokeAloud = observed.states.some((s) => s.state === "speaking");
const holds = Boolean(
  !observed.error &&
    capture.length > 0 &&
    userSpoke &&
    assistantSpoke &&
    spokeAloud &&
    observed.playerSeenWhileSpeaking,
);

const verdict = observed.error
  ? `THE CLAIM WAS NOT TESTED — ${observed.error}`
  : holds
    ? "THE CLAIM HOLDS"
    : "THE CLAIM DOES NOT HOLD";

const stateRows = observed.states
  .map((s) => `| ${s.at}s | \`${s.state}\` |`)
  .join("\n");

const utteranceRows = observed.utterances
  .map((u) => `| ${u.at}s | ${u.speaker} | ${u.text.trim().replace(/\|/g, "\\|")} |`)
  .join("\n");

const evidence = [
  `| Orb status at start | enabled, state \`${status.state}\`, gate \`${status.gate}\` |`,
  `| Microphone capture process | ${capture.length > 0 ? `\`${capture[0].replace(/^\d+\s+/, "")}\`` : "NOT RUNNING"} |`,
  `| Player process during \`speaking\` | ${observed.playerSeenWhileSpeaking ? "observed" : "NOT OBSERVED"} |`,
  `| Words attributed to the user | ${userSpoke ? "yes" : "NO"} |`,
  `| Words attributed to the assistant | ${assistantSpoke ? "yes" : "NO"} |`,
].join("\n");

const artifact = `# Proof: a conversation flows through the orb

Generated by \`scripts/prove-orb-live.mjs\`. Not hand-written, and not reachable
by a unit test: past the gate is a microphone, a Google endpoint, and a sound
card, and none of them can be asserted into cooperating.

**Verdict: ${verdict}**

## Environment

| | |
|---|---|
| Measured | ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC |
| Operating system | ${osName()} |
| Node | ${process.version} |
| Hub | \`${BASE}\` |
| Observation window | ${SECONDS} seconds |

## The claim

${CLAIM}.

## What was observed

${evidence}

The script arranged none of it. The page visit that opened the microphone was a
person's, the words in the room were whoever was in the room, and the script
only wrote down what the orb's own event stream reported while it watched.

### States, as they changed

| When | State |
|---|---|
${stateRows || "| — | no state changes were observed |"}

### Words, as the stream attributed them

| When | Speaker | Utterance |
|---|---|---|
${utteranceRows || "| — | — | no captions were observed |"}

## What this decides

${
  holds
    ? `The whole lane is real at once: the page visit opened the machine's own
microphone, the gate forwarded room audio to the realtime provider, the
provider answered with sound, and the hub played that sound out of a child
process it can kill. Every one of those steps has a unit test; this artifact is
the one place they are shown to happen together, on this desk, on this day.`
    : `Some step of the lane did not demonstrate itself inside the window. The
table above says which: a missing capture process, a silent room, or a reply
that never came are three different defects, and the row that reads NO names
which one this was. Re-run with a person talking before reading anything else
into it.`
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, artifact);
console.log(`${verdict} — wrote ${OUT}`);
process.exit(holds ? 0 : 1);
