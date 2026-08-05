/**
 * The face state the shader speaks, from the state the widget speaks.
 *
 * Split from the renderer for the same reason paint.js is split from the state
 * machine: this is the pure half — no document, no WebGL — so it can be handed
 * a state object in a test. The renderer calls it inside paint(); the test calls
 * it with every transition the reducer can produce.
 *
 * The widget's vocabulary is presence + activity; the shader's is a single face
 * state (idle / listening / thinking / speaking). A hidden widget is idle — the
 * orb is off-screen, so what it does is rest. Visible, the activity is the face
 * state directly.
 *
 * @param {{ presence: string, activity: string }} state
 * @returns {string}
 */
export function shaderStateFor(state) {
  if (state.presence === "hidden") return "idle";
  return state.activity;
}
