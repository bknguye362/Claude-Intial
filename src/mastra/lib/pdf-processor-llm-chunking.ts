// LLM-assisted PDF chunking for intelligent document processing
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { createRequire } from 'module';
import { createOpenAI } from './azure-openai-direct.js';

const require = createRequire(import.meta.url);

interface IntelligentChunk {
  id: string;
  content: string;
  summary: string;
  startLine: number;
  endLine: number;
  pageStart?: number;
  pageEnd?: number;
  sectionTitle?: string;
  sectionNumber?: string;
  topics: string[];
  chunkType: 'introduction' | 'definition' | 'example' | 'explanation' | 'conclusion' | 'reference';
}

// PDF parsing
async function loadPdfParse() {
  try {
    const pdfParseModule = require('pdf-parse');
    return pdfParseModule;
  } catch (error) {
    console.error('[LLM Chunker] Failed to load pdf-parse:', error);
    return null;
  }
}

// Analyze text with LLM to create intelligent chunks
async function analyzeTextWithLLM(
  text: string,
  startLine: number = 1,
  documentContext?: string
): Promise<IntelligentChunk[]> {
  console.log(`[LLM Chunker] Analyzing text segment (${text.length} chars, starting at line ${startLine})`);
  
  const prompt = `You are a document analysis expert. Analyze this text and create intelligent chunks.

${documentContext ? `Document Context: ${documentContext}\n` : ''}

IMPORTANT RULES:
1. Each chunk should be 500-3000 characters (prefer ~1500)
2. NEVER split sections - keep section numbers with their content
3. Keep related concepts together
4. Preserve important context

For each chunk, provide:
- Start and end line numbers (counting from line ${startLine})
- A clear summary (1-2 sentences)
- Section title and number if present
- Main topics covered
- Chunk type

TEXT TO ANALYZE:
${text}

Return a JSON array of chunks with this structure:
[{
  "startLine": number,
  "endLine": number,
  "summary": "Clear summary of content",
  "sectionTitle": "Section title if any",
  "sectionNumber": "20.10" (if present),
  "topics": ["topic1", "topic2"],
  "chunkType": "explanation|definition|example|etc"
}]`;

  try {
    // Use the same Azure OpenAI pattern as other files
    const openai = createOpenAI();
    const model = openai('gpt-4');
    
    const messages = [
      { role: 'system', content: 'You are a document structure analyzer. Always return valid JSON arrays.' },
      { role: 'user', content: prompt }
    ];
    
    // Stream the response
    const response = await model.stream(messages, {
      temperature: 0.1,
      maxTokens: 2000
    });
    
    let content = '';
    for await (const chunk of response.textStream) {
      content += chunk;
    }
    
    if (!content) throw new Error('No response from LLM');

    // Parse the JSON response
    const chunkSpecs = JSON.parse(content);
    
    // Extract the actual text for each chunk based on line numbers
    const lines = text.split('\n');
    const chunks: IntelligentChunk[] = [];
    
    for (const spec of chunkSpecs) {
      const startIdx = spec.startLine - startLine;
      const endIdx = spec.endLine - startLine + 1;
      const chunkContent = lines.slice(startIdx, endIdx).join('\n');
      
      chunks.push({
        id: `chunk-${startLine + startIdx}-${startLine + endIdx}`,
        content: chunkContent,
        summary: spec.summary,
        startLine: startLine + startIdx,
        endLine: startLine + endIdx - 1,
        sectionTitle: spec.sectionTitle,
        sectionNumber: spec.sectionNumber,
        topics: spec.topics || [],
        chunkType: spec.chunkType || 'explanation'
      });
    }
    
    return chunks;
  } catch (error) {
    console.error('[LLM Chunker] Error analyzing text:', error);
    // Fallback to simple chunking
    return createFallbackChunks(text, startLine);
  }
}

// Fallback chunking if LLM fails
function createFallbackChunks(text: string, startLine: number): IntelligentChunk[] {
  const chunks: IntelligentChunk[] = [];
  const lines = text.split('\n');
  const chunkSize = 50; // lines per chunk
  
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunkLines = lines.slice(i, i + chunkSize);
    const content = chunkLines.join('\n');
    
    chunks.push({
      id: `chunk-${startLine + i}-${startLine + i + chunkSize}`,
      content,
      summary: `Lines ${startLine + i} to ${startLine + i + chunkSize}`,
      startLine: startLine + i,
      endLine: startLine + i + chunkLines.length - 1,
      topics: [],
      chunkType: 'explanation'
    });
  }
  
  return chunks;
}

