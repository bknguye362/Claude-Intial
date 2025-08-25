import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

const question = 'the Battle of the Windmill';

// Extract entities
function extractEntitiesFromText(text) {
  const entities = [];
  const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
  const matches = text.match(capitalizedPattern) || [];
  const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How']);
  
  matches.forEach(match => {
    if (!commonWords.has(match) && match.length > 2) {
      entities.push(match);
    }
  });
  
  return [...new Set(entities)];
}

async function queryGraphForEntities(entities, maxEntities = 5) {
  const relatedEntities = new Map();
  const entitiesToQuery = entities.slice(0, maxEntities);
  
  for (const entity of entitiesToQuery) {
    try {
      console.log(`🔍 Querying graph for entity: ${entity}`);
      
      const result = await invokeLambda({
        operation: 'queryEntitiesByType',
        limit: 100
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.entities) {
          const matches = response.result.entities.filter(e => {
            const name = e.name?.[0] || '';
            return name.toLowerCase().includes(entity.toLowerCase()) || 
                   entity.toLowerCase().includes(name.toLowerCase());
          });
          
          if (matches.length > 0) {
            relatedEntities.set(entity, matches.slice(0, 3));
            console.log(`✅ Found ${matches.length} graph entities for "${entity}"`);
          }
        }
      }
    } catch (error) {
      console.log(`⚠️ Graph query failed for "${entity}":`, error.message);
    }
  }
  
  return relatedEntities;
}

// Simulate some chunks
const mockChunks = [
  { 
    content: "The Battle of the Windmill was a fierce conflict where Frederick attacked the farm.",
    distance: 0.15
  },
  { 
    content: "Napoleon led the defense when the windmill was destroyed.",
    distance: 0.18
  },
  { 
    content: "The animals worked hard to rebuild after the battle ended.",
    distance: 0.20
  },
  { 
    content: "Squealer told the animals about their glorious victory.",
    distance: 0.22
  }
];

async function testGraphEnhancement() {
  console.log('Question:', question);
  
  // Step 1: Extract entities
  const questionEntities = extractEntitiesFromText(question);
  console.log('Extracted entities:', questionEntities);
  
  // Step 2: Query graph
  const graphEntities = await queryGraphForEntities(questionEntities, 5);
  console.log(`\nFound ${graphEntities.size} entities in knowledge graph`);
  
  // Step 3: Apply graph boost
  if (graphEntities.size > 0) {
    console.log('\n🔗 APPLYING GRAPH ENHANCEMENT:');
    
    let boostedCount = 0;
    const enhancedChunks = mockChunks.map(chunk => {
      const content = chunk.content.toLowerCase();
      let graphBoost = 0;
      
      graphEntities.forEach((entities, queryTerm) => {
        entities.forEach(entity => {
          const entityName = (entity.name?.[0] || '').toLowerCase();
          if (entityName && content.includes(entityName)) {
            graphBoost = Math.max(graphBoost, 0.15);
            if (graphBoost > 0 && boostedCount < 10) {
              console.log(`⭐ Boosting chunk with "${entityName}"`);
              boostedCount++;
            }
          }
        });
      });
      
      if (graphBoost > 0) {
        return {
          ...chunk,
          distance: chunk.distance * (1 - graphBoost),
          graphEnhanced: true
        };
      }
      return chunk;
    });
    
    console.log(`\n📊 Boosted ${boostedCount} chunks based on graph entities`);
    
    // Show results
    console.log('\nEnhanced chunks:');
    enhancedChunks.forEach((chunk, i) => {
      console.log(`${i+1}. Distance: ${chunk.distance.toFixed(4)}${chunk.graphEnhanced ? ' ⭐ (graph-enhanced)' : ''}`);
      console.log(`   ${chunk.content.substring(0, 80)}...`);
    });
  }
}

testGraphEnhancement().catch(console.error);
