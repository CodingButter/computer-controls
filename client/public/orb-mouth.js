// The browser mouth: tap to talk, from this page, on this device.
//
// The architecture in one paragraph: the page dials Google's realtime
// endpoint DIRECTLY, using a single-use token the hub minted — the API key
// never travels here, and the token's constraints (model, instruction, the
// one ask_the_hub tool) were locked server-side, so this page could not
// widen them if it were hostile. Anything actionable goes to the hub as an
// `ask` over the /events lane; the hub's `answer` comes back over the same
// lane and is injected into the session for the voice to speak. Audio never
// touches the hub: latency was the reason this moved to the client.
//
// The seams below `openMouth` are exported and DOM-free so the decisions can
// be tested without a browser, the same split orb.js uses.

import { geminiLiveProvider } from "./live/session.js";
import {
  ANSWER_PREFIX,
  ANSWER_SUFFIX,
  DISPATCH_ACK,
  PROGRESS_PREFIX,
  PROGRESS_SUFFIX,
  realtimeConfig,
} from "./live/live.js";

/** Where a token comes from. POSTed with no body: the mint takes no shaping. */
export const TOKEN_PATH = "/api/orb/token";

/** The one sentence for a refused microphone, shared with the chat page. */
export const MIC_REFUSED = "The microphone was refused, so nothing was recorded.";

/** The lane rides the page's own origin — wss under TLS, ws on loopback. */
export function laneUrl(location) {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  return `${scheme}${location.host}/events`;
}

/** 16-bit little-endian PCM to Float32, for the playback graph. */
export function floatFromPcm16(bytes) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 0x8000;
  return out;
}

/**
 * What a lane frame means to a mouth waiting on its asks.
 *
 * The same exact-keys discipline the hub applies, applied back: a frame with
 * a stowaway field, a missing field, or a wrong type is null — noise, not an
 * instruction. Everything else on the lane (states, captions from other
 * mouths) is deliberately not this function's business.
 */
export function interpretLaneFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const keys = Object.keys(frame);
  if (keys.length !== 3) return null;
  if (frame.type !== "progress" && frame.type !== "answer") return null;
  if (typeof frame.id !== "string" || !frame.id) return null;
  if (typeof frame.text !== "string" || !frame.text) return null;
  return { kind: frame.type, id: frame.id, text: frame.text };
}

/** How an answer or progress line is framed for the voice to speak. */
export function frameForVoice(kind, text) {
  return kind === "answer"
    ? ANSWER_PREFIX + text + ANSWER_SUFFIX
    : PROGRESS_PREFIX + text + PROGRESS_SUFFIX;
}

/**
 * Mint a token. A 409 is a page state, not an error: the hub's own sentence
 * says what is missing, and the page renders it verbatim.
 */
export async function mintToken(fetcher = fetch) {
  const res = await fetcher(TOKEN_PATH, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `The token mint refused with status ${res.status}.`);
  }
  return body;
}

/**
 * Open the mouth: mic, lane, audio graph, session — in that order, because
 * the press is the consent gesture and the mic prompt must be its first
 * visible consequence.
 *
 * Returns { close } — close sends voice_close before tearing anything down,
 * so the widget's ears come back the moment this mouth shuts. A tab that
 * dies without closing is the lane's socket-death rule's problem, by design.
 */
