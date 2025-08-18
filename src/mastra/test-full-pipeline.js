#!/usr/bin/env node

import { createDocumentNode, createChunkNode, createChunkRelationships, exploreGraph } from './dist/lib/neptune-lambda-client.js';

async function testFullPipeline() {
    console.log('Testing full Neptune pipeline with proper parameters...\n');
    
    // Check initial state
    console.log('1. Checking initial graph state:');
    const initialState = await exploreGraph();
    if (initialState && initialState.statusCode === 200) {
        const body = JSON.parse(initialState.body);
        console.log('Initial vertices:', body.result.summary.totalVertices);
        console.log('Initial documents:', body.result.summary.documentCount);
        console.log('Initial chunks:', body.result.summary.chunkCount);
    }
    
    // Create a test document
    const testDocId = `doc_test_pipeline_${Date.now()}`;
    console.log(`\n2. Creating document: ${testDocId}`);
    
    const docCreated = await createDocumentNode(testDocId, {
        title: 'Test Pipeline Document',
        author: 'Pipeline Test',
        pages: 3,
        totalChunks: 3,
        indexName: 'test-pipeline-index',
        timestamp: new Date().toISOString()
    });
    
    console.log('Document created:', docCreated);
    
    // Create chunks for this document
    if (docCreated) {
        console.log('\n3. Creating chunks for the document:');
        
        const chunks = [
            { id: `chunk_${testDocId}_0`, content: 'First chunk content here', summary: 'Introduction' },
            { id: `chunk_${testDocId}_1`, content: 'Second chunk content here', summary: 'Main content' },
            { id: `chunk_${testDocId}_2`, content: 'Third chunk content here', summary: 'Conclusion' }
        ];
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`Creating chunk ${i}:`, chunk.id);
            
            const chunkCreated = await createChunkNode(
                chunk.id,
                testDocId,
                i,
                chunk.content,
                chunk.summary,
                {
                    pageStart: i + 1,
                    pageEnd: i + 1,
                    chunkIndex: i,
                    totalChunks: chunks.length
                }
            );
            
            console.log(`Chunk ${i} created:`, chunkCreated);
            
            // Create relationships
            if (chunkCreated) {
                const relationships = [];
                
                if (i > 0) {
                    relationships.push({
                        id: chunks[i - 1].id,
                        relationship: 'FOLLOWS',
                        strength: 1.0
                    });
                }
                
                if (i < chunks.length - 1) {
                    relationships.push({
                        id: chunks[i + 1].id,
                        relationship: 'PRECEDES',
                        strength: 1.0
                    });
                }
                
                if (relationships.length > 0) {
                    console.log(`Creating relationships for chunk ${i}:`, relationships);
                    await createChunkRelationships(chunk.id, relationships);
                }
            }
        }
    }
    
    // Check final state
    console.log('\n4. Checking final graph state:');
    const finalState = await exploreGraph();
    if (finalState && finalState.statusCode === 200) {
        const body = JSON.parse(finalState.body);
        console.log('Final vertices:', body.result.summary.totalVertices);
        console.log('Final documents:', body.result.summary.documentCount);
        console.log('Final chunks:', body.result.summary.chunkCount);
        console.log('Final edges:', body.result.summary.totalEdges);
        
        // Show the most recent documents
        console.log('\nMost recent documents:');
        body.result.documents.slice(0, 3).forEach(doc => {
            console.log('- ', doc.name || 'Unknown', '(chunks:', doc.chunkCount + ')');
        });
    }
}

testFullPipeline().catch(console.error);