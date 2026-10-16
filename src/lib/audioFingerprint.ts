// src/lib/audioFingerprint.ts
// The spectral fingerprint Choicer Voicer scores on, and the one comparison
// function that scores it.
//
// **One implementation, three callers, and that is the whole point of this
// file.** The browser fingerprints a player's take, the offline script
// (scripts/fingerprint-voiceline.mjs) fingerprints a reference clip, and the
// server compares the two. If any of them used a different FFT size, a
// different band layout or a different normalisation, the numbers would still
// *look* like fingerprints and would silently score nonsense — a mismatch here
// has no error to raise, only a leaderboard that means nothing. So the maths
// lives here and nowhere else.
//
// Client-safe: pure arithmetic, no DOM, no filesystem, no Web Audio. The
// browser hands it raw PCM; where that PCM came from is the caller's problem.
//
// It carries no secrets either, which is why it can be in the client bundle at
// all. A fingerprint is a lossy 384-number silhouette of a sound — it cannot be
// played back, and the *reference* fingerprint (the answer key) stays on the
// server. See src/server/voiceLibrary.ts.

/** Log-spaced frequency bands per frame. */
export const FINGERPRINT_BANDS = 16;

/**
 * Time slices across the whole take.
 *
 * Fixed rather than per-second, deliberately: the signal is stretched onto
 * exactly this many slices however long it ran, so somebody who delivers the
 * line slowly is compared against the reference *shape* rather than punished
 * for their timing. Getting the cadence right still helps — the slices are
 * proportional, so an early emphasis lands in an early slice either way.
 */
export const FINGERPRINT_FRAMES = 24;

/** Length of the flat array that goes over the wire. */
export const FINGERPRINT_LENGTH = FINGERPRINT_BANDS * FINGERPRINT_FRAMES;

/** Power-of-two window. 1024 @ 48kHz is ~21ms — a phoneme, roughly. */
const FFT_SIZE = 1024;

// Speech band. Below 80Hz is room rumble and handling noise; above 6kHz is
// sibilance and microphone character, which says more about the headset than
// about the impression.
const BAND_LOW_HZ = 80;
const BAND_HIGH_HZ = 6000;

/** Windows averaged per time slice, so a slice is not one arbitrary 21ms. */
const WINDOWS_PER_FRAME = 4;

/** Anything quieter than this fraction of the peak is treated as silence. */
const SILENCE_FLOOR = 0.02;

/**
 * How far the comparison will slide one fingerprint against the other, in
 * frames. Real impressions start a beat late — the player hears the cue, then
 * draws breath — and without this the whole take is scored against the wrong
 * part of the line. Two frames each way is about a tenth of the clip.
 */
const MAX_SHIFT_FRAMES = 2;

// ─── FFT ────────────────────────────────────────────────────────────────────
// Iterative radix-2 Cooley-Tukey, in place. Small enough to keep here rather
// than take a dependency the offline script would also have to install.

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Hann window, cached — it is the same 1024 numbers every call. */
let hann: Float64Array | null = null;
function hannWindow(): Float64Array {
  if (!hann) {
    hann = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }
  }
  return hann;
}

/** Bin index for each band edge, at this sample rate. */
function bandEdges(sampleRate: number): number[] {
  const binHz = sampleRate / FFT_SIZE;
  const edges: number[] = [];
  for (let b = 0; b <= FINGERPRINT_BANDS; b++) {
    const hz =
      BAND_LOW_HZ * Math.pow(BAND_HIGH_HZ / BAND_LOW_HZ, b / FINGERPRINT_BANDS);
    edges.push(Math.min(FFT_SIZE / 2 - 1, Math.max(1, Math.round(hz / binHz))));
  }
  return edges;
}

/** First and last sample above the silence floor. Returns null if all quiet. */
function trimSilence(samples: ArrayLike<number>): { start: number; end: number } | null {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  // A take with no signal at all — muted microphone, or the browser handed
  // back an empty buffer. Scoring it as 0% is right, but it must not divide by
  // a zero peak on the way there.
  if (peak < 1e-4) return null;

  const floor = peak * SILENCE_FLOOR;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < floor) start++;
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < floor) end--;
  if (end - start < FFT_SIZE) return null;
  return { start, end };
}

