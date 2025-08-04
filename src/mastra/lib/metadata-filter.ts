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

// Check if query is asking for a specific section
export function detectSectionQuery(query: string): {
  isSection: boolean;
  sectionNumber?: string;
  sectionPattern?: RegExp;
} {
  // Patterns for section queries
  const patterns = [
    /section\s+(\d+\.?\d*)/i,
    /sec\s+(\d+\.?\d*)/i,
    /chapter\s+(\d+)\.(\d+)/i,
    /(\d+)\.(\d+)\s+section/i,
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
  
  // Topic relevance
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  if (metadata.topics) {
    const topics = metadata.topics.toLowerCase();
    queryWords.forEach(word => {
      if (topics.includes(word)) score += 5;
    });
  }
  
  // Title relevance
  if (metadata.sectionTitle) {
    const title = metadata.sectionTitle.toLowerCase();
    queryWords.forEach(word => {
      if (title.includes(word)) score += 10;
    });
  }
  
  // Summary relevance
  if (metadata.summary) {
    const summary = metadata.summary.toLowerCase();
    queryWords.forEach(word => {
      if (summary.includes(word)) score += 3;
    });
  }
  
  // Chunk type bonus
  if (metadata.chunkType) {
    if (query.includes('definition') && metadata.chunkType === 'definition') score += 15;
    if (query.includes('example') && metadata.chunkType === 'example') score += 15;
    if (query.includes('introduction') && metadata.chunkType === 'introduction') score += 10;
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
  
  // Section requirement
  if (options.requireSection || sectionInfo.isSection) {
    filtered = filtered.filter(r => {
      const metadata = r.metadata || {};
      
      // If looking for specific section
      if (sectionInfo.isSection && sectionInfo.sectionNumber) {
        return metadata.sectionNumber === sectionInfo.sectionNumber ||
               (metadata.content && metadata.content.includes(sectionInfo.sectionNumber));
      }
      
      // Just require any section
      return metadata.sectionNumber;
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