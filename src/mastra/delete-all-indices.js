#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

const BUCKET_NAME = process.env.BUCKET_NAME || 'chatbotvectors362';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

async function deleteAllIndices() {
  console.log('=== DELETE ALL S3 VECTOR INDICES ===\n');
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Region: ${AWS_REGION}\n`);
  
  try {
    // First, list all indices
    console.log('1. Fetching all indices...');
    
    const envData = {
      name: 'S3 Vectors Environment',
      values: [
        { key: 'bucketName', value: BUCKET_NAME, enabled: true },
        { key: 'region', value: AWS_REGION, enabled: true }
      ]
    };
    
    const envFile = `/tmp/newman-env-${Date.now()}.json`;
    await fs.writeFile(envFile, JSON.stringify(envData));
    
    // Create list collection
    const listCollection = {
      info: {
        name: 'List Indices',
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
              raw: '{}'
            },
            url: {
              raw: `https://s3vectors.${AWS_REGION}.api.aws/ListIndexes`,
              protocol: 'https',
              host: ['s3vectors', AWS_REGION, 'api', 'aws'],
              path: ['ListIndexes']
            }
          }
        }
      ]
    };
    
    const listCollectionFile = `/tmp/newman-list-${Date.now()}.json`;
    await fs.writeFile(listCollectionFile, JSON.stringify(listCollection));
    
    const listOutputFile = `/tmp/newman-list-output-${Date.now()}.json`;
    
    await execAsync(
      `npx newman run "${listCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${listOutputFile}" --silent`
    );
    
    const listOutput = JSON.parse(await fs.readFile(listOutputFile, 'utf8'));
    const listResponse = listOutput.run.executions[0]?.response;
    
    if (!listResponse) {
      console.log('   Failed to list indices - no response');
      return;
    }
    
    if (listResponse.code !== 200) {
      console.log(`   Failed to list indices - HTTP ${listResponse.code}`);
      if (listResponse.stream) {
        try {
          const errorData = JSON.parse(Buffer.from(listResponse.stream).toString());
          console.log('   Error:', errorData.message || 'Access denied');
        } catch {
          console.log('   Response:', Buffer.from(listResponse.stream).toString());
        }
      }
      return;
    }
    
    const indices = JSON.parse(listResponse.stream.toString());
    
    if (!indices.indices || indices.indices.length === 0) {
      console.log('   No indices found to delete');
      return;
    }
    
    console.log(`   Found ${indices.indices.length} indices to delete\n`);
    
    // Delete each index
    console.log('2. Deleting indices...\n');
    
    for (const index of indices.indices) {
      process.stdout.write(`   Deleting ${index.indexName}...`);
      
      // Create delete collection for this index
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
                  indexName: index.indexName
                })
              },
              url: {
                raw: `https://s3vectors.${AWS_REGION}.api.aws/DeleteIndex`,
                protocol: 'https',
                host: ['s3vectors', AWS_REGION, 'api', 'aws'],
                path: ['DeleteIndex']
              }
            }
          }
        ]
      };
      
      const deleteCollectionFile = `/tmp/newman-delete-${Date.now()}.json`;
      await fs.writeFile(deleteCollectionFile, JSON.stringify(deleteCollection));
      
      const deleteOutputFile = `/tmp/newman-delete-output-${Date.now()}.json`;
      
      try {
        await execAsync(
          `npx newman run "${deleteCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${deleteOutputFile}" --silent`
        );
        
        const deleteOutput = JSON.parse(await fs.readFile(deleteOutputFile, 'utf8'));
        const deleteResponse = deleteOutput.run.executions[0]?.response;
        
        if (deleteResponse && deleteResponse.code === 200) {
          console.log(' ✅');
        } else {
          console.log(' ❌');
        }
      } catch (error) {
        console.log(' ❌');
      }
      
      // Small delay between deletions
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n✅ All indices deleted!');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

deleteAllIndices().catch(console.error);