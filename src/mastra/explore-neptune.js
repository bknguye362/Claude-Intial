import { 
  getGraphStats, 
  exploreGraph,
  queryGraph
} from './lib/neptune-lambda-client.js';

console.log('=== Neptune Graph Explorer ===\n');

async function main() {
  try {
    // Get graph statistics
    console.log('1. Getting graph statistics...');
    const stats = await getGraphStats();
    if (stats) {
      console.log('\nGraph Statistics:');
      console.log(`  - Total Nodes: ${stats.nodeCount}`);
      console.log(`  - Total Edges: ${stats.edgeCount}`);
      console.log(`  - Documents: ${stats.documentCount}`);
      console.log(`  - Chunks: ${stats.chunkCount}`);
    } else {
      console.log('  Failed to get graph statistics');
    }
    
    // Explore graph structure
    console.log('\n2. Exploring graph structure...');
    const exploration = await exploreGraph();
    if (exploration) {
      console.log('\nGraph Exploration:');
      console.log(JSON.stringify(exploration, null, 2));
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