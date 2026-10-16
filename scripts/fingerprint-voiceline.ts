// scripts/fingerprint-voiceline.ts
// Turns a reference recording into the `fingerprint` field of a
// content/voicelines.json entry.
//
//   npm run voicer:fingerprint -- --in clip.wav --id vo-illbeback \
//     --quote "I'll be back." --source "The Terminator (1984)"
//
// **This is a .ts run through tsx, not a .mjs like the other scripts, and that
// is the point.** It imports `fingerprint()` from src/lib/audioFingerprint —
// the same function the browser runs on a player's take. A standalone script
// with its own copy of the maths would produce numbers that look right and
// score nothing, with no error anywhere to notice it by. tsx is already a
// dependency (it is what boots the dev server), so this costs nothing.
//
// WAV needs no dependency: the decoder below is the RIFF spec plus zlib-free
// arithmetic, so the zero-install path always works. **Anything else goes
// through ffmpeg if it is on PATH** — mp3, m4a, or a whole mp4 you have not
// trimmed yet — because "convert it first" is a step that gets skipped and then
// the mode has no audio. `--from`/`--dur` trim through the same ffmpeg call, so
// a full episode can be pointed at directly:
//
//   npm run voicer:fingerprint -- --in ep.mp4 --id vo-x --from 1284.5 --dur 2.2 --write
//
// AUTHORING NOTE. Trim the clip to the line and nothing else. The fingerprint
// stretches whatever it is given across 24 time slices, so two seconds of room
// tone before the line pushes the whole performance into the back half and
// every player's take is compared against the wrong part of it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fingerprint, FINGERPRINT_LENGTH } from '../src/lib/audioFingerprint';
import { trimmedPeaks } from '../src/lib/waveform';

interface Args {
  in?: string;
  id?: string;
  quote?: string;
  source?: string;
  /** A pasted watch URL. Parsed by the loader, not here — see voiceLibrary.ts. */
  youtube?: string;
  youtubeId?: string;
  start?: string;
  end?: string;
  /**
   * Present as `--no-audio`: write the fingerprint and the peaks but leave
   * `audio` alone. For the normal YouTube case, where the local file is a copy
   * kept only so the clip can be *measured* — the room hears the embed, and
   * setting `audio` would make it hear a stand-in instead.
   */
  'no-audio'?: string;
  /** Trim, in seconds, applied by ffmpeg before fingerprinting. */
  from?: string;
  dur?: string;
  /**
   * Present as `--all`: fingerprint every file in public/audio/voicelines/
   * whose basename matches an entry id. Implies --write, because there is
   * nothing sensible to do with eighteen JSON blobs on stdout.
   */
  all?: string;
  /** Present as `--write`: patch content/voicelines.json in place. */
  write?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2) as keyof Args;
    const value = argv[i + 1];
    // A bare flag (`--write`) takes no value and must not swallow the next one.
    if (value === undefined || value.startsWith('--')) {
      out[key] = '';
      continue;
    }
    out[key] = value;
    i++;
  }
  return out;
}

/**
 * Minimal RIFF/WAVE reader: 16/24/32-bit PCM and 32-bit float, any channel
 * count, downmixed to mono.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets — real files
 * from real tools carry LIST/INFO and fact chunks before the data, and a reader
 * that assumes `data` starts at byte 44 reads metadata as audio and produces a
 * fingerprint of noise.
 */
function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file (no RIFF/WAVE header)');
  }

  let offset = 12;
  let format = 1;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID;
      // the first two bytes of that GUID are the format tag.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }

    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }

  if (!data || !channels || !sampleRate) throw new Error('WAV file has no readable fmt/data chunks');

  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const samples = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (f * channels + c) * bytesPerSample;
      if (format === 3 && bits === 32) sum += data.readFloatLE(at);
      else if (bits === 16) sum += data.readInt16LE(at) / 32768;
      else if (bits === 24) sum += ((data.readUInt8(at) | (data.readUInt8(at + 1) << 8) | (data.readInt8(at + 2) << 16)) / 8388608);
      else if (bits === 32) sum += data.readInt32LE(at) / 2147483648;
      else if (bits === 8) sum += (data.readUInt8(at) - 128) / 128;
      else throw new Error(`Unsupported WAV bit depth: ${bits}`);
    }
    samples[f] = sum / channels;
  }

  return { samples, sampleRate };
}

