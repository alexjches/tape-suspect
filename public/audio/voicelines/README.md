# Choicer Voicer reference clips

One short audio file per line in `content/voicelines.json`.

## Two ways a line can have an original, and they do different jobs

| | plays it | draws the ORIGINAL waveform | scores against it |
|---|---|---|---|
| `youtube` (a pasted watch URL) | ✅ | only via `peaks` | ❌ |
| a file in here (`audio`) | ✅ | ✅ (decoded live) | ✅ (via `fingerprint`) |

**A YouTube embed is a cross-origin iframe.** Nothing on the page can read a
sample out of it — not through Web Audio, not through `fetch`, not at all — and
getting at the audio any other way is what spec §5 rules out. So YouTube gives
you the real delivery to *listen* to, and everything that needs the samples
(the waveform, the fingerprint) needs a local copy as well. That is what the
`peaks` field is: 96 numbers measured once, offline, and shipped in the content
file so the waveform still draws on a round with no local audio.

The usual arrangement for a real line is **both**: a `youtube` URL the room
hears, plus a trimmed local clip run through the script with `--no-audio`, which
writes `fingerprint` and `peaks` without making the room hear the copy.

## The files in here are placeholders

They are the Windows text-to-speech voice reading each line, generated so the
mode is playable and testable without any content work: the listen beat, both
soundwaves, the replay control and scoring-against-the-original all run end to
end against them.

They are a robot reading the words, not the iconic delivery. **Replace them.**
Deleting them instead is also fine — a line with no `audio` still plays, it just
runs off the quote alone with no clip and no original waveform.

## Replacing them

Drop the real clips in here **keeping the filenames** (`vo-illbeback.mp3`,
`vo-heresjohnny.mp3`, …), then:

```bash
npm run voicer:fingerprint -- --all
```

That fingerprints every file whose name matches an entry id and writes `audio`,
`peaks` and `fingerprint` into `content/voicelines.json`. Delete the `.wav`
placeholders once the replacements are in, or you will have two files claiming
the same id.

### Attaching the YouTube moment

```bash
npm run voicer:fingerprint -- --in ~/Downloads/breaking-bad.mp4 \
  --id vo-onewhoknocks --from 1284.5 --dur 2.2 \
  --youtube "https://www.youtube.com/watch?v=XXXXXXXXXXX&t=42" --no-audio --write
```

`--youtube` takes the URL straight from the address bar — `youtu.be/`,
`watch?v=`, `/shorts/`, `/embed/` and a `?t=` are all understood. `--no-audio`
says the embed is the original and this file is only here to be measured.

Any format works as long as **ffmpeg is on your PATH** — mp3, m4a, wav, or an
untrimmed mp4. WAV needs nothing installed at all.

### One clip at a time

```bash
npm run voicer:fingerprint -- --in public/audio/voicelines/vo-illbeback.mp3 --write
```

The id defaults to the filename. `--write` **merges** into the existing entry,
so a hand-written `quote` and `source` survive a re-run.

### Cutting the moment out of a longer file

No separate trim step — point it at the source and give it the timestamps:

```bash
npm run voicer:fingerprint -- --in ~/Downloads/terminator.mp4 \
  --id vo-illbeback --from 1284.5 --dur 2.2 --write
```

`--from`/`--dur` are seconds and are applied by ffmpeg with an accurate seek.
Note this reads the *source* file, so it writes no `audio` path — it still
writes `peaks` and `fingerprint`, which is all a YouTube round needs. Put the
cut clip in this folder as well only if you want the room to hear *that* rather
than the embed.

### If ffmpeg isn't found

`VOICER_FFMPEG=/path/to/ffmpeg` overrides the search. On Windows the script
looks for `ffmpeg.exe` first and falls back to a `.cmd`/`.bat` shim, so
chocolatey/scoop installs work; it refuses to run a shim if any path contains
`& | ^ < >`, because cmd.exe would reinterpret those.

## Constraints worth knowing

- **Same-origin only.** The client `fetch`es these bytes and decodes them to
  draw the waveform. A URL on another host plays but decodes to nothing, and the
  ORIGINAL bar comes out flat with no error. That is why the loader refuses
  anything that is not a rooted path.
- **Under ~4 seconds.** The fingerprint stretches whatever it is given across 24
  time slices, so a long clip puts a whole sentence in one slice and every take
  scores about the same. The script warns past 4.5s.
- **No leading silence.** Same reason: two seconds of room tone pushes the
  performance into the back half of the slices, and every player is then
  compared against the wrong part of the line.
- **WAV needs nothing; everything else needs ffmpeg.** The built-in decoder is
  the RIFF spec and no dependencies, which keeps the zero-install path working.
  Anything else is converted through ffmpeg, so mp3 is fine — and preferable,
  since these are served to every player and a WAV is roughly ten times the
  size.
- **Rights are yours to clear.** Nothing here is bundled with the app by
  default beyond the placeholders, which are machine-generated.
