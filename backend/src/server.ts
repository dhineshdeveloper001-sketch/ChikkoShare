import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

// Import shared types
import {
  RoomData,
  JoinRoomRequest,
  SignalingMessage,
  ServerToClientEvents,
  ClientToServerEvents,
  TransferMode,
  DeviceInfo,
} from '../../shared/types';

const app = express();
const httpServer = createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

let publicPath = path.join(process.cwd(), 'public');
if (!fs.existsSync(publicPath)) {
  publicPath = path.join(__dirname, '../public'); // Local dev: backend/src/../public
  if (!fs.existsSync(publicPath)) {
    publicPath = path.join(__dirname, '../../../public'); // Prod: backend/dist/backend/src/../../../public
  }
  if (!fs.existsSync(publicPath)) {
     publicPath = path.join(process.cwd(), 'backend/public'); // Fallback for root execution
  }
}

app.use(express.static(publicPath));

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

interface RoomState {
  id: string;
  token: string;
  createdAt: number;
  transferMode: TransferMode;
  maxReceivers: number;
  senderName: string;
  fileCount: number;
  totalSize: number;
  senderSocketId: string;
  approvedReceivers: Map<string, DeviceInfo>; // socketId -> DeviceInfo
  pendingRequests: Map<string, DeviceInfo>; // socketId -> DeviceInfo
  status: 'active' | 'sender_disconnected';
  timeoutId: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomState>();
const ROOM_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes (can be longer or reset based on activity)

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', (data) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    const formattedRoomId = `${roomId.substring(0, 4)}-${roomId.substring(4)}`;
    const token = crypto.randomBytes(32).toString('hex');
    
    let timeoutId: NodeJS.Timeout | null = null;
    // We will no longer set an initial timeout unless the sender is completely disconnected.

    const roomData: RoomState = {
      id: formattedRoomId,
      token,
      createdAt: Date.now(),
      transferMode: data.transferMode || 'private',
      maxReceivers: data.maxReceivers || 1,
      senderName: data.senderName || 'Sender',
      fileCount: data.fileCount || 0,
      totalSize: data.totalSize || 0,
      senderSocketId: socket.id,
      approvedReceivers: new Map(),
      pendingRequests: new Map(),
      status: 'active',
      timeoutId: null,
    };

    rooms.set(formattedRoomId, roomData);
    socket.join(formattedRoomId);
    
