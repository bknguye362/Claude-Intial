import { graphEnhancedQueryTool } from './dist/tools/graph-enhanced-query-tool.js';

console.log('🧪 Testing Graph-Enhanced Query Tool');
console.log('=====================================\n');

// Test queries
const testQueries = [
  "What does Napoleon say about Old Major?",
  "Tell me about the relationships between Napoleon and other animals",
  "What happens at the end of Animal Farm?"
];

async function testGraphQuery(question) {
  console.log(`\n📝 Question: "${question}"`);
  console.log('----------------------------------------');
  
  try {
    const result = await graphEnhancedQueryTool.execute({
      context: {
        question: question,
        useGraphEnhancement: true,
        maxGraphEntities: 5
      }
    });
    
    if (result.success) {
      console.log('✅ Query successful!');
      console.log(`📊 Found ${result.totalSimilarChunks} similar chunks`);
      console.log(`📚 From ${result.documentContext.documentsFound} documents`);
      
      // Show graph enhancement info
      if (result.graphEnhancement) {
        console.log('\n🔗 Knowledge Graph Enhancement:');
        console.log(`   - Entities found: ${result.graphEnhancement.entitiesFound}`);
        console.log(`   - Graph-enhanced chunks: ${result.graphEnhancement.graphEnhancedChunks}`);
        
        if (result.graphEnhancement.entities && result.graphEnhancement.entities.length > 0) {
          console.log('\n   Entities:');
          result.graphEnhancement.entities.forEach(e => {
            console.log(`   • Query: "${e.queryTerm}"`);
            e.relatedEntities.forEach(re => {
              console.log(`     - ${re.name} (${re.type})`);
              if (re.description) {
                console.log(`       ${re.description}`);
              }
              if (re.relationships) {
                if (re.relationships.outgoing.length > 0) {
                  console.log(`       Relationships: ${re.relationships.outgoing.map(r => `${r.type} → ${r.target}`).join(', ')}`);
                }
                if (re.relationships.incoming.length > 0) {
                  console.log(`       Referenced by: ${re.relationships.incoming.map(r => `${r.source} → ${r.type}`).join(', ')}`);
                }
              }
            });
          });
        }
      }
      
      // Show sample of context that would go to LLM
      if (result.contextString) {
        const graphSection = result.contextString.indexOf('KNOWLEDGE GRAPH CONTEXT:');
        if (graphSection > -1) {
          console.log('\n📋 Graph Context for LLM:');
          console.log(result.contextString.substring(graphSection, Math.min(graphSection + 500, result.contextString.length)) + '...');
        }
      }
      
      // Show first chunk as sample
      if (result.similarChunks && result.similarChunks.length > 0) {
        const firstChunk = result.similarChunks[0];
        console.log('\n📄 Sample chunk:');
        console.log(`   Distance: ${firstChunk.distance}`);
        console.log(`   Content: ${(firstChunk.content || '').substring(0, 200)}...`);
        if (firstChunk.metadata?.graphEnhanced) {
          console.log('   ⭐ This chunk was graph-enhanced!');
        }
      }
      
    } else {
      console.log('❌ Query failed:', result.message);
      if (result.error) {
        console.log('   Error:', result.error);
      }
    }
  } catch (error) {
    console.error('❌ Error executing query:', error);
  }
}

// Run tests
async function runTests() {
  console.log('Starting tests...\n');
  
  for (const query of testQueries) {
    await testGraphQuery(query);
    console.log('\n' + '='.repeat(50));
  }
  
  console.log('\n✨ All tests completed!');
}

runTests().catch(console.error);