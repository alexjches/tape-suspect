// src/lib/voiceCapture.ts
// Browser-side microphone capture for Choicer Voicer.
//
// **Nothing recorded here ever leaves the machine.** The blob is decoded to raw
// PCM, run through `fingerprint()`, and dropped — the tracks are stopped, the
// AudioContext is closed and the only thing handed back is 384 numbers. That is
// deliberate and load-bearing: broadcasting takes would mean shipping audio of
// real people over a websocket, buffering it for reconnects and moderating it,
// and the round does not need any of that. The room hears the performance the
// same way it hears everything else in a party game — the person is in the call.
//
// The pipeline is MediaRecorder -> Blob -> decodeAudioData -> Float32 -> the
// shared fingerprint maths, rather than reading an AnalyserNode's FFT live. The
// AnalyserNode route would be fewer moving parts but its FFT is its own — a
// different window, its own smoothing constant — so a take measured that way
// could not be compared with a reference measured by scripts/fingerprint-
// voiceline.mjs. One implementation of the maths is the whole design; see
// src/lib/audioFingerprint.ts.

import { fingerprint, FINGERPRINT_LENGTH } from './audioFingerprint';
import { trimmedPeaks, WAVEFORM_COLUMNS } from './waveform';

/**
 * Hard cap on one take.
 *
 * Comfortably inside `VOICE_TURN_SECONDS` on the server, so the turn clock is
 * never what ends a recording — a take cut off by the phase machine would score
 * as though the player mumbled the end of the line.
 */
export const VOICE_RECORD_SECONDS = 8;

/** Shortest take worth measuring. Below this there is nothing to fingerprint. */
const MIN_RECORD_MS = 400;

export type VoiceCaptureError =
  | 'unsupported'
  /** The origin is not https/localhost, so getUserMedia is not offered at all. */
  | 'insecure'
  /** Dismissed or refused this time. The browser will ask again. */
  | 'denied'
  /**
   * Refused and *remembered*. This is the one that matters: the browser will
   * never show the prompt again for this origin, so "press the button again"
   * is not advice, it is a loop. Only the address-bar control can undo it.
   */
  | 'blocked'
  /** No audio input device on the machine at all. */
  | 'no-device'
  /** A device exists but something else has it, or the driver failed. */
  | 'device-busy'
  | 'no-audio'
  | 'too-short'
  | 'failed';

/**
 * A finished take.
 *
 * `fingerprint` is the only field that ever leaves the browser. `peaks` draws
 * the waveform and `url` is a blob URL for local playback — both exist so the
 * player can check their own take before submitting it, and neither is sent
 * anywhere. Call `release()` when done with it, or the blob URL keeps the
 * recording alive in memory for the life of the document.
 */
export interface VoiceTakeLocal {
  fingerprint: number[];
  peaks: number[];
  /** Blob URL for an <audio> element. Local to this browser, always. */
  url: string;
  seconds: number;
  release: () => void;
}

export interface VoiceRecorder {
  /** Ends the take and resolves with it. */
  stop: () => Promise<VoiceTakeLocal>;
  /** Abandons the take and releases the microphone. Safe to call twice. */
  cancel: () => void;
  /** 0..1, for a level meter. Reads live off an analyser on the same stream. */
  level: () => number;
  /**
   * The live peak envelope, growing as the take runs — the recording waveform.
   * A fixed-length array whose columns fill left to right, so the bar being
   * drawn while you speak is the same object as the one drawn afterwards.
   */
  livePeaks: () => number[];
}

export class VoiceCaptureFailure extends Error {
  constructor(readonly kind: VoiceCaptureError, message: string) {
    super(message);
    this.name = 'VoiceCaptureFailure';
  }
}

/** True when this browser can do any of the below at all. */
export function canCapture(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * What the browser already thinks about the microphone, without asking.
 *
 * Used to decide whether the gate needs to show at all: a player who granted
 * access last round should not be asked again. `unknown` is the honest answer
 * on Firefox and older Safari, which do not expose the `microphone` permission
 * to `permissions.query` — the gate then shows, which is the safe way round.
 */
export async function micPermission(): Promise<MicPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state as MicPermission;
  } catch {
    return 'unknown';
  }
}