/**
 * Finds an executable on PATH, returning its absolute path.
 *
 * Written out rather than left to `spawnSync('ffmpeg', …)` because of Windows.
 * Node spawns without a shell (rightly — these arguments include a file path
 * the user typed), and a bare name then goes to CreateProcess, which finds
 * `ffmpeg.exe` but **not** `ffmpeg.cmd` or `.bat`. Several Windows package
 * managers install ffmpeg as exactly such a shim, so the probe would report
 * "not installed" to somebody looking straight at it.
 *
 * `.exe` is preferred over a shim when both exist: a real binary can be spawned
 * directly, where a shim has to go through cmd.exe.
 */
function which(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  const ordered = [...exts].sort((a, b) =>
    a.toUpperCase() === '.EXE' ? -1 : b.toUpperCase() === '.EXE' ? 1 : 0
  );

  for (const dir of dirs) {
    for (const ext of ordered) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * The ffmpeg to use, or null. Probed once.
 *
 * `VOICER_FFMPEG` overrides the search, for a machine where ffmpeg is installed
 * but deliberately not on PATH.
 */
let ffmpegProbe: string | null | undefined;
function ffmpegPath(): string | null {
  if (ffmpegProbe !== undefined) return ffmpegProbe;

  const override = process.env.VOICER_FFMPEG?.trim();
  if (override) {
    ffmpegProbe = fs.existsSync(override) ? override : null;
    if (!ffmpegProbe) console.warn(`[warn] VOICER_FFMPEG points at nothing: ${override}`);
    return ffmpegProbe;
  }

  ffmpegProbe = which('ffmpeg');
  return ffmpegProbe;
}

/**
 * Runs ffmpeg, going through cmd.exe only when it has to.
 *
 * A `.cmd`/`.bat` shim cannot be spawned directly on Windows. Passing it to
 * cmd.exe is the standard answer, but cmd re-interprets `&`, `|`, `^` and `<>`
 * in what it is given — so a path containing one is refused rather than run.
 * That costs nothing real (no clip needs an ampersand in its filename) and it
 * is the whole of the injection surface this branch would otherwise open.
 */
function runFfmpeg(bin: string, args: string[]): { status: number | null; stderr: string } {
  const isShim = /\.(cmd|bat)$/i.test(bin);
  if (!isShim) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr || String(r.error ?? '') };
  }

  const unsafe = [bin, ...args].find((a) => /[&|^<>]/.test(a));
  if (unsafe) {
    throw new Error(
      `Refusing to run the ffmpeg shim with "${unsafe}" in the command — cmd.exe would ` +
        `reinterpret it. Rename the file, or point VOICER_FFMPEG at ffmpeg.exe directly.`
    );
  }
  const r = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || String(r.error ?? '') };
}

const AUDIO_DIR = path.join('public', 'audio', 'voicelines');

/**
 * Decodes any input to mono PCM, converting through ffmpeg when it has to.
 *
 * WAV with no trim is read directly — that path needs nothing installed, which
 * is what keeps the script usable on a machine with no toolchain. Everything
 * else needs ffmpeg, and says so plainly rather than failing on a RIFF header
 * check that means nothing to somebody who just pointed it at an mp3.
 */
