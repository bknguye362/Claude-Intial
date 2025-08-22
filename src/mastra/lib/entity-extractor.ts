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

  console.log(`[Entity Extractor] Processing chunk ${chunkId}, content length: ${chunkContent.length}`);

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    console.log(`[Entity Extractor] Calling Azure OpenAI at: ${url}`);
    
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
        // Try to extract JSON from the response
        let jsonStr = content.match(/\{[\s\S]*\}/)?.[0] || '{}';
        
        // More robust JSON cleanup
        jsonStr = jsonStr
          .replace(/,\s*}/g, '}')  // Remove trailing commas in objects
          .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
          .replace(/"/g, '"')      // Replace smart quotes
          .replace(/"/g, '"')      // Replace smart quotes
          .replace(/'/g, "'")      // Replace smart single quotes
          .replace(/'/g, "'")      // Replace smart single quotes
          .replace(/,\s*,/g, ',')  // Remove double commas
          .replace(/\[\s*,/g, '[') // Remove leading comma in arrays
          .replace(/}\s*{/g, '},{'); // Fix missing comma between objects
        
        // Don't double-escape backslashes if they're already escaped
        if (!jsonStr.includes('\\\\')) {
          jsonStr = jsonStr.replace(/\\/g, '\\\\');
        }
        
        let extracted;
        try {
          extracted = JSON.parse(jsonStr);
        } catch (parseError) {
          console.warn('[Entity Extractor] Failed to parse JSON, attempting fallback extraction');
          // More robust fallback extraction
          extracted = { entities: [], relationships: [] };
          
          // Try to extract entities array
          const entitiesMatch = content.match(/"entities"\s*:\s*\[([\s\S]*?)\](?:\s*[,}])/);
          if (entitiesMatch) {
            try {
              const entitiesStr = '[' + entitiesMatch[1] + ']';
              const cleanedEntities = entitiesStr
                .replace(/,\s*}/g, '}')
                .replace(/,\s*]/g, ']')
                .replace(/,\s*,/g, ',');
              extracted.entities = JSON.parse(cleanedEntities);
            } catch (e: any) {
              console.warn('[Entity Extractor] Could not parse entities array:', e.message);
            }
          }
          
          // Try to extract relationships array
          const relMatch = content.match(/"relationships"\s*:\s*\[([\s\S]*?)\](?:\s*[,}])/);
          if (relMatch) {
            try {
              const relStr = '[' + relMatch[1] + ']';
              const cleanedRels = relStr
                .replace(/,\s*}/g, '}')
                .replace(/,\s*]/g, ']')
                .replace(/,\s*,/g, ',');
              extracted.relationships = JSON.parse(cleanedRels);
            } catch (e: any) {
              console.warn('[Entity Extractor] Could not parse relationships array:', e.message);
            }
          }
        }
        
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

