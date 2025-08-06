// PDF Processing Function for automatic workflow processing
// This is not a tool - it's a direct function called by the workflow

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';

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

// PDF parsing setup
let pdfParse: any = null;

async function loadPdfParse() {
  try {
    const pdfParseModule = require('pdf-parse');
    return pdfParseModule;
  } catch (error) {
    console.error('[PDF Processor] Failed to load pdf-parse:', error);
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
  
  // If using Azure OpenAI, process with adaptive rate limiting
  if (AZURE_OPENAI_API_KEY) {
    for (let i = 0; i < texts.length; i++) {
      if (i % 10 === 0) {
        console.log(`[PDF Processor] Generating embedding ${i + 1}/${texts.length}`);
      }
      const embedding = await generateEmbedding(texts[i]);
      embeddings.push(embedding);
      
      // Adaptive rate limiting based on chunk count
      if (i < texts.length - 1) {
        // For large documents (>100 chunks), use shorter delays
        const delay = texts.length > 100 ? 1000 : 2000;
        if (i % 10 === 9) {
          // Every 10th request, add extra delay to avoid burst limits
          await new Promise(resolve => setTimeout(resolve, delay * 2));
        } else {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
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
  
  // If using Azure OpenAI, process with adaptive rate limiting
  if (AZURE_OPENAI_API_KEY) {
    for (let i = 0; i < chunks.length; i++) {
      if (i % 10 === 0) {
        console.log(`[PDF Processor] Generating summary ${i + 1}/${chunks.length}`);
      }
      try {
        const summary = await generateChunkSummary(chunks[i]);
        summaries.push(summary);
      } catch (error) {
        console.error(`[PDF Processor] Error generating summary for chunk ${i}:`, error);
        // Use fallback summary on error
        const lines = chunks[i].split('\n').filter(l => l.trim());
        summaries.push(lines.slice(0, 2).join(' ').substring(0, 200));
      }
      
      // Adaptive rate limiting
      if (i < chunks.length - 1) {
        const delay = chunks.length > 100 ? 500 : 1000;
        if (i % 10 === 9) {
          await new Promise(resolve => setTimeout(resolve, delay * 2));
        } else {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
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


// Helper function to split text into character-based chunks with overlap
function chunkTextByCharacters(text: string, chunkSize: number = 1200, overlapSize: number = 200): string[] {
  const chunks: string[] = [];
  const stride = Math.max(1, chunkSize - overlapSize); // How many characters to advance each time
  
  for (let i = 0; i < text.length; i += stride) {
    const chunk = text.substring(i, i + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    // Stop if we've covered all text
    if (i + chunkSize >= text.length) {
      break;
    }
  }
  
  console.log(`[PDF Processor] Created ${chunks.length} chunks of ~${chunkSize} characters each`);
  return chunks;
}

// Main function to process PDF
export async function processPDF(filepath: string, chunkSize: number = 1200): Promise<ProcessPDFResult> {
  console.log(`[PDF Processor] ===== STARTING PDF PROCESSING =====`);
  console.log(`[PDF Processor] Processing PDF: ${filepath}`);
  console.log(`[PDF Processor] Chunk size: ${chunkSize} characters`);
  
  try {
    // Read and parse PDF
    console.log(`[PDF Processor] Reading file from: ${filepath}`);
    const dataBuffer = await readFile(filepath);
    console.log(`[PDF Processor] File read successfully, buffer size: ${dataBuffer.length} bytes`);
    
    console.log(`[PDF Processor] Parsing PDF...`);
    const pdfData = await pdf(dataBuffer);
    console.log(`[PDF Processor] PDF parsed successfully`);
    
    const metadata = {
      title: pdfData.info?.Title,
      author: pdfData.info?.Author,
      pages: pdfData.numpages,
      characters: pdfData.text.length,
    };
    
    // Split into character-based chunks
    console.log(`[PDF Processor] Text length: ${pdfData.text.length} characters`);
    const textChunks = chunkTextByCharacters(pdfData.text, chunkSize);
    console.log(`[PDF Processor] Split into ${textChunks.length} chunks`);
    console.log(`[PDF Processor] First chunk preview: ${textChunks[0]?.substring(0, 100)}...`);
    
    // Remove chunk limit - process all chunks but warn if very large
    if (textChunks.length > 2000) {
      console.warn(`[PDF Processor] Processing large document with ${textChunks.length} chunks. This may take a while...`);
    }
    
    // Generate embeddings and summaries in parallel
    console.log(`[PDF Processor] Generating embeddings and summaries...`);
    const [embeddings, summaries] = await Promise.all([
      generateEmbeddings(textChunks),
      generateChunkSummaries(textChunks)
    ]);
    console.log(`[PDF Processor] Generated ${embeddings.length} embeddings and ${summaries.length} summaries`);
    
    // Create chunks with metadata
    const chunks = textChunks.map((content, index) => {
      const chunkPosition = index / textChunks.length;
      const pageStart = Math.floor(chunkPosition * pdfData.numpages) + 1;
      const pageEnd = Math.min(
        Math.ceil((index + 1) / textChunks.length * pdfData.numpages),
        pdfData.numpages
      );
      
      return {
        content,
        embedding: embeddings[index],
        metadata: {
          pageStart,
          pageEnd,
          chunkIndex: index,
          totalChunks: textChunks.length,
        }
      };
    });
    
    // Generate index name
    const documentId = basename(filepath, '.pdf');
    const cleanName = documentId
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const dateStr = new Date().toISOString().split('T')[0];
    const indexName = `file-${cleanName}-${dateStr}`;
    
    console.log(`[PDF Processor] Creating S3 Vectors index '${indexName}'`);
    console.log(`[PDF Processor] Using dimension: ${embeddings[0]?.length || 1536}`);
    
    // Create index and upload vectors
    const dimension = embeddings[0]?.length || 1536;
    const indexCreated = await createIndexWithNewman(indexName, dimension);
    console.log(`[PDF Processor] Index creation result: ${indexCreated}`);
    
    if (!indexCreated) {
      throw new Error(`Failed to create index '${indexName}'`);
    }
    
    // Prepare vectors for upload with linked list structure
    const vectors = chunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: chunk.embedding,
      metadata: {
        chunkIndex: index,
        pageStart: chunk.metadata.pageStart,
        pageEnd: chunk.metadata.pageEnd,
        totalChunks: chunks.length,
        // Store full chunk content up to 1000 chars (chunks are now ~1200 chars)
        chunkContent: chunk.content.substring(0, 1000),
        chunkSummary: (summaries[index] || '').substring(0, 200) // LLM-generated summary limited to 200 chars
      }
    }));
    
    console.log(`[PDF Processor] Uploading ${vectors.length} vectors to index '${indexName}'...`);
    const uploadedCount = await uploadVectorsWithNewman(indexName, vectors);
    
    console.log(`[PDF Processor] Upload complete. Uploaded ${uploadedCount} vectors to index '${indexName}'`);
    console.log(`[PDF Processor] ===== PDF PROCESSING COMPLETE =====`);
    
    return {
      success: true,
      filename: basename(filepath),
      totalChunks: chunks.length,
      indexName,
      message: `Successfully processed PDF '${basename(filepath)}' into ${chunks.length} chunks and created index '${indexName}'.`
    };
    
  } catch (error) {
    console.error('[PDF Processor] ===== ERROR IN PDF PROCESSING =====');
    console.error('[PDF Processor] Error:', error);
    console.error('[PDF Processor] Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}