/**
 * The whole vocabulary the hub and its faces share.
 *
 * A face — the web orb page, the desktop widget, whatever comes after — draws
 * state and forwards gestures. It holds no microphone, no credential, no tool,
 * and no path to the daemon. That property is not enforced by asking faces
 * nicely; it is enforced here, by the hub never offering a word that would let
 * a face ask for more. A widget that asked for more would be refused by a hub
 * that never offered it.
 *
 * So this module is deliberately small and deliberately closed. Two unions,
 * both exhaustive, and guards that admit their own members and nothing else.
 * Adding a word here is the only way a face gains a capability, which makes
 * every such addition a visible decision rather than an accident of parsing.
 */

/** What the hub says about itself. State descriptors, never audio. */
export type StateEvent =
  | { type: "wake_opened" }
  | { type: "caption"; text: string }
  | { type: "thinking" }
  | { type: "speaking" }
  | { type: "idle" }
  | { type: "touching"; id: string; x: number; y: number; width: number; height: number }
  | { type: "released"; id: string }
  | { type: "progress"; id: string; text: string }
  | { type: "answer"; id: string; text: string }
  | { type: "voice_opened" }
  | { type: "voice_closed" };

/*
 * `progress` and `answer` are the hub replying to an `ask` — the id is the
 * asker's correlation id, echoed back so a mouth holding several function
 * calls open can route each reply to the right one. `voice_opened` and
 * `voice_closed` report set transitions, not memberships: one broadcast when
 * the first mouth opens, one when the last closes. A client that opened a
 * voice session and hears `voice_opened` caused it; a client that hears it
 * without having opened knows to plug its own ears. No word carries who —
 * which device is talking is arbitration state, not content a face renders.
 */

/*
 * `touching` and `released` are the hub pointing at its own hands.
 *
 * One pair per in-flight operation: `touching` when the agent starts working on
 * an element whose screen rectangle the daemon has actually reported, and
 * `released` when that operation ends. The `id` is the operation's id, not the
 * element's — a face has no use for an accessibility-tree reference and no way
 * to spend one, and two operations on the same element are two separate hands.
 *
 * The rectangle is all that travels. No role, no name, no value: a caption is
 * content the hub already decided to publish, and the label on a button in
 * somebody's password manager is not. Geometry answers "where is the agent
 * working", which is the only question this word exists to answer.
 *
 * An operation whose element has no reported geometry produces no word at all.
 * Guessing a position would make the face a progress bar that lies, and silence
 * is the honest degradation.
 */

/** What a person does to a face. Intent, never content. */
export type Gesture =
  | { type: "mute" }
  | { type: "dismiss" }
  | { type: "drag"; x: number; y: number }
  | { type: "ask"; id: string; request: string }
  | { type: "voice_open" }
  | { type: "voice_close" }
  | { type: "caption"; text: string };

/*
 * `ask`, `voice_open`, `voice_close` and `caption` are the words a client-side
 * mouth speaks. A mouth is still a face — it holds no tool and no path to the
 * daemon — but it does hold a conversation, and these are the only four things
 * a conversation needs from the hub: route a request to the brain (`ask`, with
 * a client-chosen id the replies echo), declare the microphone session open
 * and closed (arbitration, so other mouths can plug their ears), and report
 * what was heard or said (`caption`) so faces that are not mouths can render
 * it. Still no audio: a caption is text the client's own session already
 * transcribed, published deliberately, frame by frame.
 */

export type StateEventType = StateEvent["type"];
export type GestureType = Gesture["type"];

/**
 * The vocabularies as data, so the guards and the tests read from one list.
 *
 * A test that retyped these would pass while drifting from what the socket
 * actually admits, which is the failure mode this whole module exists to
 * prevent.
 */
