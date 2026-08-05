// The orb page's browser half, served verbatim by `readUiAsset` and loaded by
// `orb.html` as a module.
//
// This page is a face, and — since the voice moved to the client — on request
// a mouth. The mouth is tap-to-talk only: the microphone opens on a press,
// never on its own, and everything it captures dials Google directly with a
// hub-minted single-use token (orb-mouth.js owns that lifecycle). With the
// mouth closed this file is what it always was: render state as motion, show
// captions, forward gestures.
//
// The seams above `init()` are exported and DOM-free so they can be tested
// without a browser, the same way `app.js` splits its own decisions out.

import { hasWebGl, syntheticLevel } from "./orb-webgl.js";

const ORB_BASE = "/api/orb";

/** Every state the hub can report, and the only ones this page will render. */
export const ORB_STATES = ["idle", "listening", "thinking", "speaking"];

/** Every gesture this page may send. The hub refuses anything else anyway. */
export const GESTURES = ["toggle", "mute", "dismiss"];

/**
 * Decide what an event from the hub means for the page.
 *
 * Returns an instruction rather than touching anything, so the whole event
 * vocabulary can be exercised in a test. An event the page does not recognise
 * produces `null` — a face that guessed at an unknown event would be a face
 * that renders something the hub never said.
 *
 * The vocabulary shrank with the hub's hearing: the deaf hub speaks states
 * and captions, nothing else. Captions arrive unattributed — the lane's
 * caption word deliberately carries no speaker, because which device was
 * talking is arbitration state, not content a face renders. Mood is gone
 * entirely: sentiment lives on the device that heard the voice now, and the
 * hub never learns it, so there is nothing for this pipe to carry.
 */
export function interpret(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "state") {
    return ORB_STATES.includes(event.state) ? { kind: "state", state: event.state } : null;
  }
  if (event.type === "caption") {
    if (typeof event.text !== "string" || !event.text.trim()) return null;
    return { kind: "caption", text: event.text };
  }
  return null;
}

/**
 * What the status probe means for whether the orb can be used at all.
 *
 * Ruling 5: no credential means no orb, and the page says why rather than
 * presenting a control that cannot work.
 *
 * The status route speaks its own coarse vocabulary — idle or talking — while
 * this page renders the richer one. "Talking" maps to the listening render
 * state: a conversation is live somewhere, and the stream will refine the
 * picture the moment it says anything. Anything unrecognised is idle, which
 * is the one state that is safe to be wrong about.
 */
export function availability(status) {
  if (!status || status.enabled !== true) {
    return {
      usable: false,
      reason: status?.reason ?? "The orb is unavailable.",
    };
  }
  if (status.state === "talking") return { usable: true, state: "listening" };
  return { usable: true, state: ORB_STATES.includes(status.state) ? status.state : "idle" };
}

