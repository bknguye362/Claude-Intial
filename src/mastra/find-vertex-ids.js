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

async function findVertexIds() {
    console.log('Finding actual vertex IDs in Neptune...\n');
    
    // First, let's create a test document and capture the returned ID
    console.log('1. Creating a test document and tracking the returned ID:');
    const testDocId = `doc_id_test_${Date.now()}`;
    
    const docResult = await invokeLambda({
        operation: 'createDocumentGraph',
        chunks: [],
        documentId: testDocId,
        metadata: {
            title: 'ID Test Document',
            author: 'ID Finder',
            testId: testDocId  // Store our ID in metadata to find it later
        }
    });
    
    console.log('Document creation result:', JSON.stringify(docResult, null, 2));
    
    if (docResult.statusCode === 200) {
        const body = JSON.parse(docResult.body);
        const generatedDocId = body.result.documentId;
        console.log('\nOur document ID:', testDocId);
        console.log('Lambda generated ID:', generatedDocId);
        
        // Now create a chunk and track its ID
        console.log('\n2. Creating a test chunk and tracking the returned ID:');
        const testChunkId = `chunk_id_test_${Date.now()}_0`;
        
        const chunkResult = await invokeLambda({
            operation: 'createChunkGraph',
            chunks: [],
            entities: [],
            concepts: [],
            relationships: [],
            chunkId: testChunkId,
            documentId: testDocId,  // Use our document ID
            chunkIndex: 0,
            content: 'Test chunk for ID discovery',
            summary: 'ID test chunk',
            metadata: {
                testChunkId: testChunkId,  // Store our ID in metadata
                lambdaDocId: generatedDocId  // Store the Lambda's doc ID
            }
        });
        
        console.log('Chunk creation result:', JSON.stringify(chunkResult, null, 2));
        
        if (chunkResult.statusCode === 200) {
            const chunkBody = JSON.parse(chunkResult.body);
            const generatedChunkId = chunkBody.result.documentId; // Note: Lambda returns 'documentId' even for chunks
            console.log('\nOur chunk ID:', testChunkId);
            console.log('Lambda generated chunk ID:', generatedChunkId);
            
            // Try to use the Lambda-generated IDs for relationships
            console.log('\n3. Testing if we can use Lambda-generated IDs for relationships:');
            
            // Create another chunk with Lambda's ID system
            const chunk2Result = await invokeLambda({
                operation: 'createChunkGraph',
                chunks: [],
                entities: [],
                concepts: [],
                relationships: [],
                chunkId: `chunk_2_${Date.now()}`,
                documentId: generatedDocId,  // Try using Lambda's doc ID
                chunkIndex: 1,
                content: 'Second test chunk',
                summary: 'Second chunk'
            });
            
            if (chunk2Result.statusCode === 200) {
                const chunk2Body = JSON.parse(chunk2Result.body);
                const generatedChunk2Id = chunk2Body.result.documentId;
                console.log('Second chunk Lambda ID:', generatedChunk2Id);
                
                // Try to create a relationship using Lambda's IDs
                console.log('\n4. Attempting to create relationship with Lambda IDs:');
                const relResult = await invokeLambda({
                    operation: 'createRelationships',
                    chunkId: generatedChunkId,
                    relationships: [{
                        id: generatedChunk2Id,
                        relationship: 'PRECEDES',
                        strength: 1.0
                    }]
                });
                
                console.log('Relationship result:', JSON.stringify(relResult, null, 2));
            }
        }
    }
    
    // Check if there's a way to query vertices by our custom IDs
    console.log('\n5. Checking if we can find vertices by properties:');
    
    // Try the getChunkProperties operation with different IDs
    const propResult = await invokeLambda({
        operation: 'getChunkProperties',
        chunkId: 'test-chunk-1'  // One of our old test chunks
    });
    
    console.log('Properties result:', JSON.stringify(propResult, null, 2));
    
    // Explore to see all vertex details
    console.log('\n6. Exploring graph for detailed vertex information:');
    const exploreResult = await invokeLambda({
        operation: 'explore'
    });
    
    if (exploreResult.statusCode === 200) {
        const body = JSON.parse(exploreResult.body);
        console.log('Total vertices:', body.result.summary.totalVertices);
        console.log('Recent documents with details:', JSON.stringify(body.result.documents.slice(0, 3), null, 2));
        console.log('Chunks with details:', JSON.stringify(body.result.chunks.slice(0, 3), null, 2));
    }
}

findVertexIds().catch(console.error);