import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { queryVectorsWithNewman, listIndicesWithNewman } from '../lib/newman-executor.js';
import { ContextBuilder } from '../lib/context-builder.js';
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

async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Graph Enhanced Query] No API key for embeddings, using mock embeddings...');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  // Implement retry logic with exponential backoff for rate limiting
  let retries = 3;
  let delay = 2000; // Start with 2 second delay
  
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
        console.log(`[Graph Enhanced Query] Rate limited (429). Waiting ${delay}ms before retry. Retries left: ${retries - 1}`);
        await wait(delay);
        delay *= 2;
        retries--;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      if (retries > 1) {
        console.log(`[Graph Enhanced Query] Error generating embedding, retrying in ${delay}ms...`);
        await wait(delay);
        delay *= 2;
        retries--;
        continue;
      }
      
      console.error('[Graph Enhanced Query] Error generating embedding after retries:', error);
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    }
  }
  
  // If we exhausted all retries, fall back
  const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
}

// Extract entities from text using simple NER patterns
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
async function queryGraphForEntities(entities: string[]): Promise<Map<string, any[]>> {
  const relatedEntities = new Map<string, any[]>();
  
  for (const entity of entities) {
    try {
      console.log(`[Graph Enhanced Query] Querying graph for entity: ${entity}`);
      
      // Query for entities by name
      const result = await invokeLambda({
        operation: 'queryEntitiesByType',
        limit: 10
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.entities) {
          // Filter entities that match or are related to our query entity
          const matches = response.result.entities.filter((e: any) => {
            const name = e.name?.[0] || '';
            return name.toLowerCase().includes(entity.toLowerCase()) || 
                   entity.toLowerCase().includes(name.toLowerCase());
          });
          
          if (matches.length > 0) {
            relatedEntities.set(entity, matches);
            console.log(`[Graph Enhanced Query] Found ${matches.length} related entities for "${entity}"`);
            
            // Get relationships for each matched entity
            for (const match of matches.slice(0, 3)) { // Limit to top 3 to avoid too many queries
              const entityId = match.entityId?.[0];
              if (entityId) {
                try {
                  const relResult = await invokeLambda({
                    operation: 'getEntityRelationships',
                    entityId: entityId
                  });
                  
                  if (relResult.body) {
                    const relResponse = JSON.parse(relResult.body);
                    if (relResponse.result) {
                      match.relationships = relResponse.result;
                      console.log(`[Graph Enhanced Query] Found ${relResponse.result.totalRelationships} relationships for ${match.name?.[0]}`);
                    }
                  }
                } catch (relError) {
                  console.error(`[Graph Enhanced Query] Error getting relationships for ${entityId}:`, relError);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Graph Enhanced Query] Error querying graph for entity "${entity}":`, error);
    }
  }
  
  return relatedEntities;
}

// Get chunks that contain specific entities
async function getChunksForEntities(entityIds: string[]): Promise<any[]> {
  const chunks: any[] = [];
  
  for (const entityId of entityIds) {
    try {
      // Query for chunks where this entity appears
      const result = await invokeLambda({
        operation: 'getEntityRelationships',
        entityId: entityId
      });
      
      if (result.body) {
        const response = JSON.parse(result.body);
        if (response.result?.outgoing) {
          // Look for APPEARS_IN relationships to chunks
          const chunkRelations = response.result.outgoing.filter((rel: any) => 
            rel.type === 'APPEARS_IN'
          );
          
          for (const rel of chunkRelations) {
            // Get the chunk details
            const chunkId = rel.to;
            if (chunkId) {
              try {
                const chunkResult = await invokeLambda({
                  operation: 'getChunkProperties',
                  chunkId: chunkId
                });
                
                if (chunkResult.body) {
                  const chunkResponse = JSON.parse(chunkResult.body);
                  if (chunkResponse.result?.chunks) {
                    chunks.push(...chunkResponse.result.chunks);
                  }
                }
              } catch (chunkError) {
                console.error(`[Graph Enhanced Query] Error getting chunk ${chunkId}:`, chunkError);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Graph Enhanced Query] Error getting chunks for entity ${entityId}:`, error);
    }
  }
  
  return chunks;
}

export const graphEnhancedQueryTool = createTool({
  id: 'graph-enhanced-query',
  description: 'Query documents with knowledge graph enhancement - finds related entities and their context',
  inputSchema: z.object({
    question: z.string().describe('The user\'s question'),
    useGraphEnhancement: z.boolean().optional().default(true).describe('Whether to use knowledge graph for enhancement'),
    maxGraphEntities: z.number().optional().default(5).describe('Maximum number of entities to query from graph'),
  }),
  execute: async ({ context }) => {
    console.log('[Graph Enhanced Query] ========= GRAPH-ENHANCED QUERY =========');
    console.log(`[Graph Enhanced Query] Question: "${context.question}"`);
    console.log(`[Graph Enhanced Query] Graph Enhancement: ${context.useGraphEnhancement}`);
    
    try {
      // Step 1: Generate embedding for the question
      console.log('[Graph Enhanced Query] 1. Generating embedding for question...');
      const embedding = await generateEmbedding(context.question);
      console.log(`[Graph Enhanced Query]    Embedding generated, length: ${embedding.length}`);
      
      // Step 2: Extract entities from the question
      let graphEntities: Map<string, any[]> = new Map();
      let graphChunks: any[] = [];
      
      if (context.useGraphEnhancement) {
        console.log('[Graph Enhanced Query] 2. Extracting entities from question...');
        const questionEntities = extractEntitiesFromText(context.question);
        console.log(`[Graph Enhanced Query]    Found ${questionEntities.length} potential entities: ${questionEntities.join(', ')}`);
        
        // Step 3: Query knowledge graph for related entities
        if (questionEntities.length > 0) {
          console.log('[Graph Enhanced Query] 3. Querying knowledge graph for related entities...');
          graphEntities = await queryGraphForEntities(questionEntities.slice(0, context.maxGraphEntities));
          console.log(`[Graph Enhanced Query]    Found related entities for ${graphEntities.size} query terms`);
          
          // Collect all entity IDs for chunk retrieval
          const allEntityIds: string[] = [];
          graphEntities.forEach((entities, key) => {
            entities.forEach(entity => {
              const entityId = entity.entityId?.[0];
              if (entityId) {
                allEntityIds.push(entityId);
              }
            });
          });
          
          // Step 4: Get chunks where these entities appear
          if (allEntityIds.length > 0) {
            console.log(`[Graph Enhanced Query] 4. Getting chunks for ${allEntityIds.length} entities...`);
            graphChunks = await getChunksForEntities(allEntityIds.slice(0, 10)); // Limit to avoid too many queries
            console.log(`[Graph Enhanced Query]    Found ${graphChunks.length} chunks from graph`);
          }
        }
      }
      
      // Step 5: Perform regular vector search
      console.log('[Graph Enhanced Query] 5. Performing vector similarity search...');
      const indices = await listIndicesWithNewman();
      console.log(`[Graph Enhanced Query]    Searching ${indices.length} indices`);
      
      const allResults: any[] = [];
      
      for (const indexName of indices) {
        try {
          const results = await queryVectorsWithNewman(indexName, embedding, 20);
          if (results.length > 0) {
            const indexedResults = results.map((r: any, idx: number) => ({
              ...r,
              index: indexName,
              score: 1.0 - (idx * 0.05)
            }));
            allResults.push(...indexedResults);
          }
        } catch (error) {
          console.error(`[Graph Enhanced Query] Error querying ${indexName}:`, error);
        }
      }
      
      // Step 6: Combine and rank results
      console.log('[Graph Enhanced Query] 6. Combining vector search and graph results...');
      
      // Boost scores for chunks that contain graph entities
      const entityChunkIds = new Set(graphChunks.map(c => c.chunkId?.[0]).filter(Boolean));
      
      const enhancedResults = allResults.map(result => {
        let enhancedScore = result.score || 0;
        let graphBoost = 0;
        
        // Check if this chunk contains any of our graph entities
        if (entityChunkIds.has(result.key)) {
          graphBoost = 0.2; // Boost score by 20% for graph-related chunks
          console.log(`[Graph Enhanced Query]    Boosting chunk ${result.key} (contains graph entities)`);
        }
        
        // Check if chunk content mentions any of our entities
        const content = result.metadata?.chunkContent || result.metadata?.content || '';
        graphEntities.forEach((entities, queryTerm) => {
          entities.forEach(entity => {
            const entityName = entity.name?.[0] || '';
            if (entityName && content.toLowerCase().includes(entityName.toLowerCase())) {
              graphBoost = Math.max(graphBoost, 0.15);
            }
          });
        });
        
        return {
          ...result,
          score: enhancedScore + graphBoost,
          graphEnhanced: graphBoost > 0,
          relatedEntities: graphBoost > 0 ? Array.from(graphEntities.keys()) : []
        };
      });
      
      // Sort by enhanced score
      enhancedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      
      // Take top results
      const topResults = enhancedResults.slice(0, 30);
      
      console.log(`[Graph Enhanced Query] 7. Selected top ${topResults.length} results`);
      const graphEnhancedCount = topResults.filter(r => r.graphEnhanced).length;
      console.log(`[Graph Enhanced Query]    ${graphEnhancedCount} results enhanced with graph data`);
      
      // Build contextualized response
      const contextualizedChunks = topResults.map(r => ({
        key: r.key,
        score: r.score || 0,
        distance: r.distance,
        index: r.index || 'unknown',
        content: r.metadata?.chunkContent || r.metadata?.content || '',
        metadata: {
          ...r.metadata,
          graphEnhanced: r.graphEnhanced,
          relatedEntities: r.relatedEntities
        },
        context: {
          documentId: r.metadata?.documentId || r.index || 'unknown',
          pageStart: r.metadata?.pageStart,
          pageEnd: r.metadata?.pageEnd,
          chunkIndex: r.metadata?.chunkIndex,
          totalChunks: r.metadata?.totalChunks
        }
      }));
      
      const contextualResponse = ContextBuilder.buildContextualResponse(contextualizedChunks);
      
      // Build comprehensive graph context for LLM
      let graphContextString = '';
      const entityDetails: any[] = [];
      
      if (graphEntities.size > 0) {
        graphContextString += '\n\n📊 KNOWLEDGE GRAPH CONTEXT:\n';
        graphContextString += '================================\n';
        
        graphEntities.forEach((entities, queryTerm) => {
          if (entities.length > 0) {
            graphContextString += `\n🔍 Related to "${queryTerm}":\n`;
            
            entities.forEach(entity => {
              const name = entity.name?.[0] || '';
              const type = entity.entityType?.[0] || '';
              const description = entity.description?.[0] || '';
              
              graphContextString += `\n• ${name} (${type})\n`;
              if (description) {
                graphContextString += `  Description: ${description}\n`;
              }
              
              // Add relationships if available
              if (entity.relationships) {
                if (entity.relationships.outgoing && entity.relationships.outgoing.length > 0) {
                  graphContextString += `  Relationships:\n`;
                  entity.relationships.outgoing.slice(0, 5).forEach((rel: any) => {
                    graphContextString += `    → ${rel.type} → ${rel.to}\n`;
                  });
                }
                if (entity.relationships.incoming && entity.relationships.incoming.length > 0) {
                  graphContextString += `  Referenced by:\n`;
                  entity.relationships.incoming.slice(0, 5).forEach((rel: any) => {
                    graphContextString += `    ← ${rel.type} ← ${rel.from}\n`;
                  });
                }
              }
              
              entityDetails.push({
                name,
                type,
                description,
                relationshipCount: entity.relationships?.totalRelationships || 0,
                outgoingRelationships: entity.relationships?.outgoing?.slice(0, 5) || [],
                incomingRelationships: entity.relationships?.incoming?.slice(0, 5) || []
              });
            });
          }
        });
        
        graphContextString += '\n================================\n';
        graphContextString += `Found ${entityDetails.length} relevant entities in the knowledge graph.\n`;
        graphContextString += `${graphEnhancedCount} search results were enhanced with graph data.\n`;
      }
      
      // Add graph entities to the response
      const graphSummary = {
        entitiesFound: graphEntities.size,
        entities: Array.from(graphEntities.entries()).map(([query, entities]) => ({
          queryTerm: query,
          relatedEntities: entities.map(e => ({
            name: e.name?.[0] || '',
            type: e.entityType?.[0] || '',
            description: e.description?.[0] || '',
            relationshipCount: e.relationships?.totalRelationships || 0,
            relationships: {
              outgoing: e.relationships?.outgoing?.slice(0, 5).map((r: any) => ({
                type: r.type,
                target: r.to
              })) || [],
              incoming: e.relationships?.incoming?.slice(0, 5).map((r: any) => ({
                type: r.type,
                source: r.from
              })) || []
            }
          }))
        })),
        graphEnhancedChunks: graphEnhancedCount,
        graphContextString: graphContextString
      };
      
      // Combine document context with graph context for the LLM
      const combinedContextString = contextualResponse.contextString + graphContextString;
      
      return {
        success: true,
        message: 'Graph-enhanced query completed',
        timestamp: new Date().toISOString(),
        similarChunks: contextualResponse.chunks,
        totalSimilarChunks: contextualResponse.chunks.length,
        documentContext: {
          documentsFound: contextualResponse.documentSummary.length,
          summary: contextualResponse.documentSummary
        },
        contextString: combinedContextString,  // Combined context for LLM
        citations: contextualResponse.citations,
        graphEnhancement: graphSummary,  // Detailed graph data
        debug: {
          indicesSearched: indices.length,
          totalResults: allResults.length,
          graphEntitiesQueried: graphEntities.size,
          graphChunksFound: graphChunks.length,
          enhancedChunks: graphEnhancedCount
        }
      };
      
    } catch (error) {
      console.error('[Graph Enhanced Query] Error:', error);
      return {
        success: false,
        message: 'Error processing graph-enhanced query',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
});