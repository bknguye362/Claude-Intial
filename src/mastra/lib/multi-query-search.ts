// Multi-query search that uses LLM to generate related queries
// Searches each index separately, merges results, and ranks them

import { queryVectorsWithNewman } from './newman-executor.js';

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';
const CHAT_DEPLOYMENT = 'gpt-4o-mini';

// Helper function to wait (for rate limiting)
async function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate embedding for text
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Multi-Query] No API key, using fallback embedding');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  let retries = 3;
  let delay = 2000;
  
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
        console.log(`[Multi-Query] Rate limited. Waiting ${delay}ms...`);
        await wait(delay);
        delay *= 2;
        retries--;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status}`);
      }

      const data: any = await response.json();
      return data.data[0].embedding;
      
    } catch (error) {
      if (retries > 1) {
        console.log(`[Multi-Query] Error, retrying in ${delay}ms...`);
        await wait(delay);
        delay *= 2;
        retries--;
        continue;
      }
      // Fall back to hash method
      console.log('[Multi-Query] Falling back to hash embedding');
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    }
  }
  
  // Fallback if all retries exhausted
  const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
}

// Use LLM to generate related queries
async function generateRelatedQueries(originalQuery: string): Promise<string[]> {
  console.log('[Multi-Query] Generating related queries with LLM...');
  
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Multi-Query] No API key, using fallback query generation');
    // Fallback: extract key phrases manually
    const queries = [originalQuery];
    
    // Add variations for "last" queries
    if (originalQuery.toLowerCase().includes('last')) {
      queries.push('final paragraph ending conclusion');
      queries.push('the end epilogue afterward');
      queries.push('closing final words last sentence');
    }
    
    // Extract key phrases
    const words = originalQuery.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length > 1) {
      queries.push(words.join(' '));
      queries.push(words.slice(-2).join(' ')); // Last 2 words
    }
    
    return queries.slice(0, 5);
  }
  
  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${CHAT_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const systemPrompt = `You are a query expansion assistant. Given a user's question, generate 4 related search queries that would help find relevant content. Focus on:
1. Rephrasing the original question
2. Extracting key concepts and searching for them
3. Using synonyms for important terms
4. Breaking down complex queries into simpler parts

Return ONLY the queries, one per line, no numbering or bullets.`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Original query: "${originalQuery}"\n\nGenerate 4 related search queries:` }
        ],
        temperature: 0.7,
        max_tokens: 200
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }
    
    const data: any = await response.json();
    const generatedText = data.choices[0]?.message?.content || '';
    
    // Parse the generated queries
    const queries = generatedText
      .split('\n')
      .map((q: string) => q.trim())
      .filter((q: string) => q.length > 0 && !q.startsWith('-') && !q.match(/^\d+\./))
      .slice(0, 4);
    
    // Always include the original query first
    return [originalQuery, ...queries];
    
  } catch (error) {
    console.error('[Multi-Query] Error generating queries with LLM:', error);
    // Fallback to simple extraction
    return [originalQuery];
  }
}

// Result with ranking information
interface RankedResult {
  key: string;
  metadata: any;
  distance?: number;
  index: string;
  appearances: number;        // How many queries returned this chunk
  bestRank: number;           // Best position across all queries
  averageRank: number;        // Average position across queries
  combinedScore: number;      // Final ranking score
  sourceQueries: string[];    // Which queries found this chunk
}

// Merge and rank results from multiple queries
function mergeAndRankResults(queryResults: { query: string; results: any[] }[]): RankedResult[] {
  const chunkMap = new Map<string, RankedResult>();
  
  // Process each query's results
  queryResults.forEach(({ query, results }) => {
    results.forEach((result, rank) => {
      const key = result.key;
      
      if (!chunkMap.has(key)) {
        chunkMap.set(key, {
          key: result.key,
          metadata: result.metadata,
          distance: result.distance,
          index: result.index,
          appearances: 1,
          bestRank: rank + 1,
          averageRank: rank + 1,
          combinedScore: 0,
          sourceQueries: [query]
        });
      } else {
        const existing = chunkMap.get(key)!;
        existing.appearances += 1;
        existing.bestRank = Math.min(existing.bestRank, rank + 1);
        existing.averageRank = ((existing.averageRank * (existing.appearances - 1)) + (rank + 1)) / existing.appearances;
        existing.sourceQueries.push(query);
        
        // Keep the best (lowest) distance
        if (result.distance && (!existing.distance || result.distance < existing.distance)) {
          existing.distance = result.distance;
        }
      }
    });
  });
  
  // Calculate combined scores
  const results = Array.from(chunkMap.values());
  results.forEach(result => {
    // Scoring formula:
    // - More appearances = better (weight: 40%)
    // - Better best rank = better (weight: 30%)
    // - Better average rank = better (weight: 20%)
    // - Lower distance = better (weight: 10%)
    
    const appearanceScore = result.appearances / queryResults.length; // 0-1
    const bestRankScore = 1 / result.bestRank; // Higher score for better rank
    const avgRankScore = 1 / result.averageRank; // Higher score for better average
    const distanceScore = result.distance ? (1 - result.distance) : 0.5; // Lower distance = higher score
    
    result.combinedScore = 
      (appearanceScore * 0.4) + 
      (bestRankScore * 0.3) + 
      (avgRankScore * 0.2) + 
      (distanceScore * 0.1);
  });
  
  // Sort by combined score (highest first)
  results.sort((a, b) => b.combinedScore - a.combinedScore);
  
  return results;
}

