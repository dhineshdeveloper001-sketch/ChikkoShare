import { Request, Response } from 'express';
import { getByToken, recordDownload } from '../services/transfer.service';
import { generateSignedUrl } from '../services/b2.service';
import { isCloudEnabled } from '../config/env';

export async function handleDownload(req: Request, res: Response): Promise<void> {
  if (!isCloudEnabled) {
    res.status(503).json({ error: 'Cloud storage not configured on this server.' });
    return;
  }

  const token = req.params['token'] as string;
  if (!token) {
    res.status(400).json({ error: 'Missing download token.' });
    return;
  }

  const transfer = getByToken(token);
  if (!transfer) {
    res.status(404).json({ error: 'Transfer not found.' });
    return;
  }

  if (transfer.status === 'deleted') {
    res.status(410).json({ error: 'This file has been deleted.' });
    return;
  }

  if (Date.now() > transfer.expires_at) {
    res.status(410).json({ error: 'Download link has expired.' });
    return;
  }

  if (transfer.status === 'uploading') {
    res.status(202).json({ error: 'Upload still in progress. Try again shortly.' });
    return;
  }

  try {
    // Generate a fresh 15-minute signed URL — B2 handles Range requests natively
    const signedUrl = await generateSignedUrl(transfer.bucket_key);
    recordDownload(transfer.id);

    // Return signed URL to client rather than proxying bytes through our server
    // This is more efficient — the client downloads directly from B2
    res.status(200).json({
      url:      signedUrl,
      filename: transfer.filename,
      size:     transfer.size,
      expiresIn: 900, // seconds
    });
  } catch (err) {
    console.error('[DOWNLOAD] Failed to generate signed URL:', err);
    res.status(500).json({ error: 'Failed to generate download link.' });
  }
}
