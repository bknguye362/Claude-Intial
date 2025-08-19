#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUCKET_NAME = process.env.BUCKET_NAME || 'chatbotvectors362';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

async function listAllIndices() {
  console.log('=== S3 Vectors Index Management ===\n');
  console.log('1. Listing all indices...');
  
  try {
    // Create Newman environment
    const envData = {
      name: 'S3 Vectors Environment',
      values: [
        { key: 'bucketName', value: BUCKET_NAME, enabled: true },
        { key: 'region', value: AWS_REGION, enabled: true },
        { key: 'indexName', value: 'dummy', enabled: true }
      ]
    };
    
    const envFile = `/tmp/newman-env-${Date.now()}.json`;
    await fs.writeFile(envFile, JSON.stringify(envData));
    
    // Create a custom collection for listing indices
    const listCollection = {
      info: {
        name: 'List All Indices',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: [
        {
          name: 'List Indices',
          request: {
            method: 'POST',
            header: [],
            body: {
              mode: 'raw',
              raw: JSON.stringify({})
            },
            url: {
              raw: `https://s3vectors.{{region}}.api.aws/ListIndices`,
              protocol: 'https',
              host: ['s3vectors', '{{region}}', 'api', 'aws'],
              path: ['ListIndices']
            }
          }
        }
      ]
    };
    
    const collectionFile = `/tmp/newman-collection-list-${Date.now()}.json`;
    await fs.writeFile(collectionFile, JSON.stringify(listCollection));
    
    // Run Newman to list indices
    const outputFile = `/tmp/newman-output-${Date.now()}.json`;
    const { stdout } = await execAsync(
      `npx newman run "${collectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${outputFile}" --silent`
    );
    
    // Parse the output
    const output = JSON.parse(await fs.readFile(outputFile, 'utf8'));
    const response = output.run.executions[0]?.response;
    
    if (response && response.code === 200) {
      const indices = JSON.parse(response.stream.toString());
      
      if (indices.indices && indices.indices.length > 0) {
        console.log(`   Found ${indices.indices.length} indices:`);
        indices.indices.forEach(index => {
          console.log(`   - ${index.indexName} (dimension: ${index.dimension}, vectors: ${index.vectorCount || 0})`);
        });
        return indices.indices;
      } else {
        console.log('   No indices found in bucket');
        return [];
      }
    } else {
      console.log('   Failed to list indices');
      return [];
    }
    
  } catch (error) {
    console.error('Error listing indices:', error.message);
    return [];
  }
}

async function deleteIndex(indexName) {
  try {
    const envData = {
      name: 'S3 Vectors Environment',
      values: [
        { key: 'bucketName', value: BUCKET_NAME, enabled: true },
        { key: 'region', value: AWS_REGION, enabled: true },
        { key: 'indexName', value: indexName, enabled: true }
      ]
    };
    
    const envFile = `/tmp/newman-env-delete-${Date.now()}.json`;
    await fs.writeFile(envFile, JSON.stringify(envData));
    
    // Create delete collection
    const deleteCollection = {
      info: {
        name: 'Delete Index',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: [
        {
          name: 'Delete Index',
          request: {
            method: 'POST',
            header: [],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                indexName: indexName
              })
            },
            url: {
              raw: `https://s3vectors.{{region}}.api.aws/DeleteIndex`,
              protocol: 'https',
              host: ['s3vectors', '{{region}}', 'api', 'aws'],
              path: ['DeleteIndex']
            }
          }
        }
      ]
    };
    
    const collectionFile = `/tmp/newman-collection-delete-${Date.now()}.json`;
    await fs.writeFile(collectionFile, JSON.stringify(deleteCollection));
    
    const outputFile = `/tmp/newman-output-delete-${Date.now()}.json`;
    await execAsync(
      `npx newman run "${collectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${outputFile}" --silent`
    );
    
    const output = JSON.parse(await fs.readFile(outputFile, 'utf8'));
    const response = output.run.executions[0]?.response;
    
    if (response && response.code === 200) {
      return true;
    }
    return false;
    
  } catch (error) {
    console.error(`Error deleting index ${indexName}:`, error.message);
    return false;
  }
}

async function clearAllIndices() {
  console.log('\n=== CLEAR ALL S3 VECTOR INDICES ===\n');
  
  // List all indices
  const indices = await listAllIndices();
  
  if (indices.length === 0) {
    console.log('\nNo indices to delete.');
    return;
  }
  
  console.log('\n⚠️  WARNING: This will delete ALL indices and their vectors!');
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log('2. Deleting all indices...\n');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const index of indices) {
    process.stdout.write(`   Deleting ${index.indexName}...`);
    const success = await deleteIndex(index.indexName);
    
    if (success) {
      console.log(' ✅');
      successCount++;
    } else {
      console.log(' ❌');
      failCount++;
    }
    
    // Small delay between deletions
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n=== DELETION COMPLETE ===');
  console.log(`   Deleted: ${successCount} indices`);
  if (failCount > 0) {
    console.log(`   Failed: ${failCount} indices`);
  }
  
  // Verify deletion
  console.log('\n3. Verifying deletion...');
  const remainingIndices = await listAllIndices();
  
  if (remainingIndices.length === 0) {
    console.log('   ✅ All indices successfully deleted!');
  } else {
    console.log(`   ⚠️  ${remainingIndices.length} indices still remain`);
  }
}

// Also export functions for programmatic use
export { listAllIndices, deleteIndex };

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  clearAllIndices().catch(console.error);
}