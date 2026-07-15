
// RFC 1918 private IP ranges
const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^fe80:/i,
];

function isPrivateIP(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

/**
 * Detects whether two peers are on the same LAN by analysing ICE candidates.
 *
 * Strategy:
 * - Listen to ICE candidates from the existing RTCPeerConnection.
 * - If we see a "host" or "srflx" candidate with a private RFC1918 address
 *   (meaning both sides are behind the same NAT or directly reachable),
 *   resolve as 'local'.
 * - If ICE fails immediately → resolve 'cloud' immediately.
 * - Otherwise wait up to MAX_WAIT_MS, then resolve 'cloud'.
 *
 * @param pc  The RTCPeerConnection that's already negotiating.
 * @returns   Promise resolving to 'local' or 'cloud'.
 */
export function detectNetworkMode(pc: RTCPeerConnection): Promise<'local' | 'cloud'> {
  const MAX_WAIT_MS = 5000;

  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (mode: 'local' | 'cloud') => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      pc.removeEventListener('icecandidate', onIceCandidate);
      pc.removeEventListener('icecandidateerror', onIceError);
      pc.removeEventListener('iceconnectionstatechange', onStateChange);
      resolve(mode);
    };

    const onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return;
      const { candidate, type } = event.candidate;

      // Host candidate with private IP → same LAN
      if (type === 'host' && isPrivateIP(parseIPFromCandidate(candidate))) {
        finish('local');
        return;
      }

      // Server-reflexive candidate with private IP → likely behind the same NAT
      if (type === 'srflx' && isPrivateIP(parseIPFromCandidate(candidate))) {
        finish('local');
        return;
      }
    };

    const onIceError = () => {
      // ICE failed immediately — switch to cloud without waiting
      finish('cloud');
    };

    const onStateChange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed') {
        finish('cloud');
      } else if (state === 'connected' || state === 'completed') {
        finish('local');
      }
    };

    // Maximum wait before falling back to cloud
    timer = setTimeout(() => finish('cloud'), MAX_WAIT_MS);

    pc.addEventListener('icecandidate', onIceCandidate);
    pc.addEventListener('icecandidateerror', onIceError);
    pc.addEventListener('iceconnectionstatechange', onStateChange);
  });
}

function parseIPFromCandidate(candidate: string): string {
  // ICE candidate format: candidate:... IP port ...
  // e.g. "candidate:1 1 UDP 2122260223 192.168.1.5 56789 typ host"
  const parts = candidate.split(' ');
  return parts[4] ?? '';
}
