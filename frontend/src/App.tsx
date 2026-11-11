import { useCallback, useEffect, useState } from 'react';

import type { RoomState, ServerMessage, Suggestion } from '@shared/types.ts';
import { startSession, type Session } from './discord.ts';
import { useSocket } from './useSocket.ts';
import { Lobby } from './Lobby.tsx';
import { Round } from './Round.tsx';
import { Reveal, Leaderboard } from './Reveal.tsx';
import { useCountdown } from './useCountdown.ts';

/** How long a server message (like "Slow down") stays on screen. */
const ERROR_VISIBLE_MS = 4_000;


export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Signing in failed; nothing works until it's retried. */
  const [signInError, setSignInError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [suggestions, setSuggestions] = useState<{ query: string; results: Suggestion[] } | null>(null);

  useEffect(() => {
    startSession()
      .then(setSession)
      .catch((cause: unknown) =>
        setSignInError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  // Server messages are momentary; clear them rather than leaving them up.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const onMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'state':
        setRoom(message.state);
        setError(null);
        return;
      case 'guessResult':
        setRejected(!message.correct);
        return;
      case 'suggestions':
        setSuggestions({ query: message.query, results: message.results });
        return;
      case 'error':
        setError(message.message);
        return;
    }
  }, []);

  const { status, send } = useSocket(onMessage);

  // Join once we have both an identity and a live socket. Because this reruns
  // when the socket reopens, a reconnect rejoins automatically.
  useEffect(() => {
    if (!session || status !== 'open') return;
    send({
      type: 'join',
      roomId: session.roomId,
      accessToken: session.accessToken,
      guestName: session.source === 'local' ? session.user.name : null,
      guestId: session.source === 'local' ? session.user.id : null,
    });
  }, [session, status, send]);

  // Clear stale "not it" feedback when the round changes.
  useEffect(() => setRejected(false), [room?.round?.number, room?.status]);

  const onStart = useCallback(() => send({ type: 'startGame' }), [send]);
  const onCategory = useCallback(
    (categoryId: string) => send({ type: 'setCategory', categoryId }),
    [send],
  );
  const onExtend = useCallback(() => send({ type: 'extendClip' }), [send]);
  const onSearch = useCallback((query: string) => send({ type: 'search', query }), [send]);
  const onGuess = useCallback(
    (text: string) => {
      setRejected(false);
      send({ type: 'guess', text });
    },
    [send],
  );

  // The big logo is for the lobby; in game it shrinks out of the way.
  const inGame = room !== null && room.status !== 'LOBBY';

  return (
    <main className="app">
      {/* Only after we'd connected once: the very first connect isn't "lost". */}
      {status !== 'open' && room && (
        <div className="banner" role="status">
          Connection lost — reconnecting…
        </div>
      )}

      <h1 className={inGame ? 'logo logo--small' : 'logo'}>
        <span aria-hidden="true">🎵</span> GUESSONG
      </h1>

      {/* Keyed by screen, so each one animates in when it appears. */}
      <div className="screen" key={`${room?.status}-${room?.round?.number ?? ''}`}>
        {screen()}
      </div>

      <p className="error" role="alert">
        {error}
      </p>
    </main>
  );

  function screen() {
    if (signInError) {
      return (
        <div className="card">
          <p className="error">{signInError}</p>
          <button onClick={() => location.reload()}>Try again</button>
        </div>
      );
    }
    if (!room) {
      return (
        <div className="card">
          <p className="muted">
            {!session ? 'Signing in…' : status === 'open' ? 'Joining lobby…' : 'Connecting…'}
          </p>
        </div>
      );
    }

    switch (room.status) {
      case 'LOBBY':
        return <Lobby state={room} onStart={onStart} onCategory={onCategory} />;

      case 'STARTING':
        return <Countdown endsAt={room.countdownEndsAt} />;

      case 'PLAYING':
        return room.round ? (
          <Round
            round={room.round}
            rejected={rejected}
            onGuess={onGuess}
            onExtend={onExtend}
            suggestions={suggestions}
            onSearch={onSearch}
          />
        ) : null;

      case 'REVEALING':
        return room.reveal ? <Reveal reveal={room.reveal} youId={room.youId} /> : null;

      case 'FINISHED':
        return (
          <Leaderboard
            players={room.players}
            youId={room.youId}
            isHost={room.youId === room.hostId}
            categoryId={room.categoryId}
            onPlayAgain={onStart}
            onCategory={onCategory}
          />
        );
    }
  }
}

/** "Loading songs…" while the server fetches them, then 3, 2, 1. */
function Countdown({ endsAt }: { endsAt: number | null }) {
  const remaining = useCountdown(endsAt ?? 0);
  return (
    <div className="card countdown">
      {endsAt === null ? (
        <p className="countdown__text">Loading songs…</p>
      ) : (
        // Keyed by the number, so each one pops in.
        <p className="countdown__number" key={remaining}>
          {Math.max(1, remaining)}
        </p>
      )}
    </div>
  );
}
