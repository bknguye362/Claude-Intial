import { invokeLambda } from './lib/neptune-lambda-client.js';

console.log('=== Neptune Chunk Debug ===\n');

async function main() {
  try {
    // Call the debug operation to get chunk properties
    console.log('Getting chunk properties...');
    const result = await invokeLambda({
      operation: 'getChunkProperties'
    });
    
    console.log('\nLambda response:', JSON.stringify(result, null, 2));
    
    if (result.body) {
      const data = JSON.parse(result.body);
      if (data.success && data.result) {
        console.log('\n=== Chunk Properties ===');
        data.result.chunks.forEach((chunk, i) => {
          console.log(`\nChunk ${i + 1}:`);
          Object.entries(chunk).forEach(([key, value]) => {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
          });
        });
      }
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

main();