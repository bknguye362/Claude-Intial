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

async function testChunkFix() {
    console.log('Finding the right format for createChunkGraph...\n');
    
    // Maybe it needs relationships array
    console.log('1. Testing createChunkGraph with relationships array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                relationships: [],  // Empty array
                chunkId: 'test_chunk_rel',
                documentId: 'test_doc',
                content: 'Test content'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Maybe it needs entities array
    console.log('\n2. Testing createChunkGraph with entities array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                entities: [],  // Empty array
                chunkId: 'test_chunk_ent',
                documentId: 'test_doc',
                content: 'Test content'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Maybe it needs concepts array
    console.log('\n3. Testing createChunkGraph with concepts array:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                concepts: [],  // Empty array
                chunkId: 'test_chunk_con',
                documentId: 'test_doc',
                content: 'Test content'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try both entities and concepts
    console.log('\n4. Testing createChunkGraph with entities AND concepts arrays:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                entities: [],
                concepts: [],
                chunkId: 'test_chunk_both',
                documentId: 'test_doc',
                content: 'Test content'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try with all possible arrays
    console.log('\n5. Testing createChunkGraph with all arrays:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                chunks: [],
                entities: [],
                concepts: [],
                relationships: [],
                chunkId: 'test_chunk_all',
                documentId: 'test_doc',
                content: 'Test content'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Based on createDocumentGraph response, maybe it expects documentId field
    console.log('\n6. Testing createChunkGraph with documentId from successful response:');
    try {
        // First create a document
        const docCommand = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                chunks: [],
                documentId: 'test_doc_for_chunks',
                metadata: {
                    title: 'Test Document for Chunks'
                }
            })
        });
        
        const docResponse = await lambdaClient.send(docCommand);
        const docResult = JSON.parse(new TextDecoder().decode(docResponse.Payload));
        const createdDocId = JSON.parse(docResult.body).result.documentId;
        console.log('Created document with ID:', createdDocId);
        
        // Now try to add chunks using that ID
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createChunkGraph',
                documentId: createdDocId,  // Use the ID returned by createDocumentGraph
                chunks: [{
                    chunkId: 'test_chunk_with_doc',
                    chunkIndex: 0,
                    content: 'Test chunk content',
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
}

testChunkFix().catch(console.error);