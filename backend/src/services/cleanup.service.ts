import { getExpired, markDeleted } from './transfer.service';
import { deleteFromB2 } from './b2.service';
import { isCloudEnabled } from '../config/env';

// ── Delete expired transfers from B2 and DB ────────────────────────────────────
export async function cleanupExpiredTransfers(): Promise<void> {
  const expired = getExpired();
  if (expired.length === 0) return;

  console.log(`[CLEANUP] Found ${expired.length} expired transfer(s) to clean up.`);

  for (const transfer of expired) {
    try {
      if (isCloudEnabled && transfer.bucket_key) {
        await deleteFromB2(transfer.bucket_key);
        console.log(`[CLEANUP] Deleted B2 object: ${transfer.bucket_key}`);
      }
      markDeleted(transfer.id);
      console.log(`[CLEANUP] Marked transfer ${transfer.id} (${transfer.filename}) as deleted.`);
    } catch (err) {
      console.error(`[CLEANUP] Failed to clean up transfer ${transfer.id}:`, err);
    }
  }
}
