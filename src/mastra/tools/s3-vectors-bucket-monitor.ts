// S3 Vectors Bucket Monitoring Tool
// Provides comprehensive visibility into the entire S3 Vectors bucket

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const s3VectorsBucketMonitorTool = createTool({
  id: 's3-vectors-bucket-monitor',
  description: 'Monitor the entire S3 Vectors bucket - list all indices, check bucket status, and get statistics. Valid actions: list-indices, bucket-stats, index-details',
  inputSchema: z.object({
    action: z.enum(['list-indices', 'bucket-stats', 'index-details']).describe('Action: "list-indices" to list all indices, "bucket-stats" for statistics, or "index-details" for specific index details'),
    indexName: z.string().optional().describe('Index name (required only for index-details action)'),
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
    
    console.log(`[S3 Vectors Bucket Monitor] Received request:`, JSON.stringify(context));
    console.log(`[S3 Vectors Bucket Monitor] Action: ${context.action}`);
    console.log(`[S3 Vectors Bucket Monitor] Bucket: ${bucketName}, Region: ${region}`);
    
    // Validate action
    if (!['list-indices', 'bucket-stats', 'index-details'].includes(context.action)) {
      const errorMsg = `Invalid action "${context.action}". Valid actions are: "list-indices" (list all indices), "bucket-stats" (get bucket statistics), or "index-details" (get details for specific index)`;
      console.error(`[S3 Vectors Bucket Monitor] ${errorMsg}`);
      return {
        success: false,
        action: context.action,
        message: errorMsg,
        error: errorMsg,
      };
    }
    
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
          const errorMsg = 'Index name is required for index-details action. Please provide indexName parameter.';
          console.error(`[S3 Vectors Bucket Monitor] ${errorMsg}`);
          return {
            success: false,
            action: context.action,
            message: errorMsg,
            error: errorMsg,
          };
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
      
      // This should never be reached due to validation above
      const errorMsg = `Unexpected action: ${context.action}`;
      console.error(`[S3 Vectors Bucket Monitor] ${errorMsg}`);
      return {
        success: false,
        action: context.action,
        message: errorMsg,
        error: errorMsg,
      };
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const errorDetails = {
        action: context.action,
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
        bucket: bucketName,
        region: region,
        awsPath: awsPath
      };
      
      console.error('[S3 Vectors Bucket Monitor] Error details:', errorDetails);
      
      // Provide helpful error messages for common issues
      let helpfulMessage = `Failed to execute ${context.action}: ${errorMsg}`;
      if (errorMsg.includes('command not found') || errorMsg.includes('aws: not found')) {
        helpfulMessage += '. AWS CLI may not be installed or not in PATH.';
      } else if (errorMsg.includes('UnauthorizedException') || errorMsg.includes('credentials')) {
        helpfulMessage += '. Check AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).';
      } else if (errorMsg.includes('NotFoundException')) {
        helpfulMessage += '. The specified index or bucket may not exist.';
      }
      
      return {
        success: false,
        action: context.action,
        message: helpfulMessage,
        error: errorMsg,
      };
    }
  },
});