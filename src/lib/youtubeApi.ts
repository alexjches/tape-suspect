// src/lib/youtubeApi.ts
// One loader for the YouTube IFrame API, shared by every player in the app.
//
// Lifted out of VideoPlayer.tsx when Choicer Voicer needed a second player.
// Two copies would each inject the script tag and each overwrite
// `window.onYouTubeIframeAPIReady`, so whichever registered second would be the
// only one ever called — and the other player would hang on load forever. The
// `_ytReady` guard below is what makes a second caller wait rather than race.
//
// The API is loaded from YouTube rather than bundled because that is the only
// supported way to embed, and spec §5 keeps playback on the official player: no
// scraping, no downloading.

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
    _ytReady: boolean;
  }
}

export function loadYouTubeAPI(): Promise<void> {
  return new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    // Somebody else already injected it — poll rather than injecting again or
    // stealing the ready callback.
    if (window._ytReady) {
      const poll = setInterval(() => {
        if (window.YT?.Player) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
      return;
    }
    window._ytReady = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = resolve;
  });
}

/**
 * The 11-character video id out of any YouTube URL, plus a `t=` start if there
 * is one. Accepts a bare id too, so a content file can carry either.
 *
 * Exists so an author can paste the URL straight from the address bar — asking
 * somebody to extract an id by hand is how you get an id with a stray `&` on
 * the end, which plays nothing and reports nothing.
 */
export function parseYouTubeRef(input: string): { id: string; start: number | null } | null {
  const raw = input.trim();
  if (!raw) return null;

  // A bare id.
  if (/^[\w-]{11}$/.test(raw)) return { id: raw, start: null };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  let id: string | null = null;
  if (url.hostname.endsWith('youtu.be')) {
    id = url.pathname.slice(1).split('/')[0] || null;
  } else if (url.hostname.endsWith('youtube.com')) {
    id = url.searchParams.get('v');
    if (!id) {
      // /embed/ID, /shorts/ID, /live/ID
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;

  // `t` is seconds, sometimes written 1m20s.
  const t = url.searchParams.get('t') ?? url.searchParams.get('start');
  let start: number | null = null;
  if (t) {
    const plain = Number(t.replace(/s$/, ''));
    if (Number.isFinite(plain)) start = plain;
    else {
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
      if (m) start = (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
    }
  }
  return { id, start };
}
