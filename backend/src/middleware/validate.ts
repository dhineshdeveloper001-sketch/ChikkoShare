import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

// MIME types validation - basic safety check
const safeMimeTypes = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/json',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'application/x-zip-compressed'
];

export const initUploadSchema = z.object({
  body: z.object({
    roomId: z.string().min(6).max(6).regex(/^[0-9]+$/, 'Room ID must be exactly 6 digits'),
    token: z.string().min(64).max(64).regex(/^[a-f0-9]+$/, 'Invalid token format'), // 32 bytes hex
    filename: z.string()
      .min(1, 'Filename cannot be empty')
      .max(255, 'Filename too long')
      .refine(val => !val.includes('..') && !val.includes('/'), { message: 'Invalid characters in filename' }),
    size: z.number().int().positive('Size must be positive'),
  }),
});

export const getPartUrlsSchema = z.object({
  body: z.object({
    roomId: z.string().min(6).max(6).regex(/^[0-9]+$/),
    token: z.string().min(64).max(64).regex(/^[a-f0-9]+$/),
    bucketKey: z.string().min(1).max(1024),
    uploadId: z.string().min(1).max(255),
    partNumbers: z.array(z.number().int().positive()).min(1).max(10000),
  }),
});

export const completeUploadSchema = z.object({
  body: z.object({
    roomId: z.string().min(6).max(6).regex(/^[0-9]+$/),
    token: z.string().min(64).max(64).regex(/^[a-f0-9]+$/),
    transferId: z.string().uuid('Invalid transfer ID'),
    bucketKey: z.string().min(1).max(1024),
    uploadId: z.string().min(1).max(255),
    parts: z.array(
      z.object({
        PartNumber: z.number().int().positive(),
        ETag: z.string().min(1),
      })
    ).min(1).max(10000),
    checksum: z.string().min(1).optional(),
  }),
});

export const downloadSchema = z.object({
  params: z.object({
    token: z.string().uuid('Invalid download token'),
  }),
  // For download we might still need room authorization if it's protected,
  // but download token is a unique UUID generated for this transfer.
});

export function validate(schema: ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
