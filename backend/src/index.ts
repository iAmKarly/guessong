import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerMessage } from '../../shared/types.ts';
import { config } from '../../shared/config.ts';
import { parseClientMessage } from './protocol.ts';
import { exchangeCode, DiscordAuthError } from './discord.ts';
import { allowGuests, resolvePlayer, IdentityError } from './identity.ts';
import { endIfEveryoneSolved, extendClip, startGame, stopGame, submitGuess } from './game.ts';
import { AudioUnavailableError, audioProvider, redeemClip, setAudioProvider } from './audio.ts';
import { deezerProvider } from './deezer.ts';
import { migrate, pool } from './db.ts';
import { enableRecording, recordPlayer } from './recorder.ts';
import {
  addPlayer,
  getRoom,
  publicState,
  removePlayer,
  setCategory,
  setConnected,
  startBlockedReason,
  type Room,
} from './rooms.ts';

const port = Number(process.env.PORT ?? 3001);

setAudioProvider(deezerProvider);

console.log(
  allowGuests
    ? '[auth] guest players ALLOWED — development only, never expose this publicly'
    : '[auth] Discord sign-in required; guest players are off',
);

// The database is optional, and a problem with it must never stop the game.
if (!pool) {
  console.warn('[db] DATABASE_URL not set — games will not be saved');
} else {
  try {
    await migrate();
    enableRecording();
    console.log('[db] connected — saving games');
  } catch (error) {
    console.error(`[db] ${(error as Error).message} — games will not be saved`);
  }
}

// --- HTTP -------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read a request body, refusing anything oversized. */
async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Body too large');
  }
  return body;
}

async function handleTokenExchange(req: IncomingMessage, res: ServerResponse) {
  try {
    const { code } = JSON.parse(await readBody(req)) as { code?: unknown };
    if (typeof code !== 'string' || code.length === 0 || code.length > 512) {
      json(res, 400, { error: 'Missing or malformed code' });
      return;
    }
    // Only the access token goes back to the client — no refresh token.
    json(res, 200, { access_token: await exchangeCode(code) });
  } catch (error) {
    const known = error instanceof DiscordAuthError;
    console.error('[auth] token exchange failed:', known ? error.message : error);
    json(res, known ? 401 : 400, { error: known ? error.message : 'Bad request' });
  }
}

/** Serve the audio a ticket unlocks. Unknown or expired tickets get a bare 404. */
async function handleClip(token: string, res: ServerResponse) {
  const ticket = /^[\w-]{1,64}$/.test(token) ? redeemClip(token) : null;
  if (!ticket) {
    res.writeHead(404).end();
    return;
  }

  try {
    const clip = await audioProvider.getClip(ticket.song, ticket.start, ticket.duration);
    res.writeHead(200, {
      'content-type': clip.contentType,
      'content-length': clip.data.length,
      'cache-control': 'no-store',
    });
    res.end(clip.data);
  } catch (error) {
    // 503 tells the client the music server is down, rather than our bug.
    const down = error instanceof AudioUnavailableError;
    if (!down) console.error('[audio] clip failed:', error);
    res.writeHead(down ? 503 : 500).end();
  }
}

/** An album cover for the reveal screen, if the provider recognises the URL. */
async function handleArtwork(src: string | null, res: ServerResponse) {
  const art = src ? await audioProvider.getArtwork(src) : null;
  if (!art) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': art.contentType,
    'content-length': art.data.length,
    // Covers never change, and are only ever requested after a reveal.
    'cache-control': 'public, max-age=86400',
  });
  res.end(art.data);
}

const http = createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/health') {
    json(res, 200, { ok: true, rounds: config.rounds });
    return;
  }
  if (pathname === '/api/token' && req.method === 'POST') {
    void handleTokenExchange(req, res);
    return;
  }
  if (pathname === '/api/artwork' && req.method === 'GET') {
    void handleArtwork(searchParams.get('src'), res);
    return;
  }
  if (pathname.startsWith('/api/clip/') && req.method === 'GET') {
    void handleClip(pathname.slice('/api/clip/'.length), res);
    return;
  }
  res.writeHead(404).end();
});

// --- WebSocket --------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/**
 * Which player each socket is acting as. The socket is the only thing we trust
 * to say who it is — a message claiming a player ID is ignored.
 *
 * ponytail: broadcast scans every connection. Fine for a party game; index by
 * room if a single server ever holds thousands of sockets.
 */
type Membership = { room: Room; playerId: string };
const memberships = new Map<WebSocket, Membership>();

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function fail(ws: WebSocket, message: string) {
  send(ws, { type: 'error', message });
}

/** Tell everyone in a room about a problem. */
function failRoom(room: Room, message: string) {
  for (const [ws, membership] of memberships) {
    if (membership.room.id === room.id) fail(ws, message);
  }
}

/** Push fresh state to everyone in a room. Each client gets its own `youId`. */
function broadcast(room: Room) {
  for (const [ws, membership] of memberships) {
    if (membership.room.id !== room.id) continue;
    send(ws, { type: 'state', state: publicState(room, membership.playerId) });
  }
}

