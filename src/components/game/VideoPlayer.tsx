'use client';
// src/components/game/VideoPlayer.tsx
// Smart player: YouTube IFrame API / Vimeo / MP4

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { parseVideoUrl } from '@/lib/videoParser';
// The IFrame API loader moved to src/lib/youtubeApi.ts when Choicer Voicer
// needed a second player — see the note there for why two copies cannot exist.
import { loadYouTubeAPI } from '@/lib/youtubeApi';

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
}

interface Props {
  url: string;
  onEnded?: () => void;
  onReady?: () => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(
  ({ url, onEnded, onReady }, ref) => {
    const parsed = parseVideoUrl(url);
    const containerRef = useRef<HTMLDivElement>(null);
    const ytPlayerRef = useRef<any>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const vimeoRef = useRef<HTMLIFrameElement>(null);

    // Expose play/pause imperatively
    useImperativeHandle(ref, () => ({
      play() {
        if (parsed.type === 'youtube' && ytPlayerRef.current) {
          ytPlayerRef.current.playVideo();
        } else if (parsed.type === 'mp4' && videoRef.current) {
          videoRef.current.play().catch(() => {});
        } else if (parsed.type === 'vimeo' && vimeoRef.current?.contentWindow) {
          vimeoRef.current.contentWindow.postMessage('{"method":"play"}', '*');
        }
      },
      pause() {
        if (parsed.type === 'youtube' && ytPlayerRef.current) {
          ytPlayerRef.current.pauseVideo();
        } else if (parsed.type === 'mp4' && videoRef.current) {
          videoRef.current.pause();
        } else if (parsed.type === 'vimeo' && vimeoRef.current?.contentWindow) {
          vimeoRef.current.contentWindow.postMessage('{"method":"pause"}', '*');
        }
      },
    }));

    // YouTube setup
    useEffect(() => {
      if (parsed.type !== 'youtube' || !parsed.id) return;
      let destroyed = false;

      loadYouTubeAPI().then(() => {
        if (destroyed || !containerRef.current) return;

        const div = document.createElement('div');
        // The API keeps this id on the iframe it swaps in, which is what
        // hands the frame over to vhs.css's #yt-player rule — width/height
        // 100% plus the scale(1.15) that crops YouTube's title bar and
        // control strip out of frame (spec §5 lock-down).
        div.id = 'yt-player';
        containerRef.current.appendChild(div);

        ytPlayerRef.current = new window.YT.Player(div, {
          // The API replaces `div` with an iframe of its own making, so the
          // container's sizing classes don't carry over — without these it
          // renders at the default 640x360 in the corner of the screen.
          width: '100%',
          height: '100%',
          videoId: parsed.id,
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              onReady?.();
            },
            onStateChange: (e: any) => {
              if (e.data === window.YT.PlayerState.ENDED) {
                onEnded?.();
              }
            },
          },
        });
      });

      return () => {
        destroyed = true;
        if (ytPlayerRef.current) {
          try { ytPlayerRef.current.destroy(); } catch {}
          ytPlayerRef.current = null;
        }
        if (containerRef.current) containerRef.current.innerHTML = '';
      };
    }, [parsed.id]);

    if (parsed.type === 'youtube') {
      return (
        <div
          ref={containerRef}
          id="yt-player-container"
          className="w-full h-full"
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (parsed.type === 'vimeo') {
      return (
        <iframe
          ref={vimeoRef}
          src={parsed.embedUrl || ''}
          className="w-full h-full border-0"
          allow="autoplay; fullscreen"
          onLoad={() => onReady?.()}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (parsed.type === 'mp4') {
      return (
        <video
          ref={videoRef}
          src={parsed.originalUrl}
          className="w-full h-full object-contain"
          playsInline
          onCanPlay={() => onReady?.()}
          onEnded={onEnded}
          controls={false}
        />
      );
    }

    return (
      <div
        className="osd-text"
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--neon-magenta)',
        }}
      >
        <p>UNSUPPORTED TAPE FORMAT</p>
      </div>
    );
  }
);

VideoPlayer.displayName = 'VideoPlayer';
