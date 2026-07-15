import { S3Client } from '@aws-sdk/client-s3';
import { B2_CONFIG, isCloudEnabled } from './env';

// S3Client is only instantiated when credentials are present.
export const s3Client: S3Client | null = isCloudEnabled
  ? new S3Client({
      endpoint:   B2_CONFIG.endpoint,
      region:     'auto',
      credentials: {
        accessKeyId:     B2_CONFIG.keyId,
        secretAccessKey: B2_CONFIG.applicationKey,
      },
      forcePathStyle: true, // required for B2 S3-compatible API
    })
  : null;
