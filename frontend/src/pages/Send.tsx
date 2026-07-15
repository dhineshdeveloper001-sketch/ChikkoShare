import React, { useState, useEffect, useCallback, useRef } from 'react';
import QRCode from 'react-qr-code';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FiUploadCloud, FiFile, FiFolder, FiX, FiCopy, FiCheck,
  FiZap, FiCloud, FiLoader, FiPause, FiPlay,
} from 'react-icons/fi';
import { socket, connectSocket } from '../services/socket';
import { closeWebRTC, pauseWebRTC, resumeWebRTC, cancelWebRTC } from '../services/webrtc';
import { cancelCloudUpload } from '../services/cloudTransfer';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import type { FileEntry } from '../../../shared/types';

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

// Collect files from a DataTransfer (supports folders via webkitGetAsEntry)
async function collectFiles(dataTransfer: DataTransfer): Promise<{ files: File[]; entries: FileEntry[] }> {
  const files: File[]    = [];
  const entries: FileEntry[] = [];

  const processEntry = async (entry: FileSystemEntry, path = ''): Promise<void> => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      await new Promise<void>((res) => {
        fileEntry.file((f) => {
          const relative = path ? `${path}/${f.name}` : f.name;
          files.push(f);
          entries.push({
            name: f.name, relativePath: relative,
            size: f.size, type: f.type || 'application/octet-stream',
            lastModified: f.lastModified,
          });
          res();
        });
      });
    } else if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      await new Promise<void>((res) => {
        dirReader.readEntries(async (dirEntries) => {
          for (const e of dirEntries) {
            await processEntry(e, path ? `${path}/${entry.name}` : entry.name);
          }
          res();
        });
      });
    }
  };

  // Use webkitGetAsEntry for folder support
  const items = Array.from(dataTransfer.items);
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await processEntry(entry);
    else {
      const f = item.getAsFile();
      if (f) {
        files.push(f);
        entries.push({ name: f.name, relativePath: f.name, size: f.size, type: f.type || 'application/octet-stream', lastModified: f.lastModified });
      }
    }
  }

  return { files, entries };
}

// Normalise regular file input (no folder support)
function fromFileList(fileList: FileList): { files: File[]; entries: FileEntry[] } {
  const files: File[]    = [];
  const entries: FileEntry[] = [];
  Array.from(fileList).forEach((f) => {
    files.push(f);
    entries.push({ name: f.name, relativePath: f.webkitRelativePath || f.name, size: f.size, type: f.type || 'application/octet-stream', lastModified: f.lastModified });
  });
  return { files, entries };
}

// ── Component ──────────────────────────────────────────────────────────────────
type SendState = 'picking' | 'waiting' | 'transferring' | 'done';

