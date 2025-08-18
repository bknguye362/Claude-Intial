#!/usr/bin/env node

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

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

async function testGremlinIds() {
    console.log('Testing relationships with known gremlin.id values...\n');
    
    // We know these chunks exist with these gremlin.id values from the previous output
    const knownChunk1 = 'test-chunk-1';
    const knownChunk2 = 'test-chunk-2';
    
    console.log('1. Attempting to create relationship between existing chunks:');
    console.log('   From:', knownChunk1);
    console.log('   To:', knownChunk2);
    
    const relResult = await invokeLambda({
        operation: 'createRelationships',
        chunkId: knownChunk1,  // Use the gremlin.id value
        relationships: [{
            id: knownChunk2,   // Use the gremlin.id value
            relationship: 'TEST_RELATIONSHIP',
            strength: 1.0
        }]
    });
    
    console.log('\nRelationship result:', JSON.stringify(relResult, null, 2));
    
    // Check if the relationship was created
    console.log('\n2. Checking chunk properties to see relationships:');
    const propResult = await invokeLambda({
        operation: 'getChunkProperties',
        chunkId: knownChunk1
    });
    
    if (propResult.statusCode === 200) {
        const body = JSON.parse(propResult.body);
        console.log('Chunk 1 details:', JSON.stringify(body.result, null, 2));
    }
    
    // Check the graph stats
    console.log('\n3. Checking graph statistics:');
    const exploreResult = await invokeLambda({
        operation: 'explore'
    });
    
    if (exploreResult.statusCode === 200) {
        const body = JSON.parse(exploreResult.body);
        console.log('Total edges before:', 2); // We saw 2 edges earlier
        console.log('Total edges now:', body.result.summary.totalEdges);
        console.log('Relationships:', JSON.stringify(body.result.relationships, null, 2));
    }
    
    // Let's also create a new document and chunk with simple IDs to test
    console.log('\n4. Creating new nodes with simple IDs:');
    
    // Create document
    const simpleDocId = 'simple-doc-1';
    const docResult = await invokeLambda({
        operation: 'createDocumentGraph',
        chunks: [],
        documentId: simpleDocId,
        metadata: {
            title: 'Simple Document',
            gremlinId: simpleDocId
        }
    });
    
    console.log('Document created:', docResult.statusCode === 200);
    
    // Create two chunks
    const simpleChunk1 = 'simple-chunk-1';
    const simpleChunk2 = 'simple-chunk-2';
    
    const chunk1Result = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [{
            chunkId: simpleChunk1,
            documentId: simpleDocId,
            chunkIndex: 0,
            content: 'Simple chunk 1'
        }],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: simpleChunk1,
        documentId: simpleDocId,
        chunkIndex: 0,
        content: 'Simple chunk 1',
        summary: 'First simple chunk'
    });
    
    console.log('Chunk 1 created:', chunk1Result.statusCode === 200);
    
    const chunk2Result = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [{
            chunkId: simpleChunk2,
            documentId: simpleDocId,
            chunkIndex: 1,
            content: 'Simple chunk 2'
        }],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: simpleChunk2,
        documentId: simpleDocId,
        chunkIndex: 1,
        content: 'Simple chunk 2',
        summary: 'Second simple chunk'
    });
    
    console.log('Chunk 2 created:', chunk2Result.statusCode === 200);
    
    // Wait a moment for vertices to be created
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to create relationship between them
    console.log('\n5. Creating relationship between new simple chunks:');
    const simpleRelResult = await invokeLambda({
        operation: 'createRelationships',
        chunkId: simpleChunk1,
        relationships: [{
            id: simpleChunk2,
            relationship: 'FOLLOWS',
            strength: 1.0
        }]
    });
    
    console.log('Relationship result:', JSON.stringify(simpleRelResult, null, 2));
}

testGremlinIds().catch(console.error);