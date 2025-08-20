// Document Processing Function for automatic workflow processing (PDF and TXT files)
// This is not a tool - it's a direct function called by the workflow

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';
import { dynamicChunk, convertToProcessorChunks } from './dynamic-chunker.js';
import { 
  createDocumentNode, 
  createChunkNode, 
  createChunkRelationships 
} from './neptune-lambda-client.js';

const require = createRequire(import.meta.url);

// Type definitions
interface PDFChunk {
  index: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  embedding?: number[];
}

interface ProcessPDFResult {
  success: boolean;
  filename: string;
  totalChunks?: number;
  indexName?: string;
  message: string;
  error?: string;
}

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

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

// Initialize PDF parser
const pdf = async (dataBuffer: Buffer) => {
  if (!pdfParse) {
    pdfParse = await loadPdfParse();
  }
  
  if (!pdfParse) {
    throw new Error('PDF parser not available - please check if pdf-parse is installed');
  }
  
  return pdfParse(dataBuffer);
};

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Processor] No API key, using fallback embedding method');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    console.log('[PDF Processor] Fallback embedding generated. First 5 values:', embedding.slice(0, 5));
    return embedding;
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
    const embedding = data.data[0].embedding;
    console.log('[PDF Processor] OpenAI embedding generated. First 5 values:', embedding.slice(0, 5));
    return embedding;
  } catch (error) {
    console.error('[PDF Processor] Error generating embedding:', error);
    console.log('[PDF Processor] Falling back to hash-based embedding');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    console.log('[PDF Processor] Fallback embedding after error. First 5 values:', embedding.slice(0, 5));
    return embedding;
  }
}

