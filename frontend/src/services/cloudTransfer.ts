import { socket } from './socket';
import { useTransferStore } from '../store/transferStore';
import toast from 'react-hot-toast';
import type { FileEntry } from '../../../shared/types';

const UPLOAD_URL   = '/api/upload';
const DOWNLOAD_URL = (token: string) => `/api/download/${token}`;

// ── Upload a file to Backblaze B2 via the backend API ─────────────────────────
export async function uploadFileToCloud(
  file: File,
  fileEntry: FileEntry,
  fileIndex: number,
  totalFiles: number,
  roomId: string,
  checksum: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_URL, true);
    xhr.setRequestHeader('x-room-id',   roomId);
    xhr.setRequestHeader('x-filename',  fileEntry.relativePath || fileEntry.name);
    xhr.setRequestHeader('x-file-size', String(fileEntry.size));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    let lastLoaded = 0;
    let lastTime   = performance.now();

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now        = performance.now();
      const deltaBytes = e.loaded - lastLoaded;
      const deltaSec   = (now - lastTime) / 1000;
      const speedBps   = deltaSec > 0 ? deltaBytes / deltaSec : 0;
      lastLoaded       = e.loaded;
      lastTime         = now;
      useTransferStore.getState().updateFileProgress(fileIndex, deltaBytes, speedBps);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const res = JSON.parse(xhr.responseText) as {
          downloadToken: string;
          expiresAt: number;
        };

        // Notify server — it will relay cloud_download_ready to the receiver
        socket.emit('cloud_upload_complete', {
          roomId,
          downloadToken: res.downloadToken,
          expiresAt:     res.expiresAt,
          fileIndex,
          totalFiles,
          filename:      fileEntry.name,
          size:          fileEntry.size,
          checksum,
        });

        useTransferStore.getState().setFileStatus(fileIndex, 'completed');
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.responseText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));

    xhr.send(file);
    (window as any).__chikkoXhr = xhr;
  });
}

// ── Download a file from Backblaze B2 via signed URL ──────────────────────────
export async function downloadFileFromCloud(
  downloadToken: string,
  filename: string,
  _fileSize: number,   // kept for API compat, size comes from server response
  fileIndex: number,
  expectedChecksum: string
): Promise<void> {
  useTransferStore.getState().setFileStatus(fileIndex, 'transferring');

  // Step 1: Get signed URL + metadata from our backend
  const metaRes = await fetch(DOWNLOAD_URL(downloadToken));
  if (!metaRes.ok) {
    const err = await metaRes.json().catch(() => ({ error: 'Failed to get download URL' }));
    throw new Error((err as { error: string }).error || 'Failed to get download URL');
  }
  const { url, size } = (await metaRes.json()) as { url: string; size: number; filename: string };

  // Step 2: Resume support — check how many bytes we already have
  const resumeKey   = `chikko_resume_${downloadToken}`;
  const resumeBytes = parseInt(sessionStorage.getItem(resumeKey) ?? '0', 10);

  const headers: HeadersInit = {};
  if (resumeBytes > 0 && resumeBytes < size) {
    headers['Range'] = `bytes=${resumeBytes}-`;
  }

  // Step 3: Stream download with hash verification
  const dlRes = await fetch(url, { headers });
  if (!dlRes.ok && dlRes.status !== 206) {
    throw new Error(`Download failed with status ${dlRes.status}`);
  }

  const reader  = dlRes.body!.getReader();
  const buffers: ArrayBuffer[] = [];
  let   received = resumeBytes;
  let   lastTime = performance.now();
  let   lastBytes = 0;

  const hashWorker = new Worker(new URL('../workers/hashWorker.ts', import.meta.url), { type: 'module' });
  hashWorker.postMessage({ type: 'init' });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    buffers.push(ab);
    hashWorker.postMessage({ type: 'update', chunk: ab });
    received += value.byteLength;

    const now      = performance.now();
    const elapsed  = (now - lastTime) / 1000;
    const speedBps = elapsed > 0 ? (received - lastBytes) / elapsed : 0;
    useTransferStore.getState().updateFileProgress(fileIndex, value.byteLength, speedBps);
    sessionStorage.setItem(resumeKey, String(received));

    lastTime  = now;
    lastBytes = received;
  }

  // Step 4: Verify SHA-256 before completing
  useTransferStore.getState().setFileStatus(fileIndex, 'verifying');

  const verifiedHash = await new Promise<string>((resolve) => {
    hashWorker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'result') resolve(e.data.hash as string);
    };
    hashWorker.postMessage({ type: 'finish' });
  });
  hashWorker.terminate();

  if (verifiedHash !== expectedChecksum) {
    useTransferStore.getState().setFileStatus(fileIndex, 'failed');
    throw new Error(`Integrity check failed for ${filename}. File may be corrupted.`);
  }

  // Step 5: Trigger browser download
  const blob   = new Blob(buffers, { type: 'application/octet-stream' });
  const objUrl = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href       = objUrl;
  a.download   = filename;
  a.click();
  URL.revokeObjectURL(objUrl);
  sessionStorage.removeItem(resumeKey);

  useTransferStore.getState().setFileStatus(fileIndex, 'completed');
  toast.success(`Downloaded: ${filename}`);
}

// ── Cancel active cloud upload ─────────────────────────────────────────────────
export function cancelCloudUpload(): void {
  const xhr = (window as any).__chikkoXhr as XMLHttpRequest | undefined;
  xhr?.abort();
}
