import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

export const s3VectorsGetByKeyTool = createTool({
  id: 's3-vectors-get-by-key',
  description: 'Get a specific vector by its key using a two-step process: first get the vector, then query with its values',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to search in'),
    vectorKey: z.string().describe('The key of the vector to retrieve'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    vector: z.object({
      key: z.string(),
      metadata: z.record(z.any()).optional(),
      values: z.array(z.number()).optional(),
      score: z.number().optional(),
    }).optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const bucketName = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
    const region = process.env.S3_VECTORS_REGION || 'us-east-2';
    
    let envFile: string | null = null;
    
    try {
      // Create environment file for Newman
      const envData = {
        values: [
          { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
          { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
          { key: 'AWS_REGION', value: region },
          { key: 'BUCKET_NAME', value: bucketName },
          { key: 'INDEX_NAME', value: context.indexName },
        ]
      };
      
      envFile = `/tmp/newman-env-get-key-${Date.now()}.json`;
      await writeFile(envFile, JSON.stringify(envData));
      
      // Step 1: Try GetVectors first
      console.log(`[Get By Key] Attempting to get vector '${context.vectorKey}' from index '${context.indexName}'`);
      
      const getCollection = {
        info: {
          name: 'Get Vector By Key',
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
        item: [{
          name: 'Get Vector',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                vectorBucketName: bucketName,
                indexName: context.indexName,
                keys: [context.vectorKey],
                returnMetadata: true,
                returnValues: true
              })
            },
            url: {
              raw: `https://s3vectors.${region}.api.aws/GetVectors`,
              protocol: 'https',
              host: ['s3vectors', region, 'api', 'aws'],
              path: ['GetVectors']
            }
          }
        }]
      };
      
      const collectionFile = `/tmp/newman-get-collection-${Date.now()}.json`;
      await writeFile(collectionFile, JSON.stringify(getCollection));
      
      const outputFile = `/tmp/newman-get-output-${Date.now()}.json`;
      const command = `npx newman run "${collectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${outputFile}"`;
      
      try {
        await execAsync(command);
        
        if (existsSync(outputFile)) {
          const outputData = await import('fs').then(fs => fs.promises.readFile(outputFile, 'utf-8'));
          const output = JSON.parse(outputData);
          
          const response = output.run?.executions?.[0]?.response;
          if (response && response.stream) {
            const responseBody = JSON.parse(response.stream.toString());
            
            if (responseBody.vectors && responseBody.vectors.length > 0) {
              const vector = responseBody.vectors[0];
              
              // If we got the vector with values, return it
              if (vector.values || vector.value) {
                return {
                  success: true,
                  vector: {
                    key: context.vectorKey,
                    metadata: vector.metadata || {},
                    values: vector.values || vector.value,
                    score: 1.0  // Exact match
                  },
                  message: `Successfully retrieved vector '${context.vectorKey}'`
                };
              }
            }
          }
        }
      } catch (error) {
        console.log('[Get By Key] GetVectors failed, trying alternative approach...');
      } finally {
        if (existsSync(collectionFile)) await unlink(collectionFile);
        if (existsSync(outputFile)) await unlink(outputFile);
      }
      
      // Step 2: If GetVectors didn't work, try ListVectors to get all vectors and find our key
      console.log(`[Get By Key] Trying ListVectors approach...`);
      
      const listCollection = {
        info: {
          name: 'List Vectors',
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
        item: [{
          name: 'List Vectors',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                vectorBucketName: bucketName,
                indexName: context.indexName,
                maxResults: 1000,
                returnMetadata: true
              })
            },
            url: {
              raw: `https://s3vectors.${region}.api.aws/ListVectors`,
              protocol: 'https',
              host: ['s3vectors', region, 'api', 'aws'],
              path: ['ListVectors']
            }
          }
        }]
      };
      
      const listCollectionFile = `/tmp/newman-list-collection-${Date.now()}.json`;
      await writeFile(listCollectionFile, JSON.stringify(listCollection));
      
      const listOutputFile = `/tmp/newman-list-output-${Date.now()}.json`;
      const listCommand = `npx newman run "${listCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${listOutputFile}"`;
      
      try {
        await execAsync(listCommand);
        
        if (existsSync(listOutputFile)) {
          const outputData = await import('fs').then(fs => fs.promises.readFile(listOutputFile, 'utf-8'));
          const output = JSON.parse(outputData);
          
          const response = output.run?.executions?.[0]?.response;
          if (response && response.stream) {
            const responseBody = JSON.parse(response.stream.toString());
            
            if (responseBody.vectors) {
              // Find the vector with matching key
              const vector = responseBody.vectors.find((v: any) => v.key === context.vectorKey);
              
              if (vector) {
                return {
                  success: true,
                  vector: {
                    key: context.vectorKey,
                    metadata: vector.metadata || {},
                    values: [],  // ListVectors doesn't return values
                    score: 1.0
                  },
                  message: `Found vector '${context.vectorKey}' (metadata only, values not included in ListVectors)`
                };
              }
            }
          }
        }
      } finally {
        if (existsSync(listCollectionFile)) await unlink(listCollectionFile);
        if (existsSync(listOutputFile)) await unlink(listOutputFile);
      }
      
      return {
        success: false,
        message: `Vector with key '${context.vectorKey}' not found in index '${context.indexName}'`
      };
      
    } catch (error) {
      console.error('[Get By Key] Error:', error);
      return {
        success: false,
        message: `Error retrieving vector: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    } finally {
      if (envFile && existsSync(envFile)) await unlink(envFile);
    }
  },
});