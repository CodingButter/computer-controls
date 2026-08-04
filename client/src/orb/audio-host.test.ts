import { describe, expect, it } from "vitest";

import {
  CAPTURE_SAMPLE_RATE,
  commandSpeaker,
  DEFAULT_CAPTURE_COMMAND,
  DEFAULT_PLAYBACK_COMMAND,
  startMicrophone,
  type ChildLike,
  type SpawnLike,
} from "./audio-host.ts";
import type { AudioFrame } from "./ear.ts";

class FakeChild implements ChildLike {
  command: string;
  args: string[];
  written: Buffer[] = [];
  killedWith: string | undefined;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private dataListeners: Array<(chunk: Buffer) => void> = [];

  stdin = {
    write: (chunk: Buffer, cb: (error?: Error | null) => void): boolean => {
      this.written.push(chunk);
      cb(null);
      return true;
    },
  };

  stdout = {
    on: (_event: "data", listener: (chunk: Buffer) => void): void => {
      this.dataListeners.push(listener);
    },
  };

  constructor(command: string, args: string[]) {
    this.command = command;
    this.args = args;
  }

  kill(signal?: string): void {
    this.killedWith = signal ?? "SIGTERM";
    this.emit("exit");
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  produce(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

function fakeSpawner() {
  const children: FakeChild[] = [];
  const spawnProcess: SpawnLike = (command, args) => {
    const child = new FakeChild(command, args);
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

describe("the microphone", () => {
  it("runs the capture command and hands whole frames onward", () => {
    const { children, spawnProcess } = fakeSpawner();
    const frames: AudioFrame[] = [];
    startMicrophone({ onFrame: (frame) => frames.push(frame), spawnProcess });

    expect(children[0].command).toBe(DEFAULT_CAPTURE_COMMAND[0]);
    children[0].produce(Buffer.from(new Int16Array([100, -200, 300]).buffer));

    expect(frames).toHaveLength(1);
    expect([...frames[0].samples]).toEqual([100, -200, 300]);
    expect(frames[0].sampleRate).toBe(CAPTURE_SAMPLE_RATE);
  });

  it("carries an odd trailing byte into the next chunk instead of corrupting a sample", () => {
    const { children, spawnProcess } = fakeSpawner();
    const frames: AudioFrame[] = [];
    startMicrophone({ onFrame: (frame) => frames.push(frame), spawnProcess });

    const bytes = Buffer.from(new Int16Array([7, 8]).buffer);
    children[0].produce(bytes.subarray(0, 3));
    children[0].produce(bytes.subarray(3));

    expect(frames.map((f) => [...f.samples])).toEqual([[7], [8]]);
  });

  it("stops by killing the capture process, and drops frames after stop", () => {
    const { children, spawnProcess } = fakeSpawner();
    const frames: AudioFrame[] = [];
    const mic = startMicrophone({ onFrame: (frame) => frames.push(frame), spawnProcess });

    mic.stop();
    expect(children[0].killedWith).toBe("SIGTERM");
    children[0].produce(Buffer.from(new Int16Array([1]).buffer));
    expect(frames).toHaveLength(0);
  });
});

describe("the speaker", () => {
  it("spawns one persistent player and writes chunks to its stdin", async () => {
    const { children, spawnProcess } = fakeSpawner();
    const speaker = commandSpeaker({ spawnProcess });

    await speaker.play(new Uint8Array([1, 2]), new AbortController().signal);
    await speaker.play(new Uint8Array([3, 4]), new AbortController().signal);

    expect(children).toHaveLength(1);
    expect(children[0].command).toBe(DEFAULT_PLAYBACK_COMMAND[0]);
    expect(children[0].written.map((b) => [...b])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("kills the player on abort, so buffered audio dies with it", async () => {
    const { children, spawnProcess } = fakeSpawner();
    const speaker = commandSpeaker({ spawnProcess });
    const controller = new AbortController();

    await speaker.play(new Uint8Array([1]), controller.signal);
    controller.abort();

    expect(children[0].killedWith).toBe("SIGTERM");
  });

  it("starts a fresh player after a barge-in", async () => {
    const { children, spawnProcess } = fakeSpawner();
    const speaker = commandSpeaker({ spawnProcess });
    const controller = new AbortController();

    await speaker.play(new Uint8Array([1]), controller.signal);
    controller.abort();
    await speaker.play(new Uint8Array([9]), new AbortController().signal);

    expect(children).toHaveLength(2);
    expect(children[1].written.map((b) => [...b])).toEqual([[9]]);
  });

  it("writes nothing for a play that was already aborted", async () => {
    const { children, spawnProcess } = fakeSpawner();
    const speaker = commandSpeaker({ spawnProcess });
    const controller = new AbortController();
    controller.abort();

    await speaker.play(new Uint8Array([1]), controller.signal);
    expect(children).toHaveLength(0);
  });
});
