import { create } from 'zustand';
import type { RoomData, PendingRequest, DeviceInfo } from '../../../shared/types';
import { persist, createJSONStorage } from 'zustand/middleware';

interface RoomState {
  roomData: RoomData | null;
  isConnectedToSignaling: boolean;
  
  // Sender specific
  pendingRequests: PendingRequest[];
  connectedReceivers: Map<string, DeviceInfo>; // socketId -> DeviceInfo
  
  // Receiver specific
  isWaitingForApproval: boolean;
  approvalRejectedReason: string | null;
  myDeviceInfo: DeviceInfo | null;
  senderDisconnected: boolean;
  
  setRoomData: (data: RoomData | null) => void;
  setSignalingConnection: (isConnected: boolean) => void;
  
  addPendingRequest: (req: PendingRequest) => void;
  removePendingRequest: (socketId: string) => void;
  addConnectedReceiver: (socketId: string, deviceInfo: DeviceInfo) => void;
  removeConnectedReceiver: (socketId: string) => void;
  
  setWaitingForApproval: (isWaiting: boolean) => void;
  setApprovalRejected: (reason: string | null) => void;
  setMyDeviceInfo: (info: DeviceInfo) => void;
  setSenderDisconnected: (disconnected: boolean) => void;
  
  reset: () => void;
}

export const useRoomStore = create<RoomState>()(
  persist(
    (set) => ({
  roomData: null,
  isConnectedToSignaling: false,
  
  pendingRequests: [],
  connectedReceivers: new Map(),
  
  isWaitingForApproval: false,
  approvalRejectedReason: null,
  myDeviceInfo: null,
  senderDisconnected: false,

  setRoomData: (data) => set({ roomData: data }),
  setSignalingConnection: (isConnectedToSignaling) => set({ isConnectedToSignaling }),
  
  addPendingRequest: (req) => set((state) => {
    // Avoid duplicates
    if (!state.pendingRequests.find(r => r.socketId === req.socketId)) {
      return { pendingRequests: [...state.pendingRequests, req] };
    }
    return state;
  }),
  removePendingRequest: (socketId) => set((state) => ({
    pendingRequests: state.pendingRequests.filter(r => r.socketId !== socketId)
  })),
  
  addConnectedReceiver: (socketId, deviceInfo) => set((state) => {
    const newMap = new Map(state.connectedReceivers);
    newMap.set(socketId, deviceInfo);
    return { connectedReceivers: newMap };
  }),
  removeConnectedReceiver: (socketId) => set((state) => {
    const newMap = new Map(state.connectedReceivers);
    newMap.delete(socketId);
    return { connectedReceivers: newMap };
  }),

  setWaitingForApproval: (isWaiting) => set({ isWaitingForApproval: isWaiting }),
  setApprovalRejected: (reason) => set({ approvalRejectedReason: reason }),
  setMyDeviceInfo: (info) => set({ myDeviceInfo: info }),
  setSenderDisconnected: (disconnected) => set({ senderDisconnected: disconnected }),
  
  reset: () => set({ 
    roomData: null, 
    pendingRequests: [],
    connectedReceivers: new Map(),
    isWaitingForApproval: false,
    approvalRejectedReason: null,
    senderDisconnected: false,
  })
  }),
  {
    name: 'chikko-room-session',
    storage: createJSONStorage(() => sessionStorage),
    partialize: (state) => ({ roomData: state.roomData }), // Only persist roomData to session storage
  }
));
