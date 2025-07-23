// Enhanced PDF Chunker Tool with S3 Vectors integration
console.log('[PDF Chunker S3Vectors] Module loading at:', new Date().toISOString());

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import * as fs from 'fs';
import * as path from 'path';
import { unlink } from 'fs/promises';
import { getS3VectorsService, S3VectorDocument } from '../lib/s3-vectors-integration.js';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from '../lib/newman-executor.js';

const require = createRequire(import.meta.url);

// Type definitions
interface PDFChunk {
  index: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  embedding?: number[];
}

interface PDFChunkWithScore extends PDFChunk {
  relevanceScore: number;
}

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Initialize S3 Vectors
const s3VectorsService = getS3VectorsService();

// Helper function to generate embeddings using Azure OpenAI
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Chunker S3Vectors] No API key for embeddings, using mock embeddings...');
    // Return mock embeddings for testing
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
    console.error('[PDF Chunker S3Vectors] Error generating embedding:', error);
    // Return mock embeddings as fallback
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Helper function to generate embeddings for multiple texts
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`[PDF Chunker S3Vectors] Generating embeddings for ${texts.length} chunks...`);
  
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

// PDF parsing setup (simplified)
let pdfParse: any = null;

async function loadPdfParse() {
  try {
    console.log('[PDF Chunker S3Vectors] Attempting to load pdf-parse module...');
    // Use createRequire for CommonJS module compatibility
    const pdfParseModule = require('pdf-parse');
    console.log('[PDF Chunker S3Vectors] pdf-parse module loaded successfully');
    return pdfParseModule;
  } catch (error) {
    console.error('[PDF Chunker S3Vectors] Failed to load pdf-parse:', error);
    console.error('[PDF Chunker S3Vectors] Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    return null;
  }
}

// Initialize PDF parser
const pdf = async (dataBuffer: Buffer) => {
  if (!pdfParse) {
    console.log('[PDF Chunker S3Vectors] PDF parser not loaded, loading now...');
    pdfParse = await loadPdfParse();
  }
  
  if (!pdfParse) {
    console.error('[PDF Chunker S3Vectors] PDF parser is still null after loading attempt');
    throw new Error('PDF parser not available - please check if pdf-parse is installed');
  }
  
  return pdfParse(dataBuffer);
};

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

// Create summary of text
function createSummary(text: string, maxLength: number = 500): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences.length <= 3) return text;
  
  const summary = [
    sentences[0],
    ...sentences.slice(1, -1).filter((_, i) => i % Math.floor(sentences.length / 5) === 0).slice(0, 3),
    sentences[sentences.length - 1]
  ].join(' ');
  
  return summary.length > maxLength ? summary.substring(0, maxLength) + '...' : summary;
}

