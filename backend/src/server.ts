import './config/env'; // Load env vars first
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

// Config & services
import { isCloudEnabled } from './config/env';
import './config/db'; // Initialize SQLite on startup
import transferRoutes from './routes/transfer.routes';
import { startCleanupWorker } from './workers/cleanup.worker';
import { globalErrorHandler } from './middleware/errorHandler';
import { createRoom, getRoom, deleteRoom, validateRoomToken, getAllRooms } from './services/room.service';

// Shared types
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SignalingMessage,
} from '../../shared/types';

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "https://*.backblazeb2.com", "wss:", "ws:"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      workerSrc: ["'self'", "blob:"],
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xContentTypeOptions: true,
  xFrameOptions: { action: "deny" }
}));

const allowedOrigins = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : ['http://localhost:3000'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200
}));

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
  res.json({ cloudEnabled: isCloudEnabled, version: 4 }); // Bumped version for sec update
});

// SPA fallback
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) res.status(500).send('Static files not built yet. Run: npm run build');
  });
});

// Centralized Error Handler
app.use(globalErrorHandler);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { 
    origin: allowedOrigins,
    methods: ['GET', 'POST'] 
  },
  maxHttpBufferSize: 1e8, // 100 MB for signaling (not file data)
});

// Socket Rate Limiting
const socketConnectionCounts = new Map<string, { count: number, resetAt: number }>();
const MAX_CONNECTIONS_PER_MIN = 20;

io.use((socket, next) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  
  let record = socketConnectionCounts.get(ip);
  if (!record || record.resetAt < now) {
    record = { count: 1, resetAt: now + 60000 };
    socketConnectionCounts.set(ip, record);
  } else {
    record.count++;
  }

  if (record.count > MAX_CONNECTIONS_PER_MIN) {
    return next(new Error('Too many socket connections'));
  }
  next();
});

// Socket Event Throttling (10 events/sec)
const eventThrottler = new Map<string, { tokens: number, lastRefill: number }>();
function checkSocketThrottle(socketId: string): boolean {
  const now = Date.now();
  let record = eventThrottler.get(socketId);
  if (!record) {
    record = { tokens: 10, lastRefill: now };
    eventThrottler.set(socketId, record);
  } else {
    const timePassed = now - record.lastRefill;
    const tokensToAdd = Math.floor(timePassed / 100); // 1 token per 100ms (10/sec)
    if (tokensToAdd > 0) {
      record.tokens = Math.min(10, record.tokens + tokensToAdd);
      record.lastRefill = now;
    }
  }

  if (record.tokens > 0) {
    record.tokens--;
    return true;
  }
  return false;
}

