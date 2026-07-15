import { Router } from 'express';
import { handleUpload } from '../controllers/upload.controller';
import { handleDownload } from '../controllers/download.controller';
import { uploadRateLimiter } from '../middleware/rateLimit';

const router = Router();

// Upload: POST /api/upload
// Raw body streamed directly to B2 (no multer disk storage)
router.post('/upload', uploadRateLimiter, handleUpload);

// Download: GET /api/download/:token
router.get('/download/:token', handleDownload);

export default router;
