import { expect, test } from "vitest";

import { CUE_MS, CUE_START_HZ, CUE_STOP_HZ, playCue } from "@/lib/wake-capture";

/**
 * The cue, checked without a browser.
 *
 * `playCue` takes the context it plays on, so it can be handed a stand-in and
 * asked what it built. That is the same property the real rule depends on: a
 * function that cannot reach for a context cannot open a second one.
 */

type Recorded = {
  frequencies: number[];
  starts: number[];
  stops: number[];
  ramps: [number, number][];
  connections: string[];
};

function fakeContext(currentTime = 0) {
  const log: Recorded = {
    frequencies: [],
    starts: [],
    stops: [],
    ramps: [],
    connections: [],
  };
  const destination = { name: "destination" };

  const context = {
    currentTime,
    destination,
    createOscillator: () => ({
      name: "oscillator",
      frequency: {
        set value(hz: number) {
          log.frequencies.push(hz);
        },
      },
      connect: (target: { name: string }) => log.connections.push(`oscillator->${target.name}`),
      start: (at: number) => log.starts.push(at),
      stop: (at: number) => log.stops.push(at),
    }),
    createGain: () => ({
      name: "gain",
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: (value: number, at: number) => log.ramps.push([value, at]),
      },
      connect: (target: { name: string }) => log.connections.push(`gain->${target.name}`),
    }),
  };

  return { context, log };
}

const play = (hz: number, ms: number, now = 0) => {
  const { context, log } = fakeContext(now);
  playCue(context as unknown as BaseAudioContext, hz, ms);
  return log;
};

test("a cue is one note at the asked-for pitch, reaching the speakers", () => {
  const log = play(CUE_START_HZ, CUE_MS);
  expect(log.frequencies).toEqual([CUE_START_HZ]);
  expect(log.starts).toHaveLength(1);
  // Through a gain rather than straight at the destination: the envelope is
  // what stops the note from clicking at each end.
  expect(log.connections).toEqual(["oscillator->gain", "gain->destination"]);
});

test("a cue stops on its own, the requested length after it starts", () => {
  const log = play(CUE_STOP_HZ, CUE_MS, 4.5);
  expect(log.starts).toEqual([4.5]);
  expect(log.stops).toEqual([4.5 + CUE_MS / 1000]);
});

test("the note fades in and out instead of switching on", () => {
  const log = play(CUE_START_HZ, CUE_MS);
  const [rampUp, rampDown] = log.ramps;
  expect(rampUp?.[0]).toBeGreaterThan(0);
  expect(rampDown?.[0]).toBe(0);
  expect(rampDown?.[1]).toBe(CUE_MS / 1000);
});

test("the two cues are different notes, so opening and closing do not sound alike", () => {
  expect(CUE_START_HZ).not.toBe(CUE_STOP_HZ);
});
