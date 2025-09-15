#!/usr/bin/env node

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, ListDataSourcesCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';

const s3Client = new S3Client({
  region: 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const bedrockClient = new BedrockAgentClient({
  region: 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = 'chatbotvectors362';
const KNOWLEDGE_BASE_ID = 'FQ7HMGJHKP';

async function deleteS3Files() {
  console.log('=== Deleting S3 Files from Bedrock Data Source ===\n');
  
  let deletedCount = 0;
  let continuationToken;
  
  do {
    // List objects in bedrock-chunks/
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'bedrock-chunks/',
      ContinuationToken: continuationToken
    });
    
    const listResponse = await s3Client.send(listCommand);
    
    if (listResponse.Contents && listResponse.Contents.length > 0) {
      // Prepare delete request
      const deleteObjects = listResponse.Contents.map(obj => ({ Key: obj.Key }));
      
      console.log(`Deleting batch of ${deleteObjects.length} files...`);
      
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: deleteObjects,
          Quiet: false
        }
      });
      
      const deleteResponse = await s3Client.send(deleteCommand);
      
      if (deleteResponse.Deleted) {
        deletedCount += deleteResponse.Deleted.length;
        console.log(`  ✓ Deleted ${deleteResponse.Deleted.length} files`);
      }
      
      if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
        console.log(`  ⚠ ${deleteResponse.Errors.length} errors occurred:`);
        deleteResponse.Errors.forEach(err => {
          console.log(`    - ${err.Key}: ${err.Message}`);
        });
      }
    }
    
    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);
  
  console.log(`\n✅ Total files deleted: ${deletedCount}`);
  return deletedCount;
}

async function syncBedrockKnowledgeBase() {
  console.log('\n=== Syncing Bedrock Knowledge Base ===\n');
  
  try {
    // List data sources
    const listCommand = new ListDataSourcesCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID
    });
    
    const listResponse = await bedrockClient.send(listCommand);
    
    if (!listResponse.dataSourceSummaries || listResponse.dataSourceSummaries.length === 0) {
      console.log('No data sources found for this knowledge base.');
      return;
    }
    
    console.log(`Found ${listResponse.dataSourceSummaries.length} data source(s)\n`);
    
    // Start ingestion job for each data source
    for (const dataSource of listResponse.dataSourceSummaries) {
      console.log(`Starting sync for data source: ${dataSource.name} (${dataSource.dataSourceId})`);
      
      try {
        const syncCommand = new StartIngestionJobCommand({
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          dataSourceId: dataSource.dataSourceId
        });
        
        const syncResponse = await bedrockClient.send(syncCommand);
        
        if (syncResponse.ingestionJob) {
          console.log(`  ✓ Ingestion job started: ${syncResponse.ingestionJob.ingestionJobId}`);
          console.log(`    Status: ${syncResponse.ingestionJob.status}`);
        }
      } catch (error) {
        console.error(`  ✗ Failed to start sync: ${error.message}`);
      }
    }
    
    console.log('\n✅ Sync initiated. The knowledge base will be updated shortly.');
    console.log('Note: It may take a few minutes for the changes to propagate.');
    
  } catch (error) {
    console.error('Error syncing knowledge base:', error);
  }
}

async function main() {
  console.log('=== Clear Bedrock Knowledge Base Data ===');
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Knowledge Base: ${KNOWLEDGE_BASE_ID}\n`);
  
  console.log('⚠️  WARNING: This will delete all documents from the Bedrock Knowledge Base!');
  console.log('Press Ctrl+C within 5 seconds to cancel...\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Step 1: Delete S3 files
  const deletedCount = await deleteS3Files();
  
  if (deletedCount > 0) {
    // Step 2: Sync the knowledge base to reflect the deletions
    await syncBedrockKnowledgeBase();
  } else {
    console.log('\nNo files to delete. Knowledge base is already empty.');
  }
  
  console.log('\n=== Process Complete ===');
}

main().catch(console.error);