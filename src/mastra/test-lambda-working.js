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

async function testWorkingFormat() {
    console.log('Testing the working format with chunks array...\n');
    
    // Test createDocumentGraph with chunks array and metadata
    console.log('1. Testing createDocumentGraph with chunks and full metadata:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                chunks: [],  // Required field!
                documentId: 'test_doc_with_chunks',
                metadata: {
                    title: 'Test Document with Chunks',
                    author: 'Test Author',
                    pages: 10,
                    totalChunks: 5,
                    indexName: 'test-index-chunks',
                    timestamp: new Date().toISOString()
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test createChunkGraph - maybe it also needs an array?
    console.log('\n2. Testing createChunkGraph with chunks array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunks: [{
                    chunkId: 'test_chunk_1',
                    documentId: 'test_doc_with_chunks',
                    chunkIndex: 0,
                    content: 'This is test chunk content',
                    summary: 'Test chunk summary'
                }]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with multiple chunks in array
    console.log('\n3. Testing createChunkGraph with multiple chunks:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunks: [
                    {
                        chunkId: 'test_chunk_2',
                        documentId: 'test_doc_with_chunks',
                        chunkIndex: 0,
                        content: 'First chunk content',
                        summary: 'First chunk'
                    },
                    {
                        chunkId: 'test_chunk_3',
                        documentId: 'test_doc_with_chunks',
                        chunkIndex: 1,
                        content: 'Second chunk content',
                        summary: 'Second chunk'
                    }
                ]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test createChunkGraph with empty chunks array
    console.log('\n4. Testing createChunkGraph with empty chunks array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunks: []
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Check what was created
    console.log('\n5. Exploring the graph to see what was created:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'explore'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Graph state:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testWorkingFormat().catch(console.error);