    socket.emit('room_created', {
      roomId: roomData.id,
      token: roomData.token,
      createdAt: roomData.createdAt,
      transferMode: roomData.transferMode,
      maxReceivers: roomData.maxReceivers,
      senderName: roomData.senderName,
      fileCount: roomData.fileCount,
      totalSize: roomData.totalSize,
    });
    console.log(`Room created: ${formattedRoomId} by ${socket.id} (Mode: ${roomData.transferMode})`);
  });

  socket.on('reclaim_room', (data, callback) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      callback({ error: 'Room not found or expired.' });
      return;
    }
    
    if (room.token !== data.token) {
      callback({ error: 'Invalid token.' });
      return;
    }
    
    // Clear timeout if it exists
    if (room.timeoutId) {
      clearTimeout(room.timeoutId);
      room.timeoutId = null;
    }
    
    room.status = 'active';
    room.senderSocketId = socket.id;
    socket.join(room.id);
    
    // Notify receivers that sender is back
    io.to(room.id).emit('sender_reconnected', { senderSocketId: socket.id });
    
    callback({
      roomData: {
        roomId: room.id,
        token: room.token,
        createdAt: room.createdAt,
        transferMode: room.transferMode,
        maxReceivers: room.maxReceivers,
        senderName: room.senderName,
        fileCount: room.fileCount,
        totalSize: room.totalSize
      },
      approvedReceivers: Array.from(room.approvedReceivers.entries()).map(([id, info]) => ({ socketId: id, deviceInfo: info }))
    });
    console.log(`Room ${room.id} reclaimed by ${socket.id}`);
  });

  socket.on('get_room_metadata', (data, callback) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      callback({ error: 'Room not found or expired.' });
      return;
    }
    
    if (room.token !== data.token) {
      callback({ error: 'Invalid token.' });
      return;
    }
    
    callback({
      metadata: {
        senderName: room.senderName,
        transferMode: room.transferMode,
        fileCount: room.fileCount,
        totalSize: room.totalSize
      }
    });
  });

  socket.on('request_join', (data: JoinRoomRequest) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('join_rejected', 'Room not found or expired.');
      return;
    }
    
    if (room.token !== data.token) {
      socket.emit('join_rejected', 'Invalid token.');
      return;
    }

    if (room.approvedReceivers.size >= room.maxReceivers) {
      socket.emit('room_full');
      return;
    }

    // Add to pending
    room.pendingRequests.set(socket.id, data.deviceInfo);
    
    // Notify Sender
    io.to(room.senderSocketId).emit('join_request', {
      socketId: socket.id,
      deviceInfo: data.deviceInfo
    });
    console.log(`User ${socket.id} requested to join room ${data.roomId}`);
  });

  socket.on('approve_request', (data) => {
    const room = rooms.get(data.roomId);
    if (!room || room.senderSocketId !== socket.id) return;
    
    const deviceInfo = room.pendingRequests.get(data.receiverSocketId);
    if (!deviceInfo) return;

    if (room.approvedReceivers.size >= room.maxReceivers) {
       // In case multiple were approved simultaneously
       return;
    }

    room.pendingRequests.delete(data.receiverSocketId);
    room.approvedReceivers.set(data.receiverSocketId, deviceInfo);

    // Make receiver join the socket.io room (mostly for cleanup/broadcasts)
    const receiverSocket = io.sockets.sockets.get(data.receiverSocketId);
    if (receiverSocket) {
      receiverSocket.join(data.roomId);
    }

    // Notify Receiver
    io.to(data.receiverSocketId).emit('join_approved', {
      roomId: data.roomId,
      senderSocketId: room.senderSocketId
    });

    // Notify Sender that receiver is fully approved and connected
    socket.emit('receiver_joined', {
      socketId: data.receiverSocketId,
      deviceInfo
    });

    console.log(`Sender approved ${data.receiverSocketId} for room ${data.roomId}`);
  });

  socket.on('reject_request', (data) => {
    const room = rooms.get(data.roomId);
    if (!room || room.senderSocketId !== socket.id) return;

    room.pendingRequests.delete(data.receiverSocketId);
    io.to(data.receiverSocketId).emit('join_rejected', data.reason || 'Sender rejected your request.');
    console.log(`Sender rejected ${data.receiverSocketId} for room ${data.roomId}`);
  });

  socket.on('signaling_message', (msg: SignalingMessage) => {
    // If target is specified (which it should be for multi-peer), route directly.
    // Ensure we attach the senderSocketId so the receiver knows who it's from.
    msg.senderSocketId = socket.id;
    
    if (msg.targetSocketId) {
       io.to(msg.targetSocketId).emit('signaling_message', msg);
    } else {
       // Fallback for strict 1:1 if needed, but not recommended for broadcast mode.
       socket.to(msg.roomId).emit('signaling_message', msg);
    }
  });

  socket.on('leave_room', (roomId: string) => {
    socket.leave(roomId);
    handleUserLeave(socket.id, roomId, true);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms.entries()) {
      handleUserLeave(socket.id, roomId, false);
    }
  });

  function handleUserLeave(socketId: string, roomId: string, isExplicit: boolean) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.senderSocketId === socketId) {
      if (isExplicit) {
        // Explicitly leaving -> close room immediately
        socket.to(roomId).emit('sender_left');
        if (room.timeoutId) clearTimeout(room.timeoutId);
        rooms.delete(roomId);
        console.log(`Sender explicitly left, closing room ${roomId}`);
      } else {
        // Disconnected -> Preserve room for 5 minutes
        room.status = 'sender_disconnected';
        socket.to(roomId).emit('sender_disconnected');
        
        room.timeoutId = setTimeout(() => {
          if (rooms.has(roomId)) {
            io.to(roomId).emit('room_error', 'Session Expired (Sender disconnected).');
            io.in(roomId).socketsLeave(roomId);
            rooms.delete(roomId);
            console.log(`Room ${roomId} expired due to sender disconnection timeout.`);
          }
        }, ROOM_EXPIRY_MS);
        
        console.log(`Sender disconnected from room ${roomId}. Preserving for 5 mins.`);
      }
    } else {
      if (room.approvedReceivers.has(socketId)) {
        room.approvedReceivers.delete(socketId);
        io.to(room.senderSocketId).emit('receiver_left', socketId);
        console.log(`Receiver ${socketId} left room ${roomId}`);
      }
      if (room.pendingRequests.has(socketId)) {
        room.pendingRequests.delete(socketId);
      }
    }
  }
});

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) res.status(500).send('Static files not built yet.');
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