// Main processing function
export async function processWithLLMChunking(
  filepath: string,
  options: {
    maxSegmentSize?: number;
    costLimit?: number;
  } = {}
): Promise<{
  success: boolean;
  filename: string;
  chunks?: IntelligentChunk[];
  totalChunks?: number;
  message: string;
  error?: string;
}> {
  console.log(`[LLM Chunker] ===== STARTING LLM-ASSISTED CHUNKING =====`);
  console.log(`[LLM Chunker] File: ${filepath}`);
  
  try {
    // Load PDF
    const pdfParse = await loadPdfParse();
    if (!pdfParse) throw new Error('PDF parser not available');
    
    const dataBuffer = await readFile(filepath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log(`[LLM Chunker] PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
    
    // Split into manageable segments for LLM processing
    // Use larger segments for large documents to reduce API calls
    const isLargeDoc = pdfData.numpages > 50 || pdfData.text.length > 1_000_000;
    const maxSegmentSize = options.maxSegmentSize || (isLargeDoc ? 20000 : 10000); // Larger segments for big docs
    const segments: string[] = [];
    const lines = pdfData.text.split('\n');
    let currentSegment = '';
    let currentLines = 0;
    
    for (const line of lines) {
      if (currentSegment.length + line.length > maxSegmentSize && currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = line;
      } else {
        currentSegment += (currentSegment ? '\n' : '') + line;
      }
    }
    if (currentSegment) segments.push(currentSegment);
    
    console.log(`[LLM Chunker] Split into ${segments.length} segments for analysis`);
    
    // Estimate cost
    const estimatedTokens = segments.reduce((sum, seg) => sum + seg.length / 4, 0);
    const estimatedCost = (estimatedTokens / 1000) * 0.01; // $0.01 per 1K tokens
    console.log(`[LLM Chunker] Estimated cost: $${estimatedCost.toFixed(2)}`);
    
    if (options.costLimit && estimatedCost > options.costLimit) {
      return {
        success: false,
        filename: basename(filepath),
        message: `Estimated cost ($${estimatedCost.toFixed(2)}) exceeds limit ($${options.costLimit})`,
        error: 'Cost limit exceeded'
      };
    }
    
    // Process each segment with LLM
    const allChunks: IntelligentChunk[] = [];
    let currentLine = 1;
    
    for (let i = 0; i < segments.length; i++) {
      console.log(`[LLM Chunker] Processing segment ${i + 1}/${segments.length}`);
      
      const documentContext = i === 0 ? 
        `This is the beginning of a ${pdfData.numpages}-page document` :
        `Continuing from line ${currentLine} of a ${pdfData.numpages}-page document`;
      
      const chunks = await analyzeTextWithLLM(segments[i], currentLine, documentContext);
      allChunks.push(...chunks);
      
      // Update line counter
      currentLine += segments[i].split('\n').length;
      
      // Rate limiting - reduce for large documents
      if (i < segments.length - 1) {
        const delay = isLargeDoc ? 200 : 1000; // Faster for large docs
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log(`[LLM Chunker] Created ${allChunks.length} intelligent chunks`);
    
    // Add page information based on position
    for (const chunk of allChunks) {
      const progress = chunk.startLine / lines.length;
      chunk.pageStart = Math.floor(progress * pdfData.numpages) + 1;
      chunk.pageEnd = Math.ceil((chunk.endLine / lines.length) * pdfData.numpages);
    }
    
    return {
      success: true,
      filename: basename(filepath),
      chunks: allChunks,
      totalChunks: allChunks.length,
      message: `Successfully created ${allChunks.length} intelligent chunks using LLM analysis`
    };
    
  } catch (error) {
    console.error('[LLM Chunker] Error:', error);
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF with LLM chunking',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Example of how to use the intelligent chunks for better search
export function createSearchableIndex(chunks: IntelligentChunk[]): Map<string, IntelligentChunk[]> {
  const index = new Map<string, IntelligentChunk[]>();
  
  // Index by section numbers
  for (const chunk of chunks) {
    if (chunk.sectionNumber) {
      const existing = index.get(chunk.sectionNumber) || [];
      existing.push(chunk);
      index.set(chunk.sectionNumber, existing);
    }
    
    // Also index by topics
    for (const topic of chunk.topics) {
      const key = `topic:${topic.toLowerCase()}`;
      const existing = index.get(key) || [];
      existing.push(chunk);
      index.set(key, existing);
    }
  }
  
  return index;
}