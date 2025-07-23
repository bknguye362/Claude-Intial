import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { queryVectorProcessorTool } from './query-vector-processor.js';
import { multiIndexSimilaritySearchTool } from './multi-index-similarity-search.js';
import { createOpenAI } from '../lib/azure-openai-direct.js';

const openai = createOpenAI();

export const ragQueryProcessorTool = createTool({
  id: 'rag-query-processor',
  description: 'Process user query end-to-end: convert to vector, store in S3, search similar chunks across indexes, and generate LLM response',
  inputSchema: z.object({
    query: z.string().describe('The user question to process'),
    userId: z.string().optional().describe('Optional user ID for tracking'),
    indexPatterns: z.array(z.string()).optional().describe('Patterns to filter indexes for search (e.g., ["file-*"]). Defaults to all non-query indexes.'),
    topK: z.number().default(10).describe('Number of similar chunks to retrieve per index'),
    globalTopK: z.number().default(10).describe('Total number of chunks to use for context'),
    systemPrompt: z.string().optional().describe('Optional system prompt for the LLM'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    response: z.string().optional().describe('The generated response from the LLM'),
    queryIndexName: z.string().optional().describe('The index where the query was stored'),
    relevantChunks: z.array(z.object({
      indexName: z.string(),
      content: z.string(),
      score: z.number(),
      metadata: z.record(z.any()),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[RAG Query Processor] Processing query: "${context.query}"`);
      
      // Step 1: Convert query to vector and store it
      console.log(`[RAG Query Processor] Step 1: Converting query to vector...`);
      const queryVectorResult = await queryVectorProcessorTool.execute({
        context: {
          query: context.query,
          userId: context.userId,
        }
      });
      
      if (!queryVectorResult.success || !queryVectorResult.embedding) {
        throw new Error(`Failed to process query vector: ${queryVectorResult.message}`);
      }
      
      console.log(`[RAG Query Processor] Query stored in index: ${queryVectorResult.indexName}`);
      
      // Step 2: Search for similar chunks across indexes
      console.log(`[RAG Query Processor] Step 2: Searching for similar chunks...`);
      const searchResult = await multiIndexSimilaritySearchTool.execute({
        context: {
          queryVector: queryVectorResult.embedding,
          indexPatterns: context.indexPatterns || ['file-*', 'document-*', 'pdf-*'],
          topK: context.topK,
          globalTopK: context.globalTopK,
        }
      });
      
      if (!searchResult.success) {
        throw new Error(`Failed to search indexes: ${searchResult.message}`);
      }
      
      console.log(`[RAG Query Processor] Found ${searchResult.results.length} relevant chunks from ${searchResult.searchedIndexes.length} indexes`);
      
      // Step 3: Prepare context from retrieved chunks
      const relevantChunks = searchResult.results.map(result => ({
        indexName: result.indexName,
        content: result.content || result.metadata.content || result.metadata.text || '',
        score: result.score,
        metadata: result.metadata,
      }));
      
      // Build context from chunks
      const contextChunks = relevantChunks
        .filter(chunk => chunk.content && chunk.content.length > 0)
        .map((chunk, index) => {
          const source = chunk.metadata.filename || chunk.indexName;
          const page = chunk.metadata.pageStart ? ` (pages ${chunk.metadata.pageStart}-${chunk.metadata.pageEnd || chunk.metadata.pageStart})` : '';
          return `[Source ${index + 1}: ${source}${page}]\n${chunk.content}`;
        })
        .join('\n\n---\n\n');
      
      if (!contextChunks) {
        return {
          success: false,
          queryIndexName: queryVectorResult.indexName,
          relevantChunks: relevantChunks,
          message: 'No relevant content found in the searched indexes',
        };
      }
      
      // Step 4: Generate response using LLM
      console.log(`[RAG Query Processor] Step 3: Generating response with LLM...`);
      
      const systemPrompt = context.systemPrompt || `You are a helpful assistant that answers questions based on the provided context. 
Always cite your sources using the [Source N] format when referencing information from the context.
If the context doesn't contain enough information to answer the question, say so clearly.`;
      
      const userPrompt = `Context from relevant documents:

${contextChunks}

---

User Question: ${context.query}

Please answer the question based on the context provided above. Cite your sources using [Source N] format.`;
      
      try {
        const completion = await openai('gpt-4.1-test').doGenerate({
          inputFormat: 'messages',
          mode: {
            type: 'regular',
          },
          prompt: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userPrompt,
            }
          ],
          temperature: 0.7,
          maxTokens: 2000,
        });
        
        const response = completion.text || 'Unable to generate response';
        
        console.log(`[RAG Query Processor] Successfully generated response`);
        
        return {
          success: true,
          response: response,
          queryIndexName: queryVectorResult.indexName,
          relevantChunks: relevantChunks,
          message: `Successfully processed query and generated response using ${relevantChunks.length} relevant chunks`,
        };
        
      } catch (llmError) {
        console.error('[RAG Query Processor] LLM Error:', llmError);
        
        // Return the chunks even if LLM fails
        return {
          success: false,
          queryIndexName: queryVectorResult.indexName,
          relevantChunks: relevantChunks,
          message: `Found ${relevantChunks.length} relevant chunks but failed to generate LLM response: ${llmError instanceof Error ? llmError.message : 'Unknown error'}`,
        };
      }
      
    } catch (error) {
      console.error('[RAG Query Processor] Error:', error);
      return {
        success: false,
        message: `Failed to process RAG query: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});