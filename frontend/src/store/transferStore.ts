import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TransferStatus = 'idle' | 'preparing' | 'connected' | 'transferring' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'rejected';

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified?: number;
}

export interface ReceiverTransferState {
  status: TransferStatus;
  progress: number;
  speedBytesPerSecond: number;
  bytesTransferred: number;
  etaSeconds: number;
}

export interface TransferRecord {
  id: string;
  fileName: string;
  size: number;
  mode: string;
  deviceName: string;
  date: number;
  status: 'Completed' | 'Failed' | 'Cancelled';
  duration: number;
}

interface TransferState {
  role: 'sender' | 'receiver' | null;
  
  // File details
  files: FileMetadata[];
  totalBytes: number;
  
  // Global Sender State
  senderStatus: TransferStatus;
  receiverStates: Map<string, ReceiverTransferState>; // socketId -> State
  
  // Receiver Specific State (if role === 'receiver')
  myTransferState: ReceiverTransferState;

  // History (Persistent)
  history: TransferRecord[];

  // Actions
  setRole: (role: 'sender' | 'receiver') => void;
  setSenderStatus: (status: TransferStatus) => void;
  setFiles: (files: FileMetadata[]) => void;
  
  initReceiverState: (socketId: string) => void;
  updateReceiverState: (socketId: string, bytesAdded: number, speed: number) => void;
  setReceiverStatus: (socketId: string, status: TransferStatus) => void;
  
  // For Receiver Role
  updateMyState: (bytesAdded: number, speed: number) => void;
  setMyStatus: (status: TransferStatus) => void;

  // History Actions
  addHistoryRecord: (record: Omit<TransferRecord, 'id'>) => void;
  clearHistory: () => void;

  reset: () => void;
}

const defaultReceiverState: ReceiverTransferState = {
  status: 'idle',
  progress: 0,
  speedBytesPerSecond: 0,
  bytesTransferred: 0,
  etaSeconds: 0,
};

export const useTransferStore = create<TransferState>()(
  persist(
    (set) => ({
      role: null,
      files: [],
      totalBytes: 0,
      
      senderStatus: 'idle',
      receiverStates: new Map(),
      
      myTransferState: { ...defaultReceiverState },
      
      history: [],

      setRole: (role) => {
        if (role) sessionStorage.setItem('chikko_role', role);
        else sessionStorage.removeItem('chikko_role');
        set({ role });
      },
      setSenderStatus: (status) => set({ senderStatus: status }),
      setFiles: (files) => {
        const totalBytes = files.reduce((acc, file) => acc + file.size, 0);
        sessionStorage.setItem('chikko_files', JSON.stringify(files));
        set({ files, totalBytes });
      },

      initReceiverState: (socketId) => set((state) => {
        const newMap = new Map(state.receiverStates);
        newMap.set(socketId, { ...defaultReceiverState, status: 'connected' });
        return { receiverStates: newMap };
      }),

      updateReceiverState: (socketId, bytesAdded, speed) => set((state) => {
        const newMap = new Map(state.receiverStates);
        const curr = newMap.get(socketId);
        if (curr) {
          const newBytes = curr.bytesTransferred + bytesAdded;
          const progress = state.totalBytes > 0 ? (newBytes / state.totalBytes) * 100 : 0;
          const eta = speed > 0 ? (state.totalBytes - newBytes) / speed : 0;
          
          newMap.set(socketId, {
            ...curr,
            bytesTransferred: newBytes,
            speedBytesPerSecond: speed,
            progress: Math.min(progress, 100),
            etaSeconds: eta,
          });
        }
        return { receiverStates: newMap };
      }),

      setReceiverStatus: (socketId, status) => set((state) => {
        const newMap = new Map(state.receiverStates);
        const curr = newMap.get(socketId);
        if (curr) {
          newMap.set(socketId, { ...curr, status });
        }
        return { receiverStates: newMap };
      }),

      updateMyState: (bytesAdded, speed) => set((state) => {
        const newBytes = state.myTransferState.bytesTransferred + bytesAdded;
        const progress = state.totalBytes > 0 ? (newBytes / state.totalBytes) * 100 : 0;
        const eta = speed > 0 ? (state.totalBytes - newBytes) / speed : 0;
        
        return {
          myTransferState: {
            ...state.myTransferState,
            bytesTransferred: newBytes,
            speedBytesPerSecond: speed,
            progress: Math.min(progress, 100),
            etaSeconds: eta,
          }
        };
      }),

      setMyStatus: (status) => set((state) => ({
        myTransferState: { ...state.myTransferState, status }
      })),

      addHistoryRecord: (record) => set((state) => ({
        history: [{ ...record, id: Math.random().toString(36).substring(2, 9) }, ...state.history]
      })),
      
      clearHistory: () => set({ history: [] }),

      reset: () => {
        sessionStorage.removeItem('chikko_role');
        sessionStorage.removeItem('chikko_files');
        set({
          role: null,
          files: [],
          totalBytes: 0,
          senderStatus: 'idle',
          receiverStates: new Map(),
          myTransferState: { ...defaultReceiverState },
        });
      }
    }),
    {
      name: 'chikko-transfer-storage',
      partialize: (state) => ({ history: state.history }), // Only persist history
    }
  )
);
