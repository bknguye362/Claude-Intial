import { processPDF } from './lib/pdf-processor.js';
import { config } from 'dotenv';
import { writeFile } from 'fs/promises';

// Load environment variables
config();

async function testDocxProcessing() {
  try {
    // Create a simple test DOCX file using one from mammoth test data
    const testDocxPath = './node_modules/mammoth/test/test-data/simple-list.docx';
    
    console.log('Testing DOCX processing...');
    console.log('File path:', testDocxPath);
    
    const result = await processPDF(testDocxPath);
    
    console.log('\nProcessing Result:');
    console.log('Success:', result.success);
    console.log('Message:', result.message);
    console.log('Index Name:', result.indexName);
    console.log('Total Chunks:', result.totalChunks);
    console.log('Error:', result.error);
    
    return result;
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testDocxProcessing();