// ── Socket handlers ────────────────────────────────────────────────────────────
io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {

  // Wraps event handler with throttling
  function withThrottle(handler: (...args: any[]) => void) {
    return (...args: any[]) => {
      if (!checkSocketThrottle(socket.id)) {
        console.warn(`Socket ${socket.id} rate limited`);
        return; // Drop event
      }
      handler(...args);
    };
  }

  // ── SENDER: Create a room ─────────────────────────────────────────────────
  socket.on('create_room', withThrottle((callback) => {
    const room = createRoom(socket.id, (expiredRoomId) => {
      io.to(expiredRoomId).emit('room_error', 'Room expired due to inactivity.');
      io.in(expiredRoomId).socketsLeave(expiredRoomId);
      deleteRoom(expiredRoomId);
    });
    
    socket.join(room.id);
    if (typeof callback === 'function') callback({ roomId: room.id, token: room.token });
  }));

  // ── RECEIVER: Join a room ─────────────────────────────────────────────────
  socket.on('join_room', withThrottle((data, callback) => {
    if (typeof callback !== 'function') return;

    // Validate payload
    const schema = z.object({
      roomId: z.string().min(6).max(6).regex(/^[0-9]+$/),
      token: z.string().min(1).max(128)
    });
    
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return callback({ error: 'Invalid room join payload.' });
    }

    const room = getRoom(data.roomId);
    if (!room) {
      return callback({ error: 'Room not found. Check the code and try again.' });
    }
    if (data.token !== 'manual' && room.token !== data.token) {
      return callback({ error: 'Invalid code or link.' });
    }
    if (room.receiverSocketId !== null) {
      return callback({ error: 'Someone is already connected to this room.' });
    }

    room.receiverSocketId = socket.id;
    room.status = 'connected';
    socket.join(data.roomId);

    callback({});
    io.to(room.senderSocketId).emit('room_joined', { receiverSocketId: socket.id });
  }));

  // ── Signaling relay (WebRTC) ──────────────────────────────────────────────
  socket.on('signaling_message', withThrottle((msg: SignalingMessage) => {
    // Validate signaling message payload roughly
    if (!msg.roomId || typeof msg.roomId !== 'string') return;
    
    const room = getRoom(msg.roomId);
    if (!room) return;
    
    // Ensure the sender is actually part of the room
    if (room.senderSocketId !== socket.id && room.receiverSocketId !== socket.id) return;

    msg.senderSocketId = socket.id;
    if (msg.targetSocketId) {
      io.to(msg.targetSocketId).emit('signaling_message', msg);
    } else {
      socket.to(msg.roomId).emit('signaling_message', msg);
    }
  }));

  // ── Network mode detected (from sender or receiver) ───────────────────────
  socket.on('report_network_mode', withThrottle((data) => {
    if (!data.roomId || !data.mode) return;
    const room = getRoom(data.roomId);
    if (!room || (room.senderSocketId !== socket.id && room.receiverSocketId !== socket.id)) return;
    
    room.networkMode = data.mode;
    io.to(data.roomId).emit('network_mode_set', data.mode);
  }));

  // ── SENDER: Cloud upload started — send metadata to receiver ───────────────
  socket.on('cloud_upload_started', withThrottle((data) => {
    if (!data.roomId) return;
    const room = getRoom(data.roomId);
    if (!room || room.senderSocketId !== socket.id) return;
    
    room.status = 'transferring';
    if (room.receiverSocketId) {
      io.to(room.receiverSocketId).emit('cloud_upload_started', {
        files: data.files,
        totalBytes: data.totalBytes,
      });
    }
  }));

  // ── SENDER: Cloud upload finished — send download info to receiver ─────────
  socket.on('cloud_upload_complete', withThrottle((data) => {
    if (!data.roomId) return;
    const room = getRoom(data.roomId);
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
  }));

  // ── RECEIVER: Integrity check result ─────────────────────────────────────
  socket.on('integrity_check_result', withThrottle((data) => {
    if (!data.roomId) return;
    const room = getRoom(data.roomId);
    if (!room || room.receiverSocketId !== socket.id) return;
    
    io.to(room.senderSocketId).emit('integrity_check_result', data);
  }));

  // ── Leave room ────────────────────────────────────────────────────────────
  socket.on('leave_room', withThrottle((roomId) => {
    if (typeof roomId !== 'string') return;
    socket.leave(roomId);
    handleUserLeave(socket.id, roomId, true);
  }));

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    eventThrottler.delete(socket.id);
    for (const room of getAllRooms()) {
      if (room.senderSocketId === socket.id || room.receiverSocketId === socket.id) {
        handleUserLeave(socket.id, room.id, false);
      }
    }
  });

  function handleUserLeave(socketId: string, roomId: string, isExplicit: boolean) {
    const room = getRoom(roomId);
    if (!room) return;

    if (room.senderSocketId === socketId) {
      if (isExplicit) {
        io.to(roomId).emit('peer_disconnected');
        io.in(roomId).socketsLeave(roomId);
        deleteRoom(roomId);
      } else {
        io.to(roomId).emit('peer_disconnected');
        if (room.timeoutId) clearTimeout(room.timeoutId);
        room.timeoutId = setTimeout(() => {
          deleteRoom(roomId);
        }, 5 * 60 * 1000);
      }
    } else if (room.receiverSocketId === socketId) {
      room.receiverSocketId = null;
      room.status = 'waiting';
      io.to(room.senderSocketId).emit('peer_disconnected');
    }
  }
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Server started on port ${PORT}`);
  }
  startCleanupWorker();
});
