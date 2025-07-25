import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';

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
        console.log('[Default Query Tool] ========= STARTING SIMILARITY SEARCH =========');
        console.log('[Default Query Tool] Searching for similar content across indexes...');
        
        try {
          // First, list all available indices using Newman
          console.log('[Default Query Tool] Listing all indices using Newman...');
          const indicesToSearch = await listIndicesWithNewman();
          
          if (!indicesToSearch || indicesToSearch.length === 0) {
            console.log('[Default Query Tool] No indices found or failed to list indices');
            throw new Error('Failed to list indices');
          }
          
          console.log(`[Default Query Tool] Found ${indicesToSearch.length} total indices:`, indicesToSearch);
          console.log(`[Default Query Tool] Will search ALL ${indicesToSearch.length} indices`);
          
          const similarResults = [];
          
          // Search each index
          for (const indexName of indicesToSearch) {
            console.log(`[Default Query Tool] 🔍 SEARCHING in index: ${indexName}`);
            console.log(`[Default Query Tool] Using embedding with length: ${embedding.length}`);
            
            try {
              console.log(`[Default Query Tool] Calling queryVectorsWithNewman for ${indexName}...`);
              
              const queryResults = await queryVectorsWithNewman(indexName, embedding, 5);
              
              if (queryResults && queryResults.length > 0) {
                console.log(`[Default Query Tool] ✅ Found ${queryResults.length} similar vectors in ${indexName}`);
                console.log(`[Default Query Tool] First result preview:`, {
                  key: queryResults[0].key,
                  score: queryResults[0].score,
                  hasMetadata: !!queryResults[0].metadata,
                  contentPreview: queryResults[0].metadata?.content?.substring(0, 100) || 'No content'
                });
                
                similarResults.push(...queryResults.map((r: any) => ({
                  key: r.key,
                  score: r.score,
                  metadata: r.metadata || {},
                  index: indexName
                })));
              } else {
                console.log(`[Default Query Tool] ❌ No results found in ${indexName}`);
              }
            } catch (searchError) {
              console.log(`[Default Query Tool] ⚠️ Error searching ${indexName}:`, searchError);
            }
          }
          
          // Sort by similarity score (higher is better)
          similarResults.sort((a, b) => (b.score || 0) - (a.score || 0));
          
          // Take top 10 results
          const topResults = similarResults.slice(0, 10);
          
          console.log(`[Default Query Tool] 📊 FINAL RESULTS: Found ${topResults.length} relevant chunks total`);
          
          // Log summary of results
          if (topResults.length > 0) {
            console.log('[Default Query Tool] Top 3 results summary:');
            topResults.slice(0, 3).forEach((r, i) => {
              console.log(`[Default Query Tool] ${i + 1}. Score: ${r.score}, Index: ${r.index}, Content preview: ${(r.metadata?.content || '').substring(0, 50)}...`);
            });
          }
          
          const result = {
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
          
          console.log('[Default Query Tool] 🎯 RETURNING RESULT WITH CHUNKS TO AGENT');
          console.log(`[Default Query Tool] Result contains ${result.similarChunks.length} chunks for the LLM to use`);
          
          return result;
        } catch (searchError) {
          console.error('[Default Query Tool] Error searching for similar content:', searchError);
          console.error('[Default Query Tool] Search error details:', {
            errorMessage: searchError instanceof Error ? searchError.message : 'Unknown error',
            errorStack: searchError instanceof Error ? searchError.stack : 'No stack trace',
            errorType: searchError?.constructor?.name
          });
          
          // Still return success for vectorization even if search fails
          return {
            success: true,
            message: 'Question vectorized and stored successfully (search failed)',
            vectorKey: vectors[0].key,
            index: 'queries',
            timestamp: new Date().toISOString(),
            questionLength: context.question.length,
            embeddingDimension: embedding.length,
            searchError: searchError instanceof Error ? searchError.message : 'Unknown search error',
            searchErrorDetails: searchError instanceof Error ? searchError.stack : 'No details available'
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