// S3 Vectors Debug Tool
// Test logging functionality and verify persistence

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getS3VectorsLogger } from '../lib/s3-vectors-persistent-logger';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const s3VectorsDebugTool = createTool({
  id: 's3-vectors-debug',
  description: 'Debug S3 Vectors logging - test log creation and check persistence',
  inputSchema: z.object({
    action: z.enum(['test-log', 'check-file', 'add-sample']).describe('Action to perform'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    logFile: z.string().optional(),
    logCount: z.number().optional(),
    fileExists: z.boolean().optional(),
    fileContent: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const logger = getS3VectorsLogger();
    const logFile = join(process.cwd(), 'src', 'mastra', 'uploads', 's3-vectors-logs.json');
    
    try {
      if (context.action === 'test-log') {
        // Add a test log entry
        logger.log('test-operation', {
          documentId: 'test-doc-' + Date.now(),
          filename: 'test.pdf',
          chunksCreated: 5,
          chunksUpdated: 0,
          totalChunks: 5
        });
        
        const summary = logger.getSummary();
        
        return {
          success: true,
          message: `Test log added. Total logs: ${summary.totalOperations}`,
          logCount: summary.totalOperations,
          logFile
        };
        
      } else if (context.action === 'check-file') {
        const exists = existsSync(logFile);
        let content = '';
        let logCount = 0;
        
        if (exists) {
          content = readFileSync(logFile, 'utf-8');
          try {
            const logs = JSON.parse(content);
            logCount = Array.isArray(logs) ? logs.length : 0;
          } catch (e) {
            logCount = -1;
          }
        }
        
        return {
          success: true,
          message: exists ? `Log file exists with ${logCount} entries` : 'Log file does not exist',
          fileExists: exists,
          logFile,
          logCount,
          fileContent: content.substring(0, 500) + (content.length > 500 ? '...' : '')
        };
        
      } else if (context.action === 'add-sample') {
        // Add sample logs to demonstrate functionality
        logger.log('storePDFEmbeddings', {
          documentId: 'sample-doc-1',
          filename: 'user-manual.pdf',
          chunksCreated: 25,
          chunksUpdated: 0,
          totalChunks: 25
        });
        
        logger.log('search', {
          searchQuery: 'how to reset password',
          resultsFound: 3
        });
        
        logger.log('storeEmbedding', {
          action: 'updated',
          documentId: 'sample-doc-1',
          filename: 'user-manual.pdf'
        });
        
        const summary = logger.getSummary();
        
        return {
          success: true,
          message: `Added 3 sample logs. Total operations: ${summary.totalOperations}`,
          logCount: summary.totalOperations
        };
      }
      
      throw new Error('Invalid action');
      
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});