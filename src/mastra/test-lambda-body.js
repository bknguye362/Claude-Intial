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

async function testLambdaBody() {
    console.log('Testing different payload structures...\n');
    
    // Test with body field
    console.log('1. Testing createDocumentGraph with body field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                body: JSON.stringify({
                    operation: 'createDocumentGraph',
                    documentId: 'test_doc_body',
                    metadata: {
                        title: 'Test Document',
                        author: 'Test Author'
                    }
                })
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with event structure
    console.log('\n2. Testing createDocumentGraph with event structure:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                httpMethod: 'POST',
                body: JSON.stringify({
                    operation: 'createDocumentGraph',
                    documentId: 'test_doc_event',
                    metadata: {
                        title: 'Test Document',
                        author: 'Test Author'
                    }
                })
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with action field
    console.log('\n3. Testing createDocumentGraph with action field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                action: 'createDocumentGraph',
                documentId: 'test_doc_action',
                metadata: {
                    title: 'Test Document',
                    author: 'Test Author'
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with method field
    console.log('\n4. Testing createDocumentGraph with method field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                method: 'createDocumentGraph',
                documentId: 'test_doc_method',
                metadata: {
                    title: 'Test Document',
                    author: 'Test Author'
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with request field
    console.log('\n5. Testing createDocumentGraph with request field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                request: {
                    operation: 'createDocumentGraph',
                    documentId: 'test_doc_request',
                    metadata: {
                        title: 'Test Document',
                        author: 'Test Author'
                    }
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testLambdaBody().catch(console.error);