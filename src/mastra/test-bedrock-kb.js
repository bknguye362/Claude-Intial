// Test script for AWS Bedrock Knowledge Base
// This script tests Bedrock KB and compares it with your S3 Vectors implementation

import { BedrockAgentRuntimeClient, RetrieveCommand, RetrieveAndGenerateCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockAgentClient, GetKnowledgeBaseCommand, ListDataSourcesCommand } from '@aws-sdk/client-bedrock-agent';
import { queryVectorsWithNewman } from './lib/newman-executor.js';
import { invokeLambda } from './lib/neptune-lambda-client.js';

// Configuration
const BEDROCK_KB_ID = process.env.BEDROCK_KB_ID || 'your-kb-id-here';
const S3_VECTORS_INDEX = 'file-aeb36780cf2889abf3462a3c87f94466-2025-08-06';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Initialize Bedrock clients
const bedrockRuntime = new BedrockAgentRuntimeClient({ region: AWS_REGION });
const bedrockAgent = new BedrockAgentClient({ region: AWS_REGION });

// Test queries - covering different types
const TEST_QUERIES = [
  // Factual questions
  { query: "Who is Old Major?", type: "factual" },
  { query: "What is the Battle of the Windmill?", type: "factual" },
  { query: "Who are Napoleon and Snowball?", type: "factual" },
  
  // Relationship questions  
  { query: "What is the relationship between Napoleon and Snowball?", type: "relationship" },
  { query: "How does Old Major inspire the other animals?", type: "relationship" },
  
  // Thematic questions
  { query: "What are the main themes of corruption in the story?", type: "thematic" },
  { query: "How does power corrupt the pigs?", type: "thematic" },
  
  // Specific detail questions
  { query: "What happens at the end of the story?", type: "detail" },
  { query: "What are the Seven Commandments?", type: "detail" },
  { query: "How do the commandments change over time?", type: "detail" }
];

// 1. Test Bedrock KB Information
async function testKnowledgeBaseInfo() {
  console.log('\n=====================================');
  console.log('1. BEDROCK KNOWLEDGE BASE INFO');
  console.log('=====================================\n');
  
  try {
    // Get KB details
    const kbCommand = new GetKnowledgeBaseCommand({ knowledgeBaseId: BEDROCK_KB_ID });
    const kbInfo = await bedrockAgent.send(kbCommand);
    
    console.log('Knowledge Base Details:');
    console.log('- Name:', kbInfo.knowledgeBase?.name);
    console.log('- Status:', kbInfo.knowledgeBase?.status);
    console.log('- Created:', kbInfo.knowledgeBase?.createdAt);
    console.log('- Storage Type:', kbInfo.knowledgeBase?.storageConfiguration?.type);
    console.log('- Embedding Model:', kbInfo.knowledgeBase?.embeddingModelArn);
    
    // List data sources
    const dsCommand = new ListDataSourcesCommand({ knowledgeBaseId: BEDROCK_KB_ID });
    const dataSources = await bedrockAgent.send(dsCommand);
    
    console.log('\nData Sources:');
    for (const ds of dataSources.dataSourceSummaries || []) {
      console.log(`- ${ds.name} (${ds.status})`);
      console.log(`  Updated: ${ds.updatedAt}`);
    }
    
  } catch (error) {
    console.error('Error getting KB info:', error.message);
  }
}

// 2. Test Bedrock Retrieve API
async function testBedrockRetrieve(query) {
  console.log(`\n[Bedrock Retrieve] Query: "${query}"`);
  console.log('-'.repeat(50));
  
  try {
    const command = new RetrieveCommand({
      knowledgeBaseId: BEDROCK_KB_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 5,
          searchType: 'HYBRID' // or 'SEMANTIC'
        }
      }
    });
    
    const startTime = Date.now();
    const response = await bedrockRuntime.send(command);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`Found ${response.retrievalResults?.length || 0} results in ${elapsedTime}ms`);
    
    // Show results
    const results = response.retrievalResults || [];
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const result = results[i];
      console.log(`\nResult ${i + 1}:`);
      console.log(`- Score: ${result.score?.toFixed(4)}`);
      console.log(`- Source: ${result.location?.s3Location?.uri || 'Unknown'}`);
      console.log(`- Content: ${result.content?.text?.substring(0, 200)}...`);
      
      // Show metadata if GraphRAG is enabled
      if (result.metadata) {
        console.log('- Metadata:', JSON.stringify(result.metadata).substring(0, 100));
      }
    }
    
    return { results, elapsedTime };
    
  } catch (error) {
    console.error('Bedrock Retrieve error:', error.message);
    return { results: [], elapsedTime: 0 };
  }
}

