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
        useTransferStore.getState().setReceiverStatus(receiverSocketId, 'failed');
        toast.error('Connection lost with a receiver.');
      }
    };

    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    peers.get(receiverSocketId)!.dc = dc;
    
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
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
      console.log('Data channel open!');
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

const handleIncomingData = (event: MessageEvent) => {
  if (typeof event.data === 'string') {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'metadata') {
        fileMeta = data;
        receiveBuffer = [];
        receivedSize = 0;
        startTime = performance.now();
        useTransferStore.getState().setMyStatus('transferring');
        
        // Also setup files in store for UI
        useTransferStore.getState().setFiles([{ name: fileMeta.name, size: fileMeta.size, type: fileMeta.fileType }]);
      } else if (data.type === 'eof') {
        finishReceivingFile();
      }
    } catch(e) {}
  } else {
    const chunk = event.data as ArrayBuffer;
    receiveBuffer.push(chunk);
    receivedSize += chunk.byteLength;
    
    const elapsedSec = (performance.now() - startTime) / 1000;
    const speed = elapsedSec > 0 ? receivedSize / elapsedSec : 0;
    useTransferStore.getState().updateMyState(chunk.byteLength, speed);
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
    let offset = 0;
    const startTime = performance.now();
    let retryCount = 0;
    
    const readSlice = (o: number, size: number) => {
      return new Promise<ArrayBuffer>((res, rej) => {
        const reader = new FileReader();
        reader.onload = (e) => res(e.target?.result as ArrayBuffer);
        reader.onerror = rej;
        reader.readAsArrayBuffer(file.slice(o, o + size));
      });
    };

    const sendNextChunk = async () => {
      if (offset >= file.size) {
        dc.send(JSON.stringify({ type: 'eof' }));
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
        
        resolve();
        return;
      }

      // Check buffer
      const buffered = dc.bufferedAmount || 0;
      let currentChunkSize = 256 * 1024;
      
      if (buffered > 10 * 1024 * 1024) {
         // High congestion, back off
         setTimeout(sendNextChunk, 100);
         return;
      } else if (buffered < 1 * 1024 * 1024) {
         currentChunkSize = 1024 * 1024; // Scale up
      } else if (buffered > 5 * 1024 * 1024) {
         currentChunkSize = 128 * 1024; // Scale down
      }

      try {
        const chunk = await readSlice(offset, currentChunkSize);
        dc.send(chunk);
        offset += chunk.byteLength;
        retryCount = 0; // reset on success
        
        const elapsed = (performance.now() - startTime) / 1000;
        const speed = elapsed > 0 ? offset / elapsed : 0;
        useTransferStore.getState().updateReceiverState(socketId, chunk.byteLength, speed);
        
        setTimeout(sendNextChunk, 0);
      } catch (e) {
        console.error('Error sending chunk to', socketId, e);
        if (retryCount < 5) {
          retryCount++;
          console.log(`Retrying chunk for ${socketId} (Attempt ${retryCount})`);
          setTimeout(sendNextChunk, 1000); // Retry after 1s
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
          resolve(); // Resolve to not block queue mode forever
        }
      }
    };

    sendNextChunk();
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
