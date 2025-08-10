import { WebSocketServer } from 'ws';
import { applyMask } from './masking.js';
import { record } from './audit.js';

export function createWSServer(server, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ server, path });
  const rooms = new Map(); // sessionId -> Set(ws)

  function joinRoom(ws, sessionId, role) {
    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId).add(ws);
    ws.sessionId = sessionId;
    ws.role = role || 'guest';
    record({ type: 'join', sessionId, role });
  }

  wss.on('connection', ws => {
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'hello') {
          joinRoom(ws, msg.sessionId, msg.role);
          ws.send(JSON.stringify({ type: 'hello_ok' }));
          return;
        }
        if (!ws.sessionId) return;

        if (msg.type === 'batch') {
          // Mutations/events from one participant; mask and broadcast to others.
          const masked = applyMask(msg.payload || {});
          const peers = rooms.get(ws.sessionId) || new Set();
          for (const peer of peers) {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'batch', from: ws.role, payload: masked }));
            }
          }
          record({ type: 'batch', sessionId: ws.sessionId, size: JSON.stringify(masked).length });
          return;
        }

        if (msg.type === 'control') {
          const peers = rooms.get(ws.sessionId) || new Set();
          for (const peer of peers) {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'control', action: msg.action }));
            }
          }
          record({ type: 'control', sessionId: ws.sessionId, action: msg.action });
          return;
        }
      } catch (e) {
        console.error('WS message error', e);
      }
    });

    ws.on('close', () => {
      const sid = ws.sessionId;
      if (sid && rooms.has(sid)) {
        rooms.get(sid).delete(ws);
        record({ type: 'leave', sessionId: sid });
      }
    });
  });

  return wss;
}