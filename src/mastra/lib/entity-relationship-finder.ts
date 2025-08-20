import { Entity, EntityRelationship } from './entity-extractor.js';

// Azure OpenAI configuration - matching entity extractor
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

// Simple relationship finder that processes ALL entities together
export async function findEntityRelationships(
  allEntities: Entity[]
): Promise<EntityRelationship[]> {
  if (!AZURE_OPENAI_API_KEY || allEntities.length < 2) {
    console.log('[Relationship Finder] Skipping - no API key or too few entities');
    return [];
  }

  console.log(`[Relationship Finder] Finding relationships between ${allEntities.length} entities...`);
  const relationships: EntityRelationship[] = [];
  
  try {
    // Process entities in reasonable batches
    const batchSize = 25;
    
    for (let i = 0; i < allEntities.length; i += batchSize) {
      const batch = allEntities.slice(i, Math.min(i + batchSize, allEntities.length));
      console.log(`[Relationship Finder] Processing batch ${Math.floor(i/batchSize) + 1}...`);
      
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
              content: `Find relationships between entities. Focus on clear, meaningful connections.
              
Common relationships:
- PERSON to PERSON: KNOWS, WORKS_WITH, REPORTS_TO, CHILD_OF, RIVAL_OF
- PERSON to ORGANIZATION: WORKS_FOR, FOUNDED, LEADS, MEMBER_OF
- PERSON to LOCATION: LIVES_IN, WORKS_IN, FROM
- PERSON to CONCEPT: BELIEVES_IN, ADVOCATES_FOR, OPPOSES
- ORGANIZATION to LOCATION: LOCATED_IN, HEADQUARTERED_IN
- CONCEPT to CONCEPT: RELATED_TO, OPPOSES, ENABLES

Return JSON with relationships array:
{
  "relationships": [
    {"from": "entity_name", "to": "entity_name", "type": "RELATIONSHIP_TYPE", "confidence": 0.8}
  ]
}`
            },
            {
              role: 'user',
              content: `Find relationships between these entities:\n${batch.map(e => 
                `- ${e.name} (${e.type})`
              ).join('\n')}`
            }
          ],
          max_tokens: 1000,
          temperature: 0.3
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
          
          const parsed = JSON.parse(jsonStr);
          const rels = parsed.relationships || [];
          
          for (const rel of rels) {
            // Find entities by name
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
                    crossChunk: fromEntity.sourceChunk !== toEntity.sourceChunk
                  }
                });
              }
            }
          }
          
          console.log(`[Relationship Finder] Batch found ${rels.length} relationships`);
        } catch (e) {
          console.error('[Relationship Finder] Error parsing response:', e);
        }
      } else {
        console.error('[Relationship Finder] API request failed:', response.status);
      }
      
      // Rate limiting
      if (i + batchSize < allEntities.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[Relationship Finder] Total relationships found: ${relationships.length}`);
    return relationships;
    
  } catch (error) {
    console.error('[Relationship Finder] Error:', error);
    return relationships;
  }
}