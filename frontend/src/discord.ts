import { DiscordSDK } from '@discord/embedded-app-sdk';

import { apiUrl } from './paths.ts';

export type Session = {
  user: { id: string; name: string; avatarUrl: string | null };
  /** 'local' means we're in a plain browser tab, not inside Discord. */
  source: 'discord' | 'local';
  /**
   * The room to join. Inside Discord this is the voice channel, so everyone who
   * launches the Activity together lands in the same lobby. Locally it's a
   * fixed value, so two browser tabs can play each other.
   */
  roomId: string;
  /** Passed to the server so it can verify who we are. Null for local guests. */
  accessToken: string | null;
};

/** Discord always launches the Activity iframe with a frame_id query param. */
export const isInDiscord = new URLSearchParams(location.search).has('frame_id');

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;

export async function startSession(): Promise<Session> {
  if (!isInDiscord) return localSession();

  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set in .env');

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // The iframe can only get a one-time code; only our server holds the secret
  // needed to turn it into a token.
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });

  const response = await fetch(apiUrl('/api/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
  const { access_token } = (await response.json()) as { access_token: string };

  const auth = await sdk.commands.authenticate({ access_token });
  if (!auth) throw new Error('Discord declined to authenticate this session');

  const { user } = auth;
  return {
    user: {
      id: user.id,
      name: user.global_name ?? user.username,
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : null,
    },
    source: 'discord',
    // The lobby is the Activity instance: Discord gives everyone who launched
    // it together the same random, unguessable ID — a lobby code nobody has to
    // type. (Channel IDs would work too, but they're easy to look up.)
    roomId: sdk.instanceId,
    accessToken: access_token,
  };
}

/**
 * Outside Discord we invent a player so `npm run dev` stays usable in a normal
 * browser tab. Persisted per tab, so two tabs are two players.
 */
function localSession(): Session {
  // `?guest=alice` pins the identity to the URL, so reopening the same URL
  // rejoins as the same player even in browsers that forget closed tabs.
  const pinned = new URLSearchParams(location.search).get('guest')?.replace(/[^\w-]/g, '').slice(0, 24);
  if (pinned) {
    return {
      user: { id: `named-${pinned}`.padEnd(8, '-'), name: pinned, avatarUrl: null },
      source: 'local',
      roomId: 'local',
      accessToken: null,
    };
  }

  const stored = sessionStorage.getItem('guessong:localUser');
  if (stored) return JSON.parse(stored) as Session;

  const id = crypto.randomUUID();
  const session: Session = {
    user: { id, name: `Guest ${id.slice(0, 4)}`, avatarUrl: null },
    source: 'local',
    roomId: 'local',
    accessToken: null,
  };
  sessionStorage.setItem('guessong:localUser', JSON.stringify(session));
  return session;
}
