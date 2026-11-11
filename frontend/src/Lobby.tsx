import type { RoomState } from '@shared/types.ts';
import { config } from '@shared/config.ts';

type Props = {
  state: RoomState;
  onStart: () => void;
  onCategory: (categoryId: string) => void;
};

export function Lobby({ state, onStart, onCategory }: Props) {
  const isHost = state.youId === state.hostId;
  const enoughPlayers = state.players.length >= state.minPlayers;

  return (
    <div className="card lobby">
      <header className="lobby__header">
        <h2>Players</h2>
        <span className="muted">
          {state.players.length} / {state.maxPlayers}
        </span>
      </header>

      <ul className="lobby__players">
        {state.players.map((player) => (
          <li key={player.id} className="player">
            {player.avatarUrl ? (
              <img className="avatar" src={player.avatarUrl} alt="" />
            ) : (
              <div className="avatar avatar--blank" aria-hidden="true" />
            )}
            <span className={player.connected ? 'player__name' : 'player__name player__name--away'}>
              {player.name}
              {player.id === state.youId && <span className="muted"> (you)</span>}
              {!player.connected && <span className="muted"> · reconnecting</span>}
            </span>
            {player.id === state.hostId && <span className="badge">HOST</span>}
          </li>
        ))}
      </ul>

      <CategoryPicker categoryId={state.categoryId} isHost={isHost} onCategory={onCategory} />

      {isHost ? (
        <>
          <button onClick={onStart} disabled={!enoughPlayers}>
            Start Game
          </button>
          {!enoughPlayers && (
            <p className="lobby__hint">
              Waiting for {state.minPlayers - state.players.length} more player
              {state.minPlayers - state.players.length === 1 ? '' : 's'}
            </p>
          )}
        </>
      ) : (
        <p className="lobby__hint">Waiting for the host to start…</p>
      )}
    </div>
  );
}

/** The host chooses; everyone else just sees the choice. */
export function CategoryPicker({
  categoryId,
  isHost,
  onCategory,
}: {
  categoryId: string;
  isHost: boolean;
  onCategory: (categoryId: string) => void;
}) {
  const label = config.categories.find((category) => category.id === categoryId)?.label;
  return (
    <label className="lobby__category">
      <span className="muted">Category</span>
      {isHost ? (
        <select value={categoryId} onChange={(event) => onCategory(event.target.value)}>
          {config.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      ) : (
        <strong>{label ?? categoryId}</strong>
      )}
    </label>
  );
}
