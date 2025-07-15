console.log('[PDF Chunker Tool] Module loading at:', new Date().toISOString());

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import * as fs from 'fs';
import * as path from 'path';
// S3 imports removed - using local storage only

// Workaround for pdf-parse debug mode issue
// We need to prevent the module check that triggers debug mode
let pdfParse: any = null;

// Pre-set globals to prevent pdf-parse debug mode
if (typeof global !== 'undefined') {
  // Force module.parent to exist before any imports
  if (typeof module !== 'undefined' && !module.parent) {
    (module as any).parent = { filename: 'fake-parent' };
  }
  // Set flags that might prevent debug mode
  (global as any).PDF_PARSE_NO_DEBUG = true;
  (global as any).NODE_ENV = 'production';
}

// Fallback PDF text extraction using basic parsing
async function fallbackPdfParse(dataBuffer: Buffer) {
  console.log(`[PDF Chunker Tool] Using fallback PDF parser...`);
  
  // Convert buffer to string and try to extract text
  const pdfString = dataBuffer.toString('binary');
  const textParts: string[] = [];
  
  // Helper function to decode PDF strings with better handling
  function decodePdfString(str: string): string {
    // First, handle octal sequences
    let decoded = str.replace(/\\(\d{1,3})/g, (_, oct) => {
      const code = parseInt(oct, 8);
      return String.fromCharCode(code);
    });
    
    // Handle escape sequences
    decoded = decoded
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    
    return decoded;
  }
  
  // Method 1: Extract text between BT (Begin Text) and ET (End Text) markers
  const textMatches = pdfString.matchAll(/BT\s*(.*?)\s*ET/gs);
  
  for (const match of textMatches) {
    const content = match[1];
    // Extract text from Tj and TJ operators
    const tjMatches = content.matchAll(/\((.*?)\)\s*Tj/g);
    const tjArrayMatches = content.matchAll(/\[(.*?)\]\s*TJ/g);
    
    for (const tjMatch of tjMatches) {
      const text = decodePdfString(tjMatch[1]);
      if (text.trim() && /[a-zA-Z]/.test(text)) {
        textParts.push(text);
      }
    }
    
    for (const tjArrayMatch of tjArrayMatches) {
      const arrayContent = tjArrayMatch[1];
      const strings = arrayContent.matchAll(/\((.*?)\)/g);
      for (const strMatch of strings) {
        const text = decodePdfString(strMatch[1]);
        if (text.trim() && /[a-zA-Z]/.test(text)) {
          textParts.push(text);
        }
      }
    }
  }
  
  // Method 2: Look for text in streams (for compressed content)
  if (textParts.length === 0) {
    console.log(`[PDF Chunker Tool] No text found with BT/ET, trying stream extraction...`);
    
    // Find all stream objects
    const streamMatches = pdfString.matchAll(/stream\s*\n(.*?)\nendstream/gs);
    
    for (const streamMatch of streamMatches) {
      const streamContent = streamMatch[1];
      
      // Check if stream might be compressed (FlateDecode)
      if (streamContent.charCodeAt(0) === 0x78 && streamContent.charCodeAt(1) === 0x9C) {
        try {
          // Try to decompress using zlib
          const zlib = await import('zlib');
          const buffer = Buffer.from(streamContent, 'binary');
          const decompressed = zlib.inflateSync(buffer);
          const decompressedText = decompressed.toString('utf8');
          
          // Extract text from decompressed content
          const tjInStream = decompressedText.matchAll(/\((.*?)\)\s*Tj/g);
          for (const match of tjInStream) {
            const text = decodePdfString(match[1]);
            if (text.trim() && /[a-zA-Z]/.test(text)) {
              textParts.push(text);
            }
          }
        } catch (err) {
          // Decompression failed, try raw extraction
        }
      }
      
      // Fallback: Try to find readable text in the stream
      // Look for sequences of printable ASCII characters
      const readableMatches = streamContent.matchAll(/[\x20-\x7E]{4,}/g);
      
      for (const readable of readableMatches) {
        const text = readable[0];
        // Filter out obvious non-text content
        if (!text.match(/^[0-9.\s]+$/) && !text.match(/^[A-Z0-9_]+$/) && /[a-zA-Z]{3,}/.test(text)) {
          textParts.push(text);
        }
      }
    }
  }
  
  // Method 3: Try hex string extraction (for PDFs using hex encoding)
  if (textParts.length < 10) {
    console.log(`[PDF Chunker Tool] Trying hex string extraction...`);
    const hexMatches = pdfString.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g);
    
    for (const hexMatch of hexMatches) {
      const hex = hexMatch[1];
      if (hex.length % 2 === 0) {
        let text = '';
        for (let i = 0; i < hex.length; i += 2) {
          const code = parseInt(hex.substr(i, 2), 16);
          text += String.fromCharCode(code);
        }
        text = text.trim();
        if (text.length > 2 && /[a-zA-Z]/.test(text)) {
          textParts.push(text);
        }
      }
    }
  }
  
  // Method 4: Look for Unicode mappings (for modern PDFs)
  const toUnicodeMatches = pdfString.matchAll(/beginbfchar(.*?)endbfchar/gs);
  const unicodeMap = new Map();
  
  for (const match of toUnicodeMatches) {
    const mappings = match[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
    for (const mapping of mappings) {
      unicodeMap.set(mapping[1], mapping[2]);
    }
  }
  
  // Method 5: Extract any string literals as last resort
  if (textParts.length < 10) {
    console.log(`[PDF Chunker Tool] Extracting raw string literals...`);
    const stringMatches = pdfString.matchAll(/\(((?:[^()\\]|\\.)*)\)/g);
    
    for (const strMatch of stringMatches) {
      const text = decodePdfString(strMatch[1]).trim();
      
      // Only include strings that look like actual text
      if (text.length > 3 && /[a-zA-Z]/.test(text) && !/^[\x00-\x1F\x7F-\xFF]+$/.test(text)) {
        textParts.push(text);
      }
    }
  }
  
  // Deduplicate and join text parts
  const uniqueTextParts = [...new Set(textParts)];
  let extractedText = uniqueTextParts.join(' ')
    .replace(/\s+/g, ' ')
    .replace(/([.!?])\s*([A-Z])/g, '$1 $2')
    .replace(/(\w)-(\s+)(\w)/g, '$1$3')
    .trim();
  
  // If still no text, provide a more helpful message
  if (!extractedText) {
    extractedText = 'This PDF appears to be encrypted, use compressed streams, or contain only images. The fallback parser cannot extract text from this type of PDF.';
  }
  
  console.log(`[PDF Chunker Tool] Fallback parser extracted ${extractedText.length} characters`);
  if (extractedText.length > 0) {
    console.log(`[PDF Chunker Tool] First 200 chars: ${extractedText.substring(0, 200)}`);
  }
  
  // Create a response similar to pdf-parse
  return {
    numpages: (pdfString.match(/\/Type\s*\/Page\b/g) || []).length || 1,
    text: extractedText,
    info: {
      Title: 'Unknown',
      Author: 'Unknown'
    }
  };
}

