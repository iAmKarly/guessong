/**
 * Discord OAuth2, kept in one file so the rest of the server never touches
 * tokens or secrets.
 *
 * The client can only ever obtain an authorization *code* — exchanging it for
 * an access token requires the client secret, which lives here and is never
 * sent to the browser.
 */

const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';

export type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
};

export class DiscordAuthError extends Error {}

function credentials() {
  const clientId = process.env.VITE_DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new DiscordAuthError(
      'VITE_DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set in .env',
    );
  }
  return { clientId, clientSecret };
}

/** Swap a one-time authorization code for an access token. */
export async function exchangeCode(code: string): Promise<string> {
  const { clientId, clientSecret } = credentials();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  });

  if (!response.ok) {
    // Discord's error body can echo request details; keep it out of our logs.
    throw new DiscordAuthError(`Discord rejected the code exchange (${response.status})`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new DiscordAuthError('Discord returned no access token');
  return data.access_token;
}

/**
 * Resolve an access token to a user. This is how the server learns who someone
 * is — a client claiming an identity is never enough.
 */
export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch(USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new DiscordAuthError(`Invalid access token (${response.status})`);
  return (await response.json()) as DiscordUser;
}

// --- Activity instances -------------------------------------------------------

/**
 * Whether the server can check lobby membership with Discord. Needs the app's
 * bot token (Developer Portal → Bot → Reset Token). Without it, a client's word
 * about which Activity instance it's in is taken on trust.
 */
export function canVerifyInstances(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.VITE_DISCORD_CLIENT_ID);
}

/**
 * Who's in each instance, briefly cached so a lobby filling up doesn't mean
 * one Discord request per player.
 */
const INSTANCE_CACHE_MS = 5_000;
const instances = new Map<string, { users: Set<string>; fetchedAt: number }>();

async function instanceUsers(instanceId: string, fresh: boolean): Promise<Set<string> | null> {
  const cached = instances.get(instanceId);
  if (!fresh && cached && Date.now() - cached.fetchedAt < INSTANCE_CACHE_MS) return cached.users;

  const url =
    `https://discord.com/api/v10/applications/${process.env.VITE_DISCORD_CLIENT_ID}` +
    `/activity-instances/${encodeURIComponent(instanceId)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null; // No such instance.
  if (!response.ok) throw new DiscordAuthError(`Discord instance lookup failed (${response.status})`);

  const { users } = (await response.json()) as { users?: unknown };
  const set = new Set(Array.isArray(users) ? users.filter((id): id is string => typeof id === 'string') : []);
  instances.set(instanceId, { users: set, fetchedAt: Date.now() });
  if (instances.size > 1_000) instances.delete(instances.keys().next().value!);
  return set;
}

/** How long to wait before re-checking someone who has only just launched. */
const JUST_LAUNCHED_RETRY_MS = 1_500;

/**
 * Whether Discord says this user is in this Activity instance. Someone who has
 * just launched may not be listed yet, so a miss is re-checked once.
 */
export async function isInInstance(instanceId: string, userId: string): Promise<boolean> {
  if ((await instanceUsers(instanceId, false))?.has(userId)) return true;
  await new Promise((resolve) => setTimeout(resolve, JUST_LAUNCHED_RETRY_MS));
  return (await instanceUsers(instanceId, true))?.has(userId) ?? false;
}

/** Test seam. */
export function resetInstances(): void {
  instances.clear();
}
