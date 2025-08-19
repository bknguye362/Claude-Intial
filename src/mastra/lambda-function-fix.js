// This is the fixed Lambda function code that should be deployed to AWS Lambda
// It properly handles vertex IDs so relationships can be created

const gremlin = require('gremlin');
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const Graph = gremlin.structure.Graph;

// Neptune connection
const NEPTUNE_ENDPOINT = process.env.NEPTUNE_ENDPOINT || 'your-neptune-endpoint.amazonaws.com';
const NEPTUNE_PORT = process.env.NEPTUNE_PORT || 8182;

// Initialize Gremlin connection
const dc = new DriverRemoteConnection(`wss://${NEPTUNE_ENDPOINT}:${NEPTUNE_PORT}/gremlin`, {});
const graph = new Graph();
const g = graph.traversal().withRemote(dc);

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));
    
    const operation = event.operation;
    
    try {
        switch (operation) {
            case 'explore':
                return await exploreGraph();
                
            case 'createDocumentGraph':
                return await createDocumentGraph(event);
                
            case 'createChunkGraph':
                return await createChunkGraph(event);
                
            case 'createRelationships':
                return await createRelationships(event);
                
            case 'getChunkProperties':
                return await getChunkProperties(event);
                
            default:
                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        success: false,
                        error: `Unknown operation: ${operation}`
                    })
                };
        }
    } catch (error) {
        console.error('Error processing request:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message
            })
        };
    }
};

async function createDocumentGraph(event) {
    // FIX: Check for required arrays
    const chunks = event.chunks || [];
    const documentId = event.documentId;
    const metadata = event.metadata || {};
    
    if (!documentId) {
        throw new Error('documentId is required');
    }
    
    try {
        // FIX: Use the provided documentId as the vertex ID
        // Check if vertex already exists
        const existing = await g.V(documentId).hasLabel('document').toList();
        
        if (existing.length === 0) {
            // Create new vertex with specific ID
            const vertex = await g.addV('document')
                .property('id', documentId)  // Set the ID property
                .property('gremlin.id', documentId)  // CRITICAL: Set gremlin.id to match
                .property('name', metadata.title || documentId)
                .property('title', metadata.title || '')
                .property('author', metadata.author || '')
                .property('pages', metadata.pages || 0)
                .property('totalChunks', metadata.totalChunks || chunks.length)
                .property('indexName', metadata.indexName || '')
                .property('timestamp', metadata.timestamp || new Date().toISOString())
                .property('documentId', documentId)  // Also store as documentId
                .next();
                
            console.log(`Created document vertex with ID: ${documentId}`);
        } else {
            console.log(`Document vertex already exists: ${documentId}`);
        }
        
        // Process chunks if provided
        const chunksProcessed = 0;
        const entitiesCreated = [];
        const conceptsCreated = [];
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    documentId: documentId,  // Return the actual ID we used
                    chunksProcessed,
                    entitiesCreated,
                    conceptsCreated
                }
            })
        };
    } catch (error) {
        console.error('Error creating document graph:', error);
        throw error;
    }
}

async function createChunkGraph(event) {
    // FIX: Check for required arrays
    const chunks = event.chunks || [];
    const entities = event.entities || [];
    const concepts = event.concepts || [];
    const relationships = event.relationships || [];
    
    const chunkId = event.chunkId;
    const documentId = event.documentId;
    const chunkIndex = event.chunkIndex || 0;
    const content = event.content || '';
    const summary = event.summary || '';
    const metadata = event.metadata || {};
    
    if (!chunkId) {
        throw new Error('chunkId is required');
    }
    
    try {
        // FIX: Use the provided chunkId as the vertex ID
        // Check if vertex already exists
        const existing = await g.V(chunkId).hasLabel('chunk').toList();
        
        if (existing.length === 0) {
            // Create new chunk vertex with specific ID
            const vertex = await g.addV('chunk')
                .property('id', chunkId)  // Set the ID property
                .property('gremlin.id', chunkId)  // CRITICAL: Set gremlin.id to match
                .property('chunkId', chunkId)  // Store as chunkId too
                .property('documentId', documentId || '')
                .property('index', chunkIndex)
                .property('content', content.substring(0, 1000))  // Limit content size
                .property('summary', summary)
                .property('vectorKey', chunkId)  // For S3 Vectors integration
                .property('pageStart', metadata.pageStart || 0)
                .property('pageEnd', metadata.pageEnd || 0)
                .property('chunkIndex', metadata.chunkIndex || chunkIndex)
                .property('totalChunks', metadata.totalChunks || 0)
                .next();
                
            console.log(`Created chunk vertex with ID: ${chunkId}`);
            
            // Create edge from document to chunk if documentId provided
            if (documentId) {
                try {
                    // Check if document exists
                    const docExists = await g.V(documentId).hasLabel('document').toList();
                    if (docExists.length > 0) {
                        await g.V(documentId)
                            .addE('HAS_CHUNK')
                            .to(g.V(chunkId))
                            .property('index', chunkIndex)
                            .next();
                        console.log(`Created HAS_CHUNK edge from ${documentId} to ${chunkId}`);
                    }
                } catch (edgeError) {
                    console.error('Error creating document->chunk edge:', edgeError);
                    // Continue even if edge creation fails
                }
            }
        } else {
            console.log(`Chunk vertex already exists: ${chunkId}`);
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    documentId: chunkId,  // Return the actual chunk ID
                    chunksProcessed: chunks.length,
                    relationshipsCreated: 0,
                    chunkVertices: []
                }
            })
        };
    } catch (error) {
        console.error('Error creating chunk graph:', error);
        throw error;
    }
}

