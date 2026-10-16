'use client';
// src/components/game/VoiceClip.tsx
// The original moment, played from YouTube on the Choicer Voicer screen.
//
// Why a second player rather than reusing VideoPlayer:
//
//   - The watch phase plays a whole clip once, full-bleed and locked down. This
//     plays a *few seconds* out of the middle of a video, on demand, as many
//     times as the room wants — so it needs a start, an end, and a replay that
//     seeks back rather than a play() that resumes.
//   - It is a prop on a screen, not the screen. VideoPlayer's container is sized
//     by vhs.css's #yt-player rule, including the scale(1.15) crop; two elements
//     claiming that id on one page would fight over it.
//
// **YouTube can only ever be the playback half of this mode.** The embed is a
// cross-origin iframe: the page cannot read its samples, cannot route it through
// Web Audio and cannot decode it. So it feeds neither the ORIGINAL waveform (see
// `VoiceLine.peaks`, precomputed and shipped in the content file) nor the
// reference fingerprint (which needs a local copy of the audio and the offline
// script). It plays the moment, which is what the room needs to hear, and that
// is all it does. Scraping or downloading the audio to get around that is out —
// spec §5 keeps this on the official player.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { loadYouTubeAPI } from '@/lib/youtubeApi';

export interface VoiceClipHandle {
  /** Seek to the start and play. Replay is a seek, not a resume. */
  play: () => void;
  stop: () => void;
}

interface Props {
  videoId: string;
  /** Seconds into the video the line begins. */
  start: number | null;
  /** Seconds into the video it ends — the player is paused there. */
  end: number | null;
  onPlayingChange?: (playing: boolean) => void;
  /** 0..1 through the trimmed span, or null when it is not playing. */
  onProgress?: (progress: number | null) => void;
}

export const VoiceClip = forwardRef<VoiceClipHandle, Props>(function VoiceClip(
  { videoId, start, end, onPlayingChange, onProgress },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The callbacks are read through refs so the effect below does not list them
  // as dependencies: a parent that passes an inline arrow would otherwise tear
  // the iframe down and rebuild it on every one of its own renders, and this
  // screen re-renders about twenty times a second while somebody is recording.
  const playingCb = useRef(onPlayingChange);
  const progressCb = useRef(onProgress);
  useEffect(() => {
    playingCb.current = onPlayingChange;
    progressCb.current = onProgress;
  });

  const stopTicking = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  // One interval does the playhead and the end-stop together. The IFrame API has
  // no "stop at" — the only way to trim the tail is to watch the clock and pause
  // it, so both jobs are the same poll.
  const startTicking = useCallback(() => {
    stopTicking();
    tickRef.current = setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      const at = p.getCurrentTime() as number;
      const from = start ?? 0;
      const to = end ?? from + (p.getDuration?.() ?? 0);
      if (end !== null && at >= end) {
        p.pauseVideo();
        stopTicking();
        playingCb.current?.(false);
        progressCb.current?.(null);
        return;
      }
      const span = Math.max(0.1, to - from);
      progressCb.current?.(Math.max(0, Math.min(1, (at - from) / span)));
    }, 100);
  }, [start, end, stopTicking]);

  useImperativeHandle(ref, () => ({
    play() {
      const p = playerRef.current;
      if (!p?.seekTo) return;
      p.seekTo(start ?? 0, true);
      p.playVideo();
    },
    stop() {
      playerRef.current?.pauseVideo?.();
      stopTicking();
      playingCb.current?.(false);
      progressCb.current?.(null);
    },
  }));

  useEffect(() => {
    // Captured now rather than read in the cleanup: React has already detached
    // the node by then, so `hostRef.current` is null and the iframe the API
    // built would be left behind.
    const host = hostRef.current;
    let destroyed = false;
    void loadYouTubeAPI().then(() => {
      if (destroyed || !host) return;
      const div = document.createElement('div');
      host.appendChild(div);
      playerRef.current = new window.YT.Player(div, {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          autoplay: 0,
          // Controls stay OFF and the frame is pointer-inert: the room hears the
          // clip together, and a scrubber would let one player wander off into
          // the rest of the video during somebody else's turn.
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          start: start ?? 0,
        },
        events: {
          onStateChange: (e: any) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
              playingCb.current?.(true);
              startTicking();
            } else if (e.data === S.ENDED || e.data === S.PAUSED) {
              stopTicking();
              playingCb.current?.(false);
              progressCb.current?.(null);
            }
          },
        },
      });
    });

    return () => {
      destroyed = true;
      stopTicking();
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          /* already gone with the node */
        }
        playerRef.current = null;
      }
      if (host) host.innerHTML = '';
    };
  }, [videoId, start, startTicking, stopTicking]);

  return <div ref={hostRef} className="voice-clip-frame" />;
});
