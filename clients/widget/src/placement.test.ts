import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  HEIGHT,
  SNAP_ZONE_PX,
  WIDTH,
  dragPlacement,
  readDragRequest,
  restorePlacement,
  snapZoneFor,
  stageFor,
} from "./window-shape.js";
import { decodePlacement, readPlacement, writePlacement } from "./placement-store.js";

/**
 * Where a dragged face ends up, decided without a screen.
 *
 * The arithmetic of dragging, snapping, and remembering is deliberately in
 * plain modules rather than inside the Electron handler that calls them, for
 * the same reason the rest of this suite is source-level: these are the parts
 * that can be wrong in ways nobody notices until a face is stuck off the
 * bottom of a monitor that is no longer plugged in, and they can all be
 * checked on a machine with no display at all.
 *
 * The work areas below are Electron `workArea` rectangles: origin *and* size,
 * because a second monitor does not start at zero.
 */

/** The primary display, as Electron reports it. */
const primary = { x: 0, y: 0, width: 1920, height: 1080 };

/** A second monitor to the left of it, which is where negative coordinates come from. */
const leftOfPrimary = { x: -1920, y: 0, width: 1920, height: 1080 };

describe("dragging the face", () => {
  test("without shift, the face lands exactly where it was let go", () => {
    const placement = dragPlacement(primary, { x: 640, y: 400 }, false);
    expect(placement).toEqual({ x: 640, y: 400, zone: { h: null, v: null } });
  });

  test("without shift, an edge is not a magnet", () => {
    // Two pixels off the left edge is a placement, not a failed snap. Snapping
    // a drag nobody asked to snap would make precise placement impossible.
    const placement = dragPlacement(primary, { x: 2, y: 300 }, false);
    expect(placement.x).toBe(2);
    expect(placement.zone).toEqual({ h: null, v: null });
  });

  test("shift near an edge hugs it, and leaves the other axis alone", () => {
    const placement = dragPlacement(primary, { x: 10, y: 620 }, true);
    expect(placement.x).toBe(0);
    // A face snapped to the left edge is still at the height it was dragged to.
    expect(placement.y).toBe(620);
    expect(placement.zone).toEqual({ h: "left", v: null });
  });

  test("shift near a corner takes both axes", () => {
    const bottomRight = dragPlacement(
      primary,
      { x: primary.width - WIDTH - 12, y: primary.height - HEIGHT - 9 },
      true,
    );
    expect(bottomRight).toEqual({
      x: primary.width - WIDTH,
      y: primary.height - HEIGHT,
      zone: { h: "right", v: "bottom" },
    });
  });

  test("shift near the middle centres the face", () => {
    const centre = dragPlacement(
      primary,
      { x: (primary.width - WIDTH) / 2 + 8, y: (primary.height - HEIGHT) / 2 - 8 },
      true,
    );
    expect(centre.x).toBe(Math.round((primary.width - WIDTH) / 2));
    expect(centre.y).toBe(Math.round((primary.height - HEIGHT) / 2));
    expect(centre.zone).toEqual({ h: "center", v: "middle" });
  });

  test("shift released outside every zone is free placement", () => {
    // The issue's release valve: holding shift does not mean the face has to
    // end up somewhere it was not put.
    const point = { x: SNAP_ZONE_PX * 4, y: SNAP_ZONE_PX * 4 };
    const placement = dragPlacement(primary, point, true);
    expect(placement).toEqual({ ...point, zone: { h: null, v: null } });
    expect(snapZoneFor(primary, point)).toEqual({ h: null, v: null });
  });

  test("the whole window stays on the work area", () => {
    // A frameless, taskbar-less face dragged off the bottom of the screen is a
    // face with nothing left to grab. The clamp is the way back.
    const offBottomRight = dragPlacement(primary, { x: 5000, y: 5000 }, false);
    expect(offBottomRight.x).toBe(primary.width - WIDTH);
    expect(offBottomRight.y).toBe(primary.height - HEIGHT);

    const offTopLeft = dragPlacement(primary, { x: -900, y: -900 }, false);
    expect(offTopLeft.x).toBe(0);
    expect(offTopLeft.y).toBe(0);
  });

  test("a second monitor is a place, not an error", () => {
    // Displays left of or above the primary sit at negative coordinates, and a
    // clamp written against a screen that starts at zero would yank the face
    // back onto the primary display every time it was dragged across.
    const placement = dragPlacement(leftOfPrimary, { x: -1200, y: 500 }, false);
    expect(placement.x).toBe(-1200);

    const snapped = dragPlacement(leftOfPrimary, { x: -1900, y: 20 }, true);
    expect(snapped).toEqual({ x: -1920, y: 0, zone: { h: "left", v: "top" } });

    const right = dragPlacement(leftOfPrimary, { x: -400, y: 500 }, true);
    expect(right.x).toBe(leftOfPrimary.x + leftOfPrimary.width - WIDTH);
  });
});

