import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// S3 client for reading files
const s3Client = process.env.AWS_S3_BUCKET ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
}) : null;

export const textReaderTool = createTool({
  id: 'text-reader',
  description: 'Read text content from TXT files in the uploads directory',
  inputSchema: z.object({
    filepath: z.string().describe('The file path of the text file to read (e.g., /path/to/uploads/abc123.txt)'),
    encoding: z.string().optional().default('utf-8').describe('Text encoding (default: utf-8)'),
  }),
  outputSchema: z.object({
    content: z.string().describe('The text content from the file'),
    filename: z.string().describe('The original filename'),
    size: z.number().describe('File size in bytes'),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[Text Reader Tool] Reading text file from: ${context.filepath}`);
      
      let content: string;
      let filename: string;
      
      // Check if this is an S3 path
      if (context.filepath.startsWith('s3://')) {
        // Parse S3 path
        const s3PathMatch = context.filepath.match(/^s3:\/\/([^\/]+)\/(.+)$/);
        if (!s3PathMatch || !s3Client) {
          throw new Error('Invalid S3 path or S3 not configured');
        }
        
        const [, bucket, key] = s3PathMatch;
        filename = basename(key);
        
        console.log(`[Text Reader Tool] Reading from S3: ${bucket}/${key}`);
        
        // Get object from S3
        const getObjectCommand = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        
        const response = await s3Client.send(getObjectCommand);
        const chunks: Uint8Array[] = [];
        
        // Read the stream
        for await (const chunk of response.Body as any) {
          chunks.push(chunk);
        }
        
        const buffer = Buffer.concat(chunks);
        content = buffer.toString(context.encoding as BufferEncoding);
      } else {
        // Local file path
        // Security check: ensure the file is in the uploads directory
        const normalizedPath = context.filepath.replace(/\\/g, '/');
        if (!normalizedPath.includes('/uploads/')) {
          throw new Error('File must be in the uploads directory');
        }
        
        filename = basename(context.filepath);
        
        // Read the text file
        content = await readFile(context.filepath, context.encoding as BufferEncoding);
      }
      
      console.log(`[Text Reader Tool] Successfully read ${content.length} characters from ${filename}`);
      
      return {
        content: content,
        filename: filename,
        size: Buffer.byteLength(content, context.encoding as BufferEncoding),
      };
      
    } catch (error) {
      console.error(`[Text Reader Tool] Error reading text file:`, error);
      return {
        content: '',
        filename: basename(context.filepath),
        size: 0,
        error: error instanceof Error ? error.message : 'Unknown error reading text file',
      };
    }
  },
});