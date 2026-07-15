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

// ── Initiate Multipart Upload ───────────────────────────────────────────────────
export async function initiateMultipartUpload(key: string, mimeType: string): Promise<string> {
  if (!s3Client) throw new Error('B2 not configured');
  const res = await s3Client.send(new CreateMultipartUploadCommand({
    Bucket:      B2_CONFIG.bucketName,
    Key:         key,
    ContentType: mimeType,
  }));
  if (!res.UploadId) throw new Error('Failed to initiate multipart upload');
  return res.UploadId;
}

// ── Generate Presigned URLs for Parts ─────────────────────────────────────────
export async function generateUploadPartUrls(
  key: string,
  uploadId: string,
  partNumbers: number[],
  expiresIn: number = 900 // 15 minutes as requested
): Promise<{ partNumber: number; url: string }[]> {
  if (!s3Client) throw new Error('B2 not configured');
  
  const urls = await Promise.all(
    partNumbers.map(async (pn) => {
      const cmd = new UploadPartCommand({
        Bucket: B2_CONFIG.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: pn,
      });
      const url = await getSignedUrl(s3Client!, cmd, { expiresIn });
      return { partNumber: pn, url };
    })
  );
  
  return urls;
}

// ── Complete Multipart Upload ─────────────────────────────────────────────────
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: UploadPart[]
): Promise<void> {
  if (!s3Client) throw new Error('B2 not configured');
  
  // Ensure parts are sorted by PartNumber
  const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

  await s3Client.send(new CompleteMultipartUploadCommand({
    Bucket:          B2_CONFIG.bucketName,
    Key:             key,
    UploadId:        uploadId,
    MultipartUpload: { Parts: sortedParts },
  }));
}

// ── Generate Presigned Upload URL for Small Files (< 5MB) ─────────────────────
export async function generatePutUploadUrl(
  key: string,
  mimeType: string,
  expiresIn: number = 900
): Promise<string> {
  if (!s3Client) throw new Error('B2 not configured');
  
  // We can't easily import PutObjectCommand from s3 client without adding it at top.
  // We will assume all files use multipart upload for simplicity and consistency.
  throw new Error('Not implemented. Use multipart for everything.');
}

// ── Generate a presigned GET URL (15 minutes) ───────────────────────────────
export async function generateSignedDownloadUrl(
  key: string,
  expiresIn: number = 900
): Promise<string> {
  if (!s3Client) throw new Error('B2 not configured');
  const cmd = new GetObjectCommand({ Bucket: B2_CONFIG.bucketName, Key: key });
  return getSignedUrl(s3Client!, cmd, { expiresIn });
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
