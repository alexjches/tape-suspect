// src/lib/waveform.ts
// Peak envelopes for the two waveforms on the Choicer Voicer screen.
//
// Kept apart from audioFingerprint.ts on purpose. That file is the *scoring*
// and every number in it is load-bearing — change the band layout and the
// fingerprints stop being comparable. This is the *picture*, and none of it is
// load-bearing at all: it exists so a player can see that their take had a
// shout where the original had a shout. Mixing the two would invite tuning the
// scoring to make the drawing look better.
//
// Client-safe pure arithmetic, like its neighbour.

/**
 * Columns in a drawn waveform.
 *
 * Fixed rather than derived from the canvas width, and that is what makes the
 * two waveforms comparable: the original and the take are different lengths, so
 * a per-pixel envelope would put the same moment of the line at different
 * places on the two bars. At a fixed count, column 12 is 12/96 of the way
 * through *both*, which is the whole point of stacking them.
 *
 * The same reasoning as FINGERPRINT_FRAMES, at a resolution meant for an eye
 * rather than for a cosine.
 */
export const WAVEFORM_COLUMNS = 96;

/**
 * Peak amplitude per column, 0..1, normalised so the loudest column is 1.
 *
 * Normalising is not cosmetic: a take recorded on a quiet laptop microphone and
 * an original mastered for cinema differ in level by more than they differ in
 * shape, and un-normalised the player's own waveform would be a flat line under
 * a mountain. It is the same instinct as the fingerprint dividing loudness out
 * — what is being compared is the shape.
 */
export function peaks(samples: ArrayLike<number>, columns = WAVEFORM_COLUMNS): number[] {
  const out = new Array<number>(columns).fill(0);
  if (samples.length === 0) return out;

  const per = samples.length / columns;
  let loudest = 0;

  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * per);
    const to = Math.min(samples.length, Math.floor((c + 1) * per));
    let peak = 0;
    // Step through long spans rather than reading every sample: a 4-second clip
    // at 48kHz is ~2000 samples per column, and the peak of every 8th is the
    // same picture for an eighth of the work. This runs on the main thread
    // while a recording is being processed.
    const step = Math.max(1, Math.floor((to - from) / 256));
    for (let i = from; i < to; i += step) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[c] = peak;
    if (peak > loudest) loudest = peak;
  }

  if (loudest < 1e-6) return out;
  for (let c = 0; c < columns; c++) out[c] = Math.min(1, out[c] / loudest);
  return out;
}

/**
 * Trims leading and trailing near-silence, then re-spreads over the columns.
 *
 * The two bars have to line up to be worth stacking, and the commonest reason
 * they do not is dead air: a player presses record, draws breath, then speaks,
 * so their line starts a third of the way along while the original starts at
 * zero. Trimming both to where the sound actually is puts the same moment of
 * the performance at the same place on both bars.
 *
 * Deliberately a *separate* trim from the fingerprint's: this one is tuned by
 * eye and can be changed freely, whereas changing the scoring one invalidates
 * every reference on file.
 */
export function trimmedPeaks(
  samples: ArrayLike<number>,
  columns = WAVEFORM_COLUMNS
): number[] {
  let loudest = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > loudest) loudest = a;
  }
  if (loudest < 1e-5) return new Array<number>(columns).fill(0);

  const floor = loudest * 0.04;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < floor) start++;
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < floor) end--;
  if (end - start < 128) return peaks(samples, columns);

  // `subarray` is a view rather than a copy, which matters: these buffers are
  // seconds of 48kHz audio and this runs while the player waits.
  if (samples instanceof Float32Array) return peaks(samples.subarray(start, end + 1), columns);

  const copy = new Float32Array(end - start + 1);
  for (let i = 0; i < copy.length; i++) copy[i] = samples[start + i];
  return peaks(copy, columns);
}