function init() {
  const orb = document.getElementById("orb");
  const canvas = document.getElementById("orb-canvas");
  const caption = document.getElementById("caption");
  const reason = document.getElementById("reason");
  const log = document.getElementById("log");
  const drawer = document.getElementById("drawer");
  const drawerToggle = document.getElementById("drawer-toggle");
  const composer = document.getElementById("composer");
  const message = document.getElementById("message");

  let threadId;
  let usable = false;

  // The WebGL orb — null when the browser lacks WebGL or the DOM orb is the
  // active face. setState feeds both renderers; the DOM orb stays in sync
  // whether it's visible or hidden, which costs nothing.
  let webglOrb = null;
  let currentState = "idle";

  const setState = (state) => {
    orb.setAttribute("data-state", state);
    currentState = state;
    webglOrb?.setState(state);
  };

  const appendTurn = (text, who) => {
    const line = document.createElement("div");
    line.className = `turn ${who}`;
    line.textContent = text;
    log.append(line);
    log.scrollTop = log.scrollHeight;
  };

  const apply = (instruction) => {
    if (!instruction) return;
    if (instruction.kind === "state") {
      setState(instruction.state);
      if (instruction.state === "idle") caption.textContent = "";
      return;
    }
    // A stream caption is unattributed — the lane's word carries no speaker —
    // so it lands on the caption line only. The drawer log stays the record of
    // turns this page can attribute: its own typing, and its own mouth.
    caption.textContent = instruction.text;
  };

  const gesture = async (name) => {
    if (!usable || !GESTURES.includes(name)) return;
    const res = await fetch(`${ORB_BASE}/gesture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gesture: name }),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (ORB_STATES.includes(body.state)) setState(body.state);
  };

  orb.addEventListener("click", () => void gesture("toggle"));

  // The talk toggle: this device's own mouth. Loaded on first press so a
  // page that is only ever a face never fetches the mouth at all. The mouth
  // module owns the whole lifecycle; this wiring owns only the button state
  // and where the mouth's words land on the page.
  //
  // Deliberately NOT gated on availability(): that verdict describes the
  // hub's own voice, and the mouth does not need one — it needs the token
  // mint, whose refusal arrives as its own complete sentence and is shown
  // here verbatim. Ruling 5's principle (say why, don't present a dead
  // control) is honored by the mint's sentence, not by hiding the button.
  const talk = document.getElementById("talk");
  let mouth = null;
  let opening = false;
  const setLive = (live) => {
    talk.setAttribute("data-live", String(live));
    talk.setAttribute("aria-pressed", String(live));
    talk.textContent = live ? "Stop" : "Talk";
  };
  talk.addEventListener("click", async () => {
    if (opening) return;
    if (mouth) {
      const closing = mouth;
      mouth = null;
      setLive(false);
      await closing.close();
      return;
    }
    opening = true;
    try {
      const { openMouth } = await import("./orb-mouth.js");
      reason.hidden = true;
      mouth = await openMouth({
        onCaption: (text, speaker) => {
          caption.textContent = text;
          appendTurn(text, speaker === "user" ? "you" : "agent");
        },
        onState: (state) => {
          if (ORB_STATES.includes(state)) setState(state);
          if (state === "idle" && mouth) {
            mouth = null;
            setLive(false);
          }
        },
        onReason: (text) => {
          reason.textContent = text;
          reason.hidden = false;
        },
      });
      setLive(true);
    } catch (error) {
      // A refused mic and a keyless hub land here the same way: as a
      // sentence the page shows, while everything else keeps working.
      reason.textContent = error?.message ?? "The mouth could not be opened.";
      reason.hidden = false;
      setLive(false);
    } finally {
      opening = false;
    }
  });

  // Feature-detect WebGL. If the browser supports it, mount the shader sphere
  // and hide the DOM button. If not — or if the dynamic import fails for any
  // reason — the DOM orb stays, and its CSS animations carry state. This is
  // the single point where the fallback decision is made (#110 ruling 5).
  // The probe uses a scratch canvas: probing the display canvas would claim
  // its one-and-only context type before three.js asks for its own.
  if (canvas && hasWebGl(document.createElement("canvas"))) {
    import("./orb-webgl.js")
      .then(({ mountWebGlOrb }) => {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        return mountWebGlOrb({ canvas, reducedMotion });
      })
      .then((orb3d) => {
        webglOrb = orb3d;
        webglOrb.setState(currentState);
        canvas.hidden = false;
        orb.hidden = true;
        canvas.addEventListener("click", () => void gesture("toggle"));
      })
      .catch(() => {
        // three.js failed to load or the WebGL context failed. The DOM orb
        // was never hidden, so the page is already in its fallback state.
      });
  }

  // The page owns the single animation loop. It synthesizes a level from the
  // current state and feeds it to the WebGL orb each frame. When the DOM orb
  // is the active face, webglOrb is null and this is a no-op.
  const loop = (now) => {
    if (webglOrb) {
      webglOrb.setLevel(syntheticLevel(currentState, now));
      webglOrb.tick(now);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  drawerToggle.addEventListener("click", () => {
    const open = drawer.getAttribute("data-open") !== "true";
    drawer.setAttribute("data-open", String(open));
    drawerToggle.setAttribute("aria-expanded", String(open));
  });

  // Typing still works when the orb does not — that is the promise the refusal
  // text makes, so the composer is never disabled alongside the orb.
  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = message.value.trim();
    if (!text) return;
    message.value = "";
    appendTurn(text, "you");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, ...(threadId ? { threadId } : {}) }),
    });
    const reply = await res.json();
    if (reply.threadId) threadId = reply.threadId;
    appendTurn(reply.text ?? reply.error ?? "No answer came back.", "agent");
  });

  const listen = () => {
    const events = new EventSource(`${ORB_BASE}/events`);
    events.addEventListener("message", (event) => {
      try {
        apply(interpret(JSON.parse(event.data)));
      } catch {
        // A malformed frame is dropped rather than rendered. EventSource
        // reconnects on its own, which is why nothing is torn down here.
      }
    });
  };

  void (async () => {
    const status = await fetch(`${ORB_BASE}/status`)
      .then((res) => res.json())
      .catch(() => undefined);
    const verdict = availability(status);

    if (!verdict.usable) {
      usable = false;
      orb.setAttribute("data-off", "true");
      orb.disabled = true;
      orb.title = verdict.reason;
      reason.textContent = verdict.reason;
      reason.hidden = false;
      return;
    }

    usable = true;
    setState(verdict.state);
    listen();
  })();
}

if (typeof document !== "undefined") init();
