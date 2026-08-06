// The WebGL orb face: a three.js shader sphere rendered on a canvas.
//
// This module is the rendering layer — nothing else. It consumes the same
// state events the DOM orb consumes (idle / listening / thinking / speaking)
// and renders them as shader motion instead of CSS keyframes. It exposes
// setState / setLevel / setMood so the page can drive it without knowing
// anything about WebGL.
//
// The pure seams above the mount function are exported DOM-free and three.js-
// free so they can be tested in vitest without a browser or a GPU. three.js is
// loaded lazily via dynamic import inside mountWebGlOrb — it is never fetched
// on a browser that falls back to the DOM orb, and it is never resolved in a
// test environment.

/** Every state the orb can render. Matches the set in orb.js. */
export const ORB_STATES = ["idle", "listening", "thinking", "speaking"];

/**
 * Map an audio level [0..1] to vertex displacement amplitude.
 *
 * Level is clamped to range. A floor keeps idle from looking dead-flat — the
 * sphere always breathes, even at level zero.
 */
export function levelToDisplacement(level) {
  const clamped = Math.max(0, Math.min(1, level));
  return 0.02 + clamped * 0.18;
}

/**
 * Map orb state to shader behavior parameters.
 *
 * State is motion: each state gets its own noise speed, spatial scale, and
 * pulse frequency. Unknown states fall back to idle rather than rendering
 * something the hub never said.
 */
export function stateToParams(state) {
  // `energy` is the one number the whole scene breathes with: it scales how
  // fast the wisps churn, how fast the smoke swirls, and how fast the sphere
  // turns. Idle is barely moving; listening stirs; thinking runs hot;
  // speaking sits between, because its life comes from the level pulse.
  const params = {
    idle: { noiseSpeed: 0.25, noiseScale: 1.2, pulseFreq: 0.0, energy: 0.3 },
    listening: { noiseSpeed: 0.9, noiseScale: 1.8, pulseFreq: 1.5, energy: 1.0 },
    thinking: { noiseSpeed: 1.7, noiseScale: 2.4, pulseFreq: 0.0, energy: 1.6 },
    speaking: { noiseSpeed: 0.6, noiseScale: 1.1, pulseFreq: 3.0, energy: 1.2 },
  };
  return params[state] ?? params.idle;
}

/**
 * Map a mood label to an RGB color triplet [0..1].
 *
 * Mood drives color independently of state-driven motion (#106): the orb moves
 * according to what it is doing and is tinted according to how the person
 * sounded, and the two never have to agree.
 *
 * The palette follows #106 — red for frustration, green for excitement, blue
 * for calm — with neutral left as the orb's identity indigo. Calm is blue
 * rather than the purple the issue also offers, because purple is already what
 * resting looks like, and a calm orb that is indistinguishable from an orb with
 * nothing to say would be a colour carrying no information.
 *
 * An unknown label is neutral rather than an error. This function sits between
 * a classifier that may be replaced and a shader that must draw something, and
 * the resting colour is the honest thing to show when the label is not
 * understood.
 */
export function moodToColor(mood) {
  const colors = {
    neutral: [0.62, 0.3, 0.88],
    frustrated: [0.85, 0.25, 0.2],
    excited: [0.25, 0.78, 0.35],
    calm: [0.2, 0.5, 0.9],
  };
  return colors[mood] ?? colors.neutral;
}

/**
 * How fast the mood colour chases its target, per second.
 *
 * The reciprocal is the time constant: at 0.5 the orb covers about two thirds
 * of a colour change in two seconds and finishes over the following few. Slow
 * enough that the change reads as a drift rather than a switch.
 */
export const MOOD_EASE_PER_SECOND = 0.5;

/**
 * Feature-detect WebGL2 on a canvas-like object.
 *
 * Takes an object with a getContext method so it can be tested with a stub.
 * The caller must probe a THROWAWAY canvas, never the display canvas: a
 * canvas remembers its first context type forever, so probing the display
 * canvas with one kind of context makes three.js's later request for its
 * own kind fail with "existing context of a different type". WebGL2 is what
 * three r169 requires, so WebGL2 is what the probe asks for.
 * Returns false — not null or a throw — when WebGL is unavailable, so the
 * caller can treat it as a simple boolean gate.
 */
