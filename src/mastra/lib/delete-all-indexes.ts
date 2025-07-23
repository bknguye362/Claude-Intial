import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const POSTMAN_COLLECTION = './postman-s3-vectors.json';
const BUCKET_NAME = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
const REGION = process.env.S3_VECTORS_REGION || 'us-east-2';

export async function deleteAllIndexesWithNewman(): Promise<{ deleted: string[], failed: string[], total: number }> {
  console.log(`[Delete All Indexes] Starting bulk delete operation for bucket: ${BUCKET_NAME}`);
  
  let envFile: string | null = null;
  const deleted: string[] = [];
  const failed: string[] = [];
  
  try {
    // Create environment file for Newman
    const envData = {
      values: [
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
        { key: 'AWS_REGION', value: REGION },
        { key: 'BUCKET_NAME', value: BUCKET_NAME },
        { key: 'INDEX_NAME', value: 'placeholder' } // Will be replaced for each index
      ]
    };
    
    envFile = `/tmp/newman-env-delete-all-${Date.now()}.json`;
    await writeFile(envFile, JSON.stringify(envData));
    
    // First, list all indexes using Newman
    console.log(`[Delete All Indexes] Listing all indexes...`);
    
    const listCollection = {
      info: {
        name: 'List All Indexes',
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
        name: 'List Indexes',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: {
            mode: 'raw',
            raw: JSON.stringify({
              vectorBucketName: BUCKET_NAME
            })
          },
          url: {
            raw: `https://s3vectors.${REGION}.api.aws/ListIndexes`,
            protocol: 'https',
            host: ['s3vectors', REGION, 'api', 'aws'],
            path: ['ListIndexes']
          }
        }
      }]
    };
    
    const listCollectionFile = `/tmp/newman-list-collection-${Date.now()}.json`;
    await writeFile(listCollectionFile, JSON.stringify(listCollection));
    
    const listOutputFile = `/tmp/newman-list-output-${Date.now()}.json`;
    const listCommand = `npx newman run "${listCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${listOutputFile}"`;
    
    let indexes: string[] = [];
    
    try {
      await execAsync(listCommand);
      
      if (existsSync(listOutputFile)) {
        const outputData = await import('fs').then(fs => fs.promises.readFile(listOutputFile, 'utf-8'));
        const output = JSON.parse(outputData);
        
        // Extract index names from the response
        const response = output.run?.executions?.[0]?.response;
        if (response && response.stream) {
          const responseBody = JSON.parse(response.stream.toString());
          if (responseBody.indexes) {
            indexes = responseBody.indexes.map((idx: any) => idx.indexName);
            console.log(`[Delete All Indexes] Found ${indexes.length} indexes to delete:`, indexes);
          }
        }
      }
    } catch (error) {
      console.error('[Delete All Indexes] Error listing indexes:', error);
      throw new Error('Failed to list indexes');
    } finally {
      if (existsSync(listCollectionFile)) await unlink(listCollectionFile);
      if (existsSync(listOutputFile)) await unlink(listOutputFile);
    }
    
    if (indexes.length === 0) {
      console.log('[Delete All Indexes] No indexes found to delete');
      return { deleted: [], failed: [], total: 0 };
    }
    
    // Confirm before deletion (in production, you might want to add a safety check)
    console.log(`[Delete All Indexes] Preparing to delete ${indexes.length} indexes...`);
    
    // Delete each index
    for (const indexName of indexes) {
      console.log(`[Delete All Indexes] Deleting index: ${indexName}`);
      
      const deleteCollection = {
        info: {
          name: 'Delete Index',
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
          name: 'Delete Index',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                vectorBucketName: BUCKET_NAME,
                indexName: indexName
              })
            },
            url: {
              raw: `https://s3vectors.${REGION}.api.aws/DeleteIndex`,
              protocol: 'https',
              host: ['s3vectors', REGION, 'api', 'aws'],
              path: ['DeleteIndex']
            }
          }
        }]
      };
      
      const deleteCollectionFile = `/tmp/newman-delete-collection-${Date.now()}.json`;
      await writeFile(deleteCollectionFile, JSON.stringify(deleteCollection));
      
      try {
        const deleteCommand = `npx newman run "${deleteCollectionFile}" --environment "${envFile}" --reporters cli`;
        await execAsync(deleteCommand);
        deleted.push(indexName);
        console.log(`[Delete All Indexes] ✓ Deleted: ${indexName}`);
      } catch (error) {
        failed.push(indexName);
        console.error(`[Delete All Indexes] ✗ Failed to delete: ${indexName}`, error);
      } finally {
        if (existsSync(deleteCollectionFile)) await unlink(deleteCollectionFile);
      }
      
      // Small delay between deletions to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`[Delete All Indexes] Operation complete. Deleted: ${deleted.length}, Failed: ${failed.length}`);
    
    return {
      deleted,
      failed,
      total: indexes.length
    };
    
  } catch (error) {
    console.error('[Delete All Indexes] Fatal error:', error);
    throw error;
  } finally {
    if (envFile && existsSync(envFile)) await unlink(envFile);
  }
}