/**
 * Calls back whenever the browser's microphone permission changes.
 *
 * The point of this is the recovery path: somebody who has been told to fix it
 * in the address bar does exactly that, and the page should then get on with
 * the round rather than waiting to be pressed. Returns an unsubscribe, and is a
 * no-op where `permissions` is not implemented for microphone (Firefox), where
 * the explicit re-check button is the fallback.
 */
export function watchMicPermission(onChange: (state: MicPermission) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return () => {};
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const handler = () => onChange((status?.state ?? 'unknown') as MicPermission);

  void navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((s) => {
      if (cancelled) return;
      status = s;
      s.addEventListener('change', handler);
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    status?.removeEventListener('change', handler);
  };
}

/**
 * What to tell somebody whose refusal the browser has remembered.
 *
 * Names the address-bar control, because that is genuinely the only way back —
 * no amount of pressing the in-page button will reopen the prompt — and says to
 * reload, because Chrome does not re-apply a changed microphone setting to a
 * page that is already open.
 */
const BLOCKED_MESSAGE =
  'Your browser is blocking the microphone for this site, so it will not show the prompt. ' +
  'Click the 🔒 (or 🎤) icon in the address bar → Microphone → Allow, then reload this page.';

/**
 * Turns a getUserMedia rejection into something a player can act on.
 *
 * Every one of these was reported as "Microphone blocked. Allow it in your
 * browser, then press again" before, which is wrong for four of the five cases
 * and unactionable for the fifth. The `name` on the DOMException is what
 * distinguishes them and it is well specified across browsers.
 */
/**
 * "No microphone", written for the platform the player is actually on.
 *
 * A generic "check your sound settings" sends a Windows user to the mixer,
 * where the microphone is present and working — because the thing blocking it
 * is two levels down a *privacy* page, and the second toggle there ("let
 * desktop apps access your microphone") is the one that silently hides the
 * device from Chrome while leaving it visible everywhere else.
 */
function noDeviceMessage(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) {
    return (
      'No microphone reached the browser — so it has nothing to ask permission for, ' +
      'which is why no prompt appeared. On Windows this is usually the privacy switch, ' +
      'not the hardware: Settings → Privacy & security → Microphone, turn on BOTH ' +
      '"Microphone access" and "Let desktop apps access your microphone", then press again.'
    );
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return (
      'No microphone reached the browser — so it has nothing to ask permission for, ' +
      'which is why no prompt appeared. Check System Settings → Privacy & Security → ' +
      'Microphone and switch your browser on, then press again.'
    );
  }
  return (
    'No microphone reached the browser — so it has nothing to ask permission for, ' +
    'which is why no prompt appeared. Plug one in, or enable it in your system sound ' +
    'and privacy settings, then press again.'
  );
}

async function describeGetUserMediaFailure(err: unknown): Promise<VoiceCaptureFailure> {
  const name = err instanceof Error ? err.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError': {
      // Refused — but this fires both for "dismissed the prompt just now" and
      // for "blocked permanently", and the two need opposite advice. Re-query:
      // a remembered refusal shows up as 'denied' here, a dismissal does not.
      const state = await micPermission();
      return state === 'denied'
        ? new VoiceCaptureFailure('blocked', BLOCKED_MESSAGE)
        : new VoiceCaptureFailure(
            'denied',
            'You dismissed the microphone prompt. Press the button again and choose Allow.'
          );
    }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      // **This is the other case where no prompt appears, and it is not the
      // browser's doing.** With no device visible to it, the browser has
      // nothing to ask about, so it rejects instantly — indistinguishable from
      // the outside from "the button is broken". On Windows the commonest
      // cause is not a missing microphone at all but the OS privacy switch,
      // which hides every device from every browser while the hardware sits
      // there working, so that path is named rather than left to be guessed.
      return new VoiceCaptureFailure('no-device', noDeviceMessage());
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new VoiceCaptureFailure(
        'device-busy',
        'Your microphone is in use by another app (a call, or another tab). Close it and press again.'
      );
    case 'SecurityError':
      return new VoiceCaptureFailure(
        'insecure',
        'Microphones only work on https or localhost — this page is not on a secure address.'
      );
    default:
      return new VoiceCaptureFailure(
        'failed',
        'Could not open the microphone' + (name ? ` (${name})` : '') + '. Press again to retry.'
      );
  }
}