async function handleJoin(
  ws: WebSocket,
  roomId: string,
  accessToken: string | null,
  guestName: string | null,
  guestId: string | null,
) {
  let player;
  try {
    player = await resolvePlayer(accessToken, guestName, guestId);
  } catch (error) {
    const known = error instanceof IdentityError || error instanceof DiscordAuthError;
    console.error('[join] identity failed:', known ? error.message : error);
    fail(ws, known ? error.message : 'Could not verify your Discord session');
    return;
  }

  // The same socket joining again as the same player (React runs effects twice
  // in development, and reconnect logic may resend) is a no-op, not a
  // leave-and-rejoin — that would drop the player mid-game.
  const current = memberships.get(ws);
  if (current && current.room.id === roomId && current.playerId === player.id) {
    send(ws, { type: 'state', state: publicState(current.room, player.id) });
    return;
  }

  // Otherwise this socket is switching rooms or identity: leave the old one.
  leave(ws);

  const room = getRoom(roomId);
  const result = addPlayer(room, player);
  if (!result.ok) {
    fail(ws, result.reason);
    return;
  }

  // Back within the grace period: keep the seat, cancel the removal.
  const key = graceKey(room, player.id);
  clearTimeout(graceTimers.get(key));
  graceTimers.delete(key);

  memberships.set(ws, { room, playerId: player.id });
  recordPlayer(player);
  console.log(`[room ${roomId}] ${player.name} joined (${room.players.size})`);
  broadcast(room);
}

/**
 * Dropped players keep their seat for config.reconnectGraceMs. One timer per
 * player per room; rejoining cancels it.
 */
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const graceKey = (room: Room, playerId: string) => `${room.id}\u0000${playerId}`;

/** Whether any other socket is still acting as this player (a second tab). */
function hasOtherConnection(room: Room, playerId: string): boolean {
  return [...memberships.values()].some(
    (other) => other.room.id === room.id && other.playerId === playerId,
  );
}

function removeNow(room: Room, playerId: string) {
  const discarded = removePlayer(room, playerId);
  console.log(`[room ${room.id}] ${playerId} left (${room.players.size})`);

  // Last one out: stop the round timers so an empty room can't keep ticking.
  if (discarded) {
    stopGame(room);
    return;
  }
  // The players left may all have solved the round already.
  if (!endIfEveryoneSolved(room, broadcast)) broadcast(room);
}

/** The player chose to leave: remove them straight away. */
function leave(ws: WebSocket) {
  const membership = memberships.get(ws);
  if (!membership) return;
  memberships.delete(ws);

  const { room, playerId } = membership;
  if (hasOtherConnection(room, playerId)) return;
  clearTimeout(graceTimers.get(graceKey(room, playerId)));
  graceTimers.delete(graceKey(room, playerId));
  removeNow(room, playerId);
}

/** The connection dropped: keep the seat for a while, in case they come back. */
function disconnect(ws: WebSocket) {
  const membership = memberships.get(ws);
  if (!membership) return;
  memberships.delete(ws);

  const { room, playerId } = membership;
  if (hasOtherConnection(room, playerId)) return;

  setConnected(room, playerId, false);
  console.log(`[room ${room.id}] ${playerId} dropped, holding their seat`);
  if (!endIfEveryoneSolved(room, broadcast)) broadcast(room);

  const key = graceKey(room, playerId);
  graceTimers.set(
    key,
    setTimeout(() => {
      graceTimers.delete(key);
      // They may have come back on a new socket and dropped again; only remove
      // them if they're still away.
      if (room.players.get(playerId)?.connected === false) removeNow(room, playerId);
    }, config.reconnectGraceMs),
  );
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = parseClientMessage(data.toString());
    if (!message) {
      fail(ws, 'Unrecognised message');
      return;
    }

    switch (message.type) {
      case 'join':
        void handleJoin(ws, message.roomId, message.accessToken, message.guestName, message.guestId);
        return;

      case 'leave':
        leave(ws);
        return;

      case 'startGame': {
        const membership = memberships.get(ws);
        if (!membership) {
          fail(ws, 'Join a lobby first');
          return;
        }
        const { room, playerId } = membership;
        const blocked = startBlockedReason(room, playerId);
        if (blocked) {
          fail(ws, blocked);
          return;
        }
        // Fetching songs takes a moment; everyone hears about it if it fails.
        void startGame(room, broadcast).then((problem) => {
          if (problem) failRoom(room, problem);
        });
        return;
      }

      case 'setCategory': {
        const membership = memberships.get(ws);
        if (!membership) {
          fail(ws, 'Join a lobby first');
          return;
        }
        const problem = setCategory(membership.room, membership.playerId, message.categoryId);
        if (problem) fail(ws, problem);
        else broadcast(membership.room);
        return;
      }

      case 'search': {
        // Only players in a game can search, which keeps this off the open web.
        if (!memberships.has(ws)) return;
        const { query } = message;
        void audioProvider.search(query).then((results) => {
          send(ws, { type: 'suggestions', query, results });
        });
        return;
      }

      case 'guess': {
        const membership = memberships.get(ws);
        if (!membership) {
          fail(ws, 'Join a lobby first');
          return;
        }
        const outcome = submitGuess(
          membership.room,
          membership.playerId,
          message.text,
          broadcast,
        );
        if (!outcome.ok) fail(ws, outcome.reason);
        else send(ws, { type: 'guessResult', correct: outcome.correct, points: outcome.points });
        return;
      }

      case 'extendClip': {
        const membership = memberships.get(ws);
        if (!membership) {
          fail(ws, 'Join a lobby first');
          return;
        }
        const problem = extendClip(membership.room, membership.playerId, broadcast);
        if (problem) fail(ws, problem);
        return;
      }
    }
  });

  // A dropped connection must never take the server down with it.
  ws.on('close', () => disconnect(ws));
  ws.on('error', (err) => {
    console.error('[ws] socket error', err);
    disconnect(ws);
  });
});

http.listen(port, () => console.log(`Guessong server on http://localhost:${port}`));
