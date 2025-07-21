import { createTool } from '@mastra/core';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

export const s3VectorsFlexibleQueryTool = createTool({
  id: 's3-vectors-flexible-query',
  description: 'Query any S3 Vectors index with flexible parameters - can target any index name',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to query'),
    query: z.string().optional().describe('Text query to search for (will be converted to embedding)'),
    queryVector: z.array(z.number()).optional().describe('Pre-computed query vector (if not provided, will generate from query text)'),
    topK: z.number().default(5).describe('Number of results to return'),
    filter: z.record(z.any()).optional().describe('Metadata filter to apply'),
    returnMetadata: z.boolean().default(true).describe('Whether to return metadata with results'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string(),
    results: z.array(z.object({
      key: z.string(),
      score: z.number(),
      metadata: z.record(z.any()).optional(),
      vector: z.array(z.number()).optional(),
    })),
    totalResults: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Flexible Query] Querying index: ${context.indexName}`);
    
    try {
      let queryVector = context.queryVector;
      
      // Generate embedding if query text is provided instead of vector
      if (!queryVector && context.query) {
        const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
        const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
        
        if (!AZURE_OPENAI_API_KEY) {
          console.log('[S3 Vectors Flexible Query] No API key for embeddings, using mock embeddings...');
          queryVector = Array(1536).fill(0).map(() => Math.random() * 0.1 - 0.05);
        } else {
          const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/text-embedding-ada-002/embeddings?api-version=2023-05-15`;
          
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': AZURE_OPENAI_API_KEY,
            },
            body: JSON.stringify({
              input: context.query,
            }),
          });
          
          if (!response.ok) {
            throw new Error(`Embedding API error: ${response.statusText}`);
          }
          
          const data = await response.json() as { data: Array<{ embedding: number[] }> };
          queryVector = data.data[0].embedding;
        }
      }
      
      if (!queryVector) {
        throw new Error('Either query text or queryVector must be provided');
      }
      
      // Prepare query payload
      const queryPayload: any = {
        queryVector: {
          float32: queryVector
        },
        topK: context.topK,
        returnMetadata: context.returnMetadata
      };
      
      if (context.filter) {
        queryPayload.filter = context.filter;
      }
      
      // Write to temporary file
      const tempFile = join('/tmp', `query-${Date.now()}.json`);
      await writeFile(tempFile, JSON.stringify(queryPayload));
      
      // Query using AWS CLI
      const command = `aws s3vectors query-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --cli-input-json file://${tempFile} --region ${REGION}`;
      console.log(`[S3 Vectors Flexible Query] Executing command for index '${context.indexName}'`);
      
      const { stdout, stderr } = await execAsync(command);
      
      // Clean up temp file
      await unlink(tempFile);
      
      if (stderr && !stderr.includes('WARNING')) {
        throw new Error(stderr);
      }
      
      const queryResult = JSON.parse(stdout);
      const results = queryResult.vectors?.map((v: any) => ({
        key: v.key,
        score: v.score,
        metadata: v.metadata || {},
        vector: v.data?.float32
      })) || [];
      
      console.log(`[S3 Vectors Flexible Query] Found ${results.length} results in index '${context.indexName}'`);
      
      return {
        success: true,
        indexName: context.indexName,
        results,
        totalResults: results.length,
        message: `Successfully queried index '${context.indexName}' and found ${results.length} results`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Flexible Query] Error:', error);
      return {
        success: false,
        indexName: context.indexName,
        results: [],
        totalResults: 0,
        message: `Failed to query index '${context.indexName}'`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const s3VectorsListIndicesTool = createTool({
  id: 's3-vectors-list-indices',
  description: 'List all available S3 Vectors indices in the bucket',
  inputSchema: z.object({
    bucketName: z.string().default(BUCKET_NAME).optional().describe('The vector bucket name'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indices: z.array(z.object({
      indexName: z.string(),
      dimension: z.number(),
      distanceMetric: z.string(),
      dataType: z.string(),
      vectorCount: z.number().optional(),
    })),
    totalIndices: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors List Indices] Listing indices in bucket: ${context.bucketName || BUCKET_NAME}`);
    
    try {
      const bucketName = context.bucketName || BUCKET_NAME;
      const command = `aws s3vectors list-indexes --vector-bucket-name ${bucketName} --region ${REGION}`;
      
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('WARNING')) {
        throw new Error(stderr);
      }
      
      const result = JSON.parse(stdout);
      const indices = result.indexes?.map((idx: any) => ({
        indexName: idx.indexName,
        dimension: idx.dimension,
        distanceMetric: idx.distanceMetric,
        dataType: idx.dataType,
        vectorCount: idx.vectorCount
      })) || [];
      
      console.log(`[S3 Vectors List Indices] Found ${indices.length} indices`);
      
      return {
        success: true,
        indices,
        totalIndices: indices.length,
        message: `Found ${indices.length} indices in bucket '${bucketName}'`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors List Indices] Error:', error);
      return {
        success: false,
        indices: [],
        totalIndices: 0,
        message: 'Failed to list indices',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const s3VectorsGetVectorsTool = createTool({
  id: 's3-vectors-get-vectors',
  description: 'Get specific vectors by keys from any S3 Vectors index',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to retrieve vectors from'),
    keys: z.array(z.string()).describe('Array of vector keys to retrieve'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string(),
    vectors: z.array(z.object({
      key: z.string(),
      metadata: z.record(z.any()).optional(),
      vector: z.array(z.number()).optional(),
    })),
    totalVectors: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Get Vectors] Getting ${context.keys.length} vectors from index: ${context.indexName}`);
    
    try {
      const vectors = [];
      
      // Get vectors one by one (AWS CLI doesn't support batch get)
      for (const key of context.keys) {
        const command = `aws s3vectors get-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --keys ${key} --region ${REGION}`;
        
        try {
          const { stdout } = await execAsync(command);
          const result = JSON.parse(stdout);
          
          if (result.vectors && result.vectors.length > 0) {
            const vector = result.vectors[0];
            vectors.push({
              key: vector.key,
              metadata: vector.metadata || {},
              vector: vector.data?.float32
            });
          }
        } catch (err) {
          console.warn(`[S3 Vectors Get Vectors] Failed to get vector '${key}':`, err);
        }
      }
      
      console.log(`[S3 Vectors Get Vectors] Retrieved ${vectors.length} vectors from index '${context.indexName}'`);
      
      return {
        success: true,
        indexName: context.indexName,
        vectors,
        totalVectors: vectors.length,
        message: `Successfully retrieved ${vectors.length} vectors from index '${context.indexName}'`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Get Vectors] Error:', error);
      return {
        success: false,
        indexName: context.indexName,
        vectors: [],
        totalVectors: 0,
        message: `Failed to get vectors from index '${context.indexName}'`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});