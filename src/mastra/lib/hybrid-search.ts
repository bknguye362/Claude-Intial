// Hybrid search combining vector similarity and keyword matching
import { queryVectorsWithNewman } from './newman-executor.js';

interface SearchResult {
  key: string;
  distance: number;
  metadata: any;
  keywordScore?: number;
  hybridScore?: number;
}

// Extract important keywords from query
function extractKeywords(query: string): string[] {
  // Remove common words and extract meaningful terms
  const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for', 'of', 'as', 'by', 'from', 'what', 'where', 'when', 'how', 'why']);
  
  // Extract section numbers
  const sectionPattern = /\b(\d+\.?\d*)\b/g;
  const sectionNumbers = query.match(sectionPattern) || [];
  
  // Extract other words
  const words = query.toLowerCase()
    .replace(/[^\w\s.-]/g, '') // Keep dots for section numbers
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return [...new Set([...sectionNumbers, ...words])];
}

// Calculate keyword match score
function calculateKeywordScore(content: string, metadata: any, keywords: string[]): number {
  let score = 0;
  const lowerContent = content.toLowerCase();
  
  for (const keyword of keywords) {
    // Exact matches in content
    const contentMatches = (lowerContent.match(new RegExp(`\\b${keyword}\\b`, 'gi')) || []).length;
    score += contentMatches * 2; // Weight content matches higher
    
    // Matches in metadata
    if (metadata.sectionNumber && metadata.sectionNumber.includes(keyword)) {
      score += 10; // High weight for section number matches
    }
    
    if (metadata.sectionTitle && metadata.sectionTitle.toLowerCase().includes(keyword)) {
      score += 5; // Good weight for title matches
    }
    
    if (metadata.topics && metadata.topics.toLowerCase().includes(keyword)) {
      score += 3; // Medium weight for topic matches
    }
    
    if (metadata.summary && metadata.summary.toLowerCase().includes(keyword)) {
      score += 2; // Lower weight for summary matches
    }
  }
  
  return score;
}

// Perform hybrid search
export async function hybridSearch(
  query: string,
  embedding: number[],
  indices: string[],
  options: {
    maxDistance?: number;
    minKeywordScore?: number;
    topK?: number;
    weightVector?: number; // 0-1, how much to weight vector similarity vs keywords
  } = {}
): Promise<SearchResult[]> {
  const {
    maxDistance = 0.3, // More lenient than 0.2
    minKeywordScore = 0,
    topK = 20, // Get more initial results
    weightVector = 0.7 // 70% vector, 30% keyword
  } = options;
  
  console.log('[Hybrid Search] Starting hybrid search');
  console.log(`[Hybrid Search] Query: "${query}"`);
  
  // Extract keywords
  const keywords = extractKeywords(query);
  console.log(`[Hybrid Search] Keywords: ${keywords.join(', ')}`);
  
  // Get vector search results
  const vectorResults: SearchResult[] = [];
  
  for (const indexName of indices) {
    try {
      const results = await queryVectorsWithNewman(indexName, embedding, topK);
      
      if (results && results.length > 0) {
        vectorResults.push(...results.map(r => ({
          ...r,
          index: indexName
        })));
      }
    } catch (error) {
      console.error(`[Hybrid Search] Error querying ${indexName}:`, error);
    }
  }
  
  // Calculate hybrid scores
  const scoredResults = vectorResults.map(result => {
    // Vector similarity score (inverse of distance)
    const vectorScore = 1 - (result.distance || 0);
    
    // Keyword matching score
    const content = result.metadata?.content || '';
    const keywordScore = calculateKeywordScore(content, result.metadata || {}, keywords);
    const normalizedKeywordScore = Math.min(keywordScore / 10, 1); // Normalize to 0-1
    
    // Hybrid score
    const hybridScore = (weightVector * vectorScore) + ((1 - weightVector) * normalizedKeywordScore);
    
    return {
      ...result,
      keywordScore,
      hybridScore
    };
  });
  
  // Filter and sort by hybrid score
  const filteredResults = scoredResults
    .filter(r => {
      // More lenient filtering
      const passesDistance = r.distance <= maxDistance;
      const passesKeyword = r.keywordScore >= minKeywordScore;
      
      // If strong keyword match, allow higher distance
      if (r.keywordScore > 5) {
        return r.distance <= maxDistance * 1.5;
      }
      
      return passesDistance || passesKeyword;
    })
    .sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0))
    .slice(0, 10); // Final top 10
  
  console.log(`[Hybrid Search] Found ${filteredResults.length} results after filtering`);
  
  // Log top results for debugging
  filteredResults.slice(0, 3).forEach((r, i) => {
    console.log(`[Hybrid Search] Result ${i + 1}:`);
    console.log(`  - Distance: ${r.distance?.toFixed(4)}`);
    console.log(`  - Keyword Score: ${r.keywordScore}`);
    console.log(`  - Hybrid Score: ${r.hybridScore?.toFixed(4)}`);
    console.log(`  - Section: ${r.metadata?.sectionNumber || 'N/A'}`);
  });
  
  return filteredResults;
}