/**
 * Discord serves the Activity from a sandboxed origin and forwards everything
 * under `/.proxy` to the host you configure in the URL Mapping. Vite mirrors
 * that prefix in dev, so the client uses the same paths in both places and
 * never hard-codes a host.
 */
export const PROXY_PREFIX = '/.proxy';

export const apiUrl = (path: string) => `${PROXY_PREFIX}${path}`;

export const socketUrl = () => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${PROXY_PREFIX}/ws`;
};
