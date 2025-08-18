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

async function testLambdaDebug() {
    console.log('Debugging Lambda function parameter expectations...\n');
    
    // First, let's see what operations are available
    console.log('1. Testing with no operation (should list available operations):');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({})
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test with invalid operation to see error message
    console.log('\n2. Testing with invalid operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'invalid_operation'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try minimal createDocumentGraph
    console.log('\n3. Testing createDocumentGraph with minimal params:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                documentId: 'test_doc_minimal'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try with different field names
    console.log('\n4. Testing createDocumentGraph with docId instead of documentId:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                docId: 'test_doc_docId',
                metadata: {
                    title: 'Test'
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try with id field
    console.log('\n5. Testing createDocumentGraph with id field:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                id: 'test_doc_id',
                metadata: {
                    title: 'Test'
                }
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Try with document field
    console.log('\n6. Testing createDocumentGraph with document object:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createDocumentGraph',
                document: {
                    id: 'test_doc_object',
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
}

testLambdaDebug().catch(console.error);