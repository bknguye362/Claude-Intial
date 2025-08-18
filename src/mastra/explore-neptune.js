import { 
  getGraphStats, 
  exploreGraph,
  queryGraph
} from './lib/neptune-lambda-client.js';

console.log('=== Neptune Graph Explorer ===\n');

async function main() {
  try {
    // Skip stats for now since Lambda doesn't support it
    console.log('1. Skipping graph statistics (not supported by Lambda)...');
    
    // Explore graph structure
    console.log('\n2. Exploring graph structure...');
    const exploration = await exploreGraph();
    if (exploration && exploration.body) {
      try {
        const data = JSON.parse(exploration.body);
        if (data.success && data.result) {
          console.log('\nGraph Summary:');
          console.log(`  - Total Vertices: ${data.result.summary.totalVertices}`);
          console.log(`  - Total Edges: ${data.result.summary.totalEdges}`);
          console.log(`  - Documents: ${data.result.summary.documentCount}`);
          console.log(`  - Chunks: ${data.result.summary.chunkCount}`);
          
          console.log('\nDocuments in Graph:');
          data.result.documents.forEach((doc, i) => {
            console.log(`  ${i + 1}. ${doc.name}`);
            console.log(`     Created: ${doc.timestamp}`);
            console.log(`     Chunks: ${doc.chunkCount}`);
          });
          
          console.log('\nSample Chunks:');
          data.result.chunks.slice(0, 3).forEach((chunk, i) => {
            console.log(`  ${i + 1}. Chunk Index: ${chunk.index}`);
            console.log(`     Summary: ${chunk.summary}`);
            console.log(`     Content: ${chunk.contentPreview}`);
          });
        }
      } catch (e) {
        console.log('  Failed to parse exploration data:', e);
      }
    } else {
      console.log('  Failed to explore graph');
    }
    
    // Try a sample query
    console.log('\n3. Sample query...');
    const results = await queryGraph('test query', 5);
    if (results && results.length > 0) {
      console.log(`\nQuery returned ${results.length} results:`);
      results.forEach((result, i) => {
        console.log(`\n  Result ${i + 1}:`);
        console.log(`    ${JSON.stringify(result, null, 2)}`);
      });
    } else {
      console.log('  No results from query');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();