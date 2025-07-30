import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

const POSTMAN_COLLECTION = path.join(__dirname, '../postman-s3-vectors.json');
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
    const totalBatches = Math.ceil(vectors.length / batchSize);
    console.log(`[Newman Executor] Total vectors to upload: ${vectors.length} in ${totalBatches} batches`);
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
      console.log(`[Newman Executor] Created collection file for batch: ${collectionFile}`);
      
      // Run Newman for this batch
      outputFile = `/tmp/newman-output-batch-${Date.now()}.json`;
      const command = `npx newman run "${collectionFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
      console.log(`[Newman Executor] Running upload command for batch ${Math.floor(i / batchSize) + 1}/${totalBatches}`);
      
      try {
        const { stdout, stderr } = await execAsync(command);
        console.log(`[Newman Executor] Newman upload stdout:`, stdout ? stdout.substring(0, 200) : 'empty');
        if (stderr) {
          console.error(`[Newman Executor] Newman upload stderr:`, stderr);
        }
        uploaded += batch.length;
        
        const batchNum = Math.floor(i / batchSize) + 1;
        console.log(`[Newman Executor] Batch ${batchNum}/${totalBatches}: ${batch.length} vectors uploaded successfully`);
        console.log(`[Newman Executor] Progress: ${uploaded}/${vectors.length} vectors (${((uploaded / vectors.length) * 100).toFixed(1)}%)`);
        
        // Check if output file exists and read the result
        if (outputFile && existsSync(outputFile)) {
          try {
            const fs = await import('fs');
            const outputData = await fs.promises.readFile(outputFile, 'utf-8');
            const result = JSON.parse(outputData);
            
            // Check for errors in the Newman run
            const execution = result.run?.executions?.[0];
            const responseCode = execution?.response?.code || 0;
            
            if (result.run?.stats?.assertions?.failed > 0 || 
                result.run?.stats?.requests?.failed > 0 ||
                responseCode >= 400) {
              let responseBody = '';
              if (execution?.response?.stream) {
                if (Buffer.isBuffer(execution.response.stream)) {
                  responseBody = execution.response.stream.toString();
                } else if (execution.response.stream.type === 'Buffer' && Array.isArray(execution.response.stream.data)) {
                  responseBody = Buffer.from(execution.response.stream.data).toString();
                } else {
                  responseBody = JSON.stringify(execution.response.stream);
                }
              }
              console.error(`[Newman Executor] ❌ Upload FAILED for batch ${batchNum}`);
              console.error(`[Newman Executor] Response status: ${responseCode}`);
              console.error(`[Newman Executor] Failed assertions: ${result.run?.stats?.assertions?.failed}`);
              console.error(`[Newman Executor] Failed requests: ${result.run?.stats?.requests?.failed}`);
              console.error(`[Newman Executor] Error response: ${responseBody}`);
              uploaded -= batch.length; // Subtract if failed
            } else {
              // Log success details
              console.log(`[Newman Executor] ✅ Upload verified for batch ${batchNum}`);
              console.log(`[Newman Executor] Response status: ${responseCode}`);
              if (execution?.response?.stream) {
                const responseStr = execution.response.stream.toString();
                console.log(`[Newman Executor] Response preview: ${responseStr.substring(0, 200)}`);
              }
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
    
    console.log(`[Newman Executor] Upload summary: ${uploaded}/${vectors.length} vectors successfully uploaded`);
    if (uploaded < vectors.length) {
      console.error(`[Newman Executor] ⚠️ WARNING: Only ${uploaded} out of ${vectors.length} vectors were uploaded successfully`);
    }
    return uploaded;
    
  } catch (error) {
    console.error('[Newman Executor] Error uploading vectors:', error);
    return uploaded;
  } finally {
    if (envFile && existsSync(envFile)) await unlink(envFile);
  }
}

// List indices using Newman and Postman collection
export async function listIndicesWithNewman(): Promise<string[]> {
  console.log('[Newman List] Starting listIndicesWithNewman...');
  
  const collectionFile = POSTMAN_COLLECTION;
  const outputFile = './newman-list-output.json';
  let envFile: string | null = null;
  
  console.log('[Newman List] Collection file:', collectionFile);
  console.log('[Newman List] Collection exists?', existsSync(collectionFile));
  
  try {
    const bucketName = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
    const region = process.env.S3_VECTORS_REGION || 'us-east-2';
    
    // Create environment file (same approach as uploadVectorsWithNewman)
    const envData = {
      values: [
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID || '' },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY || '' },
        { key: 'AWS_REGION', value: region },
        { key: 'BUCKET_NAME', value: bucketName }
      ]
    };
    
    envFile = `/tmp/newman-list-env-${Date.now()}.json`;
    await fs.writeFile(envFile, JSON.stringify(envData));
    console.log('[Newman List] Created environment file:', envFile);
    console.log('[Newman List] Environment data:', JSON.stringify(envData, null, 2));
    
    // Log credential status
    console.log('[Newman List] Credential check:');
    console.log('[Newman List] - AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `${process.env.AWS_ACCESS_KEY_ID.substring(0, 10)}...` : 'NOT SET');
    console.log('[Newman List] - AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET');
    
    // Use environment file instead of --env-var
    const command = `npx newman run "${collectionFile}" --environment "${envFile}" --folder "List All Indexes" --reporters cli,json --reporter-json-export "${outputFile}"`;
    
    console.log('[Newman List] Running command with environment file...');
    
    const { stdout, stderr } = await execAsync(command);
    
    console.log('[Newman List] Command completed');
    
    if (stderr) {
      console.log('[Newman List] Stderr output:', stderr);
    }
    
    if (stdout) {
      console.log('[Newman List] Stdout preview:', stdout.substring(0, 500));
    }
    
    // Parse the output
    if (existsSync(outputFile)) {
      console.log('[Newman List] Reading output file...');
      const outputContent = await fs.readFile(outputFile, 'utf-8');
      console.log('[Newman List] Output file size:', outputContent.length, 'bytes');
      
      const output = JSON.parse(outputContent);
      console.log('[Newman List] Newman run stats:', {
        totalRequests: output.run?.stats?.requests?.total,
        failedRequests: output.run?.stats?.requests?.failed,
        totalAssertions: output.run?.stats?.assertions?.total,
        failedAssertions: output.run?.stats?.assertions?.failed
      });
      
      console.log('[Newman List] Total executions:', output.run?.executions?.length || 0);
      
      const listExecution = output.run?.executions?.find((exec: any) => 
        exec.item?.name?.includes('List All Indexes')
      );
      
      console.log('[Newman List] Found List All Indexes execution:', !!listExecution);
      
      if (listExecution) {
        console.log('[Newman List] Response status:', listExecution.response?.code);
        console.log('[Newman List] Response status text:', listExecution.response?.status);
        
        if (listExecution.response?.stream) {
          // Handle different types of stream data
          let responseBody: string;
          if (Buffer.isBuffer(listExecution.response.stream)) {
            responseBody = listExecution.response.stream.toString();
          } else if (typeof listExecution.response.stream === 'object') {
            // Check if it's a buffer-like object with type and data
            if (listExecution.response.stream.type === 'Buffer' && Array.isArray(listExecution.response.stream.data)) {
              console.log('[Newman List] Stream is a Buffer object, converting from data array...');
              const buffer = Buffer.from(listExecution.response.stream.data);
              responseBody = buffer.toString();
            } else {
              console.log('[Newman List] Stream is already an object:', listExecution.response.stream);
              responseBody = JSON.stringify(listExecution.response.stream);
            }
          } else {
            responseBody = String(listExecution.response.stream);
          }
          
          console.log('[Newman List] Response body length:', responseBody.length);
          console.log('[Newman List] Response body preview:', responseBody.substring(0, 200));
          
          try {
            const response = JSON.parse(responseBody);
            console.log('[Newman List] Parsed response keys:', Object.keys(response));
            
            if (response.indexes && Array.isArray(response.indexes)) {
              console.log('[Newman List] ✅ Found', response.indexes.length, 'indices');
              const indexNames = response.indexes.map((idx: any) => idx.indexName);
              console.log('[Newman List] Index names:', indexNames);
              
              // Log details of first few indices
              response.indexes.slice(0, 3).forEach((idx: any, i: number) => {
                console.log(`[Newman List] Index ${i + 1}:`, JSON.stringify(idx, null, 2));
              });
              
              await fs.unlink(outputFile);
              if (envFile && existsSync(envFile)) await fs.unlink(envFile);
              return indexNames;
            } else {
              console.log('[Newman List] ⚠️ No indexes array in response');
              console.log('[Newman List] Full response:', JSON.stringify(response, null, 2));
            }
          } catch (parseError) {
            console.error('[Newman List] Error parsing response body:', parseError);
            console.log('[Newman List] Raw response body:', responseBody);
          }
        } else {
          console.log('[Newman List] ⚠️ No response stream found');
          console.log('[Newman List] Response object:', JSON.stringify(listExecution.response, null, 2));
        }
      } else {
        console.log('[Newman List] ⚠️ List All Indexes execution not found');
        console.log('[Newman List] Available executions:', 
          output.run?.executions?.map((e: any) => e.item?.name) || []
        );
      }
      
      await fs.unlink(outputFile);
    } else {
      console.log('[Newman List] ⚠️ Output file does not exist');
    }
    
    console.log('[Newman List] Returning empty array (no indices found)');
    
    // Log environment variable status for debugging
    console.log('[Newman List] Environment check:');
    console.log('[Newman List] - AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `Set (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : 'NOT SET');
    console.log('[Newman List] - AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'NOT SET');
    console.log('[Newman List] - S3_VECTORS_BUCKET:', process.env.S3_VECTORS_BUCKET || 'chatbotvectors362');
    console.log('[Newman List] - S3_VECTORS_REGION:', process.env.S3_VECTORS_REGION || 'us-east-2');
    
    return [];
    
  } catch (error) {
    console.error('[Newman List] Error listing indices:', error);
    return [];
  } finally {
    try {
      if (existsSync(outputFile)) await fs.unlink(outputFile);
      if (envFile && existsSync(envFile)) await fs.unlink(envFile);
    } catch (cleanupError) {
      console.error('[Newman List] Cleanup error:', cleanupError);
    }
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
  console.log(`[Newman Query] Received queryVector first 5: [${queryVector.slice(0, 5).map(v => v.toFixed(6)).join(', ')}...]`);
  
  const collectionFile = './postman-s3-vectors.json';
  const envFile = './postman-s3-vectors-env-temp.json';
  const outputFile = './newman-query-output.json';
  
  try {
    // Create environment file with query parameters matching Postman collection
    const envData = {
      values: [
        { key: 'BUCKET_NAME', value: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362' },
        { key: 'AWS_REGION', value: process.env.S3_VECTORS_REGION || 'us-east-2' },
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID || '' },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY || '' },
        { key: 'INDEX_NAME', value: indexName }
      ]
    };
    
    await fs.writeFile(envFile, JSON.stringify(envData, null, 2));
    
    // Create a custom request file with our actual query vector
    const requestFile = './postman-query-request-temp.json';
    const customRequest = {
      collection: {
        info: { name: "Query Request" },
        auth: {
          type: "awsv4",
          awsv4: [
            { key: "accessKey", value: "{{AWS_ACCESS_KEY_ID}}", type: "string" },
            { key: "secretKey", value: "{{AWS_SECRET_ACCESS_KEY}}", type: "string" },
            { key: "region", value: "{{AWS_REGION}}", type: "string" },
            { key: "service", value: "s3vectors", type: "string" }
          ]
        },
        item: [{
          name: "Query Vectors",
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                vectorBucketName: "{{BUCKET_NAME}}",
                indexName: "{{INDEX_NAME}}",
                queryVector: {
                  float32: queryVector
                },
                topK: topK,
                returnMetadata: true,
                returnValues: true,
                returnDistance: true
              })
            },
            url: {
              raw: "https://s3vectors.{{AWS_REGION}}.api.aws/QueryVectors",
              protocol: "https",
              host: ["s3vectors", "{{AWS_REGION}}", "api", "aws"],
              path: ["QueryVectors"]
            }
          }
        }]
      }
    };
    
    await fs.writeFile(requestFile, JSON.stringify(customRequest, null, 2));
    
    // Run Newman with our custom request
    const command = `npx newman run "${requestFile}" --environment "${envFile}" --reporters cli,json --reporter-json-export "${outputFile}"`;
    
    console.log('[Newman Query] Executing query command with custom request...');
    console.log(`[Newman Query] Vector length in request: ${queryVector.length}`);
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
        exec.item?.name === 'Query Vectors with Metadata' || 
        exec.item?.name === 'Query Vectors with Filter' ||
        exec.item?.name?.toLowerCase().includes('query')
      );
      
      console.log('[Newman Query] Found execution:', !!queryExecution);
      console.log('[Newman Query] Available requests:', output.run?.executions?.map((e: any) => e.item?.name));
      
      if (queryExecution?.response?.stream) {
        // Handle different types of stream data (same as listIndices)
        let responseBody: string;
        if (Buffer.isBuffer(queryExecution.response.stream)) {
          responseBody = queryExecution.response.stream.toString();
        } else if (typeof queryExecution.response.stream === 'object') {
          // Check if it's a buffer-like object with type and data
          if (queryExecution.response.stream.type === 'Buffer' && Array.isArray(queryExecution.response.stream.data)) {
            console.log('[Newman Query] Stream is a Buffer object, converting from data array...');
            const buffer = Buffer.from(queryExecution.response.stream.data);
            responseBody = buffer.toString();
          } else {
            console.log('[Newman Query] Stream is already an object:', queryExecution.response.stream);
            responseBody = JSON.stringify(queryExecution.response.stream);
          }
        } else {
          responseBody = String(queryExecution.response.stream);
        }
        
        console.log('[Newman Query] Response body preview:', responseBody.substring(0, 200));
        
        try {
          const response = JSON.parse(responseBody);
          
          if (response.vectors && Array.isArray(response.vectors)) {
            console.log(`[Newman Query] ✅ SUCCESS: Found ${response.vectors.length} similar vectors`);
            if (response.vectors.length > 0) {
              const firstVector = response.vectors[0];
              console.log('[Newman Query] First result:', {
                key: firstVector.key,
                distance: firstVector.distance,
                hasMetadata: !!firstVector.metadata,
                metadataKeys: firstVector.metadata ? Object.keys(firstVector.metadata) : [],
                allFields: Object.keys(firstVector)
              });
              // Log a preview of the metadata
              if (firstVector.metadata) {
                console.log('[Newman Query] Metadata preview:', {
                  content: firstVector.metadata.content ? firstVector.metadata.content.substring(0, 100) + '...' : 'N/A',
                  documentId: firstVector.metadata.documentId || 'N/A',
                  chunkIndex: firstVector.metadata.chunkIndex,
                  pageStart: firstVector.metadata.pageStart
                });
              }
            }
            return response.vectors;
          } else {
            console.log('[Newman Query] ⚠️ No vectors found in response');
            console.log('[Newman Query] Response structure:', Object.keys(response));
            console.log('[Newman Query] Full response:', JSON.stringify(response, null, 2));
          }
        } catch (parseError) {
          console.error('[Newman Query] Error parsing response:', parseError);
          console.log('[Newman Query] Raw response:', responseBody);
        }
      } else {
        console.log('[Newman Query] No response stream found');
        if (queryExecution) {
          console.log('[Newman Query] Execution details:', JSON.stringify(queryExecution, null, 2).substring(0, 500));
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
      if (existsSync('./postman-query-request-temp.json')) await fs.unlink('./postman-query-request-temp.json');
    } catch (cleanupError) {
      console.error('[Newman Query] Cleanup error:', cleanupError);
    }
  }
}