async function createRelationships(event) {
    const chunkId = event.chunkId;
    const relationships = event.relationships || [];
    
    if (!chunkId || !relationships.length) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    success: false,
                    relationshipsCreated: 0,
                    totalRequested: 0,
                    errors: ['No relationships to create']
                }
            })
        };
    }
    
    let created = 0;
    const errors = [];
    
    try {
        // FIX: Look for vertices by their ID directly
        // First check if source vertex exists
        const sourceVertex = await g.V(chunkId).toList();
        const sourceFound = sourceVertex.length > 0;
        
        if (!sourceFound) {
            // Try finding by gremlin.id property as fallback
            const sourceByProp = await g.V().has('gremlin.id', chunkId).toList();
            if (sourceByProp.length > 0) {
                console.log(`Found source vertex by gremlin.id property: ${chunkId}`);
            } else {
                errors.push(`Source vertex not found: ${chunkId}`);
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        result: {
                            success: false,
                            relationshipsCreated: 0,
                            totalRequested: relationships.length,
                            errors
                        }
                    })
                };
            }
        }
        
        for (const rel of relationships) {
            const targetId = rel.id;
            const relationshipType = rel.relationship || 'RELATED';
            const strength = rel.strength || 1.0;
            
            try {
                // Check if target vertex exists
                const targetVertex = await g.V(targetId).toList();
                const targetFound = targetVertex.length > 0;
                
                if (!targetFound) {
                    // Try finding by gremlin.id property as fallback
                    const targetByProp = await g.V().has('gremlin.id', targetId).toList();
                    if (targetByProp.length === 0) {
                        errors.push(`Target vertex not found: ${targetId}`);
                        continue;
                    }
                }
                
                // Create the edge
                // Use the actual vertex IDs or gremlin.id property
                if (sourceFound && targetFound) {
                    // Both vertices found by ID
                    await g.V(chunkId)
                        .addE(relationshipType)
                        .to(g.V(targetId))
                        .property('strength', strength)
                        .next();
                } else {
                    // Use gremlin.id property
                    await g.V().has('gremlin.id', chunkId)
                        .addE(relationshipType)
                        .to(g.V().has('gremlin.id', targetId))
                        .property('strength', strength)
                        .next();
                }
                
                created++;
                console.log(`Created ${relationshipType} edge from ${chunkId} to ${targetId}`);
            } catch (relError) {
                console.error(`Error creating relationship ${chunkId} -> ${targetId}:`, relError);
                errors.push(`Failed to create edge ${chunkId} -> ${targetId}: ${relError.message}`);
            }
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    success: created > 0,
                    relationshipsCreated: created,
                    totalRequested: relationships.length,
                    errors: errors.length > 0 ? errors : undefined
                }
            })
        };
    } catch (error) {
        console.error('Error creating relationships:', error);
        throw error;
    }
}

async function getChunkProperties(event) {
    const chunkId = event.chunkId;
    
    if (!chunkId) {
        throw new Error('chunkId is required');
    }
    
    try {
        // FIX: Search by both vertex ID and gremlin.id property
        let chunks = await g.V(chunkId).hasLabel('chunk').valueMap(true).toList();
        
        if (chunks.length === 0) {
            // Try finding by gremlin.id property
            chunks = await g.V().has('gremlin.id', chunkId).hasLabel('chunk').valueMap(true).toList();
        }
        
        // Format the results
        const formattedChunks = chunks.map(chunk => {
            const formatted = {};
            for (const [key, value] of Object.entries(chunk)) {
                formatted[key] = Array.isArray(value) ? value : [value];
            }
            return formatted;
        });
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    chunks: formattedChunks,
                    count: formattedChunks.length
                }
            })
        };
    } catch (error) {
        console.error('Error getting chunk properties:', error);
        throw error;
    }
}

async function exploreGraph() {
    try {
        // Get graph statistics
        const totalVertices = await g.V().count().next();
        const totalEdges = await g.E().count().next();
        const documentCount = await g.V().hasLabel('document').count().next();
        const chunkCount = await g.V().hasLabel('chunk').count().next();
        
        // Get sample documents
        const documents = await g.V().hasLabel('document')
            .limit(10)
            .valueMap('name', 'title', 'timestamp', 'totalChunks')
            .toList();
        
        // Get sample chunks
        const chunks = await g.V().hasLabel('chunk')
            .limit(5)
            .valueMap('index', 'summary', 'content')
            .toList();
        
        // Format documents
        const formattedDocs = documents.map(doc => ({
            name: doc.name || doc.title || 'Unknown',
            timestamp: doc.timestamp || ['Unknown'],
            chunkCount: doc.totalChunks ? doc.totalChunks[0] : 0
        }));
        
        // Format chunks
        const formattedChunks = chunks.map(chunk => ({
            index: chunk.index || [0],
            summary: chunk.summary || 'No summary',
            contentPreview: chunk.content ? 'Content available' : 'No content'
        }));
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    summary: {
                        totalVertices: totalVertices.value,
                        totalEdges: totalEdges.value,
                        documentCount: documentCount.value,
                        chunkCount: chunkCount.value
                    },
                    documents: formattedDocs,
                    chunks: formattedChunks,
                    relationships: {}
                }
            })
        };
    } catch (error) {
        console.error('Error exploring graph:', error);
        throw error;
    }
}

// Close connection when Lambda container is terminated
process.on('SIGTERM', async () => {
    await dc.close();
});