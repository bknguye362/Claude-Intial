// Document Processing Function for automatic workflow processing (PDF, TXT, and DOCX files)
// This is not a tool - it's a direct function called by the workflow

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';
import { dynamicChunk, convertToProcessorChunks } from './dynamic-chunker.js';

const require = createRequire(import.meta.url);

// Type definitions
interface PDFChunk {
  index: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  embedding?: number[];
}

interface ProcessPDFResult {
  success: boolean;
  filename: string;
  totalChunks?: number;
  indexName?: string;
  message: string;
  error?: string;
}

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

// Document parsing setup
let pdfParse: any = null;
let mammoth: any = null;

async function loadPdfParse() {
  try {
    const pdfParseModule = require('pdf-parse');
    return pdfParseModule;
  } catch (error) {
    console.error('[PDF Processor] Failed to load pdf-parse:', error);
    return null;
  }
}

async function loadMammoth() {
  try {
    const mammothModule = require('mammoth');
    return mammothModule;
  } catch (error) {
    console.error('[PDF Processor] Failed to load mammoth:', error);
    return null;
  }
}

// Initialize PDF parser
const pdf = async (dataBuffer: Buffer) => {
  if (!pdfParse) {
    pdfParse = await loadPdfParse();
  }
  
  if (!pdfParse) {
    throw new Error('PDF parser not available - please check if pdf-parse is installed');
  }
  
  return pdfParse(dataBuffer);
};

// Initialize DOCX parser
const docx = async (dataBuffer: Buffer) => {
  if (!mammoth) {
    mammoth = await loadMammoth();
  }
  
  if (!mammoth) {
    throw new Error('DOCX parser not available - please check if mammoth is installed');
  }
  
  const result = await mammoth.extractRawText({ buffer: dataBuffer });
  return {
    text: result.value,
    numpages: Math.ceil(result.value.length / 3000) // Estimate pages
  };
};

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Processor] No API key, using fallback embedding method');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    console.log('[PDF Processor] Fallback embedding generated. First 5 values:', embedding.slice(0, 5));
    return embedding;
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDINGS_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: 'text-embedding-ada-002'
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    const embedding = data.data[0].embedding;
    console.log('[PDF Processor] OpenAI embedding generated. First 5 values:', embedding.slice(0, 5));
    return embedding;
  } catch (error) {
    console.error('[PDF Processor] Error generating embedding:', error);
    console.log('[PDF Processor] Falling back to hash-based embedding');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    console.log('[PDF Processor] Fallback embedding after error. First 5 values:', embedding.slice(0, 5));
    return embedding;
  }
}

// Helper function to generate embeddings for multiple texts with rate limiting
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`[PDF Processor] Generating embeddings for ${texts.length} chunks...`);
  
  const embeddings: number[][] = [];
  
  // If using Azure OpenAI, process with controlled parallelism
  if (AZURE_OPENAI_API_KEY) {
    // Process in batches with limited concurrency
    const maxConcurrent = 3; // Process 3 at a time
    const batchDelay = 1500; // Delay between batches
    
    for (let i = 0; i < texts.length; i += maxConcurrent) {
      const batch = texts.slice(i, i + maxConcurrent);
      
      if (i % 30 === 0) {
        console.log(`[PDF Processor] Generating embeddings ${i + 1}-${Math.min(i + maxConcurrent, texts.length)}/${texts.length}`);
      }
      
      // Process batch in parallel
      const batchPromises = batch.map(async (text) => {
        try {
          return await generateEmbedding(text);
        } catch (error) {
          console.error('[PDF Processor] Embedding error, using fallback:', error);
          const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          return Array(1536).fill(0).map((_, j) => Math.sin(hash + j) * 0.5 + 0.5);
        }
      });
      
      const batchEmbeddings = await Promise.all(batchPromises);
      embeddings.push(...batchEmbeddings);
      
      // Delay between batches to respect rate limits
      if (i + maxConcurrent < texts.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }
  } else {
    // For fallback method, can process in parallel
    const batchSize = 5;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(text => generateEmbedding(text));
      const batchEmbeddings = await Promise.all(batchPromises);
      embeddings.push(...batchEmbeddings);
    }
  }
  
  return embeddings;
}

