// scripts/generate-characters.mjs
//
// Authors the character artwork in public/avatars/.
//
// This is a build-time authoring tool, not a runtime composer. Each character
// below is drawn deliberately; the shared helpers only supply the boilerplate
// every one of them repeats — the badge disc, the bust, an eye with its two
// highlights — the way a set of Illustrator symbols would. The output is 12
// static SVG files, which is what the game actually ships.
//
// The style is matched to the reference set in /pfp-examples, measured from
// its source rather than eyeballed:
//
//   · 262.2 × 299 canvas, badge disc at cx 131.1 / cy 174.6 / r 123.33, which
//     bottom-aligns the disc and leaves ~50px of headroom for hats and ears to
//     break out above it.
//   · No strokes anywhere. An outline is a darker copy of the shape drawn
//     behind it and grown by a few px — the Illustrator "expand stroke" look.
//   · One ink colour, #012442, a deep navy. Never black.
//   · Eyes are ink blobs carrying two white highlights, a large one up-left and
//     a small one down-right, at ~0.30 and ~0.18 of the eye radius.
//   · Blush is a plum ellipse, roughly rx 11 ry 7, with no outline.
//   · Teeth are a white block with ink bars over it for the gaps, not
//     individual white shapes.
//
// Run: node scripts/generate-characters.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'avatars');

// ── Palette, sampled from the reference set ──────────────────────────
const INK = '#012442';
const WHITE = '#FFFFFF';
const C = {
  raspberry: '#E02D5C',
  raspberryDeep: '#AF1545',
  coral: '#EF5B70',
  gold: '#F7C434',
  goldDeep: '#EFC03C',
  amber: '#F9B800',
  yellow: '#FFDF5A',
  peach: '#FFBB71',
  orange: '#F29B3B',
  mint: '#52D89B',
  mintDeep: '#39B579',
  green: '#39D88C',
  grass: '#2ECC56',
  grassDeep: '#17A535',
  sky: '#00C9FF',
  paleBlue: '#C1E0E5',
  plum: '#AF4E81',
  pink: '#F9D9F6',
  lilac: '#F2C0F0',
  slate: '#33455E',
  slateDeep: '#22334A',
};

// ── Smoothing core ───────────────────────────────────────────────────
// Counted against the reference set: 4214 cubic segments and 396 smooth
// continuations (s/S) versus 13 quadratics, with curves outnumbering straight
// lines roughly 3:1. Curvature there is continuous nearly everywhere.
//
// The first pass of this script inverted that — 34 straight segments, 45
// quadratics, zero smooth continuations — and those three things are exactly
// what read as "sharp":
//
//   · A straight line meeting another at a vertex is a corner. Ears drawn as
//     `L,L,z` triangles are folded from card, not drawn.
//   · A quadratic carries one control point, so a curve's entry and exit
//     tangents cannot be set independently; every junction between two `q`
//     segments is a tangent break. `s`/`S` exist precisely to mirror the
//     previous control point and guarantee the join is smooth.
//   · `rect rx` snaps from zero curvature to 1/r in one step. The eye reads
//     that discontinuity as a corner even though the corner is round.
//
// Everything below keeps curvature continuous by construction:
//
//   · smoothLoop  Catmull-Rom through points, emitted as cubics. Joins are
//                 C1 by construction, so a shape cannot kink at a vertex.
//   · squircle    Corners that ease out of the straight edge instead of
//                 snapping onto a fixed-radius arc.
//   · blobPts     A circle with deterministic per-vertex wobble, so organic
//                 shapes are drawn rather than compass-perfect.

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Deterministic jitter. Regenerating the cast must produce byte-identical
 * files — a wobble that moved on every run would make every rebuild a diff.
 */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Catmull-Rom spline through `pts`, emitted as cubic beziers.
 *
 * `t` is tension: 1 is the standard spline, lower pulls the curve toward the
 * straight polygon through the points. Every control point is derived from
 * the neighbouring vertices, which is what makes the joins C1 — the curve
 * cannot develop a kink no matter where the points are put.
 */