// Helper to load pdf-parse, handling the debug mode issue
async function loadPdfParse() {
  try {
    // First attempt: Import pdf-parse directly
    // This will throw if it tries to read the test file
    const pdfParseModule = await import('pdf-parse');
    return pdfParseModule.default || pdfParseModule;
  } catch (error: any) {
    // If it's the test file error, use fallback parser
    if (error?.message?.includes('05-versions-space.pdf')) {
      console.log(`[PDF Chunker Tool] pdf-parse debug mode error detected, using fallback parser`);
      return fallbackPdfParse;
    }
    
    throw error;
  }
}

const pdf = async (dataBuffer: Buffer) => {
  console.log(`[PDF Chunker Tool] Parsing PDF...`);
  
  if (!pdfParse) {
    console.log(`[PDF Chunker Tool] Loading pdf-parse...`);
    
    try {
      pdfParse = await loadPdfParse();
      console.log(`[PDF Chunker Tool] Successfully loaded pdf-parse`);
    } catch (error: any) {
      console.error(`[PDF Chunker Tool] Failed to load pdf-parse:`, error);
      
      // If it's the debug mode error, use fallback parser
      if (error?.message?.includes('05-versions-space.pdf')) {
        console.log(`[PDF Chunker Tool] Using fallback parser due to pdf-parse error`);
        pdfParse = fallbackPdfParse;
      } else {
        throw error;
      }
    }
  }
  
  console.log(`[PDF Chunker Tool] pdf-parse type:`, typeof pdfParse);
  console.log(`[PDF Chunker Tool] About to call pdfParse with buffer size:`, dataBuffer.length);
  
  if (!dataBuffer || dataBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }
  
  // Ensure we're calling it as a function with our buffer
  if (typeof pdfParse !== 'function') {
    throw new Error('pdf-parse is not a function');
  }
  
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
  
  // Special handling for positional queries
  const isLastParagraph = queryLower.includes('last paragraph') || queryLower.includes('final paragraph');
  const isFirstParagraph = queryLower.includes('first paragraph') || queryLower.includes('opening paragraph');
  const isLastChapter = queryLower.includes('last chapter') || queryLower.includes('final chapter');
  const isFirstChapter = queryLower.includes('first chapter') || queryLower.includes('opening chapter');
  
  // If asking for last content, prioritize last chunks
  if (isLastParagraph || isLastChapter) {
    const lastChunks = chunks.slice(-5).reverse(); // Get last 5 chunks in reverse order
    return lastChunks.map((chunk, index) => ({
      ...chunk,
      relevanceScore: 100 - index // Highest score for the very last chunk
    }));
  }
  
  // If asking for first content, prioritize first chunks
  if (isFirstParagraph || isFirstChapter) {
    const firstChunks = chunks.slice(0, 5);
    return firstChunks.map((chunk, index) => ({
      ...chunk,
      relevanceScore: 100 - index // Highest score for the very first chunk
    }));
  }
  
  // Regular keyword-based search
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

// Helper function to extract specific content from text
function extractSpecificContent(text: string, query: string): string {
  const queryLower = query.toLowerCase();
  
  // For "last paragraph" queries
  if (queryLower.includes('last paragraph') || queryLower.includes('final paragraph')) {
    // Split by double newlines to find paragraphs
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length > 0) {
      return paragraphs[paragraphs.length - 1].trim();
    }
    // If no double newlines, try single newlines
    const lines = text.split(/\n/).filter(l => l.trim().length > 20);
    if (lines.length > 0) {
      // Return last substantial block of text
      const lastLines = lines.slice(-5).join('\n').trim();
      return lastLines;
    }
  }
  
  // For "first paragraph" queries
  if (queryLower.includes('first paragraph') || queryLower.includes('opening paragraph')) {
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length > 0) {
      return paragraphs[0].trim();
    }
    const lines = text.split(/\n/).filter(l => l.trim().length > 20);
    if (lines.length > 0) {
      const firstLines = lines.slice(0, 5).join('\n').trim();
      return firstLines;
    }
  }
  
  // For direct quote requests
  if (queryLower.includes('quote') || queryLower.includes('exact text') || queryLower.includes('verbatim')) {
    // Return the full chunk content for quotes
    return text;
  }
  
  // Default: return a relevant excerpt
  // Find sentences containing query words
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
  
  const relevantSentences = sentences.filter(sentence => {
    const sentLower = sentence.toLowerCase();
    return queryWords.some(word => sentLower.includes(word));
  });
  
  if (relevantSentences.length > 0) {
    return relevantSentences.join(' ').trim();
  }
  
  // If no specific match, return the text as is
  return text;
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
    specificAnswer: z.string().optional().describe('Direct answer to specific queries like last paragraph'),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[PDF Chunker Tool] ===== TOOL CALLED =====`);
    console.log(`[PDF Chunker Tool] Context:`, JSON.stringify(context));
    console.log(`[PDF Chunker Tool] Process ID:`, process.pid);
    console.log(`[PDF Chunker Tool] Current time:`, new Date().toISOString());
    
    try {
      // Handle both 'filepath' and 'filePath' for compatibility
      console.log(`[PDF Chunker Tool] Raw context.filepath:`, context.filepath);
      console.log(`[PDF Chunker Tool] Raw context.filePath:`, context.filePath);
      
      const filepath = context.filepath || context.filePath;
      console.log(`[PDF Chunker Tool] Resolved filepath:`, filepath);
      
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
        let cached = pdfChunksCache.get(cacheKey);
        
        if (!cached) {
          console.log(`[PDF Chunker Tool] PDF not in cache, processing on-demand for query...`);
          
          // Check if file exists
          if (!fs.existsSync(filepath)) {
            return {
              success: false,
              action: 'query',
              message: 'File not found',
              error: `File does not exist: ${filepath}`,
            };
          }

          // Read and process the PDF (same as summarize action does)
          const fileBuffer = fs.readFileSync(filepath);
          let pdfData;
          
          try {
            // Try standard parsing first
            if (pdfParse) {
              pdfData = await pdfParse(fileBuffer);
            } else {
              // Fallback parsing
              pdfData = await fallbackPdfParse(fileBuffer);
            }
          } catch (parseError: any) {
            console.log('[PDF-CHUNKER-V3] Primary parsing failed, using fallback parser:', parseError.message);
            try {
              pdfData = await fallbackPdfParse(fileBuffer);
            } catch (fallbackError: any) {
              return {
                success: false,
                action: 'query',
                message: 'Failed to parse PDF',
                error: fallbackError.message,
              };
            }
          }

          // Extract text and metadata
          const text = pdfData.text || '';
          const metadata = {
            pages: pdfData.numpages || 1,
            info: pdfData.info || {},
            title: pdfData.info?.Title || path.basename(filepath, '.pdf'),
            author: pdfData.info?.Author || 'Unknown',
          };

          // Chunk the text
          const textChunks = chunkTextByLines(text, context.chunkSize || 200);
          
          // Create chunk objects with estimated page numbers (same as summarize action)
          const chunks = textChunks.map((content, index) => {
            const chunkPosition = index / textChunks.length;
            const pageStart = Math.floor(chunkPosition * metadata.pages) + 1;
            const pageEnd = Math.min(
              Math.ceil((index + 1) / textChunks.length * metadata.pages),
              metadata.pages
            );
            
            return {
              index,
              content,
              pageStart,
              pageEnd,
            };
          });
          
          // Cache for future use
          cached = {
            chunks,
            metadata,
            timestamp: Date.now(),
          };
          pdfChunksCache.set(cacheKey, cached);
          console.log(`[PDF Chunker Tool] Successfully processed and cached PDF with ${chunks.length} chunks`);
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
        
        // Process chunks to extract specific content based on the query
        const processedChunks = relevantChunks.map(chunk => {
          const extractedContent = extractSpecificContent(chunk.content, context.query || '');
          return {
            ...chunk,
            content: extractedContent,
            isExtract: extractedContent !== chunk.content // Flag to indicate if content was extracted
          };
        });
        
        // Create a specific answer based on the query type
        let specificAnswer = '';
        const queryLower = context.query.toLowerCase();
        
        if (queryLower.includes('last paragraph') || queryLower.includes('final paragraph')) {
          // For last paragraph, use the content from the highest scoring chunk (which should be the last chunk)
          specificAnswer = processedChunks[0].content;
          console.log(`[PDF Chunker Tool] Extracted last paragraph: ${specificAnswer.substring(0, 100)}...`);
        } else if (queryLower.includes('first paragraph') || queryLower.includes('opening paragraph')) {
          specificAnswer = processedChunks[0].content;
          console.log(`[PDF Chunker Tool] Extracted first paragraph: ${specificAnswer.substring(0, 100)}...`);
        }
        
        return {
          success: true,
          action: 'query',
          filename: basename(filepath),
          totalChunks: cached.chunks.length,
          chunks: processedChunks,
          message: specificAnswer 
            ? `Here is the ${context.query}:\n\n${specificAnswer}`
            : `Found ${relevantChunks.length} relevant chunks for query: "${context.query}"`,
          specificAnswer, // Include the direct answer if available
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
          console.log(`[PDF Chunker Tool] Normalized path:`, normalizedPath);
          console.log(`[PDF Chunker Tool] Checking if path includes /uploads/:`, normalizedPath.includes('/uploads/'));
          
          if (!normalizedPath.includes('/uploads/')) {
            console.error(`[PDF Chunker Tool] Invalid path - must be in uploads directory:`, normalizedPath);
            throw new Error('File must be in the uploads directory');
          }
          
          filename = basename(filepath);
          console.log(`[PDF Chunker Tool] About to read file from:`, filepath);
          console.log(`[PDF Chunker Tool] Filename:`, filename);
          console.log(`[PDF Chunker Tool] Current working directory:`, process.cwd());
          
          try {
            dataBuffer = await readFile(filepath);
            console.log(`[PDF Chunker Tool] Successfully read file, buffer size:`, dataBuffer.length);
          } catch (readError) {
            console.error(`[PDF Chunker Tool] Error reading file:`, readError);
            console.error(`[PDF Chunker Tool] Error type:`, (readError as any)?.constructor?.name);
            console.error(`[PDF Chunker Tool] Attempted path:`, filepath);
            const errorMessage = readError instanceof Error ? readError.message : String(readError);
            throw new Error(`Failed to read PDF file from ${filepath}: ${errorMessage}`);
          }
          
          // Parse the PDF
          console.log(`[PDF Chunker Tool] About to parse PDF with buffer size:`, dataBuffer.length);
          const pdfData = await pdf(dataBuffer);
          console.log(`[PDF Chunker Tool] Successfully parsed PDF`);
          
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
        error: `[PDF-CHUNKER-V3] ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});

// Export a test function to verify this module is being used
export const testPdfChunkerModule = () => {
  return 'PDF_CHUNKER_MODULE_LOADED_V2';
};