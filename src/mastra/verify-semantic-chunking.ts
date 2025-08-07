#!/usr/bin/env node

/**
 * Verification tool to check if documents use semantic-preserving dynamic chunking
 * 
 * Dynamic chunking principles:
 * 1. Keep paragraphs together when possible
 * 2. If paragraph > 1000 chars, split at sentence boundaries
 * 3. Never break mid-word or mid-sentence
 * 4. Maintain ~1000 char target with 100 char overlap
 */

import { queryVectorsWithNewman, listIndicesWithNewman } from './lib/newman-executor.js';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

interface SemanticAnalysis {
  chunkIndex: number;
  content: string;
  length: number;
  startsWithCapital: boolean;
  endsWithPunctuation: boolean;
  hasCompleteSentences: boolean;
  appearsTruncated: boolean;
  midWordBreak: boolean;
  midSentenceBreak: boolean;
  semanticScore: number;
}

function analyzeChunkSemantics(content: string): SemanticAnalysis {
  const trimmed = content.trim();
  const length = trimmed.length;
  
  // Check if starts properly (capital letter or number)
  const startsWithCapital = /^[A-Z0-9"']/.test(trimmed);
  
  // Check if ends properly (punctuation)
  const endsWithPunctuation = /[.!?;:'")\]]\s*$/.test(trimmed);
  
  // Check for complete sentences
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [];
  const hasCompleteSentences = sentences.length > 0;
  
  // Check for mid-word breaks (ends with incomplete word)
  const lastWord = trimmed.split(/\s+/).pop() || '';
  const midWordBreak = lastWord.length > 0 && 
    lastWord.length < 4 && 
    !/[.!?,;:'")\]aeiou]$/i.test(lastWord) &&
    !trimmed.endsWith('...');
  
  // Check for mid-sentence breaks
  const midSentenceBreak = !endsWithPunctuation && 
    !trimmed.endsWith('...') && 
    length > 50; // Only check substantial chunks
  
  // Check if appears truncated
  const appearsTruncated = (
    trimmed.endsWith('...') ||
    (midSentenceBreak && !startsWithCapital) ||
    midWordBreak
  );
  
  // Calculate semantic score (0-100)
  let semanticScore = 100;
  if (!startsWithCapital) semanticScore -= 10;
  if (!endsWithPunctuation) semanticScore -= 20;
  if (!hasCompleteSentences && length > 100) semanticScore -= 15;
  if (midWordBreak) semanticScore -= 30;
  if (midSentenceBreak) semanticScore -= 15;
  if (appearsTruncated) semanticScore -= 10;
  
  return {
    chunkIndex: 0,
    content: trimmed,
    length,
    startsWithCapital,
    endsWithPunctuation,
    hasCompleteSentences,
    appearsTruncated,
    midWordBreak,
    midSentenceBreak,
    semanticScore: Math.max(0, semanticScore)
  };
}

async function verifyIndexChunking(indexName: string): Promise<void> {
  console.log(`\n${colors.blue}═══ Analyzing: ${indexName} ═══${colors.reset}\n`);
  
  try {
    // Get sample chunks
    const queryVector = Array(1536).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5);
    const chunks = await queryVectorsWithNewman(indexName, queryVector, 20);
    
    if (!chunks || chunks.length === 0) {
      console.log(`${colors.yellow}No chunks found${colors.reset}`);
      return;
    }
    
    console.log(`Retrieved ${chunks.length} chunks for analysis\n`);
    
    const analyses: SemanticAnalysis[] = [];
    let totalScore = 0;
    let violations = {
      midWord: 0,
      midSentence: 0,
      noPunctuation: 0,
      truncated: 0
    };
    
    // Analyze each chunk
    chunks.forEach((chunk, idx) => {
      const content = chunk.metadata?.chunkContent || chunk.metadata?.content || '';
      if (!content) return;
      
      const analysis = analyzeChunkSemantics(content);
      analysis.chunkIndex = chunk.metadata?.chunkIndex || idx;
      analyses.push(analysis);
      totalScore += analysis.semanticScore;
      
      // Count violations
      if (analysis.midWordBreak) violations.midWord++;
      if (analysis.midSentenceBreak) violations.midSentence++;
      if (!analysis.endsWithPunctuation) violations.noPunctuation++;
      if (analysis.appearsTruncated) violations.truncated++;
      
      // Show first 3 chunks in detail
      if (idx < 3) {
        console.log(`${colors.bright}Chunk ${analysis.chunkIndex}:${colors.reset}`);
        console.log(`  Length: ${analysis.length} chars`);
        console.log(`  Semantic Score: ${getScoreColor(analysis.semanticScore)}${analysis.semanticScore}/100${colors.reset}`);
        
        // Show indicators
        const indicators = [];
        if (analysis.startsWithCapital) indicators.push('✓ Proper start');
        else indicators.push('✗ No capital start');
        
        if (analysis.endsWithPunctuation) indicators.push('✓ Proper ending');
        else indicators.push('✗ No punctuation end');
        
        if (!analysis.midWordBreak) indicators.push('✓ Complete words');
        else indicators.push('✗ Mid-word break');
        
        if (!analysis.midSentenceBreak) indicators.push('✓ Complete sentence');
        else indicators.push('⚠ Mid-sentence break');
        
        console.log(`  Indicators: ${indicators.join(', ')}`);
        
        // Show content boundaries
        console.log(`  Start: "${content.substring(0, 50)}..."`);
        console.log(`  End: "...${content.substring(content.length - 50)}"`);
        console.log();
      }
    });
    
    // Calculate overall statistics
    const avgScore = analyses.length > 0 ? totalScore / analyses.length : 0;
    const avgLength = analyses.reduce((sum, a) => sum + a.length, 0) / analyses.length;
    
    // Determine chunking quality
    let quality = 'Unknown';
    let qualityColor = colors.gray;
    
    if (avgScore >= 80) {
      quality = 'EXCELLENT - Semantic boundaries preserved';
      qualityColor = colors.green;
    } else if (avgScore >= 60) {
      quality = 'GOOD - Mostly semantic, some issues';
      qualityColor = colors.yellow;
    } else if (avgScore >= 40) {
      quality = 'FAIR - Mixed semantic/character splitting';
      qualityColor = colors.yellow;
    } else {
      quality = 'POOR - Character-based splitting';
      qualityColor = colors.red;
    }
    
    // Summary
    console.log(`${colors.bright}══ Summary ══${colors.reset}`);
    console.log(`Average Semantic Score: ${getScoreColor(avgScore)}${avgScore.toFixed(1)}/100${colors.reset}`);
    console.log(`Average Chunk Size: ${Math.round(avgLength)} chars`);
    console.log(`Quality: ${qualityColor}${quality}${colors.reset}`);
    
    if (violations.midWord > 0 || violations.midSentence > 0) {
      console.log(`\n${colors.yellow}Violations Found:${colors.reset}`);
      if (violations.midWord > 0) 
        console.log(`  • Mid-word breaks: ${violations.midWord}/${chunks.length}`);
      if (violations.midSentence > 0) 
        console.log(`  • Mid-sentence breaks: ${violations.midSentence}/${chunks.length}`);
      if (violations.noPunctuation > 0) 
        console.log(`  • Missing punctuation: ${violations.noPunctuation}/${chunks.length}`);
      if (violations.truncated > 0) 
        console.log(`  • Appears truncated: ${violations.truncated}/${chunks.length}`);
    }
    
    // Determine if using dynamic chunking
    const isDynamic = avgScore >= 60 && violations.midWord === 0;
    
    console.log(`\n${colors.bright}Verdict:${colors.reset} ${isDynamic ? 
      `${colors.green}✅ Using Dynamic Chunking${colors.reset}` : 
      `${colors.red}❌ Using Static Character Splitting${colors.reset}`}`);
    
    if (!isDynamic) {
      console.log(`\n${colors.yellow}Recommendation:${colors.reset}`);
      console.log(`Re-process this document with dynamic chunking to preserve semantic meaning.`);
      console.log(`Dynamic chunking will:`);
      console.log(`  • Keep paragraphs together`);
      console.log(`  • Split at sentence boundaries when needed`);
      console.log(`  • Never break mid-word or mid-sentence`);
    }
    
  } catch (error) {
    console.error(`${colors.red}Error:${colors.reset}`, error);
  }
}

function getScoreColor(score: number): string {
  if (score >= 80) return colors.green;
  if (score >= 60) return colors.yellow;
  return colors.red;
}

async function main() {
  console.log(`${colors.bright}🔍 Semantic Chunking Verification${colors.reset}`);
  console.log('═'.repeat(50));
  console.log(`\nThis tool verifies chunks preserve semantic meaning:`);
  console.log(`• Paragraphs stay together`);
  console.log(`• Long paragraphs split at sentences`);
  console.log(`• No mid-word or mid-sentence breaks\n`);
  
  // Get indices
  const indices = await listIndicesWithNewman();
  const documentIndices = indices.filter(idx => 
    idx.startsWith('file-') || 
    idx.includes('pdf') || 
    idx.includes('document')
  );
  
  if (documentIndices.length === 0) {
    console.log(`${colors.red}No document indices found${colors.reset}`);
    return;
  }
  
  console.log(`Found ${documentIndices.length} document indices:`);
  documentIndices.forEach((idx, i) => {
    console.log(`  ${i + 1}. ${idx}`);
  });
  
  // Let user choose or analyze all
  const args = process.argv.slice(2);
  let indicesToCheck = documentIndices;
  
  if (args.length > 0) {
    // User specified an index
    const specified = args[0];
    if (documentIndices.includes(specified)) {
      indicesToCheck = [specified];
    } else {
      console.log(`\n${colors.yellow}Index '${specified}' not found${colors.reset}`);
      return;
    }
  } else if (documentIndices.length > 3) {
    // Check only most recent if many indices
    console.log(`\n${colors.yellow}Checking 3 most recent indices (use 'npm run verify-chunking INDEX_NAME' for specific)${colors.reset}`);
    indicesToCheck = documentIndices.slice(-3);
  }
  
  // Analyze each index
  for (const indexName of indicesToCheck) {
    await verifyIndexChunking(indexName);
  }
  
  console.log(`\n${colors.gray}Tip: To check a specific index, run:${colors.reset}`);
  console.log(`  npm run verify-chunking <index-name>`);
}

main().catch(console.error);