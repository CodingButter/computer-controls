import { createTool, defineMastraCodePlugin, z } from "mastracode/plugin";

import { DesktopServiceError } from "./client.ts";
import { SCHEMA_DIGEST } from "./protocol.generated.ts";
import * as schemas from "./schemas.generated.ts";
import { buildPushLane } from "./signals/index.ts";
import { DesktopSupervisor } from "./supervisor.ts";

/**
 * Semantic desktop control.
 *
 * Every tool here talks to the Python desktop service over a Unix socket, and
 * the service is what talks to AT-SPI. The plugin holds no desktop state of its
 * own — that is what lets the sidecar be replaced later without touching this
 * file.
 */

const supervisor = new DesktopSupervisor();

/**
 * A capture result, as the schema declares it — the base64 image plus the facts
 * about what was captured.
 *
 * A tool result is text, and an image is not. The bytes stay on the result
 * because the protocol says they do, and `toModelOutput` spends them as a media
 * part instead: the model gets the picture and the facts, never the base64.
 */
type CaptureResult = { image: string } & Record<string, unknown>;

/**
 * The push lane: deltas reaching the model with nobody having called a tool.
 *
 * Built once at load. The provider is handed to Mastra Code, which owns its
 * lifecycle, and the same instance backs the arming processor — see
 * `signals/arming.ts` for why arming cannot depend on tool calls alone.
 */
const pushLane = buildPushLane(supervisor);

/** Turn a service error into something the model can act on rather than a stack trace.
 *
 * The detail travels with the message. A startup failure knows exactly why it failed —
 * the service says so on stderr and the supervisor captures it — and dropping that on
 * the way to the model turns a one-line diagnosis into an investigation. This cost a
 * real one: "exited with code 1" was actually "another service is already listening on
 * that socket", which the caller could have acted on immediately.
 */
export function describeFailure(error: unknown): never {
  if (error instanceof DesktopServiceError) {
    const stderr = error.detail.stderr;
    const because = typeof stderr === "string" && stderr.trim()
      ? `\n${diagnosisFrom(stderr)}`
      : "";
    throw new Error(`[${error.code}] ${error.message}${because}`);
  }
  throw error;
}

/** The tail of a traceback, where Python puts the diagnosis.
 *
 * Deliberately not clever. An earlier version took the single last line, which
 * silently truncated any exception whose message wrapped — losing exactly the half
 * that named the problem. A few lines of frame noise costs the model nothing; a
 * confidently-cropped diagnosis costs it the answer.
 */
const DIAGNOSIS_LINES = 3;

function diagnosisFrom(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-DIAGNOSIS_LINES)
    .join("\n");
}

/**
 * What an attaching client should say when the service does not know a method
 * this client's own generated protocol declares.
 *
 * Clients do not start the service, they attach to whichever instance is already
 * listening — deliberately, so that a long-lived daemon survives any one client.
 * The consequence is that the daemon serves the code it booted with, and a
 * daemon started before a method existed answers `METHOD_NOT_FOUND` for a method
 * these types promise is there. That cost forty minutes once: the capture
 * backend was on disk and the running daemon had never heard of it.
 *
 * Returns the sentence to append, or nothing when the digests agree and the
 * missing method is a genuine mystery rather than a stale process.
 */
export function staleDaemonHint(
  serviceDigest: string | undefined,
  clientDigest: string,
): string {
  if (!serviceDigest) {
    return (
      "\nThe running service predates the handshake field that reports its schema version, " +
      "so it is certainly older than this client. Restart the desktop daemon."
    );
  }
  if (serviceDigest !== clientDigest) {
    return (
      `\nThe running service was built from schema ${serviceDigest} and this client from ` +
      `${clientDigest}. The daemon is serving older code than this client expects — restart it.`
    );
  }
  return "";
}

/**
 * How long to wait for a method that spends real time on purpose.
 *
 * Typing a paragraph at seventy words a minute takes the better part of a
 * minute, and the default deadline would cut the connection while the service
 * was still doing exactly what it was asked to do — abandoning a half-typed
 * sentence with nobody left holding the result. The estimate is the same
 * arithmetic the service uses, plus room for the settling that follows.
 */
