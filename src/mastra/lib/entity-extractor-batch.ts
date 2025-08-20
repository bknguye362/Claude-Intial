// Batch entity extraction - processes multiple chunks in one API call
import { invokeLambda } from './neptune-lambda-client.js';
import { findEntityRelationships } from './entity-relationship-finder.js';

// Configuration
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://neogenaieastus2.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview';

const CHUNK_BATCH_SIZE = 3; // Process 3 chunks at a time

// Entity types
export interface Entity {
  id: string;
  name: string;
  type: string; // PERSON, ORGANIZATION, LOCATION, TECHNOLOGY, CONCEPT, EVENT, PRODUCT
  sourceChunk: string;
  properties: Record<string, any>;
}

export interface EntityRelationship {
  fromEntity: string;
  toEntity: string;
  relationshipType: string;
  confidence: number;
  properties: Record<string, any>;
}

interface ChunkBatch {
  chunkIds: string[];
  combinedContent: string;
  entities: Entity[];
}

// Extract entities from a batch of chunks in ONE API call
async function extractEntitiesFromBatch(
  chunks: Array<{id: string; content: string; summary?: string}>
): Promise<ChunkBatch> {
  const chunkIds = chunks.map(c => c.id);
  
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Batch Entity Extractor] No API key, skipping batch');
    return { chunkIds, combinedContent: '', entities: [] };
  }

  // Combine chunk content with clear separators
  const combinedContent = chunks.map((chunk, i) => 
    `[CHUNK ${i+1}: ${chunk.id}]\n${chunk.content}\n${chunk.summary ? `Summary: ${chunk.summary}` : ''}`
  ).join('\n\n---CHUNK SEPARATOR---\n\n');

  try {
    const response = await fetch(AZURE_OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `Extract ALL named entities from these ${chunks.length} text chunks. Be comprehensive.
            
Entity types to identify:
- PERSON: Individuals, characters, historical figures
- ORGANIZATION: Companies, agencies, institutions, groups
- LOCATION: Countries, cities, buildings, landmarks, geographical features
- TECHNOLOGY: Software, frameworks, tools, platforms, protocols
- CONCEPT: Ideas, theories, principles, abstract notions
- EVENT: Meetings, conferences, historical events, activities
- PRODUCT: Books, articles, products, services

For each entity:
- name: The entity name as it appears
- type: One of the above types
- chunk_ids: Array of chunk IDs where this entity appears (from CHUNK 1, CHUNK 2, etc.)
- description: Brief context about the entity

Return JSON: {
  "entities": [
    {"name": "...", "type": "...", "chunk_ids": ["chunk_1", "chunk_2"], "description": "..."}
  ]
}`
          },
          {
            role: 'user',
            content: `Extract entities from these ${chunks.length} chunks:\n\n${combinedContent.substring(0, 6000)}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.2
      })
    });
    
    if (response.ok) {
      const data: any = await response.json();
      const content = data.choices[0].message.content;
      
      try {
        // Clean up JSON response
        let jsonStr = content.match(/\{[\s\S]*\}/)?.[0] || '{}';
        jsonStr = jsonStr
          .replace(/,\s*}/g, '}')  // Remove trailing commas
          .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
        
        const extracted = JSON.parse(jsonStr);
        const entities: Entity[] = [];
        
        if (extracted.entities) {
          for (const entity of extracted.entities) {
            // Create entity with proper ID
            const entityId = `entity_${(entity.type || 'unknown').toLowerCase()}_${entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            
            // Determine source chunks
            let sourceChunks = entity.chunk_ids || [];
            if (sourceChunks.length === 0) {
              // If no chunks specified, assume it's in the first chunk
              sourceChunks = [chunks[0].id];
            } else {
              // Map chunk numbers to actual chunk IDs
              sourceChunks = sourceChunks.map((chunkRef: string) => {
                const match = chunkRef.match(/\d+/);
                if (match) {
                  const idx = parseInt(match[0]) - 1;
                  return chunks[idx]?.id || chunks[0].id;
                }
                return chunks[0].id;
              });
            }
            
            entities.push({
              id: entityId,
              name: entity.name,
              type: entity.type || 'UNKNOWN',
              sourceChunk: sourceChunks[0], // Primary source
              properties: {
                description: entity.description || '',
                sourceChunks: sourceChunks,
                fromBatch: true
              }
            });
          }
        }
        
        console.log(`[Batch Entity Extractor] Extracted ${entities.length} entities from batch of ${chunks.length} chunks`);
        return { chunkIds, combinedContent, entities };
        
      } catch (e) {
        console.error('[Batch Entity Extractor] Error parsing response:', e);
        return { chunkIds, combinedContent, entities: [] };
      }
    }
    
    return { chunkIds, combinedContent, entities: [] };
    
  } catch (error) {
    console.error('[Batch Entity Extractor] Error:', error);
    return { chunkIds, combinedContent, entities: [] };
  }
}

