import { socket } from './socket';
import { useTransferStore } from '../store/transferStore';
import { useRoomStore } from '../store/roomStore';
import type { FileEntry } from '../../../shared/types';

const API_INIT     = '/api/cloud/init';
const API_URLS     = '/api/cloud/urls';
const API_COMPLETE = '/api/cloud/complete';
const API_DOWNLOAD = (token: string) => `/api/cloud/download/${token}`;

function getAdaptiveChunkSize(fileSize: number): number {
  const MB = 1024 * 1024;
  if (fileSize < 100 * MB) return 8 * MB;
  if (fileSize < 2000 * MB) return 16 * MB;
  if (fileSize < 10000 * MB) return 32 * MB;
  return 64 * MB;
}

function getAdaptiveConcurrency(speedBps: number): number {
  const MB = 1024 * 1024;
  if (speedBps === 0) return 4; // default start
  if (speedBps < 1 * MB) return 2; // slow
  if (speedBps < 5 * MB) return 4; // medium
  return 6; // fast
}

export const cancelCloudUpload = () => {
  // Cancel logic can be hooked up if needed by aborting XHRs
};

// ── Upload a file to Backblaze B2 via Signed URLs ──────────────────────────────
export async function uploadFileToCloud(
  file: File,
  fileEntry: FileEntry,
  fileIndex: number,
  totalFiles: number,
  roomId: string,
  checksum: string
): Promise<void> {
  const token = useRoomStore.getState().token;
  const initRes = await fetch(API_INIT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, token, filename: fileEntry.relativePath || fileEntry.name, size: file.size })
  }).then(r => r.json());

  if (!initRes.success) throw new Error(initRes.message);

  const { uploadId, bucketKey, transferId, downloadToken } = initRes;

  const chunkSize = getAdaptiveChunkSize(file.size);
  const totalParts = Math.ceil(file.size / chunkSize);
  const parts: { PartNumber: number, ETag: string }[] = [];

  let currentPart = 1;
  let bytesUploaded = 0;
  let activeUploads = 0;
  let speedBps = 0;
  const urlCache = new Map<number, { url: string, expiresAt: number }>();

  useTransferStore.getState().setFileStatus(fileIndex, 'transferring');

  const fetchUrls = async (startPart: number, count: number) => {
    const partNumbers = [];
    for (let i = 0; i < count; i++) {
      const pn = startPart + i;
      if (pn <= totalParts && !urlCache.has(pn)) partNumbers.push(pn);
    }
    if (partNumbers.length === 0) return;
    
    const res = await fetch(API_URLS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, token, bucketKey, uploadId, partNumbers })
    }).then(r => r.json());
    
    if (res.success) {
      const now = Date.now();
      res.urls.forEach((u: any) => {
        urlCache.set(u.partNumber, { url: u.url, expiresAt: now + 14 * 60 * 1000 }); // 14 mins valid locally
      });
    }
  };

  // Prefetch first batch
  await fetchUrls(1, 10);

  let lastTime = performance.now();
  let lastBytes = 0;

  return new Promise((resolve, reject) => {
    const uploadNextPart = async () => {
      // Check pause/cancel state
      const state = useTransferStore.getState();
      if (state.overallStatus === 'cancelled') {
        reject(new Error('Upload cancelled'));
        return;
      }

      if (currentPart > totalParts) {
        if (activeUploads === 0 && parts.length === totalParts) {
          // Finish
          try {
            const compRes = await fetch(API_COMPLETE, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomId, token, transferId, bucketKey, uploadId, parts, checksum })
            }).then(r => r.json());

            if (compRes.success) {
              socket.emit('cloud_upload_complete', {
                roomId, downloadToken, expiresAt: Date.now() + 600000,
                fileIndex, totalFiles, filename: fileEntry.name, size: file.size, checksum
              });
              useTransferStore.getState().setFileStatus(fileIndex, 'completed');
              resolve();
            } else {
              reject(new Error(compRes.message));
            }
          } catch (e: any) { reject(e); }
        }
        return;
      }

      const partNum = currentPart++;
      activeUploads++;

      // Ensure URL is prefetched and valid
      if (!urlCache.has(partNum) || Date.now() > urlCache.get(partNum)!.expiresAt) {
        await fetchUrls(partNum, 10);
      }

      const urlData = urlCache.get(partNum);
      if (!urlData) {
        reject(new Error(`Failed to get presigned URL for part ${partNum}`));
        return;
      }

      const start = (partNum - 1) * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);

      const xhr = new XMLHttpRequest();
      xhr.open('PUT', urlData.url, true);
      
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const now = performance.now();
          const totalUploadedNow = bytesUploaded + e.loaded;
          if (now - lastTime > 250) {
            const deltaBytes = totalUploadedNow - lastBytes;
            const deltaSec = (now - lastTime) / 1000;
            speedBps = deltaBytes / deltaSec;
            lastTime = now;
            lastBytes = totalUploadedNow;
            useTransferStore.getState().updateFileProgress(fileIndex, deltaBytes, speedBps);
          }
        }
      };

      xhr.onload = () => {
        activeUploads--;
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag') || '';
          parts.push({ PartNumber: partNum, ETag: etag });
          bytesUploaded += chunk.size;
          
          // Adjust concurrency based on speed
          const targetConcurrency = getAdaptiveConcurrency(speedBps);
          while (activeUploads < targetConcurrency && currentPart <= totalParts) {
            uploadNextPart();
          }
        } else {
          reject(new Error(`Upload part ${partNum} failed: ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => { activeUploads--; reject(new Error('Network error')); };
      xhr.onabort = () => { activeUploads--; reject(new Error('Aborted')); };
      xhr.send(chunk);
    };

    // Start initial concurrent uploads
    const initialConcurrency = getAdaptiveConcurrency(0);
    for (let i = 0; i < Math.min(initialConcurrency, totalParts); i++) {
      uploadNextPart();
    }
  });
}

// ── Download a file from Backblaze B2 via signed URL ──────────────────────────
export async function downloadFileFromCloud(
  downloadToken: string,
  filename: string,
  _fileSize: number,
  fileIndex: number
): Promise<void> {
  useTransferStore.getState().setFileStatus(fileIndex, 'transferring');

  const metaRes = await fetch(API_DOWNLOAD(downloadToken));
  if (!metaRes.ok) {
    const err = await metaRes.json().catch(() => ({ message: 'Failed to get download URL' }));
    throw new Error(err.message);
  }
  const { url, size } = await metaRes.json();

  const resumeKey   = `chikko_resume_${downloadToken}`;
  const resumeBytes = parseInt(sessionStorage.getItem(resumeKey) ?? '0', 10);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';

    if (resumeBytes > 0 && resumeBytes < size) {
      xhr.setRequestHeader('Range', `bytes=${resumeBytes}-`);
    }

    let lastLoaded = resumeBytes;
    let lastTime   = performance.now();

    xhr.onprogress = (e) => {
      const now = performance.now();
      const totalLoaded = resumeBytes + e.loaded;
      if (now - lastTime > 250) {
        const deltaBytes = totalLoaded - lastLoaded;
        const deltaSec   = (now - lastTime) / 1000;
        const speedBps   = deltaBytes / deltaSec;
        lastLoaded = totalLoaded;
        lastTime = now;
        useTransferStore.getState().updateFileProgress(fileIndex, deltaBytes, speedBps);
        sessionStorage.setItem(resumeKey, String(totalLoaded));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response;
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(objectUrl);
        
        sessionStorage.removeItem(resumeKey);
        useTransferStore.getState().setFileStatus(fileIndex, 'completed');
        resolve();
      } else {
        reject(new Error(`Download failed: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during download'));
    xhr.onabort = () => reject(new Error('Download cancelled'));
    
    xhr.send();
  });
}
