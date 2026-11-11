import type { GameStatus, Player, Reveal, RoomState, Song } from '../../shared/types.ts';
import { config } from '../../shared/config.ts';

/** The live round. Holds the answer, so none of it is sent to clients directly. */
export type RoundRuntime = {
  /** Database ID, generated here so recording never has to wait on Postgres. */
  id: string;
  number: number;
  song: Song;
  segmentStart: number;
  startedAt: number;
  endsAt: number;
  /** Index into config.clipDurations, per player. */
  clipLevel: Map<string, number>;
  /** Each player's ticket for the clip length they've unlocked. */
  clipTokens: Map<string, string>;
  /** Guess count this round, per player — the rate limit. */
  attempts: Map<string, number>;
  /** Normalised guesses already made, per player, so repeats are ignored. */
  tried: Map<string, Set<string>>;
  /** When each player last guessed, for the cooldown. */
  lastGuessAt: Map<string, number>;
  /** Points earned this round by players who got it, in solve order. */
  solved: Map<string, number>;
};

/**
 * Authoritative room state. Clients get a rebuilt snapshot on every change and
 * never patch anything themselves.
 *
 * ponytail: in memory only. A restart drops every game, which is fine for a
 * party game — move rooms to Postgres/Redis only if we ever run more than one
 * server process.
 */
export type Room = {
  id: string;
  status: GameStatus;
  hostId: string | null;
  /** Insertion-ordered, which is what makes host succession predictable. */
  players: Map<string, Player>;
  categoryId: string;
  /** Database ID of the game in progress, if any. */
  gameId: string | null;
  countdownEndsAt: number | null;
  /** The playlist for the current game, one song per round. */
  songs: Song[];
  round: RoundRuntime | null;
  reveal: Reveal | null;
  /** Whatever the game is waiting on next: round end, or reveal end. */
  timer: ReturnType<typeof setTimeout> | null;
};

const rooms = new Map<string, Room>();

export function getRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      status: 'LOBBY',
      hostId: null,
      players: new Map(),
      categoryId: config.categories[0].id,
      gameId: null,
      countdownEndsAt: null,
      songs: [],
      round: null,
      reveal: null,
      timer: null,
    };
    rooms.set(id, room);
  }
  return room;
}

export function roomCount(): number {
  return rooms.size;
}

/** Test seam — rooms are process-global otherwise. */
export function resetRooms(): void {
  for (const room of rooms.values()) if (room.timer) clearTimeout(room.timer);
  rooms.clear();
}

export type JoinResult = { ok: true } | { ok: false; reason: string };

export function addPlayer(room: Room, player: Player): JoinResult {
  const returning = room.players.has(player.id);

  // Latecomers are welcome mid-game; they play from the next round (see
  // game.ts, which only lets players who were there when a round began guess).
  if (!returning && room.players.size >= config.maxPlayers) {
    return { ok: false, reason: `This lobby is full (${config.maxPlayers} players)` };
  }

  // Rejoining (refresh, reconnect, second tab) must not reset a score.
  const existing = room.players.get(player.id);
  room.players.set(player.id, {
    ...player,
    score: existing?.score ?? player.score,
    connected: true,
  });
  room.hostId ??= player.id;
  return { ok: true };
}

/** Returns true when the room was discarded, so callers can stop its timers. */
export function removePlayer(room: Room, playerId: string): boolean {
  room.players.delete(playerId);

  if (room.players.size === 0) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    rooms.delete(room.id);
    return true;
  }

  // The host leaving promotes whoever joined earliest of those remaining.
  if (room.hostId === playerId) {
    room.hostId = room.players.keys().next().value ?? null;
  }
  return false;
}

/**
 * Whether `playerId` may start this room's game. Returns an error message, or
 * null when it's allowed.
 */
export function startBlockedReason(room: Room, playerId: string): string | null {
  if (room.hostId !== playerId) return 'Only the host can start the game';
  if (room.status !== 'LOBBY' && room.status !== 'FINISHED') {
    return 'The game is already running';
  }
  if (connectedPlayers(room).length < config.minPlayers) {
    return `You need at least ${config.minPlayers} players`;
  }
  return null;
}

/** Players currently online. Dropped players in their grace period don't count. */
export function connectedPlayers(room: Room): Player[] {
  return [...room.players.values()].filter((player) => player.connected);
}

/** Mark a player as dropped (keeping their seat) or back. */
export function setConnected(room: Room, playerId: string, connected: boolean): void {
  const player = room.players.get(playerId);
  if (player) player.connected = connected;
}

/** Host only, and only between games. Returns an error message, or null. */
export function setCategory(room: Room, playerId: string, categoryId: string): string | null {
  if (room.hostId !== playerId) return 'Only the host can choose the category';
  if (room.status !== 'LOBBY' && room.status !== 'FINISHED') return 'Wait for this game to finish';
  if (!config.categories.some((category) => category.id === categoryId)) return 'Unknown category';
  room.categoryId = categoryId;
  return null;
}

export function publicState(room: Room, youId: string): RoomState {
  return {
    roomId: room.id,
    status: room.status,
    hostId: room.hostId,
    players: [...room.players.values()],
    minPlayers: config.minPlayers,
    maxPlayers: config.maxPlayers,
    youId,
    categoryId: room.categoryId,
    countdownEndsAt: room.countdownEndsAt,
    round: room.round ? roundView(room.round, youId) : null,
    reveal: room.reveal,
  };
}

/** The round as one player may see it: no answer, no one else's clip level. */
function roundView(round: RoundRuntime, youId: string) {
  const level = round.clipLevel.get(youId) ?? 0;
  return {
    number: round.number,
    total: config.rounds,
    endsAt: round.endsAt,
    clipDuration: config.clipDurations[level] ?? config.clipDurations[0]!,
    canExtend: level < config.clipDurations.length - 1,
    solved: round.solved.has(youId),
    solvedCount: round.solved.size,
    segmentStart: round.segmentStart,
    clipToken: round.clipTokens.get(youId) ?? null,
  };
}
