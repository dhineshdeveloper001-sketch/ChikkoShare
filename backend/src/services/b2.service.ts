import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/b2';
import { B2_CONFIG, TRANSFER_CONFIG } from '../config/env';
import { Readable } from 'stream';

interface UploadPart {
  ETag: string;
  PartNumber: number;
}

// ── Streaming multipart upload to Backblaze B2 ─────────────────────────────────
// Never buffers the entire file — streams chunk-by-chunk.
export async function uploadStreamToB2(
  key: string,
  stream: Readable,
  totalSize: number,
  mimeType: string,
  onProgress?: (bytesUploaded: number) => void
): Promise<void> {
  if (!s3Client) throw new Error('B2 not configured');

  const partSize = TRANSFER_CONFIG.partSizeBytes; // 10 MB
  const uploadId = await initiateMultipart(key, mimeType);

  const parts: UploadPart[] = [];
  let partNumber = 0;
  let bytesUploaded = 0;
  let buffer = Buffer.alloc(0);

  // Queue of in-flight uploads for parallel execution
  const inFlight: Promise<void>[] = [];

  const uploadPart = async (buf: Buffer, pn: number): Promise<void> => {
    const cmd = new UploadPartCommand({
      Bucket:     B2_CONFIG.bucketName,
      Key:        key,
      UploadId:   uploadId,
      PartNumber: pn,
      Body:       buf,
    });
    const res = await s3Client!.send(cmd);
    parts[pn - 1] = { ETag: res.ETag!, PartNumber: pn };
    bytesUploaded += buf.byteLength;
    onProgress?.(bytesUploaded);
  };

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);

    while (buffer.length >= partSize) {
      const part = buffer.subarray(0, partSize);
      buffer = buffer.subarray(partSize);
      partNumber++;
      const pn = partNumber;

      const p = uploadPart(Buffer.from(part), pn);
      inFlight.push(p);

      // Keep max concurrent uploads bounded
      if (inFlight.length >= TRANSFER_CONFIG.maxConcurrentParts) {
        await Promise.race(inFlight);
        // Clean up settled promises
        for (let i = inFlight.length - 1; i >= 0; i--) {
          // We can't easily remove settled ones from the array without tracking,
          // so we just await all when at the limit, then continue
        }
        await Promise.all(inFlight);
        inFlight.length = 0;
      }
    }
  }

  // Upload remaining buffer as final part
  if (buffer.length > 0) {
    partNumber++;
    inFlight.push(uploadPart(Buffer.from(buffer), partNumber));
  }

  await Promise.all(inFlight);

  // Sort parts by PartNumber before completing
  const sortedParts = parts.filter(Boolean).sort((a, b) => a.PartNumber - b.PartNumber);

  await s3Client!.send(new CompleteMultipartUploadCommand({
    Bucket:          B2_CONFIG.bucketName,
    Key:             key,
    UploadId:        uploadId,
    MultipartUpload: { Parts: sortedParts },
  }));
}

async function initiateMultipart(key: string, mimeType: string): Promise<string> {
  const res = await s3Client!.send(new CreateMultipartUploadCommand({
    Bucket:      B2_CONFIG.bucketName,
    Key:         key,
    ContentType: mimeType,
  }));
  if (!res.UploadId) throw new Error('Failed to initiate multipart upload');
  return res.UploadId;
}

// ── Generate a presigned GET URL (default 15 minutes) ─────────────────────────
export async function generateSignedUrl(
  key: string,
  expiresIn: number = TRANSFER_CONFIG.downloadUrlExpirySeconds
): Promise<string> {
  if (!s3Client) throw new Error('B2 not configured');
  const cmd = new GetObjectCommand({ Bucket: B2_CONFIG.bucketName, Key: key });
  return getSignedUrl(s3Client, cmd, { expiresIn });
}

// ── Delete an object from B2 ──────────────────────────────────────────────────
export async function deleteFromB2(key: string): Promise<void> {
  if (!s3Client) return;
  await s3Client.send(new DeleteObjectCommand({
    Bucket: B2_CONFIG.bucketName,
    Key:    key,
  }));
}

// ── Abort a multipart upload (cleanup on error) ───────────────────────────────
export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  if (!s3Client) return;
  await s3Client.send(new AbortMultipartUploadCommand({
    Bucket:   B2_CONFIG.bucketName,
    Key:      key,
    UploadId: uploadId,
  }));
}
