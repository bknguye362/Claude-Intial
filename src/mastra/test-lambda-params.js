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

async function testLambdaOperations() {
    console.log('Testing Lambda operations with different parameter formats...\n');
    
    // Test createDocumentGraph with different parameter formats
    const testDocId = `doc_test_${Date.now()}`;
    
    console.log('1. Testing createDocumentGraph with nested params structure:');
    try {
        const command1 = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                params: {
                    documentId: testDocId,
                    metadata: {
                        title: 'Test Document',
                        author: 'Test Author',
                        pages: 10,
                        totalChunks: 5,
                        indexName: 'test-index',
                        timestamp: new Date().toISOString()
                    }
                }
            })
        });
        
        const response1 = await lambdaClient.send(command1);
        const result1 = JSON.parse(new TextDecoder().decode(response1.Payload));
        console.log('Result:', JSON.stringify(result1, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    console.log('\n2. Testing createDocumentGraph with flat params (current implementation):');
    try {
        const command2 = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: testDocId + '_flat',
                metadata: {
                    title: 'Test Document Flat',
                    author: 'Test Author',
                    pages: 10,
                    totalChunks: 5,
                    indexName: 'test-index-flat',
                    timestamp: new Date().toISOString()
                }
            })
        });
        
        const response2 = await lambdaClient.send(command2);
        const result2 = JSON.parse(new TextDecoder().decode(response2.Payload));
        console.log('Result:', JSON.stringify(result2, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    console.log('\n3. Testing createChunkGraph with nested params:');
    const testChunkId = `chunk_test_${Date.now()}_0`;
    try {
        const command3 = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                params: {
                    chunkId: testChunkId,
                    documentId: testDocId,
                    chunkIndex: 0,
                    content: 'Test chunk content',
                    summary: 'Test summary',
                    metadata: {
                        pageStart: 1,
                        pageEnd: 1,
                        chunkIndex: 0,
                        totalChunks: 5
                    }
                }
            })
        });
        
        const response3 = await lambdaClient.send(command3);
        const result3 = JSON.parse(new TextDecoder().decode(response3.Payload));
        console.log('Result:', JSON.stringify(result3, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    console.log('\n4. Testing createChunkGraph with flat params (current implementation):');
    try {
        const command4 = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunkId: testChunkId + '_flat',
                documentId: testDocId + '_flat',
                chunkIndex: 0,
                content: 'Test chunk content flat',
                summary: 'Test summary flat',
                metadata: {
                    pageStart: 1,
                    pageEnd: 1,
                    chunkIndex: 0,
                    totalChunks: 5
                }
            })
        });
        
        const response4 = await lambdaClient.send(command4);
        const result4 = JSON.parse(new TextDecoder().decode(response4.Payload));
        console.log('Result:', JSON.stringify(result4, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    console.log('\n5. Testing explore operation to verify connections:');
    try {
        const command5 = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'explore'
            })
        });
        
        const response5 = await lambdaClient.send(command5);
        const result5 = JSON.parse(new TextDecoder().decode(response5.Payload));
        console.log('Current graph state - Vertices:', result5.nodeCount, 'Edges:', result5.edgeCount);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testLambdaOperations().catch(console.error);