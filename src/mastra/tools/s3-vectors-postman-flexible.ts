import { createTool } from '@mastra/core';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

// Configuration
const POSTMAN_COLLECTION = '/home/bkngu/Claude/s3-vectors/postman-s3-vectors-working.json';
const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

// Helper to get AWS credentials
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

// Flexible Postman Executor Tool
export const s3VectorsPostmanFlexibleTool = createTool({
  id: 's3-vectors-postman-flexible',
  description: 'Execute any request from the S3 Vectors Postman collection with custom parameters',
  inputSchema: z.object({
    requestName: z.string().describe('The name of the request in the Postman collection (e.g., "Put Vectors with Metadata", "Create Index", "Query Vectors with Filter")'),
    requestBody: z.record(z.any()).optional().describe('The request body as a JSON object (for POST/PUT requests)'),
    environmentOverrides: z.record(z.string()).optional().describe('Override environment variables (e.g., {INDEX_NAME: "my-index", BUCKET_NAME: "my-bucket"})'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    requestName: z.string(),
    statusCode: z.number().optional(),
    response: z.any().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[S3 Vectors Postman Flexible] Executing request: ${context.requestName}`);
    
    let envFile: string | null = null;
    let outputFile: string | null = null;
    let customCollectionFile: string | null = null;
    
    try {
      // Check Newman
      try {
        await execAsync('newman --version');
      } catch {
        throw new Error('Newman is not installed. Install with: npm install -g newman');
      }
      
      // Get AWS credentials
      const { accessKeyId, secretAccessKey } = getAwsCredentials();
      
      // Create environment with overrides
      const envVars = {
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_REGION: REGION,
        BUCKET_NAME: BUCKET_NAME,
        INDEX_NAME: 'default-index',
        ...context.environmentOverrides
      };
      
      const envData = {
        id: 's3-vectors-env',
        name: 'S3 Vectors Environment',
        values: Object.entries(envVars).map(([key, value]) => ({
          key,
          value,
          enabled: true
        }))
      };
      
      envFile = `/tmp/newman-env-flexible-${Date.now()}.json`;
      await writeFile(envFile, JSON.stringify(envData));
      
      // If request body is provided, we need to modify the collection
      if (context.requestBody) {
        console.log('[S3 Vectors Postman Flexible] Customizing request body...');
        
        // Read the original collection
        const collectionData = JSON.parse(await readFile(POSTMAN_COLLECTION, 'utf-8'));
        
        // Find the request by name
        let requestFound = false;
        for (const item of collectionData.item || []) {
          if (item.name === context.requestName) {
            requestFound = true;
            if (item.request && item.request.body && item.request.body.mode === 'raw') {
              // Update the request body
              item.request.body.raw = JSON.stringify(context.requestBody, null, 2);
            }
            break;
          }
        }
        
        if (!requestFound) {
          throw new Error(`Request "${context.requestName}" not found in Postman collection`);
        }
        
        // Save modified collection
        customCollectionFile = `/tmp/postman-custom-${Date.now()}.json`;
        await writeFile(customCollectionFile, JSON.stringify(collectionData));
      }
      
      // Run Newman
      outputFile = `/tmp/newman-output-${Date.now()}.json`;
      const collectionPath = customCollectionFile || POSTMAN_COLLECTION;
      const command = `newman run "${collectionPath}" --folder "${context.requestName}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
      
      console.log('[S3 Vectors Postman Flexible] Running Newman...');
      const { stdout, stderr } = await execAsync(command);
      
      // Parse results
      if (!existsSync(outputFile)) {
        console.log('[S3 Vectors Postman Flexible] Newman output:', stdout);
        if (stderr) console.error('[S3 Vectors Postman Flexible] Newman stderr:', stderr);
        throw new Error('Newman did not produce output file');
      }
      
      const result = JSON.parse(await readFile(outputFile, 'utf-8'));
      
      // Extract response
      let response = null;
      let statusCode = null;
      
      if (result.run && result.run.executions && result.run.executions.length > 0) {
        const execution = result.run.executions[0];
        if (execution.response) {
          statusCode = execution.response.code;
          if (execution.response.stream) {
            try {
              response = JSON.parse(execution.response.stream.toString());
            } catch {
              response = execution.response.stream.toString();
            }
          }
        }
      }
      
      // Check for failures
      if (result.run?.stats?.assertions?.failed > 0 || result.run?.stats?.requests?.failed > 0) {
        const errorDetails = result.run.failures?.[0]?.error?.message || 
                           result.run.failures?.[0]?.source?.response?.body ||
                           response ||
                           'Request failed';
        throw new Error(`Request failed: ${errorDetails}`);
      }
      
      return {
        success: true,
        requestName: context.requestName,
        statusCode,
        response,
        message: `Successfully executed "${context.requestName}" request`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman Flexible] Error:', error);
      return {
        success: false,
        requestName: context.requestName,
        message: `Failed to execute "${context.requestName}" request`,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Cleanup
      if (envFile && existsSync(envFile)) await unlink(envFile);
      if (outputFile && existsSync(outputFile)) await unlink(outputFile);
      if (customCollectionFile && existsSync(customCollectionFile)) await unlink(customCollectionFile);
    }
  },
});

// List available requests tool
export const s3VectorsPostmanListRequestsTool = createTool({
  id: 's3-vectors-postman-list-requests',
  description: 'List all available requests in the S3 Vectors Postman collection',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    requests: z.array(z.object({
      name: z.string(),
      method: z.string().optional(),
      url: z.string().optional(),
      description: z.string().optional(),
    })).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async () => {
    console.log('[S3 Vectors Postman List] Listing available requests...');
    
    try {
      // Check if collection exists
      if (!existsSync(POSTMAN_COLLECTION)) {
        throw new Error(`Postman collection not found at ${POSTMAN_COLLECTION}`);
      }
      
      // Read the collection
      const collectionData = JSON.parse(await readFile(POSTMAN_COLLECTION, 'utf-8'));
      
      // Extract request information
      const requests = [];
      for (const item of collectionData.item || []) {
        const request = {
          name: item.name,
          method: item.request?.method,
          url: item.request?.url?.raw || item.request?.url,
          description: item.request?.description
        };
        requests.push(request);
      }
      
      return {
        success: true,
        requests,
        message: `Found ${requests.length} requests in the Postman collection`,
      };
      
    } catch (error) {
      console.error('[S3 Vectors Postman List] Error:', error);
      return {
        success: false,
        message: 'Failed to list Postman requests',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});

