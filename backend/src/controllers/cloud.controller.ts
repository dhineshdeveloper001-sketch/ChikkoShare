import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { isCloudEnabled, TRANSFER_CONFIG } from '../config/env';
import { createTransfer, getByToken, markComplete, recordDownload } from '../services/transfer.service';
import { initiateMultipartUpload, generateUploadPartUrls, completeMultipartUpload, generateSignedDownloadUrl } from '../services/b2.service';

export async function initUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isCloudEnabled) {
      res.status(503).json({ success: false, message: 'Cloud storage not configured', errorCode: 'CLOUD_DISABLED', timestamp: Date.now() });
      return;
    }

    // Input is already validated by Zod
    const { roomId, filename, size } = req.body;

    if (size > TRANSFER_CONFIG.maxFileSizeBytes) {
      res.status(413).json({ success: false, message: 'File too large', errorCode: 'FILE_TOO_LARGE', timestamp: Date.now() });
      return;
    }

    let mimeType = mime.lookup(filename) || 'application/octet-stream';
    // basic block on dangerous mimes
    const dangerousMimes = ['application/x-msdownload', 'application/x-sh', 'application/x-bat'];
    if (dangerousMimes.includes(mimeType)) {
      mimeType = 'application/octet-stream';
    }

    // Always use a random UUID for the object key to prevent traversal and enumeration
    const objectId = uuidv4();
    const bucketKey = `${objectId}/${uuidv4()}`; // Extra randomness to prevent guessing

    const uploadId = await initiateMultipartUpload(bucketKey, mimeType);
    const transfer = createTransfer({
      roomId,
      filename,
      size,
      bucketKey,
      networkMode: 'cloud',
      uploadId
    });

    res.status(200).json({
      success: true,
      downloadToken: transfer.download_token,
      transferId: transfer.id,
      uploadId,
      bucketKey,
      timestamp: Date.now()
    });
  } catch (err) {
    next(err);
  }
}

export async function getPartUrls(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { bucketKey, uploadId, partNumbers } = req.body;
    
    // Zod already validated the inputs

    // 15-minute expiry as requested (900 seconds)
    const urls = await generateUploadPartUrls(bucketKey, uploadId, partNumbers, 900);
    res.status(200).json({ success: true, urls, timestamp: Date.now() });
  } catch (err) {
    next(err);
  }
}

export async function completeUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { transferId, bucketKey, uploadId, parts, checksum } = req.body;
    
    await completeMultipartUpload(bucketKey, uploadId, parts);
    markComplete(transferId);
    
    res.status(200).json({ success: true, message: 'Upload complete', timestamp: Date.now() });
  } catch (err) {
    next(err);
  }
}

export async function getDownloadUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.params.token as string;
    const transfer = getByToken(token);
    
    if (!transfer) {
      res.status(404).json({ success: false, message: 'Transfer not found', errorCode: 'NOT_FOUND', timestamp: Date.now() });
      return;
    }

    if (transfer.status !== 'complete') {
      res.status(400).json({ success: false, message: 'File not ready for download', errorCode: 'NOT_READY', timestamp: Date.now() });
      return;
    }

    if (Date.now() > transfer.expires_at) {
      res.status(410).json({ success: false, message: 'Transfer expired', errorCode: 'EXPIRED', timestamp: Date.now() });
      return;
    }

    const url = await generateSignedDownloadUrl(transfer.bucket_key, 900); // 15 mins expiry
    recordDownload(transfer.id);
    
    res.status(200).json({ 
      success: true, 
      url, 
      filename: transfer.filename, 
      size: transfer.size, 
      checksum: transfer.checksum, 
      timestamp: Date.now() 
    });
  } catch (err) {
    next(err);
  }
}
