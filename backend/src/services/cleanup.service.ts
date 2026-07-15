import { getExpired, markDeleted } from './transfer.service';
import { deleteFromB2, abortMultipart } from './b2.service';
import { isCloudEnabled } from '../config/env';

// ── Delete expired transfers from B2 and DB ────────────────────────────────────
export async function cleanupExpiredTransfers(): Promise<void> {
  const expired = getExpired();
  if (expired.length === 0) return;

  for (const transfer of expired) {
    try {
      if (isCloudEnabled && transfer.bucket_key) {
        if (transfer.status === 'uploading' && transfer.upload_id) {
          // Abandoned multipart upload
          await abortMultipart(transfer.bucket_key, transfer.upload_id);
        } else {
          // Completed or other
          await deleteFromB2(transfer.bucket_key);
        }
      }
      markDeleted(transfer.id);
    } catch (err) {
      console.error(`[CLEANUP] Failed to clean up transfer ${transfer.id}:`, err);
    }
  }
}
