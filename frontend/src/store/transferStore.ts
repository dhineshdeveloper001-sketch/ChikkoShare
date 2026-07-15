import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FileEntry, TransferRecord, TransferStatus, NetworkMode } from '../../../shared/types';

// ── Per-file transfer progress ────────────────────────────────────────────────
export interface FileTransferState {
  file: FileEntry;
  status: TransferStatus;
  bytesTransferred: number;
  speedBps: number;       // bytes/sec
  etaSeconds: number;
  progress: number;       // 0-100
}

interface TransferStoreState {
  role: 'sender' | 'receiver' | null;

  // Batch of files being transferred
  files: FileEntry[];
  totalBytes: number;
  fileStates: FileTransferState[];
  currentFileIndex: number;

  // Overall status
  overallStatus: TransferStatus;
  networkMode: NetworkMode;
  isPaused: boolean;

  // Aggregated progress (for display)
  totalBytesTransferred: number;
  overallSpeedBps: number;
  overallEtaSeconds: number;

  // History (persisted to localStorage)
  history: TransferRecord[];

  // Actions
  setRole: (role: 'sender' | 'receiver') => void;
  setFiles: (files: FileEntry[]) => void;
  setNetworkMode: (mode: NetworkMode) => void;
  setOverallStatus: (status: TransferStatus) => void;

  updateFileProgress: (index: number, bytesAdded: number, speedBps: number) => void;
  setFileStatus: (index: number, status: TransferStatus) => void;

  setPaused: (v: boolean) => void;
  cancel: () => void;

  addHistoryRecord: (record: Omit<TransferRecord, 'id'>) => void;
  clearHistory: () => void;
  reset: () => void;
}

export const useTransferStore = create<TransferStoreState>()(
  persist(
    (set) => ({
      role: null,
      files: [],
      totalBytes: 0,
      fileStates: [],
      currentFileIndex: 0,
      overallStatus: 'idle',
      networkMode: 'detecting',
      isPaused: false,
      totalBytesTransferred: 0,
      overallSpeedBps: 0,
      overallEtaSeconds: 0,
      history: [],

      setRole: (role) => set({ role }),

      setFiles: (files) => {
        const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
        const fileStates: FileTransferState[] = files.map((f) => ({
          file: f,
          status: 'idle',
          bytesTransferred: 0,
          speedBps: 0,
          etaSeconds: 0,
          progress: 0,
        }));
        // Store raw File objects on window for webrtc.ts to access
        set({ files, totalBytes, fileStates, currentFileIndex: 0, totalBytesTransferred: 0 });
      },

      setNetworkMode: (networkMode) => set({ networkMode }),
      setOverallStatus: (overallStatus) => set({ overallStatus }),

      updateFileProgress: (index, bytesAdded, speedBps) => set((state) => {
        const newStates = [...state.fileStates];
        const curr = newStates[index];
        if (!curr) return {};

        const newBytes = curr.bytesTransferred + bytesAdded;
        const progress = curr.file.size > 0 ? Math.min((newBytes / curr.file.size) * 100, 100) : 0;
        const eta = speedBps > 0 ? (curr.file.size - newBytes) / speedBps : 0;

        newStates[index] = { ...curr, bytesTransferred: newBytes, speedBps, etaSeconds: eta, progress };

        // Recalculate overall
        const totalBytesTransferred = newStates.reduce((acc, s) => acc + s.bytesTransferred, 0);
        const overallSpeedBps = speedBps;
        const remaining = state.totalBytes - totalBytesTransferred;
        const overallEtaSeconds = speedBps > 0 ? remaining / speedBps : 0;

        return { fileStates: newStates, totalBytesTransferred, overallSpeedBps, overallEtaSeconds };
      }),

      setFileStatus: (index, status) => set((state) => {
        const newStates = [...state.fileStates];
        if (newStates[index]) {
          newStates[index] = { ...newStates[index], status };
        }
        // Advance currentFileIndex when a file completes
        const nextIndex = status === 'completed' ? index + 1 : state.currentFileIndex;
        return { fileStates: newStates, currentFileIndex: nextIndex };
      }),

      setPaused: (isPaused) => set({ isPaused }),

      cancel: () => set((state) => ({
        overallStatus: 'cancelled',
        isPaused: false,
        fileStates: state.fileStates.map((s) =>
          s.status === 'transferring' || s.status === 'paused'
            ? { ...s, status: 'cancelled' }
            : s
        ),
      })),

      addHistoryRecord: (record) => set((state) => ({
        history: [
          { ...record, id: crypto.randomUUID() },
          ...state.history,
        ].slice(0, 200), // keep last 200 records
      })),

      clearHistory: () => set({ history: [] }),

      reset: () => {
        (window as any).__chikkoFiles = [];
        set({
          role: null,
          files: [],
          totalBytes: 0,
          fileStates: [],
          currentFileIndex: 0,
          overallStatus: 'idle',
          networkMode: 'detecting',
          isPaused: false,
          totalBytesTransferred: 0,
          overallSpeedBps: 0,
          overallEtaSeconds: 0,
        });
      },
    }),
    {
      name: 'chikko-transfer-v3',
      partialize: (state) => ({ history: state.history }),
    }
  )
);
