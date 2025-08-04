// Hybrid PDF processor that combines semantic chunking with LLM-assisted analysis
import { basename } from 'path';
import { readFile, stat } from 'fs/promises';
import { createRequire } from 'module';
import { processWithLLMChunking } from './pdf-processor-llm-chunking.js';
import { processSemanticPDF } from './pdf-processor-semantic.js';
import { processPDF as processLineBasedPDF } from './pdf-processor.js';
import { processStreamingPDF } from './pdf-processor-streaming.js';
import { processSectionAwarePDF } from './pdf-processor-section-aware.js';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';

const require = createRequire(import.meta.url);

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

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
    console.error('[Hybrid Processor] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Detect if PDF is a textbook based on content
async function detectTextbook(pdfText: string, filename: string): Promise<boolean> {
  const textbookIndicators = [
    /chapter\s+\d+/i,
    /section\s+\d+\.\d+/i,
    /exercise\s+\d+\.\d+/i,
    /figure\s+\d+\.\d+/i,
    /table\s+\d+\.\d+/i,
    /theorem\s+\d+\.\d+/i,
    /definition\s+\d+\.\d+/i,
    /table of contents/i,
    /bibliography/i,
    /references\s*$/im,
    /index\s*$/im,
    /appendix\s+[a-z]/i
  ];
  
  const indicatorCount = textbookIndicators.filter(pattern => pattern.test(pdfText)).length;
  
  // Check filename patterns
  const filenamePatterns = [
    /textbook/i,
    /chapter/i,
    /lecture/i,
    /course/i,
    /edition/i,
    /academic/i
  ];
  
  const filenameMatch = filenamePatterns.some(pattern => pattern.test(filename));
  
  return indicatorCount >= 3 || (indicatorCount >= 2 && filenameMatch);
}

export async function processHybridPDF(
  filepath: string,
  options: {
    forceMethod?: 'llm' | 'semantic' | 'line-based' | 'streaming' | 'section-aware' | 'auto';
    maxCost?: number;
  } = {}
): Promise<{
  success: boolean;
  filename: string;
  totalChunks?: number;
  indexName?: string;
  message: string;
  error?: string;
  method?: string;
  processingCost?: number;
  statusId?: string;
}> {
  console.log(`[Hybrid Processor] ===== STARTING HYBRID PDF PROCESSING =====`);
  console.log(`[Hybrid Processor] File: ${filepath}`);
  console.log(`[Hybrid Processor] Options:`, options);
  
  try {
    // Check file size first to avoid timeout on very large files
    const stats = await stat(filepath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`[Hybrid Processor] File size: ${fileSizeMB.toFixed(2)}MB`);
    
    // For very large files (>50MB), warn but still try LLM unless it would definitely timeout
    if (fileSizeMB > 50) {
      console.log(`[Hybrid Processor] ⚠️ Very large file detected (${fileSizeMB.toFixed(2)}MB)`);
      
      // Estimate processing time - roughly 1 second per 10KB of text with LLM
      const estimatedSeconds = (fileSizeMB * 1024) / 10;
      
      if (estimatedSeconds > 25) { // Would likely timeout
        console.log(`[Hybrid Processor] File too large for synchronous LLM processing (est. ${Math.round(estimatedSeconds)}s)`);
        console.log(`[Hybrid Processor] Consider using streaming processor or splitting the PDF`);
        
        // Still try LLM but warn about potential timeout
        console.log(`[Hybrid Processor] Attempting LLM processing anyway - may timeout...`);
      }
    }
    
    // Load PDF parser
    const pdfParse = require('pdf-parse');
    const dataBuffer = await readFile(filepath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log(`[Hybrid Processor] PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
    
    const filename = basename(filepath);
    const isTextbook = await detectTextbook(pdfData.text, filename);
    
    console.log(`[Hybrid Processor] Document type: ${isTextbook ? 'TEXTBOOK' : 'GENERAL'}`);
    
    // Determine processing method
    let method = options.forceMethod || 'auto';
    
    if (method === 'auto') {
      // Always use LLM for all PDFs
      method = 'llm';
      const estimatedCost = (pdfData.text.length / 4000) * 0.01;
      console.log(`[Hybrid Processor] Using LLM for intelligent chunking (${pdfData.numpages} pages, est. cost: $${estimatedCost.toFixed(2)})`);
      
      // Warn if it's a large PDF
      if (pdfData.numpages > 100 || pdfData.text.length > 3_000_000) {
        console.log(`[Hybrid Processor] ⚠️ Large PDF detected - processing may take several minutes`);
      }
    }
    
    console.log(`[Hybrid Processor] Selected method: ${method}`);
    
    // Process based on method
    switch (method) {
      case 'llm':
        // Use LLM-assisted chunking for best quality
        const llmResult = await processWithLLMChunking(filepath, {
          maxSegmentSize: 8000,
          costLimit: options.maxCost || 2.0 // Default $2 limit
        });
        
        if (!llmResult.success || !llmResult.chunks) {
          throw new Error(llmResult.error || 'LLM chunking failed');
        }
        
        // Generate embeddings and store
        console.log(`[Hybrid Processor] Generating embeddings for ${llmResult.chunks.length} LLM chunks...`);
        
        const indexName = `llm-${filename.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
        await createIndexWithNewman(indexName, 1536);
        
        const vectors = [];
        for (const chunk of llmResult.chunks) {
          const embedding = await generateEmbedding(chunk.content);
          
          vectors.push({
            key: chunk.id,
            embedding,
            metadata: {
              content: chunk.content.substring(0, 1500),
              summary: chunk.summary,
              sectionNumber: chunk.sectionNumber || '',
              sectionTitle: chunk.sectionTitle || '',
              topics: (chunk.topics || []).join(', '),
              chunkType: chunk.chunkType,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              pageStart: chunk.pageStart || 0,
              pageEnd: chunk.pageEnd || 0,
              documentId: filename,
              filename,
              timestamp: new Date().toISOString()
            }
          });
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        await uploadVectorsWithNewman(indexName, vectors);
        
        return {
          success: true,
          filename,
          totalChunks: llmResult.chunks.length,
          indexName,
          message: `Successfully processed with LLM-assisted chunking: ${llmResult.chunks.length} intelligent chunks created`,
          method: 'llm',
          processingCost: llmResult.chunks.length * 0.001 // Rough estimate
        };
        
      case 'semantic':
        // Use semantic chunking (good balance)
        return await processSemanticPDF(filepath, {
          strategy: 'semantic',
          maxChunkSize: 2500,
          minChunkSize: 200,
          overlapSize: 200
        });
        
      case 'streaming':
        // Use streaming processor for very large PDFs
        console.log(`[Hybrid Processor] Using streaming processor for large PDF`);
        const streamResult = await processStreamingPDF(filepath, {
          batchSize: 50,
          immediateResponse: true
        });
        
        return {
          success: streamResult.success,
          filename: streamResult.filename,
          totalChunks: streamResult.totalChunks,
          indexName: streamResult.indexName,
          message: streamResult.message,
          error: streamResult.error,
          method: 'streaming',
          statusId: streamResult.statusId
        };
        
      case 'section-aware':
        // Use section-aware processing for textbooks
        return await processSectionAwarePDF(filepath, {
          batchSize: 20
        });
        
      case 'line-based':
      default:
        // Use simple line-based (fastest)
        return await processLineBasedPDF(filepath);
    }
    
  } catch (error) {
    console.error('[Hybrid Processor] Error:', error);
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Quick analysis to help decide processing method
export async function analyzePDFForProcessing(filepath: string): Promise<{
  pages: number;
  characters: number;
  isTextbook: boolean;
  recommendedMethod: 'llm' | 'semantic' | 'line-based' | 'streaming';
  estimatedCost: number;
  estimatedTime: number;
}> {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = await readFile(filepath);
    const pdfData = await pdfParse(dataBuffer);
    
    const filename = basename(filepath);
    const isTextbook = await detectTextbook(pdfData.text, filename);
    
    let recommendedMethod: 'llm' | 'semantic' | 'line-based' | 'streaming';
    let estimatedCost = 0;
    let estimatedTime = 0;
    
    // Check if PDF is very large
    if (pdfData.numpages > 200 || pdfData.text.length > 5_000_000) {
      recommendedMethod = 'streaming';
      estimatedCost = (pdfData.text.length / 1500) * 0.0004; // Embedding cost
      estimatedTime = 30; // Immediate response, background processing
    } else if (isTextbook && pdfData.numpages < 50) {
      recommendedMethod = 'llm';
      estimatedCost = (pdfData.text.length / 4000) * 0.01; // GPT-4 input cost
      estimatedTime = pdfData.numpages * 2; // 2 seconds per page
    } else if (isTextbook) {
      recommendedMethod = 'semantic';
      estimatedCost = (pdfData.text.length / 1500) * 0.0004; // Embedding cost
      estimatedTime = pdfData.numpages * 0.5; // 0.5 seconds per page
    } else {
      recommendedMethod = 'line-based';
      estimatedCost = (pdfData.text.length / 1500) * 0.0004; // Embedding cost
      estimatedTime = pdfData.numpages * 0.2; // 0.2 seconds per page
    }
    
    return {
      pages: pdfData.numpages,
      characters: pdfData.text.length,
      isTextbook,
      recommendedMethod,
      estimatedCost,
      estimatedTime
    };
    
  } catch (error) {
    throw new Error(`Failed to analyze PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}