import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deleteAllIndexesWithNewman } from '../lib/delete-all-indexes.js';

export const s3VectorsDeleteAllTool = createTool({
  id: 's3-vectors-delete-all',
  description: 'Delete ALL S3 Vectors indexes in the bucket. USE WITH EXTREME CAUTION - this will permanently delete all indexes and their vectors!',
  inputSchema: z.object({
    confirmDeletion: z.boolean().describe('Must be true to confirm you want to delete ALL indexes'),
    safetyPhrase: z.literal('DELETE ALL INDEXES').describe('Type exactly "DELETE ALL INDEXES" to confirm')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    deleted: z.array(z.string()).describe('List of successfully deleted index names'),
    failed: z.array(z.string()).describe('List of index names that failed to delete'),
    total: z.number().describe('Total number of indexes that were found'),
    message: z.string()
  }),
  execute: async ({ context }) => {
    try {
      // Safety checks
      if (!context.confirmDeletion) {
        return {
          success: false,
          deleted: [],
          failed: [],
          total: 0,
          message: 'Deletion not confirmed. Set confirmDeletion to true to proceed.'
        };
      }
      
      if (context.safetyPhrase !== 'DELETE ALL INDEXES') {
        return {
          success: false,
          deleted: [],
          failed: [],
          total: 0,
          message: 'Safety phrase incorrect. You must type exactly "DELETE ALL INDEXES" to confirm.'
        };
      }
      
      console.log('[S3 Vectors Delete All] WARNING: Deleting all indexes in the bucket!');
      
      // Execute the deletion
      const result = await deleteAllIndexesWithNewman();
      
      return {
        success: result.failed.length === 0,
        deleted: result.deleted,
        failed: result.failed,
        total: result.total,
        message: result.total === 0 
          ? 'No indexes found to delete.'
          : `Deleted ${result.deleted.length} out of ${result.total} indexes. ${result.failed.length > 0 ? `Failed to delete: ${result.failed.join(', ')}` : 'All indexes deleted successfully.'}`
      };
      
    } catch (error) {
      console.error('[S3 Vectors Delete All] Error:', error);
      return {
        success: false,
        deleted: [],
        failed: [],
        total: 0,
        message: `Error deleting indexes: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  },
});