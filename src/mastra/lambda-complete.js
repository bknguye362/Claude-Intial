const gremlin = require('gremlin');
const __ = gremlin.process.statics;
const T = gremlin.process.T;

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
            
            // Entity operations
            case 'createEntityNode':
                return await createEntityNode(event, g);
            case 'createEntityRelationship':
                return await createEntityRelationship(event, g);
            case 'queryEntitiesByType':
                return await queryEntitiesByType(event, g);
            case 'getEntityRelationships':
                return await getEntityRelationships(event, g);
            
            // Document operations
            case 'clearByDocumentId':
                return await clearByDocumentId(event, g);
            
            // Batch operations for rate limit optimization
            case 'createEntityChunkRelationshipsBatch':
                return await createEntityChunkRelationshipsBatch(event, g);
            
            // Batch entity and relationship creation
            case 'createEntities':
                return await createEntitiesBatch(event, g);
            case 'createRelationshipsBatch':
                return await createRelationshipsBatch(event, g);
                
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
                .to(__.V().has('gremlin.id', chunkId))
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
                .to(__.V().has('gremlin.id', rel.id))
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
        const entityCount = await g.V().hasLabel('entity').count().next();
        
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
                        chunkCount: chunkCount.value,
                        entityCount: entityCount.value
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

// ENTITY OPERATIONS

async function createEntityNode(event, g) {
    const entityId = event.entityId;
    const entityType = event.entityType;
    const name = event.name;
    const properties = event.properties || {};
    const documentId = event.documentId;
    const indexName = event.indexName;  // S3 Vector index name
    
    if (!entityId || !entityType || !name) {
        throw new Error('entityId, entityType, and name are required');
    }
    
    try {
        // Create entity vertex with proper gremlin.id
        const vertex = await g.addV('entity')
            .property('gremlin.id', entityId)  // Set gremlin.id for finding
            .property('entityId', entityId)
            .property('entityType', entityType)
            .property('name', name)
            .property('documentId', documentId || '')
            .property('indexName', indexName || '')  // Link to S3 index
            // Add all custom properties
            .property('sourceChunks', JSON.stringify(properties.sourceChunks || []))
            .property('description', properties.description || '')
            .property('context', properties.context || '')
            .property('timestamp', new Date().toISOString())
            .next();
            
        console.log(`Created entity vertex: ${name} (${entityType})`);
        
        // Create edge from document to entity if documentId provided
        if (documentId) {
            try {
                await g.V().has('gremlin.id', documentId)
                    .addE('HAS_ENTITY')
                    .to(__.V().has('gremlin.id', entityId))
                    .property('entityType', entityType)
                    .next();
                console.log(`Created HAS_ENTITY edge from document to ${name}`);
            } catch (edgeError) {
                console.error('Error creating document->entity edge:', edgeError);
            }
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    entityId: entityId,
                    created: true
                }
            })
        };
    } catch (error) {
        console.error('Error creating entity node:', error);
        throw error;
    }
}

