// PDF Processor with proper rate limiting for Azure OpenAI
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';

const require = createRequire(import.meta.url);

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

// Rate limiting configuration
const RATE_LIMIT_DELAY = 1000; // 1 second between API calls
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds on rate limit error

// Helper function with retry logic
async function callAzureWithRetry(fn: () => Promise<any>, context: string): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error: any) {
      const errorMessage = error.message || String(error);
      
      // Check for rate limit error (429 or "Too Many Requests")
      if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests') || errorMessage.includes('rate')) {
        console.log(`[PDF Processor] Rate limited on ${context}, attempt ${attempt}/${MAX_RETRIES}. Waiting ${RETRY_DELAY}ms...`);
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt)); // Exponential backoff
          continue;
        }
      }
      
      // For other errors or final attempt, throw
      throw error;
    }
  }
}

// Generate embedding with rate limiting and retry
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  return callAzureWithRetry(async () => {
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

    if (response.status === 429) {
      throw new Error('429 Too Many Requests');
    }

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  }, 'embedding generation');
}

// Generate embeddings with proper rate limiting
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`[PDF Processor] Generating embeddings for ${texts.length} chunks with rate limiting...`);
  
  const embeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i++) {
    console.log(`[PDF Processor] Generating embedding ${i + 1}/${texts.length}`);
    const embedding = await generateEmbedding(texts[i]);
    embeddings.push(embedding);
    
    // Rate limit: wait between requests
    if (i < texts.length - 1 && AZURE_OPENAI_API_KEY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
    }
  }
  
  return embeddings;
}

// Generate summary with rate limiting and retry
async function generateChunkSummary(chunkContent: string): Promise<string> {
  if (!AZURE_OPENAI_API_KEY) {
    const lines = chunkContent.split('\n').filter(l => l.trim());
    return lines.slice(0, 2).join(' ').substring(0, 200);
  }

  return callAzureWithRetry(async () => {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that creates concise summaries. Summarize the following text in 2-3 sentences, focusing on the main concepts and key information.'
          },
          {
            role: 'user',
            content: `Summarize this text:\n\n${chunkContent.substring(0, 2000)}`
          }
        ],
        max_tokens: 100,
        temperature: 0.3,
        model: 'gpt-4'
      })
    });

    if (response.status === 429) {
      throw new Error('429 Too Many Requests');
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error: ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const data: any = await response.json();
    return data.choices[0].message.content.trim().substring(0, 200);
  }, 'summary generation');
}

// Generate summaries with rate limiting
async function generateSummaries(chunks: string[]): Promise<string[]> {
  console.log(`[PDF Processor] Generating summaries for ${chunks.length} chunks with rate limiting...`);
  
  const summaries: string[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[PDF Processor] Generating summary ${i + 1}/${chunks.length}`);
    try {
      const summary = await generateChunkSummary(chunks[i]);
      summaries.push(summary);
    } catch (error) {
      console.error(`[PDF Processor] Error generating summary for chunk ${i}:`, error);
      // Use fallback summary on error
      const lines = chunks[i].split('\n').filter(l => l.trim());
      summaries.push(lines.slice(0, 2).join(' ').substring(0, 200));
    }
    
    // Rate limit: wait between requests
    if (i < chunks.length - 1 && AZURE_OPENAI_API_KEY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
    }
  }
  
  return summaries;
}

// PDF parsing setup
let pdfParse: any = null;

async function loadPdfParse() {
  try {
    const pdfParseModule = require('pdf-parse');
    return pdfParseModule;
  } catch (error) {
    console.error('[PDF Processor] Failed to load pdf-parse:', error);
    return null;
  }
}

const pdf = async (dataBuffer: Buffer) => {
  if (!pdfParse) {
    pdfParse = await loadPdfParse();
  }
  
  if (!pdfParse) {
    throw new Error('PDF parser not available');
  }
  
  return pdfParse(dataBuffer);
};

// Chunk text by lines
function chunkTextByLines(text: string, maxChunkSize: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + line).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Main processing function
export async function processPDF(
  filepath: string,
  filename: string,
  documentId: string,
  chunkSize: number = 8000
): Promise<any> {
  console.log(`[PDF Processor] ===== STARTING PDF PROCESSING =====`);
  console.log(`[PDF Processor] File: ${filename}`);
  console.log(`[PDF Processor] Document ID: ${documentId}`);
  console.log(`[PDF Processor] Using Azure OpenAI: ${!!AZURE_OPENAI_API_KEY}`);
  
  const indexName = `file-${documentId}-${new Date().toISOString().split('T')[0]}`;
  
  try {
    // Read and parse PDF
    console.log(`[PDF Processor] Reading file from: ${filepath}`);
    const dataBuffer = await readFile(filepath);
    console.log(`[PDF Processor] File read successfully, buffer size: ${dataBuffer.length} bytes`);
    
    console.log(`[PDF Processor] Parsing PDF...`);
    const pdfData = await pdf(dataBuffer);
    console.log(`[PDF Processor] PDF parsed successfully`);
    
    // Split into chunks
    console.log(`[PDF Processor] Text length: ${pdfData.text.length} characters`);
    const textChunks = chunkTextByLines(pdfData.text, chunkSize);
    console.log(`[PDF Processor] Split into ${textChunks.length} chunks`);
    
    // Estimate processing time
    if (AZURE_OPENAI_API_KEY) {
      const estimatedTime = textChunks.length * (RATE_LIMIT_DELAY * 2) / 1000; // embeddings + summaries
      console.log(`[PDF Processor] Estimated processing time: ${Math.ceil(estimatedTime / 60)} minutes`);
    }
    
    // Generate embeddings and summaries with rate limiting
    console.log(`[PDF Processor] Starting embedding and summary generation...`);
    const embeddings = await generateEmbeddings(textChunks);
    const summaries = await generateSummaries(textChunks);
    
    // Create vectors for upload
    const vectors = textChunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: embeddings[index],
      metadata: {
        chunkIndex: index,
        pageStart: Math.floor(index * 8),
        pageEnd: Math.floor((index + 1) * 8),
        totalChunks: textChunks.length,
        chunkContent: chunk.substring(0, 1000),
        chunkSummary: summaries[index]
      }
    }));
    
    // Create index and upload vectors
    console.log(`[PDF Processor] Creating index: ${indexName}`);
    const dimension = embeddings[0]?.length || 1536;
    const indexCreated = await createIndexWithNewman(indexName, dimension);
    
    if (!indexCreated) {
      throw new Error(`Failed to create index '${indexName}'`);
    }
    
    console.log(`[PDF Processor] Uploading ${vectors.length} vectors to index...`);
    const uploaded = await uploadVectorsWithNewman(indexName, vectors);
    
    console.log(`[PDF Processor] ===== PDF PROCESSING COMPLETE =====`);
    console.log(`[PDF Processor] Successfully uploaded ${uploaded}/${vectors.length} vectors`);
    
    return {
      success: true,
      filename,
      totalChunks: textChunks.length,
      indexName,
      message: `Processed ${filename}: ${textChunks.length} chunks indexed in ${indexName}`
    };
    
  } catch (error) {
    console.error(`[PDF Processor] ===== ERROR IN PDF PROCESSING =====`);
    console.error(`[PDF Processor] Error:`, error);
    throw error;
  }
}

export default { processPDF };