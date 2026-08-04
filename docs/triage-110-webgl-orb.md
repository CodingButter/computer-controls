# Triage: issue #110 — The orb renders in WebGL: a three.js shader face over the same events

**Verdict: valid and actionable → planning.**

A rendering enhancement by the repo owner, building directly on the merged
orb PR (#105 → PR #109). The orb's face changes from a styled DOM button to a
three.js shader-driven sphere, while everything behind the face — the wake gate,
the mouth queue, the utterance bank, the live seam, the routes — stays untouched.
No WebGL or three.js code exists anywhere in the codebase today; no duplicate PR
has been opened.

## What changes, and what stays

**New surface:**
- A 3D scene: a sphere with a custom shader. Vertex displacement breathes with
  live audio level; fresnel edge glow; subtle idle drift. State becomes shader
  state: idle drift, wake ripple, speaking pulse by output amplitude, thinking
  shimmer.
- The orb as a mountable module owning its own canvas, exposing `setState(state)`
  and `setLevel(level)`. The orb page mounts it; #107's widget client mounts the
  same module later on a transparent canvas.
- Mood color (#106) as one shader uniform: emotion → color, tweened over time.
- Vendored three.js ES module served by the hub + an import map in the orb page.
  No bundler, no runtime CDN fetch (#103 doctrine).

**Untouched (confirmed against source):**
- `OrbEvent` union, `routes.ts` (SSE `/api/orb/events`, POST `/api/orb/gesture`,
  GET `/api/orb/status`), `orb.ts` (gate/mouth/brain wiring), the ear chain,
  the live session, the credentials path. The face is a consumer of the same
  state + caption events the current DOM orb already consumes.

## The audio-level question — resolved

The current event vocabulary is closed: `{type: "state"}` and `{type: "caption"}`
only (`orb.ts:35-37`). No audio-level event exists. The hub's speaker plays at
the OS audio layer (`index.ts:58`, deferred to #107), and the browser page
receives nothing but state + caption over SSE.

This is **not a blocker**. The acceptance test
`test_audio_level_drives_the_shader_displacement_uniform` is a module-internal
test: it verifies that calling `setLevel(n)` updates the shader's displacement
uniform. It does not require a live audio source to exist in the page's event
stream. The module API takes `setLevel` as a parameter; what feeds it is the
page's concern, not the module's.

For the orb page, `setLevel` can be driven by a client-side animation loop that
synthesizes a plausible level from the current state (e.g., rhythmic pulse during
`speaking`, gentle swell during `listening`, flat during `idle`/`thinking`). When
#107's widget client mounts the same module — with browser Web Audio API access
to the output stream — it feeds real amplitude. The module is ready either way.

## Architectural fit — confirmed against source

| Concern | Where it lands | Evidence |
|---|---|---|
| Module consumes same events | `interpret()` and `availability()` in `orb.js` are DOM-free seams; the WebGL module calls `setState`/`setLevel` from the same state events the current page already wires | `client/public/orb.js:29-56` |
| No bundler, raw ES modules | `ui.ts readUiAsset` serves static files verbatim; extensionless → `.html`; add three.js as a served `.js` + `<script type="importmap">` in `orb.html` | `client/src/ui.ts:27-41`, `client/public/orb.html:137` |
| Hub serves vendored three.js | Static dir already serves `/orb.js`, `/app.js`; add `/vendor/three.module.js` (or similar) to the same served directory | `client/src/ui.ts`, `client/public/` |
| Graceful floor (no-WebGL → DOM orb) | Feature-detect `canvas.getContext('webgl')` at mount; if absent, keep the current DOM orb markup. Decided in one place, stated once. | New code in the orb page |
| Mood color as shader uniform | Shader accepts a `uniform vec3 uMood`; #106's emotion label maps to a color tweened over time. Shader is ready before the classifier label exists. | #106 (OPEN, blocked on #105 which is merged) |
| State-by-motion stays law | Four states → four shader behaviors, same mapping the DOM orb's CSS animations encode today | `client/public/orb.html:45-66` |

## Vendoring three.js — the no-bundler constraint

three.js ships as an ES module (`three.module.js`, ~600KB minified). The doctrine
(#103, merged) forbids a bundler and a runtime CDN fetch. The plan must:

1. Vendor the single `three.module.js` file into the hub's served static dir.
2. Add an `<script type="importmap">` to `orb.html` mapping `"three"` to the
   served path, so the module imports `from "three"` resolves without a bundler.
3. Verify no `fetch()` to a CDN occurs at runtime (the fifth acceptance test).

## Named acceptance tests (from the issue)

All five are testable against the architecture as understood:

1. `test_the_orb_module_mounts_on_a_canvas_and_consumes_state_events`
2. `test_audio_level_drives_the_shader_displacement_uniform`
3. `test_the_vendored_three_module_is_served_by_the_hub_and_named_in_the_import_map`
4. `test_a_browser_without_webgl_falls_back_to_the_dom_orb`
5. `test_the_page_ships_no_bundler_and_no_runtime_cdn_fetch`

## Open decisions for planning (not blockers)

- **Shader complexity vs. file size.** A full PBR material is overkill; the spec
  calls for vertex displacement + fresnel + uniform color. Planning decides the
  shader's exact GLSL and how much of three.js's built-in material system to use
  vs. a custom `ShaderMaterial`.
- **three.js version + vendoring path.** Pin a specific version; decide the exact
  path under `client/public/` (e.g., `/vendor/three.module.js`).
- **Module shape.** The module is a mountable thing exposing `setState`/
  `setLevel`. Is it a plain JS module (constructor + methods, no framework), or
  something more structured? The orb page is raw ES modules with no framework,
  so a plain module matches the house style.
- **Synthetic level algorithm.** How the page derives `setLevel` values from
  state in the absence of real audio amplitude. Must look organic, not mechanical.
- **Reduced-motion floor.** The DOM orb honors `prefers-reduced-motion`. The
  WebGL orb must too — the shader should reduce to a static or minimal state.
