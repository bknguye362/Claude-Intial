// Add these functions to your Lambda function for entity operations

async function createEntityNode(event) {
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
                    .to(g.V().has('gremlin.id', entityId))
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

async function createEntityRelationship(event) {
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
            .to(g.V().has('gremlin.id', toEntity))
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

// Query entities by type
async function queryEntitiesByType(event) {
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

// Get entity relationships
async function getEntityRelationships(event) {
    const entityId = event.entityId;
    
    if (!entityId) {
        throw new Error('entityId is required');
    }
    
    try {
        // Get outgoing relationships
        const outgoing = await g.V().has('gremlin.id', entityId)
            .outE()
            .project('type', 'to', 'confidence')
            .by(label)
            .by(inV().values('name'))
            .by(values('confidence'))
            .toList();
            
        // Get incoming relationships
        const incoming = await g.V().has('gremlin.id', entityId)
            .inE()
            .project('type', 'from', 'confidence')
            .by(label)
            .by(outV().values('name'))
            .by(values('confidence'))
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

// Add these cases to your Lambda handler's switch statement:
case 'createEntityNode':
    return await createEntityNode(event);
    
case 'createEntityRelationship':
    return await createEntityRelationship(event);
    
case 'queryEntitiesByType':
    return await queryEntitiesByType(event);
    
case 'getEntityRelationships':
    return await getEntityRelationships(event);