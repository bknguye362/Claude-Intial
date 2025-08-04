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
  // Minimal stopwords - keep most words for better matching
  const stopWords = new Set(['the', 'is', 'a', 'an', 'and', 'or', 'but', 'in', 'to', 'for', 'of', 'as', 'by']);
  
  // Extract all numbers (including decimals)
  const numberPattern = /\b(\d+\.?\d*)\b/g;
  const numbers = query.match(numberPattern) || [];
  
  // Extract words - keep shorter words too for better matching
  const words = query.toLowerCase()
    .replace(/[^\w\s.-]/g, '') // Keep dots and hyphens
    .split(/\s+/)
    .filter(word => {
      // Keep all numbers
      if (/\d/.test(word)) return true;
      // Keep words 2+ chars that aren't stopwords
      return word.length >= 2 && !stopWords.has(word);
    });
  
  // Combine and deduplicate
  const allKeywords = [...new Set([...numbers, ...words])];
  
  // Also add bigrams for better phrase matching
  const bigrams = [];
  const wordArray = query.toLowerCase().split(/\s+/);
  for (let i = 0; i < wordArray.length - 1; i++) {
    bigrams.push(`${wordArray[i]} ${wordArray[i + 1]}`);
  }
  
  return [...allKeywords, ...bigrams];
}

// Calculate keyword match score
function calculateKeywordScore(content: string, metadata: any, keywords: string[]): number {
  let score = 0;
  const lowerContent = content.toLowerCase();
  
  for (const keyword of keywords) {
    // Handle bigrams (phrases) vs single words differently
    const isBigram = keyword.includes(' ');
    
    if (isBigram) {
      // For bigrams, look for exact phrase matches
      const phraseMatches = (lowerContent.match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
      score += phraseMatches * 5; // Higher weight for phrase matches
    } else {
      // For single words, look for word boundary matches
      try {
        const contentMatches = (lowerContent.match(new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) || []).length;
        score += contentMatches * 2;
      } catch (e) {
        // Fallback to simple includes for special characters
        if (lowerContent.includes(keyword)) {
          score += 2;
        }
      }
    }
    
    // Check metadata fields if they exist
    const metadataChecks = [
      { field: metadata.sectionNumber, weight: 10 },
      { field: metadata.sectionTitle, weight: 5 },
      { field: metadata.topics, weight: 3 },
      { field: metadata.summary, weight: 2 },
      { field: metadata.filename, weight: 1 }
    ];
    
    metadataChecks.forEach(({ field, weight }) => {
      if (field && field.toString().toLowerCase().includes(keyword)) {
        score += weight;
      }
    });
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