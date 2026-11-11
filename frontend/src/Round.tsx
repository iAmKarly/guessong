import type { RoundState, Suggestion } from '@shared/types.ts';
import { GuessBox } from './GuessBox.tsx';
import { useCountdown } from './useCountdown.ts';
import { useClip } from './useClip.ts';

type Props = {
  round: RoundState;
  /** Set when the last guess was wrong, cleared on the next attempt. */
  rejected: boolean;
  onGuess: (text: string) => void;
  onExtend: () => void;
  suggestions: { query: string; results: Suggestion[] } | null;
  onSearch: (query: string) => void;
};

export function Round({ round, rejected, onGuess, onExtend, suggestions, onSearch }: Props) {
  const remaining = useCountdown(round.endsAt);
  const clip = useClip(round.clipToken);

  return (
    <div className="card round">
      <header className="round__header">
        <span className="muted">
          Round {round.number} / {round.total}
        </span>
        <span className={`round__clock${remaining <= 5 ? ' round__clock--urgent' : ''}`}>
          {remaining}s
        </span>
      </header>

      <div className="round__clip">
        <button
          className="round__play"
          onClick={clip.play}
          disabled={!clip.ready}
          aria-label={`Play ${round.clipDuration} second clip`}
        >
          ▶
        </button>
        <span className="round__duration">{round.clipDuration}s</span>
        {clip.failed && <p className="error">Music server is down — guess anyway!</p>}
      </div>

      {round.clipToken === null ? (
        <p className="lobby__hint">You joined mid-round — you're in from the next one.</p>
      ) : round.solved ? (
        <p className="round__solved">Got it — waiting for the others…</p>
      ) : (
        <>
          <GuessBox
            roundNumber={round.number}
            suggestions={suggestions}
            onSearch={onSearch}
            onGuess={onGuess}
          />

          {rejected && <p className="round__wrong">Not it — try again</p>}

          <button className="button--ghost" onClick={onExtend} disabled={!round.canExtend}>
            {round.canExtend ? 'Hear more (fewer points)' : 'Full clip already'}
          </button>
        </>
      )}

      <p className="muted round__footer">
        {round.solvedCount} solved · clip starts at {formatTime(round.segmentStart)}
      </p>
    </div>
  );
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
