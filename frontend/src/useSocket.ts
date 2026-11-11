import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientMessage, ServerMessage } from '@shared/types.ts';
import { socketUrl } from './paths.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/**
 * One WebSocket to the game server, reconnecting on drop.
 *
 * See paths.ts for why the URL is origin-relative and /.proxy-prefixed.
 */
export function useSocket(onMessage: (message: ServerMessage) => void) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  // Keep the latest callback without forcing a reconnect every render.
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout>;
    let closedByUs = false;
    let attempt = 0;

    const connect = () => {
      const ws = new WebSocket(socketUrl());
      socketRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      ws.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(event.data) as ServerMessage);
        } catch {
          console.warn('[ws] unparseable message from server');
        }
      };
      ws.onclose = () => {
        setStatus('closed');
        if (closedByUs) return;
        // Exponential backoff, capped, so a server restart doesn't get hammered.
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10_000));
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  // Stable identity: callers use this in effect dependency arrays, and a fresh
  // function each render would re-fire them.
  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { status, send };
}
