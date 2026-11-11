/**
 * Types shared by the frontend and backend.
 *
 * Rule of thumb: nothing in here may ever contain the correct answer while a
 * round is in progress. The server owns the answer; the client is told after
 * the round ends.
 */

export type GameStatus = 'LOBBY' | 'STARTING' | 'PLAYING' | 'REVEALING' | 'FINISHED';

export type Player = {
  /** Discord user ID, or a server-assigned ID for local dev guests. */
  id: string;
  name: string;
  avatarUrl: string | null;
  score: number;
  /** False while a dropped player is inside their reconnect grace period. */
  connected: boolean;
};

/**
 * Song metadata. The audio itself is never stored here — `audioSource` is a
 * reference the AudioProvider knows how to resolve (Milestone 5).
 */
export type Song = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  audioSource: string | null;
  audioProvider: string;
  /** Full track length in seconds, when known. */
  duration: number | null;
  /** Other names a correct guess may use, e.g. "Twinkle Twinkle". */
  aliases: string[];
};

/**
 * The in-progress round, as seen by one specific player. Deliberately contains
 * no answer and no other player's clip level.
 */
export type RoundState = {
  number: number;
  total: number;
  /** Epoch ms. Clients render a countdown from this; the server enforces it. */
  endsAt: number;
  /** How much of the clip *you* may hear, in seconds. */
  clipDuration: number;
  /** Whether a longer clip is still available to you. */
  canExtend: boolean;
  /** Whether you have already answered correctly this round. */
  solved: boolean;
  /** How many players have solved it, for a bit of tension. */
  solvedCount: number;
  /** Where in the track the clip starts, in seconds. */
  segmentStart: number;
  /**
   * Fetch your clip from /api/clip/<token>. Opaque and random, so it says
   * nothing about the song, and the server only ever serves the clip length
   * you've unlocked — never the full track.
   */
  clipToken: string | null;
};

/** Revealed once the round is over. */
export type Reveal = {
  title: string;
  artist: string;
  artworkUrl: string | null;
  /** The longest clip, so everyone can hear what they were guessing. */
  clipToken: string | null;
  /** Only players who answered correctly, best first. */
  scores: { playerId: string; name: string; points: number }[];
};

/**
 * Everything a client is allowed to know about a room. Built fresh by the
 * server on every change — clients never patch state themselves.
 */
export type RoomState = {
  roomId: string;
  status: GameStatus;
  hostId: string | null;
  players: Player[];
  minPlayers: number;
  maxPlayers: number;
  /** Which of `players` is the recipient of this message. */
  youId: string;
  /** What the next game will play; one of config.categories. Host chooses. */
  categoryId: string;
  /** Epoch ms when round 1 begins, once the songs are ready. For the 3-2-1. */
  countdownEndsAt: number | null;
  /** Present while status is PLAYING. */
  round: RoundState | null;
  /** Present while status is REVEALING. */
  reveal: Reveal | null;
};

// --- WebSocket protocol -----------------------------------------------------
// Both directions use a discriminated union on `type`. The server validates
// every inbound message; see backend/src/protocol.ts.

export type ClientMessage =
  /**
   * `accessToken` is a Discord token the server resolves to a real identity.
   * `guestName` is the local-development path and is only honoured outside
   * production — see backend/src/identity.ts.
   */
  | {
      type: 'join';
      roomId: string;
      accessToken: string | null;
      guestName: string | null;
      /** A local guest's own stable ID, so a refresh rejoins as the same player. */
      guestId: string | null;
    }
  | { type: 'leave' }
  | { type: 'startGame' }
  /** Host only, between games. */
  | { type: 'setCategory'; categoryId: string }
  | { type: 'guess'; text: string }
  /** Trade potential points for a longer clip. */
  | { type: 'extendClip' }
  /** Autocomplete for the guess box. */
  | { type: 'search'; query: string };

/** One autocomplete entry: a song from the whole catalog, not just this game. */
export type Suggestion = { title: string; artist: string };

export type ServerMessage =
  | { type: 'state'; state: RoomState }
  /** Feedback on your own guess. Never reveals the answer. */
  | { type: 'guessResult'; correct: boolean; points: number }
  /** Results for one search. `query` echoes the request, so stale replies can be dropped. */
  | { type: 'suggestions'; query: string; results: Suggestion[] }
  | { type: 'error'; message: string };