export function pacedTimeoutMs(params: Record<string, unknown>): number | undefined {
  const text = typeof params.text === "string" ? params.text : params.replaceWith;
  if (typeof text !== "string") return undefined;
  const wpm = typeof params.wordsPerMinute === "number" ? params.wordsPerMinute : 70;
  const typing = (text.length * 60_000) / (wpm * 5);
  return Math.ceil(typing) + PACED_HEADROOM_MS;
}

/** Settling, a stalled toolkit call, and the round trip — not typing time. */
const PACED_HEADROOM_MS = 30_000;

const PACED_METHODS = new Set(["typeText", "editText"]);

async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    const timeout = PACED_METHODS.has(method) ? pacedTimeoutMs(params) : undefined;
    return await supervisor.request<T>(method, params, timeout);
  } catch (error) {
    if (error instanceof DesktopServiceError && error.code === "METHOD_NOT_FOUND") {
      const hint = staleDaemonHint(await supervisor.schemaDigest(), SCHEMA_DIGEST);
      if (hint) throw new Error(`[${error.code}] ${error.message}${hint}`);
    }
    return describeFailure(error);
  }
}

export default defineMastraCodePlugin({
  id: "desktop-control",
  name: "Semantic Desktop Control",
  version: "0.2.0",
  description:
    "Semantic control of Linux desktop applications through AT-SPI2 — applications, windows, elements, actions.",
  signalProviders: [pushLane.provider],
  processors: pushLane.processors,
  tools: {
    desktop_capabilities: {
      tool: createTool({
        id: "desktop_capabilities",
        description:
          "Report what this desktop session is and what this build can actually do with it: display server, desktop environment, compositor, and per-tier availability. Tiers that are unavailable say why. Call this before assuming a capability exists.",
        inputSchema: schemas.getDesktopCapabilitiesParams,
        outputSchema: schemas.getDesktopCapabilitiesResult,
        execute: async () => await request("getDesktopCapabilities"),
      }),
    },

    desktop_list_applications: {
      tool: createTool({
        id: "desktop_list_applications",
        description:
          "List the applications currently running on the desktop, with their toolkit and how many windows each has. Application ids are stable for the lifetime of the application process.",
        inputSchema: schemas.listApplicationsParams,
        outputSchema: schemas.listApplicationsResult,
        execute: async () => await request("listApplications"),
      }),
    },

    desktop_list_windows: {
      tool: createTool({
        id: "desktop_list_windows",
        description:
          "List the top-level windows on the desktop, optionally narrowed to one application. Each window carries a stable id, its title, its role and whether it is the active window.",
        inputSchema: schemas.listWindowsParams,
        outputSchema: schemas.listWindowsResult,
        execute: async (input) =>
          await request("listWindows", {
            ...(input?.applicationId ? { applicationId: input.applicationId } : {}),
          }),
      }),
    },

    desktop_inspect_window: {
      tool: createTool({
        id: "desktop_inspect_window",
        description:
          "Look inside a window and get back a compact semantic tree: roles, names, states, " +
          "available actions and stable element ids. Always bounded — prefer a shallow depth " +
          "and a role filter over a large tree, and use desktop_query_elements instead when " +
          "you are looking for something specific. Note that the window's own action list is " +
          "often the most capable surface: GTK4 applications expose their entire command set " +
          "there while their element tree is nearly empty.",
        inputSchema: schemas.inspectWindowParams,
        outputSchema: schemas.inspectWindowResult,
        execute: async (input) =>
          await request("inspectWindow", { ...input }),
      }),
    },

    desktop_query_elements: {
      tool: createTool({
        id: "desktop_query_elements",
        description:
          "Find specific elements inside a window by role, name or state — the preferred way " +
          "to locate something, because it returns a short flat list instead of a tree. " +
          "At least one filter is required. Returned element ids are stable and revision-" +
          "stamped: if the element changes before you use one, the service tells you it is " +
          "stale rather than acting on something else.",
        inputSchema: schemas.queryElementsParams,
        outputSchema: schemas.queryElementsResult,
        execute: async (input) => await request("queryElements", { ...input }),
      }),
    },

    desktop_inspect_element: {
      tool: createTool({
        id: "desktop_inspect_element",
        description:
          "Drill into an element you have already located: the depth budget is measured from " +
          "that element rather than from the window. Use this when a window inspection bottoms " +
          "out before reaching what you want — a document's text, a deeply nested list — " +
          "because window inspection spends its depth walking down through layout containers " +
          "and real applications put their content below what any single window walk can " +
          "reach. Anchor on the deepest relevant thing you found, then drill.",
        inputSchema: schemas.inspectElementParams,
        outputSchema: schemas.inspectElementResult,
        execute: async (input) => await request("inspectElement", { ...input }),
      }),
    },

    desktop_focus_window: {
      tool: createTool({
        id: "desktop_focus_window",
        description:
          "Raise and focus a window by id. The result reports which tier did it and what " +
          "changed as a result, so you do not need to list windows again to confirm.",
        inputSchema: schemas.focusWindowParams,
        outputSchema: schemas.focusWindowResult,
        execute: async (input) => await request("focusWindow", { ...input }),
      }),
    },

    desktop_invoke_element: {
      tool: createTool({
        id: "desktop_invoke_element",
        description:
          "Invoke a named action on an element — or on a window's own frame, which on GTK4 " +
          "applications is where the entire command set lives. Actions are named, never " +
          "indexed. If the action does not exist the error lists the ones that do. The result " +
          "carries the effects that were observed while the action was in flight: new windows, " +
          "focus moves, value changes. Read those instead of re-inspecting.",
        inputSchema: schemas.invokeElementParams,
        outputSchema: schemas.invokeElementResult,
        execute: async (input) => await request("invokeElement", { ...input }),
      }),
    },

    desktop_set_element_value: {
      tool: createTool({
        id: "desktop_set_element_value",
        description:
          "Set an element's text or numeric value through the toolkit directly — never by " +
          "typing at the screen, so it does not matter where focus happens to be. The result " +
          "reports the effects that followed, the same way invoking does.",
        inputSchema: schemas.setElementValueParams,
        outputSchema: schemas.setElementValueResult,
        execute: async (input) => await request("setElementValue", { ...input }),
      }),
    },

    desktop_type_text: {
      tool: createTool({
        id: "desktop_type_text",
        description:
          "Type into an editable element the way a person does: a word at a time, at a " +
          "typist's speed, through the same interface dictation software uses. Use this for " +
          "anything a human will watch arrive — a message, a chat, a document — and use " +
          "desktop_set_element_value for a form field nobody is looking at. Some applications " +
          "only notice text that arrives as edits and ignore having their field replaced " +
          "wholesale; this is the one that works on those. The call is held open for as long " +
          "as the typing takes, which is roughly the character count divided by five times the " +
          "words-per-minute. Success means the field read back what you asked for, not that " +
          "the insertions were accepted. If it stops early the result still returns: read " +
          "'progress' for how many words landed and why it stopped, then decide whether to " +
          "wait, finish it, or clear the field — the text that already landed is really there.",
        inputSchema: schemas.typeTextParams,
        outputSchema: schemas.typeTextResult,
        execute: async (input) => await request("typeText", { ...input }),
      }),
    },

    desktop_edit_text: {
      tool: createTool({
        id: "desktop_edit_text",
        description:
          "Replace or delete part of an editable element's text, addressed by the text itself " +
          "rather than by character positions. Editing here is a splice — the range is removed " +
          "and the replacement put in its place — because there is no keyboard at this layer " +
          "and nothing to press backspace on. Give 'find' text that appears exactly once: two " +
          "matches, or text that has changed since you read it, are refused rather than guessed " +
          "at, so a stale idea of a field can never edit the wrong sentence. Omit 'replaceWith' " +
          "to delete. Add 'showSelection' to highlight the range first when a person is " +
          "watching, and 'wordsPerMinute' to type the replacement in at human speed.",
        inputSchema: schemas.editTextParams,
        outputSchema: schemas.editTextResult,
        execute: async (input) => await request("editText", { ...input }),
      }),
    },

    desktop_perform_actions: {
      tool: createTool({
        id: "desktop_perform_actions",
        description:
          "Run several actions in one call — filling a dialog and confirming it costs one " +
          "exchange instead of one per field. Stops at the first failure by default and tells " +
          "you which steps ran, which failed and which were never attempted.",
        inputSchema: schemas.performActionsParams,
        outputSchema: schemas.performActionsResult,
        execute: async (input) => await request("performActions", { ...input }),
      }),
    },

    desktop_wait_for: {
      tool: createTool({
        id: "desktop_wait_for",
        description:
          "Wait for something to become true — a window opening or closing, an element " +
          "appearing, the session advancing past a revision. Use this instead of guessing a " +
          "duration: the waiting happens in the service and returns the moment the condition " +
          "holds, and a timeout tells you which condition was still false.",
        inputSchema: schemas.waitForParams,
        outputSchema: schemas.waitForResult,
        execute: async (input) => await request("waitFor", { ...input }),
      }),
    },

    desktop_changes_since: {
      tool: createTool({
        id: "desktop_changes_since",
        description:
          "What changed on the desktop since a revision you already know about. Every change " +
          "says whether you caused it, another client caused it, or nobody here did — so news " +
          "from the outside world is never mistaken for your own effects. If the answer comes " +
          "back with complete false, you fell behind what the service still holds: resume from " +
          "resumeRevision, or read the whole state again.",
        inputSchema: schemas.getDeltaSinceParams,
        outputSchema: schemas.getDeltaSinceResult,
        execute: async (input) => await request("getDeltaSince", { ...input }),
      }),
    },

    desktop_list_installable_applications: {
      tool: createTool({
        id: "desktop_list_installable_applications",
        description:
          "The applications this desktop can start. The ids here are the only thing " +
          "desktop_launch_application accepts — there is no way to ask this service to run a " +
          "command, and that is deliberate.",
        inputSchema: schemas.listInstallableApplicationsParams,
        outputSchema: schemas.listInstallableApplicationsResult,
        execute: async (input) => await request("listInstallableApplications", { ...input }),
      }),
    },

    desktop_launch_application: {
      tool: createTool({
        id: "desktop_launch_application",
        description:
          "Start an installed application by its entry id, from the list above. The result " +
          "reports the window it opened as your own doing, so the application you just " +
          "started is never announced back to you as somebody else's news. A cold start often " +
          "outlasts the settling wait — wait on window-opened rather than assuming nothing " +
          "happened.",
        inputSchema: schemas.launchApplicationParams,
        outputSchema: schemas.launchApplicationResult,
        execute: async (input) => await request("launchApplication", { ...input }),
      }),
    },

    desktop_capture_window: {
      tool: createTool({
        id: "desktop_capture_window",
        description:
          "See one window's pixels, for the content the accessibility tree cannot express — " +
          "what an image shows, what a canvas drew, whether a rendering actually looks right. " +
          "Takes a window id and never a screen region, so nothing else on the desktop is ever " +
          "in frame. Looking is not addressing: act through element references, not through " +
          "what you saw here.",
        inputSchema: schemas.captureWindowParams,
        outputSchema: schemas.captureWindowResult,
        execute: async (input) =>
          await request("captureWindow", { ...input }) as z.infer<typeof schemas.captureWindowResult>,
        toModelOutput: (output: unknown) => {
          const result = output as Partial<CaptureResult> | null;
          if (typeof result?.image !== "string") return undefined;
          const { image, ...facts } = result;
          return {
            type: "content",
            value: [
              { type: "text", text: JSON.stringify(facts) },
              { type: "media", data: image, mediaType: "image/png" },
            ],
          };
        },
      }),
    },

    desktop_state: {
      tool: createTool({
        id: "desktop_state",
        description:
          "The current picture in one call: which windows exist and which one has focus. Use " +
          "this to re-acquire the desktop after being told a delta was incomplete, or as a " +
          "cheap first look before deciding what to inspect in detail.",
        inputSchema: schemas.getDesktopStateParams,
        outputSchema: schemas.getDesktopStateResult,
        execute: async (input) => await request("getDesktopState", { ...input }),
      }),
    },
  },
});
