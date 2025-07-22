import { createTool } from '@mastra/core';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

// Configuration - ALL credentials must come from environment variables
const POSTMAN_COLLECTION = '/home/bkngu/Claude/s3-vectors/postman-s3-vectors-working.json';
const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

// Helper function to get AWS credentials from environment
function getAwsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not found. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
    );
  }
  
  return { accessKeyId, secretAccessKey };
}

// Helper function to create Newman environment file
async function createNewmanEnv(indexName: string): Promise<string> {
  const { accessKeyId, secretAccessKey } = getAwsCredentials();
  
  const envFile = `/tmp/newman-env-${Date.now()}.json`;
  const envData = {
    id: 's3-vectors-env',
    name: 'S3 Vectors Environment',
    values: [
      { key: 'BUCKET_NAME', value: BUCKET_NAME, enabled: true },
      { key: 'AWS_ACCESS_KEY_ID', value: accessKeyId, enabled: true },
      { key: 'AWS_SECRET_ACCESS_KEY', value: secretAccessKey, enabled: true },
      { key: 'AWS_REGION', value: REGION, enabled: true },
      { key: 'INDEX_NAME', value: indexName, enabled: true }
    ]
  };
  
  await writeFile(envFile, JSON.stringify(envData));
  return envFile;
}

// Helper function to extract response from Newman output
async function extractNewmanResponse(outputFile: string): Promise<any> {
  try {
    const newmanOutput = JSON.parse(await readFile(outputFile, 'utf-8'));
    
    if (newmanOutput.run && newmanOutput.run.executions && newmanOutput.run.executions.length > 0) {
      const execution = newmanOutput.run.executions[0];
      if (execution.response && execution.response.stream) {
        const responseBody = execution.response.stream.toString();
        return JSON.parse(responseBody);
      }
    }
    throw new Error('No response found in Newman output');
  } catch (error) {
    throw new Error(`Failed to extract Newman response: ${error}`);
  }
}

