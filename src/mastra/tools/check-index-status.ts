import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { queryVectorsWithNewman } from '../lib/newman-executor.js';

export const checkIndexStatusTool = createTool({
  id: 'check-index-status',
  description: 'Check the status and content coverage of a specific S3 Vectors index',
  inputSchema: z.object({
    indexName: z.string().describe('The name of the index to check'),
  }),
  execute: async ({ context }) => {
    console.log(`[Check Index Status] Checking index: ${context.indexName}`);
    
    try {
      // Create a generic embedding to query all vectors
      const genericEmbedding = Array(1536).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5);
      
      // Query with high limit to see how many vectors are in the index
      const results = await queryVectorsWithNewman(context.indexName, genericEmbedding, 100);
      
      console.log(`[Check Index Status] Found ${results.length} vectors in index`);
      
      // Analyze the chunk distribution
      const chunkIndices = new Set<number>();
      const pageNumbers = new Set<number>();
      let maxChunkIndex = -1;
      let totalChunks = 0;
      
      results.forEach((result: any) => {
        if (result.metadata?.chunkIndex !== undefined) {
          chunkIndices.add(result.metadata.chunkIndex);
          maxChunkIndex = Math.max(maxChunkIndex, result.metadata.chunkIndex);
        }
        if (result.metadata?.pageStart) {
          pageNumbers.add(result.metadata.pageStart);
        }
        if (result.metadata?.pageEnd) {
          pageNumbers.add(result.metadata.pageEnd);
        }
        if (result.metadata?.totalChunks) {
          totalChunks = Math.max(totalChunks, result.metadata.totalChunks);
        }
      });
      
      // Check for gaps in chunk indices
      const missingChunks: number[] = [];
      if (totalChunks > 0) {
        for (let i = 0; i < totalChunks; i++) {
          if (!chunkIndices.has(i)) {
            missingChunks.push(i);
          }
        }
      }
      
      // Sort page numbers
      const sortedPages = Array.from(pageNumbers).sort((a, b) => a - b);
      const maxPage = sortedPages.length > 0 ? sortedPages[sortedPages.length - 1] : 0;
      
      // Look for the highest chunk index content
      const highestChunks = results
        .filter((r: any) => r.metadata?.chunkIndex !== undefined)
        .sort((a: any, b: any) => b.metadata.chunkIndex - a.metadata.chunkIndex)
        .slice(0, 3);
      
      return {
        success: true,
        indexName: context.indexName,
        vectorCount: results.length,
        uniqueChunks: chunkIndices.size,
        expectedChunks: totalChunks,
        maxChunkIndex: maxChunkIndex,
        missingChunks: missingChunks.length,
        missingChunkIndices: missingChunks.slice(0, 20), // First 20 missing
        pagesCovered: sortedPages,
        maxPage: maxPage,
        coveragePercentage: totalChunks > 0 ? ((chunkIndices.size / totalChunks) * 100).toFixed(2) + '%' : 'N/A',
        highestChunks: highestChunks.map((c: any) => ({
          chunkIndex: c.metadata?.chunkIndex,
          pageStart: c.metadata?.pageStart,
          pageEnd: c.metadata?.pageEnd,
          contentPreview: (c.metadata?.content || '').substring(0, 100) + '...'
        })),
        message: missingChunks.length > 0 
          ? `Index has ${missingChunks.length} missing chunks out of ${totalChunks} expected`
          : `Index appears complete with ${chunkIndices.size} chunks`
      };
      
    } catch (error) {
      console.error('[Check Index Status] Error:', error);
      return {
        success: false,
        message: 'Error checking index status',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
});