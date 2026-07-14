import { socket } from './socket';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

interface PeerInstance {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: 'connecting' | 'connected' | 'disconnected';
}

// Maps receiver socketId to their Peer Connection & Data Channel
const peers = new Map<string, PeerInstance>();

// Current Receiver Connection (for Receiver role)
let myPeerConnection: RTCPeerConnection | null = null;
let myDataChannel: RTCDataChannel | null = null;

// For Sender Role: Initiate connection to a specific receiver
export const initiateWebRTCConnection = async (receiverSocketId: string) => {
  try {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    
    peers.set(receiverSocketId, { pc, dc: null, status: 'connecting' });
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
      console.log(`WebRTC State [${receiverSocketId}]:`, pc.connectionState);
      const peer = peers.get(receiverSocketId);
      if (!peer) return;

      if (pc.connectionState === 'connected') {
        peer.status = 'connected';
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        peer.status = 'disconnected';
        if (pc.signalingState !== 'closed') {
           console.log(`Attempting ICE restart for ${receiverSocketId}`);
           pc.createOffer({ iceRestart: true }).then(offer => {
             return pc.setLocalDescription(offer);
           }).then(() => {
             const roomId = useRoomStore.getState().roomData?.roomId;
             if (roomId) {
               socket.emit('signaling_message', { roomId, targetSocketId: receiverSocketId, type: 'offer', payload: pc.localDescription });
             }
           }).catch(() => {
             useTransferStore.getState().setReceiverStatus(receiverSocketId, 'failed');
             toast.error('Connection lost with a receiver.');
           });
        }
      }
    };

    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    peers.get(receiverSocketId)!.dc = dc;
    
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      console.log(`[WEBRTC] DATACHANNEL OPEN for ${receiverSocketId}`);
      useTransferStore.getState().setReceiverStatus(receiverSocketId, 'connected');
    };
    dc.onclose = () => {
      console.log(`Data channel closed for ${receiverSocketId}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const roomId = useRoomStore.getState().roomData?.roomId;
    if (roomId) {
      socket.emit('signaling_message', {
        roomId,
        targetSocketId: receiverSocketId,
        type: 'offer',
        payload: offer,
      });
    }

  } catch (err) {
    console.error('Error initiating WebRTC:', err);
    toast.error('Failed to establish P2P connection.');
  }
};

// For Receiver Role: Wait for connection
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
    if (myPeerConnection?.connectionState === 'connected') {
      useTransferStore.getState().setMyStatus('connected');
    } else if (myPeerConnection?.connectionState === 'disconnected' || myPeerConnection?.connectionState === 'failed') {
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
  };
};

export const handleSignalingMessage = async (msg: any) => {
  const isSender = useTransferStore.getState().role === 'sender';
  
  try {
    if (isSender) {
      // Handle receiver's answer or ice candidates
      const senderSocketId = msg.senderSocketId; // actually the receiver who sent it
      const peer = peers.get(senderSocketId);
      if (!peer) return;

      if (msg.type === 'answer') {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      } else if (msg.type === 'ice-candidate') {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    } else {
      // Handle sender's offer or ice candidates
      if (!myPeerConnection) {
        await setupReceiverWebRTC(msg.senderSocketId);
      }

      if (msg.type === 'offer') {
        await myPeerConnection?.setRemoteDescription(new RTCSessionDescription(msg.payload));
        const answer = await myPeerConnection?.createAnswer();
        await myPeerConnection?.setLocalDescription(answer);

        socket.emit('signaling_message', {
          roomId: msg.roomId,
          targetSocketId: msg.senderSocketId,
          type: 'answer',
          payload: answer,
        });
      } else if (msg.type === 'ice-candidate') {
        await myPeerConnection?.addIceCandidate(new RTCIceCandidate(msg.payload));
      }
    }
  } catch (err) {
    console.error('Error handling signaling message:', err);
  }
};

// --- CHUNK TRANSFER ENGINE (Receiver Side) ---
let receiveBuffer: ArrayBuffer[] = [];
let receivedSize = 0;
let fileMeta: any = null;
let startTime = 0;
let lastReceiverUiUpdate = 0;
let receiverBytesAccumulated = 0;
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
          console.log(`Resuming file transfer from offset ${receivedSize}`);
        } else {
          // New file or restart, reset everything
          receiverHashWorker.postMessage({ type: 'init' });
          fileMeta = data;
          receiveBuffer = [];
          receivedSize = 0;
          receiverBytesAccumulated = 0;
          startTime = performance.now();
          lastReceiverUiUpdate = startTime;
          useTransferStore.getState().setMyStatus('transferring');
          useTransferStore.getState().setFiles([{ name: fileMeta.name, size: fileMeta.size, type: fileMeta.fileType }]);
        }
        console.log(`[WEBRTC] SENDING SYNC_OFFSET: ${receivedSize}`);
        myDataChannel?.send(JSON.stringify({ type: 'sync_offset', offset: receivedSize }));
      } else if (data.type === 'eof') {
        const elapsedSec = (performance.now() - startTime) / 1000;
        const speed = elapsedSec > 0 ? receivedSize / elapsedSec : 0;
        useTransferStore.getState().updateMyState(receiverBytesAccumulated, speed);
        receiverBytesAccumulated = 0;
        
        if (receiverHashWorker) {
          receiverHashWorker.onmessage = (e) => {
            if (e.data.type === 'result') {
              const computedHash = e.data.hash;
              if (computedHash !== data.hash || data.fileSize !== receivedSize) {
                useTransferStore.getState().setMyStatus('failed'); // Set a generic failed or 'corrupted' status
                toast.error('File corrupted during transfer! Hashes do not match.', { duration: 8000 });
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
    if (receivedSize === 0) console.log(`[WEBRTC] RECEIVE CHUNK 0`);
    receiveBuffer.push(chunk);
    receiverHashWorker?.postMessage({ type: 'update', chunk });
    receivedSize += chunk.byteLength;
    receiverBytesAccumulated += chunk.byteLength;
    
    const now = performance.now();
    if (now - lastReceiverUiUpdate > 250) {
      const elapsedSec = (now - startTime) / 1000;
      const speed = elapsedSec > 0 ? receivedSize / elapsedSec : 0;
      useTransferStore.getState().updateMyState(receiverBytesAccumulated, speed);
      receiverBytesAccumulated = 0;
      lastReceiverUiUpdate = now;
    }
  }
};

const finishReceivingFile = async () => {
  useTransferStore.getState().setMyStatus('completed');
  
  const blob = new Blob(receiveBuffer, { type: fileMeta.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = fileMeta.name;
  a.click();
  
  URL.revokeObjectURL(url);
  toast.success(`Received ${fileMeta.name}`);
  
  useTransferStore.getState().addHistoryRecord({
    fileName: fileMeta.name,
    size: fileMeta.size,
    mode: 'receive',
    deviceName: 'Sender', // Usually we don't have the exact sender name easily here without roomStore cross-referencing, but this is fine.
    date: Date.now(),
    status: 'Completed',
    duration: (performance.now() - startTime) / 1000
  });
  
  receiveBuffer = [];
};

// --- CHUNK SCHEDULER (Sender Side) ---
export const startTransferToAll = async (file: File) => {
  const mode = useRoomStore.getState().roomData?.transferMode;
  useTransferStore.getState().setSenderStatus('transferring');
  
  // Prepare receivers
  const activePeers = Array.from(peers.entries()).filter(([_, p]) => p.dc?.readyState === 'open');
  if (activePeers.length === 0) {
    toast.error('No ready connections to send to.');
    useTransferStore.getState().setSenderStatus('failed');
    return;
  }

  const metadata = JSON.stringify({ type: 'metadata', name: file.name, size: file.size, fileType: file.type });
  console.log(`[WEBRTC] TRANSFER START: ${file.name} to ${activePeers.length} peers`);

  if (mode === 'queue') {
    // Sequential
    for (const [socketId, peer] of activePeers) {
      peer.dc!.send(metadata);
      useTransferStore.getState().setReceiverStatus(socketId, 'transferring');
      await sendFileToPeer(file, socketId, peer.dc!);
    }
  } else {
    // Broadcast & Private (Parallel)
    for (const [socketId, peer] of activePeers) {
      peer.dc!.send(metadata);
      useTransferStore.getState().setReceiverStatus(socketId, 'transferring');
      // Fire and forget (they will run in parallel)
      sendFileToPeer(file, socketId, peer.dc!);
    }
  }
};

const sendFileToPeer = (file: File, socketId: string, dc: RTCDataChannel): Promise<void> => {
  return new Promise((resolve) => {
    
    // Listen for sync_offset before pumping
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'sync_offset') {
            console.log(`[WEBRTC] SYNC_OFFSET RECEIVED: ${data.offset}`);
            clearTimeout(retryTimeout);
            clearTimeout(abortTimeout);
            dc.removeEventListener('message', onMessage);
            startPumping(data.offset || 0);
          }
        } catch (e) {
          console.error('[WEBRTC] Error processing handshake message:', e);
        }
      }
    };
    dc.addEventListener('message', onMessage);
    
    // Handshake Timeout & Retry
    let retryTimeout: ReturnType<typeof setTimeout>;
    let abortTimeout: ReturnType<typeof setTimeout>;
    
    const sendMetadata = () => {
      dc.send(JSON.stringify({ type: 'metadata', name: file.name, size: file.size, fileType: file.type }));
    };
    
    retryTimeout = setTimeout(() => {
      console.warn(`[WEBRTC] sync_offset timeout. Retrying metadata to ${socketId}`);
      sendMetadata();
      
      abortTimeout = setTimeout(() => {
        console.error(`[WEBRTC] Handshake failed for ${socketId}`);
        dc.removeEventListener('message', onMessage);
        useTransferStore.getState().setReceiverStatus(socketId, 'failed');
        toast.error('Receiver initialization failed. Please reconnect.');
        resolve();
      }, 10000);
    }, 10000);

    const startPumping = (initialOffset: number) => {
      const senderHashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
      senderHashWorker.postMessage({ type: 'init' });
      
      let offset = initialOffset;
      const startTime = performance.now();
      let retryCount = 0;
      
      let lastUiUpdate = performance.now();
      let bytesAddedSinceLastUpdate = 0;
      
      dc.bufferedAmountLowThreshold = 1024 * 1024; // 1 MB
      let isPaused = false;
      let sending = false;
      
      const readSlice = (o: number, size: number): Promise<ArrayBuffer> => {
        return new Promise<ArrayBuffer>((res, rej) => {
          const reader = new FileReader();
          reader.onload = (e) => res(e.target?.result as ArrayBuffer);
          reader.onerror = rej;
          reader.readAsArrayBuffer(file.slice(o, o + size));
        });
      };

      const getAdaptiveChunkSize = (speed: number) => {
        let desired = 128 * 1024;
        if (speed < 1 * 1024 * 1024) desired = 128 * 1024;
        else if (speed < 5 * 1024 * 1024) desired = 256 * 1024;
        else desired = 512 * 1024;
        
        // Clamp based on receiver browser
        const receiver = useRoomStore.getState().connectedReceivers.get(socketId);
        const browser = (receiver?.browser || '').toLowerCase();
        
        let maxSafeSize = 128 * 1024; // Default safe limit
        if (browser.includes('safari')) maxSafeSize = 64 * 1024;
        else if (browser.includes('firefox')) maxSafeSize = 128 * 1024;
        else if (browser.includes('chrome') || browser.includes('edge')) maxSafeSize = 256 * 1024;
        
        return Math.min(desired, maxSafeSize);
      };

      let nextChunkPromise: Promise<ArrayBuffer> | null = null;
      let currentChunkSize = 128 * 1024;
      
      const prefetchNextChunk = (o: number, size: number) => {
        if (o < file.size) {
          nextChunkPromise = readSlice(o, Math.min(size, file.size - o));
        } else {
          nextChunkPromise = null;
        }
      };

      // Initial prefetch
      prefetchNextChunk(offset, currentChunkSize);

      let firstChunkLogged = false;

      const pump = async () => {
        if (sending) return;
        sending = true;

        while (offset < file.size) {
          if (dc.readyState !== 'open') {
             resolve();
             return;
          }

        if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
          isPaused = true;
          sending = false;
          return; // Wait for onbufferedamountlow
        }

        try {
          if (!nextChunkPromise) prefetchNextChunk(offset, currentChunkSize);
          const chunk = await nextChunkPromise!;
          
          if (!firstChunkLogged) {
             console.log(`[WEBRTC] SEND CHUNK 0`);
             firstChunkLogged = true;
          }
          
          dc.send(chunk);
          senderHashWorker.postMessage({ type: 'update', chunk });
          offset += chunk.byteLength;
          retryCount = 0;
          bytesAddedSinceLastUpdate += chunk.byteLength;

          const now = performance.now();
          const elapsedSec = (now - startTime) / 1000;
          const speed = elapsedSec > 0 ? offset / elapsedSec : 0;
          
          currentChunkSize = getAdaptiveChunkSize(speed);
          prefetchNextChunk(offset, currentChunkSize); // Pipeline the next read

          if (now - lastUiUpdate > 250 || offset >= file.size) {
            useTransferStore.getState().updateReceiverState(socketId, bytesAddedSinceLastUpdate, speed);
            bytesAddedSinceLastUpdate = 0;
            lastUiUpdate = now;
          }
        } catch (e) {
          console.error('Error sending chunk to', socketId, e);
          if (retryCount < 5) {
            retryCount++;
            await new Promise(r => setTimeout(r, 1000));
            nextChunkPromise = null; // force re-read
          } else {
            useTransferStore.getState().setReceiverStatus(socketId, 'failed');
            const receiverInfo = useRoomStore.getState().connectedReceivers.get(socketId);
            useTransferStore.getState().addHistoryRecord({
              fileName: file.name,
              size: file.size,
              mode: 'send',
              deviceName: receiverInfo?.name || 'Unknown Device',
              date: Date.now(),
              status: 'Failed',
              duration: (performance.now() - startTime) / 1000
            });
            resolve();
            return;
          }
        }
      }

      if (offset >= file.size) {
        senderHashWorker.onmessage = (e) => {
          if (e.data.type === 'result') {
            dc.send(JSON.stringify({ 
              type: 'eof', 
              hash: e.data.hash,
              totalChunks: e.data.chunkCount,
              fileSize: file.size,
              transferTime: performance.now() - startTime
            }));
            
            useTransferStore.getState().setReceiverStatus(socketId, 'completed');
            
            const receiverInfo = useRoomStore.getState().connectedReceivers.get(socketId);
            useTransferStore.getState().addHistoryRecord({
              fileName: file.name,
              size: file.size,
              mode: 'send',
              deviceName: receiverInfo?.name || 'Unknown Device',
              date: Date.now(),
              status: 'Completed',
              duration: (performance.now() - startTime) / 1000
            });
            senderHashWorker.terminate();
            resolve();
          }
        };
        senderHashWorker.postMessage({ type: 'finish' });
        return;
      }
      
      sending = false;
    };

      dc.onbufferedamountlow = () => {
        if (isPaused) {
          isPaused = false;
          pump();
        }
      };

      pump();
    };
  });
};

export const removePeer = (socketId: string) => {
  const peer = peers.get(socketId);
  if (peer) {
    peer.dc?.close();
    peer.pc?.close();
    peers.delete(socketId);
  }
};

export const closeWebRTC = () => {
  for (const [, peer] of peers.entries()) {
    peer.dc?.close();
    peer.pc?.close();
  }
  peers.clear();
  
  if (myDataChannel) myDataChannel.close();
  if (myPeerConnection) myPeerConnection.close();
  myPeerConnection = null;
  myDataChannel = null;
};
