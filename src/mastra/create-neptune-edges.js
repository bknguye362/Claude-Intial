import { 
  exploreGraph,
  createChunkRelationships
} from './lib/neptune-lambda-client.js';

console.log('=== Neptune Edge Creator ===\n');

async function main() {
  try {
    // First, explore to get existing nodes
    console.log('1. Getting existing nodes from graph...');
    const exploration = await exploreGraph();
    
    if (!exploration || !exploration.body) {
      console.log('Failed to explore graph');
      return;
    }
    
    const data = JSON.parse(exploration.body);
    if (!data.success || !data.result) {
      console.log('No graph data found');
      return;
    }
    
    console.log(`Found ${data.result.summary.documentCount} documents with ${data.result.summary.chunkCount} chunks\n`);
    
    // Group chunks by document
    const documentChunks = {};
    data.result.documents.forEach(doc => {
      if (doc.chunkCount > 0) {
        documentChunks[doc.name] = doc.chunkCount;
      }
    });
    
    console.log('2. Creating edges between chunks...\n');
    
    // For each document, create sequential relationships between its chunks
    for (const [docName, chunkCount] of Object.entries(documentChunks)) {
      console.log(`\nProcessing document: ${docName} (${chunkCount} chunks)`);
      
      // Create edges between sequential chunks
      for (let i = 0; i < chunkCount; i++) {
        const currentChunkId = `chunk_${docName}_${i}`;
        const relationships = [];
        
        // Link to previous chunk
        if (i > 0) {
          relationships.push({
            id: `chunk_${docName}_${i - 1}`,
            relationship: 'FOLLOWS',
            strength: 1.0
          });
          console.log(`  - Creating edge: ${currentChunkId} FOLLOWS chunk_${docName}_${i - 1}`);
        }
        
        // Link to next chunk
        if (i < chunkCount - 1) {
          relationships.push({
            id: `chunk_${docName}_${i + 1}`,
            relationship: 'PRECEDES',
            strength: 1.0
          });
          console.log(`  - Creating edge: ${currentChunkId} PRECEDES chunk_${docName}_${i + 1}`);
        }
        
        // Create semantic relationships to other chunks in same document
        // For demo, we'll create weaker connections to chunks 2 positions away
        if (i > 1) {
          relationships.push({
            id: `chunk_${docName}_${i - 2}`,
            relationship: 'RELATED_TO',
            strength: 0.5
          });
          console.log(`  - Creating edge: ${currentChunkId} RELATED_TO chunk_${docName}_${i - 2} (weak)`);
        }
        
        if (i < chunkCount - 2) {
          relationships.push({
            id: `chunk_${docName}_${i + 2}`,
            relationship: 'RELATED_TO',
            strength: 0.5
          });
          console.log(`  - Creating edge: ${currentChunkId} RELATED_TO chunk_${docName}_${i + 2} (weak)`);
        }
        
        // Create the relationships
        if (relationships.length > 0) {
          const success = await createChunkRelationships(currentChunkId, relationships);
          if (success) {
            console.log(`  ✓ Created ${relationships.length} edges for ${currentChunkId}`);
          } else {
            console.log(`  ✗ Failed to create edges for ${currentChunkId}`);
          }
        }
      }
    }
    
    // Let's also create some cross-document relationships
    // For demonstration, link chunks about similar topics
    console.log('\n3. Creating cross-document semantic relationships...\n');
    
    // Link chunks that mention "Napoleon" across documents
    const napoleonChunks = [
      'chunk_test-document-1755126107564_1',
      'chunk_test-document-1755127665176_1',
      'chunk_test-document-1755128127356_1'
    ];
    
    for (let i = 0; i < napoleonChunks.length; i++) {
      for (let j = i + 1; j < napoleonChunks.length; j++) {
        const relationships = [
          {
            id: napoleonChunks[j],
            relationship: 'SIMILAR_TOPIC',
            strength: 0.7
          }
        ];
        
        console.log(`  - Creating edge: ${napoleonChunks[i]} SIMILAR_TOPIC ${napoleonChunks[j]}`);
        await createChunkRelationships(napoleonChunks[i], relationships);
      }
    }
    
    // Verify edges were created
    console.log('\n4. Verifying graph after edge creation...');
    const finalExploration = await exploreGraph();
    if (finalExploration && finalExploration.body) {
      const finalData = JSON.parse(finalExploration.body);
      if (finalData.success && finalData.result) {
        console.log(`\nFinal Graph Summary:`);
        console.log(`  - Total Vertices: ${finalData.result.summary.totalVertices}`);
        console.log(`  - Total Edges: ${finalData.result.summary.totalEdges}`);
        console.log(`  - Edge creation ${finalData.result.summary.totalEdges > 0 ? 'SUCCESSFUL!' : 'may have failed'}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();