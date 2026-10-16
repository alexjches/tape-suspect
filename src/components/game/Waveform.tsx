'use client';
// src/components/game/Waveform.tsx
// The soundwave display on the Choicer Voicer screen: the original clip and the
// take being performed against it, **drawn over each other in one box**.
//
// Overlaid rather than stacked, because the question a player is asking is "how
// close am I", and two bars in two boxes make that a comparison you have to
// carry across a gap. Superimposed, the answer is a colour: the two series are
// composited with `lighter`, so cyan and magenta add to near-white wherever
// they agree and stay separate wherever they do not. Matching is literally the
// bright part.
//
// A canvas rather than 96 divs per series: this repaints ~20 times a second
// while somebody is recording, and that many elements restyled at that rate is
// what makes a phone drop frames during the one moment the round asks a player
// to concentrate.
//
// The column count is fixed (WAVEFORM_COLUMNS) rather than derived from the
// width, which is what makes the overlay meaningful — the two clips are
// different lengths, so column 12 has to be 12/96 of the way through *both*.

import { useCallback, useEffect, useRef } from 'react';
import { WAVEFORM_COLUMNS } from '@/lib/waveform';

/**
 * Turns `var(--neon-cyan)` into the colour it currently stands for.
 *
 * **A canvas does not understand CSS custom properties.** Assigning
 * `ctx.fillStyle = 'var(--neon-cyan)'` is not an error — it is an invalid value,
 * which the spec says to ignore, so fillStyle keeps whatever it was and the
 * bars paint in the default black. Both waveforms rendered as black-on-black
 * that way, and nothing anywhere reported a problem.
 */
function resolveColour(el: Element, colour: string): string {
  const named = colour.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (!named) return colour;
  const value = getComputedStyle(el).getPropertyValue(named[1]).trim();
  return value || '#ffffff';
}

/**
 * The inks, fixed in both themes.
 *
 * `.waveform` keeps a dark fill whichever theme is on — the same call as
 * `.draw-card` and `.osd-menu`, because these are saturated neon and the dark
 * ground is what they read against, and additive compositing only works on a
 * dark ground at all. Taking these from the `--neon-*` variables looked right
 * until light mode was checked: there `--neon-green` and `--neon-magenta` are
 * both `#ff5fa2`, so RECORDING and RECORDED came out the same colour.
 *
 * Cyan and magenta specifically: they are near-opposite in hue, so `lighter`
 * sums them to something close to white where the two waveforms coincide.
 */
export const WAVE_INK = {
  original: '#00f0ff',
  take: '#ff0077',
  recording: '#00ff66',
} as const;

/**
 * The playhead, red as in `gui.png`.
 *
 * Deliberately outside WAVE_INK and outside the hue range either series can
 * reach: it is the one mark on this canvas that is not sound, and a white line
 * — which is what it was — is indistinguishable from the bright overlap the
 * whole display exists to show.
 */
const PLAYHEAD_INK = '#ff2d2d';

export interface WaveSeries {
  /** 0..1 per column. Short arrays are padded, long ones cut. */
  peaks: number[];
  colour: string;
  label: string;
  /** Drawn faintly — used for the take before anything is recorded. */
  muted?: boolean;
}

interface Props {
  series: WaveSeries[];
  /** 0..1 playhead, or null. Drawn as a line rather than by dimming, because
   *  dimming one of two overlaid series just looks like the other one. */
  progress?: number | null;
}

export function Waveform({ series, progress = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Both dimensions come from the canvas's *rendered* size rather than from a
  // prop, which is the repo's rule about media queries: an inline height beats
  // every selector, so the MOBILE block could not shrink this. CSS owns the
  // box; this only fills it.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    // Before layout there is nothing to draw into, and sizing a canvas to 0 and
    // back clears it for a frame. The observer below calls again.
    if (cssWidth < 1 || cssHeight < 1) return;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const mid = cssHeight / 2;
    const span = (cssHeight - 6) / 2;

    // Additive: where the two series overlap, the colours sum toward white.
    // That is the whole reason they are in one box — "how close together are
    // these" becomes "how white is it".
    ctx.globalCompositeOperation = 'lighter';

    for (const s of series) {
      ctx.fillStyle = resolveColour(canvas, s.colour);
      ctx.globalAlpha = s.muted ? 0.2 : 0.85;

      // A filled envelope mirrored about the midline, as `gui.png` draws it —
      // one continuous body rather than 96 separate bars. The overlap is what
      // this picture is for, and two bar fields interleave into a comb where
      // two solid bodies simply add.
      ctx.beginPath();
      for (let c = 0; c < WAVEFORM_COLUMNS; c++) {
        const value = Math.max(0, Math.min(1, s.peaks[c] ?? 0));
        // A floor of 1px: a silent stretch still draws a hairline, so it reads
        // as a quiet passage rather than as a gap where the rendering failed.
        const y = mid - Math.max(1, value * span);
        const x = ((c + 0.5) * cssWidth) / WAVEFORM_COLUMNS;
        if (c === 0) ctx.moveTo(0, y);
        ctx.lineTo(x, y);
      }
      // Back along the bottom half, mirrored, closing one shape.
      for (let c = WAVEFORM_COLUMNS - 1; c >= 0; c--) {
        const value = Math.max(0, Math.min(1, s.peaks[c] ?? 0));
        const y = mid + Math.max(1, value * span);
        const x = ((c + 0.5) * cssWidth) / WAVEFORM_COLUMNS;
        if (c === WAVEFORM_COLUMNS - 1) ctx.lineTo(cssWidth, y);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // The midline and its end markers, from the reference: they are what make
    // an empty box read as a waveform display waiting for sound rather than as
    // a panel that failed to draw.
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(0, mid - 0.5, cssWidth, 1);

    // Red, as the reference draws it — the one element on this canvas that is
    // neither series, so it must not be a colour either series can reach.
    if (progress !== null && progress >= 0) {
      const x = Math.min(cssWidth - 1, progress * cssWidth);
      ctx.fillStyle = PLAYHEAD_INK;
      ctx.fillRect(x - 0.75, 0, 1.5, cssHeight);
    }
  }, [series, progress]);

  useEffect(() => {
    draw();
  }, [draw]);

  // A canvas does not reflow its own contents, so a rotation, a window resize
  // or the mobile breakpoint firing would otherwise leave it stretched at the
  // old backing-store size until the next repaint happened to land.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  // No theme observer, because WAVE_INK does not change with the theme. If
  // these ever go back to CSS variables, this file needs one: nothing
  // re-renders the component when the theme flips, and between turns it can sit
  // untouched for a minute.

  return (
    <div className="waveform">
      <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />
      {/* The legend is the accessible content — the canvas is a picture of
          something the player can hear, and a screen reader gets nothing from
          192 numbers. */}
      <div className="waveform-legend">
        {series.map((s) => (
          <span key={s.label} className={`waveform-key${s.muted ? ' muted' : ''}`}>
            <span className="waveform-swatch" style={{ background: s.colour }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