function smoothLoop(pts, t = 1) {
  const n = pts.length;
  const at = (i) => pts[((i % n) + n) % n];
  let d = `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * t;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * t;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * t;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * t;
    d += `C${r2(c1x)},${r2(c1y)} ${r2(c2x)},${r2(c2y)} ${r2(p2[0])},${r2(p2[1])}`;
  }
  return `${d}z`;
}

const loop = (pts, f, t = 1) => `<path d="${smoothLoop(pts, t)}" fill="${f}"/>`;

/**
 * Offset a closed loop outward by `pad` — the outline trick, for splines.
 *
 * This must be a true normal offset, not a radial push from the centroid.
 * Radial looks right on a circle and is wrong on everything else: on a tall
 * shape like the ghost, a point on the flank is much closer to the centroid
 * than one at the crown, so the same `pad` buys a different outline width at
 * every vertex and the ink reads as a thick lumpy band rather than an even
 * line. Offsetting along the angle bisector of the two adjacent edges, with
 * the miter correction, gives a constant width all the way round.
 */
function grow(pts, pad) {
  const n = pts.length;
  const at = (i) => pts[((i % n) + n) % n];
  const cx = pts.reduce((a, p) => a + p[0], 0) / n;
  const cy = pts.reduce((a, p) => a + p[1], 0) / n;

  // Edge normal, flipped to whichever side faces away from the centroid.
  const normal = (p, q) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = dy / len;
    let ny = -dx / len;
    const mx = (p[0] + q[0]) / 2 - cx;
    const my = (p[1] + q[1]) / 2 - cy;
    if (nx * mx + ny * my < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  };

  return pts.map((p, i) => {
    const n1 = normal(at(i - 1), p);
    const n2 = normal(p, at(i + 1));
    let bx = n1[0] + n2[0];
    let by = n1[1] + n2[1];
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen;
    by /= blen;
    // Miter: the bisector is shorter than the edge normals by cos(theta/2),
    // so divide it back out or convex corners come up short.
    const cos = Math.max(0.35, bx * n1[0] + by * n1[1]);
    return [p[0] + (bx * pad) / cos, p[1] + (by * pad) / cos];
  });
}

const oLoop = (pts, f, pad = 8, t = 1) => loop(grow(pts, pad), INK, t) + loop(pts, f, t);

/**
 * Superellipse-style rounded rectangle — the "squircle" corner.
 *
 * The corner begins further along the edge than its nominal radius (`d`, which
 * is r scaled up by `s`) and its control points sit at 0.42 of the way to the
 * corner point. That factor is deliberately below 0.5523 — the value that
 * reproduces a circular arc — so the curve peels away from the straight edge
 * gradually instead of at a fixed radius. Curvature ramps rather than jumps.
 *
 * Swapping `rect rx` for this is the single biggest de-sharpening win in the
 * set, because most of the hard-surface characters are built from rectangles.
 */
function squirclePath(x, y, w, h, r, s = 0.6) {
  const d = Math.min(r * (1 + s), Math.min(w, h) / 2);
  const k = d * 0.42;
  return (
    `M${r2(x + d)},${r2(y)}` +
    `L${r2(x + w - d)},${r2(y)}` +
    `C${r2(x + w - d + k)},${r2(y)} ${r2(x + w)},${r2(y + d - k)} ${r2(x + w)},${r2(y + d)}` +
    `L${r2(x + w)},${r2(y + h - d)}` +
    `C${r2(x + w)},${r2(y + h - d + k)} ${r2(x + w - d + k)},${r2(y + h)} ${r2(x + w - d)},${r2(y + h)}` +
    `L${r2(x + d)},${r2(y + h)}` +
    `C${r2(x + d - k)},${r2(y + h)} ${r2(x)},${r2(y + h - d + k)} ${r2(x)},${r2(y + h - d)}` +
    `L${r2(x)},${r2(y + d)}` +
    `C${r2(x)},${r2(y + d - k)} ${r2(x + d - k)},${r2(y)} ${r2(x + d)},${r2(y)}z`
  );
}

/** Ring of points around an ellipse, with deterministic wobble. */
function blobPts(cx, cy, rx, ry, n = 12, wobble = 0, seed = 7) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const k = 1 + (rand() - 0.5) * 2 * wobble;
    out.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return out;
}

// ── Primitives ───────────────────────────────────────────────────────
const circ = (cx, cy, r, f) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}"/>`;
const ell = (cx, cy, rx, ry, f, t = '') =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}"${t ? ` transform="${t}"` : ''}/>`;
const path = (d, f) => `<path d="${d}" fill="${f}"/>`;

