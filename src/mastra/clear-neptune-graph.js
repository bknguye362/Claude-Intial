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

async function clearNeptuneGraph() {
    console.log('=== Neptune Graph Cleanup ===\n');
    
    // First, check current state
    console.log('1. Checking current graph state:');
    const exploreResult = await invokeLambda({
        operation: 'explore'
    });
    
    if (exploreResult && exploreResult.statusCode === 200) {
        const body = JSON.parse(exploreResult.body);
        console.log(`   Current vertices: ${body.result.summary.totalVertices}`);
        console.log(`   Current edges: ${body.result.summary.totalEdges}`);
        console.log(`   Documents: ${body.result.summary.documentCount}`);
        console.log(`   Chunks: ${body.result.summary.chunkCount}`);
    }
    
    console.log('\n2. Available cleanup operations:');
    console.log('   a) Clear ALL nodes and edges (complete reset)');
    console.log('   b) Clear by document ID');
    console.log('   c) Clear by date range');
    console.log('   d) Clear test nodes only');
    console.log('   e) Clear orphaned nodes');
    
    // Add this operation to your Lambda function:
    console.log('\n3. To clear everything, add this to your Lambda:');
    console.log(`
async function clearAllGraph(event) {
    const confirmationToken = event.confirmationToken;
    
    // Safety check - require confirmation token
    if (confirmationToken !== 'DELETE_ALL_GRAPH_DATA') {
        return {
            statusCode: 400,
            body: JSON.stringify({
                success: false,
                error: 'Confirmation token required. Pass confirmationToken: "DELETE_ALL_GRAPH_DATA"'
            })
        };
    }
    
    try {
        // Count before deletion
        const vertexCount = await g.V().count().next();
        const edgeCount = await g.E().count().next();
        
        // Delete all edges first (required before deleting vertices)
        await g.E().drop().iterate();
        
        // Delete all vertices
        await g.V().drop().iterate();
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    message: 'Graph cleared successfully',
                    deletedVertices: vertexCount.value,
                    deletedEdges: edgeCount.value
                }
            })
        };
    } catch (error) {
        console.error('Error clearing graph:', error);
        throw error;
    }
}

async function clearByDocumentId(event) {
    const documentId = event.documentId;
    const indexName = event.indexName;
    
    if (!documentId && !indexName) {
        throw new Error('documentId or indexName required');
    }
    
    try {
        let deleteCount = 0;
        
        if (indexName) {
            // Delete by index name (preferred - gets everything)
            // First delete edges
            await g.V().has('indexName', indexName)
                .bothE()
                .drop()
                .iterate();
            
            // Then delete vertices
            const result = await g.V().has('indexName', indexName)
                .drop()
                .iterate();
            
            deleteCount = result.value || 0;
        } else {
            // Delete by document ID
            await g.V().has('documentId', documentId)
                .bothE()
                .drop()
                .iterate();
                
            const result = await g.V().has('documentId', documentId)
                .drop()
                .iterate();
                
            deleteCount = result.value || 0;
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    message: 'Document graph cleared',
                    deletedNodes: deleteCount
                }
            })
        };
    } catch (error) {
        console.error('Error clearing document graph:', error);
        throw error;
    }
}

async function clearTestNodes(event) {
    try {
        // Delete test nodes (nodes with IDs containing 'test')
        await g.V().has('gremlin.id', containing('test'))
            .bothE()
            .drop()
            .iterate();
            
        const result = await g.V().has('gremlin.id', containing('test'))
            .drop()
            .iterate();
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    message: 'Test nodes cleared'
                }
            })
        };
    } catch (error) {
        console.error('Error clearing test nodes:', error);
        throw error;
    }
}
    `);
    
    console.log('\n4. Direct Gremlin commands for manual cleanup:');
    console.log('   Clear everything:');
    console.log('   g.E().drop()  // Delete all edges first');
    console.log('   g.V().drop()  // Then delete all vertices');
    console.log('');
    console.log('   Clear specific document:');
    console.log("   g.V().has('indexName', 'file-xyz-2024').bothE().drop()");
    console.log("   g.V().has('indexName', 'file-xyz-2024').drop()");
    console.log('');
    console.log('   Clear test data:');
    console.log("   g.V().has('gremlin.id', containing('test')).drop()");
    console.log('');
    console.log('   Clear by date (older than 30 days):');
    console.log("   g.V().has('timestamp', lt('2024-12-01')).drop()");
}

clearNeptuneGraph().catch(console.error);