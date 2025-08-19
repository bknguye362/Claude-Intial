// Fixed Lambda function - just the key functions that need changes
// The existing Lambda structure stays the same, just update these functions

async function createDocumentGraph(event) {
    // Add default arrays to prevent "Cannot read properties of undefined (reading 'length')" error
    const chunks = event.chunks || [];
    const documentId = event.documentId;
    const metadata = event.metadata || {};
    
    try {
        // Create document vertex
        // KEY FIX: Add .property('gremlin.id', documentId)
        const vertex = await g.addV('document')
            .property('gremlin.id', documentId)  // <-- ADD THIS LINE
            .property('name', metadata.title || documentId)
            .property('title', metadata.title || '')
            .property('author', metadata.author || '')
            .property('pages', metadata.pages || 0)
            .property('totalChunks', metadata.totalChunks || chunks.length)
            .property('indexName', metadata.indexName || '')
            .property('timestamp', metadata.timestamp || new Date().toISOString())
            .property('documentId', documentId)
            .next();
            
        console.log(`Created document vertex with gremlin.id: ${documentId}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    documentId: documentId,
                    chunksProcessed: chunks.length,
                    entitiesCreated: [],
                    conceptsCreated: []
                }
            })
        };
    } catch (error) {
        console.error('Error creating document graph:', error);
        throw error;
    }
}

async function createChunkGraph(event) {
    // Add default arrays to prevent "Cannot read properties of undefined (reading 'length')" error
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
    
    try {
        // Create chunk vertex
        // KEY FIX: Add .property('gremlin.id', chunkId)
        const vertex = await g.addV('chunk')
            .property('gremlin.id', chunkId)  // <-- ADD THIS LINE
            .property('chunkId', chunkId)
            .property('documentId', documentId || '')
            .property('index', chunkIndex)
            .property('content', content.substring(0, 1000))
            .property('summary', summary)
            .property('vectorKey', chunkId)
            .property('pageStart', metadata.pageStart || 0)
            .property('pageEnd', metadata.pageEnd || 0)
            .property('chunkIndex', metadata.chunkIndex || chunkIndex)
            .property('totalChunks', metadata.totalChunks || 0)
            .next();
            
        console.log(`Created chunk vertex with gremlin.id: ${chunkId}`);
        
        // Optionally create edge from document to chunk
        if (documentId) {
            try {
                await g.V().has('gremlin.id', documentId)
                    .addE('HAS_CHUNK')
                    .to(g.V().has('gremlin.id', chunkId))
                    .property('index', chunkIndex)
                    .next();
                console.log(`Created HAS_CHUNK edge from ${documentId} to ${chunkId}`);
            } catch (edgeError) {
                console.error('Error creating document->chunk edge:', edgeError);
            }
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                result: {
                    documentId: chunkId,
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
        // KEY FIX: Look for vertices by gremlin.id property
        const sourceVertex = await g.V().has('gremlin.id', chunkId).toList();
        
        if (sourceVertex.length === 0) {
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
        
        for (const rel of relationships) {
            const targetId = rel.id;
            const relationshipType = rel.relationship || 'RELATED';
            const strength = rel.strength || 1.0;
            
            try {
                // KEY FIX: Look for target by gremlin.id property
                const targetVertex = await g.V().has('gremlin.id', targetId).toList();
                
                if (targetVertex.length === 0) {
                    errors.push(`Target vertex not found: ${targetId}`);
                    continue;
                }
                
                // Create the edge using gremlin.id property
                await g.V().has('gremlin.id', chunkId)
                    .addE(relationshipType)
                    .to(g.V().has('gremlin.id', targetId))
                    .property('strength', strength)
                    .next();
                
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
        // KEY FIX: Search by gremlin.id property
        const chunks = await g.V().has('gremlin.id', chunkId).hasLabel('chunk').valueMap(true).toList();
        
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