// Helper function to generate summary for a chunk using LLM
async function generateChunkSummary(chunkContent: string): Promise<string> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Processor] No API key, using fallback summary');
    // Return a simple summary if no API key
    const lines = chunkContent.split('\n').filter(l => l.trim());
    return lines.slice(0, 2).join(' ').substring(0, 200);
  }

  try {
    // Log chunk being sent to LLM
    console.log('[PDF Processor] Sending chunk to LLM for summary. First 200 chars:', chunkContent.substring(0, 200));
    console.log('[PDF Processor] Chunk length:', chunkContent.length, 'chars');
    
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that creates concise summaries of text chunks. Focus on the key concepts, topics, and information present in the chunk. Keep summaries under 150 words.'
          },
          {
            role: 'user',
            content: `Please summarize the following text chunk:\n\n${chunkContent.substring(0, 3000)}`
          }
        ],
        max_tokens: 200,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('[PDF Processor] Error generating summary:', error);
    // Fallback to simple summary
    const lines = chunkContent.split('\n').filter(l => l.trim());
    return lines.slice(0, 2).join(' ').substring(0, 200);
  }
}

// Helper function to generate summaries for multiple chunks
async function generateChunkSummaries(chunks: string[]): Promise<string[]> {
  console.log(`[PDF Processor] Generating summaries for ${chunks.length} chunks...`);
  
  const summaries: string[] = [];
  
  // If using Azure OpenAI, process with controlled parallelism
  if (AZURE_OPENAI_API_KEY) {
    const maxConcurrent = 2; // Process 2 summaries at a time (less than embeddings)
    const batchDelay = 1000; // Delay between batches
    
    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const batch = chunks.slice(i, i + maxConcurrent);
      
      if (i % 20 === 0) {
        console.log(`[PDF Processor] Generating summaries ${i + 1}-${Math.min(i + maxConcurrent, chunks.length)}/${chunks.length}`);
      }
      
      // Process batch in parallel
      const batchPromises = batch.map(async (chunk) => {
        try {
          return await generateChunkSummary(chunk);
        } catch (error) {
          console.error('[PDF Processor] Summary error, using fallback');
          const lines = chunk.split('\n').filter(l => l.trim());
          return lines.slice(0, 2).join(' ').substring(0, 200);
        }
      });
      
      const batchSummaries = await Promise.all(batchPromises);
      summaries.push(...batchSummaries);
      
      // Delay between batches
      if (i + maxConcurrent < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }
  } else {
    // For fallback method, just use simple summaries
    for (const chunk of chunks) {
      const lines = chunk.split('\n').filter(l => l.trim());
      summaries.push(lines.slice(0, 2).join(' ').substring(0, 200));
    }
  }
  
  return summaries;
}


// Helper function to find the end of a sentence
function findSentenceEnd(text: string, startPos: number, maxPos: number): number {
  // Look for sentence endings: . ! ? followed by space or newline or end of text
  const sentenceEndPattern = /[.!?](?:\s|$)/g;
  
  // Start searching from startPos
  sentenceEndPattern.lastIndex = startPos;
  
  let match;
  let lastGoodEnd = maxPos; // Default to maxPos if no sentence end found
  
  while ((match = sentenceEndPattern.exec(text)) !== null) {
    if (match.index <= maxPos) {
      // Found a sentence end within our chunk size limit
      lastGoodEnd = match.index + match[0].length;
    } else {
      // We've gone past our max position
      break;
    }
  }
  
  // If we couldn't find any sentence end, at least try to end at a word boundary
  if (lastGoodEnd === maxPos && maxPos < text.length) {
    // Look backwards from maxPos to find a space
    for (let i = maxPos; i > startPos && i > maxPos - 50; i--) {
      if (text[i] === ' ' || text[i] === '\n') {
        lastGoodEnd = i;
        break;
      }
    }
  }
  
  return lastGoodEnd;
}

// Helper function to split text into character-based chunks with overlap
function chunkTextByCharacters(text: string, chunkSize: number = 1000, overlapSize: number = 200): string[] {
  const chunks: string[] = [];
  let currentPos = 0;
  
  while (currentPos < text.length) {
    // Calculate the ideal end position for this chunk
    let idealEnd = currentPos + chunkSize;
    
    // If this would be the last chunk, take everything remaining
    if (idealEnd >= text.length) {
      const chunk = text.substring(currentPos).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      break;
    }
    
    // Find a good sentence boundary near the ideal end position
    // Allow up to 100 extra characters to complete a sentence
    const actualEnd = findSentenceEnd(text, currentPos, Math.min(idealEnd + 100, text.length));
    
    // Extract the chunk
    const chunk = text.substring(currentPos, actualEnd).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    
    // Move to the next chunk position with overlap
    // Calculate stride based on actual chunk size to maintain consistent overlap
    const actualChunkSize = actualEnd - currentPos;
    const stride = Math.max(1, actualChunkSize - overlapSize);
    currentPos += stride;
    
    // Prevent infinite loops
    if (stride <= 0) {
      currentPos = actualEnd;
    }
  }
  
  console.log(`[PDF Processor] Created ${chunks.length} chunks with sentence boundaries`);
  console.log(`[PDF Processor] Average chunk size: ${Math.round(text.length / chunks.length)} characters`);
  return chunks;
}