/**
 * Puts the browser's microphone prompt up, then lets go of the device.
 *
 * Two jobs, and the second is the one that is easy to miss. It asks for the
 * microphone **before** anybody's turn, so the browser's permission dialog does
 * not appear over the top of a 25-second turn clock that is already running —
 * which is what happened when the first `getUserMedia` was the RECORD button.
 *
 * And it is a **user gesture**, which is what unlocks audio playback. Browsers
 * refuse to play sound until the page has been interacted with, so without a
 * button like this the round's opening clip would silently not play for every
 * player who had not clicked anything yet — which, on a screen they were taken
 * to by the host pressing start, is all of them.
 *
 * The tracks are stopped immediately: holding the device open between turns
 * leaves the browser's recording indicator lit for the whole round, which reads
 * as the game listening when it is not.
 */
export async function requestMicAccess(): Promise<void> {
  if (!canCapture()) {
    // `navigator.mediaDevices` is undefined on an insecure origin, so this is
    // where a LAN address like http://192.168.1.5:3000 actually lands — not in
    // the catch below. Naming it is the difference between a fixable problem
    // and "this browser cannot record audio", which is false.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new VoiceCaptureFailure(
        'insecure',
        'Microphones only work on https or localhost. This page is on a plain http address, ' +
          'so the browser will not offer the prompt at all.'
      );
    }
    throw new VoiceCaptureFailure('unsupported', 'This browser cannot record audio');
  }

  // **Always call getUserMedia. Never decide not to.**
  //
  // A previous version checked `permissions.query` first and threw without
  // calling it when the answer was 'denied'. That was a bug with exactly one
  // symptom — the browser never prompts — because the only thing that can
  // *raise* the prompt is this call, and the code had made it unreachable for
  // precisely the players who most needed it. `permissions.query` is also not
  // authoritative: it goes stale after site data is cleared, Safari answers for
  // a different notion of the permission, and Firefox does not answer at all.
  // So the query is used only to word the failure afterwards, never to skip the
  // ask.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw await describeGetUserMediaFailure(err);
  }
  stream.getTracks().forEach((t) => t.stop());

  // Nudging a context to `running` on the same gesture is what actually banks
  // the playback unlock; a context created later can start suspended.
  try {
    const ctx = audioContext();
    await ctx.resume().catch(() => {});
    void ctx.close().catch(() => {});
  } catch {
    /* playback will ask for its own gesture — not worth failing the grant over */
  }
}

/**
 * Fetches a clip and returns its waveform, for the ORIGINAL bar.
 *
 * Decoded rather than measured off a playing `<audio>` element, because the bar
 * has to be there before the clip plays — and an element's analyser can only
 * report the moment it is currently at. Needs same-origin bytes; see
 * `VoiceLine.audio`.
 */
export async function loadClipPeaks(url: string): Promise<{ peaks: number[]; seconds: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`clip ${url} -> ${res.status}`);
  const ctx = audioContext();
  try {
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    return { peaks: trimmedPeaks(toMono(buffer)), seconds: buffer.duration };
  } finally {
    void ctx.close().catch(() => {});
  }
}

function audioContext(): AudioContext {
  const Ctor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor();
}

/** Averages a decoded buffer's channels down to one. */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

/**
 * Opens the microphone and starts recording.
 *
 * Echo cancellation and noise suppression are left **on** (they are the
 * browser default) rather than turned off for a "purer" signal. Both are
 * band-limited and roughly equal across the lobby, whereas a player on a laptop
 * with them off gets their own keyboard and their own speakers back in the
 * recording, which moves their fingerprint far more than the processing does.
 * Auto-gain is on for the same reason it does not matter: the fingerprint is
 * mean-subtracted per frame, so loudness has already been divided out.
 */
