import type { LaneObserver } from "../events/socket.ts";
import type { EventSource } from "../events/source.ts";
import type { StateEvent } from "../events/types.ts";

/**
 * Face events, derived from the only thing the hub still knows about voice:
 * the lane.
 *
 * The old adapter here translated a hub-side orb's events into the face
 * vocabulary. That orb is gone — the microphone, the gate, and the Gemini
 * session all live on client devices now — so the hub can no longer say "the
 * wake word was heard": it never hears one. What it *can* say truthfully is
 * derived from the lane's own traffic:
 *
 *   a voice session opens (0 → n)  → wake_opened
 *   the last one closes (n → 0)    → idle
 *   an ask reaches the brain       → thinking
 *   an answer goes back            → speaking
 *
 * `wake_opened` is a deliberate semantic collapse. It used to mean "the gate
 * heard the name"; it now means "a conversation is live somewhere". Wake
 * detection moved to the devices, and the hub only ever learns that a session
 * opened — so that is the honest content of the word, and every face that
 * shows up for it (the widget popping visible, the page leaving idle) is
 * showing exactly what the hub knows.
 *
 * Captions are the asymmetric case. The lane's socket already relays a
 * caption to every WebSocket face itself, so the lane-facing source here does
 * NOT repeat them — a second copy would say everything twice. The SSE face on
 * the orb page is not on that socket, so the face-facing subscription carries
 * captions too. Same words, one delivery each.
 */

export type LaneFaceSource = {
  /**
   * The lane's event source: derived states only. Captions ride the socket's
   * own relay, so they are deliberately absent here.
   */
  source: EventSource;
  /**
   * What the socket calls when the conversation moves. `Required` because
   * this source implements the whole observer surface — the optionality in
   * the lane's type is for observers that care about less.
   */
  observer: Required<LaneObserver>;
  /**
   * A face that is not on the lane's socket — the orb page's SSE — subscribes
   * here and hears the derived states *and* the captions.
   */
  subscribeFace(handler: (event: StateEvent) => void): () => void;
  /** How many connections hold an open voice session right now. */
  mouths(): number;
};

export function createLaneFaceSource(): LaneFaceSource {
  const laneHandlers = new Set<(event: StateEvent) => void>();
  const faceHandlers = new Set<(event: StateEvent) => void>();
  let openMouths = 0;

  const emit = (event: StateEvent) => {
    for (const handler of [...laneHandlers]) handler(event);
    for (const handler of [...faceHandlers]) handler(event);
  };

  return {
    source: {
      subscribe(handler) {
        laneHandlers.add(handler);
        return () => laneHandlers.delete(handler);
      },
      // No handleGesture. Mute and dismiss used to close the hub's gate;
      // there is no hub gate any more, and pretending to act on them would
      // be a control that does nothing. The words stay in the vocabulary —
      // they are the face's own business now — and the source stays silent.
    },
    observer: {
      voiceCount(count: number) {
        const was = openMouths;
        openMouths = count;
        if (was === 0 && count > 0) emit({ type: "wake_opened" });
        if (was > 0 && count === 0) emit({ type: "idle" });
      },
      askStarted() {
        emit({ type: "thinking" });
      },
      answerDelivered() {
        emit({ type: "speaking" });
      },
      caption(text: string) {
        // Face subscribers only — the lane's socket already relayed this to
        // every WebSocket face, and a word said twice is noise.
        for (const handler of [...faceHandlers]) handler({ type: "caption", text });
      },
    },
    subscribeFace(handler) {
      faceHandlers.add(handler);
      return () => faceHandlers.delete(handler);
    },
    mouths: () => openMouths,
  };
}
