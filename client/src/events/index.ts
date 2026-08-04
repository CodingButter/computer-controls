export { EVENTS_PATH, attachEventSocket, isLocalPeer } from "./socket.ts";
export type { EventSocket } from "./socket.ts";
export { ScriptedEventSource } from "./source.ts";
export type { EventSource } from "./source.ts";
export {
  GESTURE_TYPES,
  STATE_EVENT_TYPES,
  isGesture,
  isStateEvent,
  parseGesture,
  parseStateEvent,
} from "./types.ts";
export type { Gesture, GestureType, StateEvent, StateEventType } from "./types.ts";