/**
 * Turns raw mono PCM into the fingerprint the round is scored on.
 *
 * Returns a flat `FINGERPRINT_FRAMES × FINGERPRINT_BANDS` array in frame-major
 * order, or an all-zero array for silence. Every frame is mean-subtracted and
 * L2-normalised, which is what makes the comparison indifferent to how loud
 * anyone is and how far they sit from the microphone — the round is about the
 * *shape* of a voice, not about who shouted.
 */
export function fingerprint(samples: ArrayLike<number>, sampleRate: number): number[] {
  const out = new Array<number>(FINGERPRINT_LENGTH).fill(0);
  const span = trimSilence(samples);
  if (!span || sampleRate <= 0) return out;

  const window = hannWindow();
  const edges = bandEdges(sampleRate);
  const total = span.end - span.start + 1;
  const frameLen = total / FINGERPRINT_FRAMES;

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const bands = new Float64Array(FINGERPRINT_BANDS);

  // Pass one: log band energies for every frame, kept whole. The normalisation
  // below needs the entire take before it can touch any of it — see the note
  // on the per-band mean.
  const grid = new Float64Array(FINGERPRINT_LENGTH);
  const live = new Array<boolean>(FINGERPRINT_FRAMES).fill(false);

  for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
    bands.fill(0);
    const frameStart = span.start + Math.floor(f * frameLen);
    // Evenly spaced windows across the slice, clamped so the last one still
    // fits inside the signal.
    const room = Math.max(0, Math.floor(frameLen) - FFT_SIZE);
    let taken = 0;

    for (let w = 0; w < WINDOWS_PER_FRAME; w++) {
      const offset =
        frameStart + (WINDOWS_PER_FRAME > 1 ? Math.floor((room * w) / (WINDOWS_PER_FRAME - 1)) : 0);
      if (offset + FFT_SIZE > samples.length) break;

      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = samples[offset + i] * window[i];
        im[i] = 0;
      }
      fft(re, im);

      for (let b = 0; b < FINGERPRINT_BANDS; b++) {
        let energy = 0;
        for (let bin = edges[b]; bin < edges[b + 1]; bin++) {
          energy += re[bin] * re[bin] + im[bin] * im[bin];
        }
        // A band narrower than one bin still has to contribute something, or
        // the low bands read as silence at every sample rate.
        const width = Math.max(1, edges[b + 1] - edges[b]);
        bands[b] += energy / width;
      }
      taken++;
      if (room === 0) break;
    }

    if (taken === 0) continue;

    live[f] = true;
    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      grid[f * FINGERPRINT_BANDS + b] = Math.log10(bands[b] / taken + 1e-10);
    }
  }

  // ── Pass two: normalise ──
  //
  // **Subtracting each band's mean across the whole take is the step that makes
  // this measure a performance rather than a sound.** Without it the vector is
  // dominated by the take's static spectral tilt — how bass-heavy the voice is,
  // what the microphone does, how much room is in it — which every recording of
  // anything shares to a degree. Measured: with only the per-frame
  // normalisation below, an unrelated descending whistle scored 55% against a
  // voice clip and earned 3 of the 4 available points. With this pass it scores
  // in the teens, while a genuine impression stays in the 70s-90s.
  //
  // It is the same idea as cepstral mean normalisation in speech recognition,
  // and what is left afterwards is exactly what the round is about: how the
  // spectrum *moves* over the line. Emphasis, pitch contour, where the shout
  // lands.
  const liveCount = live.filter(Boolean).length;
  if (liveCount === 0) return out;

  for (let b = 0; b < FINGERPRINT_BANDS; b++) {
    let sum = 0;
    for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
      if (live[f]) sum += grid[f * FINGERPRINT_BANDS + b];
    }
    const mean = sum / liveCount;
    for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
      if (live[f]) grid[f * FINGERPRINT_BANDS + b] -= mean;
    }
  }

  return normaliseFrames(grid, live);
}

/**
 * Mean-subtracts and L2-normalises each frame of a raw 384-number grid.
 *
 * The last step of `fingerprint()`, exported because anything that *builds* a
 * fingerprint rather than measuring one has to finish it the same way — the
 * simulated takes in src/server/bots.ts, for instance. A vector that skipped
 * this would not be a unit vector, and `similarity` would return a dot product
 * that is not a cosine: numbers above 1, or silently deflated ones.
 *
 * `live` marks which frames hold signal; omitted, every frame is treated as
 * live. Frames left out stay zero, which `similarity` reads as "no evidence"
 * rather than as a mismatch.
 */
