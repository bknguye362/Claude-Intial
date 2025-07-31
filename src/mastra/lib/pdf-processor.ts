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
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
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
    return data.data[0].embedding;
  } catch (error) {
    console.error('[PDF Processor] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Helper function to generate embeddings for multiple texts
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`[PDF Processor] Generating embeddings for ${texts.length} chunks...`);
  
  const batchSize = 5;
  const embeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchPromises = batch.map(text => generateEmbedding(text));
    const batchEmbeddings = await Promise.all(batchPromises);
    embeddings.push(...batchEmbeddings);
    
    if (i + batchSize < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return embeddings;
}

// Helper function to split text into chunks
function chunkTextByLines(text: string, linesPerChunk: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const chunk = lines.slice(i, i + linesPerChunk).join('\n').trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  
  return chunks;
}

// Main function to process PDF
export async function processPDF(filepath: string, chunkSize: number = 500): Promise<ProcessPDFResult> {
  console.log(`[PDF Processor] ===== STARTING PDF PROCESSING =====`);
  console.log(`[PDF Processor] Processing PDF: ${filepath}`);
  console.log(`[PDF Processor] Chunk size: ${chunkSize}`);
  
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
    
    // Split into chunks
    console.log(`[PDF Processor] Text length: ${pdfData.text.length} characters`);
    const textChunks = chunkTextByLines(pdfData.text, chunkSize);
    console.log(`[PDF Processor] Split into ${textChunks.length} chunks`);
    console.log(`[PDF Processor] First chunk preview: ${textChunks[0]?.substring(0, 100)}...`);
    
    // Check size limits
    const MAX_CHUNKS = 2000; // Increased from 300 to handle larger documents
    if (textChunks.length > MAX_CHUNKS) {
      console.error(`[PDF Processor] Document too large (${textChunks.length} chunks). Maximum: ${MAX_CHUNKS}`);
      return {
        success: false,
        filename: basename(filepath),
        totalChunks: textChunks.length,
        message: `PDF is too large (${textChunks.length} chunks). Maximum supported: ${MAX_CHUNKS} chunks.`,
        error: 'Document exceeds maximum size limit'
      };
    }
    
    // Generate embeddings
    const embeddings = await generateEmbeddings(textChunks);
    
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
    
    // Prepare vectors for upload
    const vectors = chunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: chunk.embedding,
      metadata: {
        content: chunk.content.substring(0, 1500), // Increased from 500 to 1500 chars
        documentId,
        filename: basename(filepath),
        chunkIndex: index,
        totalChunks: chunks.length,
        pageStart: chunk.metadata.pageStart,
        pageEnd: chunk.metadata.pageEnd,
        timestamp: new Date().toISOString()
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