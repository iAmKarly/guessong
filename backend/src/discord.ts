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
