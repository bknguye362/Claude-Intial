// Context expansion to include neighboring chunks for better results

interface ChunkWithContext {
  mainChunk: any;
  previousChunk?: any;
  nextChunk?: any;
  expandedContent: string;
}

// Get neighboring chunks based on chunk index
export async function expandContext(
  results: any[],
  allChunksMap: Map<string, any[]>
): Promise<ChunkWithContext[]> {
  const expandedResults: ChunkWithContext[] = [];
  
  for (const result of results) {
    const metadata = result.metadata || {};
    const documentId = metadata.documentId;
    const chunkIndex = metadata.chunkIndex;
    
    if (!documentId || chunkIndex === undefined) {
      // No context available
      expandedResults.push({
        mainChunk: result,
        expandedContent: metadata.content || ''
      });
      continue;
    }
    
    // Get all chunks for this document
    const documentChunks = allChunksMap.get(documentId) || [];
    
    // Find neighboring chunks
    const previousChunk = chunkIndex > 0 ? documentChunks[chunkIndex - 1] : undefined;
    const nextChunk = chunkIndex < documentChunks.length - 1 ? documentChunks[chunkIndex + 1] : undefined;
    
    // Build expanded content
    let expandedContent = '';
    
    // Add previous context if from same section
    if (previousChunk && previousChunk.metadata?.sectionNumber === metadata.sectionNumber) {
      expandedContent += '[Previous context...]\n';
      expandedContent += (previousChunk.metadata?.content || '').slice(-200) + '\n\n';
    }
    
    // Main content
    expandedContent += metadata.content || '';
    
    // Add next context if from same section
    if (nextChunk && nextChunk.metadata?.sectionNumber === metadata.sectionNumber) {
      expandedContent += '\n\n[Continuing...]\n';
      expandedContent += (nextChunk.metadata?.content || '').slice(0, 200);
    }
    
    expandedResults.push({
      mainChunk: result,
      previousChunk,
      nextChunk,
      expandedContent
    });
  }
  
  return expandedResults;
}

// Build a map of all chunks by document for context expansion
export async function buildChunkMap(indices: string[]): Promise<Map<string, any[]>> {
  const chunkMap = new Map<string, any[]>();
  
  // This would need to query all chunks from each index
  // For now, returning empty map - would need to implement full index scanning
  
  return chunkMap;
}