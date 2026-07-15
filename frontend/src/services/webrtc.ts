import { socket } from './socket';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import { detectNetworkMode } from './networkDetector';
import { uploadFileToCloud } from './cloudTransfer';
import toast from 'react-hot-toast';
import type { FileEntry } from '../../../shared/types';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// ── Single peer connection (v3 is always 1-to-1) ──────────────────────────────
let peerConnection: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
let peerRole: 'sender' | 'receiver' | null = null;

// Pause/cancel signals
let _isPaused = false;
let _isCancelled = false;

export const pauseWebRTC  = () => { _isPaused   = true;  };
export const resumeWebRTC = () => { _isPaused   = false; };
export const cancelWebRTC = () => { _isCancelled = true; closeWebRTC(); };

// ── Cleanup ───────────────────────────────────────────────────────────────────
export const closeWebRTC = () => {
  try { dataChannel?.close(); } catch (_) {}
  try { peerConnection?.close(); } catch (_) {}
  peerConnection = null;
  dataChannel    = null;
  _isPaused      = false;
  _isCancelled   = false;
};

// ── Browser-specific chunk sizes ───────────────────────────────────────────────
const getMaxChunk = (): number => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('safari') && !ua.includes('chrome')) return 64 * 1024;
  if (ua.includes('firefox')) return 128 * 1024;
  return 256 * 1024;
};

