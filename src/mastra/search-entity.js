import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function searchForEntity(searchTerm) {
  console.log(`=== SEARCHING FOR: "${searchTerm}" ===\n`);
  
  // Search across all entity types
  const entityTypes = ['PERSON', 'ORGANIZATION', 'LOCATION', 'CONCEPT', 'TECHNOLOGY', 'EVENT', 'PRODUCT'];
  let foundEntities = [];
  
  for (const type of entityTypes) {
    const result = await invokeLambda({
      operation: 'queryEntitiesByType',
      entityType: type,
      limit: 100
    });
    
    if (result.statusCode === 200) {
      const data = JSON.parse(result.body);
      if (data.result?.entities) {
        // Search for entities containing the search term (case insensitive)
        const matches = data.result.entities.filter(entity => {
          const name = entity.name?.[0] || '';
          const description = entity.description?.[0] || '';
          return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                 description.toLowerCase().includes(searchTerm.toLowerCase());
        });
        
        if (matches.length > 0) {
          console.log(`Found in ${type}:`);
          matches.forEach(entity => {
            foundEntities.push({
              ...entity,
              type: type
            });
            console.log(`  - ${entity.name?.[0]} (${entity.entityId?.[0]})`);
            if (entity.description?.[0]) {
              console.log(`    Description: ${entity.description[0]}`);
            }
          });
          console.log();
        }
      }
    }
  }
  
  if (foundEntities.length === 0) {
    console.log(`No entities found matching "${searchTerm}"`);
    return;
  }
  
  console.log(`\nTotal matches: ${foundEntities.length}`);
  
  // Get relationships for the first matching entity
  if (foundEntities.length > 0) {
    const firstEntity = foundEntities[0];
    const entityId = firstEntity.entityId?.[0];
    const name = firstEntity.name?.[0];
    
    console.log(`\n=== RELATIONSHIPS FOR: ${name} ===`);
    
    const relResult = await invokeLambda({
      operation: 'getEntityRelationships',
      entityId: entityId
    });
    
    if (relResult.statusCode === 200) {
      const data = JSON.parse(relResult.body);
      
      if (data.result?.outgoing?.length > 0) {
        console.log('\nOutgoing relationships:');
        data.result.outgoing.forEach(rel => {
          console.log(`  → ${rel.type || 'RELATED_TO'} → ${rel.to} (confidence: ${rel.confidence || 'N/A'})`);
        });
      }
      
      if (data.result?.incoming?.length > 0) {
        console.log('\nIncoming relationships:');
        data.result.incoming.forEach(rel => {
          console.log(`  ← ${rel.type || 'RELATED_TO'} ← ${rel.from} (confidence: ${rel.confidence || 'N/A'})`);
        });
      }
      
      if (data.result?.totalRelationships === 0) {
        console.log('\nNo relationships found for this entity.');
      }
    }
  }
}

// Search for the term provided as command line argument or default to "Old Major"
const searchTerm = process.argv[2] || 'Old Major';
searchForEntity(searchTerm).catch(console.error);