// LLM-based two-pass chunking strategy
async function generateLLMChunks(fullText: string, maxChunkSize: number = 1000): Promise<{ chunks: string[], summaries: string[] }> {
  console.log('[PDF Processor] Starting LLM-based two-pass chunking strategy');
  console.log(`[PDF Processor] Document length: ${fullText.length} characters`);
  
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Processor] No API key for LLM chunking, falling back to simple chunking');
    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += maxChunkSize) {
      chunks.push(fullText.slice(i, i + maxChunkSize));
    }
    return { chunks, summaries: chunks.map(() => '') };
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    // PASS 1: Create raw chunks at sentence boundaries
    console.log('[PDF Processor] PASS 1: Creating raw chunks for analysis...');
    const rawChunks: string[] = [];
    const chunkStartPositions: number[] = [];
    
    let currentPos = 0;
    while (currentPos < fullText.length) {
      let endPos = Math.min(currentPos + maxChunkSize, fullText.length);
      
      // Adjust to sentence boundary if not at the end
      if (endPos < fullText.length) {
        const chunk = fullText.slice(currentPos, endPos);
        
        // Look for sentence endings (. ! ?) in the last part of the chunk
        let bestBreak = -1;
        
        // Search for sentence endings in reverse order (prefer later sentences)
        const sentenceEndings = ['. ', '.\n', '! ', '!\n', '? ', '?\n', '."', '!"', '?"'];
        for (const ending of sentenceEndings) {
          const lastIndex = chunk.lastIndexOf(ending);
          if (lastIndex > maxChunkSize * 0.5) { // Found in last half of chunk
            bestBreak = Math.max(bestBreak, lastIndex + ending.length - (ending.includes('\n') ? 1 : 0));
          }
        }
        
        // If no sentence break found, try paragraph break
        if (bestBreak === -1) {
          const lastParagraph = chunk.lastIndexOf('\n\n');
          if (lastParagraph > maxChunkSize * 0.5) {
            bestBreak = lastParagraph + 2;
          }
        }
        
        // If still no break, fall back to word boundary
        if (bestBreak === -1) {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxChunkSize * 0.7) {
            bestBreak = lastSpace;
          }
        }
        
        if (bestBreak > 0) {
          endPos = currentPos + bestBreak;
        }
      }
      
      rawChunks.push(fullText.slice(currentPos, endPos).trim());
      chunkStartPositions.push(currentPos);
      currentPos = endPos;
      
      // Skip whitespace at the start of next chunk
      while (currentPos < fullText.length && /\s/.test(fullText[currentPos])) {
        currentPos++;
      }
    }
    console.log(`[PDF Processor] Created ${rawChunks.length} raw chunks at sentence boundaries`);
    
    // Analyze each chunk for summaries and boundary suggestions
    console.log('[PDF Processor] Analyzing chunks for summaries and boundaries...');
    const chunkAnalyses: Array<{
      summary: string;
      shouldMergeWithNext: boolean;
      topic: string;
    }> = [];
    
    // Process chunks in batches
    const batchSize = 5;
    for (let i = 0; i < rawChunks.length; i += batchSize) {
      const batch = rawChunks.slice(i, Math.min(i + batchSize, rawChunks.length));
      console.log(`[PDF Processor] Analyzing chunks ${i + 1}-${Math.min(i + batchSize, rawChunks.length)} of ${rawChunks.length}`);
      
      const batchPromises = batch.map(async (chunk, batchIdx) => {
        const chunkIndex = i + batchIdx;
        const isLastChunk = chunkIndex === rawChunks.length - 1;
        
        // Include context from adjacent chunks
        const prevContext = chunkIndex > 0 ? rawChunks[chunkIndex - 1].slice(-100) : '';
        const nextContext = !isLastChunk ? rawChunks[chunkIndex + 1].slice(0, 100) : '';
        
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
                content: `Analyze this text chunk and provide:
1. A one-sentence summary
2. The main topic
3. Whether it should merge with the next chunk

MERGE GUIDELINES:
Merge if (shouldMergeWithNext: true):
- Section spillover: Content continues beyond this chunk without a clear end point
- Context dependency: Meaning is incomplete (ends mid-sentence, mid-paragraph, or mid-enumeration)
- Chunk too small: Less than 200 characters and needs more context

Do NOT merge if (shouldMergeWithNext: false):
- Clear topic break: Next chunk starts a new section/topic
- Optimal size: Current chunk is 700-1000 chars and semantically complete
- Independent sections: Next chunk references this one but can stand alone

This chunk is ${chunk.length} chars. Be conservative with merging.
Return JSON: {"summary": "...", "topic": "...", "shouldMergeWithNext": true/false}`
              },
              {
                role: 'user',
                content: `${prevContext ? `[Previous ends]: ...${prevContext}\n\n` : ''}[CHUNK ${chunkIndex + 1}]:\n${chunk}\n\n${nextContext ? `[Next begins]: ${nextContext}...` : '[Last chunk]'}`
              }
            ],
            max_tokens: 200,
            temperature: 0.3
          })
        });
        
        if (response.ok) {
          const data: any = await response.json();
          const content = data.choices[0].message.content;
          try {
            const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
            return {
              summary: parsed.summary || '',
              topic: parsed.topic || `Section ${chunkIndex + 1}`,
              shouldMergeWithNext: parsed.shouldMergeWithNext === true
            };
          } catch {
            return { summary: '', topic: `Section ${chunkIndex + 1}`, shouldMergeWithNext: false };
          }
        }
        return { summary: '', topic: `Section ${chunkIndex + 1}`, shouldMergeWithNext: false };
      });
      
      const batchResults = await Promise.all(batchPromises);
      chunkAnalyses.push(...batchResults);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`[PDF Processor] Analysis complete: ${chunkAnalyses.filter(a => a.shouldMergeWithNext).length} of ${chunkAnalyses.length} chunks suggest merging`);
    
    // Debug: Show merge decisions
    console.log('[PDF Processor] Merge decisions:');
    chunkAnalyses.forEach((analysis, idx) => {
      if (analysis.shouldMergeWithNext || idx < 5) { // Show first 5 and all merges
        console.log(`  Chunk ${idx + 1}: ${analysis.shouldMergeWithNext ? 'MERGE' : 'NO MERGE'} - Topic: "${analysis.topic}" - Length: ${rawChunks[idx]?.length || 0} chars`);
      }
    });
    
    // PASS 2: Recombine text based on LLM's boundary suggestions
    console.log('[PDF Processor] PASS 2: Creating semantic chunks based on boundaries...');
    const semanticChunks: string[] = [];
    const semanticSummaries: string[] = [];
    
    let i = 0;
    while (i < rawChunks.length) {
      // Start a new semantic chunk
      const startIdx = i;
      const startPos = chunkStartPositions[i];
      let endIdx = i;
      let mergedSummaries: string[] = [chunkAnalyses[i].summary].filter(s => s);
      let mergedTopics: string[] = [chunkAnalyses[i].topic];
      
      // Calculate current chunk size
      let currentEndPos = endIdx === rawChunks.length - 1 
        ? fullText.length 
        : chunkStartPositions[endIdx + 1];
      let currentLength = currentEndPos - startPos;
      
      console.log(`[PDF Processor] Processing semantic chunk starting at raw chunk ${startIdx + 1}`);
      
      // Keep merging while appropriate
      while (
        endIdx < rawChunks.length - 1 &&
        (chunkAnalyses[endIdx]?.shouldMergeWithNext || currentLength < 200) // Force merge if too small
      ) {
        console.log(`  - Raw chunk ${endIdx + 1}: shouldMerge=${chunkAnalyses[endIdx]?.shouldMergeWithNext}, currentLength=${currentLength}`);
        // Check if merging would exceed max chunk size
        const nextEndPos = endIdx + 1 === rawChunks.length - 1 
          ? fullText.length 
          : chunkStartPositions[endIdx + 2];
        const mergedLength = nextEndPos - startPos;
        
        // Stop if merging would make chunk too large (unless current is too small)
        if (mergedLength > maxChunkSize * 1.2 && currentLength >= 200) {
          console.log(`  - Stopping merge: would exceed size (${mergedLength} > ${maxChunkSize * 1.2})`);
          break;
        }
        endIdx++;
        currentLength = mergedLength; // Update current length after merging
        if (chunkAnalyses[endIdx].summary) {
          mergedSummaries.push(chunkAnalyses[endIdx].summary);
        }
        if (chunkAnalyses[endIdx].topic && !mergedTopics.includes(chunkAnalyses[endIdx].topic)) {
          mergedTopics.push(chunkAnalyses[endIdx].topic);
        }
        console.log(`  - Merged with chunk ${endIdx + 1}, new length: ${currentLength}`);
      }
      
      // Extract the semantic chunk from the full text
      let endPos = endIdx === rawChunks.length - 1 
        ? fullText.length 
        : chunkStartPositions[endIdx + 1];
      
      // Ensure we end at a sentence boundary if possible
      if (endPos < fullText.length) {
        const remainder = fullText.slice(endPos, Math.min(endPos + 100, fullText.length));
        
        // Check if we're mid-sentence and find the next sentence ending
        const sentenceEndings = ['. ', '.\n', '! ', '!\n', '? ', '?\n', '."', '!"', '?"'];
        let nearestEnd = -1;
        
        for (const ending of sentenceEndings) {
          const idx = remainder.indexOf(ending);
          if (idx !== -1 && (nearestEnd === -1 || idx < nearestEnd)) {
            nearestEnd = idx + ending.length - (ending.includes('\n') ? 1 : 0);
          }
        }
        
        // Extend to complete the sentence if it's reasonably close
        if (nearestEnd > 0 && nearestEnd < 100) {
          endPos += nearestEnd;
        }
      }
      
      const semanticChunkText = fullText.slice(startPos, endPos).trim();
      
      if (semanticChunkText) {
        semanticChunks.push(semanticChunkText);
        
        // Create combined summary
        const combinedSummary = mergedSummaries.length > 1
          ? `${mergedTopics[0]}: ${mergedSummaries.join(' ')}`.slice(0, 200)
          : mergedSummaries[0] || mergedTopics[0];
        
        semanticSummaries.push(combinedSummary);
        
        console.log(`[PDF Processor] Created semantic chunk ${semanticChunks.length}:`);
        console.log(`  - Length: ${semanticChunkText.length} chars`);
        console.log(`  - Merged: ${endIdx - startIdx + 1} raw chunks (${startIdx + 1}-${endIdx + 1})`);
        console.log(`  - Topic: ${mergedTopics[0]}`);
        console.log(`  - First 50 chars: "${semanticChunkText.slice(0, 50)}..."`);
        console.log(`  - Last 50 chars: "...${semanticChunkText.slice(-50)}"`);
        console.log('');
      }
      
      // Move to next unprocessed chunk
      i = endIdx + 1;
    }
    
    
    console.log(`[PDF Processor] Two-pass chunking complete:`);
    console.log(`[PDF Processor]   - Raw chunks: ${rawChunks.length}`);
    console.log(`[PDF Processor]   - Semantic chunks: ${semanticChunks.length}`);
    console.log(`[PDF Processor]   - Average semantic chunk size: ${Math.round(fullText.length / semanticChunks.length)} chars`);
    
    return { chunks: semanticChunks, summaries: semanticSummaries };
    
  } catch (error) {
    console.error('[PDF Processor] Error in LLM chunking:', error);
    console.log('[PDF Processor] Falling back to simple chunking');
    
    // Fallback to simple chunking
    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += maxChunkSize) {
      chunks.push(fullText.slice(i, i + maxChunkSize));
    }
    return { chunks, summaries: chunks.map(() => '') };
  }
}