// Main tool definition
export const pdfChunkerS3VectorsTool = createTool({
  id: 'pdf-chunker-s3vectors',
  description: 'Read PDF files, split into chunks, store in S3 Vectors, and search with semantic similarity',
  inputSchema: z.object({
    filepath: z.string().optional().describe('The file path of the PDF to read'),
    filePath: z.string().optional().describe('The file path of the PDF to read (alternative)'),
    action: z.enum(['process', 'query', 'summarize']).describe('Action to perform'),
    chunkSize: z.number().default(200).optional().describe('Number of lines per chunk'),
    query: z.string().optional().describe('Search query for finding relevant chunks'),
    indexName: z.string().optional().describe('Custom index name to create and use (uses Postman if provided)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    filename: z.string().optional(),
    totalChunks: z.number().optional(),
    chunks: z.array(z.object({
      index: z.number(),
      content: z.string(),
      pageStart: z.number().optional(),
      pageEnd: z.number().optional(),
      relevanceScore: z.number().optional(),
    })).optional(),
    metadata: z.object({
      title: z.string().optional(),
      author: z.string().optional(),
      pages: z.number().optional(),
      characters: z.number().optional(),
    }).optional(),
    summary: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[PDF Chunker S3Vectors] ===== TOOL CALLED =====`);
    console.log(`[PDF Chunker S3Vectors] Action: ${context.action}`);
    
    try {
      // Initialize S3 Vectors index
      try {
        await s3VectorsService.initialize();
      } catch (initError) {
        console.error('[PDF Chunker S3Vectors] Failed to initialize S3 Vectors:', initError);
        // Continue without S3 Vectors - will work like the old tool
      }
      
      const filepath = context.filepath || context.filePath;
      if (!filepath) {
        throw new Error('Missing required parameter: filepath');
      }
      
      const documentId = basename(filepath, '.pdf');
      
      if (context.action === 'process') {
        console.log(`[PDF Chunker S3Vectors] Processing PDF: ${filepath}`);
        
        // Read and parse PDF
        const dataBuffer = await readFile(filepath);
        const pdfData = await pdf(dataBuffer);
        
        const metadata = {
          title: pdfData.info?.Title,
          author: pdfData.info?.Author,
          pages: pdfData.numpages,
          characters: pdfData.text.length,
        };
        
        // Split into chunks
        const textChunks = chunkTextByLines(pdfData.text, context.chunkSize || 200);
        console.log(`[PDF Chunker S3Vectors] Split into ${textChunks.length} chunks`);
        
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
        
        // Create index and store vectors
        let stats = { created: 0, updated: 0, total: chunks.length };
        let fileIndexName: string | null = null;
        
        // ALWAYS use Newman/Postman for index creation and vector storage
        // Generate index name if not provided
        if (!context.indexName) {
          // Create file-specific index name
          context.indexName = `file-${documentId}-${Date.now()}`;
          console.log(`[PDF Chunker S3Vectors] No index name provided, using: ${context.indexName}`);
        }
        
        console.log(`[PDF Chunker S3Vectors] Using Newman/Postman to create index '${context.indexName}'`);
        
        try {
          // Step 1: Create the index using Newman
          const dimension = embeddings[0]?.length || 1536;
          const indexCreated = await createIndexWithNewman(context.indexName, dimension);
          
          if (!indexCreated) {
            throw new Error(`Failed to create index '${context.indexName}'`);
          }
          
          // Step 2: Upload vectors using Newman
          console.log(`[PDF Chunker S3Vectors] Uploading ${chunks.length} chunks to index '${context.indexName}' using Newman...`);
          
          // Prepare vectors for upload
          const vectors = chunks.map((chunk, index) => ({
            key: `${documentId}-chunk-${index}`,
            embedding: chunk.embedding,
            metadata: {
              content: chunk.content.substring(0, 1000),
              documentId,
              filename: basename(filepath),
              chunkIndex: index,
              totalChunks: chunks.length,
              pageStart: chunk.metadata.pageStart,
              pageEnd: chunk.metadata.pageEnd,
              timestamp: new Date().toISOString()
            }
          }));
          
          const uploadedCount = await uploadVectorsWithNewman(context.indexName, vectors);
          stats.created = uploadedCount;
          
          fileIndexName = context.indexName;
          console.log(`[PDF Chunker S3Vectors] Completed: ${stats.created} vectors uploaded to index '${fileIndexName}' using Newman/Postman`);
          
        } catch (error) {
          console.error('[PDF Chunker S3Vectors] Error with Newman/Postman operations:', error);
          console.error('[PDF Chunker S3Vectors] Error details:', {
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            indexName: context.indexName,
            chunksCount: chunks.length
          });
          
          // Check if it's a Newman-specific error
          let errorDetails = 'Unknown error';
          if (error instanceof Error) {
            errorDetails = error.message;
            // Add more context for common errors
            if (error.message.includes('ENOENT')) {
              errorDetails = 'Newman executable not found. This might be a Heroku deployment issue.';
            } else if (error.message.includes('spawn')) {
              errorDetails = 'Failed to execute Newman. The Newman CLI might not be installed.';
            }
          }
          
          // Don't throw - return partial success with detailed error
          return {
            success: false,
            action: 'process',
            filename: basename(filepath),
            totalChunks: chunks.length,
            chunks: chunks.slice(0, 3).map((c, i) => ({
              index: i,
              content: c.content,
              pageStart: c.metadata.pageStart,
              pageEnd: c.metadata.pageEnd,
            })),
            metadata,
            message: `PDF was chunked successfully (${chunks.length} chunks) but failed to create S3 Vectors index: ${errorDetails}`,
            error: errorDetails,
          };
        }
        
        // Store file index mapping for later retrieval
        if (fileIndexName) {
          try {
            // Store the mapping in a JSON file
            const mappingPath = join('/tmp', 'file-index-mappings.json');
            let mappings: Record<string, string> = {};
            
            try {
              const existingData = await readFile(mappingPath, 'utf-8');
              mappings = JSON.parse(existingData);
            } catch (e) {
              // File doesn't exist yet
            }
            
            mappings[basename(filepath)] = fileIndexName;
            await fs.promises.writeFile(mappingPath, JSON.stringify(mappings, null, 2));
            console.log(`[PDF Chunker S3Vectors] Saved index mapping: ${basename(filepath)} -> ${fileIndexName}`);
          } catch (e) {
            console.error('[PDF Chunker S3Vectors] Failed to save index mapping:', e);
          }
        }
        
        return {
          success: true,
          action: 'process',
          filename: basename(filepath),
          totalChunks: chunks.length,
          chunks: chunks.slice(0, 3).map((c, i) => ({
            index: i,
            content: c.content,
            pageStart: c.metadata.pageStart,
            pageEnd: c.metadata.pageEnd,
          })),
          metadata,
          message: context.indexName 
            ? `Successfully processed PDF into ${chunks.length} chunks and uploaded ${stats.created} vectors to index '${fileIndexName}' using Postman.`
            : `Successfully processed PDF into ${chunks.length} chunks. S3 Vectors: ${stats.created} new vectors created in file-specific index '${fileIndexName}'.`,
        };
        
      } else if (context.action === 'query') {
        if (!context.query) {
          throw new Error('Query parameter is required for search action');
        }
        
        console.log(`[PDF Chunker S3Vectors] Searching for: "${context.query}"`);
        
        // Generate embedding for query
        const queryEmbedding = await generateEmbedding(context.query);
        
        // Search in S3 Vectors using the file index mapping
        let results: any[] = [];
        let fileIndexName: string | null = null;
        
        // First try to find the file-specific index
        const mappingPath = join('/tmp', 'file-index-mappings.json');
        
        try {
          const mappingData = await readFile(mappingPath, 'utf-8');
          const mappings = JSON.parse(mappingData);
          const filename = basename(filepath);
          fileIndexName = mappings[filename];
          console.log(`[PDF Chunker S3Vectors] Found file index for '${filename}': ${fileIndexName}`);
        } catch (e) {
          console.log('[PDF Chunker S3Vectors] No file index mapping found');
          // Return message asking user to process the file first
          return {
            success: false,
            action: 'query',
            filename: basename(filepath),
            message: `PDF not processed yet. Please process the PDF first before querying.`,
            chunks: [],
          };
        }
        
        if (!fileIndexName) {
          return {
            success: false,
            action: 'query',
            filename: basename(filepath),
            message: `No index found for this PDF. Please process the PDF first.`,
            chunks: [],
          };
        }
        
        // For now, return a message since we can't query via Newman yet
        // TODO: Implement query via Newman/Postman
        console.log(`[PDF Chunker S3Vectors] Query functionality via Newman not yet implemented`);
        
        return {
          success: false,
          action: 'query',
          filename: basename(filepath),
          message: `Query functionality is not yet available. The PDF has been indexed as '${fileIndexName}' but querying requires AWS CLI which is not available in this environment.`,
          chunks: [],
        };
        
      } else if (context.action === 'summarize') {
        console.log(`[PDF Chunker S3Vectors] Creating summary for: ${filepath}`);
        
        // Read and parse PDF directly for summarization
        const dataBuffer = await readFile(filepath);
        const pdfData = await pdf(dataBuffer);
        
        const metadata = {
          title: pdfData.info?.Title,
          author: pdfData.info?.Author,
          pages: pdfData.numpages,
          characters: pdfData.text.length,
        };
        
        // Create summary from the full text
        const summary = createSummary(pdfData.text, 1000);
        
        return {
          success: true,
          action: 'summarize',
          filename: basename(filepath),
          summary,
          metadata,
          message: 'Successfully created summary',
        };
      }
      
      throw new Error('Invalid action');
      
    } catch (error) {
      console.error(`[PDF Chunker S3Vectors] Error:`, error);
      return {
        success: false,
        action: context.action,
        message: 'Failed to process PDF',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});