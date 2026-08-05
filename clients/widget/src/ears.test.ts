// The ears' decisions, exercised without a browser: the worker seam speaks
// the LocalEar interface, the chain is the hub's own gate around it, and the
// plug answers the lane's voice words the way the arbitration design says.

import { describe, expect, test } from "vitest";
import { CAPTURE_RATE, createEarChain, createWorkerEar, plugDecision } from "./ears.js";

/** A worker that answers by hand: the test plays the engine room. */
function fakeWorker() {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const posted: Array<{ id: string; samples: ArrayBuffer }> = [];
  return {
    posted,
    postMessage(message: { id: string; samples: ArrayBuffer }) {
      posted.push(message);
    },
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
      listeners.push(listener);
    },
    emit(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
  };
}

const frame = (level: number, samples = 1600) => ({
  samples: new Int16Array(samples).fill(level),
  sampleRate: CAPTURE_RATE,
});

describe("the worker ear speaks the LocalEar seam", () => {
  test("it declares English and nothing else — the licence boundary rides the seam", () => {
    expect(createWorkerEar(fakeWorker()).languages).toEqual(["en"]);
  });

  test("a transcription is asked for and answered by id", async () => {
    const worker = fakeWorker();
    const ear = createWorkerEar(worker);
    const answer = ear.transcribe(frame(1000));
    expect(worker.posted).toHaveLength(1);
    worker.emit({ kind: "transcript", id: worker.posted[0].id, text: "mastra open the door" });
    await expect(answer).resolves.toBe("mastra open the door");
  });

  test("two in flight cannot swap answers: the id is the routing", async () => {
    const worker = fakeWorker();
    const ear = createWorkerEar(worker);
    const first = ear.transcribe(frame(1000));
    const second = ear.transcribe(frame(1000));
    // Answered out of order, on purpose.
    worker.emit({ kind: "transcript", id: worker.posted[1].id, text: "second" });
    worker.emit({ kind: "transcript", id: worker.posted[0].id, text: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  test("a failed transcription rejects — which the gate reads as a closed gate", async () => {
    const worker = fakeWorker();
    const ear = createWorkerEar(worker);
    const answer = ear.transcribe(frame(1000));
    worker.emit({ kind: "transcript-failed", id: worker.posted[0].id, error: "the model choked" });
    await expect(answer).rejects.toThrow("the model choked");
  });

  test("a dead model rejects everything, forever: it can never become audio on the network", async () => {
    const worker = fakeWorker();
    const ear = createWorkerEar(worker);
    const inFlight = ear.transcribe(frame(1000));
    worker.emit({ kind: "dead", error: "no weights" });
    await expect(inFlight).rejects.toThrow("no weights");
    await expect(ear.transcribe(frame(1000))).rejects.toThrow("no weights");
  });

  test("the utterance's own buffer stays the gate's: a copy is transferred, not the original", () => {
    const worker = fakeWorker();
    const ear = createWorkerEar(worker);
    const utterance = frame(1000);
    void ear.transcribe(utterance);
    expect(utterance.samples.length).toBeGreaterThan(0);
    expect(worker.posted[0].samples).not.toBe(utterance.samples.buffer);
  });
});

describe("the chain is the hub's own gate around this ear", () => {
  test("speech with the name, then silence, opens the gate and forwards what follows", async () => {
    const worker = fakeWorker();
    const opened: unknown[] = [];
    const forwarded: unknown[] = [];
    const gate = createEarChain({
      ear: createWorkerEar(worker),
      events: {
        onOpen: (hearing: unknown) => opened.push(hearing),
        onIdle: () => {},
        onForward: (pushed: unknown) => forwarded.push(pushed),
      },
    });

    // A loud utterance, then enough silence to end it.
    await gate.push(frame(1000));
    const settling = gate.push(frame(0, CAPTURE_RATE)); // a full second of silence
    // The consideration is queued on a microtask; one turn of the loop later
    // the buffered utterance has reached the worker, and the test transcribes it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.posted).toHaveLength(1);
    worker.emit({ kind: "transcript", id: worker.posted[0].id, text: "mastra, what time is it?" });
    await settling;

    expect(gate.isOpen).toBe(true);
    expect(opened).toHaveLength(1);
    expect((opened[0] as { transcript: string }).transcript).toBe("mastra, what time is it?");

    // Open gate forwards; nothing was forwarded before it opened.
    expect(forwarded).toHaveLength(0);
    await gate.push(frame(1000));
    expect(forwarded).toHaveLength(1);
  });

  test("speech without the name never opens the gate — the classifier is the wake decision", async () => {
    const worker = fakeWorker();
    const opened: unknown[] = [];
    const gate = createEarChain({
      ear: createWorkerEar(worker),
      events: { onOpen: (hearing: unknown) => opened.push(hearing), onIdle: () => {}, onForward: () => {} },
    });

    await gate.push(frame(1000));
    const settling = gate.push(frame(0, CAPTURE_RATE));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({ kind: "transcript", id: worker.posted[0].id, text: "just talking to myself here" });
    await settling;

    expect(gate.isOpen).toBe(false);
    expect(opened).toHaveLength(0);
  });
});

describe("the plug: the lane's voice words, answered", () => {
  test("another client opening a voice session plugs these ears", () => {
    expect(plugDecision("voice_opened", false)).toBe("plug");
  });

  test("our own session's confirmation does not: the widget never self-plugs", () => {
    expect(plugDecision("voice_opened", true)).toBeNull();
  });

  test("a closed voice session always unplugs — listening is what should resume", () => {
    expect(plugDecision("voice_closed", false)).toBe("unplug");
    expect(plugDecision("voice_closed", true)).toBe("unplug");
  });

  test("every other word on the lane is not the ears' business", () => {
    for (const type of ["wake_opened", "caption", "thinking", "speaking", "idle", "answer", "progress"]) {
      expect(plugDecision(type, false)).toBeNull();
      expect(plugDecision(type, true)).toBeNull();
    }
  });
});