// Perform multi-query search
export async function multiQuerySearch(
  originalQuery: string,
  indices: string[],
  options: {
    maxQueries?: number;
    topKPerQuery?: number;
    finalTopK?: number;
  } = {}
): Promise<{
  rankedResults: RankedResult[];
  queries: string[];
  stats: {
    totalUnique: number;
    queryCount: number;
    indexCount: number;
    finalChunksFound: number[];
  };
}> {
  const {
    maxQueries = 5,
    topKPerQuery = 30,
    finalTopK = 30
  } = options;
  
  console.log('[Multi-Query] ========= MULTI-QUERY SEARCH =========');
  console.log(`[Multi-Query] Original query: "${originalQuery}"`);
  console.log(`[Multi-Query] Indices to search: ${indices.join(', ')}`);
  
  // Generate related queries using LLM
  const queries = await generateRelatedQueries(originalQuery);
  console.log(`[Multi-Query] Generated ${queries.length} queries:`);
  queries.forEach((q, i) => console.log(`[Multi-Query]   ${i + 1}. "${q}"`));
  
  // Generate embeddings for each query
  console.log('[Multi-Query] Generating embeddings...');
  const embeddings: { query: string; embedding: number[] }[] = [];
  
  for (const query of queries.slice(0, maxQueries)) {
    const embedding = await generateEmbedding(query);
    embeddings.push({ query, embedding });
    await wait(500); // Rate limiting
  }
  
  // Search each index with each query
  console.log('[Multi-Query] Searching indices...');
  const queryResults: { query: string; results: any[] }[] = [];
  
  for (const { query, embedding } of embeddings) {
    console.log(`[Multi-Query] Searching with: "${query}"`);
    const results: any[] = [];
    
    for (const indexName of indices) {
      try {
        const indexResults = await queryVectorsWithNewman(indexName, embedding, topKPerQuery);
        if (indexResults && indexResults.length > 0) {
          results.push(...indexResults.map((r: any) => ({
            ...r,
            index: indexName
          })));
        }
      } catch (error) {
        console.error(`[Multi-Query] Error querying ${indexName}:`, error);
      }
    }
    
    // Sort by distance and take top results
    results.sort((a, b) => (a.distance || 1) - (b.distance || 1));
    queryResults.push({
      query,
      results: results.slice(0, topKPerQuery)
    });
    
    // Log what chunks were found
    const chunkIndices = results
      .map(r => r.metadata?.chunkIndex)
      .filter(idx => idx !== undefined);
    
    if (chunkIndices.length > 0) {
      const highest = Math.max(...chunkIndices);
      console.log(`[Multi-Query]   Found ${chunkIndices.length} chunks, highest: ${highest}`);
    }
  }
  
  // Merge and rank all results
  console.log('[Multi-Query] Merging and ranking results...');
  const rankedResults = mergeAndRankResults(queryResults);
  
  // Calculate statistics
  const uniqueChunks = new Set(rankedResults.map(r => r.metadata?.chunkIndex).filter(idx => idx !== undefined));
  const finalChunks = [315, 316, 317, 318].filter(idx => uniqueChunks.has(idx));
  
  console.log('[Multi-Query] ========= RESULTS SUMMARY =========');
  console.log(`[Multi-Query] Total unique chunks: ${uniqueChunks.size}`);
  console.log(`[Multi-Query] Top chunks by combined score:`);
  
  rankedResults.slice(0, 10).forEach((result, i) => {
    const chunkIdx = result.metadata?.chunkIndex || 'unknown';
    console.log(`[Multi-Query]   ${i + 1}. Chunk ${chunkIdx}:`);
    console.log(`[Multi-Query]      - Appeared in ${result.appearances}/${queries.length} queries`);
    console.log(`[Multi-Query]      - Best rank: ${result.bestRank}`);
    console.log(`[Multi-Query]      - Score: ${result.combinedScore.toFixed(3)}`);
  });
  
  if (finalChunks.length > 0) {
    console.log(`[Multi-Query] ✅ Final chunks found: ${finalChunks.join(', ')}`);
  } else {
    console.log('[Multi-Query] ❌ No final chunks (315-318) found');
  }
  
  // Return top results
  return {
    rankedResults: rankedResults.slice(0, finalTopK),
    queries,
    stats: {
      totalUnique: uniqueChunks.size,
      queryCount: queries.length,
      indexCount: indices.length,
      finalChunksFound: finalChunks
    }
  };
}