async function createEntityRelationship(event, g) {
    const fromEntity = event.fromEntity;
    const toEntity = event.toEntity;
    const relationshipType = event.relationshipType || 'RELATED_TO';
    const properties = event.properties || {};
    const confidence = event.confidence || 0.8;
    
    if (!fromEntity || !toEntity) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: false,
                error: 'fromEntity and toEntity are required'
            })
        };
    }
    
    try {
        // Check if entities exist
        const fromVertex = await g.V().has('gremlin.id', fromEntity).toList();
        const toVertex = await g.V().has('gremlin.id', toEntity).toList();
        
        if (fromVertex.length === 0 || toVertex.length === 0) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: false,
                    error: `Entities not found: from=${fromVertex.length > 0}, to=${toVertex.length > 0}`
                })
            };
        }
        
        // Create the relationship
        await g.V().has('gremlin.id', fromEntity)
            .addE(relationshipType)
            .to(__.V().has('gremlin.id', toEntity))
            .property('confidence', confidence)
            .property('crossChunk', properties.crossChunk || false)
            .property('timestamp', new Date().toISOString())
            .next();
            
        console.log(`Created ${relationshipType} relationship from ${fromEntity} to ${toEntity}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    created: true,
                    relationshipType: relationshipType
                }
            })
        };
    } catch (error) {
        console.error('Error creating entity relationship:', error);
        throw error;
    }
}

async function queryEntitiesByType(event, g) {
    const entityType = event.entityType;
    const limit = event.limit || 100;
    
    try {
        let query = g.V().hasLabel('entity');
        
        if (entityType) {
            query = query.has('entityType', entityType);
        }
        
        const entities = await query
            .limit(limit)
            .valueMap('entityId', 'name', 'entityType', 'description')
            .toList();
            
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    entities: entities,
                    count: entities.length
                }
            })
        };
    } catch (error) {
        console.error('Error querying entities:', error);
        throw error;
    }
}

async function getEntityRelationships(event, g) {
    const entityId = event.entityId;
    
    if (!entityId) {
        throw new Error('entityId is required');
    }
    
    try {
        // Get outgoing relationships
        const outgoing = await g.V().has('entityId', entityId)
            .outE()
            .project('type', 'to', 'confidence')
            .by(T.label)
            .by(__.inV().values('name'))
            .by(__.values('confidence'))
            .toList();
            
        // Get incoming relationships
        const incoming = await g.V().has('entityId', entityId)
            .inE()
            .project('type', 'from', 'confidence')
            .by(T.label)
            .by(__.outV().values('name'))
            .by(__.values('confidence'))
            .toList();
            
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    entityId: entityId,
                    outgoing: outgoing,
                    incoming: incoming,
                    totalRelationships: outgoing.length + incoming.length
                }
            })
        };
    } catch (error) {
        console.error('Error getting entity relationships:', error);
        throw error;
    }
}

// DOCUMENT OPERATIONS

async function clearByDocumentId(event, g) {
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

// BATCH OPERATIONS FOR RATE LIMIT OPTIMIZATION

async function createEntityChunkRelationshipsBatch(event, g) {
    const relationships = event.relationships || [];
    
    if (!relationships || relationships.length === 0) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    created: 0,
                    message: 'No relationships to create'
                }
            })
        };
    }
    
    let successCount = 0;
    let failCount = 0;
    const errors = [];
    
    console.log(`Creating batch of ${relationships.length} entity-chunk relationships...`);
    
    for (const rel of relationships) {
        try {
            // Create APPEARS_IN edge from entity to chunk
            await g.V().has('gremlin.id', rel.entityId)
                .addE('APPEARS_IN')
                .to(__.V().has('gremlin.id', rel.chunkId))
                .property('timestamp', new Date().toISOString())
                .next();
            
            successCount++;
        } catch (error) {
            console.error(`Failed to create relationship ${rel.entityId} -> ${rel.chunkId}:`, error.message);
            failCount++;
            errors.push(`${rel.entityId} -> ${rel.chunkId}: ${error.message}`);
        }
    }
    
    console.log(`Batch complete: ${successCount} created, ${failCount} failed`);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            result: {
                created: successCount,
                failed: failCount,
                total: relationships.length,
                errors: errors.length > 0 ? errors.slice(0, 10) : undefined // Limit error messages
            }
        })
    };
}

async function createEntitiesBatch(event, g) {
    const entities = event.entities || [];
    
    if (!entities || entities.length === 0) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    created: 0,
                    message: 'No entities to create'
                }
            })
        };
    }
    
    let successCount = 0;
    let failCount = 0;
    
    console.log(`Creating batch of ${entities.length} entities...`);
    
    for (const entity of entities) {
        try {
            // Check if entity already exists
            const exists = await g.V().has('gremlin.id', entity.entityId).hasNext();
            if (exists) {
                console.log(`Entity ${entity.entityId} already exists, skipping`);
                continue;
            }
            
            // Create entity vertex
            await g.addV('entity')
                .property('gremlin.id', entity.entityId)
                .property('entityId', entity.entityId)
                .property('entityType', entity.type)
                .property('name', entity.name)
                .property('indexName', entity.properties?.indexName || '')
                .property('description', entity.properties?.description || '')
                .property('sourceChunks', JSON.stringify(entity.properties?.sourceChunks || []))
                .property('timestamp', new Date().toISOString())
                .next();
            
            successCount++;
        } catch (error) {
            console.error(`Failed to create entity ${entity.name}:`, error.message);
            failCount++;
        }
    }
    
    console.log(`Batch complete: ${successCount} created, ${failCount} failed`);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            result: {
                created: successCount,
                failed: failCount,
                total: entities.length
            }
        })
    };
}

async function createRelationshipsBatch(event, g) {
    const relationships = event.relationships || [];
    
    if (!relationships || relationships.length === 0) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    created: 0,
                    message: 'No relationships to create'
                }
            })
        };
    }
    
    let successCount = 0;
    let failCount = 0;
    
    console.log(`Creating batch of ${relationships.length} entity relationships...`);
    
    for (const rel of relationships) {
        try {
            // Check if entities exist
            const fromExists = await g.V().has('gremlin.id', rel.fromEntityId).hasNext();
            const toExists = await g.V().has('gremlin.id', rel.toEntityId).hasNext();
            
            if (!fromExists || !toExists) {
                console.log(`Entities not found for relationship: from=${fromExists}, to=${toExists}`);
                failCount++;
                continue;
            }
            
            // Create relationship
            await g.V().has('gremlin.id', rel.fromEntityId)
                .addE(rel.relationshipType || 'RELATED_TO')
                .to(__.V().has('gremlin.id', rel.toEntityId))
                .property('confidence', rel.confidence || 0.8)
                .property('crossChunk', rel.properties?.crossChunk || false)
                .property('timestamp', new Date().toISOString())
                .next();
            
            successCount++;
        } catch (error) {
            console.error(`Failed to create relationship:`, error.message);
            failCount++;
        }
    }
    
    console.log(`Batch complete: ${successCount} created, ${failCount} failed`);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            result: {
                created: successCount,
                failed: failCount,
                total: relationships.length
            }
        })
    };
}