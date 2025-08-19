#!/usr/bin/env node

import { createNeptuneGraphEnhanced } from './dist/lib/neptune-enhanced.js';
import { exploreGraph } from './dist/lib/neptune-lambda-client.js';

async function testEnhancedNeptune() {
    console.log('=== Testing Enhanced Neptune Integration ===\n');
    
    // Check initial state
    console.log('1. Checking initial graph state:');
    const initialState = await exploreGraph();
    let initialVertices = 0;
    let initialEdges = 0;
    
    if (initialState && initialState.statusCode === 200) {
        const body = JSON.parse(initialState.body);
        initialVertices = body.result.summary.totalVertices;
        initialEdges = body.result.summary.totalEdges;
        console.log(`   Vertices: ${initialVertices}`);
        console.log(`   Edges: ${initialEdges}`);
        console.log(`   Documents: ${body.result.summary.documentCount}`);
        console.log(`   Chunks: ${body.result.summary.chunkCount}`);
    }
    
    // Create a test document with meaningful content for relationship discovery
    const timestamp = Date.now();
    const testDocId = `doc_enhanced_test_${timestamp}`;
    const indexName = `enhanced-test-${timestamp}`;
    
    console.log(`\n2. Creating test document: ${testDocId}`);
    
    // Sample chunks with content that should create semantic relationships
    const testChunks = [
        {
            id: `chunk_${indexName}_0`,
            content: 'Machine learning is a subset of artificial intelligence that enables systems to learn from data. It uses algorithms to identify patterns and make decisions without being explicitly programmed.',
            summary: 'Introduction to machine learning and its relationship to AI',
            metadata: { pageStart: 1, pageEnd: 1, chunkIndex: 0, totalChunks: 6 }
        },
        {
            id: `chunk_${indexName}_1`,
            content: 'Neural networks are computational models inspired by the human brain. They consist of interconnected nodes (neurons) organized in layers.',
            summary: 'Neural networks structure and inspiration',
            metadata: { pageStart: 1, pageEnd: 2, chunkIndex: 1, totalChunks: 6 }
        },
        {
            id: `chunk_${indexName}_2`,
            content: 'Deep learning is a type of machine learning that uses multi-layered neural networks. It has revolutionized fields like computer vision and natural language processing.',
            summary: 'Deep learning as advanced neural network application',
            metadata: { pageStart: 2, pageEnd: 2, chunkIndex: 2, totalChunks: 6 }
        },
        {
            id: `chunk_${indexName}_3`,
            content: 'Training a neural network involves adjusting weights and biases through backpropagation. The network learns by minimizing a loss function using gradient descent.',
            summary: 'Neural network training process',
            metadata: { pageStart: 3, pageEnd: 3, chunkIndex: 3, totalChunks: 6 }
        },
        {
            id: `chunk_${indexName}_4`,
            content: 'Computer vision applications include image classification, object detection, and facial recognition. These tasks were previously very difficult for traditional programming approaches.',
            summary: 'Computer vision applications and advantages',
            metadata: { pageStart: 4, pageEnd: 4, chunkIndex: 4, totalChunks: 6 }
        },
        {
            id: `chunk_${indexName}_5`,
            content: 'In summary, machine learning, particularly deep learning with neural networks, has transformed how we approach complex problems in AI, enabling breakthroughs in vision, language, and decision-making tasks.',
            summary: 'Summary of ML and deep learning impact',
            metadata: { pageStart: 5, pageEnd: 5, chunkIndex: 5, totalChunks: 6 }
        }
    ];
    
    console.log(`   Creating ${testChunks.length} chunks with semantic content`);
    
    // Expected relationships:
    // - Chunk 0 (ML intro) should be REFERENCED by chunk 2 (deep learning) and chunk 5 (summary)
    // - Chunk 1 (neural networks) should be ELABORATED by chunk 2 (deep learning) and chunk 3 (training)
    // - Chunk 2 (deep learning) REFERENCES chunk 4 (computer vision)
    // - Chunk 5 (summary) SUMMARIZES chunks 0, 1, 2
    
    console.log('\n3. Running enhanced Neptune graph creation...');
    console.log('   This will:');
    console.log('   - Create document and chunk nodes');
    console.log('   - Wait for nodes to be committed');
    console.log('   - Create sequential relationships (FOLLOWS)');
    console.log('   - Use LLM to discover semantic relationships');
    
    const startTime = Date.now();
    
    const success = await createNeptuneGraphEnhanced(
        testDocId,
        {
            title: 'Machine Learning and Neural Networks Test Document',
            author: 'Test System',
            pages: 5,
            totalChunks: testChunks.length,
            indexName: indexName,
            timestamp: new Date().toISOString()
        },
        testChunks
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n   Completed in ${duration} seconds`);
    console.log(`   Success: ${success}`);
    
    // Wait a bit more for everything to settle
    console.log('\n4. Waiting for graph updates to propagate...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check final state
    console.log('\n5. Checking final graph state:');
    const finalState = await exploreGraph();
    
    if (finalState && finalState.statusCode === 200) {
        const body = JSON.parse(finalState.body);
        const newVertices = body.result.summary.totalVertices - initialVertices;
        const newEdges = body.result.summary.totalEdges - initialEdges;
        
        console.log(`   Total vertices: ${body.result.summary.totalVertices} (added ${newVertices})`);
        console.log(`   Total edges: ${body.result.summary.totalEdges} (added ${newEdges})`);
        console.log(`   Documents: ${body.result.summary.documentCount}`);
        console.log(`   Chunks: ${body.result.summary.chunkCount}`);
        
        console.log('\n6. Analysis:');
        console.log(`   Expected new vertices: 7 (1 document + 6 chunks)`);
        console.log(`   Actual new vertices: ${newVertices}`);
        console.log(`   Expected minimum edges: 5 (sequential FOLLOWS relationships)`);
        console.log(`   Actual new edges: ${newEdges}`);
        
        if (newEdges > 5) {
            console.log(`   ✅ Semantic relationships discovered: ${newEdges - 5} additional edges!`);
        } else if (newEdges === 5) {
            console.log('   ⚠️  Only sequential relationships created (no semantic relationships)');
        } else {
            console.log('   ❌ Fewer edges than expected - relationship creation may have failed');
        }
        
        // Show recent documents
        console.log('\n7. Recent documents in graph:');
        const recentDocs = body.result.documents.slice(0, 5);
        recentDocs.forEach(doc => {
            const name = Array.isArray(doc.name) ? doc.name[0] : doc.name || 'Unknown';
            const timestamp = Array.isArray(doc.timestamp) ? doc.timestamp[0] : doc.timestamp;
            console.log(`   - ${name}`);
            console.log(`     Timestamp: ${timestamp}`);
            console.log(`     Chunks: ${doc.chunkCount}`);
        });
    }
    
    console.log('\n=== Test Complete ===');
    console.log('\nTo test with a real PDF:');
    console.log('1. Upload a PDF through the web interface or API');
    console.log('2. Check the logs for "Neptune knowledge graph created with semantic relationships"');
    console.log('3. Run this test again to see the increased vertex and edge counts');
}

testEnhancedNeptune().catch(console.error);