// Helper function to generate embeddings for multiple texts with rate limiting
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`[PDF Processor] Generating embeddings for ${texts.length} chunks...`);
  
  const embeddings: number[][] = [];
  
  // If using Azure OpenAI, process with controlled parallelism
  if (AZURE_OPENAI_API_KEY) {
    // Process in batches with limited concurrency
    const maxConcurrent = 3; // Process 3 at a time
    const batchDelay = 1500; // Delay between batches
    
    for (let i = 0; i < texts.length; i += maxConcurrent) {
      const batch = texts.slice(i, i + maxConcurrent);
      
      if (i % 30 === 0) {
        console.log(`[PDF Processor] Generating embeddings ${i + 1}-${Math.min(i + maxConcurrent, texts.length)}/${texts.length}`);
      }
      
      // Process batch in parallel
      const batchPromises = batch.map(async (text) => {
        try {
          return await generateEmbedding(text);
        } catch (error) {
          console.error('[PDF Processor] Embedding error, using fallback:', error);
          const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          return Array(1536).fill(0).map((_, j) => Math.sin(hash + j) * 0.5 + 0.5);
        }
      });
      
      const batchEmbeddings = await Promise.all(batchPromises);
      embeddings.push(...batchEmbeddings);
      
      // Delay between batches to respect rate limits
      if (i + maxConcurrent < texts.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }
  } else {
    // For fallback method, can process in parallel
    const batchSize = 5;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(text => generateEmbedding(text));
      const batchEmbeddings = await Promise.all(batchPromises);
      embeddings.push(...batchEmbeddings);
    }
  }
  
  return embeddings;
}

