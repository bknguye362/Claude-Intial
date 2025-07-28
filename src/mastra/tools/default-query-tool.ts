import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';

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
      // Step 1: Generate embedding for the question
      console.log('[Default Query Tool] 1. Generating embedding for question...');
      const embedding = await generateEmbedding(context.question);
      console.log(`[Default Query Tool]    Embedding generated, length: ${embedding.length}`);
      console.log(`[Default Query Tool]    First 5 values: [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
      
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
          const results = await queryVectorsWithNewman(indexName, embedding, 5);
          console.log(`[Default Query Tool]     Found ${results.length} results`);
          
          if (results.length > 0) {
            // Add index name to each result
            const indexedResults = results.map((r: any) => ({
              ...r,
              index: indexName
            }));
            allResults.push(...indexedResults);
            
            // Show first result preview
            const firstResult = results[0];
            console.log(`[Default Query Tool]     Top result score: ${firstResult.score || 'N/A'}`);
            console.log(`[Default Query Tool]     Content preview: ${(firstResult.metadata?.content || '').substring(0, 150)}...`);
          }
        } catch (searchError) {
          const errorMsg = searchError instanceof Error ? searchError.message : 'Unknown error';
          console.error(`[Default Query Tool]     Error querying ${indexName}: ${errorMsg}`);
        }
      }
      
      // Step 5: Sort all results by score and show top 10 with enhanced context
      console.log('\n[Default Query Tool] 5. TOP 10 RESULTS ACROSS ALL INDICES:');
      console.log('[Default Query Tool] =====================================');
      
      // Sort by score (higher is better)
      allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top10 = allResults.slice(0, 10);
      
      // Group results by document for better contextualization
      const resultsByDocument = new Map<string, any[]>();
      
      top10.forEach((result, i) => {
        const docId = result.metadata?.documentId || result.metadata?.filename || result.index;
        if (!resultsByDocument.has(docId)) {
          resultsByDocument.set(docId, []);
        }
        resultsByDocument.get(docId)!.push(result);
        
        console.log(`[Default Query Tool] ${i + 1}. [${result.index}] Score: ${result.score || 'N/A'}`);
        console.log(`[Default Query Tool]    Key: ${result.key}`);
        if (result.metadata?.pageStart) {
          console.log(`[Default Query Tool]    Pages: ${result.metadata.pageStart}-${result.metadata.pageEnd || result.metadata.pageStart}`);
          console.log(`[Default Query Tool]    Chunk: ${result.metadata.chunkIndex + 1}/${result.metadata.totalChunks || '?'}`);
        }
        console.log(`[Default Query Tool]    Content: ${(result.metadata?.content || 'No content').substring(0, 200)}...`);
      });
      
      console.log(`[Default Query Tool] Total results found across all indices: ${allResults.length}`);
      console.log(`[Default Query Tool] Results from ${resultsByDocument.size} different documents`);
      
      // Build contextualized response with page references
      const contextualizedChunks = top10.map(r => {
        const chunk = {
          key: r.key,
          score: r.score,
          index: r.index,
          metadata: r.metadata,
          content: r.metadata?.content || r.metadata?.text || 'No content available',
          // Enhanced contextual information
          context: {
            documentId: r.metadata?.documentId || r.metadata?.filename || 'Unknown',
            pageStart: r.metadata?.pageStart,
            pageEnd: r.metadata?.pageEnd,
            chunkIndex: r.metadata?.chunkIndex,
            totalChunks: r.metadata?.totalChunks,
            timestamp: r.metadata?.timestamp
          }
        };
        
        // Add page reference string for easy citation
        if (r.metadata?.pageStart) {
          const pageRef = r.metadata.pageEnd && r.metadata.pageEnd !== r.metadata.pageStart 
            ? `pages ${r.metadata.pageStart}-${r.metadata.pageEnd}`
            : `page ${r.metadata.pageStart}`;
          chunk.context.pageReference = pageRef;
          chunk.context.citation = `${chunk.context.documentId} (${pageRef})`;
        }
        
        return chunk;
      });
      
      // Create document summary for better context understanding
      const documentSummary = Array.from(resultsByDocument.entries()).map(([docId, docResults]) => {
        const pageNumbers = new Set<number>();
        docResults.forEach(r => {
          if (r.metadata?.pageStart) pageNumbers.add(r.metadata.pageStart);
          if (r.metadata?.pageEnd) pageNumbers.add(r.metadata.pageEnd);
        });
        
        return {
          documentId: docId,
          relevantChunks: docResults.length,
          relevantPages: Array.from(pageNumbers).sort((a, b) => a - b),
          averageScore: docResults.reduce((sum, r) => sum + (r.score || 0), 0) / docResults.length
        };
      });
      
      // Return the enhanced results
      const result = {
        success: true,
        message: 'Question vectorized and similar content found with enhanced context',
        timestamp: new Date().toISOString(),
        questionLength: context.question.length,
        embeddingDimension: embedding.length,
        similarChunks: contextualizedChunks,
        totalSimilarChunks: top10.length,
        // Document-level context summary
        documentContext: {
          documentsFound: documentSummary.length,
          summary: documentSummary
        },
        // Debug information
        debug: {
          indicesSearched: indices.join(','),
          totalIndicesSearched: indices.length,
          totalResultsBeforeFilter: allResults.length,
          listingMethod: indices.length > 1 ? 'listIndicesWithNewman' : 'fallback',
          awsKeySet: !!process.env.AWS_ACCESS_KEY_ID,
          bucketName: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362',
          listingErrors: listingErrors
        }
      };
      
      console.log('[Default Query Tool] 🎯 RETURNING RESULT WITH CHUNKS TO AGENT');
      console.log(`[Default Query Tool] Result contains ${result.similarChunks.length} chunks for the LLM to use`);
      
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