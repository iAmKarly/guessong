-- Initial schema.
--
-- Two jobs: keep a record of every game, and collect the human-behaviour data
-- the future guessability model will train on (see the `guesses` table).
--
-- Never edit a migration that has already been applied anywhere. Add a new,
-- higher-numbered file instead; backend/src/db.ts applies them in order.

CREATE TABLE songs (
  -- The provider's own ID, e.g. 'deezer:908604612'.
  id             text PRIMARY KEY,
  title          text NOT NULL,
  artist         text NOT NULL,
  album          text,
  artwork_url    text,
  -- A reference the provider understands. Audio itself is never stored here.
  -- For Deezer this is a preview URL, which expires: don't rely on it later.
  audio_source   text,
  audio_provider text NOT NULL,
  -- Seconds of audio available to cut clips from (30 for a Deezer preview).
  duration       real,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE players (
  -- A Discord user ID, or 'guest:<uuid>' for local development.
  id            text PRIMARY KEY,
  name          text NOT NULL,
  avatar_url    text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id          uuid PRIMARY KEY,
  -- The Discord voice channel (or 'local') the game was played in.
  room_id     text NOT NULL,
  category_id text NOT NULL,
  host_id     text REFERENCES players (id),
  started_at  timestamptz NOT NULL,
  -- Null when the game was abandoned before its last round.
  finished_at timestamptz
);

CREATE TABLE rounds (
  id            uuid PRIMARY KEY,
  game_id       uuid NOT NULL REFERENCES games (id),
  number        integer NOT NULL,
  song_id       text NOT NULL REFERENCES songs (id),
  -- Where the clip started inside the song's audio, in seconds.
  segment_start real NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  UNIQUE (game_id, number)
);

-- One row per submitted guess, right or wrong. This is the training data:
-- which segments people recognise, how fast, and from how short a clip.
CREATE TABLE guesses (
  id                bigserial PRIMARY KEY,
  game_id           uuid NOT NULL REFERENCES games (id),
  round_id          uuid NOT NULL REFERENCES rounds (id),
  player_id         text NOT NULL REFERENCES players (id),
  created_at        timestamptz NOT NULL,
  answer            text NOT NULL,
  normalized_answer text NOT NULL,
  correct           boolean NOT NULL,
  -- Milliseconds from the round starting to this guess.
  response_time_ms  integer NOT NULL,
  -- How much of the clip the player had unlocked when they guessed.
  clip_duration     real NOT NULL,
  -- Copied from the round so analysis queries don't need a join.
  segment_start     real NOT NULL,
  points            integer NOT NULL
);

CREATE INDEX guesses_round_id ON guesses (round_id);
CREATE INDEX rounds_song_id ON rounds (song_id);
