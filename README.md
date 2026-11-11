# Guessong

A Discord Activity where players hear a fraction of a second of a song and race to name it.

**Status: Milestone 5 (audio).** A full, playable game with real songs: lobby →
countdown → 10 rounds of guessing clips from the host's chosen category → answer reveal → final
leaderboard. Saving games to Postgres is built but switched off until Milestone 8 (see
"Database" below).

---

## Requirements

- **Node 24+** — the backend runs TypeScript directly via Node's built-in type stripping,
  so there is no build step, no `tsx`, and no `ts-node`.
- npm 10+

## Setup

```bash
npm install
cp .env.example .env   # see below if .env.example is missing
npm run dev
```

Then open <http://localhost:3000>. You should see the Guessong logo, a generated
"Guest" identity, and a green **Connected** badge. Outside Discord the app invents a
local player so ordinary browser development keeps working.

**Open a second tab to test multiplayer.** Local guests all join the same room, and each
tab gets its own identity, so two tabs are two players — enough to see the player list
sync and the Start button unlock.

To keep a fixed identity, add a name to the address (development only; see Security): <http://localhost:3000/?guest=alice>
and <http://localhost:3000/?guest=bob>. Reopening the same address rejoins as the same
player, even in browsers that forget a closed tab (such as VS Code's).

### `.env`

`.env` holds your settings and secrets and is never committed. `.env.example` lists every
variable; copy it, then fill in what you need:

```bash
# Backend
PORT=3001

# Discord, from the Developer Portal. Only needed inside Discord.
DISCORD_CLIENT_SECRET=
VITE_DISCORD_CLIENT_ID=

# Your cloudflared tunnel hostname, no https://. Only needed inside Discord.
TUNNEL_HOST=

# Lets the server check with Discord who is in each Activity session.
# Developer Portal → Bot → Reset Token. Secret, like the client secret.
DISCORD_BOT_TOKEN=

# Postgres. Leave empty until Milestone 8; see "Database" below.
POSTGRES_PASSWORD=
DATABASE_URL=
```

A single `.env` at the repo root feeds both workspaces. Two browser tabs work with none of
it filled in.

## Database (set up in Milestone 8)

The code to save every game, round and guess is in place and tested, but **you don't need
to set anything up yet**. With no `DATABASE_URL` the game runs exactly the same, it just
doesn't save anything, and the server says so once at startup.

Setting it up is part of Milestone 8 (deployment), alongside a hosted database. These are
the steps when that time comes, or earlier if you want to start collecting play data on
your machine:

1. Add these to your `.env` (pick any password; it never leaves your machine):

   ```bash
   POSTGRES_PASSWORD=pick-a-local-password
   DATABASE_URL=postgres://guessong:pick-a-local-password@localhost:5432/guessong
   ```

2. Start Postgres (needs Docker Desktop running):

   ```bash
   docker compose up -d
   ```

3. Restart `npm run dev`. Migrations apply automatically; you'll see
   `[db] connected — saving games`.

**Migrations** are plain SQL files in `database/migrations/`, applied in file-name order
and tracked in a `schema_migrations` table. To change the schema, add a new
higher-numbered file; never edit one that has already run. `docker compose down -v`
wipes the database if you want a clean slate.

**If the database is down,** the game keeps working; failed writes are logged
(`[db] write failed`) and dropped. Saving never slows a round down.

### What's saved

| Table | One row per |
| --- | --- |
| `players` | Discord user (or local guest), updated each time they join |
| `songs` | song that has been played |
| `games` | game: room, category, host, start and finish time |
| `rounds` | round: which song, where the clip started, when it ran |
| `guesses` | **every** guess, right or wrong: the answer, whether it was correct, how long it took, how much clip the player had unlocked, and the points |

`guesses` is the training data. For example, how recognisable each song's segment was:

```sql
SELECT s.title, r.segment_start,
       avg(g.correct::int)        AS hit_rate,
       avg(g.response_time_ms)    AS avg_ms,
       avg(g.clip_duration)       AS avg_clip_needed
FROM guesses g
JOIN rounds r ON r.id = g.round_id
JOIN songs  s ON s.id = r.song_id
GROUP BY s.title, r.segment_start
ORDER BY hit_rate DESC;
```

Connect with `docker compose exec postgres psql -U guessong` to run queries like that.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend (:3001) and frontend (:3000) together, both hot-reloading |
| `npm run serve` | Exactly what production runs: builds the frontend, and the backend serves it all on :3000. Use this for testing inside Discord — see below |
| `npm start` | Start the backend alone, serving whatever was last built. What the host runs |
| `npm run dev:backend` / `npm run dev:frontend` | One at a time |
| `npm test` | Backend tests (`node --test`, no test framework dependency) |
| `npm run typecheck` | `tsc --noEmit` over both workspaces |
| `npm run build` | Production frontend bundle into `frontend/dist/` |

## Running inside Discord

Discord loads your Activity in a sandboxed iframe served from
`https://<app-id>.discordsays.com`. It cannot reach `localhost`, so during development
you expose the Vite dev server through a public HTTPS tunnel and point Discord at it.
Only the **frontend** is tunnelled — Vite proxies `/.proxy/*` through to the backend,
so one tunnel and one URL mapping cover everything.

### One-time: create the app

1. Go to <https://discord.com/developers/applications> → **New Application**, name it
   Guessong.
2. **General Information** → copy the **Application ID**. This is your
   `VITE_DISCORD_CLIENT_ID`.
3. **OAuth2** → **Reset Secret** → copy it into `DISCORD_CLIENT_SECRET` in `.env`.
   Treat it like a password; it never reaches the browser.
4. **OAuth2** → **Redirects** → add `https://127.0.0.1`. The embedded flow doesn't
   redirect anywhere, but Discord refuses to issue codes unless at least one redirect
   URI exists.
5. **Activities** → enable Activities for the app. (Depending on the portal version
   this is an "Enable Activities" button or a toggle under **Activities → Settings**.)
6. **Installation** → enable **Guild Install** with the `applications.commands` scope,
   then open the generated install link and add the app to your server. Enabling
   Activities alone does *not* put the app in any server's activity picker — this step
   is what makes it appear.

### Two things that will bite you

**Use `npm run serve`, not `npm run dev`, for in-Discord testing.** Vite's dev server
relies on `eval` and inline scripts for HMR, and Discord's iframe CSP blocks both. The
activity will fail to load with CSP errors in the console. `npm run serve` builds the
frontend and has the backend serve it, exactly like production. There's no hot reload,
so re-run it after changes.

**Discord strips the `/.proxy` prefix before forwarding to your host.** The client
always requests `/.proxy/api/...` (see `frontend/src/paths.ts`), but the request can
arrive as either `/.proxy/api/...` or `/api/...`. Both forms must work. In production
the backend strips the prefix (`stripProxyPrefix` in `backend/src/static.ts`); in
development the Vite proxy matches both, so don't "simplify" those duplicate-looking
entries in `vite.config.ts`.

### Each dev session: tunnel and map

1. Install a tunnel. `brew install cloudflared` — you have neither cloudflared nor
   ngrok right now.
2. Start the app, then the tunnel:

   ```bash
   npm run serve                                  # build + serve, Discord-safe
   cloudflared tunnel --url http://localhost:3000
   ```

   It prints a hostname like `abc-def-ghi.trycloudflare.com`.
3. Put that hostname in `.env` as `TUNNEL_HOST` (no `https://`, no trailing slash) and
   restart. Vite reads `.env` at config time via `loadEnv` — it does *not* reach
   `process.env` on its own, which is why the value must be read explicitly in
   `vite.config.ts`.
4. Developer Portal → **Activities** → **URL Mappings** → set the root mapping:

   | Prefix | Target |
   | --- | --- |
   | `/` | `abc-def-ghi.trycloudflare.com` |

   Target is a bare hostname — no scheme, no path.
5. Save, then in any Discord voice channel open the activity picker (the rocket icon)
   and launch Guessong. Unpublished apps are visible to you as the owner; add friends
   under **App Testers** to let them in.

You should see your real Discord name and avatar, and a green **Connected** badge.

**The annoyance to know about:** a free cloudflared quick tunnel gets a new random
hostname every restart, so steps 3–4 repeat each time. A named cloudflared tunnel or a
reserved ngrok domain gives you a stable hostname and makes this one-time. Worth doing
if you'll be iterating for more than an afternoon.

### If it doesn't load

- **Blank iframe, CSP errors in console** — you're running `npm run dev`. Use
  `npm run serve`.
- **404 on `/api/token`** — the `/.proxy` prefix handling in `vite.config.ts` got
  narrowed. It must match both the prefixed and unprefixed forms.
- **401 on `/api/token`** — `DISCORD_CLIENT_SECRET` or `VITE_DISCORD_CLIENT_ID` is
  missing from `.env`, or the app ID doesn't match the app you launched. The backend
  logs `[auth] token exchange failed` with a reason.
- **App not in the activity picker** — the app isn't installed to that server. See
  step 6 above.
- **Requests 404 generally** — something is fetching a path without going through
  `frontend/src/paths.ts`. Never build a URL by hand.
- **Avatars missing** — `cdn.discordapp.com` is being blocked by the sandbox CSP. Add a
  second URL mapping (prefix `/cdn`, target `cdn.discordapp.com`) and route avatars
  through it.
- **"VITE_DISCORD_CLIENT_ID is not set"** — Vite reads `.env` at startup only; restart
  `npm run dev` after editing it.

I could not reach Discord's documentation from this machine, so the portal labels above
are from memory and the UI moves around. The concepts (app ID, secret, Activities
enabled, app installed to the server, root URL mapping to your tunnel) are stable; if a
label doesn't match, look for the nearest equivalent.

## Deploying

Production is **one always-on service**: the backend serves the built frontend, the API
and the WebSocket from a single address. It must be exactly one instance, because live
games are held in memory. Free tiers that put the server to sleep would drop every game
in progress, so don't use them.

The repo is set up for [Railway](https://railway.com) (`railway.json`): it builds with
`npm ci --include=dev && npm run build`, starts with `npm start`, checks `/health`, and
pins one replica. Node 24 comes from `engines` in `package.json`. Any host that runs a
Node 24 web service with WebSockets works the same way.

### Railway, step by step

1. **Create the project.** railway.com → New Project → Deploy from GitHub repo →
   `iAmKarly/guessong`. Railway reads `railway.json` and deploys on every push to `main`.
2. **Add Postgres.** In the project, New → Database → PostgreSQL. Railway creates a
   `DATABASE_URL`; reference it from the app service (Variables → Add Reference →
   `DATABASE_URL`). Migrations run automatically on start.
3. **Set the variables** on the app service:

   | Variable | Value |
   | --- | --- |
   | `VITE_DISCORD_CLIENT_ID` | Your Discord Application ID. Needed at **build** time too, since it's baked into the frontend |
   | `DISCORD_CLIENT_SECRET` | From the Developer Portal, OAuth2 |
   | `DISCORD_BOT_TOKEN` | From the Developer Portal, Bot → Reset Token |
   | `DATABASE_URL` | The reference from step 2 |

   Railway sets `PORT` itself. Do **not** set `ALLOW_GUESTS`.
4. **Get an address.** App service → Settings → Networking → Generate Domain. You get
   something like `guessong-production.up.railway.app`.
5. **Check it's alive:** open `https://<your-domain>/health`; it should say `"ok":true`.
   The deploy logs should show `[db] connected — saving games`, `[auth] Discord sign-in
   required` and `[auth] lobby membership checked with Discord`.

### Pointing Discord at it

In the Developer Portal → Activities → **URL Mappings**, change the root mapping's target
from your tunnel to the Railway domain: prefix `/`, target
`guessong-production.up.railway.app` (no `https://`). Save, fully quit Discord
(Cmd+Q), reopen and launch. The tunnel is no longer needed, except for testing local
changes before you push.

To let friends play while the app is unpublished, add them under **App Testers**. The
app stays out of Discord's App Directory until you choose to submit it, and you should
settle the music licensing question (see "Audio and licensing") before doing that.

### On every deploy

Pushing to `main` redeploys. The old server shuts down cleanly (it finishes database
writes first), but **games in progress end**: players see "Connection lost", reconnect
to the new server, and land in a fresh lobby. Deploy when nobody's mid-game.

## Layout

```
guessong/
├─ shared/        types.ts, config.ts — imported by both sides, no build step
├─ database/      migrations/ — numbered SQL files
├─ docker-compose.yml  local Postgres
├─ railway.json   how Railway builds, starts and health-checks the app
├─ backend/       Node + ws. Authoritative game state lives here.
│  └─ src/        index.ts     server + socket glue
│                 game.ts      state machine, timers, round rules
│                 rooms.ts     room and lobby state
│                 scoring.ts   the points formula, pure
│                 matching.ts  guess normalising and comparison
│                 segments.ts  which part of a song to play
│                 audio.ts     AudioProvider interface, clip tickets, clip cutting
│                 deezer.ts    real songs from Deezer's public API
│                 db.ts        Postgres connection + migration runner
│                 recorder.ts  saves games, rounds and guesses
│                 static.ts    serves the built frontend in production
│                 identity.ts  who a player is
│                 protocol.ts  inbound message validation
│                 discord.ts   OAuth
├─ frontend/      Vite + React. Renders server state; decides nothing itself.
│  └─ src/        App.tsx (screen routing), Lobby.tsx, Round.tsx, GuessBox.tsx, Reveal.tsx,
│                 useSocket.ts, useClip.ts, useCountdown.ts, discord.ts, paths.ts,
│                 styles.css
└─ tsconfig.base.json
```

### How a game runs

```
LOBBY -> STARTING -> PLAYING -> REVEALING -> PLAYING -> ... -> FINISHED
```

`backend/src/game.ts` owns every transition and every timer. Clients are told what
happened; they never decide it. Round ends early once everyone has solved it.

**Scoring** (`scoring.ts`, pure and isolated so it's easy to retune) rewards three
things: being right (200 base), being fast (up to 300), and needing less of the clip
(up to 200). Maximum 700 in a round.

**Clip length is per player.** Everyone hears the same segment of the same song, but
each player chooses how much of it to hear. Pressing "hear more" walks up
`config.clipDurations` and costs you points. The server tracks each player's level, and
`publicState` only ever tells you your own.

**Audio never reveals the answer.** When a round starts, each player gets a random
*ticket* for their current clip length, and fetches `/api/clip/<ticket>`. The server
knows what a ticket unlocks (song, start, duration) and serves exactly that slice of
audio, so the URL says nothing about the song, and a client can't ask for more of the
track than it has unlocked. Pressing "hear more" issues a new, longer ticket. Tickets
expire a few seconds after their round.

**Guessing** (`matching.ts`) forgives what people actually type. Case, punctuation,
accents and "the" don't matter. The artist is optional and can come first or last.
"(feat. X)" and catalog suffixes like "- Remastered 2011" are optional. A few typos are
forgiven, scaled to the title's length: none for titles of 4 characters or fewer (so
"slay" doesn't count for "Stay"), 1 up to 8, 2 up to 15, then 3.

**Autocomplete.** As you type, the guess box suggests songs from **all of Deezer**, not
from this game, so the list never gives the answer away. Type an artist to see their
songs, or part of a title. Picking a suggestion submits it as a guess; typing and
pressing Enter works too. Searches go over the game's WebSocket, so only players in a
game can search, and the server caps how often it calls Deezer overall.

**Spam protection.** Guesses closer than 300 ms apart are refused, the same wrong guess
twice doesn't use up an attempt, and each player gets 8 attempts per round.

**Reconnecting.** A dropped connection (a refresh, Wi-Fi blip, laptop lid) doesn't cost
you your game. You keep your seat and score for 30 seconds (`reconnectGraceMs`), shown
as "reconnecting" to everyone else, and the app rejoins automatically. Choosing to leave
removes you straight away. While you're away, the round doesn't wait for you: once
everyone still online has answered, it ends. Local guests keep the same identity across
a refresh. Someone joining mid-game (late to the voice channel, say) gets in
straight away, and plays from the next round.

**Every tunable lives in `shared/config.ts`** — round count, clip durations, timers,
guess limits. Nothing is hard-coded elsewhere.

### Why it's built this way

- **npm workspaces, no monorepo tool.** Two packages don't need Turbo or Nx.
- **`shared/` is a plain folder, not a package.** The backend imports it by relative
  path, the frontend through the `@shared` Vite alias. No publishing, no `dist/`,
  no symlink games.
- **Node runs the TypeScript.** Node 24 strips types natively. The cost is that
  `enum`, `namespace`, and constructor parameter properties are unavailable —
  `erasableSyntaxOnly` in `tsconfig.base.json` makes the compiler catch that for you.
- **The client talks to origin-relative URLs.** Everything goes through
  `frontend/src/paths.ts`, and Vite proxies it to the backend. A Discord Activity runs
  in a sandboxed iframe where network traffic is rewritten through `/.proxy/`, so
  avoiding hard-coded hosts means the same client code works in both places.
- **`@types/node` is pinned exactly.** The configured npm registry mirror does not
  carry every published tarball; `24.10.1` is one it has. Bump it deliberately.
- **`scripts/normalize-lockfile.mjs` runs on every install.** Installing behind a
  private registry mirror writes that mirror's hostname into `package-lock.json`.
  The script rewrites every `resolved` URL back to the public npm registry, so no
  internal infrastructure hostnames reach version control and the lock file works
  for anyone who clones it. Tarballs are identical across mirrors, so the integrity
  hashes stay valid.

### Security posture

The server is the only authority. It will own the current round, the correct answer,
the timer, and every score. `backend/src/protocol.ts` is the trust boundary: unknown
or oversized messages are rejected without throwing. The answer is never sent to a
client before a round ends.

All Discord OAuth lives in `backend/src/discord.ts`. The browser only ever handles a
one-time authorization code and a short-lived access token; the client secret stays on
the server, and the refresh token is discarded rather than returned to the client.

**Nobody can sign in as someone else.** There's no login system: inside Discord, the
server checks each player's Discord token with Discord's API and takes the ID and name
from Discord's answer, so a client can't claim to be anyone else. The socket, not the
message, decides which player a request acts as.

**Guest players are for development only.** Guests name themselves (that's what makes
two-tab testing and `?guest=alice` work), so they'd let anyone join as anyone. They're
**opt-in**: only `npm run dev` sets `ALLOW_GUESTS=1`. `npm run serve`, `npm start` and
any deployment refuse them, and the server prints which mode it's in at startup. Never
expose `npm run dev` through a tunnel.

**Lobbies are Discord Activity instances.** Everyone who launches the Activity together
shares Discord's random, unguessable instance ID, and that's the lobby: a lobby code
nobody has to type. With `DISCORD_BOT_TOKEN` set, the server also **asks Discord who is
in each instance** before letting a player into its lobby, so nobody can join a session
they weren't part of, even if they learned its ID. Without the bot token, the client's
word is taken on trust, and the server says so at startup. Set it for any real
deployment.

## Tests

```bash
npm test
```

Covers the config invariants, message validation, name sanitising, guess matching, the
scoring formula, the lobby rules that break quietly (host succession, full lobbies
admitting reconnecting players, who may start), and the whole round state machine driven
by mock timers, plus the audio: Deezer response parsing, WAV output, clip lengths, segment
bounds, ticket expiry, categories, and what happens when the music server is down. And the
database: the real migrations and recorder run against `pg-mem`, an in-memory Postgres
emulator, by playing a whole game and checking every row. 105 tests, no Docker, no
network.

One test exists specifically to catch the worst possible bug: it serialises the
mid-round client state and asserts the song title does not appear anywhere in it.

The socket glue in `index.ts` (broadcast, multi-tab handling, the reconnect grace timer)
has no automated test. Verify it with two browser tabs: refresh one mid-game and it
should come back with its score.

## Audio and licensing

Songs come from **Deezer's public API** (`backend/src/deezer.ts`): no account and no
API key, and a 30-second preview for almost every track. Each game draws 10 songs from
a category the host picks (see below).

How a clip gets to a player:

1. When a game starts, the server fetches the chart, then downloads and decodes each
   song's 30-second MP3 preview during the countdown.
2. Each player gets a ticket for the clip length they've unlocked. The server cuts
   exactly that slice from the preview and serves it as a WAV.
3. Players never receive the preview URL, the full preview, or anything that names the
   song. The URL check in `deezer.ts` also means the server only ever downloads from
   Deezer's CDN.

**If Deezer can't be reached,** starting a game fails with "Music server is down" and
the room goes back to the lobby; the host can press Start again once it's back. A clip
that fails mid-game shows the same message, and players can keep guessing. There is no
fallback music source, by design.

**Categories.** The host picks one in the lobby (or on the final leaderboard, between
games): top hits right now, a decade from the 80s to the 2020s, or pop, rock, hip-hop or
dance. "Top hits" is Deezer's live chart. Every other category *searches* Deezer for a
playlist, such as "2000s hits", preferring Deezer's own editorial playlists, so nothing
breaks when Deezer retires a playlist.

- **Add or rename a category:** add it to `categories` in `shared/config.ts`, and give it
  a source in `SOURCES` in `backend/src/deezer.ts`. A test fails if you forget the second
  step.
- **Pin a category to one exact playlist** you like: use `{ playlist: <id> }` in
  `SOURCES`, with the number from the playlist's URL on deezer.com.

A different service entirely means writing another `AudioProvider` and passing it to
`setAudioProvider` in `index.ts`.

### Licensing — read before publishing

Deezer's terms are written with "promote this track" uses in mind, and whether a game
counts is unclear. That's fine for testing with friends. **Before publishing publicly,
read Deezer's current API terms and get a lawyer's view**; I couldn't reach them from
the machine this was built on. Discord also expects an app to have the rights to the
content it streams. Other routes, if Deezer's terms rule this out:

| Option | The catch |
| --- | --- |
| Other store preview APIs (e.g. iTunes Search) | Similar "promote the track" terms. Spotify removed preview URLs for new apps in late 2024 |
| Creative Commons catalogs (Free Music Archive, Jamendo) | Mostly unknown songs, which defeats the game |
| A licensed B2B music catalog | Costs money and needs a contract |

Nothing here downloads from Spotify, YouTube or similar services, or rips their audio.

## Roadmap

1. **Scaffolding** ← done
2. **Discord Activity integration** ← done
3. **Lobby** ← done
4. **Game engine** ← done
5. **Audio (real songs via Deezer, with categories)** ← done. The Postgres code is also
   written, but switched off until Milestone 8
6. **Guessing: typo tolerance, autocomplete, spam protection** ← done
7. **Polish: reconnecting, 3-2-1 countdown, album art, error states, small windows,
   animations** ← done
8. Deployment: **code ready** (single service, Railway config, Discord session checks,
   clean shutdown). Still to do, by you: create the Railway project and Postgres, set
   the variables, and point Discord's URL Mapping at it (see "Deploying")
9. Document where the guessability model plugs in
10. Web version, playable outside Discord: nickname plus a server-issued session token
    (still no accounts), lobby codes such as `guessong.app/K7QM`, and abuse limits.
    Mostly `identity.ts` and a sign-in screen; the game itself doesn't change. Settle
    the music licensing question first, since a public website is far more visible

## License

The code is released under the [MIT License](LICENSE): anyone may use, copy, modify and
distribute it, provided the copyright notice is kept.

This covers **the code only**. Songs, previews and album art belong to their rights
holders and are streamed through Deezer under Deezer's terms; the MIT License grants no
rights to any of that content.
