import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';
import { ContextBuilder } from '../lib/context-builder.js';
import { hybridSearch } from '../lib/hybrid-search.js';
import { detectSectionQuery } from '../lib/metadata-filter-simplified.js';
import { multiQuerySearch } from '../lib/multi-query-search.js';
import { invokeLambda } from '../lib/neptune-lambda-client.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to wait (for rate limiting)
async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract entities from text for graph enhancement
function extractEntitiesFromText(text: string): string[] {
  const entities: string[] = [];
  
  // Pattern for capitalized words (potential named entities)
  const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
  const matches = text.match(capitalizedPattern) || [];
  
  // Filter out common words
  const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How']);
  
  matches.forEach(match => {
    if (!commonWords.has(match) && match.length > 2) {
      entities.push(match);
    }
  });
  
  // Also extract quoted strings
  const quotedPattern = /"([^"]+)"/g;
  let quotedMatch;
  while ((quotedMatch = quotedPattern.exec(text)) !== null) {
    entities.push(quotedMatch[1]);
  }
  
  return [...new Set(entities)]; // Remove duplicates
}

// Query Neptune graph for related entities
async function queryGraphForEntities(entities: string[], maxEntities: number = 5): Promise<Map<string, any[]>> {
  const relatedEntities = new Map<string, any[]>();
  
  // Limit entities to query
  const entitiesToQuery = entities.slice(0, maxEntities);
  
  for (const entity of entitiesToQuery) {
    try {
      console.log(`[Default Query Tool] 🔍 Querying graph for entity: ${entity}`);
      
      // Query for all entities and filter by name
      const result = await invokeLambda({
        operation: 'queryEntitiesByType',
        limit: 100
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.entities) {
          // Filter entities that match our query
          const matches = response.result.entities.filter((e: any) => {
            const name = e.name?.[0] || '';
            return name.toLowerCase().includes(entity.toLowerCase()) || 
                   entity.toLowerCase().includes(name.toLowerCase());
          });
          
          if (matches.length > 0) {
            relatedEntities.set(entity, matches.slice(0, 3)); // Limit to 3 matches per entity
            console.log(`[Default Query Tool] ✅ Found ${matches.length} graph entities for "${entity}"`);
          }
        }
      }
    } catch (error) {
      console.log(`[Default Query Tool] ⚠️ Graph query failed for "${entity}":`, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  
  return relatedEntities;
}

async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Default Query Tool] No API key for embeddings, using mock embeddings...');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  // Implement retry logic with exponential backoff for rate limiting
  let retries = 3;
  let delay = 2000; // Start with 2 second delay (same as PDF processor)
  
  while (retries > 0) {
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

      if (response.status === 429) {
        // Rate limited - wait and retry
        console.log(`[Default Query Tool] Rate limited (429). Waiting ${delay}ms before retry. Retries left: ${retries - 1}`);
        await wait(delay);
        delay *= 2; // Exponential backoff
        retries--;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      console.log('[Default Query Tool] OpenAI embedding generated successfully');
      return data.data[0].embedding;
    } catch (error) {
      if (retries > 1) {
        console.log(`[Default Query Tool] Error generating embedding, retrying in ${delay}ms...`);
        await wait(delay);
        delay *= 2;
        retries--;
        continue;
      }
      
      // Final error - fall back to hash method
      console.error('[Default Query Tool] Error generating embedding after retries:', error);
      console.log('[Default Query Tool] Falling back to hash-based embedding');
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    }
  }
  
  // If we exhausted all retries due to rate limiting, fall back
  console.log('[Default Query Tool] Exhausted retries due to rate limiting, falling back to hash embedding');
  const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
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
      console.log(`[Default Query Tool]    Generated embedding first 5: [${embedding.slice(0, 5).map(v => v.toFixed(6)).join(', ')}...]`);
      
      // Step 2: Query knowledge graph for related entities
      console.log('[Default Query Tool] 2. Checking knowledge graph for entities...');
      console.log('[Default Query Tool] 📊 GRAPH ENHANCEMENT ENABLED - Version 2.0');
      const questionEntities = extractEntitiesFromText(context.question);
      console.log(`[Default Query Tool]    Extracted ${questionEntities.length} potential entities: ${questionEntities.join(', ')}`);
      
      let graphEntities: Map<string, any[]> = new Map();
      if (questionEntities.length > 0) {
        try {
          console.log('[Default Query Tool]    Calling queryGraphForEntities...');
          graphEntities = await queryGraphForEntities(questionEntities, 5);
          if (graphEntities.size > 0) {
            console.log(`[Default Query Tool] 📊 Found ${graphEntities.size} entities in knowledge graph`);
          } else {
            console.log('[Default Query Tool]    No matching entities found in graph');
          }
        } catch (graphError) {
          console.log('[Default Query Tool] ⚠️ Graph query failed:', graphError);
          console.log('[Default Query Tool]    Continuing with vector search only');
        }
      } else {
        console.log('[Default Query Tool]    No entities extracted from question');
      }
      
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
          const results = await queryVectorsWithNewman(indexName, embedding, 30);
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
            console.log(`[Default Query Tool]     Content preview: ${(firstResult.metadata?.chunkContent || firstResult.metadata?.content || '').substring(0, 150)}...`);
          }
        } catch (searchError) {
          const errorMsg = searchError instanceof Error ? searchError.message : 'Unknown error';
          console.error(`[Default Query Tool]     Error querying ${indexName}: ${errorMsg}`);
        }
      }
      
      // Step 5: Check if we should use multi-query search
      const shouldUseMultiQuery = 
        context.question.toLowerCase().includes('last') ||
        context.question.toLowerCase().includes('end') ||
        context.question.toLowerCase().includes('final') ||
        context.question.toLowerCase().includes('conclusion') ||
        context.question.toLowerCase().includes('epilogue');
      
      let finalResults: any[] = [];
      let isMultiQueryResult = false;
      
      if (shouldUseMultiQuery) {
        console.log('\n[Default Query Tool] 5. USING MULTI-QUERY SEARCH:');
        console.log('[Default Query Tool] =====================================');
        console.log('[Default Query Tool] Detected query about document ending - using multi-query approach');
        
        try {
          const multiQueryResult = await multiQuerySearch(context.question, indices, {
            maxQueries: 5,
            topKPerQuery: 30,
            finalTopK: 30
          });
          
          console.log(`[Default Query Tool] Multi-query found ${multiQueryResult.stats.totalUnique} unique chunks`);
          console.log(`[Default Query Tool] Used ${multiQueryResult.stats.queryCount} different query variations`);
          
          // Convert ranked results to format expected by rest of code
          finalResults = multiQueryResult.rankedResults.map(r => ({
            key: r.key,
            metadata: r.metadata,
            distance: r.distance,
            index: r.index,
            score: r.combinedScore,
            hybridScore: r.combinedScore
          }));
          
          isMultiQueryResult = true;
          
          // Log if we found final chunks
          if (multiQueryResult.stats.finalChunksFound.length > 0) {
            console.log(`[Default Query Tool] ✅ Found final chunks: ${multiQueryResult.stats.finalChunksFound.join(', ')}`);
          }
          
        } catch (error) {
          console.error('[Default Query Tool] Multi-query search failed, falling back to hybrid search:', error);
          isMultiQueryResult = false;
        }
      }
      
      // If not using multi-query or if it failed, use hybrid search
      if (!isMultiQueryResult) {
        console.log('\n[Default Query Tool] 5. IMPROVED SEARCH WITH HYBRID APPROACH:');
        console.log('[Default Query Tool] =====================================');
        
        // Detect if this is a section query
        const sectionInfo = detectSectionQuery(context.question);
        if (sectionInfo.isSection) {
          console.log(`[Default Query Tool] 🔍 Section query detected: ${sectionInfo.sectionNumber}`);
          if (sectionInfo.sectionVariations) {
            console.log(`[Default Query Tool] Section variations: ${sectionInfo.sectionVariations.join(', ')}`);
          }
        }
        
        // For section queries, enhance the query with section variations
        let enhancedQuery = context.question;
        if (sectionInfo.isSection && sectionInfo.sectionVariations) {
          // Add section variations to help with keyword matching
          enhancedQuery = context.question + ' ' + sectionInfo.sectionVariations.join(' ');
          console.log(`[Default Query Tool] Enhanced query for section search: "${enhancedQuery}"`);
        }
        
        // Use hybrid search instead of simple distance filtering
        console.log('[Default Query Tool] 🎯 Using hybrid search (vector + keyword matching)...');
        const hybridResults = await hybridSearch(
          enhancedQuery,  // Use enhanced query for better section matching
          embedding,
          indices,
          {
            maxDistance: 0.4,  // Even more lenient for keyword-heavy searches
            topK: 30,          // Get more initial results for better keyword matching
            weightVector: sectionInfo.isSection ? 0.3 : 0.6,  // Weight keywords even more for section queries
            minKeywordScore: 0  // Don't require minimum keyword score
          }
        );
        
        // Skip metadata filtering - use hybrid results directly
        console.log('[Default Query Tool] 📊 Skipping metadata filtering - using keyword-based search only...');
        
        // Remove blank content from hybrid results
        const validResults = hybridResults.filter(result => {
          const content = result.metadata?.chunkContent || result.metadata?.content || '';
          if (!content || content.trim().length < 10) {
            console.log(`[Default Query Tool] ⚠️ Excluding blank/short chunk: ${result.key}`);
            return false;
          }
          return true;
        });
        
        console.log(`[Default Query Tool] 📊 Found ${validResults.length} valid results after hybrid search and filtering`);
        finalResults = validResults;
      }
      
      // Apply graph enhancement to boost relevant results
      if (graphEntities.size > 0) {
        console.log('\n[Default Query Tool] 🔗 APPLYING GRAPH ENHANCEMENT:');
        console.log('[Default Query Tool] =====================================');
        
        let boostedCount = 0;
        finalResults = finalResults.map(result => {
          const content = (result.metadata?.chunkContent || result.metadata?.content || '').toLowerCase();
          let graphBoost = 0;
          
          // Check if content mentions any graph entities
          graphEntities.forEach((entities, queryTerm) => {
            entities.forEach(entity => {
              const entityName = (entity.name?.[0] || '').toLowerCase();
              if (entityName && content.includes(entityName)) {
                graphBoost = Math.max(graphBoost, 0.15); // 15% boost for graph entity mentions
                if (graphBoost > 0 && boostedCount < 10) {
                  console.log(`[Default Query Tool]    ⭐ Boosting chunk with "${entityName}"`);
                  boostedCount++;
                }
              }
            });
          });
          
          // Apply boost to score or distance
          if (graphBoost > 0) {
            return {
              ...result,
              distance: result.distance ? result.distance * (1 - graphBoost) : result.distance,
              score: result.score ? result.score + graphBoost : graphBoost,
              graphEnhanced: true
            };
          }
          return result;
        });
        
        console.log(`[Default Query Tool] 📊 Boosted ${boostedCount} chunks based on graph entities`);
        
        // Re-sort by enhanced scores
        finalResults.sort((a, b) => {
          if (a.distance !== undefined && b.distance !== undefined) {
            return a.distance - b.distance; // Lower distance is better
          }
          return (b.score || 0) - (a.score || 0); // Higher score is better
        });
      }
      
      // Now continue with the rest of the processing using finalResults
      
      // Filter chunks by summary relevance to the question
      console.log('\n[Default Query Tool] 🎯 CHECKING SUMMARY RELEVANCE TO QUESTION:');
      console.log('[Default Query Tool] =====================================');
      console.log(`[Default Query Tool] User question: "${context.question}"`);
      
      // Extract key terms from the question for matching
      const questionLower = context.question.toLowerCase();
      // First, try to extract meaningful phrases and terms
      const questionTerms: string[] = [];
      
      // Extract multi-word technical terms (e.g., "operating system", "file system")
      const commonPhrases = [
        'operating system', 'file system', 'memory management', 'process scheduling',
        'virtual memory', 'page replacement', 'disk scheduling', 'cpu scheduling',
        'deadlock prevention', 'mutual exclusion', 'critical section', 'race condition',
        'context switch', 'thread synchronization', 'semaphore', 'mutex', 'monitor',
        'supply and demand', 'market equilibrium', 'price elasticity', 'consumer surplus'
      ];
      
      commonPhrases.forEach(phrase => {
        if (questionLower.includes(phrase)) {
          questionTerms.push(phrase);
        }
      });
      
      // Then extract individual words, excluding stop words
      const stopWords = new Set(['the', 'and', 'for', 'are', 'is', 'it', 'to', 'of', 'in', 'on', 'at', 'with', 'from', 
        'what', 'how', 'why', 'when', 'where', 'who', 'which', 'can', 'could', 'would', 'should', 
        'does', 'did', 'has', 'have', 'had', 'will', 'been', 'being', 'was', 'were', 'about', 
        'explain', 'describe', 'tell', 'me', 'please', 'need', 'want', 'know', 'understand']);
        
      const words = questionLower
        .split(/[\s,;:!?()\[\]{}"']+/)
        .filter(term => term.length > 2 && !stopWords.has(term));
        
      // Add individual words that aren't already part of phrases
      words.forEach(word => {
        if (!questionTerms.some(phrase => phrase.includes(word))) {
          questionTerms.push(word);
        }
      });
      
      console.log(`[Default Query Tool] Key question terms: [${questionTerms.join(', ')}]`);
      
      // Filter chunks where summary is relevant to the question
      const relevantResults = finalResults.filter((result, idx) => {
        const summary = (result.metadata?.chunkSummary || '').toLowerCase();
        const content = (result.metadata?.chunkContent || result.metadata?.content || '').toLowerCase();
        
        // Debug: Check if we have summaries
        if (idx === 0) {
          console.log(`[Default Query Tool] First chunk has summary: ${!!result.metadata?.chunkSummary}`);
          if (result.metadata?.chunkSummary) {
            console.log(`[Default Query Tool] Summary length: ${result.metadata.chunkSummary.length} chars`);
          }
        }
        
        // Check if summary contains any key terms from the question
        const summaryRelevance = questionTerms.filter(term => summary.includes(term)).length;
        const contentRelevance = questionTerms.filter(term => content.includes(term)).length;
        
        // Calculate relevance score
        const totalTerms = questionTerms.length || 1;
        const summaryScore = summaryRelevance / totalTerms;
        const contentScore = contentRelevance / totalTerms;
        
        // Log the analysis for first 20 chunks
        if (idx < 20) {
          console.log(`\n[Default Query Tool] Chunk ${idx + 1}:`);
          console.log(`[Default Query Tool]   Summary (first 100 chars): "${summary.substring(0, 100)}..."`);
          console.log(`[Default Query Tool]   Summary matches ${summaryRelevance}/${totalTerms} question terms (${(summaryScore * 100).toFixed(1)}%)`);
          console.log(`[Default Query Tool]   Content matches ${contentRelevance}/${totalTerms} question terms (${(contentScore * 100).toFixed(1)}%)`);
        }
        
        // For multi-query results, they're already well-ranked, so be more lenient
        const isMultiQuery = isMultiQueryResult;
        
        // Accept chunk if:
        // 1. It's from multi-query (already ranked by relevance), OR
        // 2. Any term matches in summary (even 1 match is significant), OR
        // 3. At least 1 term matches in content (lowered threshold), OR  
        // 4. Vector distance is very low (< 0.18, indicating high similarity)
        const isRelevant = isMultiQuery || summaryRelevance > 0 || contentRelevance > 0 || (result.distance && result.distance < 0.18);
        
        if (idx < 20 && !isRelevant) {
          console.log(`[Default Query Tool]   ❌ FILTERED OUT - Low relevance to question`);
        } else if (idx < 20 && isRelevant) {
          console.log(`[Default Query Tool]   ✅ KEPT - Relevant to question`);
        }
        
        return isRelevant;
      });
      
      console.log(`\n[Default Query Tool] 📊 Summary relevance filtering results:`);
      console.log(`[Default Query Tool]   Started with: ${finalResults.length} chunks`);
      console.log(`[Default Query Tool]   After relevance filter: ${relevantResults.length} chunks`);
      console.log(`[Default Query Tool]   Filtered out: ${finalResults.length - relevantResults.length} irrelevant chunks`);
      
      // If relevance filter was too aggressive, fall back to original results
      let finalFilteredResults = relevantResults;
      if (relevantResults.length === 0 && finalResults.length > 0) {
        console.log(`[Default Query Tool] ⚠️ Relevance filter too strict - falling back to top vector matches`);
        finalFilteredResults = finalResults;
      }
      
      // LIMIT TO TOP 30 RESULTS (increased from 10 for better coverage)
      const top30 = finalFilteredResults.slice(0, 30);
      console.log(`[Default Query Tool] Limited to top ${top30.length} results`);
      
      if (top30.length > 0) {
        console.log(`[Default Query Tool] 📊 Selected ${top30.length} results after relevance filtering`);
        console.log(`[Default Query Tool] Distance range: ${top30[0].distance?.toFixed(4)} to ${top30[top30.length-1].distance?.toFixed(4)}`);
      } else {
        console.log(`[Default Query Tool] ⚠️ No results found after relevance filtering`);
        
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
            resultsWithDistance: finalFilteredResults.length
          }
        };
        
        console.log('[Default Query Tool] 🎯 RETURNING EMPTY RESULT - No results with distance < 0.2');
        return result;
      }
      
      // Show which indices contributed results
      const indexContributions = new Map<string, number>();
      top30.forEach(r => {
        if (r.index) {
          indexContributions.set(r.index, (indexContributions.get(r.index) || 0) + 1);
        }
      });
      console.log(`[Default Query Tool] Results by index:`, Object.fromEntries(indexContributions));
      
      // Group results by document for better contextualization
      const resultsByDocument = new Map<string, any[]>();
      
      top30.forEach((result, i) => {
        const docId = result.metadata?.documentId || result.metadata?.filename || result.index || 'unknown';
        if (!resultsByDocument.has(docId)) {
          resultsByDocument.set(docId, []);
        }
        resultsByDocument.get(docId)!.push(result);
        
        console.log(`[Default Query Tool] ${i + 1}. [${result.index || 'unknown'}]`);
        console.log(`[Default Query Tool]    Key: ${result.key}`);
        console.log(`[Default Query Tool]    Distance: ${result.distance !== undefined ? result.distance.toFixed(4) : 'not provided'}`);
        if (result.metadata?.pageStart) {
          console.log(`[Default Query Tool]    Pages: ${result.metadata.pageStart}-${result.metadata.pageEnd || result.metadata.pageStart}`);
          console.log(`[Default Query Tool]    Chunk: ${result.metadata.chunkIndex + 1}/${result.metadata.totalChunks || '?'}`);
        }
        // Debug content issues
        const contentPreview = result.metadata?.chunkContent || result.metadata?.content || result.metadata?.text || 'No content available';
        if (contentPreview.trim().length < 10) {
          console.log(`[Default Query Tool]    ⚠️ BLANK/SHORT CONTENT DETECTED!`);
          console.log(`[Default Query Tool]    Raw metadata:`, JSON.stringify(result.metadata).substring(0, 200));
        }
        console.log(`[Default Query Tool]    Content: ${contentPreview.substring(0, 200)}...`);
      });
      
      console.log(`[Default Query Tool] Total results found across all indices: ${allResults.length}`);
      console.log(`[Default Query Tool] Results from ${resultsByDocument.size} different documents`);
      
      // Build contextualized chunks for ContextBuilder
      const contextualizedChunks = top30.map(r => ({
        key: r.key,
        score: r.score || r.hybridScore || 0,
        distance: r.distance,
        index: r.index || 'unknown',
        content: r.metadata?.chunkContent || r.metadata?.content || r.metadata?.text || 'No content available',
        metadata: r.metadata,
        context: {
          documentId: r.metadata?.documentId || r.metadata?.filename || r.index || 'unknown',
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
      const hasLinkedStructure = top30.some(r => 
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
      
      // Build graph context string if we have entities
      let graphContextString = '';
      if (graphEntities.size > 0) {
        graphContextString = '\n\n📊 KNOWLEDGE GRAPH CONTEXT:\n';
        graphContextString += '================================\n';
        
        graphEntities.forEach((entities, queryTerm) => {
          if (entities.length > 0) {
            graphContextString += `\n🔍 Related to "${queryTerm}":\n`;
            entities.forEach(entity => {
              const name = entity.name?.[0] || '';
              const type = entity.entityType?.[0] || '';
              graphContextString += `• ${name} (${type})\n`;
              if (entity.description?.[0]) {
                graphContextString += `  ${entity.description[0]}\n`;
              }
            });
          }
        });
        
        const graphEnhancedCount = top30.filter(r => r.graphEnhanced).length;
        graphContextString += '\n================================\n';
        graphContextString += `${graphEnhancedCount} results were enhanced with graph data.\n`;
      }
      
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
        // Combined context string with graph data
        contextString: contextualResponse.contextString + graphContextString,
        citations: contextualResponse.citations,
        // Graph enhancement summary
        graphEnhancement: graphEntities.size > 0 ? {
          entitiesFound: graphEntities.size,
          entities: Array.from(graphEntities.entries()).map(([query, entities]) => ({
            queryTerm: query,
            relatedEntities: entities.map(e => ({
              name: e.name?.[0] || '',
              type: e.entityType?.[0] || ''
            }))
          }))
        } : null,
        // Debug information
        debug: {
          indicesSearched: indices.join(','),
          totalIndicesSearched: indices.length,
          totalResultsBeforeFilter: allResults.length,
          resultsWithDistance: finalFilteredResults.length,
          top30Count: top30.length,
          listingMethod: indices.length > 1 ? 'listIndicesWithNewman' : 'fallback',
          awsKeySet: !!process.env.AWS_ACCESS_KEY_ID,
          bucketName: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362',
          listingErrors: listingErrors,
          graphEntitiesQueried: graphEntities.size,
          graphEnhancedChunks: top30.filter(r => r.graphEnhanced).length
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
        console.log(`[Default Query Tool] - Summary: "${(chunk.metadata?.chunkSummary || 'No summary').substring(0, 100)}..."`);
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