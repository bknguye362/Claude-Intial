// Enhanced PDF processor with semantic chunking
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';
import { chunkText, ChunkingOptions } from './semantic-chunker.js';

const require = createRequire(import.meta.url);

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Enhanced chunk interface with better metadata
interface EnhancedChunk {
  content: string;
  embedding: number[];
  metadata: {
    chunkIndex: number;
    totalChunks: number;
    pageStart?: number;
    pageEnd?: number;
    section?: string;        // Section header if detected
    chunkType?: string;      // 'header', 'paragraph', 'list', etc.
    overlapWithPrevious?: number; // Characters overlapping with previous chunk
    overlapWithNext?: number;     // Characters overlapping with next chunk
    sentenceCount?: number;
    wordCount?: number;
    hasCodeBlock?: boolean;
    hasList?: boolean;
    hasTable?: boolean;
  };
}

// PDF parsing
let pdfParse: any = null;
async function loadPdfParse() {
  try {
    const pdfParseModule = require('pdf-parse');
    return pdfParseModule;
  } catch (error) {
    console.error('[Semantic PDF Processor] Failed to load pdf-parse:', error);
    return null;
  }
}

// Generate embedding for text
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
      const error: any = new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      error.statusCode = response.status;
      throw error;
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[Semantic PDF Processor] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Analyze chunk content for metadata
function analyzeChunkContent(text: string): Partial<EnhancedChunk['metadata']> {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const words = text.split(/\s+/).filter(w => w.length > 0);
  
  return {
    sentenceCount: sentences.length,
    wordCount: words.length,
    hasCodeBlock: /```[\s\S]*```/.test(text) || /^\s{4,}\S/m.test(text),
    hasList: /^[\s]*[-*•]\s+/m.test(text) || /^\s*\d+\.\s+/m.test(text),
    hasTable: /\|.*\|.*\|/m.test(text) || /\t.*\t.*\t/m.test(text)
  };
}

