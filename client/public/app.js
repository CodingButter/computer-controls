// The browser half of the client, served verbatim by `readUiAsset` and loaded
// by `index.html` as a module. It lives here rather than inline in the page so
// that the code a browser runs is the same code the tests import: an inline
// script can only be read, never executed, by anything but a browser.
//
// The seams below the fold — `failureReason`, `handleListenResponse` — are
// exported for that reason. Everything under `init()` touches the DOM and runs
// only in a browser.

const VOICE_BASE = "/api/agents/session/voice";

/** Said when the microphone worked but produced no words. */
export const HEARD_NOTHING =
  "Nothing was transcribed, so nothing was sent. Try again closer to the mic.";

/**
 * What the voice routes say when they refuse. They answer JSON on every
 * path, but a proxy in front of them might not, so the raw body is the
 * last resort rather than a crash.
 */
export async function failureReason(res) {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error ?? parsed.message ?? body;
  } catch {
    return body || `The voice route answered ${res.status}.`;
  }
}

/**
 * What becomes of a `/listen` answer: a refusal explains itself, silence is
 * refused rather than forwarded, and words go down the same lane a typed
 * message takes.
 *
 * Separated from the recorder so the decisions can be tested without a
 * microphone, a MediaRecorder, or a DOM.
 */
export async function handleListenResponse(
  res,
  { onRefusal, onHeardNothing, sendTurn },
) {
  // Read the status before the body: a refusal that is not JSON would
  // otherwise surface as a parse error about the explanation instead of
  // the explanation.
  if (!res.ok) {
    onRefusal(await failureReason(res));
    return;
  }
  const heard = await res.json();
  const transcript = (heard.text ?? "").trim();
  if (!transcript) {
    // An empty turn is worse than a failed one: the agent would
    // answer a question nobody asked.
    onHeardNothing();
    return;
  }
  await sendTurn(transcript, { speakReply: true });
}

function init() {
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = document.getElementById("message");
  const send = document.getElementById("send");
  const scope = document.getElementById("scope");
  let threadId;

  function say(who, text, failed) {
    const el = document.createElement("div");
    el.className = `turn ${who}${failed ? " failed" : ""}`;
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  const talk = document.getElementById("talk");

  fetch("/api/health")
    .then((r) => r.json())
    .then((health) => {
      scope.textContent = `scope ${health.desktopScope} · ${health.tools.length} tools`;
      if (health.voice) {
        // Offered only when the hub says it can speak; when it cannot,
        // the button stays visible but explains itself instead of failing.
        talk.style.display = "block";
        if (!health.voice.enabled) {
          talk.disabled = true;
          talk.title = health.voice.reason ?? "Voice is off.";
          talk.textContent = "Voice off";
        }
      }
    })
    .catch(() => {
      scope.textContent = "no hub";
    });

  // One turn, whether the words were typed or spoken. The agent cannot
  // tell the difference, which is the point.
  async function sendTurn(message, { speakReply = false } = {}) {
    say("you", message);
    const pending = say("agent", "…");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, threadId }),
      });
      const reply = await response.json();
      if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
      threadId = reply.threadId ?? threadId;
      pending.textContent = reply.text || `(${reply.status})`;
      if (speakReply && reply.text) await speak(reply.text);
    } catch (error) {
      pending.classList.add("failed");
      pending.textContent = String(error);
    }
  }

  let lastSpeakFailure;

  async function speak(text) {
    // The words already reached the conversation; only the audio was lost.
    // That is still worth one sentence: a button that silently does nothing
    // is indistinguishable from a broken one, and the usual cause — an
    // OpenAI account with no credits — is fixable by the person reading it.
    // Said once per distinct reason, so a dry wallet explains itself rather
    // than nagging.
    try {
      const res = await fetch(`${VOICE_BASE}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, speakerId: "nova" }),
      });
      if (!res.ok) {
        noteSpeakFailure(await failureReason(res));
        return;
      }
      lastSpeakFailure = undefined;
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      await audio.play().catch(() => {});
    } catch (error) {
      noteSpeakFailure(String(error));
    }
  }

  function noteSpeakFailure(reason) {
    if (reason === lastSpeakFailure) return;
    lastSpeakFailure = reason;
    say("agent", `The answer was not spoken aloud. ${reason}`, true);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    send.disabled = true;
    try {
      await sendTurn(message);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  // Hold to talk: record while pressed, transcribe on release, and send
  // the transcript down exactly the same lane a typed message takes.
  let recorder;
  let chunks = [];

  talk.addEventListener("pointerdown", async (event) => {
    if (talk.disabled || recorder) return;
    event.preventDefault();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      chunks = [];
      recorder.addEventListener("dataavailable", (e) => chunks.push(e.data));
      recorder.start();
      talk.classList.add("recording");
      talk.textContent = "Listening…";
    } catch {
      recorder = undefined;
      say("agent", "The microphone was refused, so nothing was recorded.", true);
    }
  });

  async function finishRecording() {
    if (!recorder) return;
    const active = recorder;
    recorder = undefined;
    talk.classList.remove("recording");
    talk.textContent = "Hold to talk";
    await new Promise((resolve) => {
      active.addEventListener("stop", resolve, { once: true });
      active.stop();
    });
    active.stream.getTracks().forEach((t) => t.stop());
    const mimetype = active.mimeType || "audio/webm";
    const filetype = mimetype.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: mimetype });

    const body = new FormData();
    body.set("audio", new File([blob], `audio.${filetype}`, { type: mimetype }));
    body.set("options", JSON.stringify({ filetype }));
    try {
      const res = await fetch(`${VOICE_BASE}/listen`, { method: "POST", body });
      await handleListenResponse(res, {
        onRefusal: (reason) => say("agent", reason, true),
        onHeardNothing: () => say("agent", HEARD_NOTHING, true),
        sendTurn,
      });
    } catch (error) {
      say("agent", String(error), true);
    }
  }

  talk.addEventListener("pointerup", finishRecording);
  talk.addEventListener("pointercancel", finishRecording);
  talk.addEventListener("pointerleave", finishRecording);
}

// A browser has a document; the tests that import the seams above do not.
if (typeof document !== "undefined") init();
