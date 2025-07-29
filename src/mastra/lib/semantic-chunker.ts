// Semantic chunking strategies for PDF processing

export interface ChunkingOptions {
  maxChunkSize: number;       // Maximum characters per chunk
  minChunkSize: number;       // Minimum characters per chunk
  overlapSize: number;        // Characters to overlap between chunks
  strategy: 'sentence' | 'paragraph' | 'semantic' | 'sliding-window';
}

const DEFAULT_OPTIONS: ChunkingOptions = {
  maxChunkSize: 1500,
  minChunkSize: 200,
  overlapSize: 200,
  strategy: 'paragraph'
};

// Strategy 1: Sentence-based chunking
export function chunkBySentences(
  text: string, 
  options: Partial<ChunkingOptions> = {}
): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: string[] = [];
  
  // Split by sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  let currentChunk = '';
  let previousSentences: string[] = [];
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    
    // If adding this sentence would exceed max size, start new chunk
    if (currentChunk.length + trimmedSentence.length > opts.maxChunkSize && currentChunk.length > opts.minChunkSize) {
      chunks.push(currentChunk.trim());
      
      // Add overlap from previous sentences
      const overlapText = previousSentences.slice(-3).join(' ');
      currentChunk = overlapText.slice(-opts.overlapSize) + ' ' + trimmedSentence;
      previousSentences = [trimmedSentence];
    } else {
      currentChunk += ' ' + trimmedSentence;
      previousSentences.push(trimmedSentence);
    }
  }
  
  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Strategy 2: Paragraph-based chunking
export function chunkByParagraphs(
  text: string,
  options: Partial<ChunkingOptions> = {}
): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: string[] = [];
  
  // Split by double newlines or multiple spaces (paragraph boundaries)
  const paragraphs = text.split(/\n\s*\n|\r\n\s*\r\n/).map(p => p.trim()).filter(p => p);
  
  let currentChunk = '';
  let previousParagraph = '';
  
  for (const paragraph of paragraphs) {
    // Skip very short paragraphs (likely headers or page numbers)
    if (paragraph.length < 50) continue;
    
    // If adding this paragraph exceeds max size, create new chunk
    if (currentChunk.length + paragraph.length > opts.maxChunkSize && currentChunk.length > opts.minChunkSize) {
      chunks.push(currentChunk.trim());
      
      // Start new chunk with overlap from previous paragraph
      const overlap = previousParagraph.slice(-opts.overlapSize);
      currentChunk = overlap + '\n\n' + paragraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
    
    previousParagraph = paragraph;
  }
  
  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Strategy 3: Semantic chunking using topic boundaries
export function chunkBySemantic(
  text: string,
  options: Partial<ChunkingOptions> = {}
): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: string[] = [];
  
  // Identify section headers and topic boundaries
  const lines = text.split('\n');
  const sections: { header: string; content: string[] }[] = [];
  let currentSection: { header: string; content: string[] } = { header: '', content: [] };
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Detect headers (all caps, numbered sections, short lines followed by longer content)
    const isHeader = 
      (trimmedLine.length < 100 && trimmedLine === trimmedLine.toUpperCase() && /[A-Z]/.test(trimmedLine)) ||
      /^\d+\.?\s+[A-Z]/.test(trimmedLine) ||
      /^[IVX]+\.?\s+/.test(trimmedLine) || // Roman numerals
      /^(Chapter|Section|Part)\s+\d+/i.test(trimmedLine);
    
    if (isHeader && currentSection.content.length > 0) {
      // Save current section and start new one
      sections.push(currentSection);
      currentSection = { header: trimmedLine, content: [] };
    } else if (trimmedLine) {
      currentSection.content.push(trimmedLine);
    }
  }
  
  // Add last section
  if (currentSection.content.length > 0) {
    sections.push(currentSection);
  }
  
  // Now chunk within sections while respecting boundaries
  for (const section of sections) {
    const sectionText = (section.header ? section.header + '\n\n' : '') + section.content.join('\n');
    
    if (sectionText.length <= opts.maxChunkSize) {
      // Small section, keep as single chunk
      chunks.push(sectionText);
    } else {
      // Large section, need to split but keep context
      const subChunks = chunkByParagraphs(sectionText, opts);
      
      // Add section header to each sub-chunk for context
      if (section.header) {
        for (let i = 0; i < subChunks.length; i++) {
          if (i === 0) {
            chunks.push(subChunks[i]); // Already has header
          } else {
            chunks.push(`[Continued from: ${section.header}]\n\n${subChunks[i]}`);
          }
        }
      } else {
        chunks.push(...subChunks);
      }
    }
  }
  
  return chunks;
}

// Strategy 4: Sliding window with semantic boundaries
export function chunkBySlidingWindow(
  text: string,
  options: Partial<ChunkingOptions> = {}
): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: string[] = [];
  
  // First, identify good break points (end of sentences/paragraphs)
  const breakPoints: number[] = [0];
  
  // Find sentence endings
  const sentenceEndings = /[.!?]\s+/g;
  let match;
  while ((match = sentenceEndings.exec(text)) !== null) {
    breakPoints.push(match.index + match[0].length);
  }
  
  // Find paragraph breaks
  const paragraphBreaks = /\n\s*\n/g;
  while ((match = paragraphBreaks.exec(text)) !== null) {
    breakPoints.push(match.index);
  }
  
  // Sort and deduplicate break points
  const sortedBreaks = [...new Set(breakPoints)].sort((a, b) => a - b);
  sortedBreaks.push(text.length);
  
  let chunkStart = 0;
  
  while (chunkStart < text.length) {
    // Find the best break point near our target chunk size
    const targetEnd = chunkStart + opts.maxChunkSize;
    
    // Find nearest break point to target
    let bestBreak = targetEnd;
    let minDistance = text.length;
    
    for (const breakPoint of sortedBreaks) {
      if (breakPoint > chunkStart + opts.minChunkSize && breakPoint < chunkStart + opts.maxChunkSize * 1.2) {
        const distance = Math.abs(breakPoint - targetEnd);
        if (distance < minDistance) {
          minDistance = distance;
          bestBreak = breakPoint;
        }
      }
    }
    
    // Extract chunk
    const chunk = text.slice(chunkStart, bestBreak).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    
    // Move start with overlap
    chunkStart = bestBreak - opts.overlapSize;
    
    // Ensure we make progress
    if (chunkStart <= chunks.length * opts.minChunkSize) {
      chunkStart = bestBreak;
    }
  }
  
  return chunks;
}

// Advanced: Embedding-based semantic chunking
export async function chunkByEmbeddingSimilarity(
  text: string,
  embedFunction: (text: string) => Promise<number[]>,
  options: Partial<ChunkingOptions> = {}
): Promise<string[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // First, do initial rough chunking
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  // Generate embeddings for each sentence
  const sentenceEmbeddings = await Promise.all(
    sentences.map(s => embedFunction(s.trim()))
  );
  
  // Calculate similarity between adjacent sentences
  const similarities: number[] = [];
  for (let i = 0; i < sentenceEmbeddings.length - 1; i++) {
    const similarity = cosineSimilarity(sentenceEmbeddings[i], sentenceEmbeddings[i + 1]);
    similarities.push(similarity);
  }
  
  // Find natural break points (low similarity)
  const meanSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const threshold = meanSimilarity - 0.1; // Adjust based on your needs
  
  const chunks: string[] = [];
  if (sentences.length === 0) return chunks;
  
  const firstSentence = sentences[0];
  if (!firstSentence) return chunks;
  
  let currentChunk: string[] = [firstSentence];
  let chunkSize = firstSentence.length;
  
  for (let i = 1; i < sentences.length; i++) {
    const sentenceLength = sentences[i].length;
    
    // Check if we should start a new chunk
    const shouldBreak = 
      (chunkSize + sentenceLength > opts.maxChunkSize && chunkSize > opts.minChunkSize) ||
      (similarities[i - 1] < threshold && chunkSize > opts.minChunkSize);
    
    if (shouldBreak) {
      chunks.push(currentChunk.join(' ').trim());
      
      // Start new chunk with overlap
      const overlapCount = Math.max(1, Math.floor(currentChunk.length * 0.2));
      currentChunk = [...currentChunk.slice(-overlapCount), sentences[i]];
      chunkSize = currentChunk.reduce((sum, s) => sum + s.length, 0);
    } else {
      currentChunk.push(sentences[i]);
      chunkSize += sentenceLength;
    }
  }
  
  // Add final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' ').trim());
  }
  
  return chunks;
}

// Helper function for cosine similarity
function cosineSimilarity(vec1: number[], vec2: number[]): number {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// Main chunking function that selects strategy
export async function chunkText(
  text: string,
  options: Partial<ChunkingOptions> = {},
  embedFunction?: (text: string) => Promise<number[]>
): Promise<string[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  switch (opts.strategy) {
    case 'sentence':
      return chunkBySentences(text, opts);
    
    case 'paragraph':
      return chunkByParagraphs(text, opts);
    
    case 'semantic':
      return chunkBySemantic(text, opts);
    
    case 'sliding-window':
      return chunkBySlidingWindow(text, opts);
    
    default:
      // If embedding function provided, use similarity-based chunking
      if (embedFunction) {
        return chunkByEmbeddingSimilarity(text, embedFunction, opts);
      }
      return chunkByParagraphs(text, opts);
  }
}