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
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
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
      maxChunkSize: options.maxChunkSize || 1500,
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
    
    // Check size limits
    const MAX_CHUNKS = 800; // Increased for better granularity
    if (textChunks.length > MAX_CHUNKS) {
      return {
        success: false,
        filename: basename(filepath),
        totalChunks: textChunks.length,
        message: `PDF too large (${textChunks.length} chunks). Maximum: ${MAX_CHUNKS}`,
        error: 'Document exceeds size limit'
      };
    }
    
    // Generate embeddings in parallel batches
    console.log(`[Semantic PDF Processor] Generating embeddings...`);
    const embeddings: number[][] = [];
    const batchSize = 10;
    
    for (let i = 0; i < textChunks.length; i += batchSize) {
      const batch = textChunks.slice(i, i + batchSize);
      const batchEmbeddings = await Promise.all(batch.map(text => generateEmbedding(text)));
      embeddings.push(...batchEmbeddings);
      
      console.log(`[Semantic PDF Processor] Progress: ${Math.min(i + batchSize, textChunks.length)}/${textChunks.length}`);
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