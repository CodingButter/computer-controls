import { expect, test } from "vitest";

import type { AgentTurn, ChatReply } from "../chat.ts";
import type { DaemonRegistryClient } from "./daemon-client.ts";
import { withDoorknobSignal, DOORKNOB_PREFIX, DOORKNOB_SUFFIX } from "./doorknob.ts";

/**
 * The doorknob signal — ruling: "the hub signals no permission yet and the orb
 * can speak it."
 *
 * The daemon disguises an unpermitted app as APPLICATION_NOT_FOUND so the agent
 * cannot learn the registry's contents. But the user deserves the truth: when
 * the agent's reply mentions an app the user has not yet permitted, the hub
 * appends the doorknob line to the text the orb speaks and the chat renders.
 */

function stubClient(applications: { name: string; permitted: boolean }[]): Pick<DaemonRegistryClient, "getApplicationPermissions"> {
  return {
    async getApplicationPermissions() {
      return { applications };
    },
  };
}

function stubTurn(text: string): AgentTurn {
  return async () => ({ text, threadId: "t1", status: "completed" } satisfies ChatReply);
}

test("the doorknob signal is appended when the reply names an unpermitted app", async () => {
  const client = stubClient([
    { name: "some editor", permitted: true },
    { name: "google chrome", permitted: false },
  ]);
  const wrapped = withDoorknobSignal(
    stubTurn("I couldn't find Google Chrome on the desktop."),
    client as DaemonRegistryClient,
  );

  const reply = await wrapped({ message: "open chrome" });

  expect(reply.text).toContain("Google Chrome");
  expect(reply.text).toContain(DOORKNOB_PREFIX);
  expect(reply.text).toContain("google chrome");
  expect(reply.text).toContain(DOORKNOB_SUFFIX);
});

test("no signal when the reply does not mention an unpermitted app", async () => {
  const client = stubClient([
    { name: "some editor", permitted: true },
    { name: "google chrome", permitted: false },
  ]);
  const original = "The editor is open and ready.";
  const wrapped = withDoorknobSignal(stubTurn(original), client as DaemonRegistryClient);

  const reply = await wrapped({ message: "is the editor open?" });

  expect(reply.text).toBe(original);
});

test("no signal when every app is permitted", async () => {
  const client = stubClient([
    { name: "some editor", permitted: true },
    { name: "google chrome", permitted: true },
  ]);
  const original = "I see Google Chrome and the editor.";
  const wrapped = withDoorknobSignal(stubTurn(original), client as DaemonRegistryClient);

  const reply = await wrapped({ message: "what's open?" });

  expect(reply.text).toBe(original);
});

test("the reply stands unchanged when the daemon is unreachable", async () => {
  const client: Pick<DaemonRegistryClient, "getApplicationPermissions"> = {
    async getApplicationPermissions() {
      throw new Error("The desktop daemon is not running.");
    },
  };
  const original = "I couldn't find Google Chrome.";
  const wrapped = withDoorknobSignal(stubTurn(original), client as DaemonRegistryClient);

  const reply = await wrapped({ message: "open chrome" });

  // A daemon that cannot be reached must not break the chat flow.
  expect(reply.text).toBe(original);
});
