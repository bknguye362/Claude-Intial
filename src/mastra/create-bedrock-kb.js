// Script to create a Bedrock Knowledge Base with your custom chunked documents
// This creates a KB that uses your pre-chunked files from S3

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
const execAsync = promisify(exec);

// Configuration
const KB_NAME = 'animal-farm-custom-chunks';
const S3_BUCKET = process.env.S3_BUCKET || 'your-s3-bucket-name';
const REGION = process.env.AWS_REGION || 'us-east-1';

async function createKnowledgeBase() {
  console.log('🚀 Creating Bedrock Knowledge Base with Custom Chunking');
  console.log('=' .repeat(50));
  
  // Step 1: Create the Knowledge Base configuration
  const kbConfig = {
    name: KB_NAME,
    description: 'Animal Farm with custom semantic chunking',
    roleArn: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:role/BedrockKnowledgeBaseRole`, // You'll need to create this role
    knowledgeBaseConfiguration: {
      type: 'VECTOR',
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v1'
      }
    },
    storageConfiguration: {
      type: 'OPENSEARCH_SERVERLESS',
      opensearchServerlessConfiguration: {
        collectionArn: 'arn:aws:aoss:us-east-1:YOUR_ACCOUNT:collection/YOUR_COLLECTION_ID',
        vectorIndexName: 'bedrock-knowledge-base-index',
        fieldMapping: {
          vectorField: 'embedding',
          textField: 'text',
          metadataField: 'metadata'
        }
      }
    }
  };
  
  // For GraphRAG (Neptune Analytics), use this instead:
  const kbConfigGraphRAG = {
    name: KB_NAME,
    description: 'Animal Farm with custom chunking and GraphRAG',
    roleArn: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:role/BedrockKnowledgeBaseRole`,
    knowledgeBaseConfiguration: {
      type: 'VECTOR',
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v1'
      }
    },
    storageConfiguration: {
      type: 'AMAZON_NEPTUNE_ANALYTICS',
      neptuneAnalyticsConfiguration: {
        graphIdentifier: 'your-neptune-analytics-graph-id'
      }
    }
  };
  
  console.log('\n📋 Prerequisites:');
  console.log('1. Create an IAM role for Bedrock KB with permissions to:');
  console.log('   - Access S3 bucket with your chunks');
  console.log('   - Use Bedrock models');
  console.log('   - Access OpenSearch Serverless or Neptune Analytics');
  console.log('\n2. Create OpenSearch Serverless collection OR Neptune Analytics graph');
  console.log('\n3. Upload your pre-chunked files to S3');
  
  console.log('\n📝 To create the Knowledge Base manually:');
  console.log('1. Go to AWS Console → Bedrock → Knowledge Bases');
  console.log('2. Click "Create knowledge base"');
  console.log('3. Configuration:');
  console.log('   - Name: ' + KB_NAME);
  console.log('   - Choose embedding model: Titan Embeddings G1 - Text');
  console.log('   - Vector database: Choose OpenSearch Serverless or Neptune Analytics');
  console.log('\n4. Data Source Configuration:');
  console.log('   - Source: Amazon S3');
  console.log('   - S3 URI: s3://' + S3_BUCKET + '/pre-chunked/');
  console.log('   - Chunking strategy: "No chunking" (since files are pre-chunked)');
  console.log('\n5. Review and create');
  
  console.log('\n💡 Using AWS CLI:');
  console.log('\nFirst, create the IAM role:');
  console.log(`
aws iam create-role --role-name BedrockKnowledgeBaseRole --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "bedrock.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

aws iam attach-role-policy --role-name BedrockKnowledgeBaseRole \\
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam put-role-policy --role-name BedrockKnowledgeBaseRole --policy-name S3Access --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": ["arn:aws:s3:::${S3_BUCKET}/*", "arn:aws:s3:::${S3_BUCKET}"]
  }]
}'
`);

  console.log('\nThen create the Knowledge Base:');
  console.log(`
# For OpenSearch Serverless:
aws bedrock-agent create-knowledge-base \\
  --name "${KB_NAME}" \\
  --description "Animal Farm with custom semantic chunking" \\
  --role-arn "arn:aws:iam::YOUR_ACCOUNT:role/BedrockKnowledgeBaseRole" \\
  --knowledge-base-configuration '{"type":"VECTOR","vectorKnowledgeBaseConfiguration":{"embeddingModelArn":"arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v1"}}' \\
  --storage-configuration '{"type":"OPENSEARCH_SERVERLESS","opensearchServerlessConfiguration":{"collectionArn":"YOUR_COLLECTION_ARN","vectorIndexName":"bedrock-kb-index","fieldMapping":{"vectorField":"embedding","textField":"text","metadataField":"metadata"}}}' \\
  --region ${REGION}
`);

  console.log('\n# For Neptune Analytics (GraphRAG):');
  console.log(`
aws bedrock-agent create-knowledge-base \\
  --name "${KB_NAME}-graphrag" \\
  --description "Animal Farm with GraphRAG" \\
  --role-arn "arn:aws:iam::YOUR_ACCOUNT:role/BedrockKnowledgeBaseRole" \\
  --knowledge-base-configuration '{"type":"VECTOR","vectorKnowledgeBaseConfiguration":{"embeddingModelArn":"arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v1"}}' \\
  --storage-configuration '{"type":"AMAZON_NEPTUNE_ANALYTICS","neptuneAnalyticsConfiguration":{"graphIdentifier":"YOUR_GRAPH_ID"}}' \\
  --region ${REGION}
`);

  console.log('\nFinally, add your S3 data source:');
  console.log(`
aws bedrock-agent create-data-source \\
  --knowledge-base-id "KB_ID_FROM_ABOVE" \\
  --name "pre-chunked-documents" \\
  --data-source-configuration '{"type":"S3","s3Configuration":{"bucketArn":"arn:aws:s3:::${S3_BUCKET}","inclusionPrefixes":["pre-chunked/"]}}' \\
  --vector-ingestion-configuration '{"chunkingConfiguration":{"chunkingStrategy":"NONE"}}' \\
  --region ${REGION}
`);

  console.log('\n📊 Your Current Setup to Integrate:');
  console.log('- S3 Vectors Index: Can query in parallel with Bedrock KB');
  console.log('- Neptune Graph: Can be used via Neptune Analytics for GraphRAG');
  console.log('- Custom Chunking: Upload as individual files with NONE strategy');
  
  console.log('\n✅ Next Steps:');
  console.log('1. Create the Knowledge Base using the commands above');
  console.log('2. Note the KB ID that is returned');
  console.log('3. Run: export BEDROCK_KB_ID="<your-kb-id>"');
  console.log('4. Test with: node test-bedrock-kb-simple.js');
}