const Send: React.FC = () => {
  const { roomId, token, peerConnected, networkMode } = useRoomStore();
  const {
    files, fileStates, overallStatus, overallSpeedBps, overallEtaSeconds,
    totalBytesTransferred, totalBytes, isPaused, currentFileIndex,
  } = useTransferStore();

  const [sendState, setSendState]   = useState<SendState>('picking');
  const [dragActive, setDragActive] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const fileInputRef                = useRef<HTMLInputElement>(null);
  const folderInputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => {
    connectSocket();
    useTransferStore.getState().setRole('sender');
    return () => {
      useRoomStore.getState().reset();
      useTransferStore.getState().reset();
      import('../services/webrtc').then((m) => m.closeWebRTC());
    };
  }, []);

  // Advance state when transfer completes
  useEffect(() => {
    if (overallStatus === 'completed' || overallStatus === 'cancelled') {
      setSendState('done');
    } else if (overallStatus === 'transferring') {
      setSendState('transferring');
    }
  }, [overallStatus]);

  // ── File selection ─────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (fileObjs: File[], entryObjs: FileEntry[]) => {
    if (fileObjs.length === 0) return;

    useTransferStore.getState().reset();
    useTransferStore.getState().setRole('sender');
    useTransferStore.getState().setFiles(entryObjs, fileObjs);

    useRoomStore.getState().reset();
    closeWebRTC();

    // Auto-create room
    socket.once('connect', () => {});
    connectSocket();

    socket.emit('create_room', (data) => {
      useRoomStore.getState().setRoom(data.roomId, data.token);
      setSendState('waiting');
    });
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const { files: f, entries: en } = await collectFiles(e.dataTransfer);
    if (f.length) handleFiles(f, en);
  }, [handleFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      const { files: f, entries: en } = fromFileList(e.target.files);
      handleFiles(f, en);
    }
  };

  // ── Room code copy ─────────────────────────────────────────────────────────
  const copyCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  };

  // ── Pause / Resume ─────────────────────────────────────────────────────────
  const handlePause = () => {
    useTransferStore.getState().setPaused(true);
    pauseWebRTC();
  };
  const handleResume = () => {
    useTransferStore.getState().setPaused(false);
    resumeWebRTC();
  };
  const handleCancel = () => {
    cancelWebRTC();
    cancelCloudUpload();
    useTransferStore.getState().cancel();
  };

  // ── QR data ───────────────────────────────────────────────────────────────
  const qrValue = roomId && token
    ? JSON.stringify({ roomId, token, v: 3 })
    : '';

  // ── Network badge ─────────────────────────────────────────────────────────
  const NetworkBadge = () => {
    if (networkMode === 'local')
      return <span className="flex items-center gap-1 text-emerald-400 text-xs font-medium"><FiZap /> Local (WebRTC)</span>;
    if (networkMode === 'cloud')
      return <span className="flex items-center gap-1 text-blue-400 text-xs font-medium"><FiCloud /> Cloud (B2)</span>;
    return <span className="flex items-center gap-1 text-slate-500 text-xs"><FiLoader className="animate-spin" /> Detecting...</span>;
  };

  // ── Overall progress bar ──────────────────────────────────────────────────
  const overallProgress = totalBytes > 0 ? Math.min((totalBytesTransferred / totalBytes) * 100, 100) : 0;

  return (
    <div className="flex flex-col items-center w-full">
      <AnimatePresence mode="wait">

        {/* ── State: Picking files ─────────────────────────────────────────── */}
        {sendState === 'picking' && (
          <motion.div
            key="picking"
            className="w-full max-w-lg"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            {/* Drop zone */}
            <div
              className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-3xl cursor-pointer p-12 text-center transition-all select-none
                ${dragActive
                  ? 'border-blue-500 bg-blue-500/10 scale-[1.01]'
                  : 'border-slate-700 hover:border-slate-500 bg-slate-900/40 hover:bg-slate-900/60'}`}
              onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-all
                ${dragActive ? 'bg-blue-500/20' : 'bg-slate-800'}`}>
                <FiUploadCloud className={`text-3xl ${dragActive ? 'text-blue-400' : 'text-slate-400'}`} />
              </div>
              <p className="font-semibold text-slate-200 text-lg mb-1">
                {dragActive ? 'Drop to share' : 'Drop files or folders here'}
              </p>
              <p className="text-slate-500 text-sm">
                or click to browse
              </p>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
            </div>

            {/* Folder button */}
            <button
              onClick={() => folderInputRef.current?.click()}
              className="w-full mt-3 flex items-center justify-center gap-2 bg-slate-800/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 py-3 rounded-2xl text-sm font-medium transition-colors border border-slate-700/50"
            >
              <FiFolder /> Select Folder
            </button>
            <input
              ref={folderInputRef}
              type="file"
              // @ts-ignore — webkitdirectory is non-standard but widely supported
              webkitdirectory=""
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
          </motion.div>
        )}

        {/* ── State: Waiting for receiver ──────────────────────────────────── */}
        {sendState === 'waiting' && (
          <motion.div
            key="waiting"
            className="w-full max-w-sm"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-8 flex flex-col items-center">
              {/* QR */}
              {qrValue && (
                <div className="bg-white p-3 rounded-2xl mb-6 shadow-xl">
                  <QRCode value={qrValue} size={180} />
                </div>
              )}

              {/* 6-digit code */}
              <p className="text-slate-500 text-sm mb-1">Room Code</p>
              <button
                onClick={copyCode}
                className="flex items-center gap-2 font-mono text-4xl font-extrabold tracking-[0.15em] text-white hover:text-blue-300 transition-colors mb-2"
              >
                {roomId ?? '------'}
                {codeCopied ? <FiCheck className="text-emerald-400 text-xl" /> : <FiCopy className="text-slate-600 text-xl" />}
              </button>
              <p className="text-slate-500 text-xs mb-6">Tap to copy</p>

              {/* Files summary */}
              <div className="w-full bg-slate-800/50 rounded-xl p-3 mb-6 space-y-1 max-h-36 overflow-y-auto">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-slate-300">
                    <FiFile className="text-blue-400 shrink-0" />
                    <span className="truncate flex-1">{f.relativePath || f.name}</span>
                    <span className="text-slate-500 shrink-0">{formatSize(f.size)}</span>
                  </div>
                ))}
              </div>

              {/* Waiting indicator */}
              {!peerConnected ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                  Waiting for receiver...
                </div>
              ) : (
                <div className="flex items-center gap-2 text-blue-400 text-sm">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  Receiver connected — establishing connection...
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── State: Transferring ──────────────────────────────────────────── */}
        {sendState === 'transferring' && (
          <motion.div
            key="transferring"
            className="w-full max-w-md"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-8">
              {/* Current file */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
                  <FiFile className="text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white truncate">
                    {files[currentFileIndex]?.name ?? 'Transferring...'}
                  </p>
                  <p className="text-slate-500 text-xs">
                    File {currentFileIndex + 1} of {files.length}
                  </p>
                </div>
                <NetworkBadge />
              </div>

              {/* Overall progress bar */}
              <div className="h-3 w-full bg-slate-800 rounded-full overflow-hidden mb-3">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500"
                  style={{ width: `${overallProgress}%` }}
                  transition={{ ease: 'linear', duration: 0.25 }}
                />
              </div>

              {/* Stats row */}
              <div className="flex justify-between text-sm mb-6">
                <span className="text-slate-300 font-medium">{Math.round(overallProgress)}%</span>
                <span className="text-slate-400">{formatSize(overallSpeedBps)}/s</span>
                <span className="text-slate-500">ETA {formatTime(overallEtaSeconds)}</span>
              </div>

              {/* Bytes */}
              <p className="text-slate-500 text-xs text-center mb-6">
                {formatSize(totalBytesTransferred)} / {formatSize(totalBytes)} transferred
              </p>

              {/* Per-file status (compact) */}
              {files.length > 1 && (
                <div className="space-y-1.5 mb-6 max-h-28 overflow-y-auto">
                  {fileStates.map((fs, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        fs.status === 'completed'    ? 'bg-emerald-400' :
                        fs.status === 'transferring' ? 'bg-blue-400 animate-pulse' :
                        fs.status === 'failed'       ? 'bg-red-400' :
                        'bg-slate-600'
                      }`} />
                      <span className="truncate flex-1 text-slate-400">{fs.file.name}</span>
                      <span className="text-slate-500 shrink-0">{Math.round(fs.progress)}%</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Controls */}
              <div className="flex gap-3">
                {isPaused ? (
                  <button
                    onClick={handleResume}
                    className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-semibold transition-colors"
                  >
                    <FiPlay /> Resume
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    className="flex-1 flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 py-3 rounded-xl font-semibold transition-colors"
                  >
                    <FiPause /> Pause
                  </button>
                )}
                <button
                  onClick={handleCancel}
                  className="flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-5 py-3 rounded-xl font-semibold transition-colors"
                >
                  <FiX /> Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── State: Done ──────────────────────────────────────────────────── */}
        {sendState === 'done' && (
          <motion.div
            key="done"
            className="w-full max-w-sm text-center"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-3xl p-10 flex flex-col items-center">
              <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-6 ${
                overallStatus === 'cancelled' ? 'bg-slate-800' : 'bg-emerald-500/15'
              }`}>
                {overallStatus === 'cancelled'
                  ? <FiX className="text-slate-400 text-4xl" />
                  : <FiCheck className="text-emerald-400 text-4xl" />
                }
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">
                {overallStatus === 'cancelled' ? 'Transfer Cancelled' : 'All Done!'}
              </h2>
              <p className="text-slate-400 mb-8">
                {overallStatus === 'cancelled'
                  ? 'The transfer was cancelled.'
                  : `${files.length} file${files.length > 1 ? 's' : ''} sent successfully.`
                }
              </p>
              <button
                onClick={() => {
                  useRoomStore.getState().reset();
                  useTransferStore.getState().reset();
                  closeWebRTC();
                  setSendState('picking');
                }}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-bold transition-colors"
              >
                Send More Files
              </button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
};

export default Send;
