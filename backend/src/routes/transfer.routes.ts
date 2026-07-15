import { Router } from 'express';
import { initUpload, getPartUrls, completeUpload, getDownloadUrl } from '../controllers/cloud.controller';
import { uploadInitLimiter, signedUrlLimiter, downloadUrlLimiter } from '../middleware/rateLimit';
import { requireRoomToken } from '../middleware/auth';
import { validate, initUploadSchema, getPartUrlsSchema, completeUploadSchema, downloadSchema } from '../middleware/validate';

const router = Router();

// Cloud endpoints
router.post('/cloud/init', uploadInitLimiter, validate(initUploadSchema), requireRoomToken, initUpload);
router.post('/cloud/urls', signedUrlLimiter, validate(getPartUrlsSchema), requireRoomToken, getPartUrls);
router.post('/cloud/complete', signedUrlLimiter, validate(completeUploadSchema), requireRoomToken, completeUpload);
router.get('/cloud/download/:token', downloadUrlLimiter, validate(downloadSchema), getDownloadUrl);

export default router;
