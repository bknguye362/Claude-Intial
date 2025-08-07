// Dynamic text chunking that respects paragraph and header boundaries

interface ChunkMetadata {
  isHeader: boolean;
  headerLevel?: number;
  paragraphCount: number;
  startChar: number;
  endChar: number;
}

interface Chunk {
  content: string;
  metadata: ChunkMetadata;
}

// Detect if a line is a header (common patterns in PDFs)
function isHeader(line: string): { isHeader: boolean; level: number } {
  const trimmed = line.trim();
  
  // Empty lines are not headers
  if (!trimmed) {
    return { isHeader: false, level: 0 };
  }
  
  // Common header patterns
  // Chapter/Section with numbers
  if (/^(Chapter|Section|Part)\s+\d+/i.test(trimmed)) {
    return { isHeader: true, level: 1 };
  }
  
  // Numbered sections (1., 1.1, 1.1.1, etc.)
  if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(trimmed)) {
    const dots = (trimmed.match(/\./g) || []).length;
    return { isHeader: true, level: Math.min(dots + 1, 3) };
  }
  
  // Roman numerals
  if (/^[IVXLCDM]+\.\s+[A-Z]/.test(trimmed)) {
    return { isHeader: true, level: 1 };
  }
  
  // All caps lines (likely headers)
  if (trimmed.length > 3 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    return { isHeader: true, level: 2 };
  }
  
  // Lines that end with colon and are relatively short (likely section headers)
  if (trimmed.endsWith(':') && trimmed.length < 100 && /^[A-Z]/.test(trimmed)) {
    return { isHeader: true, level: 3 };
  }
  
  return { isHeader: false, level: 0 };
}

// Split text into paragraphs (separated by blank lines or indentation)
function splitIntoParagraphs(text: string): string[] {
  // Split by double newlines (blank lines between paragraphs)
  let paragraphs = text.split(/\n\s*\n/);
  
  // Further split by single newlines if they seem to be paragraph boundaries
  // (e.g., indented lines or lines starting with capital after period)
  const refined: string[] = [];
  
  for (const para of paragraphs) {
    const lines = para.split('\n');
    let currentPara = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Check if this line starts a new paragraph
      const isNewPara = 
        (i > 0 && line.startsWith('    ')) || // Indented line
        (i > 0 && /^[A-Z]/.test(trimmed) && lines[i-1].trim().endsWith('.')); // Capital after period
      
      if (isNewPara && currentPara) {
        refined.push(currentPara.trim());
        currentPara = line;
      } else {
        currentPara += (currentPara ? ' ' : '') + line;
      }
    }
    
    if (currentPara) {
      refined.push(currentPara.trim());
    }
  }
  
  return refined.filter(p => p.length > 0);
}

// Split a long paragraph into sentences
function splitIntoSentences(text: string): string[] {
  // Match sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

// Main dynamic chunking function
export function dynamicChunk(
  text: string, 
  maxChunkSize: number = 1000,
  overlap: number = 100
): Chunk[] {
  const chunks: Chunk[] = [];
  const paragraphs = splitIntoParagraphs(text);
  
  let currentChunk = '';
  let currentMetadata: ChunkMetadata = {
    isHeader: false,
    paragraphCount: 0,
    startChar: 0,
    endChar: 0
  };
  let globalCharPos = 0;
  let lastChunkEnd = '';
  
  for (const paragraph of paragraphs) {
    const headerInfo = isHeader(paragraph);
    
    // If this is a header and we have content, save current chunk
    if (headerInfo.isHeader && currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: {
          ...currentMetadata,
          endChar: globalCharPos
        }
      });
      
      // Start new chunk with overlap from previous chunk
      currentChunk = overlap > 0 && lastChunkEnd ? lastChunkEnd + ' ' : '';
      currentMetadata = {
        isHeader: true,
        headerLevel: headerInfo.level,
        paragraphCount: 0,
        startChar: globalCharPos,
        endChar: 0
      };
    }
    
    // Try to add the paragraph to current chunk
    const testChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
    
    if (testChunk.length <= maxChunkSize) {
      // Paragraph fits in current chunk
      currentChunk = testChunk;
      currentMetadata.paragraphCount++;
      if (headerInfo.isHeader) {
        currentMetadata.isHeader = true;
        currentMetadata.headerLevel = headerInfo.level;
      }
    } else if (paragraph.length > maxChunkSize) {
      // Single paragraph exceeds limit - split by sentences
      
      // First, save current chunk if it has content
      if (currentChunk.trim()) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            ...currentMetadata,
            endChar: globalCharPos
          }
        });
        lastChunkEnd = currentChunk.slice(-Math.min(overlap, currentChunk.length));
      }
      
      // Split the long paragraph into sentences
      const sentences = splitIntoSentences(paragraph);
      let sentenceChunk = overlap > 0 && lastChunkEnd ? lastChunkEnd + ' ' : '';
      let sentenceMetadata: ChunkMetadata = {
        isHeader: headerInfo.isHeader,
        headerLevel: headerInfo.level,
        paragraphCount: 0,
        startChar: globalCharPos,
        endChar: 0
      };
      
      for (const sentence of sentences) {
        const testSentence = sentenceChunk + (sentenceChunk ? ' ' : '') + sentence;
        
        if (testSentence.length <= maxChunkSize) {
          sentenceChunk = testSentence;
        } else {
          // Save current sentence chunk
          if (sentenceChunk.trim()) {
            chunks.push({
              content: sentenceChunk.trim(),
              metadata: {
                ...sentenceMetadata,
                endChar: globalCharPos,
                paragraphCount: 1 // Part of a paragraph
              }
            });
            lastChunkEnd = sentenceChunk.slice(-Math.min(overlap, sentenceChunk.length));
          }
          
          // Start new chunk with this sentence
          sentenceChunk = (overlap > 0 && lastChunkEnd ? lastChunkEnd + ' ' : '') + sentence;
          sentenceMetadata = {
            isHeader: false,
            paragraphCount: 0,
            startChar: globalCharPos,
            endChar: 0
          };
        }
      }
      
      // Save remaining sentence chunk
      if (sentenceChunk.trim()) {
        chunks.push({
          content: sentenceChunk.trim(),
          metadata: {
            ...sentenceMetadata,
            endChar: globalCharPos,
            paragraphCount: 1
          }
        });
        lastChunkEnd = sentenceChunk.slice(-Math.min(overlap, sentenceChunk.length));
      }
      
      // Reset current chunk
      currentChunk = '';
      currentMetadata = {
        isHeader: false,
        paragraphCount: 0,
        startChar: globalCharPos,
        endChar: 0
      };
    } else {
      // Paragraph doesn't fit - save current chunk and start new one
      if (currentChunk.trim()) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            ...currentMetadata,
            endChar: globalCharPos
          }
        });
        lastChunkEnd = currentChunk.slice(-Math.min(overlap, currentChunk.length));
      }
      
      // Start new chunk with this paragraph
      currentChunk = (overlap > 0 && lastChunkEnd ? lastChunkEnd + ' ' : '') + paragraph;
      currentMetadata = {
        isHeader: headerInfo.isHeader,
        headerLevel: headerInfo.level,
        paragraphCount: 1,
        startChar: globalCharPos,
        endChar: 0
      };
    }
    
    globalCharPos += paragraph.length + 2; // Account for paragraph separator
  }
  
  // Save final chunk if it has content
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: {
        ...currentMetadata,
        endChar: globalCharPos
      }
    });
  }
  
  return chunks;
}

// Convert dynamic chunks to the format expected by pdf-processor
export function convertToProcessorChunks(chunks: Chunk[]): string[] {
  return chunks.map(chunk => chunk.content);
}