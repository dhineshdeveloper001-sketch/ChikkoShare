// ── Network mode ──────────────────────────────────────────────────────────────
export type NetworkMode = 'detecting' | 'local' | 'cloud';

// ── File metadata (supports multi-file + folder) ──────────────────────────────
export interface FileEntry {
  name: string;        // filename only (e.g. IMG001.jpg)
  relativePath: string; // path relative to folder root (e.g. Vacation/IMG001.jpg)
  size: number;
  type: string;        // MIME type
  lastModified: number;
}

// ── Room data ─────────────────────────────────────────────────────────────────
export interface RoomCreatedData {
  roomId: string;  // 6-digit numeric e.g. "847291"
  token: string;   // 64-char hex for join auth
}

// ── Cloud transfer info (sent from server to receiver) ────────────────────────
export interface CloudDownloadData {
  downloadToken: string;
  expiresAt: number;
  fileIndex: number;    // which file in the batch (0-indexed)
  totalFiles: number;
  filename: string;
  size: number;
  checksum: string;     // SHA-256 hex — receiver verifies after download
}

// ── Integrity check ───────────────────────────────────────────────────────────
export interface IntegrityCheckResult {
  roomId: string;
  fileIndex: number;
  passed: boolean;
  receivedChecksum: string;
  expectedChecksum: string;
}

// ── Signaling ─────────────────────────────────────────────────────────────────
export interface SignalingMessage {
  roomId: string;
  targetSocketId?: string;
  senderSocketId?: string;
  type: 'offer' | 'answer' | 'ice-candidate';
  payload: any;
}

// ── Socket event interfaces ───────────────────────────────────────────────────
export interface ServerToClientEvents {
  // Room lifecycle
  room_joined:   (data: { receiverSocketId: string }) => void;
  peer_disconnected: () => void;
  room_error:    (message: string) => void;

  // WebRTC signaling
  signaling_message: (msg: SignalingMessage) => void;

  // Network detection result (broadcast to both peers)
  network_mode_set: (mode: NetworkMode) => void;

  // Cloud path: server tells receiver a file is ready to download
  cloud_download_ready: (data: CloudDownloadData) => void;

  // Integrity check relay
  integrity_check_result: (data: IntegrityCheckResult) => void;
}

export interface ClientToServerEvents {
  // Sender creates room, receives roomId + token via callback
  create_room: (callback: (data: RoomCreatedData) => void) => void;

  // Receiver joins room with roomId + token
  join_room: (
    data: { roomId: string; token: string },
    callback: (res: { error?: string }) => void
  ) => void;

  // WebRTC signaling relay
  signaling_message: (msg: SignalingMessage) => void;

  // Either peer reports detected network mode
  report_network_mode: (data: { roomId: string; mode: NetworkMode }) => void;

  // Sender: B2 upload for one file complete
  cloud_upload_complete: (data: {
    roomId: string;
    downloadToken: string;
    expiresAt: number;
    fileIndex: number;
    totalFiles: number;
    filename: string;
    size: number;
    checksum: string;
  }) => void;

  // Receiver: reports integrity check result back to sender
  integrity_check_result: (data: IntegrityCheckResult) => void;

  // Leave room
  leave_room: (roomId: string) => void;
}

// ── History record ────────────────────────────────────────────────────────────
export interface TransferRecord {
  id: string;
  filename: string;
  size: number;
  mode: 'send' | 'receive';
  networkMode: NetworkMode;
  date: number;
  status: 'Completed' | 'Failed' | 'Cancelled';
  duration: number; // seconds
}

// ── Transfer status ───────────────────────────────────────────────────────────
export type TransferStatus =
  | 'idle'
  | 'preparing'
  | 'connecting'
  | 'transferring'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';
