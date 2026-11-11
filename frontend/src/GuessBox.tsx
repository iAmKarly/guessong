import { useEffect, useRef, useState } from 'react';

import type { Suggestion } from '@shared/types.ts';

/** Wait for a pause in typing before searching, so each keystroke isn't a request. */
const SEARCH_DELAY_MS = 200;
const MIN_QUERY = 2;

type Props = {
  /** Changes every round, which resets the box. */
  roundNumber: number;
  /** The latest search reply from the server. */
  suggestions: { query: string; results: Suggestion[] } | null;
  onSearch: (query: string) => void;
  onGuess: (text: string) => void;
};

/**
 * The guess input, with autocomplete from the whole catalog. Players can pick
 * a suggestion or just type and press Enter; both are guesses.
 */
export function GuessBox({ roundNumber, suggestions, onSearch, onGuess }: Props) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Suggestion[]>([]);
  const [highlighted, setHighlighted] = useState(-1);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastQuery = useRef('');

  // A new round means a fresh box, ready to type in.
  useEffect(() => {
    setText('');
    setResults([]);
    inputRef.current?.focus();
  }, [roundNumber]);

  // Search after a pause in typing.
  useEffect(() => {
    const query = text.trim();
    if (query.length < MIN_QUERY) {
      lastQuery.current = '';
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      lastQuery.current = query;
      onSearch(query);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, onSearch]);

  // Only show replies to the latest search; slower, older ones are dropped.
  useEffect(() => {
    if (suggestions && suggestions.query === lastQuery.current) {
      setResults(suggestions.results);
      setHighlighted(-1);
    }
  }, [suggestions]);

  const guess = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onGuess(trimmed);
    setText('');
    setResults([]);
    lastQuery.current = '';
  };

  const pick = (suggestion: Suggestion) => guess(`${suggestion.artist} - ${suggestion.title}`);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((index) => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault();
      pick(results[highlighted]!);
    }
  };

  const showList = open && results.length > 0;

  return (
    <form
      className="guess"
      onSubmit={(event) => {
        event.preventDefault();
        guess(text);
      }}
    >
      <div className="guess__field">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder="Song or artist…"
          aria-label="Guess the song"
          role="combobox"
          aria-expanded={showList}
          aria-controls="guess-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={highlighted >= 0 ? `guess-option-${highlighted}` : undefined}
          autoComplete="off"
          maxLength={200}
        />

        {showList && (
          <ul className="guess__list" id="guess-suggestions" role="listbox">
            {results.map((suggestion, index) => (
              <li
                key={`${suggestion.artist}|${suggestion.title}`}
                id={`guess-option-${index}`}
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? 'guess__option guess__option--active' : 'guess__option'}
                // mousedown, not click: click fires after the input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(suggestion);
                }}
              >
                <span className="guess__title">{suggestion.title}</span>
                <span className="muted">{suggestion.artist}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button type="submit" disabled={text.trim().length === 0}>
        Guess
      </button>
    </form>
  );
}
