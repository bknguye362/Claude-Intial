import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';
import { ContextBuilder } from '../lib/context-builder.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Enhanced Context Query] No API key for embeddings, using mock embeddings...');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDINGS_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: 'text-embedding-ada-002'
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[Enhanced Context Query] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

export const enhancedContextQueryTool = createTool({
  id: 'enhanced-context-query',
  description: 'Query with enhanced contextual retrieval including adjacent chunks and better page references',
  inputSchema: z.object({
    question: z.string().describe('The user\'s question'),
    expandContext: z.boolean().default(true).describe('Whether to include adjacent chunks for better context'),
    maxResults: z.number().default(10).describe('Maximum number of primary results to return'),
  }),
  execute: async ({ context }) => {
    console.log('[Enhanced Context Query] ========= PROCESSING QUESTION =========');
    console.log(`[Enhanced Context Query] Question: "${context.question}"`);
    console.log(`[Enhanced Context Query] Expand context: ${context.expandContext}`);
    
    try {
      // Step 1: Generate embedding for the question
      console.log('[Enhanced Context Query] 1. Generating embedding...');
      const embedding = await generateEmbedding(context.question);
      console.log(`[Enhanced Context Query]    Embedding generated, length: ${embedding.length}`);
      
      // Step 2: List all indices
      console.log('\n[Enhanced Context Query] 2. Listing all indices...');
      let indices: string[] = [];
      
      try {
        indices = await listIndicesWithNewman();
        console.log(`[Enhanced Context Query]    Found ${indices.length} indices`);
      } catch (listError) {
        console.log(`[Enhanced Context Query] ⚠️  Listing failed, using default`);
        indices = ['queries'];
      }
      
      if (indices.length === 0) {
        indices = ['queries'];
      }
      
      // Step 3: Query each index
      console.log('\n[Enhanced Context Query] 3. Querying indices...');
      const allResults: any[] = [];
      
      // Query with more results to allow for context expansion
      const queryLimit = context.expandContext ? context.maxResults * 3 : context.maxResults;
      
      for (const indexName of indices) {
        try {
          const results = await queryVectorsWithNewman(indexName, embedding, queryLimit);
          
          if (results.length > 0) {
            const indexedResults = results.map((r: any) => ({
              ...r,
              index: indexName,
              // Ensure proper context structure
              context: {
                documentId: r.metadata?.documentId || r.metadata?.filename || indexName,
                pageStart: r.metadata?.pageStart,
                pageEnd: r.metadata?.pageEnd,
                chunkIndex: r.metadata?.chunkIndex,
                totalChunks: r.metadata?.totalChunks,
                timestamp: r.metadata?.timestamp,
                pageReference: r.metadata?.pageStart ? 
                  (r.metadata?.pageEnd && r.metadata.pageEnd !== r.metadata.pageStart ?
                    `pages ${r.metadata.pageStart}-${r.metadata.pageEnd}` :
                    `page ${r.metadata.pageStart}`) : undefined,
                citation: undefined // Will be set by ContextBuilder
              }
            }));
            allResults.push(...indexedResults);
          }
        } catch (error) {
          console.error(`[Enhanced Context Query] Error querying ${indexName}:`, error);
        }
      }
      
      // Step 4: Sort and get top results
      console.log('\n[Enhanced Context Query] 4. Processing results...');
      allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      const topResults = allResults.slice(0, context.maxResults);
      
      // Step 5: Build enhanced context
      let contextualResponse;
      
      if (context.expandContext && allResults.length > context.maxResults) {
        console.log('[Enhanced Context Query] Building expanded context with adjacent chunks...');
        contextualResponse = ContextBuilder.buildExpandedContext(topResults, allResults);
      } else {
        console.log('[Enhanced Context Query] Building standard contextual response...');
        const chunks = topResults.map(r => ({
          key: r.key,
          score: r.score,
          index: r.index,
          content: r.metadata?.content || r.metadata?.text || 'No content available',
          metadata: r.metadata,
          context: r.context
        }));
        contextualResponse = ContextBuilder.buildContextualResponse(chunks);
      }
      
      console.log(`[Enhanced Context Query] Found ${contextualResponse.chunks.length} chunks from ${contextualResponse.documentSummary.length} documents`);
      
      // Return enhanced results
      return {
        success: true,
        message: 'Enhanced contextual search completed',
        timestamp: new Date().toISOString(),
        question: context.question,
        chunks: contextualResponse.chunks,
        documentSummary: contextualResponse.documentSummary,
        contextString: contextualResponse.contextString,
        citations: contextualResponse.citations,
        totalChunks: contextualResponse.chunks.length,
        expandedContext: context.expandContext,
        debug: {
          indicesSearched: indices.length,
          totalResultsFound: allResults.length,
          topResultsUsed: topResults.length,
          documentsFound: contextualResponse.documentSummary.length
        }
      };
      
    } catch (error) {
      console.error('[Enhanced Context Query] ❌ Error:', error);
      return {
        success: false,
        message: 'Error processing enhanced context query',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
});