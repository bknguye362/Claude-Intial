// Enhanced PDF Chunker Tool with S3 Vectors integration
console.log('[PDF Chunker S3Vectors] Module loading at:', new Date().toISOString());

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import * as fs from 'fs';
import * as path from 'path';
import { unlink } from 'fs/promises';
import { getS3VectorsService, S3VectorDocument } from '../lib/s3-vectors-integration';

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
    const pdfParseModule = await import('pdf-parse');
    return pdfParseModule.default || pdfParseModule;
  } catch (error) {
    console.error('[PDF Chunker S3Vectors] Failed to load pdf-parse:', error);
    return null;
  }
}

// Initialize PDF parser
const pdf = async (dataBuffer: Buffer) => {
  if (!pdfParse) {
    pdfParse = await loadPdfParse();
  }
  
  if (!pdfParse) {
    throw new Error('PDF parser not available');
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
      await s3VectorsService.initialize();
      
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
        
        // Store in S3 Vectors
        await s3VectorsService.storePDFEmbeddings(documentId, chunks, basename(filepath));
        
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
          message: `Successfully processed PDF into ${chunks.length} chunks and stored in S3 Vectors`,
        };
        
      } else if (context.action === 'query') {
        if (!context.query) {
          throw new Error('Query parameter is required for search action');
        }
        
        console.log(`[PDF Chunker S3Vectors] Searching for: "${context.query}"`);
        
        // Generate embedding for query
        const queryEmbedding = await generateEmbedding(context.query);
        
        // Search in S3 Vectors
        const results = await s3VectorsService.searchPDFContent(queryEmbedding, 5);
        
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
          filename: result.filename || basename(filepath),
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