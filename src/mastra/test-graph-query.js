import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function testGraphQueries() {
  console.log('=== TESTING NEPTUNE GRAPH QUERIES ===\n');
  
  // Test 1: Find all PERSON entities
  console.log('1. Finding PERSON entities...');
  const personQuery = await invokeLambda({
    operation: 'queryGraph',
    query: "g.V().hasLabel('entity').has('entityType', 'PERSON').limit(5).valueMap(true)"
  });
  
  if (personQuery.statusCode === 200) {
    const result = JSON.parse(personQuery.body);
    console.log('   Found persons:', result.result?.length || 0);
    if (result.result?.[0]) {
      console.log('   Sample person:', result.result[0]);
    }
  }
  
  // Test 2: Find all ORGANIZATION entities
  console.log('\n2. Finding ORGANIZATION entities...');
  const orgQuery = await invokeLambda({
    operation: 'queryGraph',
    query: "g.V().hasLabel('entity').has('entityType', 'ORGANIZATION').limit(5).valueMap(true)"
  });
  
  if (orgQuery.statusCode === 200) {
    const result = JSON.parse(orgQuery.body);
    console.log('   Found organizations:', result.result?.length || 0);
    if (result.result?.[0]) {
      console.log('   Sample org:', result.result[0]);
    }
  }
  
  // Test 3: Find relationships
  console.log('\n3. Finding relationships...');
  const relQuery = await invokeLambda({
    operation: 'queryGraph',
    query: "g.E().limit(5).project('from', 'to', 'type').by(outV().values('name')).by(inV().values('name')).by(label())"
  });
  
  if (relQuery.statusCode === 200) {
    const result = JSON.parse(relQuery.body);
    console.log('   Found relationships:', result.result?.length || 0);
    if (result.result) {
      result.result.forEach(rel => {
        console.log(`   - ${rel.from} --[${rel.type}]--> ${rel.to}`);
      });
    }
  }
  
  // Test 4: Find connected entities (e.g., who works for which organization)
  console.log('\n4. Finding WORKS_FOR relationships...');
  const worksForQuery = await invokeLambda({
    operation: 'queryGraph',
    query: "g.V().hasLabel('entity').has('entityType', 'PERSON').outE('WORKS_FOR').inV().has('entityType', 'ORGANIZATION').path().by('name').by(label()).limit(5)"
  });
  
  if (worksForQuery.statusCode === 200) {
    const result = JSON.parse(worksForQuery.body);
    console.log('   Found WORKS_FOR relationships:', result.result?.length || 0);
    if (result.result) {
      result.result.forEach(path => {
        console.log(`   Path:`, path);
      });
    }
  }
  
  // Test 5: Count different entity types
  console.log('\n5. Entity type distribution...');
  const typeCountQuery = await invokeLambda({
    operation: 'queryGraph',
    query: "g.V().hasLabel('entity').groupCount().by('entityType')"
  });
  
  if (typeCountQuery.statusCode === 200) {
    const result = JSON.parse(typeCountQuery.body);
    console.log('   Entity types:', result.result);
  }
}

testGraphQueries().catch(console.error);