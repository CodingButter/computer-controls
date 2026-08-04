/**
 * The hub's actual ears and mouth: OS audio, as child processes.
 *
 * The design placed audio capture in the hub process rather than in any page
 * (#107), and this file is where that stops being an interface and becomes a
 * microphone. Capture and playback both run through ALSA's command-line tools —
 * `arecord` and `aplay` — because they are present on the machines this ships
 * to, they speak raw PCM over pipes, and a child process is a seam the hub can
 * kill. Killing the player IS the barge-in: audio the OS had buffered dies with
 * the process, which is the only honest way to stop a sound that has already
 * left userspace.
 *
 * Everything here takes an injectable spawn so the tests own both ends of every
 * pipe. The default commands are constants, not buried strings: what this
 * module runs on a machine is a fact a reader should find by reading one line.
 */

import { spawn as nodeSpawn } from "node:child_process";

import type { AudioFrame } from "./ear.ts";
import type { Speaker } from "./orb.ts";

/** What the capture side produces: mono 16-bit PCM at the rate the ear wants. */
export const CAPTURE_SAMPLE_RATE = 16_000;
/** What the playback side consumes: Gemini Live emits 24 kHz mono PCM. */
export const PLAYBACK_SAMPLE_RATE = 24_000;

export const DEFAULT_CAPTURE_COMMAND = [
  "arecord",
  "-q",
  "-f",
  "S16_LE",
  "-r",
  String(CAPTURE_SAMPLE_RATE),
  "-c",
  "1",
  "-t",
  "raw",
  "-",
] as const;

export const DEFAULT_PLAYBACK_COMMAND = [
  "aplay",
  "-q",
  "-f",
  "S16_LE",
  "-r",
  String(PLAYBACK_SAMPLE_RATE),
  "-c",
  "1",
  "-t",
  "raw",
  "-",
] as const;

/** The slice of a child process this module actually touches. */
export type ChildLike = {
  stdin?: { write(chunk: Buffer, cb: (error?: Error | null) => void): unknown } | null;
  stdout?: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  } | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
};

export type SpawnLike = (command: string, args: string[]) => ChildLike;

const defaultSpawn: SpawnLike = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });

export type MicrophoneOptions = {
  /** Called with each captured frame. Frames are whole samples, never split bytes. */
  onFrame(frame: AudioFrame): void;
  command?: readonly string[];
  spawnProcess?: SpawnLike;
};

export type Microphone = {
  stop(): void;
};

/**
 * Open the machine's microphone and stream frames until stopped.
 *
 * The byte stream is re-chunked into whole 16-bit samples: a capture process
 * flushes on its own schedule and owes no alignment to anybody, so an odd
 * trailing byte is carried into the next chunk rather than corrupting a sample.
 */
export function startMicrophone(options: MicrophoneOptions): Microphone {
  const command = options.command ?? DEFAULT_CAPTURE_COMMAND;
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const child = spawnProcess(command[0]!, [...command.slice(1)]);
  let stopped = false;
  let carry = Buffer.alloc(0);

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stopped) return;
    const usable = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const frameBytes = usable.length - (usable.length % 2);
    carry = Buffer.from(usable.subarray(frameBytes));
    if (frameBytes === 0) return;
    // Sliced through ArrayBuffer copy so the Int16Array view is aligned no
    // matter where Node's pool put the bytes.
    const samples = new Int16Array(
      usable.buffer.slice(usable.byteOffset, usable.byteOffset + frameBytes),
    );
    options.onFrame({ samples, sampleRate: CAPTURE_SAMPLE_RATE });
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    },
  };
}

export type CommandSpeakerOptions = {
  command?: readonly string[];
  spawnProcess?: SpawnLike;
};

/**
 * A speaker over a persistent playback process.
 *
 * One long-lived process rather than one per clip, because the realtime lane
 * delivers speech as a stream of small chunks and a process boundary between
 * every pair of chunks is an audible gap. `play` resolves when the bytes have
 * been handed to the player — pacing is the player's job, and stdin
 * backpressure is how it says slow down.
 *
 * An abort kills the player outright. The process's buffer dies with it, which
 * is exactly what a barge-in means; the next play starts a fresh one.
 */
export function commandSpeaker(options: CommandSpeakerOptions = {}): Speaker {
  const command = options.command ?? DEFAULT_PLAYBACK_COMMAND;
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  let child: ChildLike | undefined;

  function ensureChild(): ChildLike {
    if (child) return child;
    const spawned = spawnProcess(command[0]!, [...command.slice(1)]);
    const forget = () => {
      if (child === spawned) child = undefined;
    };
    spawned.on("exit", forget);
    spawned.on("error", forget);
    child = spawned;
    return spawned;
  }

  return {
    async play(audio: Uint8Array, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      const player = ensureChild();
      if (!player.stdin) {
        throw new Error("The playback process has no stdin to write to.");
      }
      const onAbort = () => {
        // The kill is the barge: buffered audio must die, not merely stop growing.
        player.kill("SIGTERM");
        if (child === player) child = undefined;
      };
      // The listener lives as long as the signal, not as long as the write:
      // `play` resolves when the bytes are handed off, but the sound is still
      // in the player's buffer, and a barge-in arriving after the handoff has
      // to kill it all the same. Killing an already-exited player is a no-op.
      signal.addEventListener("abort", onAbort, { once: true });
      await new Promise<void>((resolve, reject) => {
        player.stdin!.write(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
  };
}