// Helper to prepare your chunks for Bedrock
async function prepareChunksForBedrock() {
  console.log('\n📦 Preparing Your Chunks for Bedrock');
  console.log('=' .repeat(50));
  
  console.log('\nYour chunks should be uploaded as individual files:');
  console.log(`
# Example structure in S3:
s3://${S3_BUCKET}/
  pre-chunked/
    animal-farm/
      chunk_0000.txt  # Each file = one chunk
      chunk_0001.txt
      chunk_0002.txt
      ...
      chunk_0319.txt
`);

  console.log('\nExample upload script:');
  console.log(`
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: '${REGION}' });

// Your existing chunks
const chunks = await yourSemanticChunker('animal-farm.pdf');

for (const [index, chunk] of chunks.entries()) {
  const key = \`pre-chunked/animal-farm/chunk_\${index.toString().padStart(4, '0')}.txt\`;
  
  // Add metadata to the content
  const enrichedContent = \`
[METADATA]
Document: Animal Farm
Chunk: \${index + 1}/\${chunks.length}
Pages: \${chunk.pageStart}-\${chunk.pageEnd}
Summary: \${chunk.summary}

[CONTENT]
\${chunk.content}
\`;

  await s3.send(new PutObjectCommand({
    Bucket: '${S3_BUCKET}',
    Key: key,
    Body: enrichedContent,
    ContentType: 'text/plain',
    Metadata: {
      'document-id': 'animal-farm',
      'chunk-index': index.toString(),
      'total-chunks': chunks.length.toString()
    }
  }));
}
`);
}

// Main execution
async function main() {
  await createKnowledgeBase();
  await prepareChunksForBedrock();
  
  console.log('\n🎯 Summary');
  console.log('=' .repeat(50));
  console.log('Bedrock Knowledge Base will give you:');
  console.log('✅ Managed infrastructure');
  console.log('✅ Automatic embedding generation');
  console.log('✅ GraphRAG with Neptune Analytics (optional)');
  console.log('✅ Built-in RAG with Claude/Titan');
  console.log('\nYour custom system gives you:');
  console.log('✅ Custom semantic chunking (keep this!)');
  console.log('✅ S3 Vectors (can run in parallel)');
  console.log('✅ Neptune graph (can integrate with GraphRAG)');
  console.log('✅ Full control over the pipeline');
}

main().catch(console.error);