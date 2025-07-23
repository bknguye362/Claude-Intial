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
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
        
        // If custom index name provided, create it and use it
        if (context.indexName) {
          console.log(`[PDF Chunker S3Vectors] Creating custom index '${context.indexName}'`);
          
          try {
            // Step 1: Create the index using AWS CLI
            const bucketName = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
            const region = process.env.S3_VECTORS_REGION || 'us-east-2';
            const dimension = embeddings[0]?.length || 1536;
            
            const createCommand = `aws s3vectors create-index --vector-bucket-name ${bucketName} --index-name ${context.indexName} --dimension ${dimension} --distance-metric cosine --data-type float32 --region ${region}`;
            
            try {
              await execAsync(createCommand);
              console.log(`[PDF Chunker S3Vectors] Successfully created index '${context.indexName}'`);
            } catch (createError: any) {
              if (createError.message.includes('AlreadyExistsException')) {
                console.log(`[PDF Chunker S3Vectors] Index '${context.indexName}' already exists, using it`);
              } else {
                throw createError;
              }
            }
            
            // Step 2: Store chunks in the custom index
            console.log(`[PDF Chunker S3Vectors] Storing ${chunks.length} chunks in index '${context.indexName}'...`);
            
            // Process in batches
            const batchSize = 25;
            for (let i = 0; i < chunks.length; i += batchSize) {
              const batch = chunks.slice(i, i + batchSize);
              
              const vectorData = batch.map((chunk, batchIndex) => ({
                key: `${documentId}-chunk-${i + batchIndex}`,
                data: {
                  float32: chunk.embedding
                },
                metadata: {
                  content: chunk.content.substring(0, 1000),
                  documentId,
                  filename: basename(filepath),
                  chunkIndex: i + batchIndex,
                  totalChunks: chunks.length,
                  timestamp: new Date().toISOString(),
                  pageStart: chunk.metadata.pageStart,
                  pageEnd: chunk.metadata.pageEnd
                }
              }));
              
              const fs = require('fs').promises;
              const tempFile = `/tmp/vectors-batch-${Date.now()}.json`;
              await fs.writeFile(tempFile, JSON.stringify(vectorData));
              
              try {
                const putCommand = `aws s3vectors put-vectors --vector-bucket-name ${bucketName} --index-name ${context.indexName} --vectors file://${tempFile} --region ${region}`;
                await execAsync(putCommand);
                stats.created += batch.length;
                
                console.log(`[PDF Chunker S3Vectors] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}: ${batch.length} chunks stored`);
              } catch (error) {
                console.error(`[PDF Chunker S3Vectors] Error storing batch:`, error);
              } finally {
                await fs.unlink(tempFile);
              }
            }
            
            fileIndexName = context.indexName;
            console.log(`[PDF Chunker S3Vectors] Completed: ${stats.created} vectors stored in index '${fileIndexName}'`);
            
          } catch (error) {
            console.error('[PDF Chunker S3Vectors] Error creating/populating custom index:', error);
            throw error;
          }
          
        } else {
          // Original behavior: create file-specific index
          try {
            fileIndexName = await s3VectorsService.createFileIndex(basename(filepath));
            console.log(`[PDF Chunker S3Vectors] Created index '${fileIndexName}' for file '${basename(filepath)}'`);
            
            stats = await s3VectorsService.storePDFInFileIndex(fileIndexName, documentId, chunks, basename(filepath));
            
            await s3VectorsService.storePDFEmbeddings(documentId, chunks, basename(filepath));
          } catch (s3Error) {
            console.error('[PDF Chunker S3Vectors] Failed to store in S3 Vectors:', s3Error);
          }
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
        
        // Search in S3 Vectors
        let results: any[] = [];
        try {
          // First try to find the file-specific index
          const mappingPath = join('/tmp', 'file-index-mappings.json');
          let fileIndexName: string | null = null;
          
          try {
            const mappingData = await readFile(mappingPath, 'utf-8');
            const mappings = JSON.parse(mappingData);
            const filename = basename(filepath);
            fileIndexName = mappings[filename];
            console.log(`[PDF Chunker S3Vectors] Found file index for '${filename}': ${fileIndexName}`);
          } catch (e) {
            console.log('[PDF Chunker S3Vectors] No file index mapping found, using main index');
          }
          
          if (fileIndexName) {
            // Search in the file-specific index
            results = await s3VectorsService.searchFileIndex(fileIndexName, queryEmbedding, 5);
            console.log(`[PDF Chunker S3Vectors] Searched in file index '${fileIndexName}', found ${results.length} results`);
          } else {
            // Fallback to searching the main index
            results = await s3VectorsService.searchPDFContent(queryEmbedding, 5);
            console.log(`[PDF Chunker S3Vectors] Searched in main index, found ${results.length} results`);
          }
        } catch (searchError) {
          console.error('[PDF Chunker S3Vectors] S3 Vectors search failed:', searchError);
          // Fallback: return empty results
          results = [];
        }
        
        if (results.length === 0) {
          return {
            success: true,
            action: 'query',
            filename: basename(filepath),
            message: `No matches found for "${context.query}"`,
            chunks: [],
          };
        }
        
        // Convert results to expected format
        const chunks = results.map((result, index) => ({
          index: result.chunkIndex || index,
          content: result.content,
          pageStart: 1,
          pageEnd: 1,
          relevanceScore: result.score,
        }));
        
        return {
          success: true,
          action: 'query',
          filename: results[0]?.filename || basename(filepath),
          totalChunks: chunks.length,
          chunks,
          message: `Found ${results.length} relevant chunks using S3 Vectors semantic search`,
        };
        
      } else if (context.action === 'summarize') {
        console.log(`[PDF Chunker S3Vectors] Creating summary for: ${filepath}`);
        
        // For summarize, we need to process if not already done
        const queryEmbedding = await generateEmbedding("document summary overview");
        const results = await s3VectorsService.searchPDFContent(queryEmbedding, 10);
        
        let summary: string;
        if (results.length > 0) {
          // Use existing chunks
          const texts = results.map(r => r.content);
          summary = createSummary(texts.join('\n\n'), 1000);
        } else {
          // Process the PDF first
          const dataBuffer = await readFile(filepath);
          const pdfData = await pdf(dataBuffer);
          summary = createSummary(pdfData.text, 1000);
        }
        
        return {
          success: true,
          action: 'summarize',
          filename: basename(filepath),
          summary,
          message: 'Successfully created summary using S3 Vectors',
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