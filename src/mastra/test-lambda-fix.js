#!/usr/bin/env node

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { exploreGraph } from './dist/lib/neptune-lambda-client.js';

const LAMBDA_FUNCTION_NAME = 'chatbotRAG';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const lambdaClient = new LambdaClient({
    region: AWS_REGION,
    credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    } : undefined
});

async function invokeLambda(payload) {
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify(payload)
        });
        
        const response = await lambdaClient.send(command);
        if (response.Payload) {
            return JSON.parse(new TextDecoder().decode(response.Payload));
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function testLambdaFix() {
    console.log('=== Testing Lambda Fix ===\n');
    
    // Check initial state
    console.log('1. Checking initial graph state:');
    const initialState = await exploreGraph();
    let initialEdges = 0;
    if (initialState && initialState.statusCode === 200) {
        const body = JSON.parse(initialState.body);
        initialEdges = body.result.summary.totalEdges;
        console.log(`   Current edges: ${initialEdges}`);
    }
    
    // Create test document
    const timestamp = Date.now();
    const testDocId = `doc_fix_test_${timestamp}`;
    const testChunkId1 = `chunk_fix_test_${timestamp}_1`;
    const testChunkId2 = `chunk_fix_test_${timestamp}_2`;
    
    console.log(`\n2. Creating test document: ${testDocId}`);
    const docResult = await invokeLambda({
        operation: 'createDocumentGraph',
        chunks: [],
        documentId: testDocId,
        metadata: {
            title: 'Lambda Fix Test Document',
            author: 'Test System'
        }
    });
    
    if (docResult.statusCode === 200) {
        console.log('   ✅ Document created successfully');
    } else {
        console.log('   ❌ Document creation failed:', JSON.parse(docResult.body).error);
    }
    
    // Create first chunk
    console.log(`\n3. Creating first chunk: ${testChunkId1}`);
    const chunk1Result = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: testChunkId1,
        documentId: testDocId,
        chunkIndex: 0,
        content: 'First test chunk content',
        summary: 'First chunk'
    });
    
    if (chunk1Result.statusCode === 200) {
        console.log('   ✅ Chunk 1 created successfully');
    } else {
        console.log('   ❌ Chunk 1 creation failed:', JSON.parse(chunk1Result.body).error);
    }
    
    // Create second chunk
    console.log(`\n4. Creating second chunk: ${testChunkId2}`);
    const chunk2Result = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: testChunkId2,
        documentId: testDocId,
        chunkIndex: 1,
        content: 'Second test chunk content',
        summary: 'Second chunk'
    });
    
    if (chunk2Result.statusCode === 200) {
        console.log('   ✅ Chunk 2 created successfully');
    } else {
        console.log('   ❌ Chunk 2 creation failed:', JSON.parse(chunk2Result.body).error);
    }
    
    // Wait for vertices to be committed
    console.log('\n5. Waiting for vertices to be committed...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // THE KEY TEST: Create relationship
    console.log(`\n6. Creating relationship between chunks (THE FIX TEST):`);
    console.log(`   From: ${testChunkId1}`);
    console.log(`   To: ${testChunkId2}`);
    
    const relResult = await invokeLambda({
        operation: 'createRelationships',
        chunkId: testChunkId1,
        relationships: [{
            id: testChunkId2,
            relationship: 'FOLLOWS',
            strength: 1.0
        }]
    });
    
    if (relResult.statusCode === 200) {
        const body = JSON.parse(relResult.body);
        if (body.result.success && body.result.relationshipsCreated > 0) {
            console.log('   ✅ RELATIONSHIP CREATED SUCCESSFULLY! The fix works!');
            console.log(`   Created ${body.result.relationshipsCreated} relationship(s)`);
        } else {
            console.log('   ❌ Relationship creation failed');
            if (body.result.errors) {
                console.log('   Errors:', body.result.errors);
            }
        }
    }
    
    // Check if we can find the chunks by ID
    console.log(`\n7. Verifying chunks can be found by ID:`);
    const propResult = await invokeLambda({
        operation: 'getChunkProperties',
        chunkId: testChunkId1
    });
    
    if (propResult.statusCode === 200) {
        const body = JSON.parse(propResult.body);
        if (body.result.count > 0) {
            console.log('   ✅ Chunk found by ID! gremlin.id is working');
            const chunk = body.result.chunks[0];
            console.log(`   gremlin.id: ${chunk['gremlin.id']?.[0] || 'not set'}`);
            console.log(`   chunkId: ${chunk.chunkId?.[0] || 'not set'}`);
        } else {
            console.log('   ❌ Chunk not found by ID');
        }
    }
    
    // Check final edge count
    console.log('\n8. Checking final graph state:');
    const finalState = await exploreGraph();
    if (finalState && finalState.statusCode === 200) {
        const body = JSON.parse(finalState.body);
        const newEdges = body.result.summary.totalEdges - initialEdges;
        console.log(`   Total edges: ${body.result.summary.totalEdges}`);
        console.log(`   New edges created: ${newEdges}`);
        
        if (newEdges > 0) {
            console.log('\n🎉 SUCCESS! The Lambda fix is working!');
            console.log('   - Vertices are created with gremlin.id');
            console.log('   - Relationships can be created');
            console.log('   - The Neptune integration is now fully functional');
        } else {
            console.log('\n⚠️  No new edges were created - the fix may not be working yet');
        }
    }
    
    console.log('\n=== Test Complete ===');
}

testLambdaFix().catch(console.error);