// ============================================================================
//  Session lifecycle events.
//
//  Auth code (lib/auth.js, routes, services) announces that sessions ended;
//  the realtime gateway listens and disconnects the sockets that
//  authenticated with them. Keeps auth free of any Socket.IO dependency.
//
//    emitted: 'revoked', { sessionIds?: string[], userId?: string, exceptSessionId?: string }
//      sessionIds      exactly these sessions ended
//      userId (alone)  every session of this user ended, except exceptSessionId
// ============================================================================

import { EventEmitter } from 'events';

export const sessionEvents = new EventEmitter();
// One listener per gateway; never let a missing listener become a leak warning.
sessionEvents.setMaxListeners(20);

export function announceRevoked(payload) {
  if (!payload) return;
  if (!payload.userId && !payload.sessionIds?.length) return;
  sessionEvents.emit('revoked', payload);
}
