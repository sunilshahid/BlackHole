import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomManager } from './rooms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function getLocalIpAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // Health check endpoint
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: 'BlackHole Server', timestamp: Date.now() }));
    return;
  }

  // If client/dist exists (production fullstack build), serve static assets
  if (fs.existsSync(CLIENT_DIST)) {
    let filePath = path.join(CLIENT_DIST, urlPath);
    if (urlPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIST, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // Standalone signaling mode fallback
  if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: 'BlackHole Signaling Server', timestamp: Date.now() }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 512 * 1024 * 1024,
  perMessageDeflate: false,
});
const roomManager = new RoomManager();

// Keepalive heartbeat to prevent Cloudflare tunnel idle timeouts
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  });
}, 15000);

console.log(`[BlackHole] Signaling Server starting on port ${PORT}...`);

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (rawData: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    // 1. Direct raw binary packet relay (AES-GCM encrypted chunks & control packets)
    if (isBinary) {
      const room = roomManager.getRoomByWs(ws);
      if (!room) return;
      const isSender = room.sender?.ws === ws;
      const targetWs = isSender ? room.receiver?.ws : room.sender?.ws;
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        // Backpressure on server: pause incoming stream if receiver's socket queue is backed up
        if (targetWs.bufferedAmount > 2 * 1024 * 1024) {
          try { ws.pause(); } catch {}
          const checkDrain = setInterval(() => {
            if (!targetWs || targetWs.readyState !== WebSocket.OPEN || targetWs.bufferedAmount < 512 * 1024) {
              clearInterval(checkDrain);
              try { ws.resume(); } catch {}
            }
          }, 20);
        }
        targetWs.send(rawData, { binary: true });
      }
      return;
    }

    // 2. JSON control / signaling messages
    try {
      const text = rawData.toString();
      const message = JSON.parse(text);

      switch (message.type) {
        case 'create-room': {
          const room = roomManager.createRoom(ws, message.customCode);
          const localIps = getLocalIpAddresses();
          ws.send(JSON.stringify({
            type: 'room-created',
            roomId: room.id,
            code: room.code,
            localIps,
          }));
          console.log(`[Room Created] Code: ${room.code} (ID: ${room.id}), Local IPs:`, localIps);
          break;
        }

        case 'join-room': {
          const { code } = message;
          if (!code) {
            ws.send(JSON.stringify({ type: 'error', message: 'No code provided' }));
            return;
          }

          const result = roomManager.joinRoom(ws, code);
          if (!result.success || !result.room) {
            ws.send(JSON.stringify({ type: 'error', message: result.error || 'Failed to join room' }));
            return;
          }

          const room = result.room;
          const localIps = getLocalIpAddresses();
          // Notify receiver that room is joined
          ws.send(JSON.stringify({
            type: 'room-joined',
            roomId: room.id,
            code: room.code,
            localIps,
          }));

          // Notify sender that receiver has arrived
          if (room.sender && room.sender.ws.readyState === WebSocket.OPEN) {
            room.sender.ws.send(JSON.stringify({
              type: 'peer-joined',
              peerId: room.receiver?.id,
            }));
          }

          console.log(`[Room Joined] Code: ${room.code} - Receiver connected to Sender`);
          break;
        }

        case 'signal': {
          // Relay WebRTC SDP (offer/answer) or ICE candidates
          const room = roomManager.getRoomByWs(ws);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
            return;
          }

          const isSender = room.sender?.ws === ws;
          const targetWs = isSender ? room.receiver?.ws : room.sender?.ws;

          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'signal',
              data: message.data,
              from: isSender ? 'sender' : 'receiver',
            }));
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          console.warn(`[Unknown message type]`, message.type);
      }
    } catch (err) {
      console.error('[Signaling Error]', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    const { affectedRoom, role } = roomManager.handleDisconnect(ws);
    if (affectedRoom) {
      console.log(`[Peer Left] ${role} left room ${affectedRoom.code}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[WebSocket Error]', err);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BlackHole] Signaling Server listening on http://0.0.0.0:${PORT} (WebSocket ready)`);
});
