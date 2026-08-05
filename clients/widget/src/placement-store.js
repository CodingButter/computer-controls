import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where the user put the face, remembered between runs.
 *
 * A widget that forgot its position every launch would be one the user moves
 * every launch, and a face that reappears in the corner it was dragged out of
 * is a face that ignores what it was told. So the drag is written down.
 *
 * What is written is deliberately tiny and deliberately not a preference file:
 * two numbers and a snap intention, no window size, no theme, nothing a future
 * feature would be tempted to smuggle in beside it. This process draws; the one
 * thing it knows that nobody else does is where it was dragged.
 *
 * Every failure here is silent and lands on "you put me": an absent file is a
 * first run, an unreadable one is a disk that will be complained about
 * elsewhere, and a corrupt one is a file somebody edited by hand. None of them
 * is a reason for the face not to appear.
 */

const HORIZONTAL = ["left", "center", "right"];
const VERTICAL = ["top", "middle", "bottom"];

/** @typedef {import("./window-shape.js").SnapZone} SnapZone */
/** @typedef {{ x: number, y: number, zone: SnapZone }} StoredPlacement */

/**
 * Read a stored placement out of text, refusing anything that is not one.
 *
 * @param {string} raw
 * @returns {StoredPlacement | null}
 */
export function decodePlacement(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { x, y, zone } = parsed;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // An unrecognised zone name is not an error and not a guess: it is a face
  // that was placed freely, which is the state that trusts the stored
  // coordinates least and clamps them onto the screen.
  return /** @type {StoredPlacement} */ ({
    x,
    y,
    zone: {
      h: HORIZONTAL.includes(zone?.h) ? zone.h : null,
      v: VERTICAL.includes(zone?.v) ? zone.v : null,
    },
  });
}

/**
 * @param {{ x: number, y: number, zone?: SnapZone }} placement
 * @returns {string}
 */
export function encodePlacement(placement) {
  return JSON.stringify({
    x: placement.x,
    y: placement.y,
    zone: { h: placement.zone?.h ?? null, v: placement.zone?.v ?? null },
  });
}

/**
 * @param {string} file
 * @returns {StoredPlacement | null}
 */
export function readPlacement(file) {
  try {
    return decodePlacement(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {{ x: number, y: number, zone?: SnapZone }} placement
 */
export function writePlacement(file, placement) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encodePlacement(placement));
  } catch {
    // A face that could not write down where it was dragged is still a face.
  }
}
