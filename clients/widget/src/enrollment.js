/**
 * The enrollment surface: tune the wake-word fingerprint to the user's own
 * voice.
 *
 * The page owns the recording (it is the one document with a microphone), the
 * scoring (wake-score.js is pure), and the DOM; the shell owns the filesystem.
 * This module is the glue between them, and it names no audio, network, or
 * storage API of its own — the capture lives in ears.js, the persistence
 * crosses the bridge as a fire-and-forget send. A test that scans the shipped
 * source for "ways to open an ear" finds none here.
 *
 * The surface claims the pointer while it is open, the same way the right-click
 * menu does, because the window is click-through except over shapes it drew.
 */

import { CAPTURE_RATE, enrollTake } from "./ears.js";
import { assembleTemplates } from "./wake-score.js";

/** The phrase the user says for each take. */
export const ENROLL_PHRASE = "hey mastra";

/** How many takes the enrollment collects before offering Save. */
export const TARGET_TAKES = 3;

/**
 * Wire the enrollment overlay.
 *
 * @param {HTMLElement} root — the #enrollment element
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean }}
 */
export function createEnrollment(root) {
  const phraseEl = root.querySelector("[data-enroll-phrase]");
  const takesEl = root.querySelector("[data-enroll-takes]");
  const saveBtn = root.querySelector("[data-enroll-save]");
  const skipBtn = root.querySelector("[data-enroll-skip]");

  let takes = [];
  let open = false;

  if (phraseEl) phraseEl.textContent = ENROLL_PHRASE;

  function buildTakeSlots() {
    takesEl.replaceChildren();
    for (let i = 0; i < TARGET_TAKES; i += 1) {
      const row = document.createElement("div");
      row.className = "enroll-take";

      const label = document.createElement("span");
      label.className = "enroll-label";
      label.textContent = `Take ${i + 1}`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "enroll-record";
      btn.textContent = "Record";
      btn.addEventListener("click", () => recordTake(i));

      const score = document.createElement("span");
      score.className = "enroll-score";
      score.textContent = "—";

      row.append(label, btn, score);
      takesEl.append(row);
    }
  }

  function updateScores(scores) {
    const scoreEls = takesEl.querySelectorAll(".enroll-score");
    scoreEls.forEach((el, i) => {
      el.textContent = i < scores.length ? scores[i].toFixed(2) : "—";
    });
  }

  function setButtonsDisabled(disabled) {
    takesEl.querySelectorAll(".enroll-record").forEach((b) => {
      b.disabled = disabled;
    });
  }

  async function recordTake(slot) {
    if (!open) return;
    setButtonsDisabled(true);
    saveBtn.disabled = true;

    try {
      const samples = await enrollTake();
      // Re-recording a slot truncates everything after it, so the scores
      // always reflect the current sequence of takes.
      takes = takes.slice(0, slot);
      takes.push(samples);
      const { scores } = assembleTemplates(takes, {
        phrase: ENROLL_PHRASE,
        sampleRate: CAPTURE_RATE,
      });
      updateScores(scores);
      if (takes.length >= TARGET_TAKES) saveBtn.disabled = false;
    } finally {
      setButtonsDisabled(false);
    }
  }

  function open() {
    takes = [];
    buildTakeSlots();
    saveBtn.disabled = true;
    root.classList.remove("hidden");
    open = true;
    // Claim the pointer the same way the right-click menu does: the window is
    // click-through except over shapes it drew, so the overlay must say "I am
    // here" or its buttons fall through the floor.
    window.widget.setPointerOverShape(true);
  }

  function close() {
    open = false;
    root.classList.add("hidden");
    window.widget.setPointerOverShape(false);
  }

  function save() {
    if (takes.length === 0) {
      close();
      return;
    }
    const { templates } = assembleTemplates(takes, {
      phrase: ENROLL_PHRASE,
      sampleRate: CAPTURE_RATE,
    });
    window.widget.writeWakeTemplates({ templates, enrolled: true });
    close();
  }

  saveBtn.addEventListener("click", save);
  skipBtn.addEventListener("click", close);

  return { open, close, isOpen: () => open };
}
