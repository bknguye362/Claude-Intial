import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function debugRelationships() {
  console.log('=== DEBUGGING RELATIONSHIP QUERIES ===\n');
  
  // First, get a person entity
  console.log('1. Getting a PERSON entity...');
  const personQuery = await invokeLambda({
    operation: 'queryEntitiesByType',
    entityType: 'PERSON',
    limit: 1
  });
  
  if (personQuery.statusCode === 200) {
    const result = JSON.parse(personQuery.body);
    console.log('Person query result:', JSON.stringify(result, null, 2));
    
    if (result.result?.entities?.[0]) {
      const entity = result.result.entities[0];
      const entityId = entity.entityId?.[0];
      
      console.log('\n2. Getting relationships for entityId:', entityId);
      const relQuery = await invokeLambda({
        operation: 'getEntityRelationships',
        entityId: entityId
      });
      
      console.log('Relationship query status:', relQuery.statusCode);
      console.log('Relationship query response:', relQuery.body);
      
      if (relQuery.statusCode === 200) {
        const relResult = JSON.parse(relQuery.body);
        console.log('\nParsed relationship result:', JSON.stringify(relResult, null, 2));
      }
    }
  } else {
    console.log('Failed to get person entity:', personQuery.body);
  }
}

debugRelationships().catch(console.error);