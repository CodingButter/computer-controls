import { describe, expect, it, vi } from "vitest";

import { createCaptureLifecycle, type CaptureControl } from "./capture-lifecycle.ts";

function makeCapture(): CaptureControl & { stopped: boolean } {
  return { stopped: false, stop() { this.stopped = true; } };
}

describe("test_a_face_arriving_does_not_open_the_gate", () => {
  it("starts capture when a face arrives, without closing the gate", () => {
    const capture = makeCapture();
    const startCapture = vi.fn(() => capture);
    const closeGate = vi.fn();
    const onFaceCount = createCaptureLifecycle({ startCapture, closeGate });

    onFaceCount(1);

    // A face arriving starts local capture.
    expect(startCapture).toHaveBeenCalledTimes(1);
    // The gate is not closed by a face arriving, and it is not opened here
    // either — that is the wake word's job. The handler owns capture only.
    expect(closeGate).not.toHaveBeenCalled();
  });
});

describe("test_the_last_face_leaving_stops_capture", () => {
  it("closes the gate and stops capture when the last face leaves", () => {
    const capture = makeCapture();
    const startCapture = vi.fn(() => capture);
    const closeGate = vi.fn();
    const onFaceCount = createCaptureLifecycle({ startCapture, closeGate });

    onFaceCount(1);
    onFaceCount(0);

    expect(closeGate).toHaveBeenCalledTimes(1);
    expect(capture.stopped).toBe(true);
  });

  it("starts capture once no matter how many faces arrive", () => {
    const capture = makeCapture();
    const startCapture = vi.fn(() => capture);
    const closeGate = vi.fn();
    const onFaceCount = createCaptureLifecycle({ startCapture, closeGate });

    onFaceCount(1);
    onFaceCount(2);
    onFaceCount(3);

    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("restarts capture if a new face arrives after everyone left", () => {
    const first = makeCapture();
    const second = makeCapture();
    const captures = [first, second];
    let n = 0;
    const startCapture = vi.fn(() => captures[n++] ?? makeCapture());
    const closeGate = vi.fn();
    const onFaceCount = createCaptureLifecycle({ startCapture, closeGate });

    onFaceCount(1);
    onFaceCount(0);
    onFaceCount(1);

    expect(first.stopped).toBe(true);
    expect(startCapture).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the count is already zero and nobody was watching", () => {
    const startCapture = vi.fn(makeCapture);
    const closeGate = vi.fn();
    const onFaceCount = createCaptureLifecycle({ startCapture, closeGate });

    onFaceCount(0);

    expect(startCapture).not.toHaveBeenCalled();
    expect(closeGate).not.toHaveBeenCalled();
  });
});
