import type { Gesture, StateEvent } from "./types.ts";

/**
 * Where state events come from, as far as the socket is concerned.
 *
 * The seam outlived the hardware it was built to hide. It once stood between
 * the socket and a hub-owned ear chain; since the client migration the
 * microphones, wake gates, and realtime sessions all live on devices, and
 * what feeds this interface is the hub's own derived view of the lane — a
 * session opened somewhere, an ask is in flight — joined with the touch lane.
 * The socket still depends on this and nothing more: something that emits
 * state and accepts gestures. A scripted source proves the pipe and the face
 * in tests; the real sources implement the same two methods.
 *
 * The narrowness is also the point. A source hands out state descriptors —
 * "wake opened", "here is a caption line" — and never audio. Nothing in this
 * interface can carry a sample, so nothing downstream of it can leak one.
 */
export type EventSource = {
  /**
   * Watch the hub's state. Returns the unsubscribe, which the socket calls when
   * its connection closes — a face that walks away must not keep a handler
   * alive on the process that outlives it.
   */
  subscribe(handler: (event: StateEvent) => void): () => void;
  /**
   * Take a gesture from a face. Optional, because a source that only speaks is
   * a legitimate source; a mute the ear chain has not been taught to honour is
   * better dropped here than half-applied.
   */
  handleGesture?(gesture: Gesture): void;
};

/**
 * An event source driven by hand.
 *
 * Used by the tests and by the widget's own development loop, where the
 * alternative is speaking at a laptop and hoping. It is also what the hub boots
 * with until the ear chain exists, so the socket has something real to serve
 * rather than a null that every reader has to remember to check.
 */
export class ScriptedEventSource implements EventSource {
  readonly #handlers = new Set<(event: StateEvent) => void>();
  /** Every gesture that arrived, in order, so a test can assert what got through. */
  readonly received: Gesture[] = [];

  subscribe(handler: (event: StateEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  handleGesture(gesture: Gesture): void {
    this.received.push(gesture);
  }

  /** Say one thing to every face currently watching. */
  emit(event: StateEvent): void {
    // Iterating a copy: a handler that unsubscribes on the event it is being
    // handed would otherwise mutate the set mid-walk.
    for (const handler of [...this.#handlers]) handler(event);
  }

  /** Say several things in order — a whole wake-to-idle turn, usually. */
  emitAll(events: readonly StateEvent[]): void {
    for (const event of events) this.emit(event);
  }

  /** How many faces are watching. The socket's cleanup is asserted through this. */
  get watcherCount(): number {
    return this.#handlers.size;
  }
}
