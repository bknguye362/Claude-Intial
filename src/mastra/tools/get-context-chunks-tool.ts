import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getVectorByKeyWithNewman } from '../lib/newman-executor.js';

export const getContextChunksTool = createTool({
  id: 'get-context-chunks',
  description: 'Get adjacent chunks using the linked list structure for better context',
  parameters: z.object({
    index: z.string().describe('The S3 Vectors index name'),
    chunkKeys: z.array(z.string()).describe('Array of chunk keys to get context for'),
    contextDepth: z.number().default(1).describe('How many chunks before/after to fetch (default: 1)'),
  }),
  execute: async ({ index, chunkKeys, contextDepth = 1 }) => {
    console.log(`[Get Context Chunks] Fetching context for ${chunkKeys.length} chunks with depth ${contextDepth}`);
    
    const contextResults = new Map<string, any>();
    const fetchedKeys = new Set<string>();
    
    // Helper function to fetch a chunk
    async function fetchChunk(key: string) {
      if (fetchedKeys.has(key) || !key) return null;
      
      try {
        const result = await getVectorByKeyWithNewman({
          index,
          key
        });
        
        if (result.success && result.vector) {
          fetchedKeys.add(key);
          contextResults.set(key, result.vector);
          return result.vector;
        }
      } catch (error) {
        console.error(`[Get Context Chunks] Error fetching ${key}:`, error);
      }
      return null;
    }
    
    // For each chunk, fetch its context
    for (const chunkKey of chunkKeys) {
      // First fetch the main chunk if we don't have it
      const mainChunk = await fetchChunk(chunkKey);
      if (!mainChunk) continue;
      
      // Track chunks to fetch for context
      const toFetch: string[] = [];
      
      // Get previous chunks
      let currentKey = mainChunk.metadata?.prevChunk;
      for (let i = 0; i < contextDepth && currentKey; i++) {
        toFetch.push(currentKey);
        const chunk = await fetchChunk(currentKey);
        currentKey = chunk?.metadata?.prevChunk;
      }
      
      // Get next chunks
      currentKey = mainChunk.metadata?.nextChunk;
      for (let i = 0; i < contextDepth && currentKey; i++) {
        toFetch.push(currentKey);
        const chunk = await fetchChunk(currentKey);
        currentKey = chunk?.metadata?.nextChunk;
      }
    }
    
    // Sort results by document and chunk index
    const sortedResults = Array.from(contextResults.values()).sort((a, b) => {
      const aDoc = a.metadata?.documentId || '';
      const bDoc = b.metadata?.documentId || '';
      if (aDoc !== bDoc) return aDoc.localeCompare(bDoc);
      
      const aIndex = a.metadata?.chunkIndex || 0;
      const bIndex = b.metadata?.chunkIndex || 0;
      return aIndex - bIndex;
    });
    
    // Group continuous chunks
    const groups: any[][] = [];
    let currentGroup: any[] = [];
    let lastDoc = '';
    let lastIndex = -1;
    
    for (const chunk of sortedResults) {
      const doc = chunk.metadata?.documentId || '';
      const index = chunk.metadata?.chunkIndex || 0;
      
      if (currentGroup.length === 0 || (doc === lastDoc && index === lastIndex + 1)) {
        currentGroup.push(chunk);
      } else {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [chunk];
      }
      
      lastDoc = doc;
      lastIndex = index;
    }
    
    if (currentGroup.length > 0) groups.push(currentGroup);
    
    return {
      success: true,
      totalChunks: sortedResults.length,
      groups: groups.length,
      contextChunks: sortedResults,
      chunkGroups: groups,
      message: `Retrieved ${sortedResults.length} chunks in ${groups.length} continuous groups`
    };
  }
});

export default getContextChunksTool;