export function normaliseFrames(grid: ArrayLike<number>, live?: boolean[]): number[] {
  const out = new Array<number>(FINGERPRINT_LENGTH).fill(0);

  for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
    if (live && !live[f]) continue;
    const base = f * FINGERPRINT_BANDS;

    let sum = 0;
    for (let b = 0; b < FINGERPRINT_BANDS; b++) sum += grid[base + b];
    const mean = sum / FINGERPRINT_BANDS;

    const centred = new Array<number>(FINGERPRINT_BANDS);
    let norm = 0;
    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      centred[b] = grid[base + b] - mean;
      norm += centred[b] * centred[b];
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-9) continue;

    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      // Three decimals: the numbers ride the wire on every take, and the
      // fourth decimal moves the final percentage by less than a point.
      out[base + b] = Math.round((centred[b] / norm) * 1000) / 1000;
    }
  }

  return out;
}

/** Shape check for anything arriving from a client. */
export function isFingerprint(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === FINGERPRINT_LENGTH &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 4)
  );
}

/**
 * How alike two fingerprints are, 0–100.
 *
 * Mean per-frame cosine similarity, taken at the best of a few time offsets
 * (see MAX_SHIFT_FRAMES). Negative similarity is clamped to 0 rather than
 * mapped into the middle of the range: two unrelated recordings score around
 * 0–30 and a recognisable impression lands around 50–80, which is a scale a
 * player can read. Mapping [-1,1] onto [0,100] instead would put "nothing like
 * it" at 50 and make every score look like a near miss.
 */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== FINGERPRINT_LENGTH || b.length !== FINGERPRINT_LENGTH) return 0;

  let best = 0;
  for (let shift = -MAX_SHIFT_FRAMES; shift <= MAX_SHIFT_FRAMES; shift++) {
    let sum = 0;
    let frames = 0;
    for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
      const g = f + shift;
      if (g < 0 || g >= FINGERPRINT_FRAMES) continue;
      let dot = 0;
      let liveA = false;
      let liveB = false;
      for (let k = 0; k < FINGERPRINT_BANDS; k++) {
        const va = a[g * FINGERPRINT_BANDS + k];
        const vb = b[f * FINGERPRINT_BANDS + k];
        dot += va * vb;
        if (va !== 0) liveA = true;
        if (vb !== 0) liveB = true;
      }
      // A silent frame on either side is not a match and not a mismatch — it
      // is no evidence, so it is left out of the mean instead of scoring 0.
      if (!liveA || !liveB) continue;
      sum += dot;
      frames++;
    }
    if (frames === 0) continue;
    const score = sum / frames;
    if (score > best) best = score;
  }

  return Math.round(Math.max(0, Math.min(1, best)) * 100);
}

/**
 * The mean of several fingerprints, re-normalised per frame.
 *
 * This is what a round with no authored reference is scored against — the
 * room's own collective rendition of the line. Re-normalising matters: an
 * average of unit vectors is not a unit vector, and without it a line everyone
 * disagreed on would score low for a reason that is arithmetic rather than
 * musical.
 */
export function averageFingerprint(prints: number[][]): number[] {
  const out = new Array<number>(FINGERPRINT_LENGTH).fill(0);
  const usable = prints.filter((p) => p.length === FINGERPRINT_LENGTH);
  if (usable.length === 0) return out;

  for (const print of usable) {
    for (let i = 0; i < FINGERPRINT_LENGTH; i++) out[i] += print[i];
  }

  for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
    let norm = 0;
    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      const v = out[f * FINGERPRINT_BANDS + b];
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      const i = f * FINGERPRINT_BANDS + b;
      out[i] = norm < 1e-9 ? 0 : Math.round((out[i] / norm) * 1000) / 1000;
    }
  }

  return out;
}

/**
 * Points for one take, from its match percentage.
 *
 * Banded like Wavelength's `scoreGuess` and for the same reason: coins are paid
 * per point (see `coinsForPoints`), so the payout has to come off a small
 * integer rather than off a percentage. The percentage is what the player
 * reads; this is what they are paid on.
 */
export function scoreMatch(match: number): number {
  if (match >= 70) return 4;
  if (match >= 55) return 3;
  if (match >= 40) return 2;
  if (match >= 25) return 1;
  return 0;
}