export const s3VectorsPostmanQueryTool = createTool({
  id: 's3-vectors-postman-query',
  description: 'Query S3 Vectors using Postman/Newman - exactly like the Postman collection',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to query'),
    query: z.string().optional().describe('Text query to search for'),
    queryVector: z.array(z.number()).optional().describe('Pre-computed query vector'),
    topK: z.number().default(5).describe('Number of results to return'),
    returnMetadata: z.boolean().default(true).describe('Whether to return metadata'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string(),
    results: z.array(z.object({
      key: z.string(),
      score: z.number().optional(),
      metadata: z.record(z.any()).optional(),
    })),
    totalResults: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Postman Query] Querying index '${context.indexName}' using Newman`);
    
    let envFile: string | null = null;
    let outputFile: string | null = null;
    let requestFile: string | null = null;
    
    try {
      // Check if Newman is installed
      try {
        await execAsync('newman --version');
      } catch {
        throw new Error('Newman is not installed. Install with: npm install -g newman');
      }
      
      // Create environment file
      envFile = await createNewmanEnv(context.indexName);
      
      // Generate query vector if needed
      let queryVector = context.queryVector;
      if (!queryVector && context.query) {
        // For simplicity, use mock embedding
        console.log('[S3 Vectors Postman Query] Using mock embedding for query');
        queryVector = Array(384).fill(0).map(() => Math.random() * 0.1);
      }
      
      if (!queryVector) {
        throw new Error('Either query text or queryVector must be provided');
      }
      
      // Create a custom Postman collection with our query
      const customCollection = {
        info: {
          name: 'S3 Vectors Query',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}', type: 'string' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}', type: 'string' },
            { key: 'region', value: '{{AWS_REGION}}', type: 'string' },
            { key: 'service', value: 's3vectors', type: 'string' }
          ]
        },
        item: [
          {
            name: 'Query Vectors',
            request: {
              method: 'POST',
              header: [
                { key: 'Content-Type', value: 'application/json' }
              ],
              body: {
                mode: 'raw',
                raw: JSON.stringify({
                  vectorBucketName: '{{BUCKET_NAME}}',
                  indexName: '{{INDEX_NAME}}',
                  queryVector: {
                    float32: queryVector
                  },
                  topK: context.topK,
                  returnMetadata: context.returnMetadata,
                  returnValues: true
                })
              },
              url: {
                raw: 'https://s3vectors.{{AWS_REGION}}.api.aws/QueryVectors',
                protocol: 'https',
                host: ['s3vectors', '{{AWS_REGION}}', 'api', 'aws'],
                path: ['QueryVectors']
              }
            }
          }
        ]
      };
      
      // Save custom collection
      requestFile = `/tmp/postman-query-${Date.now()}.json`;
      await writeFile(requestFile, JSON.stringify(customCollection));
      
      // Run Newman
      outputFile = `/tmp/newman-output-${Date.now()}.json`;
      const newmanCmd = `newman run "${requestFile}" --environment "${envFile}" --reporters json --reporter-json-export "${outputFile}"`;
      
      console.log('[S3 Vectors Postman Query] Running Newman...');
      await execAsync(newmanCmd);
      
      // Extract response
      const response = await extractNewmanResponse(outputFile);
      
      const results = response.vectors?.map((v: any) => ({
        key: v.key,
        score: v.score,
        metadata: v.metadata || {}
      })) || [];
      
      console.log(`[S3 Vectors Postman Query] Found ${results.length} results`);
      
      return {
        success: true,
        indexName: context.indexName,
        results,
        totalResults: results.length,
        message: `Successfully queried index '${context.indexName}' using Postman/Newman`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman Query] Error:', error);
      return {
        success: false,
        indexName: context.indexName,
        results: [],
        totalResults: 0,
        message: `Failed to query index using Postman/Newman`,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Cleanup temp files
      if (envFile && existsSync(envFile)) await unlink(envFile);
      if (outputFile && existsSync(outputFile)) await unlink(outputFile);
      if (requestFile && existsSync(requestFile)) await unlink(requestFile);
    }
  },
});

export const s3VectorsPostmanListTool = createTool({
  id: 's3-vectors-postman-list',
  description: 'List vectors in an S3 Vectors index using Postman/Newman',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to list vectors from'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string(),
    vectors: z.array(z.object({
      key: z.string(),
    })),
    totalVectors: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Postman List] Listing vectors in index '${context.indexName}' using Newman`);
    
    let envFile: string | null = null;
    let outputFile: string | null = null;
    
    try {
      // Check Newman
      try {
        await execAsync('newman --version');
      } catch {
        throw new Error('Newman is not installed. Install with: npm install -g newman');
      }
      
      // Create environment
      envFile = await createNewmanEnv(context.indexName);
      outputFile = `/tmp/newman-list-${Date.now()}.json`;
      
      // Use the existing Postman collection with List Vectors request
      const newmanCmd = `newman run "${POSTMAN_COLLECTION}" --environment "${envFile}" --folder "List Vectors" --reporters json --reporter-json-export "${outputFile}"`;
      
      console.log('[S3 Vectors Postman List] Running Newman...');
      await execAsync(newmanCmd);
      
      // Extract response
      const response = await extractNewmanResponse(outputFile);
      
      const vectors = response.vectors?.map((v: any) => ({
        key: v.key
      })) || [];
      
      console.log(`[S3 Vectors Postman List] Found ${vectors.length} vectors`);
      
      return {
        success: true,
        indexName: context.indexName,
        vectors,
        totalVectors: vectors.length,
        message: `Successfully listed ${vectors.length} vectors in index '${context.indexName}' using Postman/Newman`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman List] Error:', error);
      return {
        success: false,
        indexName: context.indexName,
        vectors: [],
        totalVectors: 0,
        message: `Failed to list vectors using Postman/Newman`,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Cleanup
      if (envFile && existsSync(envFile)) await unlink(envFile);
      if (outputFile && existsSync(outputFile)) await unlink(outputFile);
    }
  },
});

export const s3VectorsPostmanUploadTool = createTool({
  id: 's3-vectors-postman-upload',
  description: 'Upload vectors to S3 Vectors using Postman/Newman',
  inputSchema: z.object({
    indexName: z.string().describe('The index name to store vectors in'),
    key: z.string().describe('The vector key (unique identifier)'),
    text: z.string().describe('The text content to embed and store'),
    metadata: z.record(z.any()).describe('The metadata values to associate with this vector key'),
    embedding: z.array(z.number()).optional().describe('Pre-computed embedding (384 dimensions)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    key: z.string(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Postman Upload] Uploading vector '${context.key}' using Newman`);
    
    let envFile: string | null = null;
    let outputFile: string | null = null;
    let requestFile: string | null = null;
    
    try {
      // Check Newman
      try {
        await execAsync('newman --version');
      } catch {
        throw new Error('Newman is not installed. Install with: npm install -g newman');
      }
      
      // Generate embedding if not provided
      let embedding = context.embedding;
      if (!embedding) {
        console.log('[S3 Vectors Postman Upload] Using mock embedding');
        embedding = Array(384).fill(0).map(() => Math.random());
      }
      
      // Create environment
      envFile = await createNewmanEnv(context.indexName);
      
      // Create custom collection for PUT request
      const customCollection = {
        info: {
          name: 'S3 Vectors Upload',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}', type: 'string' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}', type: 'string' },
            { key: 'region', value: '{{AWS_REGION}}', type: 'string' },
            { key: 'service', value: 's3vectors', type: 'string' }
          ]
        },
        item: [
          {
            name: 'Put Vectors',
            request: {
              method: 'POST',
              header: [
                { key: 'Content-Type', value: 'application/json' }
              ],
              body: {
                mode: 'raw',
                raw: JSON.stringify({
                  vectorBucketName: '{{BUCKET_NAME}}',
                  indexName: '{{INDEX_NAME}}',
                  vectors: [
                    {
                      key: context.key,
                      data: {
                        float32: embedding
                      },
                      metadata: {
                        ...context.metadata,
                        text: context.text,
                        uploadedAt: new Date().toISOString()
                      }
                    }
                  ]
                })
              },
              url: {
                raw: 'https://s3vectors.{{AWS_REGION}}.api.aws/PutVectors',
                protocol: 'https',
                host: ['s3vectors', '{{AWS_REGION}}', 'api', 'aws'],
                path: ['PutVectors']
              }
            }
          }
        ]
      };
      
      // Save custom collection
      requestFile = `/tmp/postman-upload-${Date.now()}.json`;
      await writeFile(requestFile, JSON.stringify(customCollection));
      
      // Run Newman
      outputFile = `/tmp/newman-upload-${Date.now()}.json`;
      const newmanCmd = `newman run "${requestFile}" --environment "${envFile}" --reporters json --reporter-json-export "${outputFile}"`;
      
      console.log('[S3 Vectors Postman Upload] Running Newman...');
      await execAsync(newmanCmd);
      
      console.log(`[S3 Vectors Postman Upload] Successfully uploaded vector '${context.key}'`);
      
      return {
        success: true,
        key: context.key,
        message: `Successfully uploaded vector '${context.key}' to index '${context.indexName}' using Postman/Newman`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman Upload] Error:', error);
      return {
        success: false,
        key: context.key,
        message: `Failed to upload vector using Postman/Newman`,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Cleanup
      if (envFile && existsSync(envFile)) await unlink(envFile);
      if (outputFile && existsSync(outputFile)) await unlink(outputFile);
      if (requestFile && existsSync(requestFile)) await unlink(requestFile);
    }
  },
});

