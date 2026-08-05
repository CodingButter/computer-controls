import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The mouth's DOM-free seams, imported exactly as the browser resolves them:
// orb-mouth.js imports ./live/session.js, which is segment 03's committed
// tsc emission — so this suite runs the same bytes the page runs.
import {
  MIC_REFUSED,
  TOKEN_PATH,
  floatFromPcm16,
  frameForVoice,
  interpretLaneFrame,
  laneUrl,
  mintToken,
} from "../../public/orb-mouth.js";
import { ANSWER_PREFIX, PROGRESS_PREFIX } from "../live/live.ts";

const publicDir = path.resolve(import.meta.dirname, "../../public");
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), "utf8");

describe("where the mouth dials from", () => {
  it("rides the page's own origin, secure when the page is", () => {
    expect(laneUrl({ protocol: "https:", host: "bigbeast.example.ts.net" })).toBe(
      "wss://bigbeast.example.ts.net/events",
    );
    expect(laneUrl({ protocol: "http:", host: "127.0.0.1:4111" })).toBe(
      "ws://127.0.0.1:4111/events",
    );
  });
});

describe("what a lane frame means to a mouth", () => {
  it("hears progress and answers, exactly shaped", () => {
    expect(interpretLaneFrame({ type: "progress", id: "a", text: "working" })).toEqual({
      kind: "progress",
      id: "a",
      text: "working",
    });
    expect(interpretLaneFrame({ type: "answer", id: "a", text: "done" })).toEqual({
      kind: "answer",
      id: "a",
      text: "done",
    });
  });

  it("treats a stowaway field as noise — the hub's discipline, applied back", () => {
    expect(
      interpretLaneFrame({ type: "answer", id: "a", text: "done", alsoRunShell: "rm -rf" }),
    ).toBeNull();
  });

  it("refuses missing or wrong-typed fields the same silent way", () => {
    expect(interpretLaneFrame({ type: "answer", id: "a" })).toBeNull();
    expect(interpretLaneFrame({ type: "answer", id: 7, text: "x" })).toBeNull();
    expect(interpretLaneFrame({ type: "caption", id: "a", text: "x" })).toBeNull();
    expect(interpretLaneFrame(null)).toBeNull();
    expect(interpretLaneFrame("answer")).toBeNull();
  });
});

describe("how hub words reach the voice", () => {
  it("frames answers and progress with the shared ownership sentences", () => {
    expect(frameForVoice("answer", "the mail is read")).toContain(ANSWER_PREFIX);
    expect(frameForVoice("progress", "reading mail")).toContain(PROGRESS_PREFIX);
  });
});

describe("pcm decoding for the speaker", () => {
  it("decodes little-endian 16-bit samples to floats", () => {
    // 0x7fff -> just under 1.0, 0x8000 (as -32768) -> -1.0
    const bytes = new Uint8Array([0xff, 0x7f, 0x00, 0x80, 0x00, 0x00]);
    const floats = floatFromPcm16(bytes);
    expect(floats.length).toBe(3);
    expect(floats[0]).toBeCloseTo(1, 3);
    expect(floats[1]).toBe(-1);
    expect(floats[2]).toBe(0);
  });

  it("drops a trailing odd byte rather than inventing a sample", () => {
    expect(floatFromPcm16(new Uint8Array([0x00, 0x00, 0x7f])).length).toBe(1);
  });
});

describe("minting", () => {
  it("asks the mint with a POST and no body — the mint takes no shaping", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ token: "auth_tokens/x", expiresAt: "later", model: "m" }),
      };
    }) as unknown as typeof fetch;

    const minted = await mintToken(fetcher);

    expect(calls[0].url).toBe(TOKEN_PATH);
    expect(calls[0].init).toEqual({ method: "POST" });
    expect("body" in calls[0].init).toBe(false);
    expect(minted.model).toBe("m");
  });

  it("surfaces the hub's own refusal sentence verbatim", async () => {
    const fetcher = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "The orb needs a Google account." }),
    })) as unknown as typeof fetch;

    await expect(mintToken(fetcher)).rejects.toThrow("The orb needs a Google account.");
  });
});

// The page half is outside the type checker and outside the module graph the
// suite executes, so its load-bearing properties are pinned at the source
// level — the same discipline the widget's boundary tests use.
describe("what the shipped mouth source promises", () => {
  const mouth = read("orb-mouth.js");
  const worklet = read("orb-capture-worklet.js");
  const page = read("orb.js");
  const html = read("orb.html");

  it("scanned real files, not an empty directory", () => {
    expect(mouth.length).toBeGreaterThan(1000);
    expect(worklet.length).toBeGreaterThan(100);
  });

  it("opens the microphone with echo cancellation, and only on request", () => {
    expect(mouth).toContain("echoCancellation: true");
    expect(mouth).toContain("noiseSuppression: true");
    // One getUserMedia call site, inside openMouth — never at module load.
    expect(mouth.split("getUserMedia").length).toBe(2);
  });

  it("carries no credential-shaped string", () => {
    for (const source of [mouth, worklet, page]) {
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
      expect(source).not.toMatch(/key=/);
    }
  });

  it("registers the processor name the mouth constructs", () => {
    const registered = worklet.match(/registerProcessor\("([^"]+)"/)?.[1];
    expect(registered).toBeTruthy();
    expect(mouth).toContain(`AudioWorkletNode(capture, "${registered}")`);
    expect(mouth).toContain('addModule("/orb-capture-worklet.js")');
  });

  it("says voice_open before audio and voice_close on the way out", () => {
    expect(mouth).toContain('{ type: "voice_open" }');
    expect(mouth).toContain('{ type: "voice_close" }');
    expect(mouth).toContain('"pagehide"');
  });

  it("notices the lane dying and closes with it", () => {
    expect(mouth).toContain('lane.addEventListener("close"');
  });

  it("checks the lane before promising the model an answer", () => {
    // DISPATCH_ACK tells the model a result is coming; the readyState check
    // must come first in the function-call handler, or a dead lane turns
    // every ask into an answer the user waits for forever.
    const handler = mouth.slice(mouth.indexOf("onFunctionCall"), mouth.indexOf("onRefusal"));
    const ack = handler.indexOf("sendFunctionResult(call.id, DISPATCH_ACK)");
    expect(handler.length).toBeGreaterThan(100);
    expect(ack).toBeGreaterThan(-1);
    expect(handler.indexOf("readyState")).toBeGreaterThan(-1);
    expect(handler.indexOf("readyState")).toBeLessThan(ack);
  });

  it("forgets pending asks on close, so a stale id cannot match late", () => {
    expect(mouth).toContain("pendingAsks.clear()");
  });

  it("is wired into the page the browser actually loads", () => {
    expect(html).toContain('id="talk"');
    expect(page).toContain('getElementById("talk")');
    expect(page).toContain('import("./orb-mouth.js")');
  });

  it("shares the one refused-microphone sentence with the chat page", () => {
    expect(read("app.js")).toContain(MIC_REFUSED);
  });

  it("parses as the browser will parse it", () => {
    // Nothing else in the pipeline checks the worklet's syntax: it is
    // loaded by addModule in a browser and never imported by this suite.
    expect(() => new Function(worklet)).not.toThrow();
  });
});