function decodeInput(file: string, from?: string, dur?: string): { samples: Float32Array; sampleRate: number } {
  const isWav = path.extname(file).toLowerCase() === '.wav';
  const trimmed = !!from || !!dur;

  if (isWav && !trimmed) return readWav(fs.readFileSync(file));

  const ff = ffmpegPath();
  if (!ff) {
    throw new Error(
      `Reading ${path.basename(file)} needs ffmpeg on your PATH` +
        (trimmed ? ' (--from/--dur are applied by ffmpeg)' : '') +
        '.\n' +
        '  Install it (winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg),\n' +
        '  or convert by hand and pass the .wav:\n' +
        `    ffmpeg -i "${file}" -vn -ac 1 -ar 48000 -t 4 clip.wav`
    );
  }

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voicer-')), 'clip.wav');
  const args = [
    '-v', 'error',
    '-i', file,
    // -ss and -t AFTER -i: slower to seek, but frame-accurate. These clips are
    // a couple of seconds and the accuracy is the entire point of the trim.
    ...(from ? ['-ss', from] : []),
    ...(dur ? ['-t', dur] : []),
    '-vn', '-ac', '1', '-ar', '48000',
    '-y', tmp,
  ];
  const run = runFfmpeg(ff, args);
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not read ${file}:\n${run.stderr.trim()}`);
  }
  const decoded = readWav(fs.readFileSync(tmp));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  return decoded;
}

/** The URL a file under public/ is served at, or null if it is outside. */
function publicUrlFor(file: string): string | null {
  const publicDir = path.resolve('public');
  const abs = path.resolve(file);
  return abs.startsWith(publicDir) ? abs.slice(publicDir.length).replace(/\\/g, '/') : null;
}

const CONFIG_PATH = path.resolve('content', 'voicelines.json');

interface ConfigLine extends Record<string, unknown> {
  id: string;
}

function readConfig(): { lines: ConfigLine[] } {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config: { lines: ConfigLine[] }): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Fingerprints one clip and merges it into its entry.
 *
 * Merging rather than replacing: `quote` and `source` are authored by hand and
 * are usually already right, and what this command exists to deliver is the
 * fingerprint and the audio path, which cannot be written by hand at all.
 * Overwriting the whole entry would blank a source line whenever somebody
 * re-ran it without repeating every flag.
 */
function ingestOne(
  file: string,
  id: string,
  config: { lines: ConfigLine[] },
  args: Args
): { ok: true; seconds: number; audio: string | null } | { ok: false; why: string } {
  const index = config.lines.findIndex((l) => l.id === id);
  if (index === -1) return { ok: false, why: `no entry with id "${id}" in content/voicelines.json` };

  const { samples, sampleRate } = decodeInput(file, args.from, args.dur);
  const seconds = samples.length / sampleRate;
  const print = fingerprint(samples, sampleRate);

  if (print.length !== FINGERPRINT_LENGTH || print.every((n) => n === 0)) {
    return {
      ok: false,
      why: `fingerprinted to silence (${seconds.toFixed(2)}s @ ${sampleRate}Hz) — too quiet, or shorter than one FFT window`,
    };
  }

  // The picture as well as the answer key, from the same decode. `peaks` is what
  // a YouTube round draws the ORIGINAL bar from — the page cannot reach an
  // embed's samples, so if this is not written here it does not exist anywhere.
  const envelope = trimmedPeaks(samples).map((n) => Math.round(n * 1000) / 1000);

  const audio = args['no-audio'] === undefined ? publicUrlFor(file) : null;
  config.lines[index] = {
    ...config.lines[index],
    ...(audio ? { audio } : {}),
    ...(args.quote ? { quote: args.quote } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.youtube ? { youtube: args.youtube } : {}),
    ...(args.youtubeId ? { youtubeId: args.youtubeId } : {}),
    ...(args.start ? { start: Number(args.start) } : {}),
    ...(args.end ? { end: Number(args.end) } : {}),
    peaks: envelope,
    fingerprint: print,
  };
  return { ok: true, seconds, audio };
}

/** Warnings that are about the *content* rather than about the run failing. */
function warnAboutClip(id: string, seconds: number, audio: string | null, args: Args): void {
  if (seconds > 4.5) {
    console.warn(
      `  [warn] ${id}: ${seconds.toFixed(2)}s is long for a line — under ~4s scores much ` +
        `better. Trim with --from/--dur.`
    );
  }
  // Silent under --no-audio: that is somebody saying the embed is the original
  // and this file is only here to be measured, which is the YouTube case.
  if (!audio && args['no-audio'] === undefined) {
    console.warn(
      `  [warn] ${id}: the clip is outside public/, so no audio path was written. The round ` +
        `will score, and the ORIGINAL waveform is drawn from the peaks just written — but ` +
        `unless the entry has a \`youtube\` URL the room will hear nothing.`
    );
  }
}

/**
 * --all: fingerprint every clip in public/audio/voicelines/ whose basename
 * matches an entry id. This is the mode that makes replacing the placeholders a
 * single command — drop the real files in, keeping the names, and run it.
 */
function ingestAll(args: Args): void {
  const dir = path.resolve(AUDIO_DIR);
  if (!fs.existsSync(dir)) {
    console.error(`No such directory: ${AUDIO_DIR}`);
    process.exit(1);
  }
  const config = readConfig();
  const ids = new Set(config.lines.map((l) => l.id));

  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && path.extname(f) !== '' && path.extname(f) !== '.md');

  let done = 0;
  let skipped = 0;
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    if (!ids.has(id)) {
      console.warn(`  [skip] ${file} — no entry with id "${id}"`);
      skipped++;
      continue;
    }
    try {
      const res = ingestOne(path.join(AUDIO_DIR, file), id, config, args);
      if (!res.ok) {
        console.error(`  [fail] ${file} — ${res.why}`);
        skipped++;
        continue;
      }
      console.log(`  [ok]   ${id} — ${res.seconds.toFixed(2)}s`);
      warnAboutClip(id, res.seconds, res.audio, args);
      done++;
    } catch (err) {
      console.error(`  [fail] ${file} — ${(err as Error).message}`);
      skipped++;
    }
  }

  if (done > 0) writeConfig(config);
  console.log(
    `\n${done} line${done === 1 ? '' : 's'} fingerprinted${skipped ? `, ${skipped} skipped` : ''}` +
      (done ? ' — content/voicelines.json updated.' : '.')
  );
  if (skipped && !done) process.exit(1);
}

