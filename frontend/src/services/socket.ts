import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, RoomData, SignalingMessage, PendingRequest, DeviceInfo } from '../../../shared/types';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';
import { handleSignalingMessage, closeWebRTC, initiateWebRTCConnection, removePeer } from './webrtc';

const SOCKET_URL = import.meta.env.PROD ? '/' : 'http://localhost:5000';

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, {
  autoConnect: false,
});

export const connectSocket = () => {
  if (!socket.connected) socket.connect();
};

export const disconnectSocket = () => {
  if (socket.connected) socket.disconnect();
};

socket.on('connect', () => {
  useRoomStore.getState().setSignalingConnection(true);
});

socket.on('disconnect', () => {
  useRoomStore.getState().setSignalingConnection(false);
});

socket.on('room_created', (data: RoomData) => {
  useRoomStore.getState().setRoomData(data);
  toast.success('Room created successfully');
});

socket.on('room_error', (message: string) => {
  toast.error(message);
  useRoomStore.getState().reset();
  useTransferStore.getState().reset();
  closeWebRTC();
});

socket.on('room_full', () => {
  toast.error('The room is full. Cannot join.');
  useRoomStore.getState().setWaitingForApproval(false);
});

// SENDER: A new receiver wants to join
socket.on('join_request', (req: PendingRequest) => {
  useRoomStore.getState().addPendingRequest(req);
  toast(`New request from ${req.deviceInfo.name}`, { icon: '👋' });
});

// SENDER: The receiver was approved and joined the socket room, establish WebRTC now
socket.on('receiver_joined', (data: { socketId: string, deviceInfo: DeviceInfo }) => {
  useRoomStore.getState().addConnectedReceiver(data.socketId, data.deviceInfo);
  toast.success(`${data.deviceInfo.name} connected!`);
  // Initiate WebRTC connection immediately (Queue or Broadcast, doesn't matter)
  initiateWebRTCConnection(data.socketId);
});

// RECEIVER: Sender approved the join request
socket.on('join_approved', () => {
  useRoomStore.getState().setWaitingForApproval(false);
  toast.success('Join request approved!');
});

// RECEIVER: Sender rejected the join request
socket.on('join_rejected', (reason: string) => {
  useRoomStore.getState().setWaitingForApproval(false);
  useRoomStore.getState().setApprovalRejected(reason);
  toast.error(reason);
});

socket.on('signaling_message', (msg: SignalingMessage) => {
  handleSignalingMessage(msg);
});

// SENDER: A receiver left
socket.on('receiver_left', (socketId: string) => {
  const deviceInfo = useRoomStore.getState().connectedReceivers.get(socketId);
  if (deviceInfo) {
    toast.error(`${deviceInfo.name} disconnected`);
  }
  useRoomStore.getState().removeConnectedReceiver(socketId);
  removePeer(socketId);
});

// RECEIVER: Sender left
socket.on('sender_left', () => {
  toast.error('Sender disconnected. Room closed.');
  closeWebRTC();
  useRoomStore.getState().reset();
  useTransferStore.getState().reset();
});
