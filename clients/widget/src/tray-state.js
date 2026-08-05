import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * How the user left the tray, remembered between runs.
 *
 * Two booleans: whether the face may hide itself after a quiet while, and
 * whether the widget is disabled outright. Both are the user's choices, made
 * in the tray menu, and a choice that reset itself every launch would not be
 * a choice — so they are written down beside `placement.json`, with the same
 * discipline placement-store established: every failure is silent and lands
 * on the defaults.
 *
 * The defaults are the product's posture, not an accident: auto-hide on
 * (a resident face that never left would be furniture) and disabled off
 * (a widget installed is a widget that works). An absent file is a first
 * run, a malformed one is a file somebody edited by hand, and both answers
 * are the same answer. That is also why a plain `writeFileSync` is enough
 * here — the worst corruption case of a two-boolean file is "defaults",
 * which is already the absent-file answer, so atomic-rename ceremony would
 * buy nothing.
 */

/** @typedef {{ autoHide: boolean, disabled: boolean }} TrayState */

export const DEFAULT_TRAY_STATE = Object.freeze({ autoHide: true, disabled: false });

/**
 * Read a stored tray state out of text, defaulting anything that is not one.
 *
 * Field by field rather than all-or-nothing: a file holding one recognisable
 * boolean and one piece of noise keeps the boolean. The user's surviving
 * choice is not forfeit because the other one got mangled.
 *
 * @param {string} raw
 * @returns {TrayState}
 */
export function decodeTrayState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRAY_STATE };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TRAY_STATE };
  return {
    autoHide:
      typeof parsed.autoHide === "boolean" ? parsed.autoHide : DEFAULT_TRAY_STATE.autoHide,
    disabled:
      typeof parsed.disabled === "boolean" ? parsed.disabled : DEFAULT_TRAY_STATE.disabled,
  };
}

/**
 * @param {TrayState} state
 * @returns {string}
 */
export function encodeTrayState(state) {
  return JSON.stringify({
    autoHide: Boolean(state.autoHide),
    disabled: Boolean(state.disabled),
  });
}

/**
 * @param {string} file
 * @returns {TrayState}
 */
export function readTrayState(file) {
  try {
    return decodeTrayState(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_TRAY_STATE };
  }
}

/**
 * @param {string} file
 * @param {TrayState} state
 */
export function writeTrayState(file, state) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encodeTrayState(state));
  } catch {
    // A tray that could not write down how it was set is still a tray.
  }
}
