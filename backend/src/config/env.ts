import dotenv from 'dotenv';
dotenv.config();

// ── Cloud availability flag ────────────────────────────────────────────────────
// The app runs in WebRTC-only mode when any required B2 credential is missing.
// B2_BUCKET_ID is intentionally not required — the S3 SDK only needs bucket name.
export const isCloudEnabled: boolean = Boolean(
  process.env.B2_KEY_ID &&
  process.env.B2_APPLICATION_KEY &&
  process.env.B2_BUCKET_NAME &&
  process.env.B2_ENDPOINT
);

if (isCloudEnabled) {
  console.log('[ENV] Cloud mode ENABLED — Backblaze B2 configured.');
} else {
  console.warn('[ENV] B2 credentials not set — running in WebRTC-only mode. Cloud fallback disabled.');
}

// ── B2 Config ──────────────────────────────────────────────────────────────────
export const B2_CONFIG = {
  keyId:          process.env.B2_KEY_ID          ?? '',
  applicationKey: process.env.B2_APPLICATION_KEY ?? '',
  bucketName:     process.env.B2_BUCKET_NAME     ?? '',
  endpoint:       process.env.B2_ENDPOINT        ?? '',
};

// ── Transfer Config ────────────────────────────────────────────────────────────
export const TRANSFER_CONFIG = {
  downloadUrlExpirySeconds: parseInt(process.env.DOWNLOAD_URL_EXPIRY_SECONDS ?? '900',      10),
  deleteAfterDownloadMs:    parseInt(process.env.DELETE_AFTER_DOWNLOAD_MS    ?? '600000',   10),
  deleteAbandonedAfterMs:   parseInt(process.env.DELETE_ABANDONED_AFTER_MS  ?? '86400000', 10),
  maxFileSizeBytes:         parseInt(process.env.MAX_FILE_SIZE               ?? '53687091200', 10), // 50 GB
};
