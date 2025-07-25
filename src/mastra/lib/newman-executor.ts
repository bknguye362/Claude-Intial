import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

const POSTMAN_COLLECTION = './postman-s3-vectors.json';
const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

export async function createIndexWithNewman(indexName: string, dimension: number = 1536): Promise<boolean> {
  console.log(`[Newman Executor] Creating index '${indexName}' with dimension ${dimension}`);
  console.log(`[Newman Executor] Current working directory: ${process.cwd()}`);
  console.log(`[Newman Executor] Postman collection path: ${POSTMAN_COLLECTION}`);
  console.log(`[Newman Executor] Collection exists: ${existsSync(POSTMAN_COLLECTION)}`);
  
  // Check if Newman is available
  try {
    const { stdout: newmanVersion } = await execAsync('newman --version');
    console.log(`[Newman Executor] Newman version: ${newmanVersion.trim()}`);
  } catch (e) {
    console.error('[Newman Executor] Newman not found in PATH:', e);
    console.log('[Newman Executor] Trying npx newman...');
  }
  
  let envFile: string | null = null;
  let outputFile: string | null = null;
  let collectionFile: string | null = null;
  
  try {
    // Log AWS credentials (safely)
    console.log(`[Newman Executor] AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? 'Set (ends with ...' + process.env.AWS_ACCESS_KEY_ID.slice(-4) + ')' : 'NOT SET'}`);
    console.log(`[Newman Executor] AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`[Newman Executor] AWS_REGION: ${REGION}`);
    console.log(`[Newman Executor] BUCKET_NAME: ${BUCKET_NAME}`);
    
    // Create environment file
    const envData = {
      values: [
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
        { key: 'AWS_REGION', value: REGION },
        { key: 'BUCKET_NAME', value: BUCKET_NAME },
        { key: 'INDEX_NAME', value: indexName }
      ]
    };
    
    envFile = `/tmp/newman-env-${Date.now()}.json`;
    await writeFile(envFile, JSON.stringify(envData));
    console.log(`[Newman Executor] Created environment file: ${envFile}`);
    
    // Create custom collection with the specific request body
    const customCollection = {
      info: {
        name: 'Create Index',
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
        name: 'Create Index',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: {
            mode: 'raw',
            raw: JSON.stringify({
              vectorBucketName: BUCKET_NAME,
              indexName: indexName,
              dimension: dimension,
              distanceMetric: 'cosine',
              dataType: 'float32'
            })
          },
          url: {
            raw: `https://s3vectors.${REGION}.api.aws/CreateIndex`,
            protocol: 'https',
            host: ['s3vectors', REGION, 'api', 'aws'],
            path: ['CreateIndex']
          }
        }
      }]
    };
    
    collectionFile = `/tmp/newman-collection-${Date.now()}.json`;
    await writeFile(collectionFile, JSON.stringify(customCollection));
    console.log(`[Newman Executor] Created collection file: ${collectionFile}`);
    
    // Run Newman
    outputFile = `/tmp/newman-output-${Date.now()}.json`;
    const command = `npx newman run "${collectionFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
    console.log(`[Newman Executor] Running command: ${command}`);
    
    const { stdout, stderr } = await execAsync(command);
    console.log(`[Newman Executor] Newman stdout:`, stdout);
    if (stderr) console.log(`[Newman Executor] Newman stderr:`, stderr);
    
    // Check results
    if (outputFile && existsSync(outputFile)) {
      const fs = await import('fs');
      const resultData = await fs.promises.readFile(outputFile, 'utf-8');
      const result = JSON.parse(resultData);
      if (result.run?.stats?.assertions?.failed > 0 || result.run?.stats?.requests?.failed > 0) {
        // Check if it's "already exists" error
        const response = result.run?.executions?.[0]?.response?.stream?.toString() || '';
        if (response.includes('AlreadyExistsException')) {
          console.log(`[Newman Executor] Index '${indexName}' already exists`);
          return true;
        }
        throw new Error(`Failed to create index: ${response}`);
      }
    }
    
    console.log(`[Newman Executor] Successfully created index '${indexName}'`);
    await unlink(collectionFile);
    return true;
    
  } catch (error) {
    console.error('[Newman Executor] Error creating index:', error);
    console.error('[Newman Executor] Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('[Newman Executor] Error message:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('[Newman Executor] Stack trace:', error.stack);
    }
    // Try to read any output file for more details
    if (outputFile && existsSync(outputFile)) {
      try {
        const fs = await import('fs');
        const output = await fs.promises.readFile(outputFile, 'utf-8');
        console.error('[Newman Executor] Newman output file:', output);
      } catch (e) {
        console.error('[Newman Executor] Could not read output file');
      }
    }
    return false;
  } finally {
    if (envFile && existsSync(envFile)) await unlink(envFile);
    if (outputFile && existsSync(outputFile)) await unlink(outputFile);
    if (collectionFile && existsSync(collectionFile)) await unlink(collectionFile);
  }
}

export async function uploadVectorsWithNewman(
  indexName: string, 
  vectors: Array<{
    key: string;
    embedding: number[];
    metadata: Record<string, any>;
  }>
): Promise<number> {
  console.log(`[Newman Executor] Uploading ${vectors.length} vectors to index '${indexName}'`);
  
  let envFile: string | null = null;
  let outputFile: string | null = null;
  let uploaded = 0;
  
  try {
    // Log AWS credentials (safely)
    console.log(`[Newman Executor] AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? 'Set (ends with ...' + process.env.AWS_ACCESS_KEY_ID.slice(-4) + ')' : 'NOT SET'}`);
    console.log(`[Newman Executor] AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`[Newman Executor] AWS_REGION: ${REGION}`);
    console.log(`[Newman Executor] BUCKET_NAME: ${BUCKET_NAME}`);
    
    // Create environment file
    const envData = {
      values: [
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
        { key: 'AWS_REGION', value: REGION },
        { key: 'BUCKET_NAME', value: BUCKET_NAME },
        { key: 'INDEX_NAME', value: indexName }
      ]
    };
    
    envFile = `/tmp/newman-env-${Date.now()}.json`;
    await writeFile(envFile, JSON.stringify(envData));
    console.log(`[Newman Executor] Created environment file: ${envFile}`);
    
    // Process in batches
    const batchSize = 10;
    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      
      // Log the vector format for debugging
      if (i === 0) { // Only log first batch
        console.log(`[Newman Executor] Sample vector format:`, JSON.stringify({
          key: batch[0].key,
          data: { float32: batch[0].embedding.slice(0, 5) }, // Just first 5 values
          metadata: batch[0].metadata
        }, null, 2));
      }
      
      // Create custom collection for this batch
      const customCollection = {
        info: {
          name: 'Put Vectors',
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
          name: 'Put Vectors with Metadata',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                vectorBucketName: BUCKET_NAME,
                indexName: indexName,
                vectors: batch.map(v => ({
                  key: v.key,
                  data: { float32: v.embedding },
                  metadata: v.metadata
                }))
              })
            },
            url: {
              raw: `https://s3vectors.${REGION}.api.aws/PutVectors`,
              protocol: 'https',
              host: ['s3vectors', REGION, 'api', 'aws'],
              path: ['PutVectors']
            }
          }
        }]
      };
      
      const collectionFile = `/tmp/newman-collection-batch-${Date.now()}.json`;
      await writeFile(collectionFile, JSON.stringify(customCollection));
      
      // Run Newman for this batch
      outputFile = `/tmp/newman-output-batch-${Date.now()}.json`;
      const command = `npx newman run "${collectionFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
      
      try {
        const { stdout, stderr } = await execAsync(command);
        uploaded += batch.length;
        
        console.log(`[Newman Executor] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectors.length / batchSize)}: ${batch.length} vectors uploaded`);
        
        // Check if output file exists and read the result
        if (outputFile && existsSync(outputFile)) {
          try {
            const fs = await import('fs');
            const outputData = await fs.promises.readFile(outputFile, 'utf-8');
            const result = JSON.parse(outputData);
            
            // Check for errors in the Newman run
            if (result.run?.stats?.assertions?.failed > 0 || result.run?.stats?.requests?.failed > 0) {
              const response = result.run?.executions?.[0]?.response?.stream?.toString() || '';
              console.error(`[Newman Executor] Upload may have failed. Response: ${response}`);
              uploaded -= batch.length; // Subtract if failed
            }
          } catch (readError) {
            console.error(`[Newman Executor] Could not read output file:`, readError);
          }
        }
      } catch (error) {
        console.error(`[Newman Executor] Error uploading batch:`, error);
        // Don't count this batch as uploaded
      } finally {
        await unlink(collectionFile);
        if (outputFile && existsSync(outputFile)) await unlink(outputFile);
      }
    }
    
    return uploaded;
    
  } catch (error) {
    console.error('[Newman Executor] Error uploading vectors:', error);
    return uploaded;
  } finally {
    if (envFile && existsSync(envFile)) await unlink(envFile);
  }
}

// Query vectors using Newman and Postman collection
export async function queryVectorsWithNewman(
  indexName: string,
  queryVector: number[],
  topK: number = 10
): Promise<any[]> {
  console.log('[Newman Query] ========= QUERY VECTORS FUNCTION CALLED =========');
  console.log(`[Newman Query] Index: ${indexName}`);
  console.log(`[Newman Query] Query vector length: ${queryVector.length}`);
  console.log(`[Newman Query] Top K: ${topK}`);
  console.log(`[Newman Query] First 5 vector values: [${queryVector.slice(0, 5).join(', ')}...]`);
  
  const collectionFile = './postman/s3-vectors-collection.json';
  const envFile = './postman/s3-vectors-env-temp.json';
  const outputFile = './postman/newman-query-output.json';
  
  try {
    // Create environment file with query parameters
    const envData = {
      values: [
        { key: 'bucketName', value: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362' },
        { key: 'region', value: process.env.S3_VECTORS_REGION || 'us-east-2' },
        { key: 'awsAccessKeyId', value: process.env.AWS_ACCESS_KEY_ID || '' },
        { key: 'awsSecretAccessKey', value: process.env.AWS_SECRET_ACCESS_KEY || '' },
        { key: 'currentIndexName', value: indexName },
        { key: 'currentQueryVector', value: JSON.stringify(queryVector) },
        { key: 'currentTopK', value: topK.toString() }
      ]
    };
    
    await fs.writeFile(envFile, JSON.stringify(envData, null, 2));
    
    // Run Newman with the Query Vectors request
    const command = `npx newman run "${collectionFile}" --environment "${envFile}" --folder "Query Vectors" --reporters cli,json --reporter-json-export "${outputFile}"`;
    
    console.log('[Newman Query] Executing query command...');
    console.log(`[Newman Query] Command: ${command}`);
    
    const { stdout, stderr } = await execAsync(command);
    
    console.log('[Newman Query] Command executed successfully');
    
    if (stderr && !stderr.includes('Newman v')) {
      console.error('[Newman Query] Error output:', stderr);
    }
    
    // Log part of stdout for debugging
    if (stdout) {
      console.log('[Newman Query] Newman output preview:', stdout.substring(0, 500));
    }
    
    // Parse the output to get results
    if (existsSync(outputFile)) {
      const output = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
      
      // Find the Query Vectors request execution
      const queryExecution = output.run?.executions?.find((exec: any) => 
        exec.item?.name === 'Query Vectors' || 
        exec.item?.name === 'Query Vectors with Filter'
      );
      
      if (queryExecution?.response?.stream) {
        const responseBody = queryExecution.response.stream.toString();
        const response = JSON.parse(responseBody);
        
        if (response.vectors && Array.isArray(response.vectors)) {
          console.log(`[Newman Query] ✅ SUCCESS: Found ${response.vectors.length} similar vectors`);
          console.log('[Newman Query] First result:', JSON.stringify(response.vectors[0], null, 2));
          return response.vectors;
        } else {
          console.log('[Newman Query] ⚠️ No vectors found in response');
          console.log('[Newman Query] Response structure:', Object.keys(response));
        }
      }
      
      // Clean up output file
      await fs.unlink(outputFile);
    }
    
    return [];
    
  } catch (error) {
    console.error('[Newman Query] Error querying vectors:', error);
    return [];
  } finally {
    // Clean up temp files
    try {
      if (existsSync(envFile)) await fs.unlink(envFile);
      if (existsSync(outputFile)) await fs.unlink(outputFile);
    } catch (cleanupError) {
      console.error('[Newman Query] Cleanup error:', cleanupError);
    }
  }
}