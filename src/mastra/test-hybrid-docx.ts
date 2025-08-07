import { processHybridPDF } from './lib/pdf-processor-hybrid.js';
import { config } from 'dotenv';

// Load environment variables
config();

async function testHybridDocx() {
  try {
    // Test with a DOCX file from mammoth test data
    const testDocxPath = './node_modules/mammoth/test/test-data/simple-list.docx';
    
    console.log('Testing DOCX through hybrid processor...');
    console.log('File path:', testDocxPath);
    
    // Force it to use the line-based processor which has DOCX support
    const result = await processHybridPDF(testDocxPath, {
      forceMethod: 'line-based'
    });
    
    console.log('\nProcessing Result:');
    console.log('Success:', result.success);
    console.log('Message:', result.message);
    console.log('Index Name:', result.indexName);
    console.log('Total Chunks:', result.totalChunks);
    console.log('Method Used:', result.method);
    console.log('Error:', result.error);
    
    return result;
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testHybridDocx();