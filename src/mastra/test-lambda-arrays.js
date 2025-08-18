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

async function testLambdaArrays() {
    console.log('Testing if Lambda expects arrays or batch operations...\n');
    
    // Test with arrays of documents
    console.log('1. Testing createDocumentGraph with documents array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documents: [{
                    documentId: 'test_doc_array_1',
                    metadata: {
                        title: 'Test Document 1',
                        author: 'Test Author'
                    }
                }]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with nodes array
    console.log('\n2. Testing createDocumentGraph with nodes array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                nodes: [{
                    id: 'test_doc_nodes_1',
                    label: 'document',
                    properties: {
                        title: 'Test Document',
                        author: 'Test Author'
                    }
                }]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test createChunkGraph with chunks array
    console.log('\n3. Testing createChunkGraph with chunks array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunks: [{
                    chunkId: 'test_chunk_array_1',
                    documentId: 'test_doc_1',
                    chunkIndex: 0,
                    content: 'Test content',
                    summary: 'Test summary'
                }]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with empty arrays
    console.log('\n4. Testing createDocumentGraph with empty documents array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documents: []
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with properties array format (Gremlin style)
    console.log('\n5. Testing createDocumentGraph with Gremlin property format:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: 'test_doc_gremlin',
                properties: [
                    ['title', 'Test Document'],
                    ['author', 'Test Author'],
                    ['pages', 10]
                ]
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testLambdaArrays().catch(console.error);