/**
 * A rectangle. Anything with a corner radius is emitted as a squircle rather
 * than `rect rx` — see squirclePath. Radius 0 stays a real <rect>, which is
 * only used for internal detail (teeth gaps, label strips) where a hard edge
 * is the intent and there is no silhouette to soften.
 */
const rect = (x, y, w, h, rd, f, t = '') =>
  rd > 0
    ? `<path d="${squirclePath(x, y, w, h, rd)}" fill="${f}"${t ? ` transform="${t}"` : ''}/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"${t ? ` transform="${t}"` : ''}/>`;

/** Outlined variants — ink copy behind, grown by `pad`. */
const oCirc = (cx, cy, r, f, pad = 7) => circ(cx, cy, r + pad, INK) + circ(cx, cy, r, f);
const oEll = (cx, cy, rx, ry, f, pad = 7, t = '') =>
  ell(cx, cy, rx + pad, ry + pad, INK, t) + ell(cx, cy, rx, ry, f, t);
const oRect = (x, y, w, h, rd, f, pad = 7, t = '') =>
  rect(x - pad, y - pad, w + pad * 2, h + pad * 2, rd + pad, INK, t) + rect(x, y, w, h, rd, f, t);

/** Organic head or body: a wobbled ellipse with an ink outline behind it. */
const oBlob = (cx, cy, rx, ry, f, pad = 8, wobble = 0.03, seed = 7) =>
  oLoop(blobPts(cx, cy, rx, ry, 12, wobble, seed), f, pad);

/**
 * A curved, tapered ear or horn, replacing the `L,L,z` triangles.
 *
 * Built as a smoothed loop over six points — the two base corners, a bulge
 * point up each side, and two points a hair apart at the tip. The tip pair is
 * what keeps it pointed: Catmull-Rom rounds every vertex, so a single tip
 * point would blunt into a dome, while two close points round over just
 * enough to look drawn rather than cut.
 */
function horn(b1, b2, tip, f, swell = 0.09) {
  const mid = (p, q, k) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  // Bulge each flank away from the ear's own centroid. Pushing along a single
  // axis-perpendicular instead — the first attempt — moves both flanks the
  // same rotational way, which shears the ear into a lean rather than
  // fattening it.
  const cx = (b1[0] + b2[0] + tip[0]) / 3;
  const cy = (b1[1] + b2[1] + tip[1]) / 3;
  const out = (p, k) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / len) * k, p[1] + (dy / len) * k];
  };
  const size = Math.hypot(tip[0] - cx, tip[1] - cy);
  return loop(
    [
      b1,
      out(mid(b1, tip, 0.52), size * swell),
      // The tip is two points a hair apart. One point would blunt into a dome
      // — the spline rounds every vertex — while a close pair rounds over just
      // enough to look drawn instead of cut.
      mid(tip, b1, 0.11),
      mid(tip, b2, 0.11),
      out(mid(b2, tip, 0.52), size * swell),
      b2,
    ],
    f,
    0.62
  );
}

