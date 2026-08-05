export { ASK_FAILED, EVENTS_PATH, attachEventSocket, isLocalPeer } from "./socket.ts";
export type { CredentialCheck, EventSocket, LaneBrain } from "./socket.ts";
export {
  DEVICE_CREDENTIALS_FILE,
  DEVICE_SUBPROTOCOL_PREFIX,
  MalformedDeviceCredentials,
  createDeviceCredentialStore,
} from "./device-credentials.ts";
export type { DeviceCredential, DeviceCredentialStore } from "./device-credentials.ts";
export { ScriptedEventSource } from "./source.ts";
export type { EventSource } from "./source.ts";
export { combineEventSources, createTouchLane, harvestGeometry, targetOf } from "./touch-lane.ts";
export type { Rect, TouchLane } from "./touch-lane.ts";
export {
  GESTURE_TYPES,
  STATE_EVENT_TYPES,
  isGesture,
  isStateEvent,
  parseGesture,
  parseStateEvent,
} from "./types.ts";
export type { Gesture, GestureType, StateEvent, StateEventType } from "./types.ts";
