import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman } from '../lib/newman-executor.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Default Query Tool] No API key for embeddings, using mock embeddings...');
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
    console.error('[Default Query Tool] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

export const defaultQueryTool = createTool({
  id: 'default-query',
  description: 'Default tool for handling any user question - automatically vectorizes and stores questions',
  inputSchema: z.object({
    question: z.string().describe('The user\'s question'),
    context: z.string().optional().describe('Additional context for the question'),
  }),
  execute: async ({ context }) => {
    console.log('[Default Query Tool] ========= HANDLING QUESTION =========');
    console.log(`[Default Query Tool] Question: "${context.question}"`);
    console.log(`[Default Query Tool] Context: ${context.context || 'None'}`);
    
    try {
      // Generate embedding for the question
      console.log('[Default Query Tool] Generating embedding for question...');
      const embedding = await generateEmbedding(context.question);
      console.log(`[Default Query Tool] Generated embedding with length: ${embedding.length}`);
      
      const timestamp = Date.now();
      
      // Create vector with metadata
      const vectors = [{
        key: `question-default-tool-${timestamp}`,
        embedding: embedding,
        metadata: {
          question: context.question,
          context: context.context || '',
          timestamp: new Date().toISOString(),
          source: 'default-query-tool',
          type: 'user-question',
          automatic: true,
          tool: 'defaultQueryTool'
        }
      }];
      
      // Upload to queries index
      console.log('[Default Query Tool] Uploading question vector to "queries" index...');
      console.log('[Default Query Tool] Vector details:', {
        key: vectors[0].key,
        embeddingLength: embedding.length,
        metadataKeys: Object.keys(vectors[0].metadata)
      });
      
      const uploadedCount = await uploadVectorsWithNewman('queries', vectors);
      console.log(`[Default Query Tool] Upload result: ${uploadedCount} vectors uploaded`);
      
      if (uploadedCount > 0) {
        console.log('[Default Query Tool] Successfully vectorized and stored question');
        
        // Now search for similar vectors across relevant indexes
        console.log('[Default Query Tool] Searching for similar content across indexes...');
        
        try {
          // Search in file-* indexes for document chunks
          const searchIndexes = ['file-*', 'chatbot-embeddings'];
          const similarResults = [];
          
          for (const indexPattern of searchIndexes) {
            console.log(`[Default Query Tool] Searching in index pattern: ${indexPattern}`);
            
            try {
              const results = await queryVectorsWithNewman(indexPattern, embedding, 5);
              
              if (results && results.length > 0) {
                console.log(`[Default Query Tool] Found ${results.length} similar vectors in ${indexPattern}`);
                similarResults.push(...results.map(r => ({
                  ...r,
                  index: indexPattern
                })));
              }
            } catch (searchError) {
              console.log(`[Default Query Tool] No results or error searching ${indexPattern}:`, searchError);
            }
          }
          
          // Sort by similarity score (higher is better)
          similarResults.sort((a, b) => (b.score || 0) - (a.score || 0));
          
          // Take top 10 results
          const topResults = similarResults.slice(0, 10);
          
          console.log(`[Default Query Tool] Found ${topResults.length} relevant chunks total`);
          
          return {
            success: true,
            message: 'Question vectorized, stored, and similar content found',
            vectorKey: vectors[0].key,
            index: 'queries',
            timestamp: new Date().toISOString(),
            questionLength: context.question.length,
            embeddingDimension: embedding.length,
            similarChunks: topResults.map(r => ({
              key: r.key,
              score: r.score,
              index: r.index,
              metadata: r.metadata,
              content: r.metadata?.content || r.metadata?.text || 'No content available'
            })),
            totalSimilarChunks: topResults.length
          };
        } catch (searchError) {
          console.error('[Default Query Tool] Error searching for similar content:', searchError);
          
          // Still return success for vectorization even if search fails
          return {
            success: true,
            message: 'Question vectorized and stored successfully (search failed)',
            vectorKey: vectors[0].key,
            index: 'queries',
            timestamp: new Date().toISOString(),
            questionLength: context.question.length,
            embeddingDimension: embedding.length,
            searchError: searchError instanceof Error ? searchError.message : 'Unknown search error'
          };
        }
      } else {
        console.log('[Default Query Tool] Failed to upload vector');
        return {
          success: false,
          message: 'Failed to upload question vector',
          error: 'Upload returned 0 vectors'
        };
      }
      
    } catch (error) {
      console.error('[Default Query Tool] Error processing question:', error);
      return {
        success: false,
        message: 'Error processing question',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
});