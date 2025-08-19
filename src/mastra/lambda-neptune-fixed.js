const gremlin = require('gremlin');

const NEPTUNE_ENDPOINT = process.env.NEPTUNE_ENDPOINT || 'your-neptune-cluster.cluster-xxxxx.us-east-2.neptune.amazonaws.com';
const NEPTUNE_PORT = process.env.NEPTUNE_PORT || 8182;

// Lambda-compatible gremlin connection
function getGremlinConnection() {
    return new gremlin.driver.DriverRemoteConnection(
        `wss://${NEPTUNE_ENDPOINT}:${NEPTUNE_PORT}/gremlin`,
        {
            mimeType: 'application/vnd.gremlin-v2.0+json',
            rejectUnauthorized: false,
            headers: {},
            // Key Lambda fixes:
            pingEnabled: false,  // Disable WebSocket ping
            pongTimeout: 0,      // No pong timeout
            connectOnStartup: false  // Don't connect until needed
        }
    );
}

// Create a new connection for each invocation
function getGraphTraversal() {
    const connection = getGremlinConnection();
    return gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection);
}

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));
    
    const operation = event.operation;
    let g;
    let connection;
    
    try {
        // Create fresh connection for this invocation
        connection = getGremlinConnection();
        g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection);
        
        switch (operation) {
            case 'createDocumentGraph':
                return await createDocumentGraph(event, g);
            case 'createChunkGraph':
                return await createChunkGraph(event, g);
            case 'createRelationships':
                return await createRelationships(event, g);
            case 'explore':
                return await exploreGraph(g);
            case 'getChunkProperties':
                return await getChunkProperties(event, g);
            case 'clearAllGraph':
                return await clearAllGraph(event, g);
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
        console.error('Handler error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message || 'Internal server error'
            })
        };
    } finally {
        // Clean up connection
        if (connection) {
            try {
                await connection.close();
            } catch (e) {
                console.error('Error closing connection:', e);
            }
        }
    }
};

// Pass g as parameter to all functions
async function createDocumentGraph(event, g) {
    const documentId = event.documentId;
    const metadata = event.metadata || {};
    const chunks = event.chunks || [];
    
    if (!documentId) {
        throw new Error('documentId is required');
    }
    
    try {
        const vertex = await g.addV('document')
            .property('gremlin.id', documentId)
            .property('documentId', documentId)
            .property('title', metadata.title || '')
            .property('author', metadata.author || '')
            .property('indexName', metadata.indexName || documentId)
            .property('timestamp', new Date().toISOString())
            .next();
            
        console.log(`Created document vertex: ${documentId}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    documentId: documentId,
                    created: true
                }
            })
        };
    } catch (error) {
        console.error('Error creating document:', error);
        throw error;
    }
}

async function createChunkGraph(event, g) {
    const chunkId = event.chunkId;
    const documentId = event.documentId;
    const content = event.content || '';
    const summary = event.summary || '';
    const chunkIndex = event.chunkIndex || 0;
    
    const chunks = event.chunks || [];
    const entities = event.entities || [];
    const concepts = event.concepts || [];
    const relationships = event.relationships || [];
    
    if (!chunkId || !documentId) {
        throw new Error('chunkId and documentId are required');
    }
    
    try {
        const vertex = await g.addV('chunk')
            .property('gremlin.id', chunkId)
            .property('chunkId', chunkId)
            .property('documentId', documentId)
            .property('content', content.substring(0, 1000))
            .property('summary', summary)
            .property('chunkIndex', chunkIndex)
            .property('indexName', event.indexName || documentId)
            .property('timestamp', new Date().toISOString())
            .next();
            
        console.log(`Created chunk vertex: ${chunkId}`);
        
        try {
            await g.V().has('gremlin.id', documentId)
                .addE('HAS_CHUNK')
                .to(g.V().has('gremlin.id', chunkId))
                .property('chunkIndex', chunkIndex)
                .next();
            console.log(`Created HAS_CHUNK edge from ${documentId} to ${chunkId}`);
        } catch (edgeError) {
            console.error('Error creating edge:', edgeError);
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    chunkId: chunkId,
                    created: true
                }
            })
        };
    } catch (error) {
        console.error('Error creating chunk:', error);
        throw error;
    }
}

async function createRelationships(event, g) {
    const chunkId = event.chunkId;
    const relationships = event.relationships || [];
    
    if (!chunkId) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: false,
                error: 'chunkId is required'
            })
        };
    }
    
    let successCount = 0;
    const errors = [];
    
    for (const rel of relationships) {
        try {
            const fromExists = await g.V().has('gremlin.id', chunkId).hasNext();
            const toExists = await g.V().has('gremlin.id', rel.id).hasNext();
            
            if (!fromExists || !toExists) {
                errors.push(`Vertices not found: from=${fromExists}, to=${toExists} for ${chunkId} -> ${rel.id}`);
                continue;
            }
            
            await g.V().has('gremlin.id', chunkId)
                .addE(rel.relationship || 'RELATED_TO')
                .to(g.V().has('gremlin.id', rel.id))
                .property('strength', rel.strength || 0.5)
                .next();
                
            successCount++;
            console.log(`Created relationship from ${chunkId} to ${rel.id}`);
        } catch (error) {
            console.error(`Error creating relationship to ${rel.id}:`, error);
            errors.push(error.message);
        }
    }
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            result: {
                success: successCount > 0,
                relationshipsCreated: successCount,
                errors: errors.length > 0 ? errors : undefined
            }
        })
    };
}

async function exploreGraph(g) {
    try {
        const totalVertices = await g.V().count().next();
        const totalEdges = await g.E().count().next();
        const documentCount = await g.V().hasLabel('document').count().next();
        const chunkCount = await g.V().hasLabel('chunk').count().next();
        
        const recentDocs = await g.V().hasLabel('document')
            .order().by('timestamp', gremlin.process.order.desc)
            .limit(5)
            .valueMap('documentId', 'title')
            .toList();
        
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
                    recentDocuments: recentDocs
                }
            })
        };
    } catch (error) {
        console.error('Error exploring graph:', error);
        throw error;
    }
}

async function getChunkProperties(event, g) {
    const chunkId = event.chunkId;
    
    if (!chunkId) {
        throw new Error('chunkId is required');
    }
    
    try {
        const chunks = await g.V().has('gremlin.id', chunkId)
            .valueMap(true)
            .toList();
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    count: chunks.length,
                    chunks: chunks
                }
            })
        };
    } catch (error) {
        console.error('Error getting chunk properties:', error);
        throw error;
    }
}

async function clearAllGraph(event, g) {
    const confirmationToken = event.confirmationToken;
    
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
        const vertexCount = await g.V().count().next();
        const edgeCount = await g.E().count().next();
        
        await g.E().drop().iterate();
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