import { create } from 'zustand';
import type { RoomData, PendingRequest, DeviceInfo } from '../../../shared/types';

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
  
  setRoomData: (data: RoomData | null) => void;
  setSignalingConnection: (isConnected: boolean) => void;
  
  addPendingRequest: (req: PendingRequest) => void;
  removePendingRequest: (socketId: string) => void;
  addConnectedReceiver: (socketId: string, deviceInfo: DeviceInfo) => void;
  removeConnectedReceiver: (socketId: string) => void;
  
  setWaitingForApproval: (isWaiting: boolean) => void;
  setApprovalRejected: (reason: string | null) => void;
  setMyDeviceInfo: (info: DeviceInfo) => void;
  
  reset: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  roomData: null,
  isConnectedToSignaling: false,
  
  pendingRequests: [],
  connectedReceivers: new Map(),
  
  isWaitingForApproval: false,
  approvalRejectedReason: null,
  myDeviceInfo: null,

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
  
  reset: () => set({ 
    roomData: null, 
    pendingRequests: [],
    connectedReceivers: new Map(),
    isWaitingForApproval: false,
    approvalRejectedReason: null,
  })
}));
