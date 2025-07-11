import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import pdf from 'pdf-parse';

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
      
      // Security check: ensure the file is in the uploads directory
      const normalizedPath = context.filepath.replace(/\\/g, '/');
      if (!normalizedPath.includes('/uploads/')) {
        throw new Error('File must be in the uploads directory');
      }
      
      // Extract just the filename
      const filename = basename(context.filepath);
      
      // Read the PDF file
      const dataBuffer = await readFile(context.filepath);
      
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