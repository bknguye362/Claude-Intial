import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function testSimpleRelationships() {
  console.log('=== TESTING SIMPLIFIED RELATIONSHIP QUERIES ===\n');
  
  // Get graph stats first
  console.log('1. Checking graph statistics...');
  const exploreResult = await invokeLambda({
    operation: 'explore'
  });
  
  if (exploreResult.statusCode === 200) {
    const result = JSON.parse(exploreResult.body);
    console.log(`  Total Vertices: ${result.result.summary.totalVertices}`);
    console.log(`  Total Edges: ${result.result.summary.totalEdges}`);
    console.log(`  Entities: ${result.result.summary.entityCount}`);
    
    if (result.result.summary.totalEdges > 0) {
      console.log('\n✅ Graph has edges/relationships!');
    } else {
      console.log('\n❌ No edges in graph');
    }
  }
  
  // Get a specific entity
  console.log('\n2. Getting first entity with relationships...');
  const personQuery = await invokeLambda({
    operation: 'queryEntitiesByType', 
    entityType: 'PERSON',
    limit: 3
  });
  
  if (personQuery.statusCode === 200) {
    const result = JSON.parse(personQuery.body);
    
    for (const entity of result.result.entities) {
      const entityId = entity.entityId?.[0];
      const name = entity.name?.[0];
      
      console.log(`\n  Testing entity: ${name} (${entityId})`);
      
      // Try to get relationships
      const relQuery = await invokeLambda({
        operation: 'getEntityRelationships',
        entityId: entityId
      });
      
      console.log(`    Status: ${relQuery.statusCode}`);
      if (relQuery.statusCode !== 200) {
        console.log(`    Error: ${JSON.parse(relQuery.body).error}`);
      } else {
        const relResult = JSON.parse(relQuery.body);
        console.log(`    Outgoing: ${relResult.result?.outgoing?.length || 0}`);
        console.log(`    Incoming: ${relResult.result?.incoming?.length || 0}`);
      }
    }
  }
}

testSimpleRelationships().catch(console.error);