import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const POSTMAN_COLLECTION = '/home/bkngu/Claude/s3-vectors/postman-s3-vectors-working.json';
const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

export async function createIndexWithNewman(indexName: string, dimension: number = 1536): Promise<boolean> {
  console.log(`[Newman Executor] Creating index '${indexName}' with dimension ${dimension}`);
  
  let envFile: string | null = null;
  let outputFile: string | null = null;
  
  try {
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
    
    const collectionFile = `/tmp/newman-collection-${Date.now()}.json`;
    await writeFile(collectionFile, JSON.stringify(customCollection));
    
    // Run Newman
    outputFile = `/tmp/newman-output-${Date.now()}.json`;
    const command = `newman run "${collectionFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
    
    const { stdout, stderr } = await execAsync(command);
    
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
    return false;
  } finally {
    if (envFile && existsSync(envFile)) await unlink(envFile);
    if (outputFile && existsSync(outputFile)) await unlink(outputFile);
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
    
    // Process in batches
    const batchSize = 10;
    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      
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
      const command = `newman run "${collectionFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
      
      try {
        await execAsync(command);
        uploaded += batch.length;
        
        console.log(`[Newman Executor] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectors.length / batchSize)}: ${batch.length} vectors uploaded`);
      } catch (error) {
        console.error(`[Newman Executor] Error uploading batch:`, error);
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