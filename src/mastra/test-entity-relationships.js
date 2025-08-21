import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function exploreEntitiesAndRelationships() {
  console.log('=== EXPLORING ENTITIES AND RELATIONSHIPS ===\n');
  
  // Step 1: Get some PERSON entities
  console.log('1. Finding PERSON entities...');
  const personQuery = await invokeLambda({
    operation: 'queryEntitiesByType',
    entityType: 'PERSON',
    limit: 5
  });
  
  if (personQuery.statusCode === 200) {
    const result = JSON.parse(personQuery.body);
    console.log(`   Found ${result.result?.count || 0} persons\n`);
    
    if (result.result?.entities && result.result.entities.length > 0) {
      // Show each person and their relationships
      for (let i = 0; i < Math.min(3, result.result.entities.length); i++) {
        const entity = result.result.entities[i];
        console.log(`\n   Person ${i + 1}:`);
        console.log(`   - Name: ${entity.name?.[0] || 'Unknown'}`);
        console.log(`   - Type: ${entity.entityType?.[0] || 'PERSON'}`);
        console.log(`   - ID: ${entity.entityId?.[0] || 'No ID'}`);
        
        // Get relationships for this entity
        if (entity.entityId?.[0]) {
          const relQuery = await invokeLambda({
            operation: 'getEntityRelationships',
            entityId: entity.entityId[0]
          });
          
          if (relQuery.statusCode === 200) {
            const relResult = JSON.parse(relQuery.body);
            console.log(`   - Outgoing relationships: ${relResult.result?.outgoing?.length || 0}`);
            console.log(`   - Incoming relationships: ${relResult.result?.incoming?.length || 0}`);
            
            if (relResult.result?.outgoing && relResult.result.outgoing.length > 0) {
              console.log('     Outgoing:');
              relResult.result.outgoing.slice(0, 3).forEach(rel => {
                console.log(`       → ${rel.type} → ${rel.to}`);
              });
            }
            
            if (relResult.result?.incoming && relResult.result.incoming.length > 0) {
              console.log('     Incoming:');
              relResult.result.incoming.slice(0, 3).forEach(rel => {
                console.log(`       ← ${rel.type} ← ${rel.from}`);
              });
            }
          }
        }
      }
    }
  }
  
  console.log('\n\n2. Finding ORGANIZATION entities...');
  const orgQuery = await invokeLambda({
    operation: 'queryEntitiesByType',
    entityType: 'ORGANIZATION',
    limit: 5
  });
  
  if (orgQuery.statusCode === 200) {
    const result = JSON.parse(orgQuery.body);
    console.log(`   Found ${result.result?.count || 0} organizations\n`);
    
    if (result.result?.entities && result.result.entities.length > 0) {
      for (let i = 0; i < Math.min(2, result.result.entities.length); i++) {
        const entity = result.result.entities[i];
        console.log(`\n   Organization ${i + 1}:`);
        console.log(`   - Name: ${entity.name?.[0] || 'Unknown'}`);
        console.log(`   - Type: ${entity.entityType?.[0] || 'ORGANIZATION'}`);
        console.log(`   - ID: ${entity.entityId?.[0] || 'No ID'}`);
      }
    }
  }
  
  console.log('\n\n3. Finding LOCATION entities...');
  const locQuery = await invokeLambda({
    operation: 'queryEntitiesByType',
    entityType: 'LOCATION',
    limit: 5
  });
  
  if (locQuery.statusCode === 200) {
    const result = JSON.parse(locQuery.body);
    console.log(`   Found ${result.result?.count || 0} locations\n`);
    
    if (result.result?.entities && result.result.entities.length > 0) {
      for (let i = 0; i < Math.min(2, result.result.entities.length); i++) {
        const entity = result.result.entities[i];
        console.log(`\n   Location ${i + 1}:`);
        console.log(`   - Name: ${entity.name?.[0] || 'Unknown'}`);
        console.log(`   - Type: ${entity.entityType?.[0] || 'LOCATION'}`);
      }
    }
  }
  
  // Show different entity types
  console.log('\n\n4. Checking all entity types...');
  const allTypes = ['PERSON', 'ORGANIZATION', 'LOCATION', 'CONCEPT', 'TECHNOLOGY', 'EVENT', 'PRODUCT'];
  
  for (const type of allTypes) {
    const query = await invokeLambda({
      operation: 'queryEntitiesByType',
      entityType: type,
      limit: 1
    });
    
    if (query.statusCode === 200) {
      const result = JSON.parse(query.body);
      const count = result.result?.count || 0;
      if (count > 0) {
        console.log(`   - ${type}: ${count} found`);
      }
    }
  }
}

exploreEntitiesAndRelationships().catch(console.error);