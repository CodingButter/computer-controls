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
  | { type: "idle" };

/** What a person does to a face. Intent, never content. */
export type Gesture =
  | { type: "mute" }
  | { type: "dismiss" }
  | { type: "drag"; x: number; y: number };

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
] as const satisfies readonly StateEventType[];

export const GESTURE_TYPES = ["mute", "dismiss", "drag"] as const satisfies readonly GestureType[];

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
};

const GESTURE_KEYS: Record<GestureType, readonly string[]> = {
  mute: ["type"],
  dismiss: ["type"],
  drag: ["type", "x", "y"],
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

export function isStateEvent(value: unknown): value is StateEvent {
  if (!isPlainRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string") return false;
  if (!(STATE_EVENT_TYPES as readonly string[]).includes(type)) return false;
  if (!hasExactKeys(value, STATE_EVENT_KEYS[type as StateEventType])) return false;
  if (type === "caption") return typeof value.text === "string";
  return true;
}

export function isGesture(value: unknown): value is Gesture {
  if (!isPlainRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string") return false;
  if (!(GESTURE_TYPES as readonly string[]).includes(type)) return false;
  if (!hasExactKeys(value, GESTURE_KEYS[type as GestureType])) return false;
  if (type === "drag") return isFiniteNumber(value.x) && isFiniteNumber(value.y);
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