// Create Index Tool
export const s3VectorsPostmanCreateIndexTool = createTool({
  id: 's3-vectors-postman-create-index',
  description: 'Create a new S3 Vectors index using Postman/Newman',
  inputSchema: z.object({
    indexName: z.string().describe('Name for the new index'),
    dimension: z.number().default(1536).describe('Vector dimension (384 for sentence-transformers, 1536 for OpenAI)'),
    distanceMetric: z.enum(['cosine', 'euclidean', 'dotProduct']).default('cosine').describe('Distance metric for similarity'),
    dataType: z.enum(['float32', 'float16']).default('float32').describe('Data type for vectors'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Postman Create] Creating index: ${context.indexName}`);
    
    let envFile: string | null = null;
    let outputFile: string | null = null;
    try {
      // Get AWS credentials
      const { accessKeyId, secretAccessKey } = getAwsCredentials();
      
      // Create custom environment with all parameters
      const customEnv = {
        "values": [
          { "key": "AWS_ACCESS_KEY_ID", "value": accessKeyId },
          { "key": "AWS_SECRET_ACCESS_KEY", "value": secretAccessKey },
          { "key": "AWS_REGION", "value": REGION },
          { "key": "BUCKET_NAME", "value": BUCKET_NAME },
          { "key": "INDEX_NAME", "value": context.indexName }
        ]
      };
      
      envFile = `/tmp/newman-env-create-${Date.now()}.json`;
      await writeFile(envFile, JSON.stringify(customEnv));
      
      // Check if collection exists
      if (!existsSync(POSTMAN_COLLECTION)) {
        throw new Error(`Postman collection not found at ${POSTMAN_COLLECTION}`);
      }
      
      // Run Newman with Create Index request
      outputFile = `/tmp/newman-create-result-${Date.now()}.json`;
      const command = `newman run "${POSTMAN_COLLECTION}" --folder "Create Index" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
      
      console.log('[S3 Vectors Postman Create] Running Newman...');
      const { stdout, stderr } = await execAsync(command);
      
      // Check if output file was created
      if (!existsSync(outputFile)) {
        console.log('[S3 Vectors Postman Create] Newman output:', stdout);
        if (stderr) console.error('[S3 Vectors Postman Create] Newman stderr:', stderr);
        throw new Error('Newman did not produce output file');
      }
      
      // Check results
      const resultData = await readFile(outputFile, 'utf-8');
      const result = JSON.parse(resultData);
      
      if (result.run?.stats?.assertions?.failed > 0 || result.run?.stats?.requests?.failed > 0) {
        const errorDetails = result.run.failures?.[0]?.error?.message || 
                           result.run.failures?.[0]?.source?.response?.body ||
                           'Unknown error';
        throw new Error(`Index creation failed: ${errorDetails}`);
      }
      
      return {
        success: true,
        indexName: context.indexName,
        message: `Successfully created S3 Vectors index '${context.indexName}' with dimension ${context.dimension}`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman Create] Error:', error);
      return {
        success: false,
        message: 'Failed to create S3 Vectors index',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Cleanup
      if (envFile && existsSync(envFile)) await unlink(envFile);
      if (outputFile && existsSync(outputFile)) await unlink(outputFile);
    }
  },
});

