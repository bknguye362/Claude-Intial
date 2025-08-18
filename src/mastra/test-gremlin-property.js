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

async function testGremlinProperty() {
    console.log('Testing different ways to set gremlin.id property...\n');
    
    const timestamp = Date.now();
    
    // Test 1: Try setting gremlin.id in metadata
    console.log('1. Testing with gremlin.id in metadata:');
    const testId1 = `gremlin-test-${timestamp}-1`;
    
    const result1 = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: testId1,
        documentId: 'test-doc',
        chunkIndex: 0,
        content: 'Test content 1',
        summary: 'Test 1',
        metadata: {
            'gremlin.id': testId1  // Try in metadata
        }
    });
    
    console.log('Result:', result1.statusCode === 200 ? 'Created' : 'Failed');
    
    // Test 2: Try with id field directly
    console.log('\n2. Testing with id field:');
    const testId2 = `gremlin-test-${timestamp}-2`;
    
    const result2 = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [],
        entities: [],
        concepts: [],
        relationships: [],
        id: testId2,  // Try id field
        chunkId: testId2,
        documentId: 'test-doc',
        chunkIndex: 1,
        content: 'Test content 2',
        summary: 'Test 2'
    });
    
    console.log('Result:', result2.statusCode === 200 ? 'Created' : 'Failed');
    
    // Test 3: Try with gremlinId field
    console.log('\n3. Testing with gremlinId field:');
    const testId3 = `gremlin-test-${timestamp}-3`;
    
    const result3 = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [],
        entities: [],
        concepts: [],
        relationships: [],
        gremlinId: testId3,  // Try gremlinId field
        chunkId: testId3,
        documentId: 'test-doc',
        chunkIndex: 2,
        content: 'Test content 3',
        summary: 'Test 3'
    });
    
    console.log('Result:', result3.statusCode === 200 ? 'Created' : 'Failed');
    
    // Test 4: Try setting it in the chunks array
    console.log('\n4. Testing with gremlin.id in chunks array:');
    const testId4 = `gremlin-test-${timestamp}-4`;
    
    const result4 = await invokeLambda({
        operation: 'createChunkGraph',
        chunks: [{
            'gremlin.id': testId4,
            chunkId: testId4,
            content: 'Test content 4'
        }],
        entities: [],
        concepts: [],
        relationships: [],
        chunkId: testId4,
        documentId: 'test-doc',
        chunkIndex: 3,
        content: 'Test content 4',
        summary: 'Test 4'
    });
    
    console.log('Result:', result4.statusCode === 200 ? 'Created' : 'Failed');
    
    // Wait for vertices to be created
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check if any of our IDs work for relationships
    console.log('\n5. Testing relationships with our test IDs:');
    
    for (let i = 1; i <= 4; i++) {
        const fromId = `gremlin-test-${timestamp}-${i}`;
        const toId = `gremlin-test-${timestamp}-${(i % 4) + 1}`;
        
        const relResult = await invokeLambda({
            operation: 'createRelationships',
            chunkId: fromId,
            relationships: [{
                id: toId,
                relationship: 'TEST',
                strength: 1.0
            }]
        });
        
        const body = JSON.parse(relResult.body);
        console.log(`Test ${i} (${fromId} -> ${toId}):`, body.result.success ? 'SUCCESS' : 'FAILED');
        if (body.result.errors) {
            console.log('  Error:', body.result.errors[0]);
        }
    }
    
    // Check properties of our created chunks
    console.log('\n6. Checking if any chunks were created with our IDs:');
    const propResult = await invokeLambda({
        operation: 'getChunkProperties',
        chunkId: `gremlin-test-${timestamp}-1`
    });
    
    if (propResult.statusCode === 200) {
        const body = JSON.parse(propResult.body);
        console.log('Found chunks:', body.result.count);
        if (body.result.count > 0) {
            console.log('Chunk details:', JSON.stringify(body.result.chunks[0], null, 2));
        }
    }
}

testGremlinProperty().catch(console.error);