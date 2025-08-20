import { createEntityKnowledgeGraph } from './dist/lib/entity-extractor-batch.js';

const testChunks = [
  { id: 'chunk_1', content: 'Apple Inc. was founded by Steve Jobs in Cupertino.', summary: 'About Apple' },
  { id: 'chunk_2', content: 'Microsoft was founded by Bill Gates in Seattle.', summary: 'About Microsoft' },
  { id: 'chunk_3', content: 'Google is based in Mountain View, California.', summary: 'About Google' }
];

console.log('Testing batch entity extractor...');
console.log('Azure API Key set:', process.env.AZURE_OPENAI_API_KEY ? 'YES' : 'NO');

createEntityKnowledgeGraph('test_doc', 'test_index', testChunks)
  .then(result => {
    console.log('Result:', result);
    console.log('Entities found:', result.entities.length);
    console.log('Relationships found:', result.relationships.length);
  })
  .catch(err => {
    console.error('Error:', err);
  });