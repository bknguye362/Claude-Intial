import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { queryVectorsWithNewman } from '../lib/newman-executor.js';

export const getContextChunksTool = createTool({
  id: 'get-context-chunks',
  description: 'Get adjacent chunks using the linked list structure for better context',
  inputSchema: z.object({
    index: z.string().describe('The S3 Vectors index name'),
    chunkKeys: z.array(z.string()).describe('Array of chunk keys to get context for'),
    contextDepth: z.number().default(1).describe('How many chunks before/after to fetch (default: 1)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    totalChunks: z.number(),
    groups: z.number(),
    contextChunks: z.array(z.any()),
    chunkGroups: z.array(z.array(z.any())),
    message: z.string()
  }),
  execute: async ({ context }) => {
    const { index, chunkKeys, contextDepth = 1 } = context;
    console.log(`[Get Context Chunks] Fetching context for ${chunkKeys.length} chunks with depth ${contextDepth}`);
    
    const contextResults = new Map<string, any>();
    const fetchedKeys = new Set<string>();
    
    // Helper function to fetch chunks by keys
    async function fetchChunksByKeys(keys: string[]) {
      const validKeys = keys.filter(k => k && !fetchedKeys.has(k));
      if (validKeys.length === 0) return [];
      
      try {
        // Use a neutral vector to get all chunks, then filter by key
        const result = await queryVectorsWithNewman(
          index,
          Array(1536).fill(0.1),
          1000 // Get many results to find our specific keys
        );
        
        if (result && result.length > 0) {
          const foundChunks = result.filter((v: any) => validKeys.includes(v.key));
          foundChunks.forEach((chunk: any) => {
            fetchedKeys.add(chunk.key);
            contextResults.set(chunk.key, chunk);
          });
          return foundChunks;
        }
      } catch (error) {
        console.error(`[Get Context Chunks] Error fetching chunks:`, error);
      }
      return [];
    }
    
    // First, fetch all the main chunks
    await fetchChunksByKeys(chunkKeys);
    
    // Now, for each chunk, collect its linked chunks
    const linkedChunksToFetch = new Set<string>();
    
    for (const chunkKey of chunkKeys) {
      const mainChunk = contextResults.get(chunkKey);
      if (!mainChunk) continue;
      
      // Collect previous chunks
      let currentKey = mainChunk.metadata?.prevChunk;
      for (let i = 0; i < contextDepth && currentKey; i++) {
        linkedChunksToFetch.add(currentKey);
        // We'll need to fetch this chunk first to get its prevChunk
        const tempResult = contextResults.get(currentKey);
        if (tempResult) {
          currentKey = tempResult.metadata?.prevChunk;
        } else {
          break; // Will fetch in next batch
        }
      }
      
      // Collect next chunks
      currentKey = mainChunk.metadata?.nextChunk;
      for (let i = 0; i < contextDepth && currentKey; i++) {
        linkedChunksToFetch.add(currentKey);
        // We'll need to fetch this chunk first to get its nextChunk
        const tempResult = contextResults.get(currentKey);
        if (tempResult) {
          currentKey = tempResult.metadata?.nextChunk;
        } else {
          break; // Will fetch in next batch
        }
      }
    }
    
    // Fetch all linked chunks
    if (linkedChunksToFetch.size > 0) {
      await fetchChunksByKeys(Array.from(linkedChunksToFetch));
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