import { useCallback, useEffect, useRef, useState } from 'react';

import { apiUrl } from './paths.ts';

/**
 * Web Audio rather than <audio>: a 0.1s clip needs sample-accurate start and
 * stop, and <audio> start-up latency would swallow most of it.
 */
let context: AudioContext | null = null;
const audioContext = () => (context ??= new AudioContext());

/**
 * Browsers keep audio muted until the user interacts with the page. The first
 * click or keypress anywhere unlocks it, so later clips can play by themselves.
 */
const unlock = () => void audioContext().resume();
document.addEventListener('pointerdown', unlock, { once: true });
document.addEventListener('keydown', unlock, { once: true });

/** Fetch the clip a ticket unlocks, play it once it arrives, and allow replays. */
export function useClip(token: string | null) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [failed, setFailed] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const stop = () => {
    try {
      sourceRef.current?.stop();
    } catch {
      // Already stopped.
    }
    sourceRef.current = null;
  };

  const start = (clip: AudioBuffer) => {
    stop();
    const ctx = audioContext();
    const source = ctx.createBufferSource();
    source.buffer = clip;
    source.connect(ctx.destination);
    source.start();
    sourceRef.current = source;
  };

  useEffect(() => {
    setBuffer(null);
    setFailed(false);
    if (!token) return;

    let cancelled = false;
    fetch(apiUrl(`/api/clip/${token}`))
      .then((response) => {
        if (!response.ok) throw new Error(`Clip request failed (${response.status})`);
        return response.arrayBuffer();
      })
      .then((data) => audioContext().decodeAudioData(data))
      .then((decoded) => {
        if (cancelled) return;
        setBuffer(decoded);
        // Autoplay only once audio is unlocked; otherwise the Play button does it.
        if (audioContext().state === 'running') start(decoded);
      })
      .catch((error: unknown) => {
        console.warn('[audio]', error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      stop();
    };
  }, [token]);

  const play = useCallback(() => {
    unlock();
    if (buffer) start(buffer);
  }, [buffer]);

  return { ready: buffer !== null, failed, play };
}