// 3. Test Bedrock RetrieveAndGenerate API
async function testBedrockRAG(query) {
  console.log(`\n[Bedrock RAG] Query: "${query}"`);
  console.log('-'.repeat(50));
  
  try {
    const command = new RetrieveAndGenerateCommand({
      input: { text: query },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: BEDROCK_KB_ID,
          modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0'
        }
      }
    });
    
    const startTime = Date.now();
    const response = await bedrockRuntime.send(command);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`Generated response in ${elapsedTime}ms`);
    console.log('\nAnswer:', response.output?.text);
    
    // Show citations
    if (response.citations && response.citations.length > 0) {
      console.log('\nCitations:');
      for (const citation of response.citations) {
        const ref = citation.retrievedReferences?.[0];
        console.log(`- ${ref?.location?.s3Location?.uri || 'Unknown source'}`);
      }
    }
    
    return { answer: response.output?.text, elapsedTime };
    
  } catch (error) {
    console.error('Bedrock RAG error:', error.message);
    return { answer: '', elapsedTime: 0 };
  }
}

// 4. Test S3 Vectors for comparison
async function testS3Vectors(query) {
  console.log(`\n[S3 Vectors] Query: "${query}"`);
  console.log('-'.repeat(50));
  
  try {
    // Generate embedding (mock for testing)
    const embedding = Array(1536).fill(0).map(() => Math.random());
    
    const startTime = Date.now();
    const results = await queryVectorsWithNewman(S3_VECTORS_INDEX, embedding, 5);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`Found ${results.length} results in ${elapsedTime}ms`);
    
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const result = results[i];
      console.log(`\nResult ${i + 1}:`);
      console.log(`- Distance: ${result.distance?.toFixed(4)}`);
      console.log(`- Chunk: ${result.metadata?.chunkIndex}/${result.metadata?.totalChunks}`);
      console.log(`- Content: ${(result.metadata?.chunkContent || '').substring(0, 200)}...`);
    }
    
    return { results, elapsedTime };
    
  } catch (error) {
    console.error('S3 Vectors error:', error.message);
    return { results: [], elapsedTime: 0 };
  }
}

// 5. Compare results between systems
async function compareResults(query) {
  console.log('\n=====================================');
  console.log('COMPARISON: Bedrock KB vs S3 Vectors');
  console.log('=====================================');
  console.log(`Query: "${query}"\n`);
  
  // Run both in parallel
  const [bedrockResults, s3Results] = await Promise.all([
    testBedrockRetrieve(query),
    testS3Vectors(query)
  ]);
  
  console.log('\n📊 Performance Comparison:');
  console.log(`- Bedrock KB: ${bedrockResults.elapsedTime}ms (${bedrockResults.results.length} results)`);
  console.log(`- S3 Vectors: ${s3Results.elapsedTime}ms (${s3Results.results.length} results)`);
  
  // Check result overlap
  const bedrockContent = bedrockResults.results.map(r => r.content?.text?.substring(0, 100));
  const s3Content = s3Results.results.map(r => r.metadata?.chunkContent?.substring(0, 100));
  
  let overlap = 0;
  for (const bc of bedrockContent) {
    for (const sc of s3Content) {
      if (bc && sc && bc === sc) overlap++;
    }
  }
  
  console.log(`\n📈 Result Overlap: ${overlap} matching chunks`);
  console.log(`- Bedrock unique: ${bedrockResults.results.length - overlap}`);
  console.log(`- S3 unique: ${s3Results.results.length - overlap}`);
}

