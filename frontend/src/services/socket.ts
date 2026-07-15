import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, SignalingMessage } from '../../../shared/types';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';
import {
  handleSignalingMessage,
  closeWebRTC,
  initiateSenderConnection,
} from './webrtc';
import { downloadFileFromCloud } from './cloudTransfer';

const SOCKET_URL = import.meta.env.PROD ? '/' : 'http://127.0.0.1:5000';

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, {
  autoConnect: false,
});

export const connectSocket    = () => { if (!socket.connected) socket.connect(); };
export const disconnectSocket = () => { if (socket.connected) socket.disconnect(); };

// ── Connection lifecycle ───────────────────────────────────────────────────────
socket.on('connect', () => {
  useRoomStore.getState().setSignalingConnected(true);
});

socket.on('disconnect', () => {
  useRoomStore.getState().setSignalingConnected(false);
});

// ── Room events ───────────────────────────────────────────────────────────────
// SENDER: Receiver joined — start WebRTC immediately
socket.on('room_joined', ({ receiverSocketId }) => {
  useRoomStore.getState().setPeerConnected(true);
  toast.success('Receiver connected!');
  initiateSenderConnection(receiverSocketId);
});

// Either peer: other side disconnected
socket.on('peer_disconnected', () => {
  useRoomStore.getState().setPeerConnected(false);
  toast.error('Peer disconnected.', { duration: 4000 });
});

socket.on('room_error', (msg) => {
  toast.error(msg);
  useRoomStore.getState().reset();
  useTransferStore.getState().reset();
  closeWebRTC();
});

// ── Signaling relay ────────────────────────────────────────────────────────────
socket.on('signaling_message', (msg: SignalingMessage) => {
  handleSignalingMessage(msg);
});

// ── Network mode ───────────────────────────────────────────────────────────────
socket.on('network_mode_set', (mode) => {
  useRoomStore.getState().setNetworkMode(mode);
  useTransferStore.getState().setNetworkMode(mode);
});

// ── Cloud download ready (receiver side) ──────────────────────────────────────
socket.on('cloud_download_ready', async (data) => {
  useTransferStore.getState().setOverallStatus('transferring');

  try {
    await downloadFileFromCloud(
      data.downloadToken,
      data.filename,
      data.size,
      data.fileIndex,
      data.checksum
    );

    const roomId = useRoomStore.getState().roomId;
    if (roomId) {
      socket.emit('integrity_check_result', {
        roomId,
        fileIndex:        data.fileIndex,
        passed:           true,
        receivedChecksum: data.checksum,
        expectedChecksum: data.checksum,
      });
    }

    // If all files done
    if (data.fileIndex === data.totalFiles - 1) {
      useTransferStore.getState().setOverallStatus('completed');
    }
  } catch (err: any) {
    toast.error(err.message || 'Download failed.');
    useTransferStore.getState().setOverallStatus('failed');
  }
});
