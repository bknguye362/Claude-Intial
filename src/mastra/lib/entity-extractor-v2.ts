import { invokeLambda } from './neptune-lambda-client.js';

// Configuration
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://neogenaieastus2.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview';

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

interface ChunkEntities {
  chunkId: string;
  entities: Entity[];
  relationships: EntityRelationship[];
}

// Extract entities from a single chunk (no relationships yet)
async function extractEntitiesFromChunk(
  chunkId: string, 
  chunkContent: string
): Promise<ChunkEntities> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Entity Extractor] No API key, skipping entity extraction');
    return { chunkId, entities: [], relationships: [] };
  }

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
            content: `Extract ALL named entities from the text. Be comprehensive.

Entity types to identify:
- PERSON: Individuals, characters, historical figures
- ORGANIZATION: Companies, agencies, institutions, groups
- LOCATION: Countries, cities, buildings, landmarks, geographical features
- TECHNOLOGY: Software, frameworks, tools, platforms, protocols
- CONCEPT: Ideas, theories, principles, abstract notions
- EVENT: Meetings, conferences, historical events, activities
- PRODUCT: Books, articles, products, services

For each entity, provide:
- name: The entity name as it appears
- type: One of the above types
- description: Brief context about the entity

Return JSON: {
  "entities": [
    {"name": "...", "type": "...", "description": "..."}
  ]
}`
          },
          {
            role: 'user',
            content: `Extract entities from this text:\n\n${chunkContent.substring(0, 3000)}`
          }
        ],
        max_tokens: 800,
        temperature: 0.2
      })
    });
    
    if (response.ok) {
      const data: any = await response.json();
      const content = data.choices[0].message.content;
      
      try {
        const extracted = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
        
        // Convert to our format
        const entities: Entity[] = [];
        
        // Process entities
        if (extracted.entities) {
          for (const entity of extracted.entities) {
            const entityId = `entity_${entity.type.toLowerCase()}_${entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            
            entities.push({
              id: entityId,
              name: entity.name,
              type: entity.type,
              sourceChunk: chunkId,
              properties: {
                description: entity.description || '',
                sourceChunks: [chunkId]
              }
            });
          }
        }
        
        console.log(`[Entity Extractor] Extracted ${entities.length} entities from chunk`);
        return { chunkId, entities, relationships: [] };
        
      } catch (e) {
        console.error('[Entity Extractor] Error parsing LLM response:', e);
        return { chunkId, entities: [], relationships: [] };
      }
    }
    
    return { chunkId, entities: [], relationships: [] };
    
  } catch (error) {
    console.error('[Entity Extractor] Error extracting entities:', error);
    return { chunkId, entities: [], relationships: [] };
  }
}

// Find relationships between ALL entities after they've been extracted and deduplicated
async function discoverEntityRelationships(
  allEntities: Entity[]
): Promise<EntityRelationship[]> {
  if (!AZURE_OPENAI_API_KEY || allEntities.length < 2) {
    console.log('[Entity Extractor] Skipping relationship discovery - no API key or too few entities');
    return [];
  }

  const relationships: EntityRelationship[] = [];
  console.log(`[Entity Extractor] Discovering relationships between ${allEntities.length} entities...`);
  
  try {
    // Process entities in reasonable batches
    const batchSize = 30;
    
    for (let i = 0; i < allEntities.length; i += batchSize) {
      const batch = allEntities.slice(i, Math.min(i + batchSize, allEntities.length));
      
      // For each batch, also include context of other entities
      const otherEntities = allEntities.filter(e => !batch.includes(e));
      
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
              content: `Analyze these entities and identify ALL meaningful relationships between them.
              
Common relationship types by entity pairs:
- PERSON → PERSON: KNOWS, WORKS_WITH, REPORTS_TO, MANAGES, MARRIED_TO, CHILD_OF, PARENT_OF, SIBLING_OF, RIVAL_OF, FRIEND_OF
- PERSON → ORGANIZATION: WORKS_FOR, FOUNDED, LEADS, MEMBER_OF, OWNS, REPRESENTS
- PERSON → LOCATION: LIVES_IN, BORN_IN, WORKS_IN, VISITED, FROM, RULES
- PERSON → TECHNOLOGY: CREATED, USES, EXPERT_IN, MAINTAINS
- PERSON → CONCEPT: BELIEVES_IN, ADVOCATES_FOR, OPPOSES, REPRESENTS, EMBODIES
- PERSON → PRODUCT: CREATED, OWNS, USES, WROTE, PRODUCED
- PERSON → EVENT: ATTENDED, ORGANIZED, PARTICIPATED_IN, WITNESSED
- ORGANIZATION → LOCATION: LOCATED_IN, OPERATES_IN, HEADQUARTERED_IN
- ORGANIZATION → TECHNOLOGY: DEVELOPS, USES, OWNS, MAINTAINS
- CONCEPT → CONCEPT: RELATED_TO, OPPOSES, ENABLES, CAUSES, PART_OF, CONTRADICTS
- LOCATION → LOCATION: NEAR, CONTAINS, PART_OF, BORDERS

Be comprehensive and find ALL plausible relationships based on the context.
Only include relationships with confidence >= 0.6.

Return JSON: {
  "relationships": [
    {"from": "entity_name", "to": "entity_name", "type": "RELATIONSHIP_TYPE", "confidence": 0.8, "reason": "brief explanation"}
  ]
}`
            },
            {
              role: 'user',
              content: `Primary entities to analyze for relationships:
${batch.map(e => `- ${e.name} (${e.type}): ${e.properties.description || ''}`).join('\n')}

Other entities in the document (find relationships between primary and these too):
${otherEntities.slice(0, 30).map(e => `- ${e.name} (${e.type})`).join('\n')}`
            }
          ],
          max_tokens: 2000,
          temperature: 0.3
        })
      });
      
      if (response.ok) {
        const data: any = await response.json();
        const content = data.choices[0].message.content;
        
        try {
          const extracted = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
          const rels = extracted.relationships || [];
          
          for (const rel of rels) {
            // Find entities by name (case-insensitive)
            const fromEntity = allEntities.find(e => 
              e.name.toLowerCase() === rel.from.toLowerCase()
            );
            const toEntity = allEntities.find(e => 
              e.name.toLowerCase() === rel.to.toLowerCase()
            );
            
            if (fromEntity && toEntity && rel.confidence >= 0.6) {
              // Check for duplicates
              const exists = relationships.some(r => 
                r.fromEntity === fromEntity.id && 
                r.toEntity === toEntity.id && 
                r.relationshipType === rel.type
              );
              
              if (!exists) {
                relationships.push({
                  fromEntity: fromEntity.id,
                  toEntity: toEntity.id,
                  relationshipType: rel.type,
                  confidence: rel.confidence,
                  properties: { 
                    crossChunk: fromEntity.sourceChunk !== toEntity.sourceChunk,
                    reason: rel.reason || ''
                  }
                });
              }
            }
          }
          
          console.log(`[Entity Extractor] Batch ${Math.floor(i/batchSize) + 1}: Found ${rels.length} relationships`);
          
        } catch (e) {
          console.error('[Entity Extractor] Error parsing relationships:', e);
        }
      }
      
      // Rate limiting
      if (i + batchSize < allEntities.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[Entity Extractor] Total relationships discovered: ${relationships.length}`);
    return relationships;
    
  } catch (error) {
    console.error('[Entity Extractor] Error discovering relationships:', error);
    return relationships;
  }
}

// Main function to create entity knowledge graph
export async function createEntityKnowledgeGraph(
  documentId: string,
  indexName: string,  // Used to link with S3 Vector index
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
  console.log('[Entity Knowledge Graph] Starting entity extraction and graph creation...');
  console.log(`[Entity Knowledge Graph] Document ID: ${documentId}`);
  console.log(`[Entity Knowledge Graph] S3 Index Name: ${indexName}`);
  
  const allEntities: Entity[] = [];
  
  try {
    // Step 1: Extract entities from each chunk (NO relationships yet)
    console.log('[Entity Knowledge Graph] Step 1: Extracting entities from chunks...');
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[Entity Knowledge Graph] Processing chunk ${i + 1}/${chunks.length}`);
      
      const chunkEntities = await extractEntitiesFromChunk(
        chunks[i].id,
        chunks[i].content + (chunks[i].summary ? `\n\nSummary: ${chunks[i].summary}` : '')
      );
      
      allEntities.push(...chunkEntities.entities);
      
      // Don't overwhelm the API
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[Entity Knowledge Graph] Extracted ${allEntities.length} total entities`);
    
    // Step 2: Deduplicate entities
    console.log('[Entity Knowledge Graph] Step 2: Deduplicating entities...');
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
        if (!existingEntity.properties.sourceChunks.includes(entity.sourceChunk)) {
          existingEntity.properties.sourceChunks.push(entity.sourceChunk);
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
    console.log(`[Entity Knowledge Graph] Deduplicated to ${dedupedEntities.length} unique entities`);
    
    // Step 3: Create entity nodes in Neptune FIRST (before relationships)
    console.log('[Entity Knowledge Graph] Step 3: Creating entity nodes in Neptune...');
    
    for (const entity of dedupedEntities) {
      try {
        await invokeLambda({
          operation: 'createEntityNode',
          entityId: entity.id,
          entityType: entity.type,
          name: entity.name,
          properties: entity.properties,
          documentId: documentId,
          indexName: indexName  // Link to S3 Vector index
        });
      } catch (error) {
        console.error(`[Entity Knowledge Graph] Failed to create entity ${entity.name}:`, error);
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created ${dedupedEntities.length} entity nodes`);
    
    // Step 4: NOW discover relationships between ALL entities
    console.log('[Entity Knowledge Graph] Step 4: Discovering relationships between entities...');
    const relationships = await discoverEntityRelationships(dedupedEntities);
    
    // Step 5: Create relationships in Neptune
    console.log('[Entity Knowledge Graph] Step 5: Creating relationships in Neptune...');
    
    let successfulRelationships = 0;
    for (const rel of relationships) {
      try {
        await invokeLambda({
          operation: 'createEntityRelationship',
          fromEntity: rel.fromEntity,
          toEntity: rel.toEntity,
          relationshipType: rel.relationshipType,
          properties: rel.properties,
          confidence: rel.confidence
        });
        successfulRelationships++;
      } catch (error) {
        console.error(`[Entity Knowledge Graph] Failed to create relationship:`, error);
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created ${successfulRelationships} of ${relationships.length} relationships`);
    console.log(`[Entity Knowledge Graph] Knowledge graph complete!`);
    
    return {
      entities: dedupedEntities,
      relationships: relationships,
      success: true
    };
    
  } catch (error) {
    console.error('[Entity Knowledge Graph] Error creating knowledge graph:', error);
    return {
      entities: allEntities,
      relationships: [],
      success: false
    };
  }
}

// Export for use in PDF processor
export { extractEntitiesFromChunk, discoverEntityRelationships };