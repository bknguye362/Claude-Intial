import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// Dynamic import to avoid initialization errors
const pdf = async (dataBuffer: Buffer) => {
  const pdfParse = (await import('pdf-parse')).default;
  return pdfParse(dataBuffer);
};

// S3 client for reading files
const s3Client = process.env.AWS_S3_BUCKET ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
}) : null;

// In-memory storage for PDF chunks (in production, use a database)
const pdfChunksCache = new Map<string, {
  chunks: Array<{ index: number; content: string; pageStart: number; pageEnd: number }>;
  metadata: any;
  timestamp: number;
}>();

// Helper function to split text into chunks by lines
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

// Helper function to search chunks for relevant content
function searchChunks(
  chunks: Array<{ index: number; content: string; pageStart: number; pageEnd: number }>, 
  query: string
): Array<{ index: number; content: string; pageStart: number; pageEnd: number; relevanceScore: number }> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
  
  const scoredChunks = chunks.map(chunk => {
    const contentLower = chunk.content.toLowerCase();
    let score = 0;
    
    // Exact match gets highest score
    if (contentLower.includes(queryLower)) {
      score += 10;
    }
    
    // Count word matches
    queryWords.forEach(word => {
      const matches = (contentLower.match(new RegExp(word, 'g')) || []).length;
      score += matches * 2;
    });
    
    return { ...chunk, relevanceScore: score };
  });
  
  // Sort by relevance and return top chunks
  return scoredChunks
    .filter(chunk => chunk.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 10); // Return top 10 most relevant chunks
}

export const pdfChunkerTool = createTool({
  id: 'pdf-chunker',
  description: 'Read PDF files, split into chunks, and search for specific information. Perfect for Q&A about PDF documents.',
  inputSchema: z.object({
    filepath: z.string().describe('The file path of the PDF to read'),
    action: z.enum(['process', 'query']).describe('Action to perform: "process" to chunk the PDF, "query" to search existing chunks'),
    chunkSize: z.number().default(20).optional().describe('Number of lines per chunk (only for process action)'),
    query: z.string().optional().describe('Search query for finding relevant chunks (only for query action)'),
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
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const cacheKey = context.filepath;
      
      if (context.action === 'process') {
        console.log(`[PDF Chunker Tool] Processing PDF: ${context.filepath}`);
        
        let dataBuffer: Buffer;
        let filename: string;
        
        // Check if this is an S3 path
        if (context.filepath.startsWith('s3://')) {
          const s3PathMatch = context.filepath.match(/^s3:\/\/([^\/]+)\/(.+)$/);
          if (!s3PathMatch || !s3Client) {
            throw new Error('Invalid S3 path or S3 not configured');
          }
          
          const [, bucket, key] = s3PathMatch;
          filename = basename(key);
          
          const getObjectCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          });
          
          const response = await s3Client.send(getObjectCommand);
          const chunks: Uint8Array[] = [];
          
          for await (const chunk of response.Body as any) {
            chunks.push(chunk);
          }
          
          dataBuffer = Buffer.concat(chunks);
        } else {
          // Local file path
          const normalizedPath = context.filepath.replace(/\\/g, '/');
          if (!normalizedPath.includes('/uploads/')) {
            throw new Error('File must be in the uploads directory');
          }
          
          filename = basename(context.filepath);
          dataBuffer = await readFile(context.filepath);
        }
        
        // Parse the PDF
        const pdfData = await pdf(dataBuffer);
        
        // Extract metadata
        const metadata = {
          title: pdfData.info?.Title,
          author: pdfData.info?.Author,
          pages: pdfData.numpages,
          characters: pdfData.text.length,
        };
        
        // Split text into chunks
        const textChunks = chunkTextByLines(pdfData.text, context.chunkSize || 20);
        
        // Create chunk objects with estimated page numbers
        const chunks = textChunks.map((content, index) => {
          const chunkPosition = index / textChunks.length;
          const pageStart = Math.floor(chunkPosition * pdfData.numpages) + 1;
          const pageEnd = Math.min(
            Math.ceil((index + 1) / textChunks.length * pdfData.numpages),
            pdfData.numpages
          );
          
          return {
            index,
            content,
            pageStart,
            pageEnd,
          };
        });
        
        // Cache the chunks
        pdfChunksCache.set(cacheKey, {
          chunks,
          metadata,
          timestamp: Date.now(),
        });
        
        console.log(`[PDF Chunker Tool] Created ${chunks.length} chunks of ~${context.chunkSize || 20} lines each`);
        
        return {
          success: true,
          action: 'process',
          filename,
          totalChunks: chunks.length,
          chunks: chunks.slice(0, 3), // Return first 3 chunks as preview
          metadata,
          message: `Successfully processed PDF "${filename}" into ${chunks.length} chunks. Use 'query' action to search for specific content.`,
        };
        
      } else if (context.action === 'query') {
        // Check if PDF has been processed
        const cached = pdfChunksCache.get(cacheKey);
        
        if (!cached) {
          return {
            success: false,
            action: 'query',
            message: 'PDF has not been processed yet. Please use action "process" first.',
            error: 'PDF not found in cache',
          };
        }
        
        if (!context.query) {
          return {
            success: false,
            action: 'query',
            message: 'Query parameter is required for search action.',
            error: 'Missing query parameter',
          };
        }
        
        console.log(`[PDF Chunker Tool] Searching for: "${context.query}"`);
        
        // Search for relevant chunks
        const relevantChunks = searchChunks(cached.chunks, context.query);
        
        if (relevantChunks.length === 0) {
          // Return some chunks anyway for context
          return {
            success: true,
            action: 'query',
            filename: basename(context.filepath),
            totalChunks: cached.chunks.length,
            chunks: cached.chunks.slice(0, 5),
            message: `No direct matches found for "${context.query}". Showing first 5 chunks for context.`,
          };
        }
        
        return {
          success: true,
          action: 'query',
          filename: basename(context.filepath),
          totalChunks: cached.chunks.length,
          chunks: relevantChunks,
          message: `Found ${relevantChunks.length} relevant chunks for query: "${context.query}"`,
        };
      }
      
      return {
        success: false,
        action: context.action,
        message: 'Invalid action. Use "process" to chunk PDF or "query" to search.',
        error: 'Invalid action',
      };
      
    } catch (error) {
      console.error(`[PDF Chunker Tool] Error:`, error);
      return {
        success: false,
        action: context.action,
        message: 'Failed to process PDF',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});