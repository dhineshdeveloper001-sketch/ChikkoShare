import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { motion } from 'framer-motion';
import { FiCamera, FiCheckCircle, FiClock, FiXCircle, FiZap, FiZapOff, FiImage, FiArrowLeft, FiEdit3, FiSmartphone, FiShield } from 'react-icons/fi';
import { socket, connectSocket } from '../services/socket';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import type { RoomMetadata } from '../../../shared/types';
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

type ReceiveUIState = 'idle' | 'permission' | 'scanning' | 'preview';

interface ScannedQRData {
  roomId: string;
  token: string;
}

const Receive: React.FC = () => {
  const { isWaitingForApproval, approvalRejectedReason, roomData } = useRoomStore();
  const { myTransferState } = useTransferStore();
  const { status, progress, speedBytesPerSecond, bytesTransferred, etaSeconds } = myTransferState;
  
  const [uiState, setUiState] = useState<ReceiveUIState>('idle');
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [flashOn, setFlashOn] = useState(false);
  const [flashSupported, setFlashSupported] = useState(false);
  
  const [scannedData, setScannedData] = useState<ScannedQRData | null>(null);
  const [previewMetadata, setPreviewMetadata] = useState<RoomMetadata | null>(null);
  const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);
  
  const [manualCode, setManualCode] = useState('');
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    connectSocket();
    useTransferStore.getState().setRole('receiver');
    const myInfo = getDeviceInfo();
    useRoomStore.getState().setMyDeviceInfo(myInfo);
    
    return () => {
      stopScanner();
    };
  }, []);

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop()); 
      setHasPermission(true);
      initScanner();
    } catch (err) {
      setHasPermission(false);
    }
  };

  const initScanner = async () => {
    setUiState('scanning');
    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length) {
        setCameras(devices);
        
        let targetCameraId = devices[0].id;
        // Prioritize rear camera
        const rearCamera = devices.find(d => d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('environment'));
        if (rearCamera) targetCameraId = rearCamera.id;
        
        const savedCamera = localStorage.getItem('chikko_camera_id');
        if (savedCamera && devices.find(d => d.id === savedCamera)) {
          targetCameraId = savedCamera;
        }
        
        setSelectedCamera(targetCameraId);
        startScannerWithCamera(targetCameraId);
      } else {
        toast.error('No cameras found.');
        setUiState('idle');
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to access cameras.');
      setUiState('idle');
    }
  };

  const startScannerWithCamera = async (cameraId: string) => {
    stopScanner();
    setTimeout(async () => {
      try {
        scannerRef.current = new Html5Qrcode("reader");
        await scannerRef.current.start(
          cameraId,
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            handleQRDetected(decodedText);
          },
          () => {
            // Ignore ongoing frame parse errors
          }
        );
        
        // Check flash capabilities
        const track = scannerRef.current.getRunningTrackCameraCapabilities();
        setFlashSupported(track?.torchFeature() ? true : false);
        setFlashOn(false);

      } catch (err) {
        console.error('Scanner start error:', err);
      }
    }, 200); // small delay to ensure DOM is ready and previous instance is cleared
  };

  const stopScanner = () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      scannerRef.current.stop().then(() => {
        scannerRef.current?.clear();
      }).catch(console.error);
    }
  };

  const handleCameraChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setSelectedCamera(newId);
    localStorage.setItem('chikko_camera_id', newId);
    startScannerWithCamera(newId);
  };

  const toggleFlash = async () => {
    if (!scannerRef.current || !flashSupported) return;
    try {
      await scannerRef.current.applyVideoConstraints({
        advanced: [{ torch: !flashOn }]
      } as any);
      setFlashOn(!flashOn);
    } catch (e) {
      console.error('Torch error', e);
      toast.error('Flash control failed.');
    }
  };

  const handleQRDetected = (decodedText: string) => {
    try {
      const data = JSON.parse(decodedText);
      if (data.roomId && data.token) {
        stopScanner();
        setScannedData(data);
        fetchRoomMetadata(data.roomId, data.token);
      } else {
        toast.error('Invalid QR Code format.');
      }
    } catch (e) {
      toast.error('Invalid QR Code.');
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    stopScanner();
    setUiState('idle');

    try {
      const html5QrCode = new Html5Qrcode("hidden-reader");
      const decodedText = await html5QrCode.scanFile(file, true);
      handleQRDetected(decodedText);
    } catch (err) {
      toast.error('No QR code detected. Please choose another image.');
    }
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const fetchRoomMetadata = (roomId: string, token: string) => {
    setUiState('preview');
    setIsFetchingMetadata(true);
    
    socket.emit('get_room_metadata', { roomId, token }, (res: { error?: string, metadata?: RoomMetadata }) => {
      setIsFetchingMetadata(false);
      if (res.error) {
        toast.error(res.error);
        setUiState('idle');
      } else if (res.metadata) {
        setPreviewMetadata(res.metadata);
      }
    });
  };

  const requestJoinRoom = () => {
    if (!scannedData) return;
    const deviceInfo = useRoomStore.getState().myDeviceInfo;
    if (!deviceInfo) return;
    
    useRoomStore.getState().setRoomData({ 
      roomId: scannedData.roomId, 
      token: scannedData.token, 
      createdAt: Date.now(), 
      transferMode: previewMetadata?.transferMode || 'private', 
      maxReceivers: 1,
      senderName: previewMetadata?.senderName || 'Sender',
      fileCount: previewMetadata?.fileCount || 0,
      totalSize: previewMetadata?.totalSize || 0
    });
    
    useRoomStore.getState().setWaitingForApproval(true);
    useRoomStore.getState().setApprovalRejected(null);
    
    socket.emit('request_join', { roomId: scannedData.roomId, token: scannedData.token, deviceInfo });
  };

  const handleManualConnect = () => {
    if (manualCode.length !== 9) {
      toast.error('Room code must be 9 characters (e.g., ABCD-1234)');
      return;
    }
    toast.error('Manual connection requires a full link or QR code at this time.');
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

  const renderContent = () => {
    if (approvalRejectedReason) {
      return (
        <div className="flex flex-col items-center text-center p-8 text-red-400">
          <FiXCircle className="text-6xl mb-4" />
          <h3 className="text-xl font-bold mb-2">Request Rejected</h3>
          <p className="text-slate-400 mb-6">{approvalRejectedReason}</p>
          <button 
            onClick={() => {
              useRoomStore.getState().reset();
              setUiState('idle');
            }}
            className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg"
          >
            Try Again
          </button>
        </div>
      );
    }
    
    if (isWaitingForApproval) {
      return (
        <div className="flex flex-col items-center text-center p-8">
          <div className="relative mb-6">
            <FiClock className="text-6xl text-blue-400" />
            <div className="absolute top-0 right-0 w-3 h-3 bg-yellow-400 rounded-full animate-ping" />
          </div>
          <h3 className="text-xl font-bold mb-2">Waiting for Approval</h3>
          <p className="text-slate-400 mb-2">Connection is secure.</p>
          <p className="text-slate-500 text-sm">The sender must approve your request to join Room {roomData?.roomId}.</p>
        </div>
      );
    }
    
    if (status !== 'idle') {
      return (
        <div className="flex flex-col items-center w-full">
          {status === 'completed' ? (
            <div className="flex flex-col items-center text-emerald-400 p-8 text-center">
              <FiCheckCircle className="text-6xl mb-4" />
              <h3 className="text-2xl font-bold text-white mb-2">Transfer Complete</h3>
              <p className="text-slate-400">File has been downloaded successfully.</p>
              <button 
                onClick={() => {
                   useTransferStore.getState().reset();
                   useRoomStore.getState().reset();
                   setUiState('idle');
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
      );
    }
    
    // UI State Machine for Pre-Connection
    switch (uiState) {
      case 'idle':
        return (
          <div className="flex flex-col items-center w-full">
            <button 
              onClick={() => {
                if (hasPermission === null || hasPermission === false) setUiState('permission');
                else initScanner();
              }}
              className="flex items-center justify-center gap-3 w-full bg-blue-600 hover:bg-blue-500 text-white px-8 py-5 rounded-2xl font-bold text-xl shadow-lg shadow-blue-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] mb-6"
            >
              <FiCamera className="text-2xl" /> Scan QR Code
            </button>
            
            <div className="w-full flex items-center gap-4 my-4">
              <div className="h-px bg-slate-700 flex-1"></div>
              <span className="text-slate-500 font-medium">OR</span>
              <div className="h-px bg-slate-700 flex-1"></div>
            </div>
            
            <div className="w-full mb-6">
               <label className="block text-slate-400 text-sm font-medium mb-2 pl-1">Manual Room Code</label>
               <div className="flex gap-2">
                 <div className="relative flex-1">
                   <FiEdit3 className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                   <input 
                     type="text" 
                     value={manualCode}
                     onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                     placeholder="ABCD-1234"
                     className="w-full bg-slate-900/80 border border-slate-700 rounded-xl py-3 pl-11 pr-4 text-white font-mono tracking-widest focus:outline-none focus:border-blue-500 placeholder-slate-600"
                   />
                 </div>
                 <button onClick={handleManualConnect} className="bg-slate-700 hover:bg-slate-600 text-white px-6 rounded-xl font-bold transition-colors">
                   Connect
                 </button>
               </div>
            </div>
            
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-3 w-full bg-slate-800 hover:bg-slate-700 text-slate-300 px-8 py-4 rounded-2xl font-medium transition-all"
            >
              <FiImage className="text-xl" /> Upload QR from Gallery
            </button>
            <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleImageUpload} />
          </div>
        );
        
      case 'permission':
        return (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center w-full">
            <div className="w-24 h-24 bg-blue-500/10 rounded-full flex items-center justify-center mb-6">
              <FiCamera className="text-5xl text-blue-400" />
            </div>
            <h3 className="text-2xl font-bold mb-3">Allow Camera Access</h3>
            <p className="text-slate-300 mb-6 px-4">Chikko Share requires camera permission to scan QR codes securely.</p>
            
            <div className="bg-slate-900/80 border border-slate-700/50 p-4 rounded-xl flex items-start gap-3 text-left mb-8 w-full">
              <FiShield className="text-emerald-400 text-xl flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-emerald-400 mb-1">Privacy Notice</p>
                <p className="text-sm text-slate-400">Your camera is only used locally to scan QR codes. No images or videos are recorded, uploaded, or stored.</p>
              </div>
            </div>
            
            <button 
              onClick={requestPermission}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-xl font-bold text-lg shadow-lg shadow-blue-500/20 mb-3"
            >
              Allow Camera
            </button>
            <button onClick={() => setUiState('idle')} className="w-full text-slate-400 py-3 font-medium">Cancel</button>
          </motion.div>
        );
        
      case 'scanning':
        return (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col w-full">
             <div className="flex items-center justify-between mb-4">
                <button onClick={() => { stopScanner(); setUiState('idle'); }} className="p-2 bg-slate-800 rounded-full hover:bg-slate-700 transition-colors">
                  <FiArrowLeft className="text-xl" />
                </button>
                <h3 className="font-bold text-lg">Scan QR Code</h3>
                <div className="w-10">
                  {flashSupported && (
                    <button onClick={toggleFlash} className={`p-2 rounded-full transition-colors ${flashOn ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-white'}`}>
                      {flashOn ? <FiZap /> : <FiZapOff />}
                    </button>
                  )}
                </div>
             </div>
             
             {cameras.length > 1 && (
               <div className="mb-4">
                 <select 
                   value={selectedCamera} 
                   onChange={handleCameraChange}
                   className="w-full bg-slate-900 border border-slate-700 text-sm rounded-lg p-2.5 text-slate-300 focus:outline-none focus:border-blue-500"
                 >
                   {cameras.map(c => <option key={c.id} value={c.id}>{c.label || `Camera ${c.id.substring(0, 5)}`}</option>)}
                 </select>
               </div>
             )}
             
             <div className="relative w-full aspect-[4/5] bg-black rounded-3xl overflow-hidden shadow-2xl border border-slate-700/50 mb-6">
                <div id="reader" className="w-full h-full object-cover"></div>
                {/* Overlay UI */}
                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-8">
                  <div className="relative w-64 h-64 border-2 border-white/20 rounded-2xl overflow-hidden shadow-[0_0_0_4000px_rgba(0,0,0,0.6)]">
                     <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-blue-500 rounded-tl-xl" />
                     <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-blue-500 rounded-tr-xl" />
                     <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-blue-500 rounded-bl-xl" />
                     <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-blue-500 rounded-br-xl" />
                     
                     <div className="absolute left-0 right-0 h-0.5 bg-blue-500/80 shadow-[0_0_8px_2px_#3b82f6] animate-[scan_2s_ease-in-out_infinite]" />
                  </div>
                  <p className="mt-8 text-white/80 font-medium text-sm text-center">Place the QR code inside the frame.<br/>It will be detected automatically.</p>
                </div>
             </div>
             
             <div className="flex gap-3">
               <button onClick={() => fileInputRef.current?.click()} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl font-medium flex justify-center items-center gap-2">
                 <FiImage /> Upload QR
               </button>
               <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleImageUpload} />
             </div>
             <div id="hidden-reader" className="hidden"></div>
          </motion.div>
        );
        
      case 'preview':
        return (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center w-full">
            <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4">
              <FiCheckCircle className="text-4xl text-emerald-400" />
            </div>
            <h3 className="text-2xl font-bold mb-6">QR Code Detected</h3>
            
            {isFetchingMetadata ? (
              <div className="w-full bg-slate-900/50 border border-slate-700 rounded-xl p-6 flex flex-col items-center justify-center mb-8 h-48">
                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-slate-400 font-medium">Fetching secure session data...</p>
              </div>
            ) : previewMetadata ? (
              <div className="w-full bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden mb-8 shadow-xl">
                <div className="bg-slate-800/80 px-6 py-4 border-b border-slate-700 flex items-center gap-3">
                   <FiSmartphone className="text-blue-400 text-xl" />
                   <div>
                     <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Sender</p>
                     <p className="font-bold text-white text-lg">{previewMetadata.senderName}</p>
                   </div>
                </div>
                <div className="p-6 flex flex-col gap-4">
                   <div className="flex justify-between items-center pb-4 border-b border-slate-800">
                     <span className="text-slate-400 font-medium">Transfer Mode</span>
                     <span className="bg-blue-500/20 text-blue-400 px-3 py-1 rounded font-bold capitalize text-sm">{previewMetadata.transferMode}</span>
                   </div>
                   <div className="flex justify-between items-center pb-4 border-b border-slate-800">
                     <span className="text-slate-400 font-medium">Files</span>
                     <span className="font-bold text-white">{previewMetadata.fileCount} File(s)</span>
                   </div>
                   <div className="flex justify-between items-center">
                     <span className="text-slate-400 font-medium">Total Size</span>
                     <span className="font-bold text-purple-400">{formatSize(previewMetadata.totalSize)}</span>
                   </div>
                </div>
              </div>
            ) : (
              <div className="text-red-400 mb-8">Failed to fetch metadata.</div>
            )}
            
            <div className="flex flex-col gap-3 w-full">
              <button 
                onClick={requestJoinRoom}
                disabled={isFetchingMetadata || !previewMetadata}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white py-4 rounded-xl font-bold text-lg shadow-lg transition-colors"
              >
                Connect Securely
              </button>
              <button onClick={() => setUiState('idle')} className="w-full text-slate-400 hover:text-white py-3 font-medium transition-colors">
                Cancel
              </button>
            </div>
          </motion.div>
        );
    }
  };

  return (
    <div className="flex flex-col items-center py-6 px-4">
      <motion.div 
        className="glass-panel w-full max-w-lg p-6 sm:p-8"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {renderContent()}
      </motion.div>
    </div>
  );
};

export default Receive;
