'use client';
// src/components/game/VoiceScreen.tsx
// Choicer Voicer: the room hears an iconic line, then takes turns performing it,
// and each take is scored on how closely its frequencies match.
//
// **No audio leaves this component.** A take is recorded, measured, drawn and
// kept in a blob URL that only this document can read; what goes up the socket
// is 384 numbers. The playback control plays *your own* take back to *you* —
// there is deliberately no way to hear anybody else's. Nothing here should be
// changed to transmit or store a recording: the round does not need it, and the
// moment it does this file is a moderation surface and a retention question
// instead of a party game. See src/lib/voiceCapture.ts.
//
// **There is nothing secret on this screen.** Everyone sees the same line, hears
// the same clip, and watches the same scores land — which is why there is no
// `game:assigned` for this mode and the board can be live. The one thing held
// back is the reference *fingerprint*, which is server-side and never arrives
// here at all.
//
// The shape of a turn, and the reason for the control set:
//
//   ENABLE MIC   once, before anybody performs — see requestMicAccess() for why
//                it is a button rather than a getUserMedia on first record
//   LISTEN       the room hears the original together; REPLAY stays live after
//   ● RECORD     live waveform under the original's
//   ■ STOP       or the cap runs out
//   ▶ / ↺ / ✓    hear it back, do it again, or commit it — a take is not sent
//                until the player says so

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomPublic, TurnState, VoiceTake } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { Avatar } from '@/components/vhs/Avatar';
import { Waveform, WAVE_INK } from '@/components/game/Waveform';
import { VoiceClip, type VoiceClipHandle } from '@/components/game/VoiceClip';
import { WAVEFORM_COLUMNS } from '@/lib/waveform';
import {
  canCapture,
  loadClipPeaks,
  micPermission,
  watchMicPermission,
  requestMicAccess,
  startRecording,
  VoiceCaptureFailure,
  VOICE_RECORD_SECONDS,
  type VoiceRecorder,
  type VoiceTakeLocal,
} from '@/lib/voiceCapture';

interface Props {
  room: RoomPublic;
  playerId: string;
  code: string;
  takes: VoiceTake[];
  listening: boolean;
  turnState: TurnState | null;
  actions: RoomActions;
}

type Stage = 'idle' | 'recording' | 'measuring' | 'review' | 'sent';

const EMPTY_PEAKS = new Array<number>(WAVEFORM_COLUMNS).fill(0);

/**
 * Shown when the browser has remembered a refusal.
 *
 * Kept in step with BLOCKED_MESSAGE in voiceCapture.ts — that one comes back on
 * a failed press, this one goes up before they press at all, and they describe
 * the same fix.
 */
const MIC_BLOCKED_HINT =
  'Your browser is blocking the microphone for this site, so it will not show the prompt. ' +
  'Click the 🔒 (or 🎤) icon in the address bar → Microphone → Allow, then reload this page.';

