import rateLimit from 'express-rate-limit';

export const uploadRateLimiter = rateLimit({
  windowMs:         10 * 60 * 1000, // 10 minutes
  max:              20,              // 20 upload requests per window per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message: { error: 'Too many upload requests. Please wait before trying again.' },
});
