import rateLimit from 'express-rate-limit';

const standardOptions = {
  standardHeaders: true,
  legacyHeaders: false,
};

// 10 requests / minute / IP
export const roomCreationLimiter = rateLimit({
  ...standardOptions,
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many room creation requests', errorCode: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() },
});

// 30 requests / minute / IP
export const roomJoinLimiter = rateLimit({
  ...standardOptions,
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many room join requests', errorCode: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() },
});

// 20 requests / minute / IP
export const uploadInitLimiter = rateLimit({
  ...standardOptions,
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many upload initialization requests', errorCode: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() },
});

// 120 requests / minute / IP
export const signedUrlLimiter = rateLimit({
  ...standardOptions,
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: 'Too many signed URL requests', errorCode: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() },
});

// 60 requests / minute / IP
export const downloadUrlLimiter = rateLimit({
  ...standardOptions,
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many download URL requests', errorCode: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() },
});
