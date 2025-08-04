import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';
import { ContextBuilder } from '../lib/context-builder.js';
import { hybridSearch } from '../lib/hybrid-search.js';
import { detectSectionQuery, filterByMetadata } from '../lib/metadata-filter.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings - identical to test file
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
    
    console.log('[Default Query Tool] Environment check:');
    console.log('[Default Query Tool] - AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `Set (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : 'NOT SET');
    console.log('[Default Query Tool] - AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'NOT SET');
    console.log('[Default Query Tool] - AZURE_OPENAI_API_KEY:', AZURE_OPENAI_API_KEY ? 'Set' : 'NOT SET');
    console.log('[Default Query Tool] - S3_VECTORS_BUCKET:', process.env.S3_VECTORS_BUCKET || 'chatbotvectors362');
    console.log('[Default Query Tool] - S3_VECTORS_REGION:', process.env.S3_VECTORS_REGION || 'us-east-2');
    
    try {
      // Check if this is a section-specific query
      const sectionPattern = /section\s+(\d+\.?\d*)/i;
      const sectionMatch = context.question.match(sectionPattern);
      let enhancedQuery = context.question;
      
      if (sectionMatch) {
        const sectionNumber = sectionMatch[1];
        console.log(`[Default Query Tool] 🔍 Detected section query for: ${sectionNumber}`);
        // Enhance query to include section number explicitly
        enhancedQuery = `Section ${sectionNumber} ${context.question}`;
      }
      
      // Step 1: Generate embedding for the question
      console.log('[Default Query Tool] 1. Generating embedding for question...');
      const embedding = await generateEmbedding(enhancedQuery);
      console.log(`[Default Query Tool]    Embedding generated, length: ${embedding.length}`);
      console.log(`[Default Query Tool]    Generated embedding first 5: [${embedding.slice(0, 5).map(v => v.toFixed(6)).join(', ')}...]`);
      
      // Step 2: Skip uploading - we'll query directly with the embedding
      console.log('[Default Query Tool] 2. Skipping vector storage - will query directly');
      console.log('[Default Query Tool] ✅ Question vectorized, ready to search');
      
      // Step 3: List all indices (exactly like the test file)
      console.log('\n[Default Query Tool] 3. Listing all indices...');
      let indices: string[] = [];
      const listingErrors: string[] = [];
      
      try {
        indices = await listIndicesWithNewman();
        console.log(`[Default Query Tool]    Found ${indices.length} indices:`);
        indices.forEach((idx, i) => {
          console.log(`[Default Query Tool]      ${i + 1}. ${idx}`);
        });
      } catch (listError) {
        const errorMsg = listError instanceof Error ? listError.message : 'Unknown error';
        console.log(`[Default Query Tool] ⚠️  Listing failed: ${errorMsg}`);
        listingErrors.push(errorMsg);
        indices = ['queries']; // Fallback to just queries
      }
      
      if (indices.length === 0) {
        console.log('[Default Query Tool] ⚠️  No indices found! Defaulting to queries index only.');
        indices = ['queries'];
        listingErrors.push('No indices returned from listing');
      }
      
      // Step 4: Query each index for similar content (exactly like the test file)
      console.log('\n[Default Query Tool] 4. Querying each index for similar content...');
      const allResults: any[] = [];
      
      for (const indexName of indices) {
        console.log(`[Default Query Tool] --- Querying index: ${indexName} ---`);
        
        try {
          console.log(`[Default Query Tool]     Calling queryVectorsWithNewman with embedding first 5: [${embedding.slice(0, 5).map(v => v.toFixed(6)).join(', ')}...]`);
          const results = await queryVectorsWithNewman(indexName, embedding, 10);
          console.log(`[Default Query Tool]     Found ${results.length} results`);
          
          if (results.length > 0) {
            // S3 Vectors returns results already sorted by similarity
            // Assign pseudo-scores based on rank to help with cross-index sorting
            const indexedResults = results.map((r: any, idx: number) => ({
              ...r,
              index: indexName,
              score: 1.0 - (idx * 0.1) // First result gets 1.0, second 0.9, etc.
            }));
            
            allResults.push(...indexedResults);
            
            // Show first result preview with distance
            const firstResult = indexedResults[0];
            console.log(`[Default Query Tool]     Top result: ${firstResult.key || 'unknown'}`);
            console.log(`[Default Query Tool]     Distance: ${firstResult.distance !== undefined ? firstResult.distance : 'not provided'}`);
            console.log(`[Default Query Tool]     Content preview: ${(firstResult.metadata?.content || '').substring(0, 150)}...`);
          }
        } catch (searchError) {
          const errorMsg = searchError instanceof Error ? searchError.message : 'Unknown error';
          console.error(`[Default Query Tool]     Error querying ${indexName}: ${errorMsg}`);
        }
      }
      
      // Step 5: Use improved search methods
      console.log('\n[Default Query Tool] 5. IMPROVED SEARCH WITH HYBRID APPROACH:');
      console.log('[Default Query Tool] =====================================');
      
      // Detect if this is a section query
      const sectionInfo = detectSectionQuery(context.question);
      if (sectionInfo.isSection) {
        console.log(`[Default Query Tool] 🔍 Section query detected: ${sectionInfo.sectionNumber}`);
      }
      
      // Use hybrid search instead of simple distance filtering
      console.log('[Default Query Tool] 🎯 Using hybrid search (vector + keyword matching)...');
      const hybridResults = await hybridSearch(
        context.question,
        embedding,
        indices,
        {
          maxDistance: 0.4,  // Even more lenient for keyword-heavy searches
          topK: 30,          // Get more initial results for better keyword matching
          weightVector: sectionInfo.isSection ? 0.3 : 0.6,  // Weight keywords even more for section queries
          minKeywordScore: 0  // Don't require minimum keyword score
        }
      );
      
      // Apply metadata filtering
      console.log('[Default Query Tool] 📊 Applying metadata filtering...');
      const filteredResults = filterByMetadata(
        hybridResults,
        context.question,
        {
          requireSection: false  // Don't strictly require section metadata
        }
      );
      
      // Remove blank content
      const validResults = filteredResults.filter(result => {
        const content = result.metadata?.content || '';
        if (!content || content.trim().length < 10) {
          console.log(`[Default Query Tool] ⚠️ Excluding blank/short chunk: ${result.key}`);
          return false;
        }
        return true;
      });
      
      console.log(`[Default Query Tool] 📊 Found ${validResults.length} valid results after hybrid search and filtering`);
      
      // LIMIT TO TOP 10 RESULTS
      const top10 = validResults.slice(0, 10);
      console.log(`[Default Query Tool] Limited to top ${top10.length} results`);
      
      if (top10.length > 0) {
        console.log(`[Default Query Tool] 📊 Selected ${top10.length} results after improved filtering`);
        console.log(`[Default Query Tool] Distance range: ${top10[0].distance?.toFixed(4)} to ${top10[top10.length-1].distance?.toFixed(4)}`);
      } else {
        console.log(`[Default Query Tool] ⚠️ No results found after improved filtering`);
        
        // Return early with no chunks
        const result = {
          success: true,
          message: 'No similar content found',
          timestamp: new Date().toISOString(),
          questionLength: context.question.length,
          embeddingDimension: embedding.length,
          similarChunks: [],
          totalSimilarChunks: 0,
          documentContext: {
            documentsFound: 0,
            summary: []
          },
          contextString: '',
          citations: [],
          debug: {
            indicesSearched: indices.join(','),
            totalResultsFound: allResults.length,
            resultsWithDistance: validResults.length
          }
        };
        
        console.log('[Default Query Tool] 🎯 RETURNING EMPTY RESULT - No results with distance < 0.2');
        return result;
      }
      
      // Show which indices contributed results
      const indexContributions = new Map<string, number>();
      top10.forEach(r => {
        indexContributions.set(r.index, (indexContributions.get(r.index) || 0) + 1);
      });
      console.log(`[Default Query Tool] Results by index:`, Object.fromEntries(indexContributions));
      
      // Group results by document for better contextualization
      const resultsByDocument = new Map<string, any[]>();
      
      top10.forEach((result, i) => {
        const docId = result.metadata?.documentId || result.metadata?.filename || result.index;
        if (!resultsByDocument.has(docId)) {
          resultsByDocument.set(docId, []);
        }
        resultsByDocument.get(docId)!.push(result);
        
        console.log(`[Default Query Tool] ${i + 1}. [${result.index}]`);
        console.log(`[Default Query Tool]    Key: ${result.key}`);
        console.log(`[Default Query Tool]    Distance: ${result.distance !== undefined ? result.distance.toFixed(4) : 'not provided'}`);
        if (result.metadata?.pageStart) {
          console.log(`[Default Query Tool]    Pages: ${result.metadata.pageStart}-${result.metadata.pageEnd || result.metadata.pageStart}`);
          console.log(`[Default Query Tool]    Chunk: ${result.metadata.chunkIndex + 1}/${result.metadata.totalChunks || '?'}`);
        }
        // Debug content issues
        const contentPreview = result.metadata?.content || result.metadata?.text || 'No content available';
        if (contentPreview.trim().length < 10) {
          console.log(`[Default Query Tool]    ⚠️ BLANK/SHORT CONTENT DETECTED!`);
          console.log(`[Default Query Tool]    Raw metadata:`, JSON.stringify(result.metadata).substring(0, 200));
        }
        console.log(`[Default Query Tool]    Content: ${contentPreview.substring(0, 200)}...`);
      });
      
      console.log(`[Default Query Tool] Total results found across all indices: ${allResults.length}`);
      console.log(`[Default Query Tool] Results from ${resultsByDocument.size} different documents`);
      
      // Build contextualized chunks for ContextBuilder
      const contextualizedChunks = top10.map(r => ({
        key: r.key,
        score: r.score,
        distance: r.distance,
        index: r.index,
        content: r.metadata?.content || r.metadata?.text || 'No content available',
        metadata: r.metadata,
        context: {
          documentId: r.metadata?.documentId || r.metadata?.filename || r.index,
          pageStart: r.metadata?.pageStart,
          pageEnd: r.metadata?.pageEnd,
          chunkIndex: r.metadata?.chunkIndex,
          totalChunks: r.metadata?.totalChunks,
          timestamp: r.metadata?.timestamp
        },
        contextBefore: null as string | null,
        contextAfter: null as string | null,
        linkedChunks: null as { prev: string | null, next: string | null } | null
      }));
      
      // Check if chunks have linked list structure
      const hasLinkedStructure = top10.some(r => 
        r.metadata?.prevChunk || r.metadata?.nextChunk
      );
      
      if (hasLinkedStructure) {
        console.log('[Default Query Tool] 🔗 Chunks have linked list structure for context expansion');
        
        // Add context hints to each chunk
        contextualizedChunks.forEach(chunk => {
          if (chunk.metadata?.prevContext) {
            chunk.contextBefore = chunk.metadata.prevContext;
          }
          if (chunk.metadata?.nextContext) {
            chunk.contextAfter = chunk.metadata.nextContext;
          }
          // Add linked chunk references
          if (chunk.metadata?.prevChunk || chunk.metadata?.nextChunk) {
            chunk.linkedChunks = {
              prev: chunk.metadata.prevChunk,
              next: chunk.metadata.nextChunk
            };
          }
        });
      }
      
      // Use ContextBuilder to create enhanced response
      const contextualResponse = ContextBuilder.buildContextualResponse(contextualizedChunks);
      
      // Return the enhanced results with ContextBuilder output
      const result = {
        success: true,
        message: 'Question vectorized and similar content found with enhanced context',
        timestamp: new Date().toISOString(),
        questionLength: context.question.length,
        embeddingDimension: embedding.length,
        similarChunks: contextualResponse.chunks,
        totalSimilarChunks: contextualResponse.chunks.length,
        // Document-level context summary from ContextBuilder
        documentContext: {
          documentsFound: contextualResponse.documentSummary.length,
          summary: contextualResponse.documentSummary
        },
        // Additional context from ContextBuilder
        contextString: contextualResponse.contextString,
        citations: contextualResponse.citations,
        // Debug information
        debug: {
          indicesSearched: indices.join(','),
          totalIndicesSearched: indices.length,
          totalResultsBeforeFilter: allResults.length,
          resultsWithDistance: validResults.length,
          top10Count: top10.length,
          listingMethod: indices.length > 1 ? 'listIndicesWithNewman' : 'fallback',
          awsKeySet: !!process.env.AWS_ACCESS_KEY_ID,
          bucketName: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362',
          listingErrors: listingErrors
        }
      };
      
      console.log('[Default Query Tool] 🎯 RETURNING RESULT WITH CHUNKS TO AGENT');
      console.log(`[Default Query Tool] Result contains ${result.similarChunks.length} chunks for the LLM to use`);
      
      // Show exactly what chunks are being sent to the LLM
      console.log('\n[Default Query Tool] 📚 CHUNKS BEING SENT TO LLM:');
      console.log('[Default Query Tool] =====================================');
      result.similarChunks.forEach((chunk, idx) => {
        console.log(`\n[Default Query Tool] CHUNK ${idx + 1}/${result.similarChunks.length}:`);
        console.log(`[Default Query Tool] - From index: ${chunk.metadata?.indexName || 'unknown'}`);
        console.log(`[Default Query Tool] - Distance: ${chunk.distance !== undefined ? chunk.distance.toFixed(4) : 'not provided'}`);
        console.log(`[Default Query Tool] - Document: ${chunk.metadata?.documentId || chunk.metadata?.filename || 'unknown'}`);
        if (chunk.metadata?.pageStart) {
          console.log(`[Default Query Tool] - Pages: ${chunk.metadata.pageStart}-${chunk.metadata.pageEnd || chunk.metadata.pageStart}`);
        }
        console.log(`[Default Query Tool] - Content length: ${chunk.content.length} chars`);
        console.log(`[Default Query Tool] - Content preview: "${chunk.content.substring(0, 200)}..."`);
      });
      console.log('\n[Default Query Tool] =====================================');
      
      // Calculate total content size being sent to LLM
      const totalChars = result.similarChunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
      const avgCharsPerChunk = totalChars / result.similarChunks.length;
      console.log(`[Default Query Tool] 📊 TOTAL CONTEXT SIZE: ${totalChars} characters across ${result.similarChunks.length} chunks`);
      console.log(`[Default Query Tool] 📊 AVERAGE CHUNK SIZE: ${Math.round(avgCharsPerChunk)} characters`);
      console.log('[Default Query Tool] =====================================\n');
      
      return result;
      
    } catch (error) {
      console.error('[Default Query Tool] ❌ Error:', error instanceof Error ? error.message : 'Unknown error');
      console.error('[Default Query Tool] Stack:', error instanceof Error ? error.stack : 'No stack trace');
      return {
        success: false,
        message: 'Error processing question',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
});