export async function startRecording(): Promise<VoiceRecorder> {
  if (!canCapture()) {
    throw new VoiceCaptureFailure('unsupported', 'This browser cannot record audio');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // Same treatment as the gate. This path is reachable even after a
    // successful grant — the device can be unplugged, or taken by a call, in
    // between — so it needs the real reason just as much.
    throw await describeGetUserMediaFailure(err);
  }

  const ctx = audioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const meterBuf = new Uint8Array(analyser.frequencyBinCount);
  const waveBuf = new Uint8Array(analyser.fftSize);
  ctx.createMediaStreamSource(stream).connect(analyser);

  // The live waveform. Filled left to right as the take runs, against the same
  // WAVEFORM_COLUMNS grid the finished bars use, so the picture does not jump
  // when recording stops and the decoded envelope replaces it.
  const growing = new Array<number>(WAVEFORM_COLUMNS).fill(0);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const startedAt = Date.now();
  recorder.start();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  return {
    level() {
      analyser.getByteFrequencyData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i];
      return Math.min(1, sum / meterBuf.length / 128);
    },

    livePeaks() {
      // Time-domain, not frequency: this is the amplitude envelope people read
      // as a waveform, and `level()`'s frequency average would draw a bar that
      // rises with brightness rather than with loudness.
      analyser.getByteTimeDomainData(waveBuf);
      let peak = 0;
      for (let i = 0; i < waveBuf.length; i++) {
        const a = Math.abs(waveBuf[i] - 128) / 128;
        if (a > peak) peak = a;
      }
      // Which column "now" is, by elapsed time against the cap — so the bar
      // fills at the rate the countdown empties and the two agree.
      const p = Math.min(1, (Date.now() - startedAt) / (VOICE_RECORD_SECONDS * 1000));
      const col = Math.min(WAVEFORM_COLUMNS - 1, Math.floor(p * WAVEFORM_COLUMNS));
      // Max rather than assign: this is polled ~20×/s and a column spans
      // several polls, so the loudest moment in the column is what shows.
      if (peak > growing[col]) growing[col] = peak;
      return growing;
    },

    cancel() {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already stopped — nothing to undo */
      }
      release();
    },

    stop() {
      return new Promise<VoiceTakeLocal>((resolve, reject) => {
        const elapsed = Date.now() - startedAt;

        recorder.onstop = async () => {
          try {
            if (elapsed < MIN_RECORD_MS) {
              throw new VoiceCaptureFailure('too-short', 'Hold it a little longer than that');
            }
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            if (blob.size === 0) {
              throw new VoiceCaptureFailure('no-audio', 'Nothing came through the microphone');
            }
            // A second context: `ctx` is about to be closed with the stream,
            // and decodeAudioData needs one that is still open.
            const decodeCtx = audioContext();
            let samples: Float32Array;
            let rate: number;
            try {
              const buffer = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
              samples = toMono(buffer);
              rate = buffer.sampleRate;
            } finally {
              void decodeCtx.close().catch(() => {});
            }

            const print = fingerprint(samples, rate);
            if (print.length !== FINGERPRINT_LENGTH || print.every((n) => n === 0)) {
              throw new VoiceCaptureFailure('no-audio', 'That take came out silent');
            }

            // The blob stays here. `createObjectURL` is a handle into this
            // document's own memory — it is not a network address and cannot
            // be fetched by anything else — which is what lets a player hear
            // their take back without a byte of audio being transmitted.
            const url = URL.createObjectURL(blob);
            resolve({
              fingerprint: print,
              peaks: trimmedPeaks(samples),
              url,
              seconds: samples.length / rate,
              release: () => URL.revokeObjectURL(url),
            });
          } catch (err) {
            reject(
              err instanceof VoiceCaptureFailure
                ? err
                : new VoiceCaptureFailure('failed', 'Could not read that take back')
            );
          } finally {
            release();
          }
        };

        try {
          if (recorder.state === 'inactive') {
            // Already stopped by the browser (tab backgrounded on some
            // platforms). Fire the handler ourselves so the promise settles
            // rather than hanging the player's turn.
            void recorder.onstop?.(new Event('stop'));
          } else {
            recorder.stop();
          }
        } catch {
          release();
          reject(new VoiceCaptureFailure('failed', 'The recording stopped unexpectedly'));
        }
      });
    },
  };
}
