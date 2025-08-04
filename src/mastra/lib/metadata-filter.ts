// Metadata-based filtering and ranking for search results

interface ChunkMetadata {
  content: string;
  sectionNumber?: string;
  sectionTitle?: string;
  summary?: string;
  topics?: string;
  chunkType?: string;
  pageStart?: number;
  pageEnd?: number;
  documentId?: string;
  filename?: string;
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
} {
  // Generic patterns for any document structure
  const patterns = [
    /section\s+(\d+\.?\d*)/i,
    /sec\s+(\d+\.?\d*)/i,
    /chapter\s+(\d+\.?\d*)/i,
    /part\s+(\d+\.?\d*)/i,
    /article\s+(\d+\.?\d*)/i,
    /paragraph\s+(\d+\.?\d*)/i,
    /clause\s+(\d+\.?\d*)/i,
    /item\s+(\d+\.?\d*)/i,
    /(\d+\.?\d*)\s+(section|chapter|part|article)/i,
    /§\s*(\d+\.?\d*)/,
  ];
  
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match) {
      const sectionNumber = match[1] + (match[2] ? `.${match[2]}` : '');
      return {
        isSection: true,
        sectionNumber,
        sectionPattern: new RegExp(`^${sectionNumber.replace('.', '\\.')}(\\.\\d+)?$`)
      };
    }
  }
  
  return { isSection: false };
}

// Score chunk based on metadata relevance
export function scoreMetadata(
  metadata: ChunkMetadata,
  query: string,
  sectionInfo: ReturnType<typeof detectSectionQuery>
): number {
  let score = 0;
  
  // Section-specific scoring
  if (sectionInfo.isSection && sectionInfo.sectionNumber) {
    if (metadata.sectionNumber === sectionInfo.sectionNumber) {
      score += 100; // Exact section match
    } else if (sectionInfo.sectionPattern && metadata.sectionNumber && 
               sectionInfo.sectionPattern.test(metadata.sectionNumber)) {
      score += 50; // Subsection match
    } else if (metadata.content.includes(`section ${sectionInfo.sectionNumber}`) ||
               metadata.content.includes(`Section ${sectionInfo.sectionNumber}`)) {
      score += 20; // Section mentioned in content
    }
  }
  
  // General keyword relevance
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  // Check all available metadata fields for keyword matches
  const metadataFields = [
    { field: metadata.topics, weight: 5 },
    { field: metadata.sectionTitle, weight: 10 },
    { field: metadata.summary, weight: 3 },
    { field: metadata.filename, weight: 2 },
    { field: metadata.documentId, weight: 1 }
  ];
  
  metadataFields.forEach(({ field, weight }) => {
    if (field) {
      const fieldLower = field.toString().toLowerCase();
      queryWords.forEach(word => {
        if (fieldLower.includes(word)) {
          score += weight;
        }
      });
    }
  });
  
  // Generic content type matching
  if (metadata.chunkType) {
    const typeQueries = {
      'definition': ['definition', 'define', 'what is', 'meaning'],
      'example': ['example', 'instance', 'such as', 'for example'],
      'introduction': ['introduction', 'intro', 'overview', 'beginning'],
      'conclusion': ['conclusion', 'summary', 'conclude', 'final'],
      'procedure': ['how to', 'steps', 'procedure', 'process']
    };
    
    Object.entries(typeQueries).forEach(([type, keywords]) => {
      if (metadata.chunkType === type && keywords.some(kw => queryLower.includes(kw))) {
        score += 10;
      }
    });
  }
  
  return score;
}

// Filter and rank results based on metadata
export function filterByMetadata(
  results: any[],
  query: string,
  options: FilterOptions = {}
): any[] {
  const sectionInfo = detectSectionQuery(query);
  
  // Score all results
  const scoredResults = results.map(result => {
    const metadata = result.metadata || {};
    const metadataScore = scoreMetadata(metadata, query, sectionInfo);
    
    return {
      ...result,
      metadataScore
    };
  });
  
  // Apply filters
  let filtered = scoredResults;
  
  // Section requirement - only apply if explicitly requested
  if (options.requireSection) {
    filtered = filtered.filter(r => {
      const metadata = r.metadata || {};
      const content = metadata.content || '';
      
      // If looking for specific section
      if (sectionInfo.isSection && sectionInfo.sectionNumber) {
        // Check if section number appears in metadata OR content
        const hasInMetadata = metadata.sectionNumber === sectionInfo.sectionNumber;
        const hasInContent = content.toLowerCase().includes(`section ${sectionInfo.sectionNumber}`) ||
                           content.toLowerCase().includes(`section${sectionInfo.sectionNumber}`) ||
                           content.toLowerCase().includes(`sec ${sectionInfo.sectionNumber}`) ||
                           content.toLowerCase().includes(`${sectionInfo.sectionNumber} `) ||
                           content.includes(`§${sectionInfo.sectionNumber}`);
        
        return hasInMetadata || hasInContent;
      }
      
      // If just requiring any section, don't filter (since we can't guarantee metadata)
      return true;
    });
  }
  
  // Document filter
  if (options.documentFilter) {
    filtered = filtered.filter(r => {
      const metadata = r.metadata || {};
      return metadata.documentId === options.documentFilter ||
             metadata.filename === options.documentFilter;
    });
  }
  
  // Page range filter
  if (options.pageRange) {
    filtered = filtered.filter(r => {
      const metadata = r.metadata || {};
      const pageStart = metadata.pageStart || 0;
      const pageEnd = metadata.pageEnd || pageStart;
      
      return pageEnd >= options.pageRange!.start && 
             pageStart <= options.pageRange!.end;
    });
  }
  
  // Topic filter
  if (options.topicFilter && options.topicFilter.length > 0) {
    filtered = filtered.filter(r => {
      const metadata = r.metadata || {};
      if (!metadata.topics) return false;
      
      const topics = metadata.topics.toLowerCase();
      return options.topicFilter!.some(topic => topics.includes(topic.toLowerCase()));
    });
  }
  
  // Sort by combined score
  return filtered.sort((a, b) => {
    // Combine metadata score with distance score
    const aScore = a.metadataScore - (a.distance * 100);
    const bScore = b.metadataScore - (b.distance * 100);
    return bScore - aScore;
  });
}