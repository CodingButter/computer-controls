/**
 * The capture-lifecycle seam: who starts and stops the microphone.
 *
 * A face arriving is what starts local microphone capture, and the last face
 * leaving is what stops it. The gate itself is NOT opened here — that is the
 * wake word's job. This module owns only the capture lifecycle; the privacy
 * property (audio never leaves the machine while idle) is the gate's, and the
 * two are deliberately separate so that capture can run locally without the gate
 * ever forwarding a frame.
 */

export type CaptureControl = {
  /** Stop the microphone and release whatever it was holding. */
  stop(): void;
};

export type CaptureLifecycleDeps = {
  /** Start local capture. Called once when the first face arrives. */
  startCapture(): CaptureControl;
  /** Close the gate. Called when the last face leaves, before stopping capture. */
  closeGate(): void;
};

/**
 * Build a face-count handler that drives the microphone lifecycle.
 *
 * The returned function is wired to the orb's `onFaceCount` callback. It starts
 * capture when the count rises above zero (once, no matter how many faces), and
 * stops capture — closing the gate first — when the count returns to zero.
 */
export function createCaptureLifecycle(deps: CaptureLifecycleDeps): (faceCount: number) => void {
  let capture: CaptureControl | undefined;
  return (faceCount: number) => {
    if (faceCount > 0 && !capture) {
      capture = deps.startCapture();
      return;
    }
    if (faceCount === 0 && capture) {
      deps.closeGate();
      capture.stop();
      capture = undefined;
    }
  };
}
