/**
 * What the orb lane needs from this particular machine.
 *
 * The lane itself is written against interfaces so its tests never touch a disk
 * or a sound card. This module is where those interfaces meet the host, and it
 * is deliberately the only place in the lane that does.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Clip, ClipClass, ClipStore } from "./utterance-bank.ts";
import type { Speaker } from "./orb.ts";

type StoredClip = {
  id: string;
  class: ClipClass;
  durationMs: number;
  /** base64 — one file per clip is one write, and a half-written clip is a clip that fails to parse rather than one that plays as noise. */
  audio: string;
};

/**
 * The bank, kept under the hub's own root.
 *
 * A clip that cannot be read is a clip that is not there. Filler is the most
 * disposable thing the orb owns — being briefly quiet is the correct response to
 * a corrupt cache entry, and `fill` will simply write it again.
 */
export function diskClipStore(root: string, dirName = ".mastracode/orb-clips"): ClipStore {
  const dir = path.join(root, dirName);
  const file = (id: string) => path.join(dir, `${id}.json`);

  return {
    async read(id) {
      try {
        const stored = JSON.parse(await readFile(file(id), "utf8")) as StoredClip;
        return {
          id: stored.id,
          class: stored.class,
          durationMs: stored.durationMs,
          audio: Uint8Array.from(Buffer.from(stored.audio, "base64")),
        } satisfies Clip;
      } catch {
        return undefined;
      }
    },

    async write(clip) {
      await mkdir(dir, { recursive: true });
      const stored: StoredClip = {
        id: clip.id,
        class: clip.class,
        durationMs: clip.durationMs,
        audio: Buffer.from(clip.audio).toString("base64"),
      };
      await writeFile(file(clip.id), JSON.stringify(stored), "utf8");
    },

    async list() {
      try {
        return (await readdir(dir))
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -".json".length));
      } catch {
        return [];
      }
    },
  };
}

/**
 * The speaker on a machine that has none wired yet.
 *
 * OS-level playback arrives with the widget work in #107. Until then this
 * refuses rather than resolving: a speaker that silently succeeds would report a
 * clip as spoken when nothing was heard, and every timing property the mouth
 * holds would be measuring an illusion. The mouth survives a failed utterance
 * and moves to the next one, so the refusal costs nothing but honesty.
 */
export const unwiredSpeaker: Speaker = {
  async play() {
    throw new Error("This hub has no audio output wired yet.");
  },
};