// Main function to process PDF, TXT, or DOCX files
export async function processPDF(filepath: string, chunkSize: number = 1000): Promise<ProcessPDFResult> {
  console.log(`[PDF Processor] ===== STARTING FILE PROCESSING =====`);
  console.log(`[PDF Processor] Processing file: ${filepath}`);
  console.log(`[PDF Processor] Chunk size: ${chunkSize} characters`);
  
  // Detect file type based on extension
  const fileExtension = filepath.toLowerCase().split('.').pop();
  const isPDF = fileExtension === 'pdf';
  const isTXT = fileExtension === 'txt';
  const isDOCX = fileExtension === 'docx';
  
  if (!isPDF && !isTXT && !isDOCX) {
    console.error(`[PDF Processor] Unsupported file type: .${fileExtension}`);
    return {
      success: false,
      filename: basename(filepath),
      message: `Unsupported file type: .${fileExtension}. Only PDF, TXT, and DOCX files are supported.`,
      error: 'UNSUPPORTED_FILE_TYPE'
    };
  }
  
  console.log(`[PDF Processor] File type detected: ${isPDF ? 'PDF' : isTXT ? 'TXT' : 'DOCX'}`);
  
  try {
    // Read file
    console.log(`[PDF Processor] Reading file from: ${filepath}`);
    const dataBuffer = await readFile(filepath);
    console.log(`[PDF Processor] File read successfully, buffer size: ${dataBuffer.length} bytes`);
    
    // Parse file based on type
    let pdfData: { text: string; numpages?: number };
    
    if (isPDF) {
      console.log(`[PDF Processor] Parsing PDF...`);
      pdfData = await pdf(dataBuffer);
      console.log(`[PDF Processor] PDF parsed successfully`);
    } else if (isTXT) {
      // For TXT files, create a compatible structure
      console.log(`[PDF Processor] Processing TXT file...`);
      const textContent = dataBuffer.toString('utf-8');
      pdfData = {
        text: textContent,
        numpages: Math.ceil(textContent.length / 3000) // Estimate pages (3000 chars per page)
      };
      console.log(`[PDF Processor] TXT file processed successfully`);
    } else {
      // For DOCX files, use mammoth to extract text
      console.log(`[PDF Processor] Parsing DOCX...`);
      pdfData = await docx(dataBuffer);
      console.log(`[PDF Processor] DOCX parsed successfully`);
    }
    
    const metadata = {
      title: (pdfData as any).info?.Title || basename(filepath),
      author: (pdfData as any).info?.Author || 'Unknown',
      pages: pdfData.numpages || 1,
      characters: pdfData.text.length,
      fileType: isPDF ? 'PDF' : isTXT ? 'TXT' : 'DOCX'
    };
    
    // Use dynamic paragraph-aware chunking
    console.log(`[PDF Processor] Text length: ${pdfData.text.length} characters`);
    console.log(`[PDF Processor] Using dynamic paragraph-aware chunking...`);
    
    const dynamicChunks = dynamicChunk(pdfData.text, chunkSize, 100); // 100 char overlap
    const textChunks = convertToProcessorChunks(dynamicChunks);
    
    console.log(`[PDF Processor] Split into ${textChunks.length} chunks`);
    console.log(`[PDF Processor] Chunk distribution:`);
    console.log(`[PDF Processor]   - Header chunks: ${dynamicChunks.filter(c => c.metadata.isHeader).length}`);
    console.log(`[PDF Processor]   - Average paragraphs per chunk: ${(dynamicChunks.reduce((sum, c) => sum + c.metadata.paragraphCount, 0) / dynamicChunks.length).toFixed(1)}`);
    console.log(`[PDF Processor] First chunk preview: ${textChunks[0]?.substring(0, 100)}...`);
    
    // Remove chunk limit - process all chunks but warn if very large
    if (textChunks.length > 2000) {
      console.warn(`[PDF Processor] Processing large document with ${textChunks.length} chunks. This may take a while...`);
    }
    
    // Generate index name and create index immediately
    const fileExt = isPDF ? '.pdf' : isTXT ? '.txt' : '.docx';
    const documentId = basename(filepath, fileExt);
    const cleanName = documentId
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const dateStr = new Date().toISOString().split('T')[0];
    const indexName = `file-${cleanName}-${dateStr}`;
    
    console.log(`[PDF Processor] Creating S3 Vectors index '${indexName}' IMMEDIATELY...`);
    const dimension = 1536; // OpenAI embeddings dimension
    const indexCreated = await createIndexWithNewman(indexName, dimension);
    console.log(`[PDF Processor] Index creation result: ${indexCreated}`);
    
    if (!indexCreated) {
      throw new Error(`Failed to create index '${indexName}'`);
    }
    
    console.log(`[PDF Processor] ✅ Index '${indexName}' created! Processing will continue...`)
    
    // Generate embeddings and summaries in parallel
    console.log(`[PDF Processor] Generating embeddings and summaries...`);
    const [embeddings, summaries] = await Promise.all([
      generateEmbeddings(textChunks),
      generateChunkSummaries(textChunks)
    ]);
    console.log(`[PDF Processor] Generated ${embeddings.length} embeddings and ${summaries.length} summaries`);
    
    // Create chunks with metadata including dynamic chunk info
    const chunks = textChunks.map((content, index) => {
      const chunkPosition = index / textChunks.length;
      const numPages = pdfData.numpages || 1;
      const pageStart = Math.floor(chunkPosition * numPages) + 1;
      const pageEnd = Math.min(
        Math.ceil((index + 1) / textChunks.length * numPages),
        numPages
      );
      
      // Get metadata from dynamic chunks if available
      const dynamicMeta = dynamicChunks[index]?.metadata;
      
      return {
        content,
        embedding: embeddings[index],
        metadata: {
          pageStart,
          pageEnd,
          chunkIndex: index,
          totalChunks: textChunks.length,
          isHeader: dynamicMeta?.isHeader || false,
          headerLevel: dynamicMeta?.headerLevel,
          paragraphCount: dynamicMeta?.paragraphCount || 1
        }
      };
    });
    
    // Index was already created at the beginning
    console.log(`[PDF Processor] Using existing index '${indexName}' for vector upload`);
    console.log(`[PDF Processor] Ready to upload ${chunks.length} vectors with embeddings`)
    
    // Prepare vectors for upload with metadata
    const vectors = chunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: chunk.embedding,
      metadata: {
        chunkIndex: index,
        pageStart: chunk.metadata.pageStart,
        pageEnd: chunk.metadata.pageEnd,
        totalChunks: chunks.length,
        // Store full chunk content (chunks are now 1000 chars)
        chunkContent: chunk.content,
        chunkSummary: (summaries[index] || '').substring(0, 200), // LLM-generated summary limited to 200 chars
        // Add document name for multi-document filtering
        docName: basename(filepath, fileExt).substring(0, 50) // Limited to 50 chars
      }
    }));
    
    console.log(`[PDF Processor] Uploading ${vectors.length} vectors to index '${indexName}'...`);
    const uploadedCount = await uploadVectorsWithNewman(indexName, vectors);
    
    console.log(`[PDF Processor] Upload complete. Uploaded ${uploadedCount} vectors to index '${indexName}'`);
    console.log(`[PDF Processor] ===== FILE PROCESSING COMPLETE =====`);
    
    return {
      success: true,
      filename: basename(filepath),
      totalChunks: chunks.length,
      indexName,
      message: `Successfully processed ${isPDF ? 'PDF' : isTXT ? 'TXT' : 'DOCX'} file '${basename(filepath)}' into ${chunks.length} chunks and created index '${indexName}'.`
    };
    
  } catch (error) {
    console.error('[PDF Processor] ===== ERROR IN FILE PROCESSING =====');
    console.error('[PDF Processor] Error:', error);
    console.error('[PDF Processor] Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
    return {
      success: false,
      filename: basename(filepath),
      message: `Failed to process ${fileExtension?.toUpperCase() || 'file'}`,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Alias for backward compatibility and clarity
export { processPDF as processDocument };

// Helper function to detect file type
export function getFileType(filepath: string): 'pdf' | 'txt' | 'docx' | 'unknown' {
  const extension = filepath.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'pdf';
  if (extension === 'txt') return 'txt';
  if (extension === 'docx') return 'docx';
  return 'unknown';
}