// ─────────────────────────────────────────────────────────────────────────────
// SENDER: Initiate connection & detect network mode
// Called as soon as receiver joins the room.
// ─────────────────────────────────────────────────────────────────────────────
export const initiateSenderConnection = async (receiverSocketId: string): Promise<void> => {
  peerRole = 'sender';
  closeWebRTC();
  _isCancelled = false;

  const roomId = useRoomStore.getState().roomId;
  if (!roomId) return;

  peerConnection = new RTCPeerConnection({ iceServers: STUN_SERVERS });

  // Start network detection on this peer connection BEFORE any ICE happens
  detectNetworkMode(peerConnection).then((mode) => {
    console.log('[WEBRTC] detectNetworkMode resolved:', mode);
    useRoomStore.getState().setNetworkMode(mode);
    useTransferStore.getState().setNetworkMode(mode);
    socket.emit('report_network_mode', { roomId, mode });

    if (mode === 'cloud') {
      // WebRTC didn't work — switch to cloud path
      startCloudUpload();
    }
    // If mode === 'local', WebRTC DataChannel handles the transfer (see dc.onopen below)
  });

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signaling_message', {
        roomId, targetSocketId: receiverSocketId,
        type: 'ice-candidate', payload: e.candidate,
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('[WEBRTC] Connection state:', peerConnection?.connectionState);
    if (peerConnection?.connectionState === 'failed') {
      console.warn('[WEBRTC] Connection failed! Falling back to cloud.');
      if (useRoomStore.getState().networkMode !== 'cloud') {
        useRoomStore.getState().setNetworkMode('cloud');
        useTransferStore.getState().setNetworkMode('cloud');
        socket.emit('report_network_mode', { roomId, mode: 'cloud' });
        startCloudUpload();
      }
    }
  };

  // Create data channel
  dataChannel = peerConnection.createDataChannel('chikko', { ordered: true });
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    console.log('[WEBRTC] DataChannel onopen fired!');
    useRoomStore.getState().setNetworkMode('local');
    useTransferStore.getState().setNetworkMode('local');
    socket.emit('report_network_mode', { roomId, mode: 'local' });
    startWebRTCTransfer();
  };

  dataChannel.onerror = (e) => {
    if (import.meta.env.DEV) console.error('[WEBRTC] DC error:', e);
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('signaling_message', {
    roomId, targetSocketId: receiverSocketId, type: 'offer', payload: offer,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER: Set up to receive offer
// ─────────────────────────────────────────────────────────────────────────────
export const setupReceiverConnection = async (senderSocketId: string): Promise<void> => {
  peerRole = 'receiver';
  closeWebRTC();
  _isCancelled = false;

  const roomId = useRoomStore.getState().roomId;
  if (!roomId) return;

  peerConnection = new RTCPeerConnection({ iceServers: STUN_SERVERS });

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signaling_message', {
        roomId, targetSocketId: senderSocketId,
        type: 'ice-candidate', payload: e.candidate,
      });
    }
  };

  peerConnection.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.onopen    = () => {};
    dataChannel.onmessage = handleIncomingData;
    dataChannel.onerror   = (err) => {
      if (import.meta.env.DEV) console.error('[WEBRTC] DC error:', err);
    };
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Signaling router (handles offer/answer/ice-candidate)
// ─────────────────────────────────────────────────────────────────────────────
export const handleSignalingMessage = async (msg: any): Promise<void> => {
  try {
    if (peerRole === 'sender') {
      if (!peerConnection) return;
      if (msg.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.payload));
      } else if (msg.type === 'ice-candidate') {
        await peerConnection.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    } else {
      // Receiver
      if (!peerConnection) await setupReceiverConnection(msg.senderSocketId);
      if (msg.type === 'offer') {
        await peerConnection!.setRemoteDescription(new RTCSessionDescription(msg.payload));
        const answer = await peerConnection!.createAnswer();
        await peerConnection!.setLocalDescription(answer);
        const roomId = useRoomStore.getState().roomId!;
        socket.emit('signaling_message', {
          roomId, targetSocketId: msg.senderSocketId, type: 'answer', payload: answer,
        });
      } else if (msg.type === 'ice-candidate') {
        await peerConnection!.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    }
  } catch (err) {
      if (import.meta.env.DEV) console.error('[WEBRTC] Signaling error:', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SENDER: WebRTC file pump (multi-file)
// ─────────────────────────────────────────────────────────────────────────────
async function startWebRTCTransfer(): Promise<void> {
  const rawFiles: File[] = (window as any).__chikkoFiles ?? [];
  const fileEntries = useTransferStore.getState().files;
  if (rawFiles.length === 0) return;

  useTransferStore.getState().setOverallStatus('transferring');

  for (let i = 0; i < rawFiles.length; i++) {
    if (_isCancelled) break;
    const file  = rawFiles[i];
    const entry = fileEntries[i];
    if (!file || !entry || !dataChannel) continue;

    useTransferStore.getState().setFileStatus(i, 'transferring');
    await sendFileToPeer(file, entry, i, dataChannel);
  }

  if (!_isCancelled) {
    useTransferStore.getState().setOverallStatus('completed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER: Cloud upload (multi-file, sequential)
// ─────────────────────────────────────────────────────────────────────────────
async function startCloudUpload(): Promise<void> {
  console.log('[CLOUD] startCloudUpload called');
  const rawFiles: File[] = (window as any).__chikkoFiles ?? [];
  const fileEntries = useTransferStore.getState().files;
  const roomId = useRoomStore.getState().roomId;
  if (!roomId || rawFiles.length === 0) {
    console.warn('[CLOUD] Aborting startCloudUpload: missing roomId or files', {roomId, count: rawFiles.length});
    return;
  }

  useTransferStore.getState().setOverallStatus('transferring');

  for (let i = 0; i < rawFiles.length; i++) {
    if (_isCancelled) break;
    const file  = rawFiles[i];
    const entry = fileEntries[i];
    if (!file || !entry) continue;

    useTransferStore.getState().setFileStatus(i, 'preparing');

    console.log(`[CLOUD] Computing checksum for file ${i}...`);
    // Compute SHA-256 before upload so receiver can verify integrity
    const checksum = await computeFileChecksum(file);
    console.log(`[CLOUD] Checksum computed: ${checksum}`);

    try {
      useTransferStore.getState().setFileStatus(i, 'transferring');
      console.log(`[CLOUD] Uploading file ${i}...`);
      await uploadFileToCloud(file, entry, i, rawFiles.length, roomId, checksum);
      console.log(`[CLOUD] Upload complete for file ${i}`);
    } catch (err) {
      if (_isCancelled) break;
      useTransferStore.getState().setFileStatus(i, 'failed');
      toast.error(`Failed to upload ${entry.name}`);
    }
  }

  if (!_isCancelled) {
    useTransferStore.getState().setOverallStatus('completed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER: Per-file pump with backpressure, adaptive chunk size, and resume
// ─────────────────────────────────────────────────────────────────────────────
function sendFileToPeer(file: File, entry: FileEntry, fileIndex: number, dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const senderHashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
    senderHashWorker.postMessage({ type: 'init' });

    let retryTimeout: ReturnType<typeof setTimeout>;
    let abortTimeout: ReturnType<typeof setTimeout>;

    // Step 1: Attach listener FIRST, then send metadata
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync_offset') {
          clearTimeout(retryTimeout);
          clearTimeout(abortTimeout);
          dc.removeEventListener('message', onMessage);
          startPumping(data.offset || 0);
        }
      } catch (_) {}
    };
    dc.addEventListener('message', onMessage);

    const sendMeta = () => {
      dc.send(JSON.stringify({
        type:         'metadata',
        name:         entry.name,
        relativePath: entry.relativePath,
        size:         entry.size,
        fileType:     entry.type,
        fileIndex,
      }));
    };
    sendMeta();

    // Retry metadata if no sync_offset in 8s
    retryTimeout = setTimeout(() => {
      sendMeta();
      abortTimeout = setTimeout(() => {
        dc.removeEventListener('message', onMessage);
        useTransferStore.getState().setFileStatus(fileIndex, 'failed');
        senderHashWorker.terminate();
        resolve();
      }, 8000);
    }, 8000);

    function startPumping(initialOffset: number): void {
      let offset       = initialOffset;
      let bytesAccum   = 0;
      let lastUiUpdate = performance.now();
      let txStart      = performance.now();
      let isPaused     = false;
      let pumping      = false;
      let retries      = 0;

      const HIGH_WATER  = 2 * 1024 * 1024;
      const maxChunk    = getMaxChunk();
      let   chunkSize   = maxChunk;

      dc.bufferedAmountLowThreshold = 512 * 1024;

      const readSlice = (o: number, sz: number): Promise<ArrayBuffer> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload  = (e) => res(e.target!.result as ArrayBuffer);
          reader.onerror = rej;
          reader.readAsArrayBuffer(file.slice(o, o + sz));
        });

      let prefetched: Promise<ArrayBuffer> | null = readSlice(offset, Math.min(chunkSize, file.size - offset));

      const pump = async () => {
        if (pumping) return;
        pumping = true;

        while (offset < file.size) {
          if (_isCancelled) { pumping = false; resolve(); return; }

          if (_isPaused) {
            useTransferStore.getState().setFileStatus(fileIndex, 'paused');
            pumping = false;
            // Will be restarted by dc.onbufferedamountlow or resume signal
            const resumeCheck = setInterval(() => {
              if (!_isPaused && !_isCancelled) {
                clearInterval(resumeCheck);
                useTransferStore.getState().setFileStatus(fileIndex, 'transferring');
                pump();
              }
            }, 200);
            return;
          }

          if (dc.readyState !== 'open') { pumping = false; resolve(); return; }
          if (dc.bufferedAmount > HIGH_WATER) {
            isPaused = true; pumping = false; return;
          }

          try {
            if (!prefetched) prefetched = readSlice(offset, Math.min(chunkSize, file.size - offset));
            const chunk = await prefetched;

            dc.send(chunk);
            senderHashWorker.postMessage({ type: 'update', chunk });
            offset     += chunk.byteLength;
            bytesAccum += chunk.byteLength;
            retries     = 0;

            const now     = performance.now();
            const elapsed = (now - txStart) / 1000;
            const speed   = elapsed > 0 ? offset / elapsed : 0;

            // Adaptive chunk size
            if (speed > 5 * 1024 * 1024)     chunkSize = maxChunk;
            else if (speed > 1 * 1024 * 1024) chunkSize = Math.min(256 * 1024, maxChunk);
            else                               chunkSize = Math.min(128 * 1024, maxChunk);

            prefetched = offset < file.size
              ? readSlice(offset, Math.min(chunkSize, file.size - offset))
              : null;

            if (now - lastUiUpdate > 250 || offset >= file.size) {
              useTransferStore.getState().updateFileProgress(fileIndex, bytesAccum, speed);
              bytesAccum   = 0;
              lastUiUpdate = now;
            }
          } catch (e) {
            if (retries++ < 5) {
              prefetched = null;
              await new Promise((r) => setTimeout(r, 500));
            } else {
              useTransferStore.getState().setFileStatus(fileIndex, 'failed');
              senderHashWorker.terminate();
              pumping = false;
              resolve();
              return;
            }
          }
        }

        // EOF — compute final hash, send to receiver
        senderHashWorker.onmessage = (e) => {
          if (e.data.type !== 'result') return;
          dc.send(JSON.stringify({
            type:      'eof',
            hash:      e.data.hash,
            fileSize:  file.size,
            fileIndex,
          }));
          useTransferStore.getState().setFileStatus(fileIndex, 'verifying');
          senderHashWorker.terminate();
          pumping = false;
          // Wait for receiver's integrity_ack before resolving
        };
        senderHashWorker.postMessage({ type: 'finish' });

        // Listen for ack from receiver
        const ackListener = (ev: MessageEvent) => {
          if (typeof ev.data !== 'string') return;
          try {
            const d = JSON.parse(ev.data);
            if (d.type === 'integrity_ack' && d.fileIndex === fileIndex) {
              dc.removeEventListener('message', ackListener);
              if (d.passed) {
                useTransferStore.getState().setFileStatus(fileIndex, 'completed');
              } else {
                useTransferStore.getState().setFileStatus(fileIndex, 'failed');
                toast.error(`Integrity check failed for ${entry.name}`);
              }
              resolve();
            }
          } catch (_) {}
        };
        dc.addEventListener('message', ackListener);
      };

      dc.onbufferedamountlow = () => {
        if (isPaused) { isPaused = false; pump(); }
      };

      pump();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER: Incoming data handler (multi-file aware)
// ─────────────────────────────────────────────────────────────────────────────
interface ReceiverState {
  buffer:     ArrayBuffer[];
  received:   number;
  meta:       any;
  rxStart:    number;
  hashWorker: Worker | null;
  lastUpdate: number;
  bytesAccum: number;
}

const rxState: ReceiverState = {
  buffer:     [],
  received:   0,
  meta:       null,
  rxStart:    0,
  hashWorker: null,
  lastUpdate: 0,
  bytesAccum: 0,
};

const handleIncomingData = (event: MessageEvent) => {
  if (typeof event.data === 'string') {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'metadata') {
        // New file incoming
        if (!rxState.hashWorker) {
          rxState.hashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
        }
        rxState.hashWorker.postMessage({ type: 'init' });
        rxState.meta     = data;
        rxState.buffer   = [];
        rxState.received = 0;
        rxState.rxStart  = performance.now();
        rxState.lastUpdate = rxState.rxStart;
        rxState.bytesAccum = 0;

        useTransferStore.getState().setOverallStatus('transferring');
        useTransferStore.getState().setFileStatus(data.fileIndex, 'transferring');

        // Acknowledge with current offset (resume support)
        dataChannel?.send(JSON.stringify({ type: 'sync_offset', offset: rxState.received }));

      } else if (data.type === 'eof') {
        // Verify integrity
        rxState.hashWorker!.onmessage = (e) => {
          if (e.data.type !== 'result') return;
          const passed = e.data.hash === data.hash && rxState.received === data.fileSize;

          // Send ack back to sender via DataChannel
          dataChannel?.send(JSON.stringify({
            type:      'integrity_ack',
            fileIndex: data.fileIndex,
            passed,
          }));

          if (passed) {
            finishReceiving(data.fileIndex);
          } else {
            useTransferStore.getState().setFileStatus(data.fileIndex, 'failed');
            toast.error(`File integrity check failed: ${rxState.meta?.name}`);
          }
          rxState.hashWorker?.terminate();
          rxState.hashWorker = null;
        };
        rxState.hashWorker!.postMessage({ type: 'finish' });
      }
    } catch (_) {}
  } else {
    // Binary chunk
    const chunk = event.data as ArrayBuffer;
    rxState.buffer.push(chunk);
    rxState.hashWorker?.postMessage({ type: 'update', chunk });
    rxState.received   += chunk.byteLength;
    rxState.bytesAccum += chunk.byteLength;

    const now     = performance.now();
    const elapsed = (now - rxState.rxStart) / 1000;
    const speed   = elapsed > 0 ? rxState.received / elapsed : 0;

    if (now - rxState.lastUpdate > 250) {
      useTransferStore.getState().updateFileProgress(
        rxState.meta?.fileIndex ?? 0,
        rxState.bytesAccum,
        speed
      );
      rxState.bytesAccum = 0;
      rxState.lastUpdate  = now;
    }
  }
};

async function finishReceiving(fileIndex: number): Promise<void> {
  useTransferStore.getState().setFileStatus(fileIndex, 'completed');

  if (fileIndex === (rxState.meta?.totalFiles ?? 1) - 1) {
    useTransferStore.getState().setOverallStatus('completed');
  }

  const blob   = new Blob(rxState.buffer, { type: rxState.meta?.fileType || 'application/octet-stream' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href       = url;
  a.download   = rxState.meta?.name ?? 'file';
  a.click();
  URL.revokeObjectURL(url);

  const duration = (performance.now() - rxState.rxStart) / 1000;
  toast.success(`Downloaded: ${rxState.meta?.name}`);

  useTransferStore.getState().addHistoryRecord({
    filename:    rxState.meta?.name,
    size:        rxState.meta?.size,
    mode:        'receive',
    networkMode: 'local',
    date:        Date.now(),
    status:      'Completed',
    duration,
  });

  rxState.buffer = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: compute SHA-256 of full file (for cloud uploads)
// ─────────────────────────────────────────────────────────────────────────────
export async function computeFileChecksum(file: File): Promise<string> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'init' });

    const CHUNK = 4 * 1024 * 1024; // 4 MB
    let offset = 0;

    const processNext = () => {
      if (offset >= file.size) {
        worker.onmessage = (e) => {
          if (e.data.type === 'result') { worker.terminate(); resolve(e.data.hash); }
        };
        worker.postMessage({ type: 'finish' });
        return;
      }
      const reader = new FileReader();
      const slice  = file.slice(offset, offset + CHUNK);
      reader.onload = (e) => {
        const chunk = e.target!.result as ArrayBuffer;
        worker.postMessage({ type: 'update', chunk });
        offset += chunk.byteLength;
        processNext();
      };
      reader.readAsArrayBuffer(slice);
    };

    processNext();
  });
}
