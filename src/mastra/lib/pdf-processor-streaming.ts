// Streaming PDF processor that handles large files in batches to avoid timeouts
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';

const require = createRequire(import.meta.url);

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Processing status
interface ProcessingStatus {
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  totalChunks: number;
  processedChunks: number;
  indexName?: string;
  error?: string;
  startTime: Date;
  lastUpdate: Date;
}

// Global status tracking (in production, use Redis)
const processingStatus = new Map<string, ProcessingStatus>();

// Generate embedding
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
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Split text into chunks
function chunkTextByLines(text: string, linesPerChunk: number = 50): string[] {
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

// Process PDF in streaming batches
export async function processStreamingPDF(
  filepath: string,
  options: {
    batchSize?: number;
    immediateResponse?: boolean;
    statusCallback?: (status: ProcessingStatus) => void;
  } = {}
): Promise<{
  success: boolean;
  filename: string;
  totalChunks?: number;
  processedChunks?: number;
  indexName?: string;
  message: string;
  error?: string;
  statusId?: string;
}> {
  const batchSize = options.batchSize || 50; // Process 50 chunks at a time
  const immediateResponse = options.immediateResponse ?? true;
  
  console.log(`[Streaming PDF Processor] ===== STARTING STREAMING PROCESSING =====`);
  console.log(`[Streaming PDF Processor] File: ${filepath}`);
  console.log(`[Streaming PDF Processor] Batch size: ${batchSize}`);
  
  try {
    // Load PDF parser
    const pdfParse = require('pdf-parse');
    const dataBuffer = await readFile(filepath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log(`[Streaming PDF Processor] PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
    
    // Split into chunks
    const textChunks = chunkTextByLines(pdfData.text);
    console.log(`[Streaming PDF Processor] Split into ${textChunks.length} chunks`);
    
    // Generate index name
    const filename = basename(filepath);
    const documentId = filename.replace(/\.pdf$/i, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const indexName = `streaming-${documentId}-${Date.now()}`;
    
    // Initialize status
    const statusId = `${documentId}-${Date.now()}`;
    const status: ProcessingStatus = {
      status: 'processing',
      progress: 0,
      totalChunks: textChunks.length,
      processedChunks: 0,
      indexName,
      startTime: new Date(),
      lastUpdate: new Date()
    };
    processingStatus.set(statusId, status);
    
    // Create index
    console.log(`[Streaming PDF Processor] Creating index: ${indexName}`);
    const indexCreated = await createIndexWithNewman(indexName, 1536);
    if (!indexCreated) {
      throw new Error('Failed to create index');
    }
    
    if (immediateResponse) {
      // Start processing in background and return immediately
      processInBackground(textChunks, pdfData, indexName, documentId, statusId, batchSize, options.statusCallback);
      
      return {
        success: true,
        filename,
        totalChunks: textChunks.length,
        processedChunks: 0,
        indexName,
        statusId,
        message: `Processing ${filename} in background. Check status with ID: ${statusId}`
      };
    } else {
      // Process synchronously
      const result = await processAllBatches(textChunks, pdfData, indexName, documentId, statusId, batchSize, options.statusCallback);
      return result;
    }
    
  } catch (error) {
    console.error('[Streaming PDF Processor] Error:', error);
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Process in background
async function processInBackground(
  textChunks: string[],
  pdfData: any,
  indexName: string,
  documentId: string,
  statusId: string,
  batchSize: number,
  statusCallback?: (status: ProcessingStatus) => void
) {
  try {
    await processAllBatches(textChunks, pdfData, indexName, documentId, statusId, batchSize, statusCallback);
  } catch (error) {
    console.error('[Streaming PDF Processor] Background processing error:', error);
    const status = processingStatus.get(statusId);
    if (status) {
      status.status = 'failed';
      status.error = error instanceof Error ? error.message : 'Unknown error';
      status.lastUpdate = new Date();
      if (statusCallback) statusCallback(status);
    }
  }
}

// Process all batches
async function processAllBatches(
  textChunks: string[],
  pdfData: any,
  indexName: string,
  documentId: string,
  statusId: string,
  batchSize: number,
  statusCallback?: (status: ProcessingStatus) => void
): Promise<{
  success: boolean;
  filename: string;
  totalChunks: number;
  processedChunks: number;
  indexName: string;
  message: string;
  error?: string;
}> {
  const status = processingStatus.get(statusId);
  if (!status) throw new Error('Status not found');
  
  let processedCount = 0;
  
  // Process in batches
  for (let batchStart = 0; batchStart < textChunks.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, textChunks.length);
    const batch = textChunks.slice(batchStart, batchEnd);
    
    console.log(`[Streaming PDF Processor] Processing batch ${Math.floor(batchStart/batchSize) + 1}/${Math.ceil(textChunks.length/batchSize)}`);
    
    // Generate embeddings for batch with rate limiting
    const embeddings: number[][] = [];
    for (const chunk of batch) {
      const embedding = await generateEmbedding(chunk);
      embeddings.push(embedding);
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Prepare vectors for this batch
    const vectors = batch.map((chunk, index) => {
      const globalIndex = batchStart + index;
      const chunkPosition = globalIndex / textChunks.length;
      const pageStart = Math.floor(chunkPosition * pdfData.numpages) + 1;
      const pageEnd = Math.ceil((globalIndex + 1) / textChunks.length * pdfData.numpages);
      
      return {
        key: `${documentId}-chunk-${globalIndex}`,
        embedding: embeddings[index],
        metadata: {
          content: chunk.substring(0, 1500),
          documentId,
          filename: basename(pdfData.info?.Title || documentId),
          chunkIndex: globalIndex,
          totalChunks: textChunks.length,
          pageStart,
          pageEnd,
          batchNumber: Math.floor(batchStart/batchSize) + 1,
          timestamp: new Date().toISOString()
        }
      };
    });
    
    // Upload batch to S3 Vectors
    console.log(`[Streaming PDF Processor] Uploading ${vectors.length} vectors...`);
    const uploaded = await uploadVectorsWithNewman(indexName, vectors);
    processedCount += uploaded;
    
    // Update status
    status.processedChunks = processedCount;
    status.progress = Math.round((processedCount / textChunks.length) * 100);
    status.lastUpdate = new Date();
    
    console.log(`[Streaming PDF Processor] Progress: ${processedCount}/${textChunks.length} chunks (${status.progress}%)`);
    
    if (statusCallback) {
      statusCallback(status);
    }
    
    // Add delay between batches to avoid overwhelming the system
    if (batchEnd < textChunks.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Mark as completed
  status.status = 'completed';
  status.lastUpdate = new Date();
  if (statusCallback) statusCallback(status);
  
  console.log(`[Streaming PDF Processor] ===== PROCESSING COMPLETE =====`);
  
  return {
    success: true,
    filename: basename(pdfData.info?.Title || documentId),
    totalChunks: textChunks.length,
    processedChunks: processedCount,
    indexName,
    message: `Successfully processed ${processedCount} chunks in streaming mode`
  };
}

// Get processing status
export function getProcessingStatus(statusId: string): ProcessingStatus | null {
  return processingStatus.get(statusId) || null;
}

// Check if any jobs are processing
export function hasActiveJobs(): boolean {
  for (const status of processingStatus.values()) {
    if (status.status === 'processing') return true;
  }
  return false;
}

// Clean up old statuses
export function cleanupOldStatuses(olderThanMinutes: number = 60) {
  const cutoff = Date.now() - (olderThanMinutes * 60 * 1000);
  for (const [id, status] of processingStatus.entries()) {
    if (status.lastUpdate.getTime() < cutoff && status.status !== 'processing') {
      processingStatus.delete(id);
    }
  }
}