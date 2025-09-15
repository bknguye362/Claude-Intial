#!/usr/bin/env node

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = 'chatbotvectors362';

async function countS3Files() {
  console.log('=== Checking Bedrock S3 Files ===\n');
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Prefix: bedrock-chunks/\n`);
  
  let totalFiles = 0;
  let continuationToken;
  const folderCounts = {};
  
  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'bedrock-chunks/',
      ContinuationToken: continuationToken
    });
    
    const response = await s3Client.send(listCommand);
    
    if (response.Contents) {
      totalFiles += response.Contents.length;
      
      // Count files per folder
      response.Contents.forEach(obj => {
        const parts = obj.Key.split('/');
        if (parts.length >= 2) {
          const folder = parts[1]; // Document ID folder
          folderCounts[folder] = (folderCounts[folder] || 0) + 1;
        }
      });
    }
    
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  
  console.log('Results:');
  console.log('─'.repeat(50));
  
  if (totalFiles === 0) {
    console.log('✅ No files found - Bedrock data source is EMPTY');
  } else {
    console.log(`⚠️  Found ${totalFiles} file(s) in Bedrock data source\n`);
    
    console.log('Files per document:');
    Object.entries(folderCounts).forEach(([folder, count]) => {
      console.log(`  ${folder}: ${count} files`);
    });
  }
  
  console.log('─'.repeat(50));
  
  return totalFiles;
}

countS3Files().catch(console.error);