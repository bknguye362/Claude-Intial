import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadVectorsWithNewman, queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';
import { ContextBuilder } from '../lib/context-builder.js';
import { hybridSearch } from '../lib/hybrid-search.js';
import { detectSectionQuery } from '../lib/metadata-filter-simplified.js';
import { multiQuerySearch } from '../lib/multi-query-search.js';
import { invokeLambda } from '../lib/neptune-lambda-client.js';
import { iterativeGraphReasoning, formatReasoningContext } from '../lib/graph-r1-reasoning.js';

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
  
  // Filter out common words and question words
  const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How', 'Who', 'Which', 'Is', 'Are', 'Was', 'Were', 'Can', 'Could', 'Should', 'Would', 'Tell']);
  
  matches.forEach(match => {
    if (!commonWords.has(match) && match.length > 2) {
      entities.push(match);
      
      // For multi-word names, also add individual parts (e.g., "Guy Montag" → also add "Montag")
      const parts = match.split(/\s+/);
      if (parts.length > 1) {
        parts.forEach(part => {
          if (part.length > 2 && !commonWords.has(part)) {
            entities.push(part);
          }
        });
      }
    }
  });
  
  // Also extract quoted strings
  const quotedPattern = /"([^"]+)"/g;
  let quotedMatch;
  while ((quotedMatch = quotedPattern.exec(text)) !== null) {
    entities.push(quotedMatch[1]);
  }
  
  // Also look for numbers like "451" which could be important
  const numberPattern = /\b\d{3,4}\b/g;
  const numbers = text.match(numberPattern) || [];
  entities.push(...numbers);
  
  return [...new Set(entities)]; // Remove duplicates
}

// Helper function to extract document name from S3 path or hash
function extractDocumentNameFromPath(sourceDocument: string | undefined): string {
  if (!sourceDocument) return 'Document';
  
  // Remove .pdf extension
  let cleanName = sourceDocument.replace('.pdf', '');
  
  // Check if it's a hash (32+ hex characters)
  if (/^[a-f0-9]{32,}$/.test(cleanName)) {
    // For documents with hash names, try to extract from Neptune
    // For now, return a shortened version
    return `Doc-${cleanName.substring(0, 6)}`;
  }
  
  // Check if it starts with our naming convention (file-NAME-date)
  if (cleanName.startsWith('file-')) {
    // Extract the meaningful part between 'file-' and the date
    const parts = cleanName.replace('file-', '').split('-');
    // Remove the date part (last 3 elements: YYYY-MM-DD)
    if (parts.length > 3 && /^\d{4}$/.test(parts[parts.length - 3])) {
      parts.splice(-3); // Remove date
    }
    // Convert remaining parts to readable name
    return parts.join(' ').replace(/_/g, ' ');
  }
  
  // For other formats, just return the clean name
  return cleanName;
}

