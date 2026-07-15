import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function globalErrorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Never expose stack traces in production
  
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errorCode: 'VALIDATION_ERROR',
      details: err.issues.map((e: any) => ({ path: e.path.join('.'), message: e.message })),
      timestamp: Date.now()
    });
    return;
  }

  // Handle generic / unexpected errors
  const statusCode = err.status || err.statusCode || 500;
  const message = err.status && err.status < 500 ? err.message : 'Internal Server Error';

  if (statusCode === 500) {
    // We should log this securely, but never to the client
    console.error(`[ERROR] ${new Date().toISOString()} - ${req.method} ${req.url} - ${err.message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorCode: err.errorCode || 'INTERNAL_ERROR',
    timestamp: Date.now()
  });
}
