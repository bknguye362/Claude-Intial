// S3 Vectors Monitoring Tool
// Provides visibility into stored vectors and their metadata

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const s3VectorsMonitorTool = createTool({
  id: 's3-vectors-monitor',
  description: 'Monitor and inspect vectors stored in S3 Vectors - check what documents are indexed and their status',
  inputSchema: z.object({
    action: z.enum(['list', 'stats', 'inspect']).describe('Action: list all vectors, get stats, or inspect specific document'),
    documentId: z.string().optional().describe('Document ID to inspect (for inspect action)'),
    limit: z.number().default(100).optional().describe('Maximum number of vectors to list'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    totalVectors: z.number().optional(),
    documents: z.array(z.object({
      documentId: z.string(),
      filename: z.string().optional(),
      chunkCount: z.number(),
      lastUpdated: z.string().optional(),
    })).optional(),
    vectorDetails: z.array(z.object({
      key: z.string(),
      documentId: z.string().optional(),
      chunkIndex: z.number().optional(),
      lastUpdated: z.string().optional(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const bucketName = process.env.AWS_S3_VECTOR_BUCKET || 'chatbotvectors362';
    const indexName = 'mastra-chatbot';
    const region = process.env.AWS_REGION || 'us-east-2';
    const awsPath = process.env.AWS_CLI_PATH || '~/.local/bin/aws';
    
    console.log(`[S3 Vectors Monitor] Action: ${context.action}`);
    
    try {
      if (context.action === 'list' || context.action === 'stats') {
        // List all vectors
        const listCommand = `${awsPath} s3vectors list-vectors --vector-bucket-name ${bucketName} --index-name ${indexName} --region ${region}`;
        const { stdout } = await execAsync(listCommand);
        const result = JSON.parse(stdout);
        const vectors = result.vectors || [];
        
        // Group by document
        const documentMap = new Map<string, { filename?: string, chunks: any[], lastUpdated?: string }>();
        
        vectors.forEach((vector: any) => {
          // Extract document ID from key (format: documentId-chunk-N)
          const match = vector.key.match(/^(.+)-chunk-\d+$/);
          if (match) {
            const docId = match[1];
            if (!documentMap.has(docId)) {
              documentMap.set(docId, { chunks: [] });
            }
            documentMap.get(docId)!.chunks.push(vector);
          }
        });
        
        // Get metadata for each document (sample first chunk)
        for (const [docId, docInfo] of documentMap.entries()) {
          if (docInfo.chunks.length > 0) {
            try {
              const getCommand = `${awsPath} s3vectors get-vectors --vector-bucket-name ${bucketName} --index-name ${indexName} --keys ${docInfo.chunks[0].key} --region ${region}`;
              const { stdout: getResult } = await execAsync(getCommand);
              const vectorData = JSON.parse(getResult);
              
              if (vectorData.vectors?.[0]?.metadata) {
                docInfo.filename = vectorData.vectors[0].metadata.filename;
                docInfo.lastUpdated = vectorData.vectors[0].metadata.lastUpdated;
              }
            } catch (error) {
              // Ignore metadata fetch errors
            }
          }
        }
        
        const documents = Array.from(documentMap.entries()).map(([docId, info]) => ({
          documentId: docId,
          filename: info.filename,
          chunkCount: info.chunks.length,
          lastUpdated: info.lastUpdated,
        }));
        
        return {
          success: true,
          action: context.action,
          totalVectors: vectors.length,
          documents: documents.slice(0, context.limit),
          message: `Found ${vectors.length} vectors across ${documents.length} documents`,
        };
        
      } else if (context.action === 'inspect') {
        if (!context.documentId) {
          throw new Error('Document ID required for inspect action');
        }
        
        // List vectors for specific document
        const listCommand = `${awsPath} s3vectors list-vectors --vector-bucket-name ${bucketName} --index-name ${indexName} --region ${region}`;
        const { stdout } = await execAsync(listCommand);
        const result = JSON.parse(stdout);
        const allVectors = result.vectors || [];
        
        // Filter for this document
        const docVectors = allVectors.filter((v: any) => v.key.startsWith(`${context.documentId}-chunk-`));
        
        const vectorDetails = docVectors.map((v: any) => {
          const match = v.key.match(/chunk-(\d+)$/);
          return {
            key: v.key,
            documentId: context.documentId,
            chunkIndex: match ? parseInt(match[1]) : -1,
          };
        });
        
        return {
          success: true,
          action: 'inspect',
          vectorDetails: vectorDetails.sort((a, b) => a.chunkIndex - b.chunkIndex),
          message: `Document "${context.documentId}" has ${docVectors.length} vector chunks`,
        };
      }
      
      throw new Error('Invalid action');
      
    } catch (error) {
      console.error('[S3 Vectors Monitor] Error:', error);
      return {
        success: false,
        action: context.action,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});