import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { basename } from 'path';

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
      
      // Security check: ensure the file is in the uploads directory
      const normalizedPath = context.filepath.replace(/\\/g, '/');
      if (!normalizedPath.includes('/uploads/')) {
        throw new Error('File must be in the uploads directory');
      }
      
      // Extract just the filename
      const filename = basename(context.filepath);
      
      // Read the text file
      const content = await readFile(context.filepath, context.encoding as BufferEncoding);
      
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