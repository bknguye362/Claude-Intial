import { invokeLambda } from './dist/lib/neptune-lambda-client.js';

async function checkOldMajorConnections() {
  console.log('=== CHECKING CONNECTIONS TO OLD MAJOR ===\n');
  
  // Entities that mention Old Major in their descriptions
  const relatedEntities = [
    { id: 'entity_person_willingdon_beauty', name: 'Willingdon Beauty', desc: 'Name under which Old Major had been exhibited' },
    { id: 'entity_person_sows', name: 'sows', desc: 'Sang an old song with Old Major\'s mother' },
    { id: 'entity_person_mother', name: 'mother', desc: 'Sang an old song to Old Major when he was a piglet' },
    { id: 'entity_location_raised_platform', name: 'raised platform', desc: 'Platform in the barn where Old Major sits' },
    { id: 'entity_concept_middle_white_boar', name: 'Middle White boar', desc: 'Breed of boar; old Major is a prize specimen' }
  ];
  
  console.log('Entities that mention "Old Major" in their descriptions:\n');
  
  for (const entity of relatedEntities) {
    console.log(`\nChecking: ${entity.name}`);
    console.log(`  Description: "${entity.desc}"`);
    console.log(`  Entity ID: ${entity.id}`);
    
    // Get relationships for this entity
    const result = await invokeLambda({
      operation: 'getEntityRelationships',
      entityId: entity.id
    });
    
    if (result.statusCode === 200) {
      const data = JSON.parse(result.body);
      let connectedToOldMajor = false;
      
      // Check outgoing relationships
      if (data.result?.outgoing) {
        for (const rel of data.result.outgoing) {
          if (rel.to === 'old Major') {
            console.log(`  ✅ HAS OUTGOING CONNECTION: ${entity.name} → ${rel.type || 'RELATED_TO'} → old Major`);
            connectedToOldMajor = true;
          }
        }
      }
      
      // Check incoming relationships
      if (data.result?.incoming) {
        for (const rel of data.result.incoming) {
          if (rel.from === 'old Major') {
            console.log(`  ✅ HAS INCOMING CONNECTION: old Major → ${rel.type || 'RELATED_TO'} → ${entity.name}`);
            connectedToOldMajor = true;
          }
        }
      }
      
      if (!connectedToOldMajor) {
        console.log(`  ❌ NO DIRECT CONNECTION to Old Major (despite mentioning him)`);
        console.log(`     Total relationships for this entity: ${data.result.totalRelationships}`);
      }
    } else {
      console.log(`  ⚠️ Error getting relationships: ${result.body}`);
    }
  }
  
  console.log('\n\n=== OLD MAJOR\'S ACTUAL CONNECTIONS ===');
  const oldMajorRel = await invokeLambda({
    operation: 'getEntityRelationships',
    entityId: 'entity_person_old_major'
  });
  
  if (oldMajorRel.statusCode === 200) {
    const data = JSON.parse(oldMajorRel.body);
    console.log('\nOld Major\'s outgoing connections:');
    if (data.result?.outgoing) {
      data.result.outgoing.forEach(rel => {
        console.log(`  → ${rel.type || 'RELATED_TO'} → ${rel.to}`);
      });
    }
    
    console.log('\nOld Major\'s incoming connections:');
    if (data.result?.incoming) {
      data.result.incoming.forEach(rel => {
        console.log(`  ← ${rel.type || 'RELATED_TO'} ← ${rel.from}`);
      });
    }
  }
}

checkOldMajorConnections().catch(console.error);