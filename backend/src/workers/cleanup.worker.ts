import cron from 'node-cron';
import { cleanupExpiredTransfers } from '../services/cleanup.service';

export function startCleanupWorker(): void {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('[CLEANUP WORKER] Running scheduled cleanup...');
    try {
      await cleanupExpiredTransfers();
    } catch (err) {
      console.error('[CLEANUP WORKER] Error during cleanup:', err);
    }
  });

  // Also run once on startup to clean up any leftovers from previous runs
  setTimeout(async () => {
    console.log('[CLEANUP WORKER] Running startup cleanup...');
    try {
      await cleanupExpiredTransfers();
    } catch (err) {
      console.error('[CLEANUP WORKER] Startup cleanup error:', err);
    }
  }, 5000);

  console.log('[CLEANUP WORKER] Scheduled — runs every hour.');
}
