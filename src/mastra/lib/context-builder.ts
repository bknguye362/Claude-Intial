import { ChunkContext, DocumentSummary } from './types.js';

export interface ContextualChunk {
  key: string;
  score: number;
  index: string;
  content: string;
  metadata?: any;
  context: ChunkContext;
}

export interface ContextualResponse {
  chunks: ContextualChunk[];
  documentSummary: DocumentSummary[];
  contextString: string;
  citations: string[];
}

export class ContextBuilder {
  /**
   * Build a contextual response from search results with proper citations
   */
  static buildContextualResponse(chunks: ContextualChunk[]): ContextualResponse {
    // Group chunks by document
    const chunksByDocument = new Map<string, ContextualChunk[]>();
    
    chunks.forEach(chunk => {
      const docId = chunk.context.documentId;
      if (!chunksByDocument.has(docId)) {
        chunksByDocument.set(docId, []);
      }
      chunksByDocument.get(docId)!.push(chunk);
    });
    
    // Build document summaries
    const documentSummary: DocumentSummary[] = Array.from(chunksByDocument.entries()).map(([docId, docChunks]) => {
      const pages = new Set<number>();
      const chunkIndices: number[] = [];
      
      docChunks.forEach(chunk => {
        if (chunk.context.pageStart) pages.add(chunk.context.pageStart);
        if (chunk.context.pageEnd) pages.add(chunk.context.pageEnd);
        if (typeof chunk.context.chunkIndex === 'number') {
          chunkIndices.push(chunk.context.chunkIndex);
        }
      });
      
      const sortedPages = Array.from(pages).sort((a, b) => a - b);
      const pageRanges = this.formatPageRanges(sortedPages);
      
      return {
        documentId: docId,
        relevantChunks: docChunks.length,
        relevantPages: sortedPages,
        pageRanges,
        chunkIndices: chunkIndices.sort((a, b) => a - b),
        averageScore: docChunks.reduce((sum, c) => sum + (c.score || 0), 0) / docChunks.length
      };
    });
    
    // Sort document summaries by average score
    documentSummary.sort((a, b) => b.averageScore - a.averageScore);
    
    // Build context string with proper formatting
    const contextParts: string[] = [];
    const citations: string[] = [];
    
    // Add chunks grouped by document
    documentSummary.forEach(docSummary => {
      const docChunks = chunksByDocument.get(docSummary.documentId)!;
      
      contextParts.push(`\n### From ${docSummary.documentId} (${docSummary.pageRanges}):\n`);
      
      // Sort chunks by page number and chunk index
      docChunks.sort((a, b) => {
        const pageA = a.context.pageStart || 0;
        const pageB = b.context.pageStart || 0;
        if (pageA !== pageB) return pageA - pageB;
        
        const indexA = a.context.chunkIndex || 0;
        const indexB = b.context.chunkIndex || 0;
        return indexA - indexB;
      });
      
      docChunks.forEach(chunk => {
        if (chunk.context.citation) {
          citations.push(chunk.context.citation);
        }
        
        const pageInfo = chunk.context.pageReference ? ` [${chunk.context.pageReference}]` : '';
        contextParts.push(`${chunk.content}${pageInfo}\n`);
      });
    });
    
    return {
      chunks,
      documentSummary,
      contextString: contextParts.join('\n'),
      citations: [...new Set(citations)] // Remove duplicates
    };
  }
  
  /**
   * Format page numbers into ranges (e.g., [1, 2, 3, 5, 6] -> "1-3, 5-6")
   */
  private static formatPageRanges(pages: number[]): string {
    if (pages.length === 0) return '';
    if (pages.length === 1) return `page ${pages[0]}`;
    
    const ranges: string[] = [];
    let start = pages[0];
    let end = pages[0];
    
    for (let i = 1; i <= pages.length; i++) {
      if (i === pages.length || pages[i] !== end + 1) {
        // End of a range
        if (start === end) {
          ranges.push(`${start}`);
        } else if (end === start + 1) {
          ranges.push(`${start}, ${end}`);
        } else {
          ranges.push(`${start}-${end}`);
        }
        
        if (i < pages.length) {
          start = pages[i];
          end = pages[i];
        }
      } else {
        end = pages[i];
      }
    }
    
    return ranges.length === 1 ? `page ${ranges[0]}` : `pages ${ranges.join(', ')}`;
  }
  
  /**
   * Build a response with adjacent chunks for better context
   */
  static buildExpandedContext(
    primaryChunks: ContextualChunk[], 
    allChunks: ContextualChunk[]
  ): ContextualResponse {
    const expandedChunks = new Set<string>();
    const chunksToInclude: ContextualChunk[] = [];
    
    primaryChunks.forEach(chunk => {
      // Include the primary chunk
      if (!expandedChunks.has(chunk.key)) {
        expandedChunks.add(chunk.key);
        chunksToInclude.push(chunk);
      }
      
      // Try to find adjacent chunks
      if (typeof chunk.context.chunkIndex === 'number' && chunk.context.documentId) {
        const adjacentIndices = [
          chunk.context.chunkIndex - 1,
          chunk.context.chunkIndex + 1
        ];
        
        adjacentIndices.forEach(adjIndex => {
          const adjacent = allChunks.find(c => 
            c.context.documentId === chunk.context.documentId &&
            c.context.chunkIndex === adjIndex
          );
          
          if (adjacent && !expandedChunks.has(adjacent.key)) {
            expandedChunks.add(adjacent.key);
            chunksToInclude.push({
              ...adjacent,
              score: adjacent.score * 0.8 // Lower score for adjacent chunks
            });
          }
        });
      }
    });
    
    // Sort by document and chunk index
    chunksToInclude.sort((a, b) => {
      if (a.context.documentId !== b.context.documentId) {
        return a.context.documentId.localeCompare(b.context.documentId);
      }
      const indexA = a.context.chunkIndex || 0;
      const indexB = b.context.chunkIndex || 0;
      return indexA - indexB;
    });
    
    return this.buildContextualResponse(chunksToInclude);
  }
}