export function VoiceScreen({
  room,
  playerId,
  code,
  takes,
  listening,
  turnState,
  actions,
}: Props) {
  const line = room.voiceLine;
  const activeId = turnState?.activePlayerId ?? null;
  const timeLeft = turnState?.turnTimeLeft ?? 0;
  const isMyTurn = !!playerId && activeId === playerId;
  const activePlayer = room.players.find((p) => p.id === activeId) ?? null;
  const amSpectator = !!room.players.find((p) => p.id === playerId)?.isSpectator;
  const alreadyWent = takes.some((t) => t.playerId === playerId);
  const supported = canCapture();

  // ── Microphone gate ──
  const [micReady, setMicReady] = useState(false);
  const [micAsking, setMicAsking] = useState(false);
  const [micProblem, setMicProblem] = useState<string | null>(null);
  /**
   * The browser has remembered a refusal, so it will not show the prompt again
   * however many times the button is pressed. Tracked separately from
   * `micProblem` because it changes what the control should *be* — a retry that
   * cannot work is worse than no button.
   */
  const [micBlocked, setMicBlocked] = useState(false);
  /**
   * What `permissions.query` currently answers, shown on screen.
   *
   * A read-out rather than an internal detail, because "the button does
   * nothing" and "this browser has the site on Block and will never prompt
   * again" look identical from the player's side. Printing the browser's own
   * answer is what tells those two apart without a devtools console. `unknown`
   * is Firefox, which does not expose the microphone permission at all.
   */
  const [micState, setMicState] = useState<string | null>(null);
  /** The origin to unblock, named so they know which site setting to change. */
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  // ── The original clip ──
  // Two playback paths, and which one is live is decided by the content file:
  // a YouTube id plays the real moment through the IFrame API, a local `audio`
  // path plays an <audio> element. YouTube wins when both are set, because it is
  // the actual delivery and a local file is usually a stand-in for it.
  const [decodedPeaks, setDecodedPeaks] = useState<number[]>(EMPTY_PEAKS);
  const [clipProgress, setClipProgress] = useState<number | null>(null);
  const [clipPlaying, setClipPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ytRef = useRef<VoiceClipHandle | null>(null);
  const viaYouTube = !!line?.youtubeId;

  // ── This player's take ──
  const [stage, setStage] = useState<Stage>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [heldFor, setHeldFor] = useState(0);
  const [livePeaks, setLivePeaks] = useState<number[]>(EMPTY_PEAKS);
  const [take, setTake] = useState<VoiceTakeLocal | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const takeAudioRef = useRef<HTMLAudioElement | null>(null);

  // A player who has already granted access this session should not be asked
  // again. `unknown` (Firefox, older Safari) falls through to showing the gate,
  // which is the safe way round — the worst case is one extra button press.
  useEffect(() => {
    if (!supported || amSpectator) return;
    let live = true;
    void micPermission().then((state) => {
      if (!live) return;
      setMicState(state);
      if (state === 'granted') setMicReady(true);
      // Say so before they press: a remembered block cannot be undone from
      // inside the page, so the useful screen is the instructions, not a
      // button that will fail the moment it is touched.
      if (state === 'denied') {
        setMicBlocked(true);
        setMicProblem(MIC_BLOCKED_HINT);
      }
    });
    // Fixing it in the address bar should get the round moving on its own,
    // rather than leaving somebody staring at instructions they have already
    // followed. The re-check button stays for browsers with no change event.
    const unwatch = watchMicPermission((state) => {
      setMicState(state);
      if (state === 'granted') {
        setMicReady(true);
        setMicBlocked(false);
        setMicProblem(null);
      } else if (state === 'denied') {
        setMicBlocked(true);
        setMicProblem(MIC_BLOCKED_HINT);
      }
    });

    return () => {
      live = false;
      unwatch();
    };
  }, [supported, amSpectator]);

  // Draw the original's waveform as soon as the line is known — before it
  // plays, and whether or not this player can record.
  //
  // Only the local path decodes. A YouTube line's envelope arrives precomputed
  // on `line.peaks`, because the page cannot reach an embed's samples at all —
  // see VoiceClip.tsx. Skipped rather than attempted: fetching the audio out of
  // an embed is the thing §5 rules out, not a limitation to work around.
  useEffect(() => {
    if (!line?.audio) {
      setDecodedPeaks(EMPTY_PEAKS);
      return;
    }
    let live = true;
    void loadClipPeaks(line.audio)
      .then((res) => {
        if (live) setDecodedPeaks(res.peaks);
      })
      .catch(() => {
        // A missing or undecodable clip is not worth a message: the quote is
        // still on screen and the round still plays. The flat bar says it.
        if (live) setDecodedPeaks(EMPTY_PEAKS);
      });
    return () => {
      live = false;
    };
  }, [line?.audio]);

  const playClip = useCallback(() => {
    if (viaYouTube) {
      ytRef.current?.play();
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch(() => {
      // Autoplay refused — the player has not interacted yet. The REPLAY button
      // is right there and pressing it is the gesture, so this needs no error.
      setClipPlaying(false);
    });
  }, [viaYouTube]);

  // The listen beat: the room hears it together, once, at the top of the round.
  // Gated on `micReady` because that button is the user gesture that unlocks
  // playback at all — see requestMicAccess().
  const playedOpener = useRef(false);
  useEffect(() => {
    if (!listening || playedOpener.current) return;
    if (!line?.audio && !viaYouTube) return;
    if (!micReady && !amSpectator) return;
    playedOpener.current = true;
    playClip();
  }, [listening, line?.audio, viaYouTube, micReady, amSpectator, playClip]);

  // Recording with the clip still running would capture the original back over
  // the take — which scores very well and is not a performance. The local
  // <audio> path is stopped where recording begins; the embed is stopped here,
  // because it is the one that can still be mid-clip when a turn comes round.
  useEffect(() => {
    if (stage === 'recording') ytRef.current?.stop();
  }, [stage]);

  // A new turn is a clean slate. Keyed on whose turn it is rather than on the
  // phase: this phase runs one turn per player, so the reset has to happen
  // between them or a finished take greys out the next player's own controls.
  useEffect(() => {
    setStage('idle');
    setProblem(null);
    setHeldFor(0);
    setLivePeaks(EMPTY_PEAKS);
    setTake((old) => {
      old?.release();
      return null;
    });
  }, [activeId]);

  // Meter, hold counter and live waveform — one interval, because they are the
  // same 50ms and two would visibly drift against each other on one bar.
  useEffect(() => {
    if (stage !== 'recording') return;
    const handle = setInterval(() => {
      const rec = recorderRef.current;
      if (!rec) return;
      // A fresh array each tick: the recorder mutates one buffer in place, and
      // React would skip the repaint on an unchanged reference.
      setLivePeaks([...rec.livePeaks()]);
      setHeldFor((n) => n + 0.05);
    }, 50);
    return () => clearInterval(handle);
  }, [stage]);

  // Mirrors `take` so the unmount cleanup below can reach the current one
  // without re-subscribing — and therefore without running its teardown — every
  // time a take is recorded.
  const takeRef = useRef<VoiceTakeLocal | null>(null);
  useEffect(() => {
    takeRef.current = take;
  }, [take]);

  // Releasing the microphone and the blob URL on unmount is not optional: the
  // browser leaves its recording indicator lit otherwise, which on a laptop is
  // an on-air light still on after the round has ended.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      takeRef.current?.release();
    };
  }, []);

  const enableMic = async () => {
    setMicAsking(true);
    setMicProblem(null);
    try {
      await requestMicAccess();
      setMicReady(true);
      setMicBlocked(false);
      setMicState('granted');
    } catch (err) {
      const failure = err instanceof VoiceCaptureFailure ? err : null;
      setMicProblem(failure ? failure.message : 'Could not open the microphone');
      // 'blocked' and 'insecure' are the two the player cannot get past by
      // pressing again — one needs the address bar, the other a different URL.
      setMicBlocked(failure?.kind === 'blocked' || failure?.kind === 'insecure');
      // Re-read afterwards: the press may have *been* the prompt, and a refusal
      // taken just now is what flips this from 'prompt' to 'denied'.
      void micPermission().then(setMicState);
    } finally {
      setMicAsking(false);
    }
  };

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setStage('measuring');
    try {
      const result = await recorder.stop();
      setTake(result);
      setLivePeaks(result.peaks);
      // Review, not sent: the player hears it back and decides. A take is only
      // committed by pressing USE THIS TAKE.
      setStage('review');
    } catch (err) {
      setProblem(
        err instanceof VoiceCaptureFailure ? err.message : 'Could not read that take back'
      );
      // Idle rather than sent — the turn clock is still running, so a failed
      // take is worth another go rather than a lost turn.
      setStage('idle');
      setLivePeaks(EMPTY_PEAKS);
    }
  }, []);

  // The cap lives here rather than on a timer inside the recorder, so the
  // countdown the player is watching and the moment it actually stops are the
  // same thing.
  useEffect(() => {
    if (stage === 'recording' && heldFor >= VOICE_RECORD_SECONDS) void finish();
  }, [stage, heldFor, finish]);

  // The turn ending with a take recorded but not committed sends it anyway.
  // Losing a performance somebody actually gave, because they were still
  // listening to it when the clock ran out, is the worse failure.
  useEffect(() => {
    if (stage === 'review' && take && timeLeft <= 1 && isMyTurn) {
      actions.submitTake(code, take.fingerprint);
      setStage('sent');
    }
  }, [stage, take, timeLeft, isMyTurn, actions, code]);

  const begin = async () => {
    if (!isMyTurn || amSpectator) return;
    if (stage !== 'idle' && stage !== 'review') return;
    setProblem(null);
    setTake((old) => {
      old?.release();
      return null;
    });
    setLivePeaks(EMPTY_PEAKS);
    try {
      recorderRef.current = await startRecording();
      setHeldFor(0);
      setStage('recording');
    } catch (err) {
      setProblem(
        err instanceof VoiceCaptureFailure ? err.message : 'Could not open the microphone'
      );
    }
  };

  const commit = () => {
    if (!take || stage !== 'review') return;
    actions.submitTake(code, take.fingerprint);
    setStage('sent');
  };

  if (!line) return null;

  // The original's envelope: read straight off the content file when it is
  // there, decoded from a local clip when it is not. The stored copy wins
  // because it is the only one a YouTube round can have — the page cannot touch
  // an embed's audio — and a line that ships both has been measured from the
  // same recording either way.
  const clipPeaks = line.peaks?.length ? line.peaks : decodedPeaks;
  const hasOriginalWave = clipPeaks.some((p) => p > 0);
  const takePeaks = stage === 'idle' && !take ? EMPTY_PEAKS : livePeaks;

  const best = [...takes].sort((a, b) => (b.match ?? -1) - (a.match ?? -1))[0];
  const secondsOnTake = Math.max(0, VOICE_RECORD_SECONDS - heldFor);
  const myTake = takes.find((t) => t.playerId === playerId);
  // The mic gate is for people who will actually perform.
  const needsMic = supported && !micReady && !amSpectator && !alreadyWent;

  // "TAKE 2 OF 4", the reference's "On clip 16 of 26". Read off the turn order
  // rather than counting takes: a turn that timed out with nothing recorded
  // still happened, and a counter that skipped it would go backwards.
  const turnTotal = room.players.filter((p) => !p.isSpectator).length;
  const turnNumber = (turnState?.turnIndex ?? 0) + 1;

  // One predicate for the three keys that need it, so RECORD and RETAKE can
  // never disagree about whether a take is allowed right now.
  const canRecord =
    isMyTurn &&
    micReady &&
    !amSpectator &&
    !alreadyWent &&
    (stage === 'idle' || stage === 'review');

  return (
    <div className="view-panel active-view">
      {!viaYouTube && line.audio && (
        // One element for the whole phase, played by both the listen beat and
        // every REPLAY. `preload` so the first press is instant.
        <audio
          ref={audioRef}
          src={line.audio}
          preload="auto"
          onPlay={() => setClipPlaying(true)}
          onEnded={() => {
            setClipPlaying(false);
            setClipProgress(null);
          }}
          onPause={() => setClipPlaying(false)}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration > 0) setClipProgress(el.currentTime / el.duration);
          }}
        />
      )}

      <div className="voice-layout">
        <div className="voice-main">
          {/* The turn pill that used to sit here is gone: it read "YOUR TAKE —
              22s" while `.voice-progress` at the top of the control column read
              "TAKE 3 OF 3 — 22s", which is the same fact twice, 400px apart,
              on the screen with the least spare height in the app. The column
              is the one that stays, because that is where the controls are. */}
          <div className="voice-head">
            <h2 className="brutal-title voice-title">CHOICER VOICER</h2>
            <span className="voice-whos-up">
              {listening
                ? 'EVERYBODY LISTENS'
                : activePlayer
                  ? isMyTurn
                    ? 'YOUR TAKE'
                    : `${activePlayer.name.toUpperCase()} IS UP`
                  : 'WAITING…'}
            </span>
          </div>

          {/* The line. Public all round — it is what is being performed, not
              something to be worked out. */}
          <div className="voice-line-card">
            <span className="voice-line-label">THE LINE</span>
            <span className="voice-line-quote">&ldquo;{line.quote}&rdquo;</span>
            {line.source && <span className="voice-line-source">{line.source}</span>}
          </div>

          {/* The take, for HEAR IT BACK. A blob URL into this document's own
              memory — not a network address, and unfetchable by anything else.
              Rendered whenever a take exists rather than only during review, so
              the WATCH button in the column beside it always has something to
              play. */}
          {take && <audio ref={takeAudioRef} src={take.url} preload="auto" />}

          {/* ── What is going on ──
              Prose only. Every control moved into the column on the right when
              this screen was laid out from `gui.png`, and a button here as well
              would be a second place to look for the same thing. */}
          <div className="voice-stage">
            {amSpectator ? (
              <span className="voice-instruction">
                Sitting this one out — you supplied the round.
              </span>
            ) : !supported ? (
              <span className="voice-instruction warn">
                This browser can&apos;t record audio, so your turn will pass. Chrome, Edge,
                Firefox and Safari all can.
              </span>
            ) : needsMic ? (
              <>
                <span className="voice-mic-icon" aria-hidden="true">
                  🎙️
                </span>
                <span className="voice-instruction">
                  This round needs your microphone. Nothing is uploaded or saved — your take is
                  measured in this browser and only the score is sent.
                </span>
                {/* **One button, and it always calls getUserMedia.** An earlier
                    version swapped in a different control once the permission
                    read as blocked, and that control routed to a code path that
                    returned early without asking — so the browser could never
                    prompt, which is the one thing this screen exists to make
                    happen. Being blocked changes the *wording* and adds the
                    instructions; it never removes the ask. */}
                <button
                  id="voice-enable-mic-btn"
                  className="btn-brutal magenta"
                  onClick={enableMic}
                  disabled={micAsking}
                >
                  {micAsking ? 'ASKING…' : micBlocked ? '🎙️ ASK AGAIN' : '🎙️ ENABLE MICROPHONE'}
                </button>
                {micProblem && <span className="voice-instruction warn">{micProblem}</span>}
                {/* The unblock steps, spelled out. A remembered refusal cannot
                    be undone from inside the page — no amount of pressing will
                    produce a prompt — so the only useful thing this screen can
                    do is name the exact control, and the exact origin, that
                    will. `micState` is printed with it because "it isn't
                    working" and "the browser has this site on Block" are the
                    same screen otherwise. */}
                {micBlocked && (
                  <div className="voice-unblock">
                    <span className="voice-unblock-title">How to unblock — 15 seconds</span>
                    <ol className="voice-unblock-steps">
                      <li>
                        Click the <strong>🔒 / 🎚️ / 🎤 icon</strong> at the left of the address bar
                        {origin && (
                          <>
                            {' '}
                            (this site is <strong>{origin}</strong>)
                          </>
                        )}
                      </li>
                      <li>
                        Find <strong>Microphone</strong> and set it to <strong>Allow</strong>
                      </li>
                      <li>
                        <strong>Reload the page</strong> — you will come straight back into the
                        round
                      </li>
                    </ol>
                    <span className="voice-unblock-note">
                      Browser currently reports microphone permission:{' '}
                      <strong>{micState ?? 'checking…'}</strong>
                    </span>
                  </div>
                )}
              </>
            ) : listening ? (
              <span className="voice-instruction">
                Listen to the original. You&apos;ll each get a go at it — hear it again as often as
                you like.
              </span>
            ) : isMyTurn ? (
              <span className="voice-instruction">
                {stage === 'recording'
                  ? `Say the line. Match the delivery, not just the words. — ${secondsOnTake.toFixed(1)}s left`
                  : stage === 'measuring'
                    ? 'Measuring…'
                    : stage === 'review' && take
                      ? `${take.seconds.toFixed(1)}s recorded. Only you can hear this — it is sent as a score, not as audio.`
                      : alreadyWent || stage === 'sent'
                        ? `Take logged${myTake && myTake.match !== null ? ` — ${myTake.match}%` : ''}.`
                        : `Your go. Up to ${VOICE_RECORD_SECONDS} seconds, and you can hear it back before it counts.`}
              </span>
            ) : (
              <span className="voice-instruction">
                {activePlayer ? `${activePlayer.name} is performing. Listen.` : 'Standing by…'}
              </span>
            )}

            {problem && <span className="voice-instruction warn">{problem}</span>}
          </div>

        </div>

        {/* ── The picture ──
            The moment itself, big and central, as `gui.png` lays it out —
            screen in the middle, controls stacked down the right, soundwave
            underneath. Pointer-inert and control-less by the same §5 rule the
            watch phase runs under: the room hears this together, on HEAR CLIP
            AGAIN, not on one player's scrubber.

            **It must never change parents.** The IFrame API builds an iframe
            inside this div, so a remount is a reload — which is why there is
            no expand-on-listen and nothing moves it between the beat and the
            turns. It is sized by *height* rather than width for the same
            reason the column beside it exists: at 16:9 across an 840px column
            this is 470px tall and everything else falls off a 720px screen. */}
        {viaYouTube && line.youtubeId && (
          <div className="voice-clip-stage" style={{ pointerEvents: 'none' }}>
            <VoiceClip
              ref={ytRef}
              videoId={line.youtubeId}
              start={line.startSeconds}
              end={line.endSeconds}
              onPlayingChange={setClipPlaying}
              onProgress={setClipProgress}
            />
          </div>
        )}

        {/* ── The sound ──
            One box, both series composited — see Waveform.tsx. Where the two
            agree the additive blend goes near-white, so "how close am I" is
            answered by how bright the overlap is rather than by carrying a
            shape across a gap between two boxes. Centred under the picture,
            with the playhead in red, as `gui.png` draws it. */}
        <div className="voice-waves">
          <Waveform
            progress={clipPlaying ? clipProgress : null}
            series={[
              {
                peaks: clipPeaks,
                colour: WAVE_INK.original,
                label: hasOriginalWave ? 'ORIGINAL' : 'ORIGINAL — NO WAVEFORM ON FILE',
                muted: !hasOriginalWave,
              },
              {
                peaks: takePeaks,
                colour: stage === 'recording' ? WAVE_INK.recording : WAVE_INK.take,
                label:
                  stage === 'recording'
                    ? 'YOUR TAKE — RECORDING'
                    : take
                      ? 'YOUR TAKE'
                      : 'YOUR TAKE — NOT RECORDED YET',
                muted: !take && stage !== 'recording',
              },
            ]}
          />
        </div>


        {/* ── The control stack ──
            Laid out from `gui.png`: a progress read-out over a column of
            full-width keys, with RESET MIC set apart at the bottom.

            **Every key is always rendered, and unavailable ones are disabled
            rather than removed.** That is the reference's own behaviour and it
            is the point of the arrangement — a player can see the whole shape
            of a turn from the first frame, instead of controls appearing and
            disappearing under the pointer as the stage changes. It replaced a
            single button in the middle of the screen that was RECORD, then
            STOP, then three different things, then a label. */}
        <div className="voice-controls">
          <span className="voice-progress">
            {listening
              ? `LISTEN — ${timeLeft}s`
              : activePlayer
                ? `TAKE ${Math.min(turnNumber, turnTotal)} OF ${turnTotal} — ${timeLeft}s`
                : 'STANDING BY'}
          </span>

          <button
            id="voice-replay-btn"
            className="btn-brutal dark voice-ctl"
            onClick={playClip}
            // Replaying into a live microphone records the clip back over the
            // take, which scores very well and is not a performance.
            disabled={stage === 'recording' || !(line.audio || viaYouTube)}
            title={
              !(line.audio || viaYouTube)
                ? 'This line has no recording — perform it from memory'
                : stage === 'recording'
                  ? 'Not while you are recording'
                  : 'Hear the original again'
            }
          >
            {clipPlaying ? '▶ PLAYING…' : '▶ HEAR CLIP AGAIN'}
          </button>

          {stage === 'recording' ? (
            <button
              id="voice-stop-btn"
              className="btn-brutal magenta voice-ctl active"
              onClick={finish}
            >
              ■ STOP RECORDING
            </button>
          ) : (
            <button
              id="voice-record-btn"
              className="btn-brutal magenta voice-ctl"
              disabled={!canRecord}
              onClick={begin}
              title={
                !micReady
                  ? 'Enable your microphone first'
                  : !isMyTurn
                    ? 'Wait for your turn'
                    : alreadyWent
                      ? 'You have already performed this line'
                      : 'Record your take'
              }
            >
              {stage === 'measuring' ? 'MEASURING…' : '● RECORD'}
            </button>
          )}

          <button
            id="voice-play-take-btn"
            className="btn-brutal dark voice-ctl"
            disabled={!take}
            onClick={() => {
              const el = takeAudioRef.current;
              if (!el) return;
              el.currentTime = 0;
              void el.play().catch(() => {});
            }}
            title={take ? 'Hear your own take — nobody else can' : 'Record a take first'}
          >
            ▶ WATCH
          </button>

          <button
            id="voice-retake-btn"
            className="btn-brutal dark voice-ctl"
            disabled={!take || !canRecord}
            onClick={begin}
          >
            ↺ RETAKE
          </button>

          <button
            id="voice-commit-btn"
            className="btn-brutal magenta voice-ctl"
            disabled={stage !== 'review' || !take}
            onClick={commit}
          >
            ✓ SAVE TAKE
          </button>

          {/* Set apart from the round's own keys, as in the reference. This is
              the one control that is live at every moment of the phase, for
              everybody, whatever the permission currently says — it is a plain
              call to getUserMedia, which is the only thing that can ever make a
              browser show its prompt. */}
          <span className="voice-controls-sep" aria-hidden="true" />
          <button
            id="voice-reset-mic-btn"
            className="btn-brutal dark voice-ctl subtle"
            onClick={enableMic}
            disabled={micAsking || !supported}
            title="Ask the browser for the microphone again"
          >
            {micAsking ? 'ASKING…' : '🎙️ RESET MIC'}
          </button>
          <span className={`voice-mic-state${micState === 'granted' ? ' ok' : ''}`}>
            MIC: {micState === 'granted' ? 'ON' : micState === 'denied' ? 'BLOCKED' : 'NOT SET'}
          </span>
        </div>

        {/* Sibling of .voice-main rather than nested, for the reason the draw
            card is: the mobile breakpoint reorders these, and between turns the
            board matters more than the recorder does. */}
        <div className="voice-board">
          <span className="voice-board-title">
            {line.scoredAgainstOriginal ? 'MATCH vs ORIGINAL' : 'MATCH vs THE ROOM'}
          </span>
          <ul className="voice-board-list">
            {room.players
              .filter((p) => !p.isSpectator)
              .map((p) => {
                const entry = takes.find((t) => t.playerId === p.id);
                const leading = !!best && best.playerId === p.id && (best.match ?? 0) > 0;
                return (
                  <li
                    key={p.id}
                    className={
                      `voice-board-row${p.id === activeId ? ' active' : ''}` +
                      `${leading ? ' leading' : ''}`
                    }
                  >
                    <span className="character-slot voice-board-face">
                      <Avatar code={p.avatar} size={26} />
                    </span>
                    <span className="voice-board-name">
                      {p.name}
                      {p.id === playerId ? ' (YOU)' : ''}
                    </span>
                    <span className="voice-board-score">
                      {/* Three readings, and the middle one is the point: a
                          take exists but has no number yet, because a round
                          with no reference cannot score anyone until the last
                          player has gone. */}
                      {!entry ? '—' : entry.match === null ? '✓' : `${entry.match}%`}
                    </span>
                  </li>
                );
              })}
          </ul>
          {!line.scoredAgainstOriginal && (
            <span className="voice-board-note">
              No reference recording for this line — takes are scored against each other once
              everyone has gone.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