// 6. Test GraphRAG capabilities
async function testGraphRAG(query) {
  console.log('\n=====================================');
  console.log('GRAPHRAG TEST (if enabled)');
  console.log('=====================================');
  console.log(`Query: "${query}"\n`);
  
  // Test if GraphRAG returns entity relationships
  const response = await testBedrockRetrieve(query);
  
  // Check for graph-enhanced metadata
  let hasGraphData = false;
  for (const result of response.results) {
    if (result.metadata?.entities || result.metadata?.relationships) {
      hasGraphData = true;
      console.log('\n✅ GraphRAG Data Found:');
      console.log('- Entities:', result.metadata.entities);
      console.log('- Relationships:', result.metadata.relationships);
      break;
    }
  }
  
  if (!hasGraphData) {
    console.log('❌ No GraphRAG data found in results');
    console.log('   (GraphRAG may not be enabled or no entities found)');
  }
}

// 7. Run comprehensive test suite
async function runFullTestSuite() {
  console.log('🚀 BEDROCK KNOWLEDGE BASE TEST SUITE');
  console.log('=====================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`KB ID: ${BEDROCK_KB_ID}`);
  console.log(`Region: ${AWS_REGION}`);
  
  // Test 1: KB Info
  await testKnowledgeBaseInfo();
  
  // Test 2: Run all test queries
  console.log('\n=====================================');
  console.log('2. RUNNING TEST QUERIES');
  console.log('=====================================');
  
  const results = {
    retrieve: [],
    rag: [],
    s3vectors: []
  };
  
  for (const testCase of TEST_QUERIES) {
    console.log(`\n📝 Test Case: ${testCase.type.toUpperCase()}`);
    console.log('='.repeat(50));
    
    // Test Retrieve API
    const retrieveResult = await testBedrockRetrieve(testCase.query);
    results.retrieve.push({ query: testCase.query, ...retrieveResult });
    
    // Test RAG API
    const ragResult = await testBedrockRAG(testCase.query);
    results.rag.push({ query: testCase.query, ...ragResult });
    
    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Test 3: Compare with S3 Vectors
  console.log('\n=====================================');
  console.log('3. SYSTEM COMPARISON');
  console.log('=====================================');
  
  for (const testCase of TEST_QUERIES.slice(0, 3)) { // Just test first 3
    await compareResults(testCase.query);
  }
  
  // Test 4: GraphRAG test
  await testGraphRAG("What is the relationship between Napoleon and Snowball?");
  
  // Summary statistics
  console.log('\n=====================================');
  console.log('📊 SUMMARY STATISTICS');
  console.log('=====================================');
  
  const avgRetrieveTime = results.retrieve.reduce((sum, r) => sum + r.elapsedTime, 0) / results.retrieve.length;
  const avgRAGTime = results.rag.reduce((sum, r) => sum + r.elapsedTime, 0) / results.rag.length;
  
  console.log('\nAverage Response Times:');
  console.log(`- Bedrock Retrieve: ${avgRetrieveTime.toFixed(0)}ms`);
  console.log(`- Bedrock RAG: ${avgRAGTime.toFixed(0)}ms`);
  
  console.log('\nResults Quality:');
  const successfulRetrieves = results.retrieve.filter(r => r.results.length > 0).length;
  const successfulRAGs = results.rag.filter(r => r.answer && r.answer.length > 0).length;
  
  console.log(`- Successful Retrievals: ${successfulRetrieves}/${results.retrieve.length}`);
  console.log(`- Successful RAG Responses: ${successfulRAGs}/${results.rag.length}`);
  
  console.log('\n✅ Test Suite Complete!');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args[0] === '--full') {
    // Run full test suite
    await runFullTestSuite();
  } else if (args[0] === '--query' && args[1]) {
    // Test single query
    const query = args.slice(1).join(' ');
    await testBedrockRetrieve(query);
    await testBedrockRAG(query);
    await compareResults(query);
  } else {
    // Quick test
    console.log('Quick test with sample query...\n');
    await testKnowledgeBaseInfo();
    await testBedrockRetrieve("Who is Old Major?");
    await testBedrockRAG("Who is Old Major?");
    
    console.log('\nUsage:');
    console.log('  node test-bedrock-kb.js --full              # Run full test suite');
    console.log('  node test-bedrock-kb.js --query "Your question"  # Test specific query');
  }
}

// Run tests
main().catch(console.error);