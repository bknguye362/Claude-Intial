// Simplified metadata filter for S3 Vectors constraints

interface ChunkMetadata {
  chunkContent?: string;
  chunkSummary?: string;
  pageStart?: number;
  pageEnd?: number;
  chunkIndex?: number;
  totalChunks?: number;
}

interface FilterOptions {
  requireSection?: boolean;
  sectionPattern?: string;
  documentFilter?: string;
  pageRange?: { start: number; end: number };
  topicFilter?: string[];
}

// Check if query is asking for specific structured content (sections, chapters, etc.)
export function detectSectionQuery(query: string): {
  isSection: boolean;
  sectionNumber?: string;
  sectionPattern?: RegExp;
  sectionVariations?: string[];
} {
  // Generic patterns for any document structure
  const patterns = [
    /section\s+(\d+(?:\.\d+)*)/i,  // Matches section 21.5, section 21.5.1, etc.
    /sec\s+(\d+(?:\.\d+)*)/i,
    /chapter\s+(\d+(?:\.\d+)*)/i,
    /part\s+(\d+(?:\.\d+)*)/i,
    /article\s+(\d+(?:\.\d+)*)/i,
    /paragraph\s+(\d+(?:\.\d+)*)/i,
    /clause\s+(\d+(?:\.\d+)*)/i,
    /item\s+(\d+(?:\.\d+)*)/i,
    /(\d+(?:\.\d+)*)\s+(section|chapter|part|article)/i,  // Matches "21.5 section"
    /§\s*(\d+(?:\.\d+)*)/,
    // Add support for just numbers with dots (common in queries)
    /^(\d+\.\d+(?:\.\d+)*)$/,  // Matches just "21.5" or "21.5.1"
  ];
  
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match) {
      const sectionNumber = match[1];
      console.log(`[Section Detection] Detected section query: ${sectionNumber}`);
      
      // Create variations of the section number for better matching
      const sectionVariations = [
        sectionNumber,  // e.g., "21.5"
        `section ${sectionNumber}`,  // e.g., "section 21.5"
        `Section ${sectionNumber}`,  // e.g., "Section 21.5"
        sectionNumber.replace(/\./g, '-'),  // e.g., "21-5" (some PDFs use dashes)
      ];
      
      return {
        isSection: true,
        sectionNumber,
        sectionPattern: new RegExp(`^${sectionNumber.replace(/\./g, '\\.')}(\\.\\d+)?$`),
        sectionVariations  // Add variations for keyword matching
      };
    }
  }
  
  return { isSection: false };
}

// Simplified scoring function (not actively used but kept for compatibility)
export function scoreMetadata(
  metadata: ChunkMetadata,
  query: string,
  sectionInfo: ReturnType<typeof detectSectionQuery>
): number {
  let score = 0;
  
  // Section-specific scoring based on content
  if (sectionInfo.isSection && sectionInfo.sectionNumber && metadata.chunkContent) {
    if (metadata.chunkContent.includes(`section ${sectionInfo.sectionNumber}`) ||
        metadata.chunkContent.includes(`Section ${sectionInfo.sectionNumber}`)) {
      score += 20;
    }
  }
  
  // Check summary for keyword matches
  if (metadata.chunkSummary) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const summaryLower = metadata.chunkSummary.toLowerCase();
    
    queryWords.forEach(word => {
      if (summaryLower.includes(word)) {
        score += 3;
      }
    });
  }
  
  return score;
}

// Simplified filter function (not actively used but kept for compatibility)
export function filterByMetadata(
  results: any[],
  query: string,
  options: FilterOptions = {}
): any[] {
  // Since we're not using metadata filtering, just return results as-is
  return results;
}