describe("what the page is allowed to say about a drag", () => {
  test("a distance and a modifier, and nothing else", () => {
    expect(readDragRequest({ phase: "begin", dx: 0, dy: 0, snap: false })).toEqual({
      phase: "begin",
      dx: 0,
      dy: 0,
      snap: false,
    });
    // Negative deltas are ordinary: the face was dragged up and to the left.
    expect(readDragRequest({ phase: "move", dx: -40, dy: -12, snap: true })).toEqual({
      phase: "move",
      dx: -40,
      dy: -12,
      snap: true,
    });
  });

  test("refuses anything that would move the window somewhere unfindable", () => {
    const refused = [
      undefined,
      null,
      "over there",
      { phase: "move", dx: Number.NaN, dy: 0 },
      { phase: "move", dx: 0, dy: Number.POSITIVE_INFINITY },
      { phase: "move", dx: "10", dy: 10 },
      { phase: "teleport", dx: 10, dy: 10 },
      { dx: 10, dy: 10 },
    ];
    for (const request of refused) {
      expect(readDragRequest(request), JSON.stringify(request) ?? "undefined").toBeNull();
    }
  });
});

describe("where the face opens next time", () => {
  test("a remembered snap is recomputed, not replayed", () => {
    // The corner is the intention; the pixels that meant the corner on a 1080p
    // monitor mean the middle of a 4K one.
    const stored = { x: 1560, y: 820, zone: { h: "right" as const, v: "bottom" as const } };
    const bigger = { x: 0, y: 0, width: 3840, height: 2160 };
    expect(restorePlacement(bigger, stored)).toEqual({
      x: 3840 - WIDTH,
      y: 2160 - HEIGHT,
    });
  });

  test("a remembered free position is kept, and pulled back onto the screen", () => {
    const stored = { x: 700, y: 300, zone: { h: null, v: null } };
    expect(restorePlacement(primary, stored)).toEqual({ x: 700, y: 300 });

    // The monitor it was left on is gone, or got smaller.
    const small = { x: 0, y: 0, width: 1280, height: 720 };
    const rescued = restorePlacement(small, { x: 1800, y: 1000, zone: { h: null, v: null } });
    expect(rescued.x).toBe(1280 - WIDTH);
    expect(rescued.y).toBe(720 - HEIGHT);
  });
});

describe("the stage the face opens on", () => {
  // The reconciliation between two features that arrived a day apart: the
  // window became the whole display, and the face became something the user
  // drags around. Both are true at once, and the stage is where they meet — it
  // picks the desk and the spot on it from the same reading of the display.

  test("a remembered spot opens on the display it is resolved against", () => {
    const secondMonitor = {
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1920, y: 32, width: 2560, height: 1408 },
    };
    const stored = { x: 2600, y: 700, zone: { h: null as null, v: null as null } };

    const stage = stageFor(secondMonitor, stored);

    // The window is still the whole display, and the face is where it was left
    // rather than in the default corner.
    expect({ x: stage.x, width: stage.width }).toEqual({ x: 1920, width: 2560 });
    expect(stage.orb).toEqual({ x: 2600, y: 700 });
  });

  test("a remembered corner is still a corner on a different-sized desk", () => {
    const smaller = {
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      workArea: { x: 0, y: 0, width: 1280, height: 720 },
    };
    const stored = { x: 3400, y: 1900, zone: { h: "right" as const, v: "bottom" as const } };

    // Replayed as pixels this lands far off a 1280x720 screen. Resolved as an
    // intention it is the bottom-right corner, which is what the user meant.
    expect(stageFor(smaller, stored).orb).toEqual({ x: 1280 - WIDTH, y: 720 - HEIGHT });
  });

  test("nothing remembered is the default corner, in screen coordinates", () => {
    const offset = {
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
    };

    // A monitor to the left of the primary sits at negative coordinates, and a
    // default corner computed in work-area space and never lifted into screen
    // space would put the face on the wrong monitor entirely.
    const { orb } = stageFor(offset, "corner");
    expect(orb.x).toBeLessThan(0);
    expect(orb.x).toBe(-1920 + Math.max(0, 1920 - WIDTH - 24));
  });
});

describe("remembering across a restart", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "widget-placement-"));
    file = path.join(dir, "state", "placement.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a drag written down is the drag read back", () => {
    const placement = dragPlacement(primary, { x: 1550, y: 815 }, true);
    writePlacement(file, placement);

    const restored = readPlacement(file);
    expect(restored).toEqual({ x: placement.x, y: placement.y, zone: placement.zone });
    // And the whole way round: what comes back off disk places the window where
    // it was left.
    expect(restorePlacement(primary, restored!)).toEqual({ x: placement.x, y: placement.y });
  });

  test("a first run has no file, and that is not a failure", () => {
    expect(readPlacement(path.join(dir, "nothing-here.json"))).toBeNull();
  });

  test("a file that is not a placement is treated as no placement", () => {
    for (const contents of ["", "{", "null", '"corner"', "[1,2]", '{"x":"left","y":3}', '{"x":1}']) {
      expect(decodePlacement(contents), contents).toBeNull();
    }
  });

  test("an unrecognised snap name means free placement, never a guess", () => {
    // Somebody edited the file, or a future version wrote a zone this one does
    // not know. The coordinates are still usable; the name is not.
    const decoded = decodePlacement('{"x":40,"y":50,"zone":{"h":"portside","v":"top"}}');
    expect(decoded).toEqual({ x: 40, y: 50, zone: { h: null, v: "top" } });
  });

  test("a placement survives a file written by hand with no zone at all", () => {
    writeFileSync(path.join(dir, "bare.json"), '{"x":12,"y":34}');
    expect(readPlacement(path.join(dir, "bare.json"))).toEqual({
      x: 12,
      y: 34,
      zone: { h: null, v: null },
    });
  });
});
