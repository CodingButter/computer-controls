import type { EventSource } from "../events/source.ts";
import type { Gesture, StateEvent } from "../events/types.ts";
import { ScriptedEventSource } from "../events/source.ts";
import type { OrbEvent } from "./orb.ts";

/**
 * The adapter that bridges a live orb into the face pipe.
 *
 * The orb and the faces are two separate streams that have never met: the orb
 * broadcasts `OrbEvent`s over its own SSE endpoint for the orb *page*, while
 * the faces ride the `/events` WebSocket for `StateEvent`s. A widget connected
 * to a live orb therefore shows an idle face forever — the two pipes do not
 * join. This module is the joint.
 *
 * What crosses, and what does not, is fixed by the face vocabulary — which is
 * deliberately closed and deliberately smaller than the orb's:
 *
 *   state.listening  → wake_opened   (the face's word for "a turn opened")
 *   state.thinking   → thinking
 *   state.speaking   → speaking
 *   state.idle       → idle
 *   caption { text } → caption { text }   (speaker dropped — no slot)
 *   mood             → dropped            (the face has no word for mood)
 *
 * Mood is the interesting case. The orb emits it as a guess about a person,
 * then forgets it. The face vocabulary never offered a mood field, so widening
 * it here would be the adapter inventing a word the socket was built not to
 * carry. A mood event produces no frame, and that silence is the design.
 */

/** Translate one orb event into one face event, or nothing. */
export function toStateEvent(event: OrbEvent): StateEvent | undefined {
  switch (event.type) {
    case "state":
      switch (event.state) {
        case "listening":
          return { type: "wake_opened" };
        case "thinking":
          return { type: "thinking" };
        case "speaking":
          return { type: "speaking" };
        case "idle":
          return { type: "idle" };
      }
      return undefined;
    case "caption":
      // `speaker` has no slot in the face vocabulary, so it is dropped rather
      // than smuggled. The text crosses verbatim.
      return { type: "caption", text: event.text };
    case "mood":
      // The face has no mood word. A mood event is not an error and not a gap
      // to fill — it is simply not for this pipe.
      return undefined;
  }
}

/**
 * The narrow surface of an orb a face source needs, so it can be faked without
 * a microphone, a model, or a credential.
 */
export type OrbFaceDeps = {
  /** Subscribe a face to the orb's event stream. Returns the unsubscribe. */
  subscribe(listener: (event: OrbEvent) => void): () => void;
  /** Unconditional gate close — what a mute or a dismiss means. */
  closeGate(): void;
};

/**
 * An `EventSource` driven by a live orb.
 *
 * Each face that subscribes gets its own listener on the orb, so the orb's
 * consent count (how many faces are watching) tracks real faces — a permanent
 * listener here would keep the microphone open after the last face left. The
 * orb's existing fan-out distributes to every listener; this adapter translates
 * each event once per listener and hands the `StateEvent` to that face alone.
 */
export class OrbFaceSource implements EventSource {
  readonly #deps: OrbFaceDeps;

  constructor(deps: OrbFaceDeps) {
    this.#deps = deps;
  }

  subscribe(handler: (event: StateEvent) => void): () => void {
    // The orb's subscribe counts this listener as a face for consent purposes.
    // The closure translates and forwards only the events the face vocabulary
    // has a word for; the rest (mood) never reaches the handler.
    return this.#deps.subscribe((orbEvent) => {
      const faceEvent = toStateEvent(orbEvent);
      if (faceEvent) handler(faceEvent);
    });
  }

  handleGesture(gesture: Gesture): void {
    // Mute and dismiss both mean "stop listening" — the orb's unconditional
    // gate close. A mute that sometimes opened the gate instead would be the
    // worst possible reading of the button. Drag is placement, which is the
    // face's own business and has no effect on the hub.
    if (gesture.type === "mute" || gesture.type === "dismiss") {
      this.#deps.closeGate();
    }
  }
}

/**
 * The mount an `OrbFaceSource` can be built from: a live orb plus its
 * subscribe. A refused orb (no provider, no ear, no credential) lacks both.
 */
export type LiveOrbMount = {
  orb: { closeGate(): void };
  subscribe(listener: (event: OrbEvent) => void): () => void;
};

/**
 * Choose the event source for the face pipe: the live orb when one is running,
 * the scripted source when the orb is off — so a face against a refused orb
 * sees idle, which is the truth, rather than an error.
 */
export function chooseFaceSource(mount: {
  orb?: { closeGate(): void };
  subscribe?(listener: (event: OrbEvent) => void): () => void;
}): EventSource {
  const { orb, subscribe } = mount;
  if (orb && subscribe) {
    return new OrbFaceSource({ subscribe, closeGate: () => orb.closeGate() });
  }
  return new ScriptedEventSource();
}
