import { useEffect, useState } from 'react';

/** Seconds remaining until `endsAt`, ticking down, floored at zero. */
export function useCountdown(endsAt: number): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(endsAt));

  useEffect(() => {
    setRemaining(secondsUntil(endsAt));
    const id = setInterval(() => setRemaining(secondsUntil(endsAt)), 250);
    return () => clearInterval(id);
  }, [endsAt]);

  return remaining;
}

function secondsUntil(endsAt: number): number {
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}
