import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { NetworkMode } from '../../../shared/types';

interface RoomState {
  roomId: string | null;
  token: string | null;
  isSignalingConnected: boolean;
  peerConnected: boolean;
  networkMode: NetworkMode;

  setRoom: (roomId: string, token: string) => void;
  setSignalingConnected: (v: boolean) => void;
  setPeerConnected: (v: boolean) => void;
  setNetworkMode: (mode: NetworkMode) => void;
  reset: () => void;
}

export const useRoomStore = create<RoomState>()(
  persist(
    (set) => ({
      roomId: null,
      token: null,
      isSignalingConnected: false,
      peerConnected: false,
      networkMode: 'detecting',

      setRoom: (roomId, token) => set({ roomId, token }),
      setSignalingConnected: (isSignalingConnected) => set({ isSignalingConnected }),
      setPeerConnected: (peerConnected) => set({ peerConnected }),
      setNetworkMode: (networkMode) => set({ networkMode }),

      reset: () => set({
        roomId: null,
        token: null,
        peerConnected: false,
        networkMode: 'detecting',
      }),
    }),
    {
      name: 'chikko-room-v3',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ roomId: state.roomId, token: state.token }),
    }
  )
);
