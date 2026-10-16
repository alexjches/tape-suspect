'use client';
// src/components/results/ResultsScreen.tsx
// Section 8 reveal. Layout mirrors #view-results in
// vhs-frontend-example/index.html — the accused's cassette ejects from the
// deck, then the outcome, payout and the two tapes are compared.
//
// This is the FIRST payload that carries roles (see GameResults), so it is
// also the first screen allowed to render who the imposter was.

import { useEffect, useState, useRef } from 'react';
import { GameResults } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { useRouter } from 'next/navigation';
import { useHomeHref } from '@/lib/useHomeHref';
import { useShop } from '@/hooks/useShop';
import { tapeSkinStyles, equippedSticker } from '@/lib/cosmetics';
import { Avatar } from '@/components/vhs/Avatar';

interface Props {
  results: GameResults;
  playerId: string;
  actions: RoomActions;
  code: string;
}

/** Strip a video URL down to something readable on a cassette label. */
function tapeLabel(url: string): string {
  if (!url) return 'UNKNOWN.VHS';
  try {
    const u = new URL(url);
    const id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
    return `${(id || u.hostname).toUpperCase()}.VHS`;
  } catch {
    return `${url.slice(0, 32).toUpperCase()}.VHS`;
  }
}

export function ResultsScreen({ results, playerId, actions, code }: Props) {
  const router = useRouter();
  // LEAVE goes to the lobby router, not to the landing page — and for a guest
  // that means /dashboard?guest=1, since a bare /dashboard bounces them.
  const homeHref = useHomeHref();
  // `persistent` is false for guests, whose coins live in localStorage and go
  // away with it — §11 wants them told exactly here, once a round has ended.
  const { addCoins, persistent } = useShop();
  const [ejected, setEjected] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [showCoins, setShowCoins] = useState(false);
  const [coinCount, setCoinCount] = useState(0);
  const coinsAdded = useRef(false);
  const [rejoining, setRejoining] = useState(false);
  const [rejoinError, setRejoinError] = useState<string | null>(null);

  const handleRejoin = () => {
    setRejoining(true);
    setRejoinError(null);
    // On success the room broadcasts phase 'lobby' and the room page swaps
    // this screen out — nothing more to do here.
    actions.rejoin(code).catch((err: Error) => {
      setRejoinError(err.message);
      setRejoining(false);
    });
  };

  // Coin rewards are per-player (section 9) — the imposter and the crew are
  // paid differently for the same outcome.
  const myPlayer = results.players.find((p) => p.id === playerId);
  const myCoinReward = myPlayer?.coinReward;

  const imposterIds = results.imposterIds ?? [results.imposterId];
  const imposterPlayers = results.players.filter((p) => imposterIds.includes(p.id));
  const isImposter = imposterIds.includes(playerId);
  const crewWins = results.crewWins;

  // A 2-imposter game can land between the two sides: exactly one of the pair
  // caught means nobody swept it, and section 3 pays both a middle amount.
  const outcome = results.outcome ?? (crewWins ? 'crew' : 'imposter');
  const impostersCaught = results.impostersCaught ?? (crewWins ? 1 : 0);
  const imposterCount = results.imposterCount ?? imposterIds.length;
  const iWon = outcome === 'split' ? false : isImposter !== crewWins;
  const accusedNames = results.accusedNames?.length
    ? results.accusedNames
    : [results.mostVotedName || 'NOBODY'];

  // Reveal sequence: eject the tape, then the verdict, then the payout.
  useEffect(() => {
    const t1 = setTimeout(() => setEjected(true), 1200);
    const t2 = setTimeout(() => {
      setShowWinner(true);
      if (crewWins) launchConfetti();
    }, 3000);
    const t3 = setTimeout(() => setShowCoins(true), 4200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [crewWins]);

  // Bank the reward once, counting up as it lands. For a signed-in player the
  // socket server has already credited the account — addCoins just pulls the
  // authoritative balance back, so the count-up here is presentation only.
  useEffect(() => {
    if (!showCoins || coinsAdded.current || !myCoinReward) return;
    coinsAdded.current = true;

    const target = myCoinReward.total ?? 0;
    let current = 0;
    const step = Math.max(1, Math.ceil(target / 40));
    const interval = setInterval(() => {
      current = Math.min(current + step, target);
      setCoinCount(current);
      if (current >= target) clearInterval(interval);
    }, 30);
    addCoins(target);

    return () => clearInterval(interval);
  }, [showCoins, myCoinReward, addCoins]);

  function launchConfetti() {
    const colors = ['#00f0ff', '#ff00c8', '#ffee00', '#00ff88', '#ff7700'];
    for (let i = 0; i < 120; i++) {
      setTimeout(() => {
        const el = document.createElement('div');
        el.className = 'confetti-particle';
        el.style.left = `${Math.random() * 100}vw`;
        el.style.width = `${Math.random() * 10 + 6}px`;
        el.style.height = `${Math.random() * 6 + 4}px`;
        el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        el.style.animationDuration = `${Math.random() * 2 + 2}s`;
        el.style.animationDelay = `${Math.random() * 1}s`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
      }, i * 20);
    }
  }

  const accusedName = results.mostVotedName || 'NOBODY';
  // The cassette in the deck belongs to the final accusation, so its label
  // follows that player's role, not the overall outcome.
  const headlineWasImposter =
    !!results.mostVotedId && imposterIds.includes(results.mostVotedId);
  // The cassette in the deck belongs to the accused, so it wears their skin
  // and their label — section 10's "changes how you look in game".
  const accusedCosmetics = results.players.find((p) => p.id === results.mostVotedId)?.cosmetics;
  const tape = tapeSkinStyles(accusedCosmetics);
  const sticker = equippedSticker(accusedCosmetics);
  const bannerColor =
    outcome === 'crew'
      ? 'var(--neon-green)'
      : outcome === 'split'
      ? 'var(--neon-yellow)'
      : 'var(--neon-magenta)';

  // Rank without mutating the payload we were handed.
  const ranked = [...results.players].sort((a, b) => b.votes - a.votes);
  // A scored round has no accusation, no ballot and no roles to reveal.
  const scored = results.kind === 'score';
  const maxVotes = Math.max(1, ...ranked.map((p) => p.votes));

  return (
    <div className="view-panel active-view">
      <div className="results-container">
        {/* A scored round ejects nobody: there was no ballot and no accused,
            so the banner, the eject animation and the tally below would all be
            furniture from a game that did not happen. */}
        <div>
          <h2 className="brutal-title results-banner" style={{ color: bannerColor }}>
            {scored ? 'SIGNAL READ' : 'TAPE EJECTED'}
          </h2>
          <p className="osd-text" style={{ color: '#aaa' }}>
            {results.bluffReveal
              ? 'Ballots in — here is who wrote what…'
              : scored
                ? 'Dials locked — here is how close everyone landed…'
                : `Votes tallied — the deck is spitting out ${accusedNames.join(' and ')}…`}
          </p>
        </div>

        {/* Cassette eject: the accused player's tape leaves the deck. */}
        {!scored && (
        <div className={`vcr-deck${ejected ? ' ejected' : ''}`}>
          <div className="vcr-slot">
            <div className="vcr-door">EJECTING TAPE</div>
            <div className="ejected-tape">
              <div
                className={`vhs-tape${ejected ? ' imposter-selected' : ''}`}
                style={{
                  ...tape?.shell,
                  transform: 'scale(0.65)',
                  pointerEvents: 'none',
                  marginTop: -30,
                }}
              >
                <div
                  className="tape-tag"
                  style={tape?.tag ?? { backgroundColor: 'var(--neon-magenta)', color: '#fff' }}
                >
                  {headlineWasImposter ? 'SUSPECT-X' : 'INNOCENT'}
                </div>
                <div
                  className="tape-label"
                  style={
                    sticker
                      ? { background: sticker.bg, color: sticker.color, borderColor: sticker.border }
                      : tape?.label
                  }
                >
                  <div
                    className="tape-title"
                    style={{ fontSize: '1.1rem', color: ejected ? '#8a0060' : '#1e1e24' }}
                  >
                    {ejected ? accusedName : '???'}
                  </div>
                  <div className="tape-sublabel">
                    <span>
                      {ejected ? (headlineWasImposter ? 'SUSPECT' : 'CREWMATE') : 'UNKNOWN'}
                    </span>
                    <span>● EJECT</span>
                  </div>
                </div>
                <div className="tape-window-panel" style={tape?.window}>
                  <div className="spool" style={tape?.spool}>
                    <div className="spool-gear" style={tape?.gear} />
                  </div>
                  <div className="spool" style={tape?.spool}>
                    <div className="spool-gear" style={tape?.gear} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}

        {/* ── Verdict ───────────────────────────────────────────────
            Accusation rounds only. A scored round has no suspect to name and
            no side that won, so this whole card would render "The suspect was
            ." over an empty string. Its replacement is the score table below. */}
        {showWinner && results.kind === 'accusation' && (
          <div className="brutal-card yellow" style={{ width: '100%', color: '#000' }}>
            <h3
              className="brutal-title"
              style={{ fontSize: '1.5rem', color: '#000', textShadow: 'none', marginBottom: 10 }}
            >
              {outcome === 'crew'
                ? '🚀 CREW VICTORY!'
                : outcome === 'split'
                ? '⚖️ SPLIT DECISION'
                : '👁️ SUSPECT VICTORY!'}
            </h3>
            <p style={{ fontWeight: 600 }}>
              {imposterCount > 1
                ? `${impostersCaught} of ${imposterCount} suspects caught.`
                : crewWins
                ? 'The suspect was detected and ejected from the deck.'
                : `${accusedName} was innocent — the suspect stayed in the deck.`}
            </p>
            <p style={{ fontWeight: 600, marginTop: 8 }}>
              The suspect{imposterPlayers.length > 1 ? 's were' : ' was'}{' '}
              <span
                style={{
                  textTransform: 'uppercase',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  verticalAlign: 'middle',
                }}
              >
                {imposterPlayers.length > 0
                  ? imposterPlayers.map((p, i) => (
                      <span
                        key={p.id}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <Avatar code={p.avatar} size={22} />
                        {p.name}
                        {i < imposterPlayers.length - 1 ? ',' : ''}
                      </span>
                    ))
                  : results.imposterName}
              </span>
              .
            </p>
            <p
              className="brutal-title"
              style={{ fontSize: '1.2rem', color: '#000', textShadow: 'none', marginTop: 12 }}
            >
              {outcome === 'split' ? '🤝 HALF A RESULT' : iWon ? '🎉 YOU WON' : '😞 YOU LOST'}
              {isImposter ? ' — YOU WERE THE SUSPECT' : ''}
            </p>
          </div>
        )}

        {/* ── Payout ──────────────────────────────────────────────── */}
        {showCoins && myCoinReward && (
          <div className="brutal-card" style={{ width: '100%', textAlign: 'left' }}>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div className="reveal-title-tag">🪙 CREDITS EARNED</div>
              <span
                className="brutal-title"
                style={{ fontSize: '2rem', color: 'var(--neon-yellow)' }}
              >
                +{coinCount}
              </span>
            </div>
            <div className="osd-menu" style={{ marginTop: 12 }}>
              {myCoinReward.baseCoins > 0 && (
                <div className="osd-menu-row">
                  <span>PARTICIPATION</span>
                  <span style={{ color: 'var(--neon-yellow)' }}>+{myCoinReward.baseCoins}</span>
                </div>
              )}
              {myCoinReward.bonusCoins > 0 && (
                <div className="osd-menu-row">
                  <span>{isImposter ? 'SUSPECT BONUS' : 'CREW BONUS'}</span>
                  <span style={{ color: 'var(--neon-green)' }}>+{myCoinReward.bonusCoins}</span>
                </div>
              )}
              <div className="osd-menu-row" style={{ borderTop: '2px dashed #fff', paddingTop: 8 }}>
                <span>TOTAL</span>
                <span style={{ color: 'var(--neon-yellow)' }}>+{myCoinReward.total}</span>
              </div>
            </div>

            {/* §11: the claim-your-account prompt, shown to guests after every
                round. Their balance is real but lives in this browser only —
                signing up folds exactly what they have into the account. */}
            {!persistent && (
              <div
                className="osd-menu"
                style={{ marginTop: 14, borderColor: 'var(--neon-yellow)' }}
              >
                <div className="osd-menu-title">--- Unsaved Progress ---</div>
                <p className="osd-text" style={{ color: '#ddd', padding: '6px 2px' }}>
                  You are playing as a guest, so these coins are held in this
                  browser and nowhere else. Clear your site data and they are
                  gone.
                </p>
                <button
                  id="claim-account-btn"
                  className="btn-brutal cyan"
                  style={{ width: '100%', marginTop: 6 }}
                  onClick={() => router.push('/signup')}
                >
                  💾 SAVE MY PROGRESS
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Final tally ─────────────────────────────────────────── */}
        {showWinner && !scored && (
          <div className="brutal-card" style={{ width: '100%', textAlign: 'left' }}>
            <div className="reveal-title-tag">FINAL VOTE COUNT</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              {ranked.map((player) => {
                const wasImposter = imposterIds.includes(player.id);
                return (
                  <div
                    key={player.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                  >
                    <Avatar code={player.avatar} size={24} />
                    <span
                      className="osd-text"
                      style={{
                        flex: 1,
                        color: wasImposter ? 'var(--neon-magenta)' : '#ddd',
                        textTransform: 'uppercase',
                      }}
                    >
                      {player.name}
                      {wasImposter ? ' 👁️' : ''}
                    </span>
                    <div
                      style={{
                        width: 120,
                        height: 10,
                        border: '2px solid #000',
                        background: '#111',
                      }}
                    >
                      <div
                        style={{
                          width: `${(player.votes / maxVotes) * 100}%`,
                          height: '100%',
                          background: wasImposter
                            ? 'var(--neon-magenta)'
                            : 'var(--neon-cyan)',
                        }}
                      />
                    </div>
                    <span className="osd-text" style={{ color: '#aaa', width: 18 }}>
                      {player.votes}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── The two halves, finally comparable ───────────────────
            On a Words or Questions round this pair is the whole reveal:
            until this moment nobody has seen both cards, which is why the
            near miss between them is the joke the round was built on. */}
        {showWinner && results.normalPrompt && (
          <div className="results-info-cards">
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">CREW CARD</div>
              <div className="reveal-value" style={{ color: 'var(--neon-cyan)' }}>
                &quot;{results.normalPrompt}&quot;
              </div>
            </div>
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">SUSPECT CARD</div>
              <div className="reveal-value" style={{ color: 'var(--neon-magenta)' }}>
                &quot;{results.imposterPrompt}&quot;
              </div>
            </div>
          </div>
        )}

        {showWinner && results.kind === 'score' && results.scores && (
          <div className="brutal-card yellow" style={{ width: '100%', color: '#000' }}>
            <h3
              className="brutal-title"
              style={{ fontSize: '1.5rem', color: '#000', textShadow: 'none', marginBottom: 6 }}
            >
              {results.bluffReveal ? '📖' : results.voiceLine ? '🎙️' : '🎯'}{' '}
              {results.scores[0]?.name?.toUpperCase() ?? 'NOBODY'}
              {results.bluffReveal
                ? ' PLAYED IT BEST'
                : results.voiceLine
                  ? ' NAILED IT'
                  : ' READ THE ROOM'}
            </h3>
            <p style={{ fontWeight: 600 }}>
              {results.scores[0]?.points ?? 0} point
              {(results.scores[0]?.points ?? 0) === 1 ? '' : 's'}
              {results.spectrumTarget !== null ? ` — the target was ${results.spectrumTarget}.` : '.'}
            </p>
          </div>
        )}

        {/* ── Bluff: whose fake was whose ──────────────────────────
            The authors are attached here and nowhere earlier — during the
            ballot the options carry text and an id only. */}
        {showWinner && results.bluffReveal && (
          <div className="bluff-reveal">
            <div className="bluff-reveal-word">
              {results.bluffWord} <span>really means</span>
            </div>
            <ul className="bluff-reveal-list">
              {results.bluffReveal.map((o) => (
                <li key={o.id} className={`bluff-reveal-row${o.isReal ? ' real' : ''}`}>
                  <span className="bluff-reveal-author">{o.authorName}</span>
                  <span className="bluff-reveal-text">{o.text}</span>
                  <span className="bluff-reveal-votes">
                    {o.votes} {o.votes === 1 ? 'vote' : 'votes'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── A scored round has no reveal, it has a table ─────────
            Gated on `kind` rather than on a mode id: a second scoring mode
            must not have to be added to a list of string comparisons. */}
        {/* ── Choicer Voicer: what everyone was performing ─────────
            The line was public all round, so this is a heading rather than a
            reveal. What it does add is the honest footnote about what the
            percentages were measured against — a score against the original
            recording and a score against the room's average are different
            claims, and a table that does not say which is misleading. */}
        {showWinner && results.voiceLine && (
          <div className="voice-reveal">
            <div className="voice-reveal-quote">
              &ldquo;{results.voiceLine.quote}&rdquo;
            </div>
            {results.voiceLine.source && (
              <div className="voice-reveal-source">{results.voiceLine.source}</div>
            )}
            <div className="voice-reveal-note">
              {results.voiceLine.scoredAgainstOriginal
                ? 'SCORED AGAINST THE ORIGINAL RECORDING'
                : 'NO REFERENCE ON FILE — SCORED AGAINST THE ROOM'}
            </div>
          </div>
        )}

        {showWinner && results.kind === 'score' && results.scores && (
          <div className="wl-results">
            {results.spectrum && (
              <div className="wl-results-scale">
                <span className="wl-end left">{results.spectrum.left}</span>
                <div className="wl-track">
                  <div className="wl-target" style={{ left: `${results.spectrumTarget ?? 50}%` }}>
                    <span className="wl-target-flag">{results.spectrumTarget}</span>
                  </div>
                </div>
                <span className="wl-end right">{results.spectrum.right}</span>
              </div>
            )}
            {results.spectrum && (
              <div className="wl-results-clue">
                CLUE: &ldquo;{results.psychicClue ?? '—'}&rdquo;
              </div>
            )}
            <ol className="wl-score-list">
              {results.scores.map((line, i) => (
                <li key={line.playerId} className="wl-score-row">
                  <span className="wl-score-rank">{i + 1}</span>
                  <span className="character-slot wl-score-face">
                    <Avatar code={line.avatar} size={28} />
                  </span>
                  <span className="wl-score-name">
                    {line.name}
                    {line.playerId === results.psychicId ? ' — PSYCHIC' : ''}
                  </span>
                  <span className="wl-score-detail">{line.detail}</span>
                  <span className="wl-score-points">{line.points}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── What they were all drawing ───────────────────────────
            On Fake Artist there is no pair to compare: everyone but one had
            the same word, and the reveal is that word next to whatever the
            fake was working from. Showing the hint too is the point — "they
            only had 'Animals'" is what decides whether a bad stroke was
            guilt or just bad drawing. */}
        {showWinner && results.drawWord && (
          <div className="results-info-cards">
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">THE WORD</div>
              <div className="reveal-value" style={{ color: 'var(--neon-cyan)' }}>
                &quot;{results.drawWord}&quot;
              </div>
            </div>
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">THE FAKE HAD</div>
              <div className="reveal-value" style={{ color: 'var(--neon-magenta)' }}>
                {results.drawTheme ? `"${results.drawTheme}"` : 'NOTHING AT ALL'}
              </div>
            </div>
          </div>
        )}

        {/* ── The two tapes, finally comparable ───────────────────── */}
        {showWinner && results.kind === 'accusation' && !results.normalPrompt && !results.drawWord && (
          <div className="results-info-cards">
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">CREW TAPE RECORDING</div>
              <a
                href={results.normalVideoUrl}
                target="_blank"
                rel="noreferrer"
                className="reveal-value"
                style={{ color: 'var(--neon-cyan)', wordBreak: 'break-all' }}
              >
                &quot;{tapeLabel(results.normalVideoUrl)}&quot;
              </a>
            </div>
            <div className="brutal-card video-reveal-card">
              <div className="reveal-title-tag">SUSPECT TAPE RECORDING</div>
              <a
                href={results.imposterVideoUrl}
                target="_blank"
                rel="noreferrer"
                className="reveal-value"
                style={{ color: 'var(--neon-magenta)', wordBreak: 'break-all' }}
              >
                &quot;{tapeLabel(results.imposterVideoUrl)}&quot;
              </a>
            </div>
          </div>
        )}

        {/* ── Actions ─────────────────────────────────────────────── */}
        {showWinner && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            {/* The round ending puts everyone out of the lobby. This is how
                you get back into the same one, settings and all — whoever
                clicks first re-forms it and takes the host seat. */}
            <button
              id="rejoin-btn"
              className="btn-brutal green"
              disabled={rejoining}
              onClick={handleRejoin}
            >
              {rejoining ? 'REWINDING…' : '⏮ REJOIN LOBBY'}
            </button>
            <button
              id="shop-btn"
              className="btn-brutal yellow"
              onClick={() => router.push('/shop')}
            >
              🛒 SHOP
            </button>
            {/* Tell the server before routing: the socket survives client-side
                navigation, so walking away is not leaving unless we say so. */}
            <button
              id="leave-room-btn"
              className="btn-brutal dark"
              onClick={() => {
                actions.leave(code);
                router.push(homeHref);
              }}
            >
              ⏏ LEAVE
            </button>
          </div>
        )}

        {rejoinError && (
          <div className="word-phase-banner" style={{ display: 'block' }}>
            ⛔ {rejoinError.toUpperCase()}
          </div>
        )}
      </div>
    </div>
  );
}
