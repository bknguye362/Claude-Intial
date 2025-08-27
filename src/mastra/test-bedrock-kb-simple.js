// Simple Bedrock KB test using AWS CLI (no SDK required)
// This script tests Bedrock KB using AWS CLI commands

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// Configuration
const KB_ID = process.env.BEDROCK_KB_ID || 'your-kb-id-here';
const REGION = process.env.AWS_REGION || 'us-east-1';

// Test queries
const TEST_QUERIES = [
  "Who is Old Major?",
  "What is the Battle of the Windmill?",
  "What happens at the end of the story?",
  "What are the relationships between the pigs?",
  "How does power corrupt in the story?"
];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  red: '\x1b[31m'
};

// 1. Check if KB exists
async function checkKnowledgeBase() {
  console.log(`\n${colors.blue}📋 Checking Knowledge Base...${colors.reset}`);
  
  try {
    const cmd = `aws bedrock-agent get-knowledge-base --knowledge-base-id ${KB_ID} --region ${REGION} --output json`;
    const { stdout } = await execAsync(cmd);
    const kb = JSON.parse(stdout);
    
    console.log(`${colors.green}✓${colors.reset} Knowledge Base: ${kb.knowledgeBase.name}`);
    console.log(`  Status: ${kb.knowledgeBase.status}`);
    console.log(`  Storage: ${kb.knowledgeBase.storageConfiguration.type}`);
    
    return true;
  } catch (error) {
    console.log(`${colors.red}✗${colors.reset} Knowledge Base not found or not accessible`);
    console.log(`  Make sure KB_ID is set: export BEDROCK_KB_ID="your-kb-id"`);
    return false;
  }
}

// 2. Test Retrieve API
async function testRetrieve(query) {
  console.log(`\n${colors.yellow}🔍 Testing Retrieve API${colors.reset}`);
  console.log(`Query: "${query}"`);
  
  try {
    // Create the retrieval configuration
    const retrievalConfig = {
      knowledgeBaseId: KB_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 3
        }
      }
    };
    
    // Save config to temp file
    const fs = await import('fs/promises');
    await fs.writeFile('/tmp/bedrock-query.json', JSON.stringify(retrievalConfig));
    
    // Execute AWS CLI command
    const cmd = `aws bedrock-agent-runtime retrieve --cli-input-json file:///tmp/bedrock-query.json --region ${REGION} --output json`;
    
    console.log('Executing query...');
    const startTime = Date.now();
    const { stdout } = await execAsync(cmd);
    const elapsedTime = Date.now() - startTime;
    
    const response = JSON.parse(stdout);
    
    console.log(`${colors.green}✓${colors.reset} Found ${response.retrievalResults?.length || 0} results in ${elapsedTime}ms`);
    
    // Display results
    if (response.retrievalResults) {
      response.retrievalResults.forEach((result, i) => {
        console.log(`\n  Result ${i + 1}:`);
        console.log(`  Score: ${result.score?.toFixed(4) || 'N/A'}`);
        console.log(`  Content: ${result.content?.text?.substring(0, 150)}...`);
        
        // Check for GraphRAG metadata
        if (result.metadata) {
          console.log(`  ${colors.blue}GraphRAG Metadata:${colors.reset}`, 
            JSON.stringify(result.metadata).substring(0, 100));
        }
      });
    }
    
    return response.retrievalResults || [];
    
  } catch (error) {
    console.log(`${colors.red}✗${colors.reset} Retrieve failed:`, error.message);
    return [];
  }
}

// 3. Test RetrieveAndGenerate API
async function testRAG(query) {
  console.log(`\n${colors.yellow}🤖 Testing RetrieveAndGenerate API${colors.reset}`);
  console.log(`Query: "${query}"`);
  
  try {
    const ragConfig = {
      input: { text: query },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: KB_ID,
          modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0'
        }
      }
    };
    
    const fs = await import('fs/promises');
    await fs.writeFile('/tmp/bedrock-rag.json', JSON.stringify(ragConfig));
    
    const cmd = `aws bedrock-agent-runtime retrieve-and-generate --cli-input-json file:///tmp/bedrock-rag.json --region ${REGION} --output json`;
    
    console.log('Generating response...');
    const startTime = Date.now();
    const { stdout } = await execAsync(cmd);
    const elapsedTime = Date.now() - startTime;
    
    const response = JSON.parse(stdout);
    
    console.log(`${colors.green}✓${colors.reset} Generated response in ${elapsedTime}ms`);
    console.log(`\n  Answer: ${response.output?.text?.substring(0, 300)}...`);
    
    if (response.citations?.length > 0) {
      console.log(`\n  Citations: ${response.citations.length} sources used`);
    }
    
    return response.output?.text || '';
    
  } catch (error) {
    console.log(`${colors.red}✗${colors.reset} RAG failed:`, error.message);
    return '';
  }
}

