import mammoth from 'mammoth';
import { readFile } from 'fs/promises';

async function testDocx() {
  try {
    // Test with one of the mammoth test files
    const testFile = './node_modules/mammoth/test/test-data/simple-list.docx';
    console.log('Testing DOCX parsing with:', testFile);
    
    const dataBuffer = await readFile(testFile);
    console.log('Buffer size:', dataBuffer.length);
    
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    console.log('Extracted text:', result.value);
    console.log('Text length:', result.value.length);
    
    return result.value;
  } catch (error) {
    console.error('Error:', error);
  }
}

testDocx();