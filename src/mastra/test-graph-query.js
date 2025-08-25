// Test entity extraction and graph querying
const question = 'the Battle of the Windmill';

// Extract entities from the question
function extractEntitiesFromText(text) {
  const entities = [];
  
  // Pattern for capitalized words (potential named entities)
  const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
  const matches = text.match(capitalizedPattern) || [];
  
  // Filter out common words
  const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How']);
  
  matches.forEach(match => {
    if (!commonWords.has(match) && match.length > 2) {
      entities.push(match);
    }
  });
  
  // Also extract quoted strings
  const quotedPattern = /"([^"]+)"/g;
  let quotedMatch;
  while ((quotedMatch = quotedPattern.exec(text)) !== null) {
    entities.push(quotedMatch[1]);
  }
  
  return [...new Set(entities)]; // Remove duplicates
}

const entities = extractEntitiesFromText(question);
console.log('Question:', question);
console.log('Extracted entities:', entities);

// Now query the graph for these entities
import('./dist/lib/neptune-lambda-client.js').then(async m => {
  console.log('\nQuerying graph for entities...');
  
  for (const entity of entities) {
    console.log(`\nSearching for: ${entity}`);
    
    try {
      const result = await m.invokeLambda({
        operation: 'queryEntitiesByType',
        limit: 100
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.entities) {
          // Filter entities that match our query
          const matches = response.result.entities.filter(e => {
            const name = e.name?.[0] || '';
            return name.toLowerCase().includes(entity.toLowerCase()) || 
                   entity.toLowerCase().includes(name.toLowerCase());
          });
          
          if (matches.length > 0) {
            console.log(`✅ Found ${matches.length} matches:`);
            matches.slice(0, 3).forEach(e => {
              console.log(`  - ${e.name[0]} (${e.entityType[0]})`);
              if (e.description?.[0]) {
                console.log(`    ${e.description[0]}`);
              }
            });
          } else {
            console.log('❌ No matches found');
          }
        }
      }
    } catch (error) {
      console.error(`Error querying for ${entity}:`, error.message);
    }
  }
}).catch(console.error);