export function hasWebGl(canvas) {
  try {
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

/**
 * Synthesize a plausible audio level from state and elapsed time.
 *
 * Until #107's widget client provides real output amplitude via Web Audio,
 * the page feeds this into setLevel each frame. Each state has its own
 * cadence — speaking pulses fast, listening is gentle, thinking shimmers,
 * idle is near-silent.
 */
export function syntheticLevel(state, t) {
  switch (state) {
    case "speaking":
      return Math.abs(Math.sin(t * 0.008)) * 0.6 + Math.sin(t * 0.023) * 0.15;
    case "listening":
      return Math.sin(t * 0.003) * 0.12 + 0.12;
    case "thinking":
      return Math.sin(t * 0.015) * 0.06 + 0.04;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Shader source. Simplex noise is the Ashima Arts / Stefan Gustavson
// implementation (MIT), widely used in WebGL demos and stable across drivers.
// ---------------------------------------------------------------------------

const SIMPLEX_NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// uFlowTime is time-already-multiplied-by-energy, accumulated on the CPU each
// frame. Speed changes ease through the accumulator instead of multiplying an
// absolute clock, so a state change bends the motion rather than snapping it —
// uTime * newSpeed would teleport every noise field to a different phase.
const VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uFlowTime;
uniform float uLevel;
uniform float uNoiseScale;
uniform float uPulseFreq;

varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vPos;

${SIMPLEX_NOISE}

void main() {
  float n = snoise(position * uNoiseScale + vec3(uFlowTime));
  float pulse = sin(uTime * uPulseFreq) * 0.5 + 0.5;
  float displacement = n * uLevel + pulse * uLevel * 0.3;

  vec3 pos = position + normal * displacement;

  vNormal = normalize(normalMatrix * normal);
  vPos = position;
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = mvPos.xyz;

  gl_Position = projectionMatrix * mvPos;
}
`;

// The look is the concept art: a translucent glass shell whose interior is
// swirling ribbons of magenta, violet and cyan, brightest where they tangle.
// Three noise fields at different scales and drift directions, sharpened into
// bands, each carrying one of the three ribbon colors. The mood color tints
// the whole interior without owning it.
const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uFresnelPower;
uniform float uLevel;
uniform float uFlowTime;

varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vPos;

${SIMPLEX_NOISE}

void main() {
  vec3 viewDir = normalize(-vViewPos);
  float facing = abs(dot(vNormal, viewDir));
  float fresnel = pow(1.0 - facing, uFresnelPower);

  float t = uFlowTime * 0.3;
  float n1 = snoise(vPos * 2.2 + vec3(t, -t * 0.7, t * 0.4));
  float n2 = snoise(vPos * 3.1 + vec3(-t * 0.6, t, t * 0.8) + 11.0);
  float n3 = snoise(vPos * 1.6 + vec3(t * 0.5, t * 0.3, -t) + 47.0);

  float w1 = smoothstep(0.1, 0.7, n1);
  float w2 = smoothstep(0.15, 0.75, n2);
  float w3 = smoothstep(0.2, 0.8, n3);

  vec3 magenta = vec3(0.92, 0.25, 0.86);
  vec3 violet  = vec3(0.55, 0.32, 0.95);
  vec3 cyan    = vec3(0.30, 0.75, 0.95);

  vec3 wisps = magenta * w1 + violet * w2 + cyan * w3 * 0.65;
  float wispStrength = max(w1, max(w2, w3));

  // Lavender rim: the glass shell of the sphere.
  vec3 rim = vec3(0.78, 0.62, 1.0) * fresnel * 1.35;

  vec3 color = wisps * (0.55 + uLevel * 0.8) + rim;
  color *= mix(vec3(1.0), uColor * 1.7, 0.4);
  color += uColor * uLevel * 0.5;

  // Translucent center, luminous ribbons, bright shell.
  float alpha = clamp(0.16 + fresnel * 0.75 + wispStrength * 0.5, 0.0, 1.0);

  gl_FragColor = vec4(color, alpha);
}
`;

// The smoke that swirls around the orb: a larger shell whose surface is slow
// layered noise, edge-weighted so it reads as haze hugging the sphere rather
// than a second solid. It writes no depth and renders after the orb.
const SMOKE_VERTEX_SHADER = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vPos;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPos = position;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
}
`;

const SMOKE_FRAGMENT_SHADER = /* glsl */ `
uniform float uFlowTime;
uniform vec3 uColor;

varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vPos;

${SIMPLEX_NOISE}

void main() {
  vec3 viewDir = normalize(-vViewPos);
  float facing = abs(dot(vNormal, viewDir));

  // Swirl: the sampling space itself twists around the vertical axis, with
  // the twist angle varying by height, so the haze visibly churns rather
  // than merely drifting. Flow time carries the state's energy, so the churn
  // slows to a drift in idle and races while the orb is thinking.
  float ang = uFlowTime * 0.4 + vPos.y * 1.8;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec3 p = vPos;
  p.xz = rot * p.xz;

  float t = uFlowTime * 0.32;
  float s1 = snoise(p * 1.3 + vec3(t, t * 0.6, -t * 0.8));
  float s2 = snoise(p * 2.6 - vec3(t * 0.7, -t, t * 0.5) + 23.0);
  float smoke = smoothstep(-0.25, 0.75, s1 * 0.7 + s2 * 0.5);

  // Haze is heaviest at the silhouette and thins face-on, so the orb and
  // its M stay readable through it.
  float shell = pow(1.0 - facing, 1.0);

  vec3 haze = mix(vec3(0.42, 0.22, 0.7), vec3(0.85, 0.3, 0.8), s2 * 0.5 + 0.5);
  haze = mix(haze, uColor * 1.3, 0.3);

  float alpha = smoke * shell * 0.65;
  gl_FragColor = vec4(haze, alpha);
}
`;

/**
 * Mount the WebGL orb on a canvas.
 *
 * three.js is imported dynamically so it is never loaded on a browser without
 * WebGL and never resolved in a test. Returns a controller with setState /
 * setLevel / setMood / tick / dispose — the page drives it, the module
 * renders.
 *
 * @param {{ canvas: HTMLCanvasElement, reducedMotion?: boolean }} opts
 * @returns {Promise<{ setState: (s: string) => void, setLevel: (l: number) => void, setMood: (c: string) => void, tick: (now: number) => void, dispose: () => void }>}
 */
export async function mountWebGlOrb({ canvas, reducedMotion = false }) {
  // A relative specifier, not the bare "three": both pages that wear this face
  // keep the vendored build at ./vendor/ beside this file, and a relative path
  // needs no import map. The bare specifier did — and the widget's page loaded
  // its map from an external file, which Chromium silently ignores, so the
  // shader never mounted there and nobody was told. One spelling that works
  // everywhere beats a mapping that has to be carried correctly by every page.
  const THREE = await import("./vendor/three.module.js");

  const motionScale = reducedMotion ? 0.2 : 1.0;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(520, 520, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  // Pulled back so the smoke shell around the sphere stays in frame while
  // the sphere itself keeps roughly its old on-screen size.
  camera.position.z = 4.3;

  const geometry = new THREE.IcosahedronGeometry(1, 5);

  const params = stateToParams("idle");
  const uniforms = {
    uTime: { value: 0 },
    uFlowTime: { value: 0 },
    uLevel: { value: levelToDisplacement(0) },
    uNoiseScale: { value: params.noiseScale },
    uPulseFreq: { value: params.pulseFreq * motionScale },
    uColor: { value: new THREE.Vector3(...moodToColor("neutral")) },
    uFresnelPower: { value: 2.0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 0;
  scene.add(mesh);

  // The smoke shell, sharing the orb's mood color uniform so the haze
  // follows the conversation the way the sphere does.
  const smokeGeometry = new THREE.IcosahedronGeometry(1.55, 4);
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: { uFlowTime: uniforms.uFlowTime, uColor: uniforms.uColor },
    vertexShader: SMOKE_VERTEX_SHADER,
    fragmentShader: SMOKE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });
  const smoke = new THREE.Mesh(smokeGeometry, smokeMaterial);
  smoke.renderOrder = 1;
  scene.add(smoke);

  // Subtle idle drift — the sphere slowly rotates so the fresnel edge is
  // never perfectly still, even at zero level.
  mesh.rotation.x = 0.2;

  let moodTarget = [...moodToColor("neutral")];
  let lastTime = 0;
  // Eased-toward targets: energy follows the state, displayLevel follows the
  // voice. Both smooth on the CPU so a state flip or a loud syllable bends
  // the motion instead of snapping it.
  let energyTarget = params.energy;
  let energy = params.energy;
  let rawLevel = 0;
  let displayLevel = 0;

  /** @param {string} state */
  function setState(state) {
    const p = stateToParams(state);
    energyTarget = p.energy;
    uniforms.uNoiseScale.value = p.noiseScale;
    uniforms.uPulseFreq.value = p.pulseFreq * motionScale;
  }

  /** @param {number} level */
  function setLevel(level) {
    rawLevel = Math.max(0, Math.min(1, level));
  }

  /** @param {string} mood */
  function setMood(mood) {
    moodTarget = moodToColor(mood);
  }

  /** @param {number} now — performance.now() timestamp */
  function tick(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    uniforms.uTime.value += dt;

    // Energy eases toward the state's target, and the voice adds on top —
    // a loud syllable stirs everything, not just the surface.
    energy += (energyTarget - energy) * Math.min(1, dt * 4);
    // Fast attack, slow release: the swell jumps with a syllable and relaxes
    // after it, which is what breathing looks like and averaging does not.
    const chase = rawLevel > displayLevel ? 18 : 5;
    displayLevel += (rawLevel - displayLevel) * Math.min(1, dt * chase);

    uniforms.uFlowTime.value += dt * (0.25 + energy * 0.85 + displayLevel * 0.9) * motionScale;
    uniforms.uLevel.value = levelToDisplacement(displayLevel) * motionScale;

    // The whole body swells with the voice, smoke a beat behind the sphere.
    mesh.scale.setScalar(1 + displayLevel * 0.1 * motionScale);
    smoke.scale.setScalar(1 + displayLevel * 0.06 * motionScale);

    // Tween mood color toward target — smooth transitions, never a hard cut.
    // Rate is per second, not per frame: a fixed per-frame fraction would make
    // the orb change mood two and a half times faster on a 144Hz monitor than
    // on a 60Hz one, and "eases over seconds" has to mean seconds. This is much
    // slower than the motion easing above it on purpose — the orb is weather,
    // not a status LED, and a colour that arrives before you noticed it moving
    // is the second thing.
    const moodStep = Math.min(1, dt * MOOD_EASE_PER_SECOND);
    const c = uniforms.uColor.value;
    c.x += (moodTarget[0] - c.x) * moodStep;
    c.y += (moodTarget[1] - c.y) * moodStep;
    c.z += (moodTarget[2] - c.z) * moodStep;

    // Rotation rides the same energy: a lazy idle turn, a quick thinking one.
    mesh.rotation.y += dt * (0.05 + energy * 0.13) * motionScale;
    // The smoke turns against the sphere, so the two layers visibly slide.
    smoke.rotation.y -= dt * (0.06 + energy * 0.15) * motionScale;
    smoke.rotation.z += dt * (0.02 + energy * 0.05) * motionScale;

    renderer.render(scene, camera);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    smokeGeometry.dispose();
    smokeMaterial.dispose();
    renderer.dispose();
  }

  return { setState, setLevel, setMood, tick, dispose };
}
