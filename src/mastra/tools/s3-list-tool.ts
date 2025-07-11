import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

// S3 client for listing files
const s3Client = process.env.AWS_S3_BUCKET ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
}) : null;

export const s3ListTool = createTool({
  id: 's3-list',
  description: 'List files in the S3 bucket uploads directory',
  inputSchema: z.object({
    prefix: z.string().optional().default('uploads/').describe('The S3 prefix to list files from (default: uploads/)'),
    maxFiles: z.number().optional().default(100).describe('Maximum number of files to return (default: 100)'),
  }),
  outputSchema: z.object({
    files: z.array(z.object({
      key: z.string().describe('The S3 object key'),
      filename: z.string().describe('Just the filename part'),
      size: z.number().describe('File size in bytes'),
      lastModified: z.string().describe('Last modified date'),
      s3Path: z.string().describe('Full S3 path for reading the file'),
    })),
    totalFiles: z.number(),
    bucket: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      if (!s3Client || !process.env.AWS_S3_BUCKET) {
        throw new Error('S3 is not configured');
      }
      
      const bucket = process.env.AWS_S3_BUCKET;
      console.log(`[S3 List Tool] Listing files from s3://${bucket}/${context.prefix}`);
      
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: context.prefix,
        MaxKeys: context.maxFiles,
      });
      
      const response = await s3Client.send(listCommand);
      const files = (response.Contents || []).map(obj => {
        const filename = obj.Key!.split('/').pop() || obj.Key!;
        return {
          key: obj.Key!,
          filename: filename,
          size: obj.Size || 0,
          lastModified: obj.LastModified?.toISOString() || '',
          s3Path: `s3://${bucket}/${obj.Key}`,
        };
      });
      
      console.log(`[S3 List Tool] Found ${files.length} files in ${bucket}/${context.prefix}`);
      
      return {
        files: files,
        totalFiles: files.length,
        bucket: bucket,
      };
      
    } catch (error) {
      console.error(`[S3 List Tool] Error listing S3 files:`, error);
      return {
        files: [],
        totalFiles: 0,
        bucket: process.env.AWS_S3_BUCKET || '',
        error: error instanceof Error ? error.message : 'Unknown error listing S3 files',
      };
    }
  },
});