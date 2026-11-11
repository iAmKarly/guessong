import type { ClientMessage } from '../../shared/types.ts';

/**
 * Trust boundary: anything arriving on a socket is hostile until proven
 * otherwise. Returns null for anything we don't recognise, and the caller
 * replies with an error rather than throwing.
 *
 * ponytail: hand-rolled because the protocol is small. Swap in zod once the
 * message shapes outgrow this (~Milestone 6, when guesses arrive).
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;

  switch (message.type) {
    case 'join': {
      const roomId = str(message.roomId, 64);
      if (roomId === null) return null;
      return {
        type: 'join',
        roomId,
        accessToken: str(message.accessToken, 512),
        guestName: str(message.guestName, 32),
        guestId:
          typeof message.guestId === 'string' && /^[\w-]{8,64}$/.test(message.guestId)
            ? message.guestId
            : null,
      };
    }
    case 'leave':
      return { type: 'leave' };
    case 'startGame':
      return { type: 'startGame' };
    case 'setCategory': {
      const categoryId = str(message.categoryId, 32);
      return categoryId === null ? null : { type: 'setCategory', categoryId };
    }
    case 'extendClip':
      return { type: 'extendClip' };
    case 'search': {
      const query = str(message.query, 60);
      return query === null ? null : { type: 'search', query };
    }
    case 'guess': {
      const text = str(message.text, 200);
      if (text === null) return null;
      return { type: 'guess', text };
    }
    default:
      return null;
  }
}

/** A non-empty string within `max` characters, or null. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}
