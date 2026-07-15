import { NetworkMode } from '../../../shared/types';
import crypto from 'crypto';

export interface RoomState {
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

export function generateRoomCode(): string {
  let code: string;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

export function createRoom(socketId: string, onExpire: (roomId: string) => void): RoomState {
  const roomId = generateRoomCode();
  const token  = crypto.randomBytes(32).toString('hex');

  const timeoutId = setTimeout(() => {
    onExpire(roomId);
  }, ROOM_EXPIRY_MS);

  const room: RoomState = {
    id: roomId,
    token,
    createdAt: Date.now(),
    senderSocketId: socketId,
    receiverSocketId: null,
    status: 'waiting',
    networkMode: null,
    timeoutId,
  };

  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId: string): RoomState | undefined {
  return rooms.get(roomId);
}

export function updateRoom(roomId: string, update: Partial<RoomState>): void {
  const room = rooms.get(roomId);
  if (room) {
    Object.assign(room, update);
  }
}

export function deleteRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (room && room.timeoutId) {
    clearTimeout(room.timeoutId);
  }
  rooms.delete(roomId);
}

export function getAllRooms(): IterableIterator<RoomState> {
  return rooms.values();
}

export function validateRoomToken(roomId: string, token: string): boolean {
  const room = rooms.get(roomId);
  return room !== undefined && room.token === token;
}
