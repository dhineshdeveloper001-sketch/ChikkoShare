import React, { useState, useEffect } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { motion } from 'framer-motion';
import { FiCamera, FiCheckCircle, FiClock, FiXCircle } from 'react-icons/fi';
import { socket, connectSocket } from '../services/socket';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';

// Simple device info generator
const getDeviceInfo = () => {
  const ua = navigator.userAgent;
  let browser = 'Unknown Browser';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('SamsungBrowser')) browser = 'Samsung Internet';
  else if (ua.includes('Opera') || ua.includes('OPR')) browser = 'Opera';
  else if (ua.includes('Edge') || ua.includes('Edg')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';

  let platform = 'Unknown OS';
  if (ua.includes('Win')) platform = 'Windows';
  else if (ua.includes('Mac')) platform = 'macOS';
  else if (ua.includes('Linux')) platform = 'Linux';
  else if (ua.includes('Android')) platform = 'Android';
  else if (ua.includes('like Mac OS')) platform = 'iOS';

  const randomId = Math.random().toString(36).substring(2, 6).toUpperCase();
  
  return {
    deviceId: randomId,
    name: `${browser} on ${platform}`,
    browser,
    platform
  };
};

const Receive: React.FC = () => {
  const { peerConnected, isWaitingForApproval, approvalRejectedReason, roomData } = useRoomStore();
  const { myTransferState } = useTransferStore();
  const { status, progress, speedBytesPerSecond, bytesTransferred, etaSeconds } = myTransferState;
  
  const [roomIdInput, setRoomIdInput] = useState('');
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    connectSocket();
    useTransferStore.getState().setRole('receiver');
    const myInfo = getDeviceInfo();
    useRoomStore.getState().setMyDeviceInfo(myInfo);
    
    return () => {
      // Cleanup
    };
  }, []);

  useEffect(() => {
    if (scanning && status === 'idle') {
      const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 }, false);
      scanner.render(
        (decodedText) => {
          try {
            const data = JSON.parse(decodedText);
            if (data.roomId && data.token) {
              scanner.clear();
              setScanning(false);
              requestJoinRoom(data.roomId, data.token);
            }
          } catch (e) {
            console.error('Invalid QR');
          }
        },
        (err) => {}
      );
      return () => { scanner.clear().catch(e => console.error(e)); };
    }
  }, [scanning, status]);

  const requestJoinRoom = (roomId: string, token: string) => {
    const deviceInfo = useRoomStore.getState().myDeviceInfo;
    if (!deviceInfo) return;
    
    // Optimistically set room data so we know who we are waiting for
    useRoomStore.getState().setRoomData({ roomId, token, createdAt: Date.now(), transferMode: 'private', maxReceivers: 1 });
    useRoomStore.getState().setWaitingForApproval(true);
    useRoomStore.getState().setApprovalRejected(null);
    
    socket.emit('request_join', { roomId, token, deviceInfo });
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (secs: number) => {
    if (secs === 0 || !isFinite(secs)) return '--:--';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <motion.div 
        className="glass-panel w-full max-w-2xl p-8"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <h2 className="text-3xl font-bold mb-6 text-center">Receive Files</h2>

        {approvalRejectedReason ? (
          <div className="flex flex-col items-center text-center p-8 text-red-400">
            <FiXCircle className="text-6xl mb-4" />
            <h3 className="text-xl font-bold mb-2">Request Rejected</h3>
            <p className="text-slate-400 mb-6">{approvalRejectedReason}</p>
            <button 
              onClick={() => {
                useRoomStore.getState().reset();
              }}
              className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg"
            >
              Try Again
            </button>
          </div>
        ) : isWaitingForApproval ? (
          <div className="flex flex-col items-center text-center p-8">
            <div className="relative mb-6">
              <FiClock className="text-6xl text-blue-400" />
              <div className="absolute top-0 right-0 w-3 h-3 bg-yellow-400 rounded-full animate-ping" />
            </div>
            <h3 className="text-xl font-bold mb-2">Waiting for Approval</h3>
            <p className="text-slate-400">The sender needs to approve your request to join Room {roomData?.roomId}.</p>
          </div>
        ) : status === 'idle' && !peerConnected ? (
          <div className="flex flex-col items-center">
            {scanning ? (
              <div className="w-full max-w-sm mb-6">
                <div id="reader" className="rounded-xl overflow-hidden bg-slate-900 border border-slate-700"></div>
                <button 
                  onClick={() => setScanning(false)}
                  className="mt-4 w-full py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium"
                >Cancel Scan</button>
              </div>
            ) : (
              <button 
                onClick={() => setScanning(true)}
                className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-2xl font-semibold text-lg shadow-lg mb-8"
              >
                <FiCamera className="text-xl" /> Scan QR Code
              </button>
            )}
            {/* Manual entry omitted for brevity, keeping UI clean */}
          </div>
        ) : (
          <div className="flex flex-col items-center">
            {status === 'completed' ? (
              <div className="flex flex-col items-center text-emerald-400 p-8 text-center">
                <FiCheckCircle className="text-6xl mb-4" />
                <h3 className="text-2xl font-bold text-white mb-2">Transfer Complete</h3>
                <p className="text-slate-400">File has been downloaded.</p>
                <button 
                  onClick={() => {
                     useTransferStore.getState().reset();
                     useRoomStore.getState().reset();
                  }}
                  className="mt-8 px-6 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-white font-medium"
                >Receive Another File</button>
              </div>
            ) : (
              <div className="w-full bg-slate-900/50 p-6 rounded-2xl border border-slate-700/50">
                <div className="flex flex-col items-center mb-6">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse shadow-[0_0_10px_#3b82f6]"></div>
                    <h3 className="text-xl font-bold">
                      {status === 'connected' ? 'Connected, waiting for sender...' : 'Receiving file...'}
                    </h3>
                  </div>
                </div>
                
                {status === 'transferring' && (
                  <>
                    <div className="flex justify-between text-sm mb-2 text-slate-300">
                      <span>{formatSize(bytesTransferred)} / {formatSize(useTransferStore.getState().totalBytes)}</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    
                    <div className="h-4 w-full bg-slate-800 rounded-full overflow-hidden mb-4">
                      <div 
                        className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    
                    <div className="flex justify-between text-sm text-slate-400">
                      <span>Speed: {formatSize(speedBytesPerSecond)}/s</span>
                      <span>ETA: {formatTime(etaSeconds)}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default Receive;
