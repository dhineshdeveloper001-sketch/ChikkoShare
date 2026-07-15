import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { Readable } from 'stream';
import { uploadStreamToB2 } from '../services/b2.service';
import { createTransfer, markComplete } from '../services/transfer.service';
import { isCloudEnabled, TRANSFER_CONFIG } from '../config/env';

// multer is configured in routes — raw req.pipe() used here for streaming
export async function handleUpload(req: Request, res: Response): Promise<void> {
  if (!isCloudEnabled) {
    res.status(503).json({ error: 'Cloud storage not configured on this server.' });
    return;
  }

  const roomId    = req.headers['x-room-id']   as string;
  const filename  = req.headers['x-filename']  as string;
  const sizeStr   = req.headers['x-file-size'] as string;
  const token     = req.headers['x-token']     as string; // pre-created transfer token

  if (!roomId || !filename || !sizeStr || !token) {
    res.status(400).json({ error: 'Missing required headers: x-room-id, x-filename, x-file-size, x-token' });
    return;
  }

  const fileSize = parseInt(sizeStr, 10);
  if (isNaN(fileSize) || fileSize <= 0) {
    res.status(400).json({ error: 'Invalid file size.' });
    return;
  }
  if (fileSize > TRANSFER_CONFIG.maxFileSizeBytes) {
    res.status(413).json({ error: `File exceeds maximum size of 50 GB.` });
    return;
  }

  // Determine MIME type
  const mimeType = mime.lookup(filename) || 'application/octet-stream';

  // Generate a unique key with UUID to prevent guessing
  const bucketKey = `${uuidv4()}/${filename}`;

  // Create DB record immediately (status: uploading)
  const transfer = createTransfer({ roomId, filename, size: fileSize, bucketKey, networkMode: 'cloud' });

  let bytesUploaded = 0;

  try {
    await uploadStreamToB2(
      bucketKey,
      req as unknown as Readable,
      fileSize,
      mimeType,
      (uploaded) => {
        bytesUploaded = uploaded;
        // Could emit progress via SSE here in future
      }
    );

    markComplete(transfer.id);

    res.status(200).json({
      downloadToken: transfer.download_token,
      expiresAt:     transfer.expires_at,
      fileSize:      fileSize,
      filename:      filename,
    });
  } catch (err) {
    console.error('[UPLOAD] Failed to upload to B2:', err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
}
