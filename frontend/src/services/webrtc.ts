import { socket } from './socket';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// ─── State Machine ────────────────────────────────────────────────────────────
export type PeerState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'PEER_CONNECTED'
  | 'DATACHANNEL_OPEN'
  | 'READY_FOR_TRANSFER'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'FAILED';

interface PeerInstance {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  state: PeerState;
}

// Maps receiverSocketId → PeerInstance (Sender side)
const peers = new Map<string, PeerInstance>();

// Receiver side
let myPeerConnection: RTCPeerConnection | null = null;
let myDataChannel: RTCDataChannel | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
export const clearPeers = () => {
  peers.forEach(p => { try { p.dc?.close(); p.pc.close(); } catch (_) {} });
  peers.clear();
};

export const removePeer = (socketId: string) => {
  const peer = peers.get(socketId);
  if (peer) {
    try { peer.dc?.close(); peer.pc.close(); } catch (_) {}
    peers.delete(socketId);
  }
};

export const closeWebRTC = () => {
  clearPeers();
  try { myDataChannel?.close(); myPeerConnection?.close(); } catch (_) {}
  myPeerConnection = null;
  myDataChannel = null;
};

const getBrowserMaxChunk = (socketId: string): number => {
  const receiver = useRoomStore.getState().connectedReceivers.get(socketId);
  const browser = (receiver?.browser || '').toLowerCase();
  if (browser.includes('safari')) return 64 * 1024;
  if (browser.includes('firefox')) return 128 * 1024;
  return 256 * 1024; // Chrome / Edge / default
};