// Function to extract entities from multiple chunks with TRUE parallel processing
export async function extractEntitiesFromChunks(
  chunks: Array<{
    id: string;
    content: string;
    summary?: string;
  }>
): Promise<ChunkEntities[]> {
  console.log(`[Entity Extractor] Extracting entities from ${chunks.length} chunks with high concurrency...`);
  console.log(`[Entity Extractor] API Key present: ${!!AZURE_OPENAI_API_KEY}, Key length: ${AZURE_OPENAI_API_KEY.length}`);
  console.log(`[Entity Extractor] Using endpoint: ${AZURE_OPENAI_ENDPOINT}`);
  
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Entity Extractor] No API key, returning empty entities');
    console.log('[Entity Extractor] Checked env vars: AZURE_OPENAI_API_KEY, AZURE_API_KEY, OPENAI_API_KEY');
    return chunks.map(chunk => ({ chunkId: chunk.id, entities: [], relationships: [] }));
  }
  
  // Process with much higher concurrency using Promise.all with chunks
  const maxConcurrent = 15; // Process 15 chunks simultaneously (Azure OpenAI can handle this)
  const results: ChunkEntities[] = [];
  const startTime = Date.now();
  
  console.log(`[Entity Extractor] Processing ${chunks.length} chunks with concurrency limit of ${maxConcurrent}...`);
  
  // Process all chunks in batches with high concurrency
  for (let i = 0; i < chunks.length; i += maxConcurrent) {
    const batch = chunks.slice(i, Math.min(i + maxConcurrent, chunks.length));
    const batchStartTime = Date.now();
    
    console.log(`[Entity Extractor] Processing batch ${Math.floor(i/maxConcurrent) + 1}/${Math.ceil(chunks.length/maxConcurrent)} (chunks ${i + 1}-${Math.min(i + maxConcurrent, chunks.length)})...`);
    console.log(`[Entity Extractor] Batch size: ${batch.length} chunks`);
    
    // Process entire batch in parallel - no waiting between individual chunks
    const batchPromises = batch.map(chunk => 
      extractEntitiesFromChunk(chunk.id, chunk.content, chunk.summary)
        .then(result => {
          if (!result.entities || result.entities.length === 0) {
            console.log(`[Entity Extractor] Chunk ${chunk.id} returned no entities`);
          } else {
            console.log(`[Entity Extractor] Chunk ${chunk.id} extracted ${result.entities.length} entities`);
          }
          return result;
        })
        .catch(error => {
          console.error(`[Entity Extractor] Error in chunk ${chunk.id}:`, error.message);
          console.error(`[Entity Extractor] Error details:`, error);
          return { chunkId: chunk.id, entities: [], relationships: [] };
        })
    );
    
    // Wait for entire batch to complete
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    console.log(`[Entity Extractor] Batch completed in ${batchTime}s`);
    
    // Small delay between batches to avoid rate limits (reduced from 1500ms)
    if (i + maxConcurrent < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgTimePerChunk = (parseFloat(totalTime) / chunks.length).toFixed(2);
  console.log(`[Entity Extractor] ✅ Completed ${chunks.length} chunks in ${totalTime}s (avg ${avgTimePerChunk}s per chunk)`);
  
  return results;
}

// Create entity knowledge graph from pre-extracted entities
export async function createEntityKnowledgeGraphFromExtracted(
  documentId: string,
  indexName: string,
  chunks: Array<{
    id: string;
    content: string;
    summary?: string;
    entities: Entity[];
    relationships: EntityRelationship[];
  }>
): Promise<{
  entities: Entity[];
  relationships: EntityRelationship[];
  success: boolean;
}> {
  console.log('[Entity Knowledge Graph] Creating graph from pre-extracted entities...');
  console.log(`[Entity Knowledge Graph] Document ID: ${documentId}`);
  console.log(`[Entity Knowledge Graph] S3 Index Name: ${indexName}`);
  
  const allEntities: Entity[] = [];
  let allRelationships: EntityRelationship[] = [];
  
  try {
    // Collect all entities and relationships from chunks
    for (const chunk of chunks) {
      allEntities.push(...chunk.entities);
      allRelationships.push(...chunk.relationships);
    }
    
    console.log(`[Entity Knowledge Graph] Collected ${allEntities.length} entities from chunks`);
    
    // Deduplicate entities
    const uniqueEntities = new Map<string, Entity>();
    for (const entity of allEntities) {
      const key = `${entity.type}_${entity.name}`.toLowerCase();
      if (!uniqueEntities.has(key)) {
        // Generate consistent entity ID
        entity.id = `entity_${key.replace(/[^a-z0-9]/g, '_')}`;
        uniqueEntities.set(key, entity);
      } else {
        // Merge properties if entity appears in multiple chunks
        const existing = uniqueEntities.get(key)!;
        existing.properties = { ...existing.properties, ...entity.properties };
        if (!existing.properties.sourceChunks) {
          existing.properties.sourceChunks = [existing.sourceChunk];
        }
        if (!existing.properties.sourceChunks.includes(entity.sourceChunk)) {
          existing.properties.sourceChunks.push(entity.sourceChunk);
        }
      }
    }
    
    const dedupedEntities = Array.from(uniqueEntities.values());
    console.log(`[Entity Knowledge Graph] Deduplicated to ${dedupedEntities.length} unique entities`);
    
    // Create document node in Neptune
    console.log('[Entity Knowledge Graph] Creating document node in Neptune...');
    await createDocumentNode(documentId, {
      indexName,
      totalChunks: chunks.length,
      extractedAt: new Date().toISOString()
    });
    
    // Create chunk nodes with rate limit protection
    console.log('[Entity Knowledge Graph] Creating chunk nodes...');
    const chunkBatchSize = 5; // Reduced from 10 to avoid rate limits
    
    for (let i = 0; i < chunks.length; i += chunkBatchSize) {
      const batch = chunks.slice(i, Math.min(i + chunkBatchSize, chunks.length));
      const batchPromises = batch.map((chunk, batchIndex) => 
        createChunkNode(
          chunk.id, 
          documentId, 
          i + batchIndex, // chunk index
          chunk.content.substring(0, 1000), // content (limited)
          chunk.summary || '', // summary
          { entityCount: chunk.entities.length } // metadata
        ).catch(err => {
          console.error(`[Entity Knowledge Graph] Failed to create chunk node ${chunk.id}:`, err.message);
          return false;
        })
      );
      
      await Promise.all(batchPromises);
      
      if ((i + chunkBatchSize) % 50 === 0 || i + chunkBatchSize >= chunks.length) {
        console.log(`[Entity Knowledge Graph] Created chunk nodes ${Math.min(i + chunkBatchSize, chunks.length)} of ${chunks.length}`);
      }
      
      // Add delay between batches to avoid rate limiting
      if (i + chunkBatchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
      }
    }
    
    // Create chunk relationships in parallel
    console.log('[Entity Knowledge Graph] Creating chunk relationships in parallel...');
    const relationshipPromises = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      relationshipPromises.push(
        createChunkRelationships(chunks[i].id, [
          { id: chunks[i + 1].id, relationship: 'NEXT_CHUNK', strength: 1.0 }
        ]).catch(err => {
          console.error(`[Entity Knowledge Graph] Failed to create relationship for chunk ${i}:`, err.message);
          return false;
        })
      );
    }
    
    // Process relationships in batches
    for (let i = 0; i < relationshipPromises.length; i += 10) {
      await Promise.all(relationshipPromises.slice(i, i + 10));
    }
    
    // Create entity nodes in Neptune in batches
    console.log('[Entity Knowledge Graph] Creating entity nodes in Neptune...');
    const entityBatchSize = 100; // Create 100 entities per Lambda call
    let totalEntitiesCreated = 0;
    
    for (let i = 0; i < dedupedEntities.length; i += entityBatchSize) {
      const batch = dedupedEntities.slice(i, Math.min(i + entityBatchSize, dedupedEntities.length));
      
      try {
        const createdEntities = await invokeLambda({
          operation: 'createEntities',
          entities: batch.map(entity => ({
            entityId: entity.id,
            name: entity.name,
            type: entity.type,
            properties: {
              ...entity.properties,
              indexName  // Link entity to S3 Vectors index
            }
          }))
        });
        
        totalEntitiesCreated += createdEntities.result?.created || 0;
        
        if ((i + entityBatchSize) % 200 === 0 || i + entityBatchSize >= dedupedEntities.length) {
          console.log(`[Entity Knowledge Graph] Created ${totalEntitiesCreated} of ${dedupedEntities.length} entity nodes`);
        }
        
        // Small delay between batches
        if (i + entityBatchSize < dedupedEntities.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (err: any) {
        console.error(`[Entity Knowledge Graph] Failed to create entity batch:`, err.message);
        if (err.message?.includes('Rate')) {
          console.log('[Entity Knowledge Graph] Rate limited, waiting 2 seconds...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          i -= entityBatchSize; // Retry this batch
        }
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created ${totalEntitiesCreated} entity nodes`);
    
    // Find relationships between entities using descriptions
    console.log('[Entity Knowledge Graph] Finding entity relationships...');
    const entityRelationships = await findEntityRelationships(dedupedEntities);
    allRelationships.push(...entityRelationships);
    
    // Create relationships in Neptune in batches
    if (allRelationships.length > 0) {
      console.log(`[Entity Knowledge Graph] Creating ${allRelationships.length} relationships in Neptune...`);
      const relBatchSize = 100; // Create 100 relationships per Lambda call
      let totalRelationshipsCreated = 0;
      
      for (let i = 0; i < allRelationships.length; i += relBatchSize) {
        const batch = allRelationships.slice(i, Math.min(i + relBatchSize, allRelationships.length));
        
        try {
          const relationshipResult = await invokeLambda({
            operation: 'createRelationships',
            relationships: batch.map(rel => ({
              fromEntityId: rel.fromEntity,
              toEntityId: rel.toEntity,
              relationshipType: rel.relationshipType,
              confidence: rel.confidence,
              properties: rel.properties
            }))
          });
          
          totalRelationshipsCreated += relationshipResult.result?.created || 0;
          
          if ((i + relBatchSize) % 200 === 0 || i + relBatchSize >= allRelationships.length) {
            console.log(`[Entity Knowledge Graph] Created ${totalRelationshipsCreated} of ${allRelationships.length} relationships`);
          }
          
          // Small delay between batches
          if (i + relBatchSize < allRelationships.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (err: any) {
          console.error(`[Entity Knowledge Graph] Failed to create relationship batch:`, err.message);
          if (err.message?.includes('Rate')) {
            console.log('[Entity Knowledge Graph] Rate limited, waiting 2 seconds...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            i -= relBatchSize; // Retry this batch
          }
        }
      }
      
      console.log(`[Entity Knowledge Graph] Created ${totalRelationshipsCreated} relationships`);
    }
    
    // Collect all entity-chunk relationships to create
    console.log('[Entity Knowledge Graph] Preparing entity-chunk relationships...');
    const entityChunkRelationships = [];
    
    for (const chunk of chunks) {
      for (const entity of chunk.entities) {
        const dedupedEntity = dedupedEntities.find(e => 
          e.name === entity.name && e.type === entity.type
        );
        if (dedupedEntity) {
          entityChunkRelationships.push({
            chunkId: chunk.id,
            entityId: dedupedEntity.id
          });
        }
      }
    }
    
    // Create relationships in batches to avoid rate limiting
    console.log(`[Entity Knowledge Graph] Creating ${entityChunkRelationships.length} entity-chunk relationships in batches...`);
    const batchSize = 50; // Send 50 relationships per Lambda call
    let successfulRelationships = 0;
    
    for (let i = 0; i < entityChunkRelationships.length; i += batchSize) {
      const batch = entityChunkRelationships.slice(i, Math.min(i + batchSize, entityChunkRelationships.length));
      
      try {
        // Send batch of relationships in a single Lambda call
        const result = await invokeLambda({
          operation: 'createEntityChunkRelationshipsBatch',
          relationships: batch
        });
        
        successfulRelationships += batch.length;
        
        if (i % 200 === 0 && i > 0) {
          console.log(`[Entity Knowledge Graph] Created ${successfulRelationships} of ${entityChunkRelationships.length} entity-chunk relationships`);
        }
        
        // Small delay between batches to respect rate limits
        if (i + batchSize < entityChunkRelationships.length) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay between batches
        }
      } catch (err: any) {
        console.error(`[Entity Knowledge Graph] Failed to create batch of relationships:`, err.message);
        // Implement exponential backoff on rate limit
        if (err.message?.includes('Rate')) {
          console.log('[Entity Knowledge Graph] Rate limited, waiting 2 seconds...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          i -= batchSize; // Retry this batch
        }
      }
    }
    
    console.log(`[Entity Knowledge Graph] Created ${successfulRelationships} entity-chunk relationships`);
    
    console.log('[Entity Knowledge Graph] Graph creation completed successfully');
    return {
      entities: dedupedEntities,
      relationships: allRelationships,
      success: true
    };
    
  } catch (error) {
    console.error('[Entity Knowledge Graph] Error creating graph:', error);
    return {
      entities: [],
      relationships: [],
      success: false
    };
  }
}

// Export for use in PDF processor
export { extractEntitiesFromChunk, findCrossChunkRelationships };