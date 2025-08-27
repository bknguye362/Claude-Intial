// Test script for Bedrock Knowledge Base integration with custom chunking
import { processPDF } from './dist/lib/pdf-processor.js';

// Set environment variables for Bedrock
process.env.BEDROCK_KB_ID = 'FQ7HMGJHKP';
process.env.BEDROCK_DS_ID = 'I3VDDM6TLP';
process.env.BEDROCK_KB_REGION = 'us-east-2';
process.env.S3_VECTORS_BUCKET = 'chatbotvectors362';
process.env.S3_VECTORS_REGION = 'us-east-2';

// Also set Azure OpenAI for embeddings
process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
process.env.AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || '';
process.env.AZURE_OPENAI_LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

async function testBedrockIntegration() {
  console.log('🚀 Testing Bedrock Knowledge Base Integration');
  console.log('=' .repeat(50));
  
  console.log('\nConfiguration:');
  console.log('- Bedrock KB ID:', process.env.BEDROCK_KB_ID);
  console.log('- Data Source ID:', process.env.BEDROCK_DS_ID);
  console.log('- S3 Bucket:', process.env.S3_VECTORS_BUCKET);
  console.log('- Region:', process.env.BEDROCK_KB_REGION);
  
  try {
    // Process the test document
    console.log('\n📄 Processing test document...');
    const result = await processPDF('test-document.txt');
    
    if (result.success) {
      console.log('\n✅ Document processed successfully!');
      console.log('- Total chunks:', result.totalChunks);
      console.log('- Index name:', result.indexName);
      
      // Check S3 for uploaded chunks
      console.log('\n📦 Checking S3 for Bedrock chunks...');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const timestamp = new Date().toISOString().split('T')[0];
      const s3Path = `s3://${process.env.S3_VECTORS_BUCKET}/bedrock-chunks/test-document/${timestamp}/`;
      
      try {
        const { stdout } = await execAsync(`aws s3 ls ${s3Path} --region ${process.env.S3_VECTORS_REGION} | head -5`);
        console.log('Uploaded chunks:', stdout);
      } catch (error) {
        console.log('Could not list S3 chunks:', error.message);
      }
      
      // Check Bedrock ingestion status
      if (process.env.BEDROCK_KB_ID) {
        console.log('\n🔄 Checking Bedrock ingestion status...');
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for ingestion
        
        try {
          const cmd = `aws bedrock-agent list-ingestion-jobs --knowledge-base-id ${process.env.BEDROCK_KB_ID} --data-source-id ${process.env.BEDROCK_DS_ID} --region ${process.env.BEDROCK_KB_REGION} --max-results 1 --output json`;
          const { stdout } = await execAsync(cmd);
          const jobs = JSON.parse(stdout);
          
          if (jobs.ingestionJobSummaries?.[0]) {
            const job = jobs.ingestionJobSummaries[0];
            console.log('Latest ingestion job:');
            console.log('- Job ID:', job.ingestionJobId);
            console.log('- Status:', job.status);
            console.log('- Documents scanned:', job.statistics?.numberOfDocumentsScanned);
            console.log('- Documents indexed:', job.statistics?.numberOfDocumentsIndexed);
          }
        } catch (error) {
          console.log('Could not check ingestion:', error.message);
        }
      }
      
      console.log('\n📊 Summary:');
      console.log('1. Document chunked with custom semantic strategy');
      console.log('2. Chunks uploaded to S3 Vectors for existing system');
      console.log('3. Chunks also uploaded as individual files for Bedrock KB');
      console.log('4. Bedrock ingestion triggered (if configured)');
      console.log('5. Neptune graph created in background');
      
    } else {
      console.error('\n❌ Processing failed:', result.error);
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error);
  }
}

// Run the test
testBedrockIntegration().catch(console.error);