export const STATE_EVENT_TYPES = [
  "wake_opened",
  "caption",
  "thinking",
  "speaking",
  "idle",
  "touching",
  "released",
  "progress",
  "answer",
  "voice_opened",
  "voice_closed",
] as const satisfies readonly StateEventType[];

export const GESTURE_TYPES = [
  "mute",
  "dismiss",
  "drag",
  "ask",
  "voice_open",
  "voice_close",
  "caption",
] as const satisfies readonly GestureType[];

/**
 * The exact keys each word carries, including `type`.
 *
 * Presence is checked against this, and so is absence: a message with a key
 * that is not listed is refused rather than trimmed. Trimming would let a skin
 * smuggle a field past the guard and find a reader for it downstream, and the
 * hub would have no record of having agreed to carry it.
 */
const STATE_EVENT_KEYS: Record<StateEventType, readonly string[]> = {
  wake_opened: ["type"],
  caption: ["type", "text"],
  thinking: ["type"],
  speaking: ["type"],
  idle: ["type"],
  touching: ["type", "id", "x", "y", "width", "height"],
  released: ["type", "id"],
  progress: ["type", "id", "text"],
  answer: ["type", "id", "text"],
  voice_opened: ["type"],
  voice_closed: ["type"],
};

const GESTURE_KEYS: Record<GestureType, readonly string[]> = {
  mute: ["type"],
  dismiss: ["type"],
  drag: ["type", "x", "y"],
  ask: ["type", "id", "request"],
  voice_open: ["type"],
  voice_close: ["type"],
  caption: ["type", "text"],
};

/** A JSON object and nothing else — not null, not an array, not a primitive. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exactly these keys, no more and no fewer.
 *
 * The "no more" half is what closes the vocabulary; the "no fewer" half is what
 * keeps a half-built message from being read as a complete one.
 */
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/** A finite number: NaN and the infinities are not positions on a screen. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A string with something in it. An `ask` with no request is not a question,
 * and a reply with no id has no asker — both are noise, not errors.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function isStateEvent(value: unknown): value is StateEvent {
  if (!isPlainRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string") return false;
  if (!(STATE_EVENT_TYPES as readonly string[]).includes(type)) return false;
  if (!hasExactKeys(value, STATE_EVENT_KEYS[type as StateEventType])) return false;
  if (type === "caption") return typeof value.text === "string";
  if (type === "released") return typeof value.id === "string" && value.id !== "";
  if (type === "progress" || type === "answer") {
    return isNonEmptyString(value.id) && isNonEmptyString(value.text);
  }
  if (type === "touching") {
    if (typeof value.id !== "string" || value.id === "") return false;
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return false;
    // A rectangle with no extent is not somewhere a scout can point. An
    // element reported at zero size is off-screen or not laid out, and drawing
    // over it would be inventing a place rather than repeating one.
    return isFiniteNumber(value.width) && value.width > 0 && isFiniteNumber(value.height) && value.height > 0;
  }
  return true;
}

export function isGesture(value: unknown): value is Gesture {
  if (!isPlainRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string") return false;
  if (!(GESTURE_TYPES as readonly string[]).includes(type)) return false;
  if (!hasExactKeys(value, GESTURE_KEYS[type as GestureType])) return false;
  if (type === "drag") return isFiniteNumber(value.x) && isFiniteNumber(value.y);
  if (type === "ask") return isNonEmptyString(value.id) && isNonEmptyString(value.request);
  if (type === "caption") return isNonEmptyString(value.text);
  return true;
}

/**
 * A frame off the wire, or nothing.
 *
 * Malformed JSON and a well-formed message outside the vocabulary come back the
 * same way — as `undefined`. The socket treats both as noise rather than as an
 * error worth answering, because answering would tell a caller which of its
 * guesses parsed.
 */
export function parseGesture(raw: string): Gesture | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isGesture(parsed) ? parsed : undefined;
}

export function parseStateEvent(raw: string): StateEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isStateEvent(parsed) ? parsed : undefined;
}