// 4. Compare with your S3 Vectors
async function compareWithS3Vectors() {
  console.log(`\n${colors.blue}📊 Comparing with S3 Vectors${colors.reset}`);
  
  // Import your query function
  try {
    const { queryVectorsWithNewman } = await import('./lib/newman-executor.js');
    
    // Mock embedding for testing
    const embedding = Array(1536).fill(0).map(() => Math.random());
    const indexName = 'file-aeb36780cf2889abf3462a3c87f94466-2025-08-06';
    
    console.log('Querying S3 Vectors...');
    const startTime = Date.now();
    const results = await queryVectorsWithNewman(indexName, embedding, 3);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`${colors.green}✓${colors.reset} S3 Vectors: ${results.length} results in ${elapsedTime}ms`);
    
    results.slice(0, 2).forEach((result, i) => {
      console.log(`\n  Result ${i + 1}:`);
      console.log(`  Distance: ${result.distance?.toFixed(4)}`);
      console.log(`  Content: ${(result.metadata?.chunkContent || '').substring(0, 150)}...`);
    });
    
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} S3 Vectors comparison skipped:`, error.message);
  }
}

// 5. Run batch tests
async function runBatchTest() {
  console.log(`\n${colors.bright}${colors.blue}📋 Running Batch Test${colors.reset}`);
  console.log('=' .repeat(50));
  
  const results = {
    retrieve: [],
    rag: [],
    times: []
  };
  
  for (const query of TEST_QUERIES) {
    console.log(`\n${colors.bright}Testing: "${query}"${colors.reset}`);
    console.log('-'.repeat(50));
    
    // Test Retrieve
    const retrieveResults = await testRetrieve(query);
    results.retrieve.push({
      query,
      count: retrieveResults.length,
      topScore: retrieveResults[0]?.score || 0
    });
    
    // Test RAG (optional - can be slow)
    if (process.argv.includes('--with-rag')) {
      const ragResult = await testRAG(query);
      results.rag.push({
        query,
        hasAnswer: ragResult.length > 0
      });
    }
    
    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  console.log(`\n${colors.bright}${colors.green}📊 Test Summary${colors.reset}`);
  console.log('=' .repeat(50));
  
  console.log('\nRetrieve API Results:');
  results.retrieve.forEach(r => {
    console.log(`  "${r.query}"`);
    console.log(`    → ${r.count} results, top score: ${r.topScore.toFixed(3)}`);
  });
  
  if (results.rag.length > 0) {
    console.log('\nRAG API Results:');
    results.rag.forEach(r => {
      console.log(`  "${r.query}": ${r.hasAnswer ? '✓ Answer generated' : '✗ No answer'}`);
    });
  }
}

// 6. Test data ingestion status
async function checkIngestion() {
  console.log(`\n${colors.blue}📥 Checking Data Source Ingestion${colors.reset}`);
  
  try {
    // List data sources
    const cmd = `aws bedrock-agent list-data-sources --knowledge-base-id ${KB_ID} --region ${REGION} --output json`;
    const { stdout } = await execAsync(cmd);
    const response = JSON.parse(stdout);
    
    if (response.dataSourceSummaries) {
      for (const ds of response.dataSourceSummaries) {
        console.log(`\nData Source: ${ds.name}`);
        console.log(`  Status: ${ds.status}`);
        console.log(`  Updated: ${ds.updatedAt}`);
        
        // Get ingestion job status
        try {
          const jobCmd = `aws bedrock-agent list-ingestion-jobs --knowledge-base-id ${KB_ID} --data-source-id ${ds.dataSourceId} --region ${REGION} --output json --max-results 1`;
          const { stdout: jobStdout } = await execAsync(jobCmd);
          const jobs = JSON.parse(jobStdout);
          
          if (jobs.ingestionJobSummaries?.[0]) {
            const job = jobs.ingestionJobSummaries[0];
            console.log(`  Latest Ingestion: ${job.status}`);
            console.log(`  Documents: ${job.statistics?.numberOfDocumentsScanned || 0} scanned`);
            console.log(`  Chunks: ${job.statistics?.numberOfDocumentsIndexed || 0} indexed`);
          }
        } catch (e) {
          // Ignore job listing errors
        }
      }
    }
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} Could not check ingestion status`);
  }
}

// Main execution
async function main() {
  console.log(`${colors.bright}${colors.blue}🚀 Bedrock Knowledge Base Test Tool${colors.reset}`);
  console.log('=' .repeat(50));
  console.log(`KB ID: ${KB_ID}`);
  console.log(`Region: ${REGION}`);
  
  // Check if KB exists
  const kbExists = await checkKnowledgeBase();
  if (!kbExists) {
    console.log('\n⚠️  Set environment variables:');
    console.log('  export BEDROCK_KB_ID="your-kb-id"');
    console.log('  export AWS_REGION="us-east-1"');
    return;
  }
  
  // Check ingestion status
  await checkIngestion();
  
  const args = process.argv.slice(2);
  
  if (args.includes('--batch')) {
    // Run batch test
    await runBatchTest();
  } else if (args.includes('--query')) {
    // Test specific query
    const queryIndex = args.indexOf('--query');
    const query = args.slice(queryIndex + 1).join(' ');
    await testRetrieve(query);
    if (args.includes('--with-rag')) {
      await testRAG(query);
    }
  } else if (args.includes('--compare')) {
    // Compare with S3 Vectors
    await compareWithS3Vectors();
  } else {
    // Quick test
    await testRetrieve("Who is Old Major?");
    
    console.log(`\n${colors.bright}Usage:${colors.reset}`);
    console.log('  node test-bedrock-kb-simple.js                    # Quick test');
    console.log('  node test-bedrock-kb-simple.js --batch            # Test all queries');
    console.log('  node test-bedrock-kb-simple.js --batch --with-rag # Include RAG tests');
    console.log('  node test-bedrock-kb-simple.js --query "Your question"');
    console.log('  node test-bedrock-kb-simple.js --compare          # Compare with S3 Vectors');
  }
  
  console.log(`\n${colors.green}✅ Test complete!${colors.reset}`);
}

// Run
main().catch(error => {
  console.error(`${colors.red}Error:${colors.reset}`, error.message);
  process.exit(1);
});