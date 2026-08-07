/**
 * The operating threshold: a weighted DTW distance at or below this is the
 * wake phrase. The VALUE is not a guess — it was chosen by the Phase 2
 * calibration sweep (.mastracode/plans/fingerprint-wake.proof/calibration.txt)
 * as the operating point where Jamie's real recording matches on factory-only
 * templates, held-out synthetic voices match at >=90%, and the full negative
 * set (near-misses included) produces zero false accepts in BOTH the
 * factory-only and factory-plus-enrolled configurations.
 */
export const DEFAULT_WAKE_THRESHOLD = 0.42;
/**
 * The ONE home of the enrolled-template weight. An enrolled template's
 * distance is divided by this before the threshold comparison, so the owner's
 * own voice clears the bar sooner than a stranger's. The value rode the same
 * calibration sweep as the threshold (a grid of candidate weights alongside
 * candidate thresholds — the weight trades the owner's recall against false
 * accepts, and both configurations had to pass); the chosen pair is recorded
 * in calibration.txt. The `enrolled: true` marker some stores carry is
 * documentation; THIS constant is the authority.
 */
export const ENROLLED_WAKE_WEIGHT = 1.15;
const FRAME_MS = 25;
const HOP_MS = 10;
const PRE_EMPHASIS = 0.97;
const MEL_FILTERS = 26;
const CEPSTRAL_COEFFICIENTS = 13;
/** Sakoe-Chiba: the matched query span may deviate this far from template length. */
const BAND_RATIO = 0.25;
/** Hz -> mel (HTK convention). */
function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel) {
    return 700 * (10 ** (mel / 2595) - 1);
}
/**
 * In-place iterative radix-2 FFT. Implemented here because the browser has no
 * FFT and this module may not grow a dependency: the whole live cluster ships
 * as plain emitted files a page loads directly.
 */
function fft(real, imag) {
    const n = real.length;
    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = real[i];
            real[i] = real[j];
            real[j] = tr;
            const ti = imag[i];
            imag[i] = imag[j];
            imag[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curR = 1;
            let curI = 0;
            for (let j = 0; j < len / 2; j++) {
                const aR = real[i + j];
                const aI = imag[i + j];
                const bR = real[i + j + len / 2] * curR - imag[i + j + len / 2] * curI;
                const bI = real[i + j + len / 2] * curI + imag[i + j + len / 2] * curR;
                real[i + j] = aR + bR;
                imag[i + j] = aI + bI;
                real[i + j + len / 2] = aR - bR;
                imag[i + j + len / 2] = aI - bI;
                const nextR = curR * wr - curI * wi;
                curI = curR * wi + curI * wr;
                curR = nextR;
            }
        }
    }
}
function nextPowerOfTwo(n) {
    let p = 1;
    while (p < n)
        p <<= 1;
    return p;
}
/**
 * MFCC features for one utterance: 25ms frames on a 10ms hop, pre-emphasis,
 * Hann window, power FFT, 26 mel filters, log, DCT-II down to 13 cepstral
 * coefficients — c0 dropped, per-frame log-energy appended in its place, and
 * per-utterance cepstral mean normalization over every dimension. CMN is the
 * cheap channel robustness: it is the difference between a TTS render and a
 * room microphone agreeing about the same phrase.
 *
 * Returns one Float32Array of length 13 per frame. An utterance shorter than
 * a single frame returns no frames.
 */
