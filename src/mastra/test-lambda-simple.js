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

async function testSimpleParams() {
    console.log('Testing with very simple parameters - no arrays, no complex objects...\n');
    
    // Test with just strings, no metadata object
    console.log('1. Testing createDocumentGraph with only string parameters:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: 'test_doc_simple',
                title: 'Test Document',
                author: 'Test Author'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with empty metadata
    console.log('\n2. Testing createDocumentGraph with empty metadata:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: 'test_doc_empty_meta',
                metadata: {}
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with metadata but no totalChunks (which might be confused with length)
    console.log('\n3. Testing createDocumentGraph without totalChunks field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: 'test_doc_no_chunks',
                metadata: {
                    title: 'Test Document',
                    author: 'Test Author',
                    pages: 10,
                    indexName: 'test-index',
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
    
    // Test createChunkGraph with minimal params
    console.log('\n4. Testing createChunkGraph with minimal parameters:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunkId: 'test_chunk_simple',
                documentId: 'test_doc_simple'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test without content field (which we substring to limit length)
    console.log('\n5. Testing createChunkGraph without content field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunkId: 'test_chunk_no_content',
                documentId: 'test_doc_simple',
                chunkIndex: 0,
                summary: 'Test summary'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with very short content
    console.log('\n6. Testing createChunkGraph with very short content:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunkId: 'test_chunk_short',
                documentId: 'test_doc_simple',
                chunkIndex: 0,
                content: 'Hi',
                summary: 'Test'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testSimpleParams().catch(console.error);