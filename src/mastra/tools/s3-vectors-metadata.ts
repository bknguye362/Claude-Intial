import { createTool } from '@mastra/core';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

export const s3VectorsUploadTool = createTool({
  id: 's3-vectors-upload',
  description: 'Upload vectors to S3 Vectors where key is the vector ID and value is the metadata',
  inputSchema: z.object({
    indexName: z.string().describe('The index name to store vectors in'),
    key: z.string().describe('The vector key (unique identifier)'),
    text: z.string().describe('The text content to embed and store'),
    metadata: z.record(z.any()).describe('The metadata values to associate with this vector key'),
    embedding: z.array(z.number()).optional().describe('Pre-computed embedding (if not provided, will generate from text)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    key: z.string(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Upload] Uploading vector with key: ${context.key}`);
    
    try {
      let embedding = context.embedding;
      
      // Generate embedding if not provided
      if (!embedding) {
        // Use Azure OpenAI to generate embeddings
        const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
        const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
        
        if (!AZURE_OPENAI_API_KEY) {
          console.log('[S3 Vectors Upload] No API key for embeddings, using mock embeddings...');
          embedding = Array(1536).fill(0).map(() => Math.random() * 0.1 - 0.05);
        } else {
          const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/text-embedding-ada-002/embeddings?api-version=2023-05-15`;
          
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': AZURE_OPENAI_API_KEY,
            },
            body: JSON.stringify({
              input: context.text,
            }),
          });
          
          if (!response.ok) {
            throw new Error(`Embedding API error: ${response.statusText}`);
          }
          
          const data = await response.json() as { data: Array<{ embedding: number[] }> };
          embedding = data.data[0].embedding;
        }
      }
      
      // Prepare vector payload
      const vectorPayload = {
        key: context.key,
        data: {
          float32: embedding
        },
        metadata: {
          ...context.metadata,
          text: context.text,
          uploadedAt: new Date().toISOString()
        }
      };
      
      // Write to temporary file
      const tempFile = join('/tmp', `vector-${Date.now()}.json`);
      await writeFile(tempFile, JSON.stringify([vectorPayload]));
      
      // Upload using AWS CLI
      const command = `aws s3vectors put-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --vectors file://${tempFile} --region ${REGION}`;
      const { stdout, stderr } = await execAsync(command);
      
      // Clean up temp file
      await unlink(tempFile);
      
      if (stderr && !stderr.includes('WARNING')) {
        throw new Error(stderr);
      }
      
      console.log(`[S3 Vectors Upload] Successfully uploaded vector: ${context.key}`);
      
      return {
        success: true,
        key: context.key,
        message: `Successfully uploaded vector with key: ${context.key}`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Upload] Error:', error);
      return {
        success: false,
        key: context.key,
        message: 'Failed to upload vector',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const s3VectorsReadMetadataTool = createTool({
  id: 's3-vectors-read-metadata',
  description: 'Read vectors from S3 Vectors and retrieve their metadata values',
  inputSchema: z.object({
    indexName: z.string().describe('The index name to read from'),
    keys: z.array(z.string()).optional().describe('Specific vector keys to retrieve metadata for (if not provided, lists all)'),
    filter: z.record(z.any()).optional().describe('Metadata filter for listing vectors'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    vectors: z.array(z.object({
      key: z.string(),
      metadata: z.record(z.any()),
      embedding: z.array(z.number()).optional(),
    })),
    totalCount: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Read] Reading metadata from index: ${context.indexName}`);
    
    try {
      let vectorKeys = context.keys;
      
      // If no keys provided, list all vectors first
      if (!vectorKeys || vectorKeys.length === 0) {
        const listCommand = `aws s3vectors list-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --region ${REGION}`;
        const { stdout: listOutput } = await execAsync(listCommand);
        const listResult = JSON.parse(listOutput);
        vectorKeys = listResult.vectors?.map((v: any) => v.key) || [];
      }
      
      if (!vectorKeys || vectorKeys.length === 0) {
        return {
          success: true,
          vectors: [],
          totalCount: 0,
          message: 'No vectors found in the index',
        };
      }
      
      // Get full vector data including metadata
      const vectors = [];
      for (const key of vectorKeys!) {
        const getCommand = `aws s3vectors get-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --keys ${key} --region ${REGION}`;
        const { stdout } = await execAsync(getCommand);
        const result = JSON.parse(stdout);
        
        if (result.vectors && result.vectors.length > 0) {
          const vector = result.vectors[0];
          vectors.push({
            key: vector.key,
            metadata: vector.metadata || {},
            embedding: vector.data?.float32 || []
          });
        }
      }
      
      console.log(`[S3 Vectors Read] Retrieved ${vectors.length} vectors with metadata`);
      
      return {
        success: true,
        vectors,
        totalCount: vectors.length,
        message: `Successfully retrieved ${vectors.length} vectors with metadata`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Read] Error:', error);
      return {
        success: false,
        vectors: [],
        totalCount: 0,
        message: 'Failed to read vectors',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const s3VectorsQueryTool = createTool({
  id: 's3-vectors-query',
  description: 'Query vectors by similarity search with metadata filtering',
  inputSchema: z.object({
    indexName: z.string().describe('The index name to query'),
    query: z.string().describe('Text query to search for'),
    topK: z.number().default(5).describe('Number of results to return'),
    filter: z.record(z.any()).optional().describe('Metadata filter to apply'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      key: z.string(),
      score: z.number(),
      metadata: z.record(z.any()),
    })),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Query] Searching for: "${context.query}"`);
    
    try {
      // Generate embedding for query
      const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
      const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
      
      let queryEmbedding: number[];
      if (!AZURE_OPENAI_API_KEY) {
        console.log('[S3 Vectors Query] No API key for embeddings, using mock embeddings...');
        queryEmbedding = Array(1536).fill(0).map(() => Math.random() * 0.1 - 0.05);
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
        queryEmbedding = data.data[0].embedding;
      }
      
      // Prepare query payload
      const queryPayload: any = {
        queryVector: {
          float32: queryEmbedding
        },
        topK: context.topK
      };
      
      if (context.filter) {
        queryPayload.filter = context.filter;
      }
      
      // Write to temporary file
      const tempFile = join('/tmp', `query-${Date.now()}.json`);
      await writeFile(tempFile, JSON.stringify(queryPayload));
      
      // Query using AWS CLI
      const command = `aws s3vectors query-vectors --vector-bucket-name ${BUCKET_NAME} --index-name ${context.indexName} --cli-input-json file://${tempFile} --region ${REGION}`;
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
        metadata: v.metadata || {}
      })) || [];
      
      console.log(`[S3 Vectors Query] Found ${results.length} results`);
      
      return {
        success: true,
        results,
        message: `Found ${results.length} similar vectors`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Query] Error:', error);
      return {
        success: false,
        results: [],
        message: 'Failed to query vectors',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});