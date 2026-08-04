/**
 * Main entry point: wires the connect form, WebSocket state consumer, and
 * voice record/play into a single PWA.
 */

import { connect, ConnectError } from "./connect.ts";
import { createStateView } from "./state-view.ts";
import { createVoiceClient, VoiceError } from "./voice.ts";

const connectForm = document.getElementById(
  "connect-form",
) as HTMLFormElement;
const serverInput = document.getElementById(
  "server-url",
) as HTMLInputElement;
const secretInput = document.getElementById("secret") as HTMLInputElement;
const connectError = document.getElementById("connect-error")!;
const connectScreen = document.getElementById("connect-screen")!;
const mainScreen = document.getElementById("main-screen")!;

const stateContainer = document.getElementById("desktop-state")!;
const statusLine = document.getElementById("status-line")!;

const talkButton = document.getElementById("talk-btn") as HTMLButtonElement;
const audioPlayer = document.getElementById("reply-audio") as HTMLAudioElement;

let voiceClient: ReturnType<typeof createVoiceClient> | null = null;

connectForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  connectError.textContent = "";
  connectError.classList.add("hidden");

  const serverUrl = serverInput.value.trim();
  const secret = secretInput.value;

  if (!serverUrl || !secret) {
    showConnectError("Enter both the server URL and the shared secret.");
    return;
  }

  try {
    const { token, ws } = await connect(serverUrl, secret);
    const stateView = createStateView(stateContainer);

    // Wire the status line into the state view.
    const origSetStatus = stateView.setStatus;
    stateView.setStatus = (text: string, kind: "ok" | "err" = "ok") => {
      statusLine.textContent = text;
      statusLine.className = `status-line ${kind}`;
      origSetStatus(text, kind);
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      stateView.ingest(msg);
    };

    ws.onclose = () => {
      stateView.setStatus("Disconnected from the desktop.", "err");
      talkButton.disabled = true;
    };

    // Wire the voice client.
    voiceClient = createVoiceClient(serverUrl, token);

    // Switch to the main screen.
    connectScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
  } catch (err) {
    if (err instanceof ConnectError) {
      showConnectError(err.message);
    } else {
      showConnectError("Could not connect. Check the server URL and secret.");
    }
  }
});

talkButton.addEventListener("click", async () => {
  if (!voiceClient) return;

  if (!voiceClient.recording) {
    try {
      await voiceClient.start();
      talkButton.textContent = "Listening… tap to stop";
      talkButton.classList.add("recording");
    } catch {
      showStatus("Microphone access denied.", "err");
    }
  } else {
    talkButton.disabled = true;
    talkButton.textContent = "Thinking…";
    talkButton.classList.remove("recording");

    try {
      const replyBlob = await voiceClient.stop();
      audioPlayer.src = URL.createObjectURL(replyBlob);
      await audioPlayer.play();
      showStatus("Reply received.", "ok");
    } catch (err) {
      const msg =
        err instanceof VoiceError ? err.message : "Voice turn failed.";
      showStatus(msg, "err");
    } finally {
      talkButton.disabled = false;
      talkButton.textContent = "Tap to talk";
    }
  }
});

function showConnectError(message: string) {
  connectError.textContent = message;
  connectError.classList.remove("hidden");
}

function showStatus(text: string, kind: "ok" | "err") {
  statusLine.textContent = text;
  statusLine.className = `status-line ${kind}`;
}

// Register the service worker for installability (PWA requirement).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // SW registration failure is non-fatal — the app still works, just
    // isn't installable.
  });
}