export function mfcc(samples, sampleRate) {
    const frameLength = Math.round((sampleRate * FRAME_MS) / 1000);
    const hopLength = Math.round((sampleRate * HOP_MS) / 1000);
    if (samples.length < frameLength)
        return [];
    const fftSize = nextPowerOfTwo(frameLength);
    const bins = fftSize / 2 + 1;
    // Hann window, computed once per call.
    const window = new Float64Array(frameLength);
    for (let i = 0; i < frameLength; i++) {
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameLength - 1));
    }
    // Triangular mel filterbank over the power spectrum, 0 Hz to Nyquist.
    const melLow = hzToMel(0);
    const melHigh = hzToMel(sampleRate / 2);
    const melPoints = new Float64Array(MEL_FILTERS + 2);
    for (let i = 0; i < melPoints.length; i++) {
        melPoints[i] = melToHz(melLow + ((melHigh - melLow) * i) / (MEL_FILTERS + 1));
    }
    const binOf = (hz) => Math.floor(((fftSize + 1) * hz) / sampleRate);
    const frameCount = Math.floor((samples.length - frameLength) / hopLength) + 1;
    const frames = [];
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    const power = new Float64Array(bins);
    const melEnergies = new Float64Array(MEL_FILTERS);
    for (let f = 0; f < frameCount; f++) {
        const start = f * hopLength;
        real.fill(0);
        imag.fill(0);
        let energy = 0;
        for (let i = 0; i < frameLength; i++) {
            const s = samples[start + i] / 32768;
            const prev = i > 0 ? samples[start + i - 1] / 32768 : start > 0 ? samples[start - 1] / 32768 : 0;
            const emphasized = s - PRE_EMPHASIS * prev;
            energy += emphasized * emphasized;
            real[i] = emphasized * window[i];
        }
        fft(real, imag);
        for (let i = 0; i < bins; i++) {
            power[i] = (real[i] * real[i] + imag[i] * imag[i]) / fftSize;
        }
        for (let m = 0; m < MEL_FILTERS; m++) {
            const left = binOf(melPoints[m]);
            const center = binOf(melPoints[m + 1]);
            const right = binOf(melPoints[m + 2]);
            let sum = 0;
            for (let k = left; k < center; k++) {
                if (center > left)
                    sum += power[k] * ((k - left) / (center - left));
            }
            for (let k = center; k < right; k++) {
                if (right > center)
                    sum += power[k] * ((right - k) / (right - center));
            }
            melEnergies[m] = Math.log(sum + 1e-10);
        }
        // DCT-II: 26 log-mel energies down to 13 coefficients; drop c0 (overall
        // loudness, which the appended log-energy carries more honestly).
        const out = new Float32Array(CEPSTRAL_COEFFICIENTS);
        for (let c = 1; c < CEPSTRAL_COEFFICIENTS; c++) {
            let sum = 0;
            for (let m = 0; m < MEL_FILTERS; m++) {
                sum += melEnergies[m] * Math.cos((Math.PI * c * (m + 0.5)) / MEL_FILTERS);
            }
            out[c - 1] = sum;
        }
        out[CEPSTRAL_COEFFICIENTS - 1] = Math.log(energy + 1e-10);
        frames.push(out);
    }
    // Per-utterance cepstral mean normalization, every dimension.
    const mean = new Float64Array(CEPSTRAL_COEFFICIENTS);
    for (const frame of frames) {
        for (let d = 0; d < CEPSTRAL_COEFFICIENTS; d++)
            mean[d] += frame[d];
    }
    for (let d = 0; d < CEPSTRAL_COEFFICIENTS; d++)
        mean[d] /= frames.length;
    for (const frame of frames) {
        for (let d = 0; d < CEPSTRAL_COEFFICIENTS; d++)
            frame[d] -= mean[d];
    }
    return frames;
}
function frameDistance(a, b) {
    let sum = 0;
    const dims = Math.min(a.length, b.length);
    for (let d = 0; d < dims; d++) {
        const diff = a[d] - b[d];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}
/**
 * Subsequence DTW: the normalized distance of the best-matching subsequence
 * of the query against the WHOLE template. Open start and open end on the
 * query axis — "hey mastra" mid-sentence is found where it is, not where a
 * fixed alignment expected it. A Sakoe-Chiba-style band (~±25%) rejects
 * pathological warps: any path whose matched query span drifts outside
 * ±25% of the template's progress is cut, which is both the stability and
 * the cost story. Distance is Euclidean per frame pair, normalized by path
 * length so long templates and short ones speak the same units.
 *
 * Returns Infinity when either side is empty or no banded path exists.
 */
export function subsequenceDtw(query, template) {
    const m = template.length;
    const n = query.length;
    if (m === 0 || n === 0)
        return Infinity;
    const INF = Infinity;
    // Rolling rows over the template axis: cost, path length, and the query
    // column where each path started (the band is measured against it).
    let cost = new Float64Array(n);
    let steps = new Float64Array(n);
    let start = new Int32Array(n);
    let prevCost = new Float64Array(n);
    let prevSteps = new Float64Array(n);
    let prevStart = new Int32Array(n);
    // Row 0: open start — a path may begin at any query column.
    for (let j = 0; j < n; j++) {
        prevCost[j] = frameDistance(template[0], query[j]);
        prevSteps[j] = 1;
        prevStart[j] = j;
    }
    const slack = 3; // A few frames of grace so short templates are not over-cut.
    for (let i = 1; i < m; i++) {
        for (let j = 0; j < n; j++) {
            const d = frameDistance(template[i], query[j]);
            let bestCost = INF;
            let bestSteps = 0;
            let bestStart = 0;
            // Candidate predecessors: diagonal, vertical (template advances,
            // query holds), horizontal (query advances, template holds).
            const candidates = j > 0
                ? [
                    [prevCost[j - 1], prevSteps[j - 1], prevStart[j - 1]],
                    [prevCost[j], prevSteps[j], prevStart[j]],
                    [cost[j - 1], steps[j - 1], start[j - 1]],
                ]
                : [[prevCost[j], prevSteps[j], prevStart[j]]];
            for (const [c, s, st] of candidates) {
                if (c === INF)
                    continue;
                // Band: the query span consumed so far must track the template's
                // progress within ±25% (plus slack).
                const span = j - st + 1;
                const lo = (i + 1) * (1 - BAND_RATIO) - slack;
                const hi = (i + 1) * (1 + BAND_RATIO) + slack;
                if (span < lo || span > hi)
                    continue;
                if (c < bestCost) {
                    bestCost = c;
                    bestSteps = s;
                    bestStart = st;
                }
            }
            if (bestCost === INF) {
                cost[j] = INF;
                steps[j] = 0;
                start[j] = j;
            }
            else {
                cost[j] = bestCost + d;
                steps[j] = bestSteps + 1;
                start[j] = bestStart;
            }
        }
        // Rotate rows.
        const tc = prevCost;
        prevCost = cost;
        cost = tc;
        const ts = prevSteps;
        prevSteps = steps;
        steps = ts;
        const tt = prevStart;
        prevStart = start;
        start = tt;
    }
    // Open end: the best full-template path may end at any query column, but
    // its total span must respect the band against the whole template.
    let best = INF;
    for (let j = 0; j < n; j++) {
        if (prevCost[j] === INF)
            continue;
        const span = j - prevStart[j] + 1;
        if (span < m * (1 - BAND_RATIO) - slack || span > m * (1 + BAND_RATIO) + slack)
            continue;
        const normalized = prevCost[j] / prevSteps[j];
        if (normalized < best)
            best = normalized;
    }
    return best;
}
/**
 * A WakeWordDetector backed by the template bank. `heard` computes the
 * utterance's MFCC once, scores it against every template by subsequence DTW,
 * divides each distance by that template's weight, and answers true when the
 * best effective distance clears the threshold. An empty bank never matches —
 * a widget whose templates failed to load is deaf, not trigger-happy.
 */
export function createFingerprintDetector(templates, options) {
    const threshold = options?.threshold ?? DEFAULT_WAKE_THRESHOLD;
    return {
        heard(utterance) {
            if (templates.length === 0)
                return false;
            const query = mfcc(utterance.samples, utterance.sampleRate);
            if (query.length === 0)
                return false;
            for (const template of templates) {
                const distance = subsequenceDtw(query, template.frames);
                const effective = distance / (template.weight ?? 1);
                if (effective <= threshold)
                    return true;
            }
            return false;
        },
        reset() {
            // Stateless by construction: every answer is a function of the one
            // utterance handed in. Nothing to forget.
        },
    };
}