export async function openMouth({ onCaption, onState, onReason }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    throw new Error(MIC_REFUSED);
  }

  const closers = [() => stream.getTracks().forEach((track) => track.stop())];
  const pendingAsks = new Set();
  const close = async () => {
    // Stale ids must not match a late answer on some future mouth's lane.
    pendingAsks.clear();
    for (const closer of closers.splice(0).reverse()) {
      try {
        await closer();
      } catch {
        // Teardown continues past a closer that failed: a half-open mouth
        // that stops closing is worse than any one resource leaking.
      }
    }
    onState?.("idle");
  };

  try {
    // The lane first: voice_open is what plugs other ears, and it must be
    // said before any audio can flow, not after.
    const lane = new WebSocket(laneUrl(location));
    await new Promise((resolve, reject) => {
      lane.addEventListener("open", resolve, { once: true });
      lane.addEventListener("error", () => reject(new Error("The hub's event lane refused the connection.")), {
        once: true,
      });
    });
    lane.send(JSON.stringify({ type: "voice_open" }));
    const hangUp = () => {
      if (lane.readyState === WebSocket.OPEN) {
        lane.send(JSON.stringify({ type: "voice_close" }));
      }
      lane.close();
    };
    closers.push(hangUp);
    // A closed tab must not deafen the widget until the socket-death rule
    // notices: say voice_close on the way out when there is time to.
    addEventListener("pagehide", hangUp, { once: true });
    // And the other direction: a lane that dies takes the mouth with it.
    // A session without the lane could still chat with the model but could
    // never reach the hub — a mouth that promises answers it cannot fetch.
    lane.addEventListener("close", () => {
      if (closers.length) {
        onReason?.("The hub's event lane closed, so the mouth closed with it.");
        void close();
      }
    });

    // The audio graph. Two contexts because the two directions run at the
    // rates the protocol names: the contexts do the resampling, which keeps
    // this file free of DSP it would get subtly wrong.
    const capture = new AudioContext({ sampleRate: 16000 });
    closers.push(() => capture.close());
    await capture.audioWorklet.addModule("/orb-capture-worklet.js");
    const playback = new AudioContext({ sampleRate: 24000 });
    closers.push(() => playback.close());

    let playCursor = 0;
    const playing = new Set();

    // Lane words that arrived while the model was speaking. Sending text into
    // a live session mid-generation is a barge: Gemini abandons the sentence
    // it was saying to obey the new turn. Live QA heard exactly that — answers
    // cut off by their own progress updates. So while audio is playing, lane
    // words queue here and flush when the playback drains.
    // `session` is declared below; nothing can play — so nothing can drain —
    // before the dial that creates it resolves.
    const heldWords = [];
    // Set when the user interrupts, cleared when the model speaks again.
    // Emptying `playing` is what lets a lane word through, so a barge-in
    // would otherwise open the faucet at the worst possible moment: the
    // user finally has the floor and tool #7 talks over them.
    let userHasFloor = false;
    const flushHeldWords = () => {
      while (heldWords.length) {
        const held = heldWords.shift();
        void session.sendText(frameForVoice(held.kind, held.text));
      }
    };

    const speak = (bytes) => {
      const samples = floatFromPcm16(bytes);
      if (!samples.length) return;
      // The model is talking, which means the user's interruption has been
      // answered. Narration may resume.
      userHasFloor = false;
      const buffer = playback.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = playback.createBufferSource();
      source.buffer = buffer;
      source.connect(playback.destination);
      const at = Math.max(playback.currentTime, playCursor);
      source.start(at);
      playCursor = at + buffer.duration;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        if (playing.size === 0) flushHeldWords();
      };
      onState?.("speaking");
    };
    const bargeIn = () => {
      // The user talking is the most significant signal there is, so the
      // queued narration dies here. Dropped, not deferred: these words
      // describe steps that have already finished, and stopping the sources
      // below fires `onended` — which drains `playing` and would flush this
      // very queue. Left in place, an interruption is the exact thing that
      // unloads stale narration at the person who interrupted.
      //
      // Answers survive, for the same reason the purge above spares them:
      // an id is struck from `pendingAsks` when its answer is queued, so a
      // dropped answer is a result the user asked for and never receives.
      for (let i = heldWords.length - 1; i >= 0; i -= 1) {
        if (heldWords[i].kind === "progress") heldWords.splice(i, 1);
      }
      // The floor belongs to the user until the model has answered them.
      userHasFloor = true;
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already ended; stopping it twice is not news.
        }
      }
      playing.clear();
      playCursor = 0;
      onState?.("listening");
    };

    // The session. The first mint is done by hand so the token's locked
    // model can be handed to the config; its token is banked so the first
    // dial spends it rather than minting twice. Every dial after that —
    // every redial — mints fresh, because the tokens are single-use.
    const first = await mintToken();
    let banked = first.token;

    const session = await geminiLiveProvider().connect(
      realtimeConfig({
        apiKey: "",
        model: first.model,
        mintToken: async () => {
          if (banked) {
            const token = banked;
            banked = undefined;
            return token;
          }
          return (await mintToken()).token;
        },
        events: {
          onAudio: speak,
          onBargeIn: bargeIn,
          onTranscript: (text, speaker) => {
            onCaption?.(text, speaker);
            // Relayed so faces that are not mouths can render it. Text the
            // session already produced — never audio; the lane has no
            // vocabulary for audio and that is the point.
            if (lane.readyState === WebSocket.OPEN) {
              lane.send(JSON.stringify({ type: "caption", text }));
            }
          },
          onFunctionCall: (call) => {
            // The model decided the user meant to stop listening. Close through
            // the same path a tab closing does — no function result is sent, the
            // same precedent as the refusal path. close() is idempotent, so a
            // call that arrives after the session is already closing is a
            // harmless no-op.
            if (call.name === "stop_listening") {
              void close();
              return;
            }
            // The lane is checked BEFORE the acknowledgement: DISPATCH_ACK
            // promises the model a result is coming, and a promise made over
            // a dead lane is an answer the user waits for forever.
            if (lane.readyState !== WebSocket.OPEN) {
              void session.sendFunctionResult(
                call.id,
                "The hub could not be reached, so nothing was done. Tell the user that plainly.",
              );
              return;
            }
            void session.sendFunctionResult(call.id, DISPATCH_ACK);
            pendingAsks.add(call.id);
            lane.send(
              JSON.stringify({ type: "ask", id: call.id, request: String(call.args.request ?? "") }),
            );
          },
          onRefusal: (reason) => {
            onReason?.(reason);
            void close();
          },
        },
      }),
    );
    closers.push(() => session.close());

    lane.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const meaning = interpretLaneFrame(frame);
      // Only this mouth's own asks are spoken; the lane broadcasts, and a
      // mouth relaying another mouth's answers would speak twice.
      if (!meaning || !pendingAsks.has(meaning.id)) return;
      if (meaning.kind === "answer") {
        pendingAsks.delete(meaning.id);
        // An answer supersedes the progress it outran: a queued "working on
        // it" spoken after the result would be the mouth narrating backwards.
        for (let i = heldWords.length - 1; i >= 0; i -= 1) {
          if (heldWords[i].kind === "progress" && heldWords[i].id === meaning.id) {
            heldWords.splice(i, 1);
          }
        }
      }
      // Narration waits while the user holds the floor; their result does not.
      if (meaning.kind === "progress" && userHasFloor) return;
      if (playing.size > 0) {
        heldWords.push(meaning);
        return;
      }
      void session.sendText(frameForVoice(meaning.kind, meaning.text));
    });

    // Mic into the session, last: the session starts muted and nothing
    // flows until this unmute — the press was the consent, this is the act.
    const source = capture.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(capture, "pcm16-capture");
    node.port.onmessage = (event) => session.sendAudio(new Uint8Array(event.data));
    source.connect(node);
    // A worklet with nothing downstream may be skipped by the graph; the
    // silent gain keeps it live without ever echoing the mic to the room.
    const silent = capture.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(capture.destination);

    session.unmute();
    onState?.("listening");

    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