// Query Neptune graph for related entities
async function queryGraphForEntities(entities: string[], maxEntities: number = 5): Promise<Map<string, any[]>> {
  const relatedEntities = new Map<string, any[]>();
  
  // Limit entities to query
  const entitiesToQuery = entities.slice(0, maxEntities);
  
  for (const entity of entitiesToQuery) {
    try {
      console.log(`[Default Query Tool] 🔍 Searching graph for entity: ${entity}`);
      
      // Use the new searchEntitiesByName operation for proper server-side search
      const result = await invokeLambda({
        operation: 'searchEntitiesByName',
        searchTerm: entity,
        limit: 50
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.entities) {
          // The Lambda now returns properly matched entities
          const matches = response.result.entities;
          
          if (matches.length > 0) {
            relatedEntities.set(entity, matches.slice(0, 3)); // Limit to 3 matches per entity
            console.log(`[Default Query Tool] ✅ Found ${matches.length} graph entities for "${entity}"`);
            console.log(`[Default Query Tool] 🔍 Entity structure for "${entity}":`, JSON.stringify(matches[0], null, 2));
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

// Azure OpenAI configuration for query generation
async function generateQueryVariations(originalQuery: string, minQueries: number = 5): Promise<string[]> {
  console.log(`[Default Query Tool] Generating query variations using Azure OpenAI...`);
  
  const prompt = `You are a search query optimizer. Given a user's question about a document, generate at least ${minQueries} different query variations that would help retrieve relevant information from a vector database.

Original query: "${originalQuery}"

Generate query variations that:
1. Rephrase the question in different ways
2. Focus on different aspects (who, what, when, where, why, how)
3. Use synonyms and related terms
4. Include broader and narrower versions
5. Add context or remove context
6. Break down compound questions into parts
7. Use both question and statement forms
8. Include partial queries that might match different chunks

Return ONLY a JSON array of strings, with no explanation or markdown. Each query should be different and help find different relevant chunks.`;

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-01-01-preview`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY || ''
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that generates search query variations. Always respond with valid JSON arrays only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 500,
        temperature: 0.7,
        top_p: 0.9
      })
    });

    if (!response.ok) {
      throw new Error(`Azure OpenAI error: ${response.status}`);
    }

    const responseData = await response.json() as any;
    const content = responseData.choices[0].message.content;
    
    // Parse the response
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const queries = JSON.parse(cleanContent);
    
    console.log(`[Default Query Tool] Generated ${queries.length} query variations`);
    return queries;
    
  } catch (error) {
    console.log(`[Default Query Tool] Query generation failed, using fallback variations`);
    // Simple fallback
    return [
      originalQuery,
      `Tell me about ${originalQuery}`,
      `Explain ${originalQuery}`,
      `${originalQuery} details`,
      `What is ${originalQuery}`,
      `${originalQuery} information`
    ];
  }
}

export const defaultQueryTool = createTool({
  id: 'default-query',
  description: 'Default tool for handling any user question - automatically vectorizes and stores questions',
  inputSchema: z.object({
    question: z.string().describe('The user\'s question'),
    context: z.string().optional().describe('Additional context for the question'),
    useBedrockWithExpansion: z.boolean().optional().describe('Use Bedrock KB with query expansion instead of Newman'),
    useIterativeReasoning: z.boolean().optional().describe('Use Graph-R1 iterative reasoning for complex queries'),
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
    console.log('[Default Query Tool] - Use Bedrock with Expansion:', context.useBedrockWithExpansion || false);
    
    try {
      // TEMPORARILY: Always use Bedrock with query expansion (Newman disabled)
      const USE_BEDROCK_ALWAYS = true;
      
      // Check if we should use Bedrock with query expansion
      if (USE_BEDROCK_ALWAYS || context.useBedrockWithExpansion) {
        console.log('\n[Default Query Tool] 🚀 USING BEDROCK KB WITH AZURE OPENAI QUERY EXPANSION');
        console.log('[Default Query Tool] =====================================');
        
        // Import Bedrock client dynamically
        const { BedrockAgentRuntimeClient, RetrieveCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
        const kbClient = new BedrockAgentRuntimeClient({ 
          region: 'us-east-2',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
          }
        });
        
        // Step 1: Query knowledge graph for related entities
        console.log('[Default Query Tool] 📊 GRAPH ENHANCEMENT for Bedrock queries');
        const questionEntities = extractEntitiesFromText(context.question);
        console.log(`[Default Query Tool] Extracted ${questionEntities.length} potential entities: ${questionEntities.join(', ')}`);
        
        let graphEntities: Map<string, any[]> = new Map();
        let graphEnhancedQueries: string[] = [];
        
        if (questionEntities.length > 0) {
          try {
            console.log('[Default Query Tool] Calling queryGraphForEntities...');
            graphEntities = await queryGraphForEntities(questionEntities, 5);
            
            if (graphEntities.size > 0) {
              console.log(`[Default Query Tool] 📊 Found ${graphEntities.size} entities in knowledge graph`);
              
              // Add entity-specific queries to our variations
              for (const [entityName, relationships] of graphEntities) {
                // Add queries about this entity
                graphEnhancedQueries.push(`${entityName}`);
                graphEnhancedQueries.push(`Tell me about ${entityName}`);
                
                // Add queries about relationships
                relationships.forEach(rel => {
                  if (rel.object && rel.object !== entityName) {
                    graphEnhancedQueries.push(`${entityName} and ${rel.object}`);
                  }
                });
              }
              
              console.log(`[Default Query Tool] Generated ${graphEnhancedQueries.length} graph-enhanced queries`);
            } else {
              console.log('[Default Query Tool] No matching entities found in graph');
            }
          } catch (graphError) {
            console.log('[Default Query Tool] ⚠️ Graph query failed:', graphError);
            console.log('[Default Query Tool] Continuing with standard query expansion');
          }
        }
        
        // Step 1.5: Use iterative reasoning if requested
        let iterativeReasoningContext = '';
        if (context.useIterativeReasoning) {
          console.log('[Default Query Tool] 🧠 Using Graph-R1 iterative reasoning');
          try {
            const reasoningResult = await iterativeGraphReasoning(context.question, 3, 0.7);
            iterativeReasoningContext = formatReasoningContext(reasoningResult);
            if (iterativeReasoningContext) {
              console.log('[Default Query Tool] Iterative reasoning found relevant graph knowledge');
            }
          } catch (reasoningError) {
            console.error('[Default Query Tool] Iterative reasoning failed:', reasoningError);
          }
        }
        
        // Generate query variations using Azure OpenAI
        const queryVariations = await generateQueryVariations(context.question, 7);
        
        // Combine graph-enhanced queries with AI-generated variations
        const allVariations = [context.question]; // Start with original
        
        // Add graph-enhanced queries first (they're more targeted)
        graphEnhancedQueries.forEach(q => {
          if (!allVariations.includes(q)) {
            allVariations.push(q);
          }
        });
        
        // Add AI-generated variations
        queryVariations.forEach(q => {
          if (!allVariations.includes(q)) {
            allVariations.push(q);
          }
        });
        
        const finalVariations = allVariations.slice(0, 12); // Allow up to 12 queries with graph enhancement
        console.log('[Default Query Tool] Query variations:');
        finalVariations.forEach((q, i) => {
          console.log(`[Default Query Tool]   ${i + 1}. "${q}"`);
        });
        
        // Execute all queries against Bedrock
        console.log('\n[Default Query Tool] Executing queries against Bedrock KB...');
        let allResults = new Map();
        const queryStats: any[] = [];
        
        for (const query of finalVariations) {
          const command = new RetrieveCommand({
            knowledgeBaseId: 'FQ7HMGJHKP', // TODO: Make this configurable
            retrievalQuery: { text: query },
            retrievalConfiguration: {
              vectorSearchConfiguration: {
                numberOfResults: 30
              }
            }
          });
          
          try {
            const response = await kbClient.send(command);
            const results = response.retrievalResults || [];
            
            let newChunks = 0;
            for (const result of results) {
              const key = result.content?.text?.substring(0, 150);
              if (key && !allResults.has(key)) {
                allResults.set(key, {
                  content: result.content?.text || '',
                  score: result.score,
                  metadata: {
                    sourceQuery: query,
                    matchedQueries: [query],
                    sourceDocument: result.metadata?.sourceDocument || 'Unknown',
                    pageNumber: result.metadata?.pageNumber,
                    chunkIndex: result.metadata?.chunkIndex,
                    totalChunks: result.metadata?.totalChunks
                  }
                });
                newChunks++;
              } else if (key && allResults.has(key)) {
                allResults.get(key).metadata.matchedQueries.push(query);
              }
            }
            
            // Calculate score range for this query
            let scoreInfo = '';
            if (results.length > 0) {
              const scores = results.map(r => r.score).filter(s => s !== undefined && s !== null);
              if (scores.length > 0) {
                const minScore = Math.min(...scores);
                const maxScore = Math.max(...scores);
                scoreInfo = `, scores: ${minScore.toFixed(3)}-${maxScore.toFixed(3)}`;
              }
            }
            
            queryStats.push({
              query,
              totalResults: results.length,
              newChunks,
              scoreRange: scoreInfo
            });
            
            console.log(`[Default Query Tool]   ✓ Query ${queryStats.length}: ${results.length} chunks (${newChunks} new)${scoreInfo}`);
            
          } catch (error) {
            console.log(`[Default Query Tool]   ✗ Query failed: ${error}`);
          }
        }
        
        // Extract entities from all Bedrock results for graph filtering
        console.log('\n[Default Query Tool] Extracting entities from Bedrock results for graph filtering...');
        const bedrockEntities = new Set<string>();
        
        // Extract entities from all retrieved chunks
        for (const result of allResults.values()) {
          const chunkEntities = extractEntitiesFromText(result.content);
          chunkEntities.forEach(entity => bedrockEntities.add(entity));
        }
        
        console.log(`[Default Query Tool]   Found ${bedrockEntities.size} unique entities in Bedrock results`);
        
        // Query Neptune graph for these entities
        let bedrockGraphEntities: Map<string, any[]> = new Map();
        if (bedrockEntities.size > 0) {
          try {
            const entitiesToQuery = Array.from(bedrockEntities).slice(0, 10); // Limit to 10 most relevant
            console.log(`[Default Query Tool]   Querying graph for top ${entitiesToQuery.length} entities...`);
            bedrockGraphEntities = await queryGraphForEntities(entitiesToQuery, 10);
            
            if (bedrockGraphEntities.size > 0) {
              console.log(`[Default Query Tool]   ✅ Found ${bedrockGraphEntities.size} entities in knowledge graph`);
              
              // Create a set of valid entities from graph
              const validEntities = new Set<string>();
              for (const [entity, relationships] of bedrockGraphEntities) {
                validEntities.add(entity.toLowerCase());
                // Also add related entities
                relationships.forEach(rel => {
                  if (rel.object) validEntities.add(rel.object.toLowerCase());
                });
              }
              
              // Graph filtering: Either strict filtering or boosting based on configuration
              const USE_STRICT_FILTERING = true; // Set to false for boosting only
              
              if (USE_STRICT_FILTERING) {
                console.log(`[Default Query Tool]   Applying STRICT graph filtering (only keeping chunks with graph entities)...`);
              } else {
                console.log(`[Default Query Tool]   Applying graph BOOSTING (20% score boost for chunks with graph entities)...`);
              }
              
              const filteredResults = new Map();
              let filteredCount = 0;
              
              for (const [key, result] of allResults) {
                const contentLower = result.content.toLowerCase();
                let hasValidEntity = false;
                
                // Check if chunk contains any validated entities
                for (const entity of validEntities) {
                  if (contentLower.includes(entity)) {
                    hasValidEntity = true;
                    result.graphValidated = true;
                    result.matchedEntity = entity;
                    // Boost score for graph-validated content
                    result.score = (result.score || 0.5) * 1.2;
                    break;
                  }
                }
                
                // Apply filtering or boosting based on mode
                if (USE_STRICT_FILTERING) {
                  // STRICT MODE: Only keep chunks with validated entities
                  if (hasValidEntity) {
                    filteredResults.set(key, result);
                    filteredCount++;
                  }
                } else {
                  // BOOSTING MODE: Keep all chunks, boost those with entities
                  filteredResults.set(key, result);
                  if (hasValidEntity) {
                    filteredCount++;
                  }
                }
              }
              
              console.log(`[Default Query Tool]   Graph filtering complete:`);
              console.log(`[Default Query Tool]     - Original chunks: ${allResults.size}`);
              
              if (USE_STRICT_FILTERING) {
                console.log(`[Default Query Tool]     - After filtering: ${filteredResults.size}`);
                console.log(`[Default Query Tool]     - Removed: ${allResults.size - filteredResults.size} chunks without graph entities`);
                console.log(`[Default Query Tool]     - Mode: STRICT FILTERING`);
              } else {
                console.log(`[Default Query Tool]     - Chunks with graph boost: ${filteredCount}`);
                console.log(`[Default Query Tool]     - Chunks without boost: ${allResults.size - filteredCount}`);
                console.log(`[Default Query Tool]     - Mode: SCORE BOOSTING`);
              }
              
              // Replace allResults with filtered results
              allResults = filteredResults;
              
              // If no chunks pass the filter, log a warning
              if (USE_STRICT_FILTERING && allResults.size === 0) {
                console.log(`[Default Query Tool]   ⚠️ WARNING: No chunks contain graph-validated entities!`);
                console.log(`[Default Query Tool]   Consider using boosting mode or checking graph data`);
              }
            }
          } catch (error) {
            console.log(`[Default Query Tool]   ⚠️ Graph filtering failed:`, error);
          }
        }
        
        // Prepare results in format similar to Newman results
        // Sort by score and limit to top results to avoid content filter issues
        const sortedResults = Array.from(allResults.values())
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 30); // Limit to top 30 chunks to provide more context
        
        const bedrockResults = sortedResults.map(r => {
          // Truncate content to avoid content filter issues
          const maxChunkLength = 1000; // Limit each chunk to 1000 characters (reduced from 2000)
          const truncatedContent = r.content.length > maxChunkLength 
            ? r.content.substring(0, maxChunkLength) + '...[truncated]'
            : r.content;
          
          return {
            content: truncatedContent, // Store truncated content ONLY here
            metadata: {
              // Don't duplicate content in metadata
              originalLength: r.content.length,
              truncated: r.content.length > maxChunkLength,
              sourceQuery: r.metadata?.sourceQuery,
              matchedQueries: r.metadata?.matchedQueries,
              graphValidated: r.graphValidated || false,
              matchedEntity: r.matchedEntity || null,
              // Preserve Bedrock metadata
              sourceDocument: r.metadata?.sourceDocument,
              pageNumber: r.metadata?.pageNumber,
              chunkIndex: r.metadata?.chunkIndex,
              totalChunks: r.metadata?.totalChunks
            },
            score: r.score,
            distance: 1 - (r.score || 0), // Convert score to distance
            index: 'bedrock-kb'
          };
        });
        
        // Calculate total size after truncation
        const totalContentSize = bedrockResults.reduce((sum, r) => sum + r.content.length, 0);
        
        console.log(`\n[Default Query Tool] Bedrock retrieval complete:`);
        console.log(`[Default Query Tool]   Initial chunks retrieved: ${sortedResults.length}`);
        console.log(`[Default Query Tool]   Graph-validated chunks: ${bedrockResults.filter(r => r.metadata.graphValidated).length}`);
        console.log(`[Default Query Tool]   Chunks sent to LLM: ${bedrockResults.length} (ALL are graph-validated)`);
        console.log(`[Default Query Tool]   Total content size: ${totalContentSize} characters (after truncation)`);
        console.log(`[Default Query Tool]   Average chunk size: ${Math.round(totalContentSize / bedrockResults.length)} characters`);
        console.log(`[Default Query Tool]   Expected message size: ~${Math.round(totalContentSize * 1.5)} characters (with metadata)`);
        console.log(`[Default Query Tool]   Single query would have returned: ~11 chunks`);
        
        // Show score distribution of final results
        if (bedrockResults.length > 0) {
          const scores = bedrockResults.map(r => r.score).filter(s => s !== undefined && s !== null);
          if (scores.length > 0) {
            const minScore = Math.min(...scores);
            const maxScore = Math.max(...scores);
            const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
            console.log(`[Default Query Tool]   Score distribution: min=${minScore.toFixed(3)}, max=${maxScore.toFixed(3)}, avg=${avgScore.toFixed(3)}`);
            
            // Show score buckets
            const buckets = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 1.0];
            console.log(`[Default Query Tool]   Score buckets:`);
            for (let i = 0; i < buckets.length - 1; i++) {
              const count = scores.filter(s => s >= buckets[i] && s < buckets[i+1]).length;
              if (count > 0) {
                console.log(`[Default Query Tool]     ${buckets[i].toFixed(2)}-${buckets[i+1].toFixed(2)}: ${count} chunks`);
              }
            }
          }
        }
        
        // Debug: Check if we have actual content
        if (bedrockResults.length > 0) {
          const firstResult = bedrockResults[0];
          console.log(`[Default Query Tool] First Bedrock result content check:`);
          console.log(`[Default Query Tool]   - Has content field: ${!!firstResult.content}`);
          console.log(`[Default Query Tool]   - Content length: ${firstResult.content ? firstResult.content.length : 0}`);
          console.log(`[Default Query Tool]   - Score: ${firstResult.score?.toFixed(3)}`);
          console.log(`[Default Query Tool]   - Content preview: "${(firstResult.content || '').substring(0, 100)}..."`);
        }
        
        // Build contextualized chunks for ContextBuilder
        // Don't include individual citations to encourage synthesis
        const contextualizedChunks = bedrockResults.map((r, idx) => ({
          key: `bedrock-chunk-${idx}`,
          score: r.score || 0,
          distance: r.distance,
          index: r.index,
          content: r.content || '',
          metadata: {
            ...r.metadata,
            matchCount: r.metadata.matchedQueries?.length || 1
          },
          context: {
            documentId: extractDocumentNameFromPath(r.metadata?.sourceDocument) || 'Document',
            pageStart: r.metadata?.pageNumber,
            pageEnd: r.metadata?.pageNumber,
            chunkIndex: r.metadata?.chunkIndex || idx,
            totalChunks: r.metadata?.totalChunks || bedrockResults.length,
            // Remove per-chunk citations to encourage synthesis
            citation: undefined
          }
        }));
        
        // Debug: Log first chunk content
        if (contextualizedChunks.length > 0) {
          console.log(`[Default Query Tool] First chunk content preview: "${contextualizedChunks[0].content.substring(0, 100)}..."`);
          console.log(`[Default Query Tool] Total contextualized chunks: ${contextualizedChunks.length}`);
        } else {
          console.log(`[Default Query Tool] WARNING: No contextualized chunks created!`);
        }
        
        // Use ContextBuilder to create enhanced response
        const contextualResponse = ContextBuilder.buildContextualResponse(contextualizedChunks);
        
        // Merge graph entities from both query and Bedrock results
        const allGraphEntities = new Map([...graphEntities, ...bedrockGraphEntities]);
        
        // Build graph context if we have entities
        let graphContextString = '';
        if (allGraphEntities.size > 0) {
          graphContextString = '\n📊 KNOWLEDGE GRAPH CONTEXT:\n';
          
          // Separate query-based and content-based entities
          if (graphEntities.size > 0) {
            graphContextString += '\nEntities from your query:\n';
            for (const [entityName, entityList] of graphEntities) {
              graphContextString += `\n• ${entityName}:\n`;
              entityList.forEach(entity => {
                const name = entity.name?.[0] || entityName;
                const description = entity.description?.[0] || 'No description available';
                const entityType = entity.entityType?.[0] || 'Unknown type';
                graphContextString += `  - Type: ${entityType}\n`;
                graphContextString += `  - Name: ${name}\n`;
                graphContextString += `  - Description: ${description}\n`;
              });
            }
          }
          
          if (bedrockGraphEntities.size > 0) {
            graphContextString += '\nEntities found in retrieved content:\n';
            for (const [entityName, entityList] of bedrockGraphEntities) {
              // Skip if already shown in query entities
              if (!graphEntities.has(entityName)) {
                graphContextString += `\n• ${entityName}:\n`;
                entityList.forEach(entity => {
                  const name = entity.name?.[0] || entityName;
                  const description = entity.description?.[0] || 'No description available';
                  const entityType = entity.entityType?.[0] || 'Unknown type';
                  graphContextString += `  - Type: ${entityType}\n`;
                  graphContextString += `  - Name: ${name}\n`;
                  graphContextString += `  - Description: ${description}\n`;
                });
              }
            }
          }
          
          graphContextString += '\n';
        }
        
        // Add synthesis instruction to the context with content-filter-safe language
        const synthesisInstruction = `\n\n📝 RESPONSE GUIDELINES: Please provide a comprehensive and complete answer based on the following information. Synthesize all the information into a well-organized response. DO NOT include citations, references, or source attributions like [Document], [chunk], or [page] in your response. Present the information naturally as if it's your own knowledge. Important: Ensure your response is complete and not truncated.\n\n`;
        
        const enhancedContextString = synthesisInstruction + iterativeReasoningContext + graphContextString + contextualResponse.contextString;
        
        // Debug: Log context string
        console.log(`[Default Query Tool] Context string length: ${enhancedContextString.length} chars`);
        console.log(`[Default Query Tool] Context preview: "${enhancedContextString.substring(0, 200)}..."`);
        
        // Final validation before returning
        console.log(`[Default Query Tool] FINAL RETURN CHECK:`);
        console.log(`[Default Query Tool]   - success: true`);
        console.log(`[Default Query Tool]   - similarChunks length: ${contextualResponse.chunks.length}`);
        console.log(`[Default Query Tool]   - contextString length: ${enhancedContextString.length}`);
        console.log(`[Default Query Tool]   - totalSimilarChunks: ${contextualResponse.chunks.length}`);
        if (contextualResponse.chunks.length === 0) {
          console.log(`[Default Query Tool] ⚠️ WARNING: Returning ZERO chunks! Agent will say "no content found"`);
        }
        
        return {
          success: true,
          similarChunks: contextualResponse.chunks,
          contextString: enhancedContextString,
          totalSimilarChunks: contextualResponse.chunks.length,
          documentContext: {
            documentsFound: contextualResponse.documentSummary.length,
            summary: contextualResponse.documentSummary
          },
          citations: contextualResponse.citations,
          queryExpansion: {
            variationsUsed: finalVariations.length,
            stats: queryStats,
            graphEnhanced: graphEntities.size > 0 || bedrockGraphEntities.size > 0,
            graphEntitiesFromQuery: graphEntities.size,
            graphEntitiesFromContent: bedrockGraphEntities.size,
            graphQueriesAdded: graphEnhancedQueries.length,
            graphValidatedChunks: bedrockResults.filter(r => r.metadata.graphValidated).length,
            strictFiltering: true
          },
          message: `Found ${bedrockResults.length} unique chunks using Bedrock KB with query expansion`,
          timestamp: new Date().toISOString(),
          questionLength: context.question.length
        };
      }
      
      // Original Newman-based logic
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