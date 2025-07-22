// S3 Vectors Bucket Monitoring Tool
// Provides comprehensive visibility into the entire S3 Vectors bucket

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const s3VectorsBucketMonitorTool = createTool({
  id: 's3-vectors-bucket-monitor',
  description: 'Monitor the entire S3 Vectors bucket - list all indices, check bucket status, and get statistics',
  inputSchema: z.object({
    action: z.enum(['list-indices', 'bucket-stats', 'index-details']).describe('Action to perform'),
    indexName: z.string().optional().describe('Index name for index-details action'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    bucketName: z.string().optional(),
    region: z.string().optional(),
    indices: z.array(z.object({
      indexName: z.string(),
      dimension: z.number().optional(),
      distanceMetric: z.string().optional(),
      dataType: z.string().optional(),
      status: z.string().optional(),
      createdAt: z.string().optional(),
      vectorCount: z.number().optional(),
    })).optional(),
    totalIndices: z.number().optional(),
    indexDetails: z.object({
      indexName: z.string(),
      dimension: z.number().optional(),
      vectorCount: z.number().optional(),
      sampleVectors: z.array(z.object({
        key: z.string(),
        metadata: z.record(z.any()).optional(),
      })).optional(),
    }).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const bucketName = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
    const region = process.env.S3_VECTORS_REGION || 'us-east-2';
    const awsPath = process.env.AWS_CLI_PATH || 'aws';
    
    console.log(`[S3 Vectors Bucket Monitor] Action: ${context.action}`);
    console.log(`[S3 Vectors Bucket Monitor] Bucket: ${bucketName}, Region: ${region}`);
    
    try {
      if (context.action === 'list-indices') {
        // List all indices in the bucket
        const listCommand = `${awsPath} s3vectors list-indexes --vector-bucket-name ${bucketName} --region ${region}`;
        console.log(`[S3 Vectors Bucket Monitor] Running: ${listCommand}`);
        
        const { stdout } = await execAsync(listCommand);
        const result = JSON.parse(stdout);
        const indices = result.indexes || [];
        
        console.log(`[S3 Vectors Bucket Monitor] Found ${indices.length} indices`);
        
        // For each index, try to get vector count
        const indicesWithCounts = await Promise.all(indices.map(async (index: any) => {
          try {
            // Try to list vectors to get count (limit 1 for speed)
            const countCommand = `${awsPath} s3vectors list-vectors --vector-bucket-name ${bucketName} --index-name ${index.indexName} --region ${region} --max-results 1`;
            const { stdout: countResult } = await execAsync(countCommand);
            const countData = JSON.parse(countResult);
            
            // The total count might not be available, so we'll just indicate if vectors exist
            const hasVectors = (countData.vectors || []).length > 0;
            
            return {
              ...index,
              vectorCount: hasVectors ? 1 : 0, // Simplified - just show if index has vectors
            };
          } catch (error) {
            // If we can't access the index, just return the original
            return index;
          }
        }));
        
        return {
          success: true,
          action: context.action,
          bucketName,
          region,
          indices: indicesWithCounts,
          totalIndices: indices.length,
          message: `Successfully listed ${indices.length} indices in bucket '${bucketName}'`,
        };
        
      } else if (context.action === 'bucket-stats') {
        // Get overall bucket statistics
        const listCommand = `${awsPath} s3vectors list-indexes --vector-bucket-name ${bucketName} --region ${region}`;
        const { stdout } = await execAsync(listCommand);
        const result = JSON.parse(stdout);
        const indices = result.indexes || [];
        
        // Group indices by type
        const fileIndices = indices.filter((idx: any) => idx.indexName.startsWith('file-'));
        const systemIndices = indices.filter((idx: any) => !idx.indexName.startsWith('file-'));
        
        return {
          success: true,
          action: context.action,
          bucketName,
          region,
          totalIndices: indices.length,
          message: `Bucket '${bucketName}' contains ${indices.length} indices (${fileIndices.length} file-specific, ${systemIndices.length} system indices)`,
          indices: indices.slice(0, 10), // Return first 10 as sample
        };
        
      } else if (context.action === 'index-details') {
        if (!context.indexName) {
          throw new Error('Index name required for index-details action');
        }
        
        // Get index information
        const getCommand = `${awsPath} s3vectors get-index --vector-bucket-name ${bucketName} --index-name ${context.indexName} --region ${region}`;
        let indexInfo: any = {};
        
        try {
          const { stdout } = await execAsync(getCommand);
          indexInfo = JSON.parse(stdout);
        } catch (error) {
          console.log(`[S3 Vectors Bucket Monitor] Could not get index info: ${error}`);
        }
        
        // List some vectors from the index
        const listCommand = `${awsPath} s3vectors list-vectors --vector-bucket-name ${bucketName} --index-name ${context.indexName} --region ${region} --max-results 5`;
        const { stdout: listResult } = await execAsync(listCommand);
        const vectorList = JSON.parse(listResult);
        const vectors = vectorList.vectors || [];
        
        // Get metadata for sample vectors
        const sampleVectors = await Promise.all(vectors.slice(0, 3).map(async (v: any) => {
          try {
            const getVectorCommand = `${awsPath} s3vectors get-vectors --vector-bucket-name ${bucketName} --index-name ${context.indexName} --keys ${v.key} --region ${region}`;
            const { stdout: vectorData } = await execAsync(getVectorCommand);
            const parsed = JSON.parse(vectorData);
            const vector = parsed.vectors?.[0];
            
            return {
              key: v.key,
              metadata: vector?.metadata || {},
            };
          } catch (error) {
            return { key: v.key };
          }
        }));
        
        return {
          success: true,
          action: context.action,
          indexDetails: {
            indexName: context.indexName,
            dimension: indexInfo.dimension,
            vectorCount: vectors.length,
            sampleVectors,
          },
          message: `Index '${context.indexName}' contains ${vectors.length}+ vectors`,
        };
      }
      
      throw new Error('Invalid action');
      
    } catch (error) {
      console.error('[S3 Vectors Bucket Monitor] Error:', error);
      return {
        success: false,
        action: context.action,
        message: 'Failed to monitor S3 Vectors bucket',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});