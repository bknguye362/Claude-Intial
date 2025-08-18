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

async function testGenericOperations() {
    console.log('Testing generic graph operations that might work...\n');
    
    // Test createNode operation
    console.log('1. Testing createNode operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'createNode',
                id: 'test_node_1',
                label: 'document',
                properties: {
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
    
    // Test addVertex operation (Gremlin terminology)
    console.log('\n2. Testing addVertex operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'addVertex',
                id: 'test_vertex_1',
                label: 'document',
                properties: {
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
    
    // Test create operation (generic)
    console.log('\n3. Testing generic create operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'create',
                type: 'document',
                id: 'test_create_1',
                properties: {
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
    
    // Test upsert operation
    console.log('\n4. Testing upsert operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'upsert',
                type: 'document',
                id: 'test_upsert_1',
                properties: {
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
    
    // Test query operation to see what's in the graph
    console.log('\n5. Testing query operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'query',
                query: 'g.V().hasLabel("document").limit(5)',
                limit: 5
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test rawQuery operation
    console.log('\n6. Testing rawQuery operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'rawQuery',
                query: 'g.V().count()'
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    // Test gremlin operation
    console.log('\n7. Testing gremlin operation:');
    try {
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            Payload: JSON.stringify({
                operation: 'gremlin',
                query: `g.addV('document').property('id', 'test_gremlin_doc').property('title', 'Test Document')`
            })
        });
        
        const response = await lambdaClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.Payload));
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testGenericOperations().catch(console.error);