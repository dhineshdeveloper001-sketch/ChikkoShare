import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FiCamera, FiCheckCircle, FiXCircle, FiArrowLeft,
  FiZap, FiZapOff, FiImage, FiEdit3,
  FiCloud, FiLoader,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import { socket, connectSocket } from '../services/socket';
import { closeWebRTC } from '../services/webrtc';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';

// ── Helpers ───────────────────────────────────────────────────────────────────
const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
};

const formatTime = (secs: number): string => {
  if (!isFinite(secs) || secs <= 0) return '--';
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
};

type ReceiveState = 'idle' | 'permission' | 'scanning' | 'connecting' | 'transferring' | 'done' | 'failed';

interface QRData { roomId: string; token: string; }

const Receive: React.FC = () => {
  const { networkMode } = useRoomStore();
  const { overallStatus, overallSpeedBps, overallEtaSeconds, totalBytesTransferred, totalBytes, files, currentFileIndex } = useTransferStore();

  const [state, setState]           = useState<ReceiveState>('idle');
  const [manualCode, setManualCode] = useState('');
  const [cameras, setCameras]       = useState<any[]>([]);
  const [selCamera, setSelCamera]   = useState('');
  const [flashOn, setFlashOn]       = useState(false);
  const [flashOk, setFlashOk]       = useState(false);

  const scannerRef  = useRef<Html5Qrcode | null>(null);
  const fileImgRef  = useRef<HTMLInputElement>(null);

  useEffect(() => {
    connectSocket();
    useTransferStore.getState().setRole('receiver');
    return () => {
      useRoomStore.getState().reset();
      useTransferStore.getState().reset();
      import('../services/webrtc').then((m) => m.closeWebRTC());
    };
  }, []);

  // Track transfer status changes
  useEffect(() => {
    if (overallStatus === 'waiting' || overallStatus === 'transferring') setState('transferring');
    if (overallStatus === 'completed')    setState('done');
    if (overallStatus === 'failed')       setState('failed');
  }, [overallStatus]);

  // ── Scanner lifecycle ──────────────────────────────────────────────────────
  const stopScanner = () => {
    if (scannerRef.current?.isScanning) {
      scannerRef.current.stop().then(() => scannerRef.current?.clear()).catch(() => {});
    }
  };

  const startScannerWithCamera = async (camId: string) => {
    stopScanner();
    await new Promise((r) => setTimeout(r, 200));
    try {
      scannerRef.current = new Html5Qrcode('qr-reader');
      await scannerRef.current.start(
        camId,
        { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1 },
        (text) => handleQRDetected(text),
        () => {}
      );
      const track = scannerRef.current.getRunningTrackCameraCapabilities();
      setFlashOk(!!track?.torchFeature());
      setFlashOn(false);
    } catch (_) {
      toast.error('Could not start camera.');
    }
  };

  const initScanner = async () => {
    setState('scanning');
    try {
      const devs = await Html5Qrcode.getCameras();
      if (!devs?.length) { toast.error('No camera found.'); setState('idle'); return; }
      setCameras(devs);
      const rear = devs.find((d) => /back|rear|environment/i.test(d.label));
      const saved = localStorage.getItem('chikko_cam');
      const target = (saved && devs.find((d) => d.id === saved)) ? saved : (rear?.id ?? devs[0].id);
      setSelCamera(target);
      startScannerWithCamera(target);
    } catch {
      toast.error('Camera access failed.'); setState('idle');
    }
  };

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      initScanner();
    } catch {
      toast.error('Camera permission denied.');
      setState('idle');
    }
  };

  const toggleFlash = async () => {
    if (!scannerRef.current || !flashOk) return;
    try {
      await scannerRef.current.applyVideoConstraints({ advanced: [{ torch: !flashOn }] } as any);
      setFlashOn((v) => !v);
    } catch { toast.error('Flash not supported.'); }
  };

  useEffect(() => () => stopScanner(), []);

  // ── QR / Manual join ───────────────────────────────────────────────────────
  const handleQRDetected = (text: string) => {
    try {
      const data: QRData = JSON.parse(text);
      if (data.roomId && data.token) {
        stopScanner();
        joinRoom(data.roomId, data.token);
      } else {
        toast.error('Invalid QR Code.');
      }
    } catch {
      toast.error('Invalid QR Code format.');
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopScanner();
    setState('idle');
    try {
      const reader = new Html5Qrcode('hidden-qr');
      const text   = await reader.scanFile(file, true);
      handleQRDetected(text);
    } catch {
      toast.error('No QR code found in image.');
    }
    if (fileImgRef.current) fileImgRef.current.value = '';
  };

  const handleManualConnect = () => {
    const code = manualCode.replace(/\D/g, '').substring(0, 6);
    if (code.length !== 6) {
      toast.error('Please enter the 6-digit room code.');
      return;
    }
    // For manual entry, we pass a dummy token 'manual'. The backend will accept it.
    joinRoom(code, 'manual');
  };

  const joinRoom = (roomId: string, token: string) => {
    setState('connecting');
    useRoomStore.getState().setRoom(roomId, token);

    socket.emit('join_room', { roomId, token }, (res) => {
      if (res.error) {
        toast.error(res.error);
        setState('idle');
        useRoomStore.getState().reset();
      } else {
        toast.success('Connected! Waiting for transfer...');
        // Transfer starts automatically via socket events
      }
    });
  };

  // ── Overall progress ───────────────────────────────────────────────────────
  const overallProgress = totalBytes > 0 ? Math.min((totalBytesTransferred / totalBytes) * 100, 100) : 0;

  // ── Network badge ─────────────────────────────────────────────────────────
  const NetworkBadge = () => {
    if (networkMode === 'local')
      return <span className="flex items-center gap-1 text-emerald-400 text-xs font-medium"><FiZap />Local (WebRTC)</span>;
    if (networkMode === 'cloud')
      return <span className="flex items-center gap-1 text-blue-400 text-xs font-medium"><FiCloud />Cloud (B2)</span>;
    return <span className="flex items-center gap-1 text-slate-500 text-xs"><FiLoader className="animate-spin" />Detecting...</span>;
  };

  return (
    <div className="flex flex-col items-center w-full">
      <AnimatePresence mode="wait">

        {/* ── Idle: scan / manual ─────────────────────────────────────────── */}
        {state === 'idle' && (
          <motion.div key="idle" className="w-full max-w-sm" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <button
              onClick={() => setState('permission')}
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-white py-5 rounded-2xl font-bold text-xl shadow-lg shadow-blue-900/40 transition-colors mb-4"
            >
              <FiCamera className="text-2xl" /> Scan QR Code
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-slate-600 text-sm">OR</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>

            <div className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <FiEdit3 className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={6}
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value.replace(/\D/g, '').substring(0, 6))}
                  placeholder="6-digit code"
                  className="w-full bg-slate-900/80 border border-slate-700 rounded-xl py-3 pl-10 pr-4 text-white font-mono text-lg tracking-widest focus:outline-none focus:border-blue-500 placeholder-slate-600"
                />
              </div>
              <button
                onClick={handleManualConnect}
                className="bg-slate-800 hover:bg-slate-700 text-white px-5 rounded-xl font-bold transition-colors"
              >
                Join
              </button>
            </div>

            <button
              onClick={() => fileImgRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 bg-slate-800/60 hover:bg-slate-800 text-slate-400 py-3 rounded-2xl text-sm font-medium transition-colors border border-slate-700/50"
            >
              <FiImage /> Upload QR from Gallery
            </button>
            <input type="file" accept="image/*" className="hidden" ref={fileImgRef} onChange={handleImageUpload} />
            <div id="hidden-qr" className="hidden" />
          </motion.div>
        )}

        {/* ── Permission request ───────────────────────────────────────────── */}
        {state === 'permission' && (
          <motion.div key="perm" className="w-full max-w-sm text-center" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="w-20 h-20 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <FiCamera className="text-4xl text-blue-400" />
            </div>
            <h3 className="text-xl font-bold mb-2">Allow Camera</h3>
            <p className="text-slate-400 mb-8 text-sm">ChikkoShare uses your camera only to scan QR codes. Nothing is recorded or uploaded.</p>
            <button onClick={requestPermission} className="w-full bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-xl font-bold mb-3 transition-colors">
              Allow Camera
            </button>
            <button onClick={() => setState('idle')} className="w-full text-slate-500 py-2 text-sm">Cancel</button>
          </motion.div>
        )}

        {/* ── Scanning ─────────────────────────────────────────────────────── */}
        {state === 'scanning' && (
          <motion.div key="scan" className="w-full max-w-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => { stopScanner(); setState('idle'); }} className="p-2 bg-slate-800 rounded-full hover:bg-slate-700">
                <FiArrowLeft />
              </button>
              <span className="font-semibold">Scan QR Code</span>
              <div className="w-10 flex justify-center">
                {flashOk && (
                  <button onClick={toggleFlash} className={`p-2 rounded-full ${flashOn ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-white'}`}>
                    {flashOn ? <FiZap /> : <FiZapOff />}
                  </button>
                )}
              </div>
            </div>

            {cameras.length > 1 && (
              <select
                value={selCamera}
                onChange={(e) => { setSelCamera(e.target.value); localStorage.setItem('chikko_cam', e.target.value); startScannerWithCamera(e.target.value); }}
                className="w-full bg-slate-900 border border-slate-700 text-sm rounded-lg p-2 text-slate-300 mb-3 focus:outline-none"
              >
                {cameras.map((c) => <option key={c.id} value={c.id}>{c.label || `Camera ${c.id.slice(0,5)}`}</option>)}
              </select>
            )}

            <div className="relative w-full aspect-square bg-black rounded-3xl overflow-hidden border border-slate-700/50 mb-4">
              <div id="qr-reader" className="w-full h-full" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="relative w-56 h-56">
                  <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-blue-500 rounded-tl-xl" />
                  <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-blue-500 rounded-tr-xl" />
                  <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-blue-500 rounded-bl-xl" />
                  <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-blue-500 rounded-br-xl" />
                  <div className="absolute left-0 right-0 h-0.5 bg-blue-500/80 shadow-[0_0_8px_2px_#3b82f6] animate-[scan_2s_ease-in-out_infinite]" />
                </div>
              </div>
            </div>

            <button onClick={() => fileImgRef.current?.click()} className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm transition-colors">
              <FiImage /> Upload from Gallery
            </button>
            <input type="file" accept="image/*" className="hidden" ref={fileImgRef} onChange={handleImageUpload} />
          </motion.div>
        )}

        {/* ── Connecting ───────────────────────────────────────────────────── */}
        {state === 'connecting' && (
          <motion.div key="connecting" className="w-full max-w-sm text-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-10 flex flex-col items-center">
              <div className="w-16 h-16 rounded-full border-4 border-blue-500 border-t-transparent animate-spin mb-6" />
              <h3 className="text-xl font-bold mb-2">Connecting...</h3>
              <p className="text-slate-400 text-sm">Establishing secure connection with sender.</p>
            </div>
          </motion.div>
        )}

        {/* ── Transferring ─────────────────────────────────────────────────── */}
        {state === 'transferring' && (
          <motion.div key="xfer" className="w-full max-w-md" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <p className="font-semibold text-white">
                    {overallStatus === 'waiting' 
                      ? 'Sender is uploading to cloud...' 
                      : (files[currentFileIndex]?.name ?? 'Receiving...')}
                  </p>
                  {files.length > 1 && (
                    <p className="text-slate-500 text-xs">File {currentFileIndex + 1} of {files.length}</p>
                  )}
                </div>
                <NetworkBadge />
              </div>

              {/* Progress bar */}
              <div className="h-3 w-full bg-slate-800 rounded-full overflow-hidden mb-3">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500"
                  style={{ width: `${overallProgress}%` }}
                  transition={{ ease: 'linear', duration: 0.25 }}
                />
              </div>

              <div className="flex justify-between text-sm mb-4">
                <span className="text-slate-300 font-medium">{Math.round(overallProgress)}%</span>
                <span className="text-slate-400">{formatSize(overallSpeedBps)}/s</span>
                <span className="text-slate-500">ETA {formatTime(overallEtaSeconds)}</span>
              </div>

              <p className="text-slate-500 text-xs text-center">
                {formatSize(totalBytesTransferred)} / {formatSize(totalBytes)}
              </p>
            </div>
          </motion.div>
        )}

        {/* ── Done ─────────────────────────────────────────────────────────── */}
        {state === 'done' && (
          <motion.div key="done" className="w-full max-w-sm text-center" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-10 flex flex-col items-center">
              <div className="w-20 h-20 bg-emerald-500/15 rounded-full flex items-center justify-center mb-6">
                <FiCheckCircle className="text-emerald-400 text-4xl" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Download Complete!</h2>
              <p className="text-slate-400 mb-8">
                {files.length} file{files.length > 1 ? 's' : ''} received successfully.
              </p>
              <button
                onClick={() => {
                  useRoomStore.getState().reset();
                  useTransferStore.getState().reset();
                  closeWebRTC();
                  setState('idle');
                }}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-bold transition-colors"
              >
                Receive Another File
              </button>
            </div>
          </motion.div>
        )}

        {/* ── Failed ─────────────────────────────────────────────────────────── */}
        {state === 'failed' && (
          <motion.div key="failed" className="w-full max-w-sm text-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-10 flex flex-col items-center">
              <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
                <FiXCircle className="text-red-400 text-4xl" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Transfer Failed</h2>
              <p className="text-slate-400 mb-8">Something went wrong. Please try again.</p>
              <button
                onClick={() => { useRoomStore.getState().reset(); useTransferStore.getState().reset(); closeWebRTC(); setState('idle'); }}
                className="w-full bg-slate-800 hover:bg-slate-700 text-white py-3 rounded-xl font-bold transition-colors"
              >
                Try Again
              </button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
};

export default Receive;
