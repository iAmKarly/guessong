import type { Player, Reveal as RevealData } from '@shared/types.ts';
import { useClip } from './useClip.ts';
import { apiUrl } from './paths.ts';
import { CategoryPicker } from './Lobby.tsx';

type Props = {
  reveal: RevealData;
  youId: string;
};

export function Reveal({ reveal, youId }: Props) {
  // Plays the full clip by itself, so you hear what you were guessing.
  const clip = useClip(reveal.clipToken);

  return (
    <div className="card reveal">
      {reveal.artworkUrl && (
        // Through our server: Discord's sandbox blocks images from other sites.
        <img
          className="reveal__art"
          src={apiUrl(`/api/artwork?src=${encodeURIComponent(reveal.artworkUrl)}`)}
          alt=""
          onError={(event) => (event.currentTarget.style.display = 'none')}
        />
      )}
      <p className="reveal__label">The answer</p>
      <h2 className="reveal__title">{reveal.title}</h2>
      <p className="reveal__artist">{reveal.artist}</p>
      <button className="button--ghost" onClick={clip.play} disabled={!clip.ready}>
        ▶ Hear it again
      </button>

      {reveal.scores.length === 0 ? (
        <p className="muted">Nobody got that one.</p>
      ) : (
        <ul className="reveal__scores">
          {reveal.scores.map((score) => (
            <li key={score.playerId}>
              <span className="player__name">
                {score.name}
                {score.playerId === youId && <span className="muted"> (you)</span>}
              </span>
              <span className="reveal__points">+{score.points}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type LeaderboardProps = {
  players: Player[];
  youId: string;
  isHost: boolean;
  categoryId: string;
  onPlayAgain: () => void;
  onCategory: (categoryId: string) => void;
};

export function Leaderboard({
  players,
  youId,
  isHost,
  categoryId,
  onPlayAgain,
  onCategory,
}: LeaderboardProps) {
  const ranked = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className="card leaderboard">
      <h2 className="reveal__label">Final scores</h2>

      <ol className="leaderboard__list">
        {ranked.map((player, index) => (
          <li key={player.id} className={index === 0 ? 'leaderboard__winner' : undefined}>
            <span className="leaderboard__rank">{index + 1}</span>
            {player.avatarUrl ? (
              <img className="avatar" src={player.avatarUrl} alt="" />
            ) : (
              <div className="avatar avatar--blank" aria-hidden="true" />
            )}
            <span className="player__name">
              {player.name}
              {player.id === youId && <span className="muted"> (you)</span>}
            </span>
            <span className="reveal__points">{player.score}</span>
          </li>
        ))}
      </ol>

      <CategoryPicker categoryId={categoryId} isHost={isHost} onCategory={onCategory} />

      {isHost ? (
        <button onClick={onPlayAgain}>Play again</button>
      ) : (
        <p className="lobby__hint">Waiting for the host…</p>
      )}
    </div>
  );
}