/**
 * A closed lens — the shape every mouth in this set actually is.
 *
 * Four points (left corner, bottom, right corner, top) run through the
 * spline, so the mouth corners round over instead of meeting at a point.
 * `lift` moves the top vertex: near zero is a flat upper lip, negative pulls
 * it down between the corners and the bottom to make a crescent.
 */
const lens = (cy, w, depth, f, lift = 0.08) =>
  loop(
    [
      [131 - w / 2, cy],
      [131, cy + depth],
      [131 + w / 2, cy],
      [131, cy - depth * lift],
    ],
    f,
    0.9
  );

/**
 * A smooth teardrop, for slime runs and anything else that drips.
 *
 * Six points rather than four: at four the spline has too little to work with
 * between the narrow top and the wide belly and resolves into a pointed
 * diamond, which is the opposite of a drip.
 */
const drop = (cx, top, w, h) => [
  [cx, top],
  [cx - w * 0.82, top + h * 0.4],
  [cx - w * 0.6, top + h * 0.82],
  [cx, top + h],
  [cx + w * 0.6, top + h * 0.82],
  [cx + w * 0.82, top + h * 0.4],
];

/** A crescent — a thin curved sliver, for cat mouths and veins. */
const crescent = (from, belly, to, lift) =>
  [from, belly, to, [(from[0] + to[0]) / 2, (belly[1] + from[1]) / 2 - lift]];

// ── Shared anatomy ───────────────────────────────────────────────────
const BADGE = { cx: 131.1, cy: 174.6, r: 123.33 };

const badge = (f) => circ(BADGE.cx, BADGE.cy, BADGE.r, f);

/** Shoulders. The disc crops the bottom, so only the collar area is seen. */
function bust(f, shade) {
  return (
    oBlob(131, 322, 104, 100, f, 8, 0.012, 21) +
    // Collar shadow, where the head sits over the chest.
    ell(131, 200, 78, 26, shade)
  );
}

/**
 * An eye: ink blob plus the two highlights the reference always carries.
 * `look` nudges the highlights to change where the character is looking.
 */
function eye(cx, cy, rx, ry = rx, look = [0, 0]) {
  return (
    ell(cx, cy, rx, ry, INK) +
    circ(cx - rx * 0.3 + look[0], cy - ry * 0.32 + look[1], rx * 0.3, WHITE) +
    circ(cx + rx * 0.28 + look[0], cy + ry * 0.36 + look[1], rx * 0.17, WHITE)
  );
}

/** A pair of eyes, symmetric about the centre line. */
const eyes = (dx, cy, rx, ry = rx, look = [0, 0]) =>
  eye(131 - dx, cy, rx, ry, look) + eye(131 + dx, cy, rx, ry, look);

const blush = (dx, cy, rx = 11.8, ry = 7.6, f = C.plum) =>
  ell(131 - dx, cy, rx, ry, f) + ell(131 + dx, cy, rx, ry, f);

/** Open grin: ink mouth, white teeth block, ink bars for the gaps. */
function grin(cy, w, h, gaps = 3) {
  const x = 131 - w / 2;
  let out = lens(cy, w, h * 1.55, INK);
  out += lens(cy + 4, w - 12, h * 1.02, WHITE);
  for (let i = 1; i <= gaps; i += 1) {
    const gx = x + (w / (gaps + 1)) * i;
    out += rect(gx - 2.4, cy + 3, 4.8, h * 0.72, 0, INK);
  }
  return out;
}

/** Closed smile — a thick crescent, the top edge dipping between the corners. */
const smile = (cy, w, depth) => lens(cy, w, depth, INK, -0.52);

const tongue = (cy, w, h) => lens(cy, w, h, C.raspberry, -0.7);

/** A rounded triangle — noses, fangs, anything that was an `l,l,z`. */
const tri = (a, b, c, f) => loop([a, b, c], f, 0.7);

// ── The cast ─────────────────────────────────────────────────────────
// Ordered so the roster reads as a deliberate set: the tape-room objects
// first, then the creatures.

const CAST = [
  {
    name: 'Cassette',
    art: () =>
      badge(C.gold) +
      bust(C.raspberry, C.raspberryDeep) +
      oRect(38, 74, 186, 132, 18, C.slate, 8) +
      // Spool windows
      rect(66, 100, 130, 48, 10, C.paleBlue) +
      circ(98, 124, 15, INK) +
      circ(164, 124, 15, INK) +
      circ(98, 124, 6, C.paleBlue) +
      circ(164, 124, 6, C.paleBlue) +
      eyes(33, 124, 15, 15) +
      blush(74, 168) +
      grin(160, 74, 22, 3) +
      // Label strip
      rect(60, 176, 142, 16, 5, C.paleBlue),
  },
  {
    name: 'Television',
    art: () =>
      badge(C.sky) +
      bust(C.gold, C.goldDeep) +
      // Antenna, breaking above the disc. Tapered curves rather than the
      // straight quads this used to be — a rod that bends reads as drawn.
      horn([106, 62], [124, 56], [76, 10], INK, 0.1) +
      horn([138, 56], [156, 62], [186, 10], INK, 0.1) +
      circ(74, 8, 11, C.raspberry) +
      circ(188, 8, 11, C.raspberry) +
      oRect(40, 58, 182, 150, 22, C.paleBlue, 8) +
      eyes(38, 122, 19, 21) +
      blush(78, 166, 13, 8) +
      grin(158, 66, 20, 2) +
      // Dial cluster
      circ(131, 214, 9, INK),
  },
  {
    name: 'Ghost',
    art: () => {
      // The tail scallops used to be a `q` chain, which kinks at every
      // junction. Built as points through the spline instead, so the waves
      // flow into each other and into the shoulders.
      const body = (top, side, base, amp) => {
        const pts = [
          [131, top],
          [131 + side * 0.72, top + 14],
          [131 + side, top + 74],
          [131 + side, base],
        ];
        const cols = [0.62, 0.31, 0, -0.31, -0.62];
        cols.forEach((c, i) => {
          pts.push([131 + side * c, base + (i % 2 === 0 ? amp : -amp * 0.55)]);
        });
        pts.push([131 - side, base], [131 - side, top + 74], [131 - side * 0.72, top + 14]);
        return pts;
      };
      return (
        badge(C.plum) +
        loop(body(32, 97, 250, 20), INK) +
        loop(body(44, 87, 240, 17), C.paleBlue) +
        eyes(38, 122, 20, 24) +
        blush(80, 168, 12, 7.4, C.lilac) +
        ell(131, 176, 20, 26, INK) +
        ell(131, 172, 12, 16, C.raspberry)
      );
    },
  },
  {
    name: 'Robot',
    art: () =>
      badge(C.mint) +
      bust(C.slate, C.slateDeep) +
      // Aerial
      rect(125, 6, 12, 62, 6, INK) +
      oCirc(131, 12, 13, C.gold, 7) +
      oRect(44, 62, 174, 146, 26, C.paleBlue, 8) +
      // Bolts
      circ(58, 76, 8, INK) +
      circ(204, 76, 8, INK) +
      circ(58, 194, 8, INK) +
      circ(204, 194, 8, INK) +
      rect(66, 106, 130, 40, 12, INK) +
      circ(102, 126, 13, C.sky) +
      circ(160, 126, 13, C.sky) +
      circ(98, 121, 5, WHITE) +
      circ(156, 121, 5, WHITE) +
      rect(92, 168, 78, 22, 8, INK) +
      rect(104, 168, 6, 22, 0, C.paleBlue) +
      rect(128, 168, 6, 22, 0, C.paleBlue) +
      rect(152, 168, 6, 22, 0, C.paleBlue),
  },
  {
    name: 'Alien',
    art: () =>
      badge(C.grass) +
      bust(C.mint, C.mintDeep) +
      // Stalk
      rect(125, 18, 12, 56, 6, INK) +
      oCirc(131, 20, 12, C.gold, 7) +
      oBlob(131, 128, 84, 78, C.mint, 8, 0.015, 5) +
      eyes(38, 122, 24, 30, [2, 0]) +
      blush(80, 172, 12, 7) +
      smile(168, 52, 22),
  },
  {
    name: 'Cat',
    art: () =>
      badge(C.peach) +
      bust(C.orange, '#c9782a') +
      // Ears above the disc. Wider base and a tip pulled inboard, so they read
      // as ears rather than the horns a narrow base gives.
      horn([54, 100], [130, 76], [74, 22], INK, 0.11) +
      horn([132, 76], [208, 100], [188, 22], INK, 0.11) +
      horn([78, 84], [124, 70], [86, 38], C.pink, 0.09) +
      horn([138, 70], [184, 84], [176, 38], C.pink, 0.09) +
      oBlob(131, 132, 86, 74, C.orange, 8, 0.016, 11) +
      eyes(40, 122, 19, 22) +
      // Muzzle
      tri([131, 151], [119, 138], [143, 138], INK) +
      // The classic cat "w" — two thin crescents meeting under the nose.
      loop(crescent([131, 153], [115, 170], [99, 152], 5), INK, 0.95) +
      loop(crescent([131, 153], [147, 170], [163, 152], 5), INK, 0.95) +
      blush(80, 166, 13, 8) +
      // Whiskers
      rect(24, 148, 44, 7, 3.5, INK, 'rotate(-8 46 151)') +
      rect(194, 148, 44, 7, 3.5, INK, 'rotate(8 216 151)'),
  },
  {
    name: 'Frog',
    art: () =>
      badge(C.gold) +
      bust(C.grass, C.grassDeep) +
      // Eye domes break the top of the head
      oBlob(131, 152, 90, 68, C.grass, 8, 0.014, 3) +
      oCirc(84, 84, 34, C.grass, 8) +
      oCirc(178, 84, 34, C.grass, 8) +
      eye(84, 84, 19, 22) +
      eye(178, 84, 19, 22) +
      blush(74, 168, 13, 8) +
      grin(158, 96, 26, 0) +
      tongue(176, 44, 26),
  },
  {
    name: 'Slime',
    art: () => {
      const body = (rx, ry, f, seed) =>
        loop(blobPts(131, 148, rx, ry, 12, 0.018, seed), f);
      return (
        badge(C.sky) +
        body(97, 104, INK, 31) +
        body(87, 94, C.mint, 31) +
        // Runs sagging off the lower edge, as smooth teardrops
        loop(drop(74, 214, 22, 52), INK, 0.8) +
        loop(drop(74, 224, 14, 38), C.mint, 0.8) +
        loop(drop(131, 232, 26, 60), INK, 0.8) +
        loop(drop(131, 242, 17, 45), C.mint, 0.8) +
        loop(drop(188, 214, 22, 52), INK, 0.8) +
        loop(drop(188, 224, 14, 38), C.mint, 0.8) +
        eyes(38, 132, 21, 25) +
        blush(80, 180, 12, 7.4) +
        grin(196, 60, 18, 2)
      );
    },
  },
  {
    name: 'Skull',
    art: () =>
      badge(C.raspberry) +
      bust(C.slate, C.slateDeep) +
      // Cranium, wider than the jaw
      oBlob(131, 126, 86, 80, C.paleBlue, 8, 0.013, 17) +
      // Jaw, tucked under and narrower so the skull silhouette reads
      oRect(88, 186, 86, 42, 16, C.paleBlue, 8) +
      // Teeth gaps
      rect(106, 186, 6, 42, 0, INK) +
      rect(128, 186, 6, 42, 0, INK) +
      rect(150, 186, 6, 42, 0, INK) +
      rect(88, 200, 86, 5, 0, INK) +
      eyes(40, 118, 27, 29) +
      tri([131, 150], [118, 173], [144, 173], INK),
  },
  {
    name: 'Bat',
    art: () =>
      badge(C.lilac) +
      // Wings, spread past the disc edges
      path('M92,150 C48,104 20,116 8,140 C34,142 30,168 46,182 C22,188 30,214 52,222 C74,196 100,196 100,196 z', INK) +
      path('M170,150 C214,104 242,116 254,140 C228,142 232,168 216,182 C240,188 232,214 210,222 C188,196 162,196 162,196 z', INK) +
      bust(C.slate, C.slateDeep) +
      // Ears above the disc
      horn([70, 92], [130, 68], [80, 16], INK, 0.11) +
      horn([132, 68], [192, 92], [182, 16], INK, 0.11) +
      horn([90, 78], [124, 64], [92, 32], C.plum, 0.09) +
      horn([138, 64], [172, 78], [170, 32], C.plum, 0.09) +
      oBlob(131, 132, 82, 72, C.slate, 8, 0.014, 13) +
      eyes(38, 122, 19, 21) +
      blush(78, 164, 12, 7.4, C.plum) +
      // Fangs
      lens(164, 34, 17, INK, -0.35) +
      tri([124, 180], [119, 168], [130, 168], WHITE) +
      tri([138, 180], [133, 168], [144, 168], WHITE),
  },
  {
    name: 'Cactus',
    art: () =>
      badge(C.gold) +
      bust(C.orange, '#c9782a') +
      // Arms
      oRect(30, 108, 40, 96, 20, C.grass, 8) +
      oRect(192, 128, 40, 76, 20, C.grass, 8) +
      // Trunk
      oRect(88, 46, 86, 176, 40, C.grass, 8) +
      // Flower breaking the top
      oCirc(131, 40, 17, C.raspberry, 7) +
      circ(131, 40, 7, C.gold) +
      eyes(28, 118, 17, 19) +
      blush(60, 160, 12, 7.4) +
      smile(152, 46, 22) +
      // Spines
      rect(96, 84, 4, 16, 2, INK) +
      rect(162, 84, 4, 16, 2, INK) +
      rect(96, 190, 4, 16, 2, INK) +
      rect(162, 190, 4, 16, 2, INK),
  },
  {
    name: 'Eyeball',
    art: () =>
      badge(C.raspberry) +
      bust(C.sky, '#0098c4') +
      oCirc(131, 132, 88, WHITE, 8) +
      // Veins — smooth slivers rather than kinked `q` pairs
      loop(
        [
          [62, 104],
          [80, 122],
          [80, 146],
          [70, 126],
        ],
        C.coral,
        0.8
      ) +
      loop(
        [
          [200, 104],
          [182, 122],
          [182, 146],
          [192, 126],
        ],
        C.coral,
        0.8
      ) +
      // Iris
      circ(131, 136, 50, C.sky) +
      circ(131, 136, 30, INK) +
      circ(114, 118, 15, WHITE) +
      circ(150, 158, 8, WHITE) +
      // Heavy lid, so it reads as an eye and not a ball
      path('M43,132 C43,84 84,44 131,44 C178,44 219,84 219,132 C190,96 72,96 43,132 z', INK) +
      blush(84, 190, 12, 7.4),
  },
];

// ── Emit ─────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const wrap = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 262.2 299">${inner}</svg>\n`;

CAST.forEach((character, i) => {
  const id = `c${String(i).padStart(2, '0')}`;
  writeFileSync(join(OUT, `${id}.svg`), wrap(character.art()), 'utf8');
});

console.log(`wrote ${CAST.length} characters to public/avatars/`);
console.log(CAST.map((c, i) => `  c${String(i).padStart(2, '0')}  ${c.name}`).join('\n'));