const USAGE = `Choicer Voicer — fingerprint a reference clip.

  Batch (the usual way to replace the placeholders):
    npm run voicer:fingerprint -- --all
      Fingerprints every file in public/audio/voicelines/ whose name matches an
      entry id (vo-illbeback.mp3 -> the "vo-illbeback" line) and patches
      content/voicelines.json.

  One clip:
    npm run voicer:fingerprint -- --in public/audio/voicelines/vo-x.wav --id vo-x --write

  Trimming a longer file (needs ffmpeg on PATH):
    npm run voicer:fingerprint -- --in ep.mp4 --id vo-x --from 1284.5 --dur 2.2 --write

  Attaching the moment on YouTube (playback) to a local clip (measurement):
    npm run voicer:fingerprint -- --in ep.mp4 --id vo-x --from 1284.5 --dur 2.2 \\
      --youtube "https://www.youtube.com/watch?v=XXXXXXXXXXX&t=42" --no-audio --write

  Flags:
    --in <file>     clip to read. WAV works with no dependencies; anything else
                    (mp3, m4a, mp4…) goes through ffmpeg.
    --id <id>       which entry to patch. Defaults to the filename.
    --all           every matching file in public/audio/voicelines/. Implies --write.
    --from <sec>    trim start, via ffmpeg.
    --dur <sec>     trim length, via ffmpeg.
    --youtube <url> the watch URL, pasted. This is what the room hears.
    --no-audio      do not set \`audio\` — the local file is only here to be
                    measured, and the embed is the original.
    --write         patch content/voicelines.json in place (merges, so a
                    hand-written quote/source survives a re-run).
    --quote / --source / --youtubeId / --start / --end   optional overrides.

  Always written: \`fingerprint\` (384 numbers, the answer key, server-only) and
  \`peaks\` (96 numbers, the ORIGINAL waveform). A YouTube round has no other way
  to draw that waveform — the page cannot read a sample out of an embed.`;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.all !== undefined) {
    console.log(`Scanning ${AUDIO_DIR}…\n`);
    ingestAll(args);
    return;
  }

  if (!args.in) {
    console.error(USAGE);
    process.exit(1);
  }

  const file = path.resolve(args.in);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  // The filename is the id by default, which is what makes --all work and what
  // makes the single-clip form short in the common case.
  const id = args.id ?? path.basename(file, path.extname(file));

  let samples: Float32Array;
  let sampleRate: number;
  try {
    ({ samples, sampleRate } = decodeInput(file, args.from, args.dur));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const seconds = samples.length / sampleRate;
  const print = fingerprint(samples, sampleRate);

  if (print.length !== FINGERPRINT_LENGTH || print.every((n) => n === 0)) {
    console.error(
      `Fingerprinted to silence. Either the clip is quiet or it is shorter than one FFT window ` +
        `(${seconds.toFixed(2)}s read at ${sampleRate}Hz).`
    );
    process.exit(1);
  }

  const audio = args['no-audio'] === undefined ? publicUrlFor(file) : null;
  console.log(`\n// ${seconds.toFixed(2)}s @ ${sampleRate}Hz -> ${print.length} numbers`);
  warnAboutClip(id, seconds, audio, args);

  if (args.write === undefined) {
    const entry = {
      id,
      quote: args.quote ?? 'CHANGEME',
      source: args.source ?? '',
      ...(args.youtube ? { youtube: args.youtube } : {}),
      ...(audio ? { audio } : {}),
      ...(args.youtubeId ? { youtubeId: args.youtubeId } : {}),
      ...(args.start ? { start: Number(args.start) } : {}),
      ...(args.end ? { end: Number(args.end) } : {}),
      peaks: trimmedPeaks(samples).map((n) => Math.round(n * 1000) / 1000),
      fingerprint: print,
    };
    console.log('// Paste into the "lines" array of content/voicelines.json,');
    console.log('// or re-run with --write to patch it in place:\n');
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  const config = readConfig();
  const result = ingestOne(file, id, config, args);
  if (!result.ok) {
    console.error(`Could not patch "${id}": ${result.why}`);
    process.exit(1);
  }
  writeConfig(config);
  console.log(`Patched "${id}" in content/voicelines.json${audio ? ` (audio ${audio})` : ''}`);
}

main();
