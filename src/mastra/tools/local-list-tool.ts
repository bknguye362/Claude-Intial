import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get the uploads directory path
const UPLOAD_DIR = join(dirname(__dirname), 'uploads');

export const localListTool = createTool({
  id: 'local-list',
  description: 'List files in the local uploads directory',
  inputSchema: z.object({
    maxFiles: z.number().optional().default(100).describe('Maximum number of files to return (default: 100)'),
  }),
  outputSchema: z.object({
    files: z.array(z.object({
      filename: z.string().describe('The filename'),
      path: z.string().describe('Full path for reading the file'),
      size: z.number().describe('File size in bytes'),
      lastModified: z.string().describe('Last modified date'),
      extension: z.string().describe('File extension'),
    })),
    totalFiles: z.number(),
    uploadDir: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[Local List Tool] Listing files from: ${UPLOAD_DIR}`);
      
      // Read directory contents
      const fileNames = await readdir(UPLOAD_DIR);
      
      // Filter out .gitkeep and get file stats
      const filePromises = fileNames
        .filter(name => name !== '.gitkeep')
        .slice(0, context.maxFiles)
        .map(async (fileName) => {
          const filePath = join(UPLOAD_DIR, fileName);
          const stats = await stat(filePath);
          const extension = fileName.split('.').pop() || '';
          
          return {
            filename: fileName,
            path: filePath,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
            extension: extension,
          };
        });
      
      const files = await Promise.all(filePromises);
      
      // Sort by last modified date (newest first)
      files.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      
      console.log(`[Local List Tool] Found ${files.length} files`);
      
      return {
        files: files,
        totalFiles: files.length,
        uploadDir: UPLOAD_DIR,
      };
      
    } catch (error) {
      console.error(`[Local List Tool] Error listing files:`, error);
      
      // If directory doesn't exist, return empty list
      if (error instanceof Error && error.message.includes('ENOENT')) {
        return {
          files: [],
          totalFiles: 0,
          uploadDir: UPLOAD_DIR,
          error: 'Uploads directory does not exist yet',
        };
      }
      
      return {
        files: [],
        totalFiles: 0,
        uploadDir: UPLOAD_DIR,
        error: error instanceof Error ? error.message : 'Unknown error listing files',
      };
    }
  },
});