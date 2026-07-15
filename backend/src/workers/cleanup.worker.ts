import cron from 'node-cron';
import { cleanupExpiredTransfers as processCleanup } from '../services/cleanup.service';

export function startCleanupWorker(): void {
  // Scheduled runs
  cron.schedule('0 * * * *', async () => {
    try {
      await processCleanup();
    } catch (err) {
      console.error('[CLEANUP WORKER] Scheduled error:', err);
    }
  });

  // Startup run (wait 10s to let server breathe)
  setTimeout(async () => {
    try {
      await processCleanup();
    } catch (err) {
      console.error('[CLEANUP WORKER] Startup error:', err);
    }
  }, 10000);
}
