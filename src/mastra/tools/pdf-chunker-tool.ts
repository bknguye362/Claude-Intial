import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
// S3 imports removed - using local storage only

// Dynamic import to avoid initialization errors
const pdf = async (dataBuffer: Buffer) => {
  const pdfParse = (await import('pdf-parse')).default;
  return pdfParse(dataBuffer);
};

// S3 client disabled - using local storage only
const s3Client = null;

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

// Helper function to create a summary of text
function createSummary(text: string, maxLength: number = 500): string {
  // Simple summarization: take first and last parts, and key sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences.length <= 3) return text;
  
  // Take first sentence, some middle sentences, and last sentence
  const summary = [
    sentences[0],
    ...sentences.slice(1, -1).filter((_, i) => i % Math.floor(sentences.length / 5) === 0).slice(0, 3),
    sentences[sentences.length - 1]
  ].join(' ');
  
  return summary.length > maxLength ? summary.substring(0, maxLength) + '...' : summary;
}

// Helper function to recursively summarize chunks
async function recursiveSummarize(chunks: string[]): Promise<string> {
  console.log(`[PDF Chunker Tool] Starting recursive summarization of ${chunks.length} chunks`);
  
  if (chunks.length === 0) return 'No content to summarize';
  if (chunks.length === 1) return createSummary(chunks[0]);
  
  let currentSummary = '';
  const summaries: string[] = [];
  
  // Process each chunk and create cumulative summaries
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[PDF Chunker Tool] Processing chunk ${i + 1}/${chunks.length}`);
    
    // Create summary of current chunk
    const chunkSummary = createSummary(chunks[i]);
    
    if (i === 0) {
      // First chunk - just use its summary
      currentSummary = chunkSummary;
    } else {
      // Combine with previous summary
      const combined = currentSummary + '\n\n' + chunkSummary;
      currentSummary = createSummary(combined, 800);
    }
    
    // Store intermediate summaries for potential use
    summaries.push(currentSummary);
    
    // Log progress every 10 chunks
    if ((i + 1) % 10 === 0) {
      console.log(`[PDF Chunker Tool] Processed ${i + 1} chunks, current summary length: ${currentSummary.length} chars`);
    }
  }
  
  console.log(`[PDF Chunker Tool] Completed recursive summarization. Final summary length: ${currentSummary.length} chars`);
  return currentSummary;
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
    filepath: z.string().optional().describe('The file path of the PDF to read'),
    filePath: z.string().optional().describe('The file path of the PDF to read (alternative parameter name)'),
    action: z.enum(['process', 'query', 'summarize']).describe('Action to perform: "process" to chunk the PDF, "query" to search existing chunks, "summarize" to create a recursive summary'),
    chunkSize: z.number().default(200).optional().describe('Number of lines per chunk (only for process action)'),
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
    summary: z.string().optional().describe('Recursive summary of the document'),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[PDF Chunker Tool] ===== TOOL CALLED =====`);
    console.log(`[PDF Chunker Tool] Context:`, JSON.stringify(context));
    
    try {
      // Handle both 'filepath' and 'filePath' for compatibility
      const filepath = context.filepath || context.filePath;
      if (!filepath) {
        throw new Error('Missing required parameter: filepath or filePath');
      }
      const cacheKey = filepath;
      
      if (context.action === 'process') {
        console.log(`\n[PDF Chunker Tool] ========== PROCESS ACTION ==========`);
        console.log(`[PDF Chunker Tool] Processing PDF: ${filepath}`);
        console.log(`[PDF Chunker Tool] Chunk size: ${context.chunkSize || 200} lines`);
        
        let dataBuffer: Buffer;
        let filename: string;
        
        // Local file path only
        const normalizedPath = filepath.replace(/\\/g, '/');
        if (!normalizedPath.includes('/uploads/')) {
          throw new Error('File must be in the uploads directory');
        }
        
        filename = basename(filepath);
        dataBuffer = await readFile(filepath);
        
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
        const textChunks = chunkTextByLines(pdfData.text, context.chunkSize || 200);
        console.log(`[PDF Chunker Tool] Split PDF into ${textChunks.length} chunks`);
        
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
        
        console.log(`[PDF Chunker Tool] ✓ Cached ${chunks.length} chunks for: ${cacheKey}`);
        console.log(`[PDF Chunker Tool] Cache now contains PDFs:`, Array.from(pdfChunksCache.keys()));
        
        console.log(`[PDF Chunker Tool] Created ${chunks.length} chunks of ~${context.chunkSize || 200} lines each`);
        
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
        console.log(`\n[PDF Chunker Tool] ========== QUERY ACTION ==========`);
        console.log(`[PDF Chunker Tool] Looking for cached PDF: ${cacheKey}`);
        console.log(`[PDF Chunker Tool] Currently cached PDFs:`, Array.from(pdfChunksCache.keys()));
        
        // Check if PDF has been processed
        const cached = pdfChunksCache.get(cacheKey);
        
        if (!cached) {
          console.log(`[PDF Chunker Tool] ❌ ERROR: PDF not found in cache!`);
          console.log(`[PDF Chunker Tool] Available keys:`, Array.from(pdfChunksCache.keys()));
          console.log(`[PDF Chunker Tool] Requested key: "${cacheKey}"`);
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
        console.log(`[PDF Chunker Tool] Total chunks available: ${cached.chunks.length}`);
        
        // Search for relevant chunks
        const relevantChunks = searchChunks(cached.chunks, context.query);
        console.log(`[PDF Chunker Tool] Found ${relevantChunks.length} relevant chunks`);
        
        if (relevantChunks.length === 0) {
          // Return some chunks anyway for context
          return {
            success: true,
            action: 'query',
            filename: basename(filepath),
            totalChunks: cached.chunks.length,
            chunks: cached.chunks.slice(0, 5),
            message: `No direct matches found for "${context.query}". Showing first 5 chunks for context.`,
          };
        }
        
        return {
          success: true,
          action: 'query',
          filename: basename(filepath),
          totalChunks: cached.chunks.length,
          chunks: relevantChunks,
          message: `Found ${relevantChunks.length} relevant chunks for query: "${context.query}"`,
        };
      } else if (context.action === 'summarize') {
        console.log(`\n[PDF Chunker Tool] ========== SUMMARIZE ACTION ==========`);
        console.log(`[PDF Chunker Tool] Creating recursive summary for: ${filepath}`);
        
        let dataBuffer: Buffer;
        let filename: string;
        
        // Check if PDF is already processed
        const cached = pdfChunksCache.get(cacheKey);
        
        if (cached) {
          // Use cached chunks
          console.log(`[PDF Chunker Tool] Using cached chunks for summarization`);
          const chunkTexts = cached.chunks.map(chunk => chunk.content);
          const summary = await recursiveSummarize(chunkTexts);
          
          return {
            success: true,
            action: 'summarize',
            filename: basename(filepath),
            totalChunks: cached.chunks.length,
            summary,
            metadata: cached.metadata,
            message: `Successfully created recursive summary of "${basename(filepath)}" from ${cached.chunks.length} chunks.`,
          };
        } else {
          // Need to process the PDF first
          console.log(`[PDF Chunker Tool] PDF not cached, processing first...`);
          
          // Local file path only
          const normalizedPath = filepath.replace(/\\/g, '/');
          if (!normalizedPath.includes('/uploads/')) {
            throw new Error('File must be in the uploads directory');
          }
          
          filename = basename(filepath);
          dataBuffer = await readFile(filepath);
          
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
          const textChunks = chunkTextByLines(pdfData.text, context.chunkSize || 200);
          console.log(`[PDF Chunker Tool] Split PDF into ${textChunks.length} chunks for summarization`);
          
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
          
          // Cache the chunks for future use
          pdfChunksCache.set(cacheKey, {
            chunks,
            metadata,
            timestamp: Date.now(),
          });
          
          // Create recursive summary
          const summary = await recursiveSummarize(textChunks);
          
          return {
            success: true,
            action: 'summarize',
            filename,
            totalChunks: chunks.length,
            summary,
            metadata,
            message: `Successfully processed and created recursive summary of "${filename}" from ${chunks.length} chunks.`,
          };
        }
      }
      
      return {
        success: false,
        action: context.action,
        message: 'Invalid action. Use "process" to chunk PDF, "query" to search, or "summarize" to create a recursive summary.',
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