export type TransferMode = 'private' | 'broadcast' | 'queue';

export interface DeviceInfo {
  deviceId: string;
  name: string;
  browser: string;
  platform: string;
}

export interface RoomData {
  roomId: string;
  token: string;
  createdAt: number;
  transferMode: TransferMode;
  maxReceivers: number;
  senderName: string;
  fileCount: number;
  totalSize: number;
}

export interface RoomMetadata {
  senderName: string;
  transferMode: TransferMode;
  fileCount: number;
  totalSize: number;
}

export interface JoinRoomRequest {
  roomId: string;
  token: string;
  deviceInfo: DeviceInfo;
}

export interface SignalingMessage {
  roomId: string;
  targetSocketId?: string; // Optional because initial offer might not have it strictly if broadcasted, but we will enforce it
  senderSocketId?: string;
  type: 'offer' | 'answer' | 'ice-candidate';
  payload: any;
}

export interface PendingRequest {
  socketId: string;
  deviceInfo: DeviceInfo;
}

export interface ServerToClientEvents {
  room_created: (data: RoomData) => void;
  join_request: (request: PendingRequest) => void; // Server tells Sender someone wants to join
  join_approved: (data: { roomId: string, senderSocketId: string }) => void; // Server tells Receiver they are approved
  join_rejected: (reason: string) => void; // Server tells Receiver they are rejected
  receiver_joined: (data: { socketId: string, deviceInfo: DeviceInfo }) => void; // Server tells Sender receiver is fully in
  
  signaling_message: (msg: SignalingMessage) => void;
  room_error: (message: string) => void;
  receiver_left: (socketId: string) => void;
  sender_left: () => void;
  room_full: () => void;
}

export interface ClientToServerEvents {
  create_room: (data: { transferMode: TransferMode, maxReceivers: number, senderName: string, fileCount: number, totalSize: number }) => void;
  get_room_metadata: (data: { roomId: string, token: string }, callback: (res: { error?: string, metadata?: RoomMetadata }) => void) => void;
  request_join: (data: JoinRoomRequest) => void; // Receiver asks to join
  approve_request: (data: { roomId: string, receiverSocketId: string }) => void; // Sender approves
  reject_request: (data: { roomId: string, receiverSocketId: string, reason: string }) => void; // Sender rejects
  
  signaling_message: (msg: SignalingMessage) => void;
  leave_room: (roomId: string) => void;
}
