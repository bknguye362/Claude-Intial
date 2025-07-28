// Test PDF auto-detection in file agent
console.log('=== TEST PDF AUTO-DETECTION ===\n');

// Simulate the pattern matching
const testMessages = [
  '[Uploaded files: document.pdf (./uploads/document.pdf)]',
  '[FILE_AGENT_TASK] Process this PDF (./uploads/analysis.pdf)',
  'Here is a regular message without files',
  '[Uploaded files: data.csv (./uploads/data.csv)]',  // Non-PDF
  'What is machine learning? [Uploaded files: ml-guide.pdf (./uploads/ml-guide.pdf)]'  // PDF with question
];

console.log('Testing pattern matching for PDF detection:\n');

for (const message of testMessages) {
  console.log(`Message: "${message}"`);
  
  // Check for uploaded files
  const uploadedFileMatch = message.match(/\[Uploaded files: ([^\]]+)\]/);
  const fileTaskMatch = message.match(/\[FILE_AGENT_TASK\]\s*([^(]+)\s*\(([^)]+)\)/);
  
  let filePath = null;
  
  if (fileTaskMatch) {
    filePath = fileTaskMatch[2];
  } else if (uploadedFileMatch) {
    const fileInfo = uploadedFileMatch[1];
    const pathMatch = fileInfo.match(/\(([^)]+)\)/);
    if (pathMatch) {
      filePath = pathMatch[1];
    }
  }
  
  if (filePath) {
    console.log(`  ✓ File detected: ${filePath}`);
    console.log(`  ✓ Is PDF: ${filePath.toLowerCase().endsWith('.pdf')}`);
  } else {
    console.log('  ✗ No file detected');
  }
  
  // Check if it's a question
  const questionPatterns = [
    /\?/,
    /^what\s/i,
    /^how\s/i,
    /^why\s/i,
    /^when\s/i,
    /^where\s/i,
    /^who\s/i
  ];
  
  const isQuestion = questionPatterns.some(pattern => pattern.test(message));
  console.log(`  ✓ Contains question: ${isQuestion}`);
  
  console.log('');
}

console.log('Pattern matching test complete!');