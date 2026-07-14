import React, { useState, useEffect } from 'react';
import QRCode from 'react-qr-code';
import { motion } from 'framer-motion';
import { FiUploadCloud, FiCheck, FiX, FiActivity, FiSettings, FiTrash2 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { socket, connectSocket } from '../services/socket';
import { startTransferToAll, removePeer, clearPeers } from '../services/webrtc';
import { useRoomStore } from '../store/roomStore';
import { useTransferStore } from '../store/transferStore';
import type { TransferMode } from '../../../shared/types';


const Send: React.FC = () => {
  const { roomData, pendingRequests, connectedReceivers } = useRoomStore();
  const { files, setFiles, senderStatus, receiverStates, totalBytes } = useTransferStore();
  
  const [dragActive, setDragActive] = useState(false);
  const [selectedMode, setSelectedMode] = useState<TransferMode>('private');
  const [maxReceivers, setMaxReceivers] = useState(1);
  const [roomCreated, setRoomCreated] = useState(false);

  useEffect(() => {
    connectSocket();
    useTransferStore.getState().setRole('sender');
    
    const checkReclaim = async () => {
      const room = useRoomStore.getState().roomData;
      const sessionFiles = sessionStorage.getItem('chikko_files');
      
      if (room && sessionFiles) {
        socket.emit('reclaim_room', { roomId: room.roomId, token: room.token }, (res: any) => {
          if (res.error) {
            useRoomStore.getState().reset();
          } else {
            toast.success('Session restored! Please re-select your files to resume.');
            setRoomCreated(true);
            if (res.approvedReceivers) {
              res.approvedReceivers.forEach((ar: any) => {
                useRoomStore.getState().addConnectedReceiver(ar.socketId, ar.deviceInfo);
              });
            }
          }
        });
      }
    };
    
    // Tiny delay to ensure socket connects before emitting reclaim
    setTimeout(checkReclaim, 500);
  }, []);

  const handleCreateRoom = () => {
    if (selectedFiles.length === 0) return toast.error('Please select at least one file to send.');
    
    clearPeers();
    useRoomStore.getState().reset();
    useTransferStore.getState().reset();
    // Re-apply role and files since reset clears them
    useTransferStore.getState().setRole('sender');
    useTransferStore.getState().setFiles(selectedFiles.map(f => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })));
    
    // Generate a sender name if not existing
    let senderName = localStorage.getItem('chikko_device_name');
    if (!senderName) {
      senderName = `Sender-${Math.floor(Math.random() * 10000)}`;
      localStorage.setItem('chikko_device_name', senderName);
    }
    
    socket.emit('create_room', { 
      transferMode: selectedMode, 
      maxReceivers,
      senderName,
      fileCount: selectedFiles.length,
      totalSize: totalBytes
    });
    setRoomCreated(true);
  };

  const handleFiles = (newFiles: File[]) => {
    const sessionFilesStr = sessionStorage.getItem('chikko_files');
    if (sessionFilesStr && roomCreated) {
       const sessionFiles = JSON.parse(sessionFilesStr);
       if (newFiles.length !== sessionFiles.length) {
         return toast.error(`Expected ${sessionFiles.length} files. Please select the correct files to resume.`);
       }
       for (let i = 0; i < newFiles.length; i++) {
         if (newFiles[i].name !== sessionFiles[i].name || newFiles[i].size !== sessionFiles[i].size || newFiles[i].lastModified !== sessionFiles[i].lastModified) {
           return toast.error(`File mismatch: ${newFiles[i].name}. Please select the exact original files.`);
         }
       }
       toast.success('Files validated! Ready to resume transfer.');
    }

    setSelectedFiles(newFiles);
    setFiles(newFiles.map(f => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })));
  };

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };



  const startTransfer = async () => {
    if (connectedReceivers.size === 0) return;
    if (selectedFiles.length === 0) return;
    await startTransferToAll(selectedFiles[0]);
  };

  // Auto-start transfer once connections are established
  useEffect(() => {
    if (selectedFiles.length > 0 && connectedReceivers.size > 0 && senderStatus === 'idle') {
      // Check if any of the *currently connected* receivers are ready
      const anyCurrentReady = Array.from(connectedReceivers.keys()).some(socketId => 
        receiverStates.get(socketId)?.status === 'connected'
      );
      if (anyCurrentReady) {
        startTransfer();
      }
    }
  }, [selectedFiles, connectedReceivers.size, senderStatus, receiverStates, connectedReceivers]);

  const approveRequest = (socketId: string) => {
    if (!roomData) return;
    socket.emit('approve_request', { roomId: roomData.roomId, receiverSocketId: socketId });
    useRoomStore.getState().removePendingRequest(socketId);
  };

  const rejectRequest = (socketId: string) => {
    if (!roomData) return;
    socket.emit('reject_request', { roomId: roomData.roomId, receiverSocketId: socketId, reason: 'Sender rejected.' });
    useRoomStore.getState().removePendingRequest(socketId);
  };

  const handleDisconnectReceiver = (socketId: string) => {
    removePeer(socketId);
    useRoomStore.getState().removeConnectedReceiver(socketId);
  };

  const qrData = roomData ? JSON.stringify({ 
    roomId: roomData.roomId, 
    token: roomData.token,
    version: 1,
    timestamp: Date.now()
  }) : '';

  // Calculate aggregates
  let aggBytes = 0;
  let aggSpeed = 0;
  let activeTransfers = 0;
  receiverStates.forEach(state => {
    aggBytes += state.bytesTransferred;
    aggSpeed += state.speedBytesPerSecond;
    if (state.status === 'transferring') activeTransfers++;
  });
  
  const totalExpectedBytes = totalBytes * (connectedReceivers.size || 1);
  const aggProgress = totalExpectedBytes > 0 ? (aggBytes / totalExpectedBytes) * 100 : 0;

  return (
    <div className="flex flex-col items-center py-8">
      {!roomCreated ? (
        <motion.div className="glass-panel w-full max-w-xl p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <h2 className="text-3xl font-bold mb-6 flex items-center gap-3"><FiSettings className="text-blue-400"/> Configure Transfer</h2>
          
          <div className="mb-8">
            <label className="block text-slate-300 font-medium mb-3">1. Select Files</label>
            <div 
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl cursor-pointer p-6 text-center transition-colors
                ${dragActive ? 'border-blue-500 bg-blue-500/10' : 'border-slate-600 hover:border-slate-500 hover:bg-slate-800/50'}
              `}
              onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); setDragActive(false); if (e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files)); }}
              onClick={() => document.getElementById('file-upload-init')?.click()}
            >
              <input id="file-upload-init" type="file" multiple className="hidden" onChange={(e) => e.target.files && handleFiles(Array.from(e.target.files))} />
              <FiUploadCloud className="text-4xl text-slate-400 mb-2" />
              {selectedFiles.length > 0 ? (
                <div className="text-blue-400 font-bold">{selectedFiles.length} file(s) selected ({formatSize(totalBytes)})</div>
              ) : (
                <p className="text-slate-300">Click or drag files here</p>
              )}
            </div>
          </div>

          <div className="mb-6">
            <label className="block text-slate-300 font-medium mb-2">2. Transfer Mode</label>
            <div className="grid grid-cols-3 gap-3">
              {(['private', 'broadcast', 'queue'] as TransferMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => {
                    setSelectedMode(mode);
                    if (mode === 'private') setMaxReceivers(1);
                    else if (maxReceivers === 1) setMaxReceivers(5);
                  }}
                  className={`p-3 rounded-xl capitalize font-medium transition-colors border ${
                    selectedMode === mode 
                    ? 'bg-blue-600 border-blue-500 text-white' 
                    : 'bg-slate-900/50 border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-8">
            <label className="block text-slate-300 font-medium mb-2">3. Max Receivers</label>
            <select 
              value={maxReceivers} 
              onChange={(e) => setMaxReceivers(Number(e.target.value))}
              disabled={selectedMode === 'private'}
              className="w-full bg-slate-900/50 border border-slate-700 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value={1}>1 Receiver</option>
              <option value={2}>2 Receivers</option>
              <option value={5}>5 Receivers</option>
              <option value={10}>10 Receivers</option>
              <option value={20}>20 Receivers</option>
            </select>
          </div>

          <button onClick={handleCreateRoom} className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold text-lg shadow-lg">
            Create Session
          </button>
        </motion.div>
      ) : (
        <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left Column: QR & Pending */}
          <div className="flex flex-col gap-6">
            <motion.div className="glass-panel p-6 flex flex-col items-center">
              {roomData ? (
                <>
                  <div className="bg-white p-3 rounded-xl mb-4"><QRCode value={qrData} size={150} /></div>
                  <p className="text-slate-400 text-sm mb-1">Room Code</p>
                  <p className="font-mono text-2xl tracking-widest font-bold text-blue-400 mb-2">{roomData.roomId}</p>
                  <div className="flex gap-2">
                    <span className="px-2 py-1 bg-slate-800 rounded text-xs capitalize text-slate-300">{roomData.transferMode}</span>
                    <span className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-300">{connectedReceivers.size} / {roomData.maxReceivers} Connected</span>
                  </div>
                </>
              ) : (
                 <div className="animate-pulse h-[250px] bg-slate-800 rounded-xl w-full" />
              )}
            </motion.div>

            {pendingRequests.length > 0 && (
              <motion.div className="glass-panel p-6 border-l-4 border-l-yellow-500">
                <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-yellow-400">
                  <FiActivity /> Pending Requests ({pendingRequests.length})
                </h3>
                <div className="flex flex-col gap-3">
                  {pendingRequests.map((req) => (
                    <div key={req.socketId} className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 flex flex-col gap-2">
                      <div className="font-medium">{req.deviceInfo.name}</div>
                      <div className="flex gap-2 text-xs text-slate-400 mb-1">
                        <span className="bg-slate-800 px-2 rounded">{req.deviceInfo.platform}</span>
                        <span className="bg-slate-800 px-2 rounded">{req.deviceInfo.browser}</span>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => approveRequest(req.socketId)} className="flex-1 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 py-1.5 rounded-lg flex items-center justify-center gap-1"><FiCheck/> Approve</button>
                        <button onClick={() => rejectRequest(req.socketId)} className="flex-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 py-1.5 rounded-lg flex items-center justify-center gap-1"><FiX/> Reject</button>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>

          {/* Middle/Right Column: File & Connected */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            
            {/* File Selection / Overall Progress */}
            <motion.div className="glass-panel p-6">
               {senderStatus === 'idle' ? (
                 <div className="flex flex-col h-full justify-center">
                    {files.length > 0 && (
                      <div className="flex flex-col items-center justify-center bg-slate-900/50 p-8 rounded-xl border border-slate-700 h-full">
                        <div className="text-center mb-6">
                          <div className="text-xl font-bold text-slate-200 mb-2">{files.length} File(s) Ready to Send</div>
                          <div className="text-slate-400">{formatSize(totalBytes)} total</div>
                        </div>
                        <div className="flex flex-col gap-4 items-center w-full max-w-sm">
                          {connectedReceivers.size === 0 ? (
                            <div className="flex items-center gap-3 px-6 py-4 bg-slate-800 text-slate-300 font-medium rounded-xl w-full justify-center shadow-inner">
                              <span className="animate-spin h-5 w-5 border-2 border-slate-500 border-t-slate-300 rounded-full" />
                              Waiting for receivers to join...
                            </div>
                          ) : (
                            <div className="flex items-center gap-3 px-6 py-4 bg-blue-600/20 text-blue-400 font-bold rounded-xl w-full justify-center border border-blue-500/30">
                              <span className="animate-pulse h-3 w-3 bg-blue-400 rounded-full" />
                              Establishing connection...
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                 </div>
               ) : (
                 <div className="flex flex-col">
                    <h3 className="text-xl font-bold mb-4">Overall Progress</h3>
                    
                    <div className="grid grid-cols-3 gap-4 mb-6">
                       <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                         <div className="text-slate-400 text-sm mb-1">Total Speed</div>
                         <div className="font-mono text-2xl text-blue-400">{formatSize(aggSpeed)}/s</div>
                       </div>
                       <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                         <div className="text-slate-400 text-sm mb-1">Sent</div>
                         <div className="font-mono text-2xl text-emerald-400">{formatSize(aggBytes)}</div>
                       </div>
                       <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                         <div className="text-slate-400 text-sm mb-1">Active Transfers</div>
                         <div className="font-mono text-2xl text-purple-400">{activeTransfers}</div>
                       </div>
                    </div>

                    <div className="h-4 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-300" style={{ width: `${aggProgress}%` }} />
                    </div>
                 </div>
               )}
            </motion.div>

            {/* Connected Receivers List */}
            <motion.div className="glass-panel p-6 flex-1">
               <h3 className="font-bold text-lg mb-4 flex items-center justify-between">
                 <span>Connected Receivers ({connectedReceivers.size})</span>
               </h3>
               
               {connectedReceivers.size === 0 ? (
                 <div className="text-center text-slate-500 py-8">Waiting for devices to connect...</div>
               ) : (
                 <div className="flex flex-col gap-4">
                   {Array.from(connectedReceivers.entries()).map(([socketId, device]) => {
                      const state = receiverStates.get(socketId);
                      const isTransferring = state?.status === 'transferring';
                      
                      return (
                        <div key={socketId} className="bg-slate-900/40 p-4 rounded-xl border border-slate-700/50">
                          <div className="flex justify-between items-start mb-3">
                            <div>
                              <div className="font-medium text-lg">{device.name}</div>
                              <div className="text-xs text-slate-400">ID: {device.deviceId} • {device.platform}</div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className={`px-2 py-1 text-xs rounded font-bold uppercase
                                ${state?.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400' :
                                  state?.status === 'transferring' ? 'bg-blue-500/10 text-blue-400' :
                                  state?.status === 'failed' ? 'bg-red-500/10 text-red-400' : 'bg-slate-500/10 text-slate-400'}
                              `}>
                                {state?.status || 'connected'}
                              </div>
                              <button onClick={() => handleDisconnectReceiver(socketId)} className="text-slate-500 hover:text-red-400 transition-colors p-1"><FiTrash2/></button>
                            </div>
                          </div>

                          {(isTransferring || state?.status === 'completed') && state && (
                            <div>
                               <div className="flex justify-between text-xs text-slate-300 mb-2">
                                 <span>{Math.round(state.progress)}%</span>
                                 <span>{formatSize(state.speedBytesPerSecond)}/s</span>
                               </div>
                               <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                                 <div className={`h-full transition-all duration-300 ${state.status === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${state.progress}%` }} />
                               </div>
                            </div>
                          )}
                        </div>
                      )
                   })}
                 </div>
               )}
            </motion.div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Send;