// ─── SENDER: Initiate WebRTC ──────────────────────────────────────────────────
export const initiateWebRTCConnection = async (receiverSocketId: string) => {
  console.log(`[SOCKET] RECEIVER JOINED → initiating WebRTC for ${receiverSocketId}`);
  try {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    peers.set(receiverSocketId, { pc, dc: null, state: 'CONNECTING' });
    useTransferStore.getState().initReceiverState(receiverSocketId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const roomId = useRoomStore.getState().roomData?.roomId;
        if (roomId) {
          socket.emit('signaling_message', {
            roomId,
            targetSocketId: receiverSocketId,
            type: 'ice-candidate',
            payload: event.candidate,
          });
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WEBRTC] ICE STATE [${receiverSocketId}]: ${state}`);
      const peer = peers.get(receiverSocketId);
      if (!peer) return;

      if (state === 'connected') {
        peer.state = 'PEER_CONNECTED';
        console.log(`[WEBRTC] ICE CONNECTED for ${receiverSocketId}`);
      } else if (state === 'disconnected' || state === 'failed') {
        peer.state = 'FAILED';
        useTransferStore.getState().setReceiverStatus(receiverSocketId, 'failed');
        toast.error('Connection lost with receiver.');
      }
    };

    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    peers.get(receiverSocketId)!.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log(`[WEBRTC] DATACHANNEL OPEN for ${receiverSocketId}`);
      const peer = peers.get(receiverSocketId);
      if (!peer) return;
      peer.state = 'DATACHANNEL_OPEN';
      useTransferStore.getState().setReceiverStatus(receiverSocketId, 'connected');
      console.log(`[TRANSFER] READY for ${receiverSocketId}`);

      // ── AUTO-START: Trigger transfer from inside the DataChannel open event ──
      // This is the ONLY place transfer is triggered — no React useEffect needed.
      const { files: fileMetas } = useTransferStore.getState();
      const rawFiles: File[] = (window as any).__chikkoFiles || [];

      if (rawFiles.length > 0) {
        peer.state = 'TRANSFERRING';
        console.log(`[TRANSFER] START → ${rawFiles[0].name} to ${receiverSocketId}`);
        const mode = useRoomStore.getState().roomData?.transferMode;
        useTransferStore.getState().setSenderStatus('transferring');
        useTransferStore.getState().setReceiverStatus(receiverSocketId, 'transferring');
        sendFileToPeer(rawFiles[0], receiverSocketId, dc);
      } else {
        console.warn(`[TRANSFER] DC open but no File objects available. Files:`, fileMetas.length);
      }
    };

    dc.onclose = () => console.log(`[WEBRTC] DATACHANNEL CLOSED for ${receiverSocketId}`);
    dc.onerror = (e) => console.error(`[WEBRTC] DATACHANNEL ERROR for ${receiverSocketId}`, e);

    console.log(`[WEBRTC] OFFER CREATED for ${receiverSocketId}`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const roomId = useRoomStore.getState().roomData?.roomId;
    if (roomId) {
      socket.emit('signaling_message', { roomId, targetSocketId: receiverSocketId, type: 'offer', payload: offer });
    }
  } catch (err) {
    console.error('[WEBRTC] Error initiating connection:', err);
    toast.error('Failed to establish P2P connection.');
  }
};

// ─── RECEIVER: Setup WebRTC ───────────────────────────────────────────────────
export const setupReceiverWebRTC = async (senderSocketId: string) => {
  myPeerConnection = new RTCPeerConnection({ iceServers: STUN_SERVERS });

  myPeerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const roomId = useRoomStore.getState().roomData?.roomId;
      if (roomId) {
        socket.emit('signaling_message', {
          roomId,
          targetSocketId: senderSocketId,
          type: 'ice-candidate',
          payload: event.candidate,
        });
      }
    }
  };

  myPeerConnection.onconnectionstatechange = () => {
    const state = myPeerConnection?.connectionState;
    console.log(`[WEBRTC] RECEIVER ICE STATE: ${state}`);
    if (state === 'connected') {
      useTransferStore.getState().setMyStatus('connected');
    } else if (state === 'disconnected' || state === 'failed') {
      useTransferStore.getState().setMyStatus('failed');
      toast.error('Connection lost with sender.');
    }
  };

  myPeerConnection.ondatachannel = (event) => {
    myDataChannel = event.channel;
    myDataChannel.binaryType = 'arraybuffer';
    myDataChannel.onopen = () => {
      console.log('[WEBRTC] DATACHANNEL OPEN (Receiver)');
      useTransferStore.getState().setMyStatus('connected');
    };
    myDataChannel.onmessage = handleIncomingData;
    myDataChannel.onerror = (e) => console.error('[WEBRTC] RECEIVER DATACHANNEL ERROR', e);
  };
};

// ─── Signaling Router ─────────────────────────────────────────────────────────
export const handleSignalingMessage = async (msg: any) => {
  const isSender = useTransferStore.getState().role === 'sender';
  try {
    if (isSender) {
      const peer = peers.get(msg.senderSocketId);
      if (!peer) return;
      if (msg.type === 'answer') {
        console.log(`[WEBRTC] ANSWER RECEIVED from ${msg.senderSocketId}`);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      } else if (msg.type === 'ice-candidate') {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    } else {
      if (!myPeerConnection) await setupReceiverWebRTC(msg.senderSocketId);
      if (msg.type === 'offer') {
        await myPeerConnection?.setRemoteDescription(new RTCSessionDescription(msg.payload));
        const answer = await myPeerConnection?.createAnswer();
        await myPeerConnection?.setLocalDescription(answer);
        socket.emit('signaling_message', { roomId: msg.roomId, targetSocketId: msg.senderSocketId, type: 'answer', payload: answer });
      } else if (msg.type === 'ice-candidate') {
        await myPeerConnection?.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    }
  } catch (err) {
    console.error('[WEBRTC] Signaling error:', err);
  }
};

// ─── RECEIVER: Incoming Data Handler ─────────────────────────────────────────
let receiveBuffer: ArrayBuffer[] = [];
let receivedSize = 0;
let fileMeta: any = null;
let rxStartTime = 0;
let lastRxUiUpdate = 0;
let rxBytesAccum = 0;
let receiverHashWorker: Worker | null = null;

const handleIncomingData = (event: MessageEvent) => {
  if (typeof event.data === 'string') {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'metadata') {
        console.log(`[WEBRTC] METADATA RECEIVED: ${data.name} (${data.size} bytes)`);
        if (!receiverHashWorker) {
          receiverHashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
          receiverHashWorker.postMessage({ type: 'init' });
        }
        if (fileMeta && fileMeta.name === data.name && fileMeta.size === data.size && receivedSize > 0) {
          console.log(`[WEBRTC] RESUMING from offset ${receivedSize}`);
        } else {
          receiverHashWorker.postMessage({ type: 'init' });
          fileMeta = data;
          receiveBuffer = [];
          receivedSize = 0;
          rxBytesAccum = 0;
          rxStartTime = performance.now();
          lastRxUiUpdate = rxStartTime;
          useTransferStore.getState().setMyStatus('transferring');
          useTransferStore.getState().setFiles([{ name: fileMeta.name, size: fileMeta.size, type: fileMeta.fileType }]);
        }
        console.log(`[WEBRTC] SYNC_OFFSET SEND: ${receivedSize}`);
        myDataChannel?.send(JSON.stringify({ type: 'sync_offset', offset: receivedSize }));
      } else if (data.type === 'eof') {
        const elapsedSec = (performance.now() - rxStartTime) / 1000;
        const speed = elapsedSec > 0 ? receivedSize / elapsedSec : 0;
        useTransferStore.getState().updateMyState(rxBytesAccum, speed);
        rxBytesAccum = 0;
        if (receiverHashWorker) {
          receiverHashWorker.onmessage = (e) => {
            if (e.data.type === 'result') {
              if (e.data.hash !== data.hash || data.fileSize !== receivedSize) {
                useTransferStore.getState().setMyStatus('failed');
                toast.error('File corrupted! Hash mismatch.', { duration: 8000 });
              } else {
                finishReceivingFile();
              }
              receiverHashWorker?.terminate();
              receiverHashWorker = null;
            }
          };
          receiverHashWorker.postMessage({ type: 'finish' });
        } else {
          finishReceivingFile();
        }
      }
    } catch (e) {
      console.error('[WEBRTC] Error processing incoming message:', e);
    }
  } else {
    const chunk = event.data as ArrayBuffer;
    if (receivedSize === 0) console.log(`[CHUNK] RECEIVE 0`);
    receiveBuffer.push(chunk);
    receiverHashWorker?.postMessage({ type: 'update', chunk });
    receivedSize += chunk.byteLength;
    rxBytesAccum += chunk.byteLength;
    const now = performance.now();
    if (now - lastRxUiUpdate > 250) {
      const speed = (performance.now() - rxStartTime) > 0 ? receivedSize / ((performance.now() - rxStartTime) / 1000) : 0;
      useTransferStore.getState().updateMyState(rxBytesAccum, speed);
      rxBytesAccum = 0;
      lastRxUiUpdate = now;
    }
  }
};

const finishReceivingFile = async () => {
  useTransferStore.getState().setMyStatus('completed');
  const blob = new Blob(receiveBuffer, { type: fileMeta.fileType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileMeta.name;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Downloaded: ${fileMeta.name}`);
  useTransferStore.getState().addHistoryRecord({
    fileName: fileMeta.name,
    size: fileMeta.size,
    mode: 'receive',
    deviceName: 'Sender',
    date: Date.now(),
    status: 'Completed',
    duration: (performance.now() - rxStartTime) / 1000,
  });
  receiveBuffer = [];
};

// ─── SENDER: File Pump ────────────────────────────────────────────────────────
export const startTransferToAll = async (file: File) => {
  const mode = useRoomStore.getState().roomData?.transferMode;
  const activePeers = Array.from(peers.entries()).filter(([_, p]) => p.dc?.readyState === 'open');
  console.log(`[TRANSFER] startTransferToAll: file=${file.name}, activePeers=${activePeers.length}, peersTotal=${peers.size}`);
  peers.forEach((p, id) => console.log(`  peer ${id}: dcState=${p.dc?.readyState ?? 'null'}, peerState=${p.state}`));

  if (activePeers.length === 0) {
    console.error('[TRANSFER] No open DataChannels. Cannot start.');
    useTransferStore.getState().setSenderStatus('failed');
    toast.error('Connection not ready. Please wait.');
    return;
  }

  useTransferStore.getState().setSenderStatus('transferring');
  console.log(`[TRANSFER] START → ${file.name} to ${activePeers.length} peer(s), mode=${mode}`);

  if (mode === 'queue') {
    for (const [socketId, peer] of activePeers) {
      useTransferStore.getState().setReceiverStatus(socketId, 'transferring');
      await sendFileToPeer(file, socketId, peer.dc!);
    }
  } else {
    await Promise.all(activePeers.map(([socketId, peer]) => {
      useTransferStore.getState().setReceiverStatus(socketId, 'transferring');
      return sendFileToPeer(file, socketId, peer.dc!);
    }));
  }
};

const sendFileToPeer = (file: File, socketId: string, dc: RTCDataChannel): Promise<void> => {
  return new Promise((resolve) => {
    console.log(`[WEBRTC] sendFileToPeer: attaching sync_offset listener for ${socketId}`);

    let retryTimeout: ReturnType<typeof setTimeout>;
    let abortTimeout: ReturnType<typeof setTimeout>;

    // Step 1: Attach listener FIRST
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync_offset') {
          console.log(`[WEBRTC] SYNC_OFFSET RECEIVED from ${socketId}: offset=${data.offset}`);
          clearTimeout(retryTimeout);
          clearTimeout(abortTimeout);
          dc.removeEventListener('message', onMessage);
          startPumping(data.offset || 0);
        }
      } catch (e) {
        console.error('[WEBRTC] Handshake parse error:', e);
      }
    };
    dc.addEventListener('message', onMessage);

    // Step 2: Send metadata AFTER listener is attached
    const sendMetadata = () => {
      const meta = JSON.stringify({ type: 'metadata', name: file.name, size: file.size, fileType: file.type });
      console.log(`[WEBRTC] METADATA SEND → ${socketId}: ${file.name} (${file.size} bytes)`);
      dc.send(meta);
    };
    sendMetadata();

    // Retry after 8s if no sync_offset received
    retryTimeout = setTimeout(() => {
      console.warn(`[WEBRTC] sync_offset timeout (8s) for ${socketId} — retrying metadata`);
      sendMetadata();
      abortTimeout = setTimeout(() => {
        console.error(`[WEBRTC] Handshake permanently failed for ${socketId}`);
        dc.removeEventListener('message', onMessage);
        useTransferStore.getState().setReceiverStatus(socketId, 'failed');
        toast.error('Receiver init failed. Please reconnect.');
        resolve();
      }, 8000);
    }, 8000);

    const startPumping = (initialOffset: number) => {
      console.log(`[CHUNK] PUMP START for ${socketId} from offset ${initialOffset}`);
      const senderHashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
      senderHashWorker.postMessage({ type: 'init' });

      let offset = initialOffset;
      const txStartTime = performance.now();
      let retryCount = 0;
      let lastUiUpdate = performance.now();
      let bytesAccum = 0;

      const HIGH_WATER = 2 * 1024 * 1024; // 2 MB
      dc.bufferedAmountLowThreshold = 512 * 1024; // 512 KB
      let isPaused = false;
      let pumping = false;

      const maxChunk = getBrowserMaxChunk(socketId);
      let currentChunkSize = Math.min(256 * 1024, maxChunk);

      const readSlice = (o: number, size: number): Promise<ArrayBuffer> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = (e) => res(e.target?.result as ArrayBuffer);
          reader.onerror = rej;
          reader.readAsArrayBuffer(file.slice(o, o + size));
        });

      let nextChunkPromise: Promise<ArrayBuffer> | null = null;
      const prefetch = (o: number) => {
        if (o < file.size) {
          const sz = Math.min(currentChunkSize, file.size - o);
          nextChunkPromise = readSlice(o, sz);
        } else {
          nextChunkPromise = null;
        }
      };
      prefetch(offset);

      let firstChunk = true;

      const pump = async () => {
        if (pumping) return;
        pumping = true;

        while (offset < file.size) {
          if (dc.readyState !== 'open') { resolve(); return; }

          if (dc.bufferedAmount > HIGH_WATER) {
            isPaused = true;
            pumping = false;
            return;
          }

          try {
            if (!nextChunkPromise) prefetch(offset);
            const chunk = await nextChunkPromise!;

            if (firstChunk) {
              console.log(`[CHUNK] SEND 0 → ${socketId}`);
              firstChunk = false;
            }

            dc.send(chunk);
            senderHashWorker.postMessage({ type: 'update', chunk });
            offset += chunk.byteLength;
            bytesAccum += chunk.byteLength;
            retryCount = 0;

            const now = performance.now();
            const elapsed = (now - txStartTime) / 1000;
            const speed = elapsed > 0 ? offset / elapsed : 0;

            // Adaptive chunk size
            if (speed > 5 * 1024 * 1024) currentChunkSize = maxChunk;
            else if (speed > 1 * 1024 * 1024) currentChunkSize = Math.min(256 * 1024, maxChunk);
            else currentChunkSize = Math.min(128 * 1024, maxChunk);

            prefetch(offset);

            if (now - lastUiUpdate > 250 || offset >= file.size) {
              useTransferStore.getState().updateReceiverState(socketId, bytesAccum, speed);
              bytesAccum = 0;
              lastUiUpdate = now;
            }
          } catch (e) {
            console.error(`[CHUNK] Error sending to ${socketId}:`, e);
            if (retryCount < 5) {
              retryCount++;
              nextChunkPromise = null;
              await new Promise(r => setTimeout(r, 500));
            } else {
              useTransferStore.getState().setReceiverStatus(socketId, 'failed');
              const receiverInfo = useRoomStore.getState().connectedReceivers.get(socketId);
              useTransferStore.getState().addHistoryRecord({
                fileName: file.name, size: file.size, mode: 'send',
                deviceName: receiverInfo?.name || 'Unknown', date: Date.now(),
                status: 'Failed', duration: (performance.now() - txStartTime) / 1000,
              });
              senderHashWorker.terminate();
              resolve();
              return;
            }
          }
        }

        // EOF
        if (offset >= file.size) {
          senderHashWorker.onmessage = (e) => {
            if (e.data.type === 'result') {
              dc.send(JSON.stringify({
                type: 'eof', hash: e.data.hash,
                totalChunks: e.data.chunkCount,
                fileSize: file.size,
                transferTime: performance.now() - txStartTime,
              }));
              useTransferStore.getState().setReceiverStatus(socketId, 'completed');
              const receiverInfo = useRoomStore.getState().connectedReceivers.get(socketId);
              useTransferStore.getState().addHistoryRecord({
                fileName: file.name, size: file.size, mode: 'send',
                deviceName: receiverInfo?.name || 'Unknown', date: Date.now(),
                status: 'Completed', duration: (performance.now() - txStartTime) / 1000,
              });
              senderHashWorker.terminate();
              resolve();
            }
          };
          senderHashWorker.postMessage({ type: 'finish' });
          return;
        }

        pumping = false;
      };

      dc.onbufferedamountlow = () => {
        if (isPaused) { isPaused = false; pump(); }
      };

      pump();
    };
  });
};
