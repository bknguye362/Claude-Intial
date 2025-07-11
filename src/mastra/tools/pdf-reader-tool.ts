import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// Dynamic import to avoid initialization errors
const pdf = async (dataBuffer: Buffer) => {
  const pdfParse = (await import('pdf-parse')).default;
  return pdfParse(dataBuffer);
};

// S3 client for reading files
const s3Client = process.env.AWS_S3_BUCKET ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
}) : null;

export const pdfReaderTool = createTool({
  id: 'pdf-reader',
  description: 'Read and extract text content from PDF files in the uploads directory',
  inputSchema: z.object({
    filepath: z.string().describe('The file path of the PDF to read (e.g., /path/to/uploads/abc123.pdf)'),
  }),
  outputSchema: z.object({
    content: z.string().describe('The extracted text content from the PDF'),
    filename: z.string().describe('The original filename'),
    pages: z.number().describe('Number of pages in the PDF'),
    metadata: z.object({
      title: z.string().optional(),
      author: z.string().optional(),
      subject: z.string().optional(),
      keywords: z.string().optional(),
      creator: z.string().optional(),
      producer: z.string().optional(),
      creationDate: z.string().optional(),
      modificationDate: z.string().optional(),
    }).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[PDF Reader Tool] Reading PDF from: ${context.filepath}`);
      
      let dataBuffer: Buffer;
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
        
        console.log(`[PDF Reader Tool] Reading from S3: ${bucket}/${key}`);
        
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
        
        dataBuffer = Buffer.concat(chunks);
      } else {
        // Local file path
        // Security check: ensure the file is in the uploads directory
        const normalizedPath = context.filepath.replace(/\\/g, '/');
        if (!normalizedPath.includes('/uploads/')) {
          throw new Error('File must be in the uploads directory');
        }
        
        filename = basename(context.filepath);
        
        // Read the PDF file
        dataBuffer = await readFile(context.filepath);
      }
      
      // Parse the PDF
      const pdfData = await pdf(dataBuffer);
      
      // Extract metadata
      let metadata: any = {};
      if (pdfData.info) {
        metadata = {
          title: pdfData.info.Title,
          author: pdfData.info.Author,
          subject: pdfData.info.Subject,
          keywords: pdfData.info.Keywords,
          creator: pdfData.info.Creator,
          producer: pdfData.info.Producer,
          creationDate: pdfData.info.CreationDate ? new Date(pdfData.info.CreationDate).toISOString() : undefined,
          modificationDate: pdfData.info.ModDate ? new Date(pdfData.info.ModDate).toISOString() : undefined,
        };
        
        // Remove undefined values
        Object.keys(metadata).forEach(key => {
          if (metadata[key] === undefined) {
            delete metadata[key];
          }
        });
      }
      
      console.log(`[PDF Reader Tool] Successfully extracted ${pdfData.text.length} characters from ${pdfData.numpages} pages`);
      
      return {
        content: pdfData.text,
        filename: filename,
        pages: pdfData.numpages,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
      
    } catch (error) {
      console.error(`[PDF Reader Tool] Error reading PDF:`, error);
      return {
        content: '',
        filename: basename(context.filepath),
        pages: 0,
        error: error instanceof Error ? error.message : 'Unknown error reading PDF',
      };
    }
  },
});