// Main function to create entity knowledge graph with batch processing
export async function createEntityKnowledgeGraph(
  documentId: string,
  indexName: string,
  chunks: Array<{
    id: string;
    content: string;
    summary?: string;
  }>
): Promise<{
  entities: Entity[];
  relationships: EntityRelationship[];
  success: boolean;
}> {
  console.log('[Batch Entity Knowledge Graph] Starting batch entity extraction...');
  console.log(`[Batch Entity Knowledge Graph] Document ID: ${documentId}`);
  console.log(`[Batch Entity Knowledge Graph] S3 Index Name: ${indexName}`);
  console.log(`[Batch Entity Knowledge Graph] Total chunks: ${chunks.length}`);
  console.log(`[Batch Entity Knowledge Graph] Batch size: ${CHUNK_BATCH_SIZE}`);
  
  const allEntities: Entity[] = [];
  let allRelationships: EntityRelationship[] = [];
  
  try {
    // Step 1: Extract entities in batches
    console.log('[Batch Entity Knowledge Graph] Step 1: Extracting entities in batches...');
    
    const numBatches = Math.ceil(chunks.length / CHUNK_BATCH_SIZE);
    console.log(`[Batch Entity Knowledge Graph] Processing ${numBatches} batches...`);
    
    for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
      const batchNum = Math.floor(i / CHUNK_BATCH_SIZE) + 1;
      const batch = chunks.slice(i, Math.min(i + CHUNK_BATCH_SIZE, chunks.length));
      
      console.log(`[Batch Entity Knowledge Graph] Processing batch ${batchNum}/${numBatches} (${batch.length} chunks)`);
      
      const batchResult = await extractEntitiesFromBatch(batch);
      allEntities.push(...batchResult.entities);
      
      // Rate limiting between batches
      if (i + CHUNK_BATCH_SIZE < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[Batch Entity Knowledge Graph] Extracted ${allEntities.length} total entities`);
    
    // Step 2: Deduplicate entities
    console.log('[Batch Entity Knowledge Graph] Step 2: Deduplicating entities...');
    const uniqueEntities = new Map<string, Entity>();
    
    for (const entity of allEntities) {
      const existingEntity = uniqueEntities.get(entity.id);
      
      if (!existingEntity) {
        uniqueEntities.set(entity.id, entity);
      } else {
        // Merge source chunks
        if (!existingEntity.properties.sourceChunks) {
          existingEntity.properties.sourceChunks = [existingEntity.sourceChunk];
        }
        const newChunks = entity.properties.sourceChunks || [entity.sourceChunk];
        for (const chunk of newChunks) {
          if (!existingEntity.properties.sourceChunks.includes(chunk)) {
            existingEntity.properties.sourceChunks.push(chunk);
          }
        }
        
        // Merge descriptions if different
        if (entity.properties.description && 
            entity.properties.description !== existingEntity.properties.description) {
          existingEntity.properties.additionalContext = 
            (existingEntity.properties.additionalContext || []).concat(entity.properties.description);
        }
      }
    }
    
    const dedupedEntities = Array.from(uniqueEntities.values());
    console.log(`[Batch Entity Knowledge Graph] Deduplicated to ${dedupedEntities.length} unique entities`);
    
    // Step 3: Create entity nodes in Neptune
    console.log('[Batch Entity Knowledge Graph] Step 3: Creating entity nodes in Neptune...');
    
    let successfulEntities = 0;
    let failedEntities = 0;
    
    for (const entity of dedupedEntities) {
      try {
        const result = await invokeLambda({
          operation: 'createEntityNode',
          entityId: entity.id,
          entityType: entity.type,
          name: entity.name,
          properties: entity.properties,
          documentId: documentId,
          indexName: indexName
        });
        
        if (result && result.statusCode === 200) {
          const body = JSON.parse(result.body);
          if (body.success) {
            successfulEntities++;
          } else {
            console.error(`[Batch Entity Knowledge Graph] Failed to create entity ${entity.name}:`, body.error);
            failedEntities++;
          }
        } else {
          failedEntities++;
        }
      } catch (error) {
        console.error(`[Batch Entity Knowledge Graph] Error creating entity ${entity.name}:`, error);
        failedEntities++;
      }
    }
    
    console.log(`[Batch Entity Knowledge Graph] Created ${successfulEntities} entities, ${failedEntities} failed`);
    
    // Step 4: Find relationships between entities
    console.log('[Batch Entity Knowledge Graph] Step 4: Finding relationships between entities...');
    const discoveredRelationships = await findEntityRelationships(dedupedEntities);
    allRelationships = discoveredRelationships;
    console.log(`[Batch Entity Knowledge Graph] Discovered ${discoveredRelationships.length} relationships`);
    
    // Step 5: Create relationships in Neptune
    console.log('[Batch Entity Knowledge Graph] Step 5: Creating relationships in Neptune...');
    
    let successfulRelationships = 0;
    let failedRelationships = 0;
    
    for (const rel of allRelationships) {
      console.log(`[Batch Entity Knowledge Graph] Creating relationship: ${rel.fromEntity} --[${rel.relationshipType}]--> ${rel.toEntity}`);
      try {
        const result = await invokeLambda({
          operation: 'createEntityRelationship',
          fromEntity: rel.fromEntity,
          toEntity: rel.toEntity,
          relationshipType: rel.relationshipType,
          properties: rel.properties,
          confidence: rel.confidence
        });
        
        if (result && result.statusCode === 200) {
          const body = JSON.parse(result.body);
          if (body.success) {
            successfulRelationships++;
            console.log(`[Batch Entity Knowledge Graph] ✓ Relationship created successfully`);
          } else {
            console.error(`[Batch Entity Knowledge Graph] ✗ Relationship failed:`, body.error);
            failedRelationships++;
          }
        } else {
          console.error(`[Batch Entity Knowledge Graph] ✗ Failed to create relationship:`, result);
          failedRelationships++;
        }
      } catch (error) {
        console.error(`[Batch Entity Knowledge Graph] ✗ Error creating relationship:`, error);
        failedRelationships++;
      }
    }
    
    console.log(`[Batch Entity Knowledge Graph] Completed!`);
    console.log(`  - Entities: ${successfulEntities}/${dedupedEntities.length} created`);
    console.log(`  - Relationships: ${successfulRelationships}/${allRelationships.length} created`);
    console.log(`  - API calls: ${numBatches} (instead of ${chunks.length})`);
    
    return {
      entities: dedupedEntities,
      relationships: allRelationships,
      success: true
    };
    
  } catch (error) {
    console.error('[Batch Entity Knowledge Graph] Error:', error);
    return {
      entities: allEntities,
      relationships: allRelationships,
      success: false
    };
  }
}

// Export for use in PDF processor
export { extractEntitiesFromBatch };