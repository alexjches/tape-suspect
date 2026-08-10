'use client';
// src/components/vhs/ThemeToggle.tsx
// Light/dark switch for the whole shell.
//
// The theme is a `data-theme` attribute on <html>, not a class or React state,
// for two reasons: CSS custom properties cascade from :root so one attribute
// re-themes everything without a re-render, and the inline script in layout.tsx
// can set it before first paint. Storing it in React state alone would flash
// the dark theme on every load for a light-mode user.

import { useEffect, useState } from 'react';

const KEY = 'imposter_theme';

export type Theme = 'dark' | 'light';

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Private mode with storage blocked: the toggle still works for this
    // session, it just will not be remembered. No reason to fail louder.
  }
}

export function ThemeToggle() {
  // Starts as null rather than 'dark' so the button renders nothing
  // identity-dependent until an effect has read the real value — the shell is
  // prerendered, and guessing here means the server HTML and the first client
  // pass disagree.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = (document.documentElement.getAttribute('data-theme') as Theme) || 'dark';
    setTheme(current);
  }, []);

  if (!theme) return null;

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      id="theme-toggle-btn"
      className="theme-toggle"
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