// Helper function to generate summary for a chunk using LLM
async function generateChunkSummary(chunkContent: string): Promise<string> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[PDF Processor] No API key, using fallback summary');
    // Return a simple summary if no API key
    const lines = chunkContent.split('\n').filter(l => l.trim());
    return lines.slice(0, 2).join(' ').substring(0, 200);
  }

  try {
    // Log chunk being sent to LLM
    console.log('[PDF Processor] Sending chunk to LLM for summary. First 200 chars:', chunkContent.substring(0, 200));
    console.log('[PDF Processor] Chunk length:', chunkContent.length, 'chars');
    
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
            content: 'You are a helpful assistant that creates concise summaries of text chunks. Focus on the key concepts, topics, and information present in the chunk. Keep summaries under 150 words.'
          },
          {
            role: 'user',
            content: `Please summarize the following text chunk:\n\n${chunkContent.substring(0, 3000)}`
          }
        ],
        max_tokens: 200,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('[PDF Processor] Error generating summary:', error);
    // Fallback to simple summary
    const lines = chunkContent.split('\n').filter(l => l.trim());
    return lines.slice(0, 2).join(' ').substring(0, 200);
  }
}

// Helper function to generate summaries for multiple chunks
async function generateChunkSummaries(chunks: string[]): Promise<string[]> {
  console.log(`[PDF Processor] Generating summaries for ${chunks.length} chunks...`);
  
  const summaries: string[] = [];
  
  // If using Azure OpenAI, process with controlled parallelism
  if (AZURE_OPENAI_API_KEY) {
    const maxConcurrent = 2; // Process 2 summaries at a time (less than embeddings)
    const batchDelay = 1000; // Delay between batches
    
    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const batch = chunks.slice(i, i + maxConcurrent);
      
      if (i % 20 === 0) {
        console.log(`[PDF Processor] Generating summaries ${i + 1}-${Math.min(i + maxConcurrent, chunks.length)}/${chunks.length}`);
      }
      
      // Process batch in parallel
      const batchPromises = batch.map(async (chunk) => {
        try {
          return await generateChunkSummary(chunk);
        } catch (error) {
          console.error('[PDF Processor] Summary error, using fallback');
          const lines = chunk.split('\n').filter(l => l.trim());
          return lines.slice(0, 2).join(' ').substring(0, 200);
        }
      });
      
      const batchSummaries = await Promise.all(batchPromises);
      summaries.push(...batchSummaries);
      
      // Delay between batches
      if (i + maxConcurrent < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }
  } else {
    // For fallback method, just use simple summaries
    for (const chunk of chunks) {
      const lines = chunk.split('\n').filter(l => l.trim());
      summaries.push(lines.slice(0, 2).join(' ').substring(0, 200));
    }
  }
  
  return summaries;
}


