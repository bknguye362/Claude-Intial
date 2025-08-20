// Entity extraction and knowledge graph creation
import { createDocumentNode, createChunkNode, createChunkRelationships, invokeLambda } from './neptune-lambda-client.js';
import { findEntityRelationships } from './entity-relationship-finder.js';

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

export interface Entity {
  id: string;
  name: string;
  type: string; // PERSON, ORGANIZATION, LOCATION, CONCEPT, TECHNOLOGY, EVENT, etc.
  properties: Record<string, any>;
  sourceChunk: string;
}

export interface EntityRelationship {
  fromEntity: string;
  toEntity: string;
  relationshipType: string;
  properties: Record<string, any>;
  confidence: number;
}

interface ChunkEntities {
  chunkId: string;
  entities: Entity[];
  relationships: EntityRelationship[];
}

// Extract entities from a chunk of text
async function extractEntitiesFromChunk(
  chunkId: string,
  chunkContent: string,
  chunkSummary?: string
): Promise<ChunkEntities> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Entity Extractor] No API key, skipping entity extraction');
    return { chunkId, entities: [], relationships: [] };
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `Extract entities and their relationships from the text.

Entity types to identify:
- PERSON: Individuals, authors, researchers
- ORGANIZATION: Companies, institutions, groups
- LOCATION: Places, cities, countries, regions
- TECHNOLOGY: Software, tools, frameworks, languages
- CONCEPT: Ideas, theories, methods, processes
- PRODUCT: Products, services, platforms
- EVENT: Events, dates, milestones
- METRIC: Numbers, statistics, measurements

For each entity, provide:
- name: The entity name
- type: One of the types above
- properties: Relevant attributes (role, description, context)

For relationships between entities IN THIS CHUNK, identify:
- relationshipType: WORKS_FOR, LOCATED_IN, USES, CREATES, MANAGES, OWNS, PART_OF, RELATED_TO, etc.
- confidence: 0.0 to 1.0

Return JSON:
{
  "entities": [
    {"name": "...", "type": "...", "properties": {...}}
  ],
  "relationships": [
    {"from": "entity_name", "to": "entity_name", "type": "...", "confidence": 0.9}
  ]
}`
          },
          {
            role: 'user',
            content: `Extract entities and relationships from this text:\n\n${chunkContent.substring(0, 3000)}`
          }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    if (response.ok) {
      const data = await response.json() as any;
      const content = data.choices[0].message.content;
      
      try {
        const extracted = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
        
        // Convert to our format
        const entities: Entity[] = [];
        const relationships: EntityRelationship[] = [];
        
        // Process entities
        if (extracted.entities) {
          for (const entity of extracted.entities) {
            const entityId = `entity_${entity.type.toLowerCase()}_${entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            entities.push({
              id: entityId,
              name: entity.name,
              type: entity.type,
              properties: entity.properties || {},
              sourceChunk: chunkId
            });
          }
        }
        
        // Process relationships
        if (extracted.relationships) {
          for (const rel of extracted.relationships) {
            const fromId = `entity_${entities.find(e => e.name === rel.from)?.type.toLowerCase()}_${rel.from.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            const toId = `entity_${entities.find(e => e.name === rel.to)?.type.toLowerCase()}_${rel.to.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            
            relationships.push({
              fromEntity: fromId,
              toEntity: toId,
              relationshipType: rel.type,
              properties: {},
              confidence: rel.confidence || 0.8
            });
          }
        }
        
        console.log(`[Entity Extractor] Extracted ${entities.length} entities and ${relationships.length} relationships from chunk`);
        return { chunkId, entities, relationships };
        
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

// Find relationships between entities across different chunks
async function findCrossChunkRelationships(
  allEntities: Entity[]
): Promise<EntityRelationship[]> {
  if (!AZURE_OPENAI_API_KEY || allEntities.length < 2) {
    return [];
  }

  const relationships: EntityRelationship[] = [];
  
  // Group entities by type for more focused analysis
  const entityGroups: Record<string, Entity[]> = {};
  for (const entity of allEntities) {
    if (!entityGroups[entity.type]) {
      entityGroups[entity.type] = [];
    }
    entityGroups[entity.type].push(entity);
  }
  
  try {
    // Analyze relationships between different entity types
    const typePairs = [
      ['PERSON', 'ORGANIZATION'],
      ['PERSON', 'TECHNOLOGY'],
      ['ORGANIZATION', 'LOCATION'],
      ['TECHNOLOGY', 'CONCEPT'],
      ['PRODUCT', 'ORGANIZATION'],
      ['PERSON', 'EVENT']
    ];
    
    for (const [type1, type2] of typePairs) {
      const group1 = entityGroups[type1] || [];
      const group2 = entityGroups[type2] || [];
      
      if (group1.length === 0 || group2.length === 0) continue;
      
      // Create entity summaries for LLM
      const group1Summary = group1.slice(0, 10).map(e => `${e.name} (${e.sourceChunk})`).join(', ');
      const group2Summary = group2.slice(0, 10).map(e => `${e.name} (${e.sourceChunk})`).join(', ');
      
      const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_API_KEY
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `Identify likely relationships between ${type1} and ${type2} entities.
              Common relationships:
              - PERSON-ORGANIZATION: WORKS_FOR, FOUNDED, LEADS, MEMBER_OF
              - PERSON-TECHNOLOGY: CREATED, USES, EXPERT_IN
              - ORGANIZATION-LOCATION: HEADQUARTERED_IN, OPERATES_IN
              - TECHNOLOGY-CONCEPT: IMPLEMENTS, BASED_ON, ENABLES
              - PRODUCT-ORGANIZATION: DEVELOPED_BY, OWNED_BY
              - PERSON-EVENT: ATTENDED, ORGANIZED, SPOKE_AT
              
              Only identify relationships you're confident about (confidence > 0.7).
              Return JSON array: [{"from": "name", "to": "name", "type": "...", "confidence": 0.9}]`
            },
            {
              role: 'user',
              content: `${type1} entities: ${group1Summary}\n${type2} entities: ${group2Summary}`
            }
          ],
          max_tokens: 500,
          temperature: 0.3
        })
      });
      
      if (response.ok) {
        const data = await response.json() as any;
        try {
          const rels = JSON.parse(data.choices[0].message.content.match(/\[[\s\S]*\]/)?.[0] || '[]');
          
          for (const rel of rels) {
            const fromEntity = group1.find(e => e.name === rel.from);
            const toEntity = group2.find(e => e.name === rel.to);
            
            if (fromEntity && toEntity && rel.confidence > 0.7) {
              relationships.push({
                fromEntity: fromEntity.id,
                toEntity: toEntity.id,
                relationshipType: rel.type,
                properties: { crossChunk: true },
                confidence: rel.confidence
              });
            }
          }
        } catch (e) {
          console.error('[Entity Extractor] Error parsing cross-chunk relationships:', e);
        }
      }
    }
    
    console.log(`[Entity Extractor] Found ${relationships.length} cross-chunk relationships`);
    return relationships;
    
  } catch (error) {
    console.error('[Entity Extractor] Error finding cross-chunk relationships:', error);
    return [];
  }
}

// Create entity-based knowledge graph in Neptune
export async function createEntityKnowledgeGraph(
  documentId: string,
  indexName: string,  // Add indexName parameter
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
  let allRelationships: EntityRelationship[] = [];
  
  try {
    // Step 1: Extract entities from each chunk
    console.log('[Entity Knowledge Graph] Step 1: Extracting entities from chunks...');
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[Entity Knowledge Graph] Processing chunk ${i + 1}/${chunks.length}`);
      
      const chunkEntities = await extractEntitiesFromChunk(
        chunk.id,
        chunk.content,
        chunk.summary
      );
      
      allEntities.push(...chunkEntities.entities);
      // Don't collect within-chunk relationships here - they have wrong IDs before deduplication
      // allRelationships.push(...chunkEntities.relationships);
      
      // Don't overwhelm the API
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[Entity Knowledge Graph] Extracted ${allEntities.length} entities`);
    
    // Step 2: Deduplicate entities (same entity might appear in multiple chunks)
    const uniqueEntities = new Map<string, Entity>();
    for (const entity of allEntities) {
      if (!uniqueEntities.has(entity.id)) {
        uniqueEntities.set(entity.id, entity);
      } else {
        // Merge properties if entity appears in multiple chunks
        const existing = uniqueEntities.get(entity.id)!;
        existing.properties = { ...existing.properties, ...entity.properties };
        if (!existing.properties.sourceChunks) {
          existing.properties.sourceChunks = [existing.sourceChunk];
        }
        existing.properties.sourceChunks.push(entity.sourceChunk);
      }
    }
    
    const dedupedEntities = Array.from(uniqueEntities.values());
    console.log(`[Entity Knowledge Graph] Deduplicated to ${dedupedEntities.length} unique entities`);
    
    // Step 3: Create entity nodes in Neptune FIRST
    console.log('[Entity Knowledge Graph] Step 3: Creating entity nodes in Neptune...');
    
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
          indexName: indexName  // Link to S3 Vector index
        });
        
        if (result && result.statusCode === 200) {
          successfulEntities++;
        } else {
          console.error(`[Entity Knowledge Graph] Failed to create entity ${entity.name}:`, result);
          failedEntities++;
        }
      } catch (error) {
        console.error(`[Entity Knowledge Graph] Error creating entity ${entity.name}:`, error);
        failedEntities++;
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created ${successfulEntities} entities, ${failedEntities} failed`);
    
    // Step 4: NOW find ALL relationships AFTER entities exist in Neptune
    console.log('[Entity Knowledge Graph] Step 4: Finding relationships between entities...');
    // Clear any old relationships with wrong IDs
    allRelationships = [];
    const discoveredRelationships = await findEntityRelationships(dedupedEntities);
    allRelationships.push(...discoveredRelationships);
    console.log(`[Entity Knowledge Graph] Discovered ${discoveredRelationships.length} relationships`);
    
    // Step 5: Create relationships in Neptune
    console.log('[Entity Knowledge Graph] Step 5: Creating relationships in Neptune...');
    
    let successfulRelationships = 0;
    let failedRelationships = 0;
    
    for (const rel of allRelationships) {
      console.log(`[Entity Knowledge Graph] Creating relationship: ${rel.fromEntity} --[${rel.relationshipType}]--> ${rel.toEntity}`);
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
            console.log(`[Entity Knowledge Graph] ✓ Relationship created successfully`);
          } else {
            console.error(`[Entity Knowledge Graph] ✗ Relationship failed:`, body.error);
            failedRelationships++;
          }
        } else {
          console.error(`[Entity Knowledge Graph] ✗ Failed to create relationship:`, result);
          failedRelationships++;
        }
      } catch (error) {
        console.error(`[Entity Knowledge Graph] ✗ Error creating relationship:`, error);
        failedRelationships++;
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created knowledge graph:`);
    console.log(`  - Entities: ${successfulEntities}/${dedupedEntities.length} created`);
    console.log(`  - Relationships: ${successfulRelationships}/${allRelationships.length} created`);
    
    return {
      entities: dedupedEntities,
      relationships: allRelationships,
      success: true
    };
    
  } catch (error) {
    console.error('[Entity Knowledge Graph] Error creating knowledge graph:', error);
    return {
      entities: allEntities,
      relationships: allRelationships,
      success: false
    };
  }
}

// Export for use in PDF processor
export { extractEntitiesFromChunk, findCrossChunkRelationships };