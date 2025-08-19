#!/usr/bin/env node

import { processPDF } from './dist/lib/pdf-processor.js';
import { exploreGraph } from './dist/lib/neptune-lambda-client.js';

async function testEntityPipeline() {
  console.log('=== Testing Entity Extraction Pipeline ===\n');
  
  // Check initial graph state
  console.log('1. Checking initial graph state...');
  const initialState = await exploreGraph();
  if (initialState && initialState.statusCode === 200) {
    const body = JSON.parse(initialState.body);
    console.log(`   Initial vertices: ${body.result.summary.totalVertices}`);
    console.log(`   Initial entities: ${body.result.summary.entityCount || 0}`);
  }
  
  // Process the test document
  console.log('\n2. Processing test document...');
  const filepath = 'test-entity-extraction.txt';
  
  try {
    const result = await processPDF(filepath);
    
    if (result.success) {
      console.log(`   ✅ Document processed successfully`);
      console.log(`   Index name: ${result.indexName}`);
      console.log(`   Total chunks: ${result.totalChunks}`);
    } else {
      console.log(`   ❌ Processing failed:`, result.message);
    }
  } catch (error) {
    console.error('   ❌ Error processing document:', error);
  }
  
  // Wait for Neptune operations to complete
  console.log('\n3. Waiting for Neptune operations to complete...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Check final graph state
  console.log('\n4. Checking final graph state...');
  const finalState = await exploreGraph();
  if (finalState && finalState.statusCode === 200) {
    const body = JSON.parse(finalState.body);
    console.log(`   Final vertices: ${body.result.summary.totalVertices}`);
    console.log(`   Final entities: ${body.result.summary.entityCount || 0}`);
    console.log(`   Documents: ${body.result.summary.documentCount}`);
    console.log(`   Chunks: ${body.result.summary.chunkCount}`);
    console.log(`   Edges: ${body.result.summary.totalEdges}`);
    
    const newEntities = (body.result.summary.entityCount || 0);
    if (newEntities > 0) {
      console.log('\n🎉 SUCCESS! Entity extraction is working!');
      console.log(`   Created ${newEntities} entities from the document`);
    } else {
      console.log('\n⚠️  No entities were created - check the logs above');
    }
  }
  
  console.log('\n=== Test Complete ===');
}

testEntityPipeline().catch(console.error);