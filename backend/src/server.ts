import './config/env'; // Load env vars first
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

// Config & services
import { isCloudEnabled } from './config/env';
import './config/db'; // Initialize SQLite on startup
import transferRoutes from './routes/transfer.routes';
import { startCleanupWorker } from './workers/cleanup.worker';

// Shared types
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  NetworkMode,
  SignalingMessage,
} from '../../shared/types';

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// ── Static files ───────────────────────────────────────────────────────────────
let publicPath = path.join(process.cwd(), 'public');
if (!fs.existsSync(publicPath)) publicPath = path.join(__dirname, '../public');
if (!fs.existsSync(publicPath)) publicPath = path.join(__dirname, '../../../public');
if (!fs.existsSync(publicPath)) publicPath = path.join(process.cwd(), 'backend/public');
app.use(express.static(publicPath));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', transferRoutes);

// ── Cloud status endpoint ─────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({ cloudEnabled: isCloudEnabled, version: 3 });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8, // 100 MB for signaling (not file data)
});

// ── Room state ────────────────────────────────────────────────────────────────
interface RoomState {
  id: string;
  token: string;
  createdAt: number;
  senderSocketId: string;
  receiverSocketId: string | null;
  status: 'waiting' | 'connected' | 'transferring' | 'done';
  networkMode: NetworkMode | null;
  timeoutId: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomState>();
const ROOM_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// Generate a unique 6-digit numeric room code
function generateRoomCode(): string {
  let code: string;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

// ── Socket handlers ────────────────────────────────────────────────────────────
io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {

  // ── SENDER: Create a room ─────────────────────────────────────────────────
  socket.on('create_room', (callback) => {
    const roomId = generateRoomCode();
    const token  = crypto.randomBytes(32).toString('hex');

    const timeoutId = setTimeout(() => {
      if (rooms.has(roomId)) {
        io.to(roomId).emit('room_error', 'Room expired due to inactivity.');
        io.in(roomId).socketsLeave(roomId);
        rooms.delete(roomId);
      }
    }, ROOM_EXPIRY_MS);

    const room: RoomState = {
      id: roomId, token, createdAt: Date.now(),
      senderSocketId: socket.id,
      receiverSocketId: null,
      status: 'waiting',
      networkMode: null,
      timeoutId,
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    callback({ roomId, token });
  });

  // ── RECEIVER: Join a room ─────────────────────────────────────────────────
  socket.on('join_room', (data, callback) => {
    const room = rooms.get(data.roomId);

    if (!room) {
      callback({ error: 'Room not found. Check the code and try again.' });
      return;
    }
    if (data.token !== 'manual' && room.token !== data.token) {
      callback({ error: 'Invalid code or link.' });
      return;
    }
    if (room.receiverSocketId !== null) {
      callback({ error: 'Someone is already connected to this room.' });
      return;
    }

    room.receiverSocketId = socket.id;
    room.status = 'connected';
    socket.join(data.roomId);

    callback({});

    // Notify sender that receiver has joined
    io.to(room.senderSocketId).emit('room_joined', {
      receiverSocketId: socket.id,
    });
  });

  // ── Signaling relay (WebRTC) ──────────────────────────────────────────────
  socket.on('signaling_message', (msg: SignalingMessage) => {
    msg.senderSocketId = socket.id;
    if (msg.targetSocketId) {
      io.to(msg.targetSocketId).emit('signaling_message', msg);
    } else {
      socket.to(msg.roomId).emit('signaling_message', msg);
    }
  });

  // ── Network mode detected (from sender or receiver) ───────────────────────
  socket.on('report_network_mode', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.networkMode = data.mode;
    // Broadcast to both peers in the room
    io.to(data.roomId).emit('network_mode_set', data.mode);
  });

  // ── SENDER: Cloud upload finished — send download info to receiver ─────────
  socket.on('cloud_upload_complete', (data) => {
    const room = rooms.get(data.roomId);
    if (!room || room.senderSocketId !== socket.id) return;
    room.status = 'transferring';

    if (room.receiverSocketId) {
      io.to(room.receiverSocketId).emit('cloud_download_ready', {
        downloadToken: data.downloadToken,
        expiresAt:     data.expiresAt,
        fileIndex:     data.fileIndex,
        totalFiles:    data.totalFiles,
        filename:      data.filename,
        size:          data.size,
        checksum:      data.checksum,
      });
    }
  });

  // ── RECEIVER: Integrity check result ─────────────────────────────────────
  socket.on('integrity_check_result', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    // Relay result to sender
    io.to(room.senderSocketId).emit('integrity_check_result', data);
  });

  // ── Leave room ────────────────────────────────────────────────────────────
  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
    handleUserLeave(socket.id, roomId, true);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const roomId of rooms.keys()) {
      handleUserLeave(socket.id, roomId, false);
    }
  });

  function handleUserLeave(socketId: string, roomId: string, isExplicit: boolean) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.senderSocketId === socketId) {
      if (isExplicit) {
        if (room.timeoutId) clearTimeout(room.timeoutId);
        io.to(roomId).emit('peer_disconnected');
        io.in(roomId).socketsLeave(roomId);
        rooms.delete(roomId);
      } else {
        // Keep room alive for reconnect grace period (5 min)
        io.to(roomId).emit('peer_disconnected');
        if (room.timeoutId) clearTimeout(room.timeoutId);
        room.timeoutId = setTimeout(() => {
          rooms.delete(roomId);
        }, 5 * 60 * 1000);
      }
    } else if (room.receiverSocketId === socketId) {
      room.receiverSocketId = null;
      room.status = 'waiting';
      io.to(room.senderSocketId).emit('peer_disconnected');
    }
  }
});

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) res.status(500).send('Static files not built yet. Run: npm run build');
  });
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[SERVER] ChikkoShare v3 listening on port ${PORT}`);
  console.log(`[SERVER] Cloud mode: ${isCloudEnabled ? 'ENABLED' : 'DISABLED (WebRTC only)'}`);
  startCleanupWorker();
});