// Detect chunk type
function detectChunkType(text: string, index: number, totalChunks: number): string {
  const trimmed = text.trim();
  
  // Header detection
  if (trimmed.length < 200) {
    if (/^(Chapter|Section|Part)\s+\d+/i.test(trimmed)) return 'header';
    if (/^\d+\.?\s+[A-Z]/.test(trimmed)) return 'header';
    if (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return 'header';
  }
  
  // Table of contents
  if (/^\d+\..*\.{3,}\d+$/m.test(text)) return 'toc';
  
  // References/Bibliography
  if (index > totalChunks * 0.8 && /^\[\d+\]|\d+\.\s+\w+.*\(\d{4}\)/.test(trimmed)) return 'references';
  
  // Code block
  if (/```[\s\S]*```/.test(text) || /^\s{4,}\S/m.test(text)) return 'code';
  
  // List
  if (/^[\s]*[-*•]\s+/m.test(text) || /^\s*\d+\.\s+/m.test(text)) return 'list';
  
  return 'paragraph';
}

// Main processing function with semantic chunking
export async function processSemanticPDF(
  filepath: string,
  options: Partial<ChunkingOptions> = {}
): Promise<{
  success: boolean;
  filename: string;
  totalChunks?: number;
  indexName?: string;
  message: string;
  error?: string;
  chunkingStrategy?: string;
}> {
  console.log(`[Semantic PDF Processor] ===== STARTING SEMANTIC PDF PROCESSING =====`);
  console.log(`[Semantic PDF Processor] File: ${filepath}`);
  console.log(`[Semantic PDF Processor] Chunking options:`, options);
  
  try {
    // Load PDF parser
    if (!pdfParse) {
      pdfParse = await loadPdfParse();
    }
    if (!pdfParse) {
      throw new Error('PDF parser not available');
    }
    
    // Read and parse PDF
    const dataBuffer = await readFile(filepath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log(`[Semantic PDF Processor] PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
    
    // Perform semantic chunking
    const chunkingOptions: ChunkingOptions = {
      maxChunkSize: options.maxChunkSize || 3000,
      minChunkSize: options.minChunkSize || 200,
      overlapSize: options.overlapSize || 200,
      strategy: options.strategy || 'semantic'
    };
    
    console.log(`[Semantic PDF Processor] Using ${chunkingOptions.strategy} chunking strategy`);
    
    const textChunks = await chunkText(
      pdfData.text,
      chunkingOptions,
      chunkingOptions.strategy === 'sliding-window' ? generateEmbedding : undefined
    );
    
    console.log(`[Semantic PDF Processor] Created ${textChunks.length} semantic chunks`);
    
    // Check size limits and provide warnings
    const CHUNKS_WARNING_THRESHOLD = 500;
    const MAX_CHUNKS = 2000; // Increased limit, but with better handling
    
    // Remove hard limit - only warn for very large documents
    if (textChunks.length > MAX_CHUNKS) {
      console.log(`[Semantic PDF Processor] ⚠️ Very large PDF: ${textChunks.length} chunks`);
      console.log(`[Semantic PDF Processor] ⚠️ This will take ~${Math.round(textChunks.length * 3 / 60)} minutes to process`);
      console.log(`[Semantic PDF Processor] ⚠️ Consider using streaming processor for better performance`);
    }
    
    if (textChunks.length > CHUNKS_WARNING_THRESHOLD) {
      console.log(`[Semantic PDF Processor] ⚠️ Large PDF detected: ${textChunks.length} chunks`);
      console.log(`[Semantic PDF Processor] ⚠️ Estimated processing time: ${Math.round(textChunks.length * 3 / 60)} minutes`);
      console.log(`[Semantic PDF Processor] ⚠️ Using aggressive rate limiting to avoid timeouts`);
    }
    
    // Generate embeddings with configurable rate limiting
    console.log(`[Semantic PDF Processor] Generating embeddings...`);
    const embeddings: number[][] = [];
    
    // Configurable rate limiting parameters - MORE CONSERVATIVE
    const RATE_LIMIT_CONFIG = {
      requestsPerMinute: 20,  // Reduced from 50 to avoid throttling
      burstSize: 2,           // Reduced from 5 to 2 concurrent requests
      retryAttempts: 3,       // Number of retries on 429
      backoffMultiplier: 2,   // Exponential backoff multiplier
      initialBackoff: 2000,   // Increased from 1000ms to 2000ms
    };
    
    // Calculate delays based on rate limit
    const minDelayBetweenRequests = 60000 / RATE_LIMIT_CONFIG.requestsPerMinute;
    const batchSize = Math.min(RATE_LIMIT_CONFIG.burstSize, textChunks.length);
    
    // Process embeddings with rate limiting
    let processedCount = 0;
    let consecutiveErrors = 0;
    
    for (let i = 0; i < textChunks.length; i += batchSize) {
      const batch = textChunks.slice(i, i + batchSize);
      const batchEmbeddings: number[][] = [];
      const batchStartTime = Date.now();
      
      // Process batch with retry logic
      for (let j = 0; j < batch.length; j++) {
        let retryCount = 0;
        let backoffDelay = RATE_LIMIT_CONFIG.initialBackoff;
        let success = false;
        
        while (retryCount < RATE_LIMIT_CONFIG.retryAttempts && !success) {
          try {
            const embedding = await generateEmbedding(batch[j]);
            batchEmbeddings.push(embedding);
            success = true;
            consecutiveErrors = 0; // Reset error counter on success
          } catch (error: any) {
            retryCount++;
            consecutiveErrors++;
            
            if (error?.message?.includes('429') || error?.statusCode === 429) {
              console.log(`[Semantic PDF Processor] Rate limit hit, retry ${retryCount}/${RATE_LIMIT_CONFIG.retryAttempts}`);
              
              // Exponential backoff
              await new Promise(resolve => setTimeout(resolve, backoffDelay));
              backoffDelay *= RATE_LIMIT_CONFIG.backoffMultiplier;
              
              // If too many consecutive errors, increase delay further
              if (consecutiveErrors > 10) {
                console.log(`[Semantic PDF Processor] Many consecutive errors, adding extra delay`);
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            } else {
              console.error(`[Semantic PDF Processor] Failed to generate embedding for chunk ${i + j}:`, error);
              break; // Don't retry non-429 errors
            }
          }
        }
        
        // Use fallback embedding if all retries failed
        if (!success) {
          console.warn(`[Semantic PDF Processor] Using fallback embedding for chunk ${i + j}`);
          const hash = batch[j].split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          batchEmbeddings.push(Array(1536).fill(0).map((_, idx) => Math.sin(hash + idx) * 0.5 + 0.5));
        }
        
        // Ensure minimum delay between requests
        if (j < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, minDelayBetweenRequests));
        }
      }
      
      embeddings.push(...batchEmbeddings);
      processedCount += batchEmbeddings.length;
      
      // Progress logging
      const progress = Math.round((processedCount / textChunks.length) * 100);
      const elapsedTime = Date.now() - batchStartTime;
      const estimatedTimeRemaining = (elapsedTime / batch.length) * (textChunks.length - processedCount);
      
      console.log(`[Semantic PDF Processor] Progress: ${processedCount}/${textChunks.length} (${progress}%) - ETA: ${Math.round(estimatedTimeRemaining / 1000)}s`);
      
      // Adaptive delay between batches based on processing time
      if (i + batchSize < textChunks.length) {
        const batchProcessingTime = Date.now() - batchStartTime;
        const targetBatchTime = batch.length * minDelayBetweenRequests;
        
        if (batchProcessingTime < targetBatchTime) {
          // Add extra delay to maintain rate limit
          const extraDelay = targetBatchTime - batchProcessingTime;
          await new Promise(resolve => setTimeout(resolve, extraDelay));
        }
      }
    }
    
    // Create enhanced chunks with metadata
    const enhancedChunks: EnhancedChunk[] = textChunks.map((content, index) => {
      const contentAnalysis = analyzeChunkContent(content);
      const chunkType = detectChunkType(content, index, textChunks.length);
      
      // Estimate page numbers based on character position
      const startChar = textChunks.slice(0, index).reduce((sum, chunk) => sum + chunk.length, 0);
      const endChar = startChar + content.length;
      const pageStart = Math.floor((startChar / pdfData.text.length) * pdfData.numpages) + 1;
      const pageEnd = Math.ceil((endChar / pdfData.text.length) * pdfData.numpages);
      
      // Calculate overlaps
      const overlapWithPrevious = index > 0 ? 
        content.substring(0, chunkingOptions.overlapSize).length : 0;
      const overlapWithNext = index < textChunks.length - 1 ?
        chunkingOptions.overlapSize : 0;
      
      return {
        content,
        embedding: embeddings[index],
        metadata: {
          chunkIndex: index,
          totalChunks: textChunks.length,
          pageStart,
          pageEnd,
          chunkType,
          overlapWithPrevious,
          overlapWithNext,
          ...contentAnalysis
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
    const indexName = `semantic-${cleanName}-${dateStr}`;
    
    // Create S3 Vectors index
    console.log(`[Semantic PDF Processor] Creating index: ${indexName}`);
    const indexCreated = await createIndexWithNewman(indexName, 1536);
    
    if (!indexCreated) {
      throw new Error(`Failed to create index '${indexName}'`);
    }
    
    // Prepare vectors with rich metadata
    const vectors = enhancedChunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: chunk.embedding,
      metadata: {
        content: chunk.content.substring(0, 2000),
        documentId,
        filename: basename(filepath),
        ...chunk.metadata,
        chunkingStrategy: chunkingOptions.strategy,
        timestamp: new Date().toISOString()
      }
    }));
    
    // Upload to S3 Vectors
    console.log(`[Semantic PDF Processor] Uploading ${vectors.length} vectors...`);
    const uploadedCount = await uploadVectorsWithNewman(indexName, vectors);
    
    console.log(`[Semantic PDF Processor] ===== PROCESSING COMPLETE =====`);
    
    return {
      success: true,
      filename: basename(filepath),
      totalChunks: enhancedChunks.length,
      indexName,
      chunkingStrategy: chunkingOptions.strategy,
      message: `Successfully processed '${basename(filepath)}' with ${chunkingOptions.strategy} chunking into ${enhancedChunks.length} chunks.`
    };
    
  } catch (error) {
    console.error('[Semantic PDF Processor] Error:', error);
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}