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
        return null;
    }
}

async function clearNeptuneGraph() {
    console.log('=== Neptune Graph Clear ===\n');
    
    // First, check current state
    console.log('1. Checking current graph state:');
    const exploreResult = await invokeLambda({
        operation: 'explore'
    });
    
    if (exploreResult && exploreResult.statusCode === 200) {
        const body = JSON.parse(exploreResult.body);
        console.log(`   Current vertices: ${body.result.summary.totalVertices}`);
        console.log(`   Current edges: ${body.result.summary.totalEdges}`);
        console.log(`   Entities: ${body.result.summary.entityCount}`);
        console.log(`   Documents: ${body.result.summary.documentCount}`);
        console.log(`   Chunks: ${body.result.summary.chunkCount}`);
    }
    
    console.log('\n2. Clearing ALL graph data...');
    console.log('   WARNING: This will delete all entities, relationships, documents, and chunks!');
    
    const clearResult = await invokeLambda({
        operation: 'clearAllGraph',
        confirmationToken: 'DELETE_ALL_GRAPH_DATA'
    });
    
    if (clearResult && clearResult.statusCode === 200) {
        const body = JSON.parse(clearResult.body);
        console.log('\n✓ Graph cleared successfully!');
        console.log(`   Deleted ${body.result.deletedVertices} vertices`);
        console.log(`   Deleted ${body.result.deletedEdges} edges`);
    } else {
        console.error('\n✗ Failed to clear graph');
        if (clearResult) {
            console.error('   Response:', clearResult);
        }
    }
    
    // Verify the graph is empty
    console.log('\n3. Verifying graph is empty:');
    const verifyResult = await invokeLambda({
        operation: 'explore'
    });
    
    if (verifyResult && verifyResult.statusCode === 200) {
        const body = JSON.parse(verifyResult.body);
        console.log(`   Remaining vertices: ${body.result.summary.totalVertices}`);
        console.log(`   Remaining edges: ${body.result.summary.totalEdges}`);
        
        if (body.result.summary.totalVertices === 0 && body.result.summary.totalEdges === 0) {
            console.log('\n✓ Graph is now completely empty!');
        } else {
            console.log('\n⚠️  Some data may still remain in the graph');
        }
    }
}

clearNeptuneGraph().catch(console.error);