// Helper function to find the end of a sentence
function findSentenceEnd(text: string, startPos: number, maxPos: number): number {
  // Look for sentence endings: . ! ? followed by space or newline or end of text
  const sentenceEndPattern = /[.!?](?:\s|$)/g;
  
  // Start searching from startPos
  sentenceEndPattern.lastIndex = startPos;
  
  let match;
  let lastGoodEnd = maxPos; // Default to maxPos if no sentence end found
  
  while ((match = sentenceEndPattern.exec(text)) !== null) {
    if (match.index <= maxPos) {
      // Found a sentence end within our chunk size limit
      lastGoodEnd = match.index + match[0].length;
    } else {
      // We've gone past our max position
      break;
    }
  }
  
  // If we couldn't find any sentence end, at least try to end at a word boundary
  if (lastGoodEnd === maxPos && maxPos < text.length) {
    // Look backwards from maxPos to find a space
    for (let i = maxPos; i > startPos && i > maxPos - 50; i--) {
      if (text[i] === ' ' || text[i] === '\n') {
        lastGoodEnd = i;
        break;
      }
    }
  }
  
  return lastGoodEnd;
}

// Helper function to split text into character-based chunks with overlap
function chunkTextByCharacters(text: string, chunkSize: number = 1000, overlapSize: number = 200): string[] {
  const chunks: string[] = [];
  let currentPos = 0;
  
  while (currentPos < text.length) {
    // Calculate the ideal end position for this chunk
    let idealEnd = currentPos + chunkSize;
    
    // If this would be the last chunk, take everything remaining
    if (idealEnd >= text.length) {
      const chunk = text.substring(currentPos).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      break;
    }
    
    // Find a good sentence boundary near the ideal end position
    // Allow up to 100 extra characters to complete a sentence
    const actualEnd = findSentenceEnd(text, currentPos, Math.min(idealEnd + 100, text.length));
    
    // Extract the chunk
    const chunk = text.substring(currentPos, actualEnd).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    
    // Move to the next chunk position with overlap
    // Calculate stride based on actual chunk size to maintain consistent overlap
    const actualChunkSize = actualEnd - currentPos;
    const stride = Math.max(1, actualChunkSize - overlapSize);
    currentPos += stride;
    
    // Prevent infinite loops
    if (stride <= 0) {
      currentPos = actualEnd;
    }
  }
  
  console.log(`[PDF Processor] Created ${chunks.length} chunks with sentence boundaries`);
  console.log(`[PDF Processor] Average chunk size: ${Math.round(text.length / chunks.length)} characters`);
  return chunks;
}

// Main function to process PDF or TXT files
export async function processPDF(filepath: string, chunkSize: number = 1000): Promise<ProcessPDFResult> {
  console.log(`[PDF Processor] ===== STARTING FILE PROCESSING =====`);
  console.log(`[PDF Processor] Processing file: ${filepath}`);
  console.log(`[PDF Processor] Chunk size: ${chunkSize} characters`);
  
  // Detect file type based on extension
  const fileExtension = filepath.toLowerCase().split('.').pop();
  const isPDF = fileExtension === 'pdf';
  const isTXT = fileExtension === 'txt';
  
  if (!isPDF && !isTXT) {
    console.error(`[PDF Processor] Unsupported file type: .${fileExtension}`);
    return {
      success: false,
      filename: basename(filepath),
      message: `Unsupported file type: .${fileExtension}. Only PDF and TXT files are supported.`,
      error: 'UNSUPPORTED_FILE_TYPE'
    };
  }
  
  console.log(`[PDF Processor] File type detected: ${isPDF ? 'PDF' : 'TXT'}`);
  
  try {
    // Read file
    console.log(`[PDF Processor] Reading file from: ${filepath}`);
    const dataBuffer = await readFile(filepath);
    console.log(`[PDF Processor] File read successfully, buffer size: ${dataBuffer.length} bytes`);
    
    // Parse file based on type
    let pdfData: { text: string; numpages?: number };
    
    if (isPDF) {
      console.log(`[PDF Processor] Parsing PDF...`);
      pdfData = await pdf(dataBuffer);
      console.log(`[PDF Processor] PDF parsed successfully`);
    } else {
      // For TXT files, create a compatible structure
      console.log(`[PDF Processor] Processing TXT file...`);
      const textContent = dataBuffer.toString('utf-8');
      pdfData = {
        text: textContent,
        numpages: Math.ceil(textContent.length / 3000) // Estimate pages (3000 chars per page)
      };
      console.log(`[PDF Processor] TXT file processed successfully`);
    }
    
    const metadata = {
      title: (pdfData as any).info?.Title || basename(filepath),
      author: (pdfData as any).info?.Author || 'Unknown',
      pages: pdfData.numpages || 1,
      characters: pdfData.text.length,
      fileType: isPDF ? 'PDF' : 'TXT'
    };
    
    // Always use LLM-based chunking for intelligent semantic boundaries
    console.log(`[PDF Processor] Text length: ${pdfData.text.length} characters`);
    
    let textChunks: string[];
    let chunkSummaries: string[] = [];
    let dynamicChunks: any[] = [];
    
    console.log(`[PDF Processor] Using LLM-based semantic chunking...`);
    const llmResult = await generateLLMChunks(pdfData.text, chunkSize);
    textChunks = llmResult.chunks;
    chunkSummaries = llmResult.summaries;
    
    // Create compatible dynamic chunks structure for metadata
    dynamicChunks = textChunks.map((chunk, i) => ({
      content: chunk,
      metadata: {
        isHeader: false,
        paragraphCount: chunk.split('\n\n').length,
        summary: chunkSummaries[i]
      }
    }));
    
    console.log(`[PDF Processor] Split into ${textChunks.length} chunks`);
    console.log(`[PDF Processor] Chunk distribution:`);
    console.log(`[PDF Processor]   - Header chunks: ${dynamicChunks.filter(c => c.metadata.isHeader).length}`);
    console.log(`[PDF Processor]   - Average paragraphs per chunk: ${(dynamicChunks.reduce((sum, c) => sum + c.metadata.paragraphCount, 0) / dynamicChunks.length).toFixed(1)}`);
    console.log(`[PDF Processor] First chunk preview: ${textChunks[0]?.substring(0, 100)}...`);
    
    // Remove chunk limit - process all chunks but warn if very large
    if (textChunks.length > 2000) {
      console.warn(`[PDF Processor] Processing large document with ${textChunks.length} chunks. This may take a while...`);
    }
    
    // Generate index name and create index immediately
    const fileExt = isPDF ? '.pdf' : '.txt';
    const documentId = basename(filepath, fileExt);
    const cleanName = documentId
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const dateStr = new Date().toISOString().split('T')[0];
    const indexName = `file-${cleanName}-${dateStr}`;
    
    console.log(`[PDF Processor] Creating S3 Vectors index '${indexName}' IMMEDIATELY...`);
    const dimension = 1536; // OpenAI embeddings dimension
    const indexCreated = await createIndexWithNewman(indexName, dimension);
    console.log(`[PDF Processor] Index creation result: ${indexCreated}`);
    
    if (!indexCreated) {
      throw new Error(`Failed to create index '${indexName}'`);
    }
    
    console.log(`[PDF Processor] ✅ Index '${indexName}' created! Processing will continue...`)
    
    // Generate embeddings and summaries in parallel
    console.log(`[PDF Processor] Generating embeddings and summaries...`);
    const [embeddings, summaries] = await Promise.all([
      generateEmbeddings(textChunks),
      generateChunkSummaries(textChunks)
    ]);
    console.log(`[PDF Processor] Generated ${embeddings.length} embeddings and ${summaries.length} summaries`);
    
    // Create chunks with metadata including dynamic chunk info
    const chunks = textChunks.map((content, index) => {
      const chunkPosition = index / textChunks.length;
      const numPages = pdfData.numpages || 1;
      const pageStart = Math.floor(chunkPosition * numPages) + 1;
      const pageEnd = Math.min(
        Math.ceil((index + 1) / textChunks.length * numPages),
        numPages
      );
      
      // Get metadata from dynamic chunks if available
      const dynamicMeta = dynamicChunks[index]?.metadata;
      
      return {
        content,
        embedding: embeddings[index],
        metadata: {
          pageStart,
          pageEnd,
          chunkIndex: index,
          totalChunks: textChunks.length,
          isHeader: dynamicMeta?.isHeader || false,
          headerLevel: dynamicMeta?.headerLevel,
          paragraphCount: dynamicMeta?.paragraphCount || 1,
          summary: dynamicMeta?.summary || ''
        }
      };
    });
    
    // Index was already created at the beginning
    console.log(`[PDF Processor] Using existing index '${indexName}' for vector upload`);
    console.log(`[PDF Processor] Ready to upload ${chunks.length} vectors with embeddings`)
    
    // Prepare vectors for upload with metadata
    const vectors = chunks.map((chunk, index) => ({
      key: `${documentId}-chunk-${index}`,
      embedding: chunk.embedding,
      metadata: {
        chunkIndex: index,
        pageStart: chunk.metadata.pageStart,
        pageEnd: chunk.metadata.pageEnd,
        totalChunks: chunks.length,
        // Store full chunk content (chunks are now 1000 chars)
        chunkContent: chunk.content,
        chunkSummary: (chunk.metadata.summary || '').substring(0, 200), // LLM-generated summary limited to 200 chars
        // Add document name for multi-document filtering
        docName: basename(filepath, fileExt).substring(0, 50) // Limited to 50 chars
      }
    }));
    
    console.log(`[PDF Processor] Uploading ${vectors.length} vectors to index '${indexName}'...`);
    const uploadedCount = await uploadVectorsWithNewman(indexName, vectors);
    
    console.log(`[PDF Processor] Upload complete. Uploaded ${uploadedCount} vectors to index '${indexName}'`);
    
    // Create entity-based knowledge graph
    console.log(`[PDF Processor] Creating entity knowledge graph...`);
    console.log(`[PDF Processor] Azure API Key present: ${process.env.AZURE_OPENAI_API_KEY ? 'YES' : 'NO'}`);
    try {
      console.log(`[PDF Processor] Importing entity extractor module...`);
      const { createEntityKnowledgeGraph } = await import('./entity-extractor.js');
      console.log(`[PDF Processor] Module imported successfully`);
      
      const docId = `doc_${indexName}`;  // Matches S3 index name
      const graphChunks = chunks.map((chunk, i) => ({
        id: `chunk_${indexName}_${i}`,
        content: chunk.content,
        summary: chunk.metadata.summary || chunkSummaries[i] || ''
      }));
      
      console.log(`[PDF Processor] Calling createEntityKnowledgeGraph with ${graphChunks.length} chunks...`);
      const graphResult = await createEntityKnowledgeGraph(docId, indexName, graphChunks);
      console.log(`[PDF Processor] Graph creation completed`);
      
      if (graphResult.success) {
        console.log(`[PDF Processor] Entity knowledge graph created successfully`);
        console.log(`[PDF Processor] - ${graphResult.entities.length} entities extracted`);
        console.log(`[PDF Processor] - ${graphResult.relationships.length} relationships identified`);
        
        // Log entity type distribution
        const entityTypes: Record<string, number> = {};
        for (const entity of graphResult.entities) {
          entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
        }
        console.log(`[PDF Processor] Entity types:`, entityTypes);
      } else {
        console.log(`[PDF Processor] Entity graph creation had issues but continuing...`);
      }
    } catch (neptuneError: any) {
      console.error('[PDF Processor] Error creating entity knowledge graph:', neptuneError);
      console.error('[PDF Processor] Error message:', neptuneError.message);
      console.error('[PDF Processor] Error stack:', neptuneError.stack);
      // Continue even if Neptune fails - S3 Vectors is the primary storage
    }
    
    console.log(`[PDF Processor] ===== FILE PROCESSING COMPLETE =====`);
    
    return {
      success: true,
      filename: basename(filepath),
      totalChunks: chunks.length,
      indexName,
      message: `Successfully processed ${isPDF ? 'PDF' : 'TXT'} file '${basename(filepath)}' into ${chunks.length} chunks and created index '${indexName}'.`
    };
    
  } catch (error) {
    console.error('[PDF Processor] ===== ERROR IN FILE PROCESSING =====');
    console.error('[PDF Processor] Error:', error);
    console.error('[PDF Processor] Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
    return {
      success: false,
      filename: basename(filepath),
      message: `Failed to process ${fileExtension?.toUpperCase() || 'file'}`,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Alias for backward compatibility and clarity
export { processPDF as processDocument };

// Helper function to detect file type
export function getFileType(filepath: string): 'pdf' | 'txt' | 'unknown' {
  const extension = filepath.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'pdf';
  if (extension === 'txt') return 'txt';
  return 'unknown';
}