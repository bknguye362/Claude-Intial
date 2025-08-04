// Smart section-aware PDF chunker that preserves section boundaries
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

interface SectionChunk {
  content: string;
  sectionNumber?: string;
  sectionTitle?: string;
  startLine: number;
  endLine: number;
  pageNumbers?: number[];
}

// Patterns to detect section headers
const SECTION_PATTERNS = [
  /^(\d+\.?\d*)\s+(.+)$/,                    // "21.8 Windows 10"
  /^Section\s+(\d+\.?\d*)\s*[:\-]?\s*(.+)$/, // "Section 21.8: Windows 10"
  /^Chapter\s+(\d+)\.(\d+)\s*[:\-]?\s*(.+)$/, // "Chapter 21.8: Windows 10"
  /^(\d+)\.(\d+)\.(\d+)\s+(.+)$/,            // "21.8.1 History"
  /^[A-Z][A-Z\s]+$/,                          // "WINDOWS 10" (all caps headers)
];

// Detect if a line is a section header
function isSectionHeader(line: string): { isHeader: boolean; sectionNumber?: string; title?: string } {
  const trimmed = line.trim();
  
  // Skip empty lines or very short lines
  if (!trimmed || trimmed.length < 3) {
    return { isHeader: false };
  }
  
  // Check each pattern
  for (const pattern of SECTION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      if (match[1] && match[2]) {
        return {
          isHeader: true,
          sectionNumber: match[1],
          title: match[2].trim()
        };
      } else if (match[0]) {
        // All caps header
        return {
          isHeader: true,
          title: match[0]
        };
      }
    }
  }
  
  // Check for lines that look like headers (short, possibly numbered)
  if (trimmed.length < 100 && /^\d+\./.test(trimmed)) {
    const parts = trimmed.split(/\s+/, 2);
    return {
      isHeader: true,
      sectionNumber: parts[0],
      title: parts[1] || trimmed
    };
  }
  
  return { isHeader: false };
}

// Smart chunking that preserves sections
export function chunkTextBySections(
  text: string, 
  options: {
    maxChunkSize?: number;
    minChunkSize?: number;
    preserveSections?: boolean;
  } = {}
): SectionChunk[] {
  const {
    maxChunkSize = 3000,  // Max chars per chunk
    minChunkSize = 500,   // Min chars per chunk
    preserveSections = true
  } = options;
  
  const lines = text.split('\n');
  const chunks: SectionChunk[] = [];
  
  let currentChunk: string[] = [];
  let currentSection: { number?: string; title?: string } = {};
  let startLine = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerInfo = isSectionHeader(line);
    
    // If we found a section header and we're preserving sections
    if (preserveSections && headerInfo.isHeader && currentChunk.length > 0) {
      // Save current chunk if it's not too small
      const chunkContent = currentChunk.join('\n').trim();
      if (chunkContent.length >= minChunkSize || chunks.length === 0) {
        chunks.push({
          content: chunkContent,
          sectionNumber: currentSection.number,
          sectionTitle: currentSection.title,
          startLine,
          endLine: i - 1
        });
        
        // Start new chunk
        currentChunk = [line];
        currentSection = { number: headerInfo.sectionNumber, title: headerInfo.title };
        startLine = i;
      } else {
        // Current chunk too small, keep adding to it
        currentChunk.push(line);
      }
    } else {
      // Regular line - add to current chunk
      currentChunk.push(line);
      
      // Update section info if this is a header
      if (headerInfo.isHeader && currentChunk.length === 1) {
        currentSection = { number: headerInfo.sectionNumber, title: headerInfo.title };
      }
      
      // Check if chunk is getting too large
      const currentSize = currentChunk.join('\n').length;
      if (currentSize >= maxChunkSize) {
        // Try to find a good break point (paragraph boundary)
        let breakPoint = currentChunk.length;
        for (let j = currentChunk.length - 1; j > currentChunk.length / 2; j--) {
          if (currentChunk[j].trim() === '') {
            breakPoint = j;
            break;
          }
        }
        
        // Save chunk up to break point
        const chunkContent = currentChunk.slice(0, breakPoint).join('\n').trim();
        chunks.push({
          content: chunkContent,
          sectionNumber: currentSection.number,
          sectionTitle: currentSection.title,
          startLine,
          endLine: startLine + breakPoint - 1
        });
        
        // Start new chunk with remaining lines
        currentChunk = currentChunk.slice(breakPoint);
        startLine = startLine + breakPoint;
      }
    }
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join('\n').trim();
    if (chunkContent) {
      chunks.push({
        content: chunkContent,
        sectionNumber: currentSection.number,
        sectionTitle: currentSection.title,
        startLine,
        endLine: lines.length - 1
      });
    }
  }
  
  // Log section detection
  const sectionsFound = chunks.filter(c => c.sectionNumber).length;
  console.log(`[Section Chunker] Created ${chunks.length} chunks, ${sectionsFound} with section numbers`);
  
  // Log some detected sections for debugging
  const sampleSections = chunks
    .filter(c => c.sectionNumber)
    .slice(0, 5)
    .map(c => `${c.sectionNumber}: ${c.sectionTitle}`);
  if (sampleSections.length > 0) {
    console.log(`[Section Chunker] Sample sections found: ${sampleSections.join(', ')}`);
  }
  
  return chunks;
}

// Create a section-aware PDF processor
export async function processPDFWithSections(
  filepath: string
): Promise<{
  chunks: SectionChunk[];
  totalSections: number;
  sectionMap: Map<string, number>; // section number -> chunk index
}> {
  const pdfParse = require('pdf-parse');
  const { readFile } = await import('fs/promises');
  
  const dataBuffer = await readFile(filepath);
  const pdfData = await pdfParse(dataBuffer);
  
  const chunks = chunkTextBySections(pdfData.text, {
    maxChunkSize: 3000,
    minChunkSize: 500,
    preserveSections: true
  });
  
  // Build section map for quick lookup
  const sectionMap = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    if (chunk.sectionNumber) {
      sectionMap.set(chunk.sectionNumber, index);
      // Also store variations (21.8 -> 21.8.0, etc)
      if (!chunk.sectionNumber.includes('.')) {
        sectionMap.set(`${chunk.sectionNumber}.0`, index);
      }
    }
  });
  
  const totalSections = sectionMap.size;
  console.log(`[Section Chunker] Total sections indexed: ${totalSections}`);
  
  return {
    chunks,
    totalSections,
    sectionMap
  };
}