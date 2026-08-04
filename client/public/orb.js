// The orb page's browser half, served verbatim by `readUiAsset` and loaded by
// `orb.html` as a module.
//
// This page is a face and nothing else. It holds no microphone: per issue #107
// the ear chain — voice detection, the local Moonshine ear, the classifier —
// lives in the hub process at the OS audio layer, so the privacy property is
// enforced in one place and survives this tab being closed. What this file does
// is render state as motion, show captions, and forward gestures.
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
 * Every mood the hub can report, and the only ones this page will wear (#106).
 *
 * Closed like the state list above it. An unrecognised mood renders as the
 * resting colour rather than as whatever the shader does with a word it has
 * never seen, because a face guessing at a label it does not know is a face
 * showing something the hub never said.
 */
export const ORB_MOODS = ["neutral", "frustrated", "excited", "calm"];

/**
 * Decide what an event from the hub means for the page.
 *
 * Returns an instruction rather than touching anything, so the whole event
 * vocabulary can be exercised in a test. An event the page does not recognise
 * produces `null` — a face that guessed at an unknown event would be a face
 * that renders something the hub never said.
 */
export function interpret(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "state") {
    return ORB_STATES.includes(event.state) ? { kind: "state", state: event.state } : null;
  }
  if (event.type === "caption") {
    if (typeof event.text !== "string" || !event.text.trim()) return null;
    const speaker = event.speaker === "user" || event.speaker === "assistant" ? event.speaker : null;
    return speaker ? { kind: "caption", text: event.text, speaker } : null;
  }
  if (event.type === "mood") {
    return ORB_MOODS.includes(event.mood) ? { kind: "mood", mood: event.mood } : null;
  }
  return null;
}

/**
 * What the status probe means for whether the orb can be used at all.
 *
 * Ruling 5: no credential means no orb, and the page says why rather than
 * presenting a control that cannot work.
 */
export function availability(status) {
  if (!status || status.enabled !== true) {
    return {
      usable: false,
      reason: status?.reason ?? "The orb is unavailable.",
    };
  }
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
    if (instruction.kind === "mood") {
      // The colour is the only place this label lands. It is not written to the
      // drawer, not added to the caption, and not kept in a variable the page
      // reads back — the shader tweens toward it and that is the whole of its
      // life. A DOM-only face simply does not show a mood.
      webglOrb?.setMood(instruction.mood);
      return;
    }
    caption.textContent = instruction.text;
    appendTurn(instruction.text, instruction.speaker === "user" ? "you" : "agent");
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
