// S3 Vectors Logs Tool
// View operation logs from S3 Vectors integration

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { s3VectorsLogger } from '../lib/s3-vectors-persistent-logger.js';

export const s3VectorsLogsTool = createTool({
  id: 's3-vectors-logs',
  description: 'View logs from S3 Vectors operations - see what vectors were created, updated, or searched',
  inputSchema: z.object({
    action: z.enum(['recent', 'summary', 'by-document']).describe('Action: view recent logs, get summary, or filter by document'),
    limit: z.number().default(10).optional().describe('Number of recent logs to show'),
    documentId: z.string().optional().describe('Document ID to filter logs (for by-document action)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    logs: z.array(z.object({
      timestamp: z.string(),
      operation: z.string(),
      details: z.record(z.any()),
      success: z.boolean(),
    })).optional(),
    summary: z.object({
      totalOperations: z.number(),
      successfulOperations: z.number(),
      failedOperations: z.number(),
      recentDocuments: z.array(z.string()),
      operationCounts: z.record(z.number()),
    }).optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    try {
      if (context.action === 'recent') {
        const logs = s3VectorsLogger.getRecentLogs(context.limit || 10);
        
        return {
          success: true,
          logs,
          message: `Showing ${logs.length} most recent S3 Vectors operations`,
        };
        
      } else if (context.action === 'summary') {
        const summary = s3VectorsLogger.getSummary();
        
        return {
          success: true,
          summary,
          message: `S3 Vectors operations summary: ${summary.totalOperations} total operations (${summary.successfulOperations} successful, ${summary.failedOperations} failed)`,
        };
        
      } else if (context.action === 'by-document') {
        if (!context.documentId) {
          throw new Error('Document ID required for by-document action');
        }
        
        const logs = s3VectorsLogger.getLogsByDocument(context.documentId);
        
        return {
          success: true,
          logs,
          message: `Found ${logs.length} operations for document: ${context.documentId}`,
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