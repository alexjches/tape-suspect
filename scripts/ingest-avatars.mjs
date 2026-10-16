#!/usr/bin/env node
// scripts/ingest-avatars.mjs
//
// Takes raster portraits from an image generator and turns them into the
// roster artwork public/avatars/ serves.
//
// A generated PNG does not drop in as it is. Three things are always wrong,
// and all three are silent — the file renders, it just renders badly:
//
//   1. It is opaque. The art is a badge on a white square, and every screen
//      that draws an avatar draws it on the purple field or on a console. A
//      white square behind a circular badge reads as a broken transparency,
//      not as a portrait. The background is knocked out here, once, so the
//      file is correct wherever it lands rather than needing a mask at each
//      of the ~20 call sites.
//
//   2. It is enormous. 1254x1254 RGB is ~1.2MB per character. The largest an
//      avatar is ever drawn is 168px (the landing page preview), so the whole
//      cast was going to cost several megabytes to say nothing at all.
//
//   3. Nothing names it. The ids in src/lib/avatars.ts have to match the files
//      on disk exactly, and hand-syncing the two is how a stored avatar
//      silently becomes a different character. The CHARACTERS array is printed
//      at the end for pasting.
//
// The knockout is a flood fill from the border rather than a colour test over
// the whole image: the penguin's white belly, the dragon's teeth and every
// eye highlight are the same white as the background and are only distinct
// because they are *enclosed* by ink. A global "white becomes transparent"
// pass punches holes through all of them.
//
// The mask is built at full resolution as a hard 1-bit mask and then averaged
// down along with the colour, so the 4x downscale is what produces the
// anti-aliased edge. Doing it the other way round — downscale, then threshold
// — quantises the edge to whole pixels and the circle comes out visibly
// polygonal at 320px.
//
// Colour is averaged over covered pixels *only*. Including the background in
// the average pulls every edge pixel toward white and leaves a pale halo
// around the badge that is invisible on a white page and obvious on ours.
//
// Zero dependencies, on purpose: sharp is a native binary and ImageMagick is
// not on this machine, and neither is worth carrying for a tool that runs
// when the art changes. zlib is in Node, and PNG is a documented format.
//
// Usage:
//   node scripts/ingest-avatars.mjs --in ./profile-pictures [--dry-run]
//   node scripts/ingest-avatars.mjs --in ./profile-pictures --force
//   node scripts/ingest-avatars.mjs --in ./raw --size 320
//
// The id of each character is its filename, slugified — `penguin-pilot.png`
// becomes `penguin-pilot`. Unlike the positional cNN scheme this replaced,
// renaming a file cannot quietly reassign anyone else's character; it only
// orphans its own, and an orphaned id resolves through characterFor().

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';

// Every avatar is drawn at 168px or less (LandingHero's preview is the
// largest). 320 covers that at ~2x for retina with room to spare; going to
// 512 roughly triples the bytes to serve detail no screen asks for.
const DEFAULT_SIZE = 320;

// A pixel joins the background region if every channel is at least this
// bright *and* it is connected to the border. Deliberately below 255: the
// generator's white is 255 in the flat and a shade under it along the
// anti-aliased rim, and leaving that rim opaque draws a white hairline
// around the badge. Enclosed whites are unaffected — they are unreachable.
const DEFAULT_WHITE = 236;

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const inDir = opt('in', null);
const outDir = path.resolve(opt('out', 'public/avatars'));
const size = Number(opt('size', DEFAULT_SIZE));
const white = Number(opt('white', DEFAULT_WHITE));
const dryRun = flag('dry-run');
const force = flag('force');

if (!inDir) {
  console.error('usage: node scripts/ingest-avatars.mjs --in <dir> [--out <dir>] [--size 320] [--force] [--dry-run]');
  process.exit(1);
}

// ── PNG decode ───────────────────────────────────────────────────────────────
// Only what a generator actually emits: 8-bit, non-interlaced, RGB or RGBA.
// Anything else fails loudly rather than producing subtly wrong pixels.
function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG');
  }

  let pos = 8;
  let header = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }

  if (!header) throw new Error('no IHDR');
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth} (need 8)`);
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`unsupported colour type ${header.colorType} (need 2 or 6)`);
  }

  const { width, height } = header;
  const channels = header.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;

  // Un-filter in place. Each scanline is prefixed with its filter byte and is
  // decoded against the *reconstructed* line above, so this has to run in
  // order — the filters are defined over output bytes, not input ones.
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= channels && y > 0 ? out[up + x - channels] : 0;
      let recon;
      switch (filter) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown filter ${filter} on row ${y}`);
      }
      out[dst + x] = recon & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

// ── PNG encode (RGBA) ────────────────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const lines = Buffer.alloc(height * (stride + 1));

  // Per-scanline adaptive filtering, picking the candidate with the smallest
  // sum of absolute differences (the heuristic from the PNG spec's own
  // encoding notes). On flat cartoon art this is worth roughly a third of
  // the file against filter 0 everywhere, and it costs five passes.
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const v = rgba[row + x];
      const a = x >= 4 ? rgba[row + x - 4] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[prev + x - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      cand[0][x] = v;
      cand[1][x] = (v - a) & 0xff;
      cand[2][x] = (v - b) & 0xff;
      cand[3][x] = (v - ((a + b) >> 1)) & 0xff;
      cand[4][x] = (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      let score = 0;
      // Signed magnitude: a filter output of 0xff is -1, i.e. a good
      // prediction, and scoring it as 255 picks the wrong filter.
      for (let x = 0; x < stride; x += 1) {
        const s = cand[f][x];
        score += s < 128 ? s : 256 - s;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    lines[y * (stride + 1)] = best;
    cand[best].copy(lines, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(lines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Background knockout ──────────────────────────────────────────────────────
// Flood fill inward from every border pixel. Returns coverage: 1 where the
// art is, 0 where the page shows through.
function coverageMask(img, threshold) {
  const { width, height, channels, data } = img;
  const n = width * height;
  const cover = new Uint8Array(n).fill(1);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const isBackground = (i) => {
    const p = i * channels;
    return data[p] >= threshold && data[p + 1] >= threshold && data[p + 2] >= threshold;
  };
  const push = (i) => {
    if (seen[i] || !isBackground(i)) return;
    seen[i] = 1;
    cover[i] = 0;
    queue[tail++] = i;
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  return cover;
}

// ── Downscale ────────────────────────────────────────────────────────────────
// Box filter over the exact source rectangle each target pixel maps to, with
// fractional weights at the edges of the box. A nearest-neighbour or
// integer-box shortcut aliases the ink outlines into a stipple at 4x down.
function resample(img, cover, out) {
  const { width, height, channels, data } = img;
  const rgba = Buffer.alloc(out * out * 4);
  const sx = width / out;
  const sy = height / out;

  for (let ty = 0; ty < out; ty += 1) {
    const y0 = ty * sy;
    const y1 = y0 + sy;
    for (let tx = 0; tx < out; tx += 1) {
      const x0 = tx * sx;
      const x1 = x0 + sx;

      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0; // weight of art pixels, for the colour average
      let total = 0; // weight of all pixels, for alpha

      for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          const w = wy * wx;
          const i = y * width + x;
          total += w;
          if (cover[i]) {
            const p = i * channels;
            // Honour an alpha channel if the source already had one, so a
            // second pass over an ingested file is a no-op rather than a
            // re-flattening.
            const a = channels === 4 ? data[p + 3] / 255 : 1;
            const ww = w * a;
            r += data[p] * ww;
            g += data[p + 1] * ww;
            b += data[p + 2] * ww;
            covered += ww;
          }
        }
      }

      const o = (ty * out + tx) * 4;
      if (covered > 0) {
        rgba[o] = Math.round(r / covered);
        rgba[o + 1] = Math.round(g / covered);
        rgba[o + 2] = Math.round(b / covered);
        rgba[o + 3] = Math.round((covered / total) * 255);
      }
      // else: left as 0,0,0,0. Transparent black rather than transparent
      // white, so a viewer that ignores alpha shows the shape, not a blank.
    }
  }

  return rgba;
}

// ── Naming ───────────────────────────────────────────────────────────────────
function slugify(name) {
  return name
    .replace(/\.png$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Run ──────────────────────────────────────────────────────────────────────
const sources = fs
  .readdirSync(inDir)
  .filter((f) => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

if (sources.length === 0) {
  console.error(`no .png files in ${inDir}`);
  process.exit(1);
}

const results = [];
for (const file of sources) {
  const id = slugify(file);
  const dest = path.join(outDir, `${id}.png`);
  if (fs.existsSync(dest) && !force && !dryRun) {
    console.error(`refusing to overwrite ${dest} — pass --force`);
    process.exit(1);
  }

  const src = fs.readFileSync(path.join(inDir, file));
  const img = decodePng(src);
  const cover = coverageMask(img, white);
  const rgba = resample(img, cover, size);
  const png = encodePng(size, size, rgba);

  let opaque = 0;
  for (let i = 0; i < cover.length; i += 1) opaque += cover[i];
  const kept = ((opaque / cover.length) * 100).toFixed(1);

  results.push({ id, file, dest, png, src: src.length, kept, w: img.width, h: img.height });
}

console.log(`\n  ${'id'.padEnd(18)}${'source'.padEnd(24)}${'in'.padEnd(12)}${'out'.padEnd(12)}art`);
for (const r of results) {
  console.log(
    `  ${r.id.padEnd(18)}${r.file.padEnd(24)}` +
      `${`${r.w}px ${(r.src / 1024).toFixed(0)}KB`.padEnd(12)}` +
      `${`${size}px ${(r.png.length / 1024).toFixed(0)}KB`.padEnd(12)}${r.kept}%`,
  );
}

if (dryRun) {
  console.log('\n  --dry-run: nothing written\n');
} else {
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of results) fs.writeFileSync(r.dest, r.png);
  console.log(`\n  wrote ${results.length} file(s) to ${outDir}\n`);
}

console.log('  Paste into src/lib/avatars.ts:\n');
console.log('export const CHARACTERS: Character[] = [');
for (const r of results) console.log(`  { id: '${r.id}', name: '${titleCase(r.id)}' },`);
console.log('];\n');
