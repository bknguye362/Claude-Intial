import { createChunkRelationships } from './lib/neptune-lambda-client.js';

console.log('=== Creating Test Edges ===\n');

async function main() {
  try {
    // Create edges between the actual chunks in the database
    // Based on debug output, we have chunks with gremlin.id like "test-chunk-1", "test-chunk-2"
    
    console.log('Creating edge between test-chunk-1 and test-chunk-2...');
    
    const result = await createChunkRelationships('test-chunk-1', [
      {
        id: 'test-chunk-2',
        relationship: 'FOLLOWS',
        strength: 1.0
      }
    ]);
    
    console.log('Result:', result);
    
    // Also create reverse relationship
    console.log('\nCreating reverse edge...');
    const result2 = await createChunkRelationships('test-chunk-2', [
      {
        id: 'test-chunk-1',
        relationship: 'PRECEDES',
        strength: 1.0
      }
    ]);
    
    console.log('Result:', result2);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();