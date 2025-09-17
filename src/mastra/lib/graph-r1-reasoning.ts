// Graph-R1 inspired iterative reasoning system
// Based on https://github.com/LHRLAB/Graph-R1

import { invokeLambda } from './neptune-lambda-client.js';

interface ReasoningStep {
  iteration: number;
  thought: string;
  queries: string[];
  retrievedEntities: any[];
  retrievedRelationships: any[];
  confidence: number;
  needsMoreInfo: boolean;
}

interface ReasoningContext {
  originalQuery: string;
  steps: ReasoningStep[];
  finalAnswer?: string;
  allEntities: Set<string>;
  allRelationships: Set<string>;
}

// Step 1: Think - Analyze the query and current knowledge
function think(query: string, context: ReasoningContext): string {
  if (context.steps.length === 0) {
    return `Starting analysis of: "${query}". Need to identify key entities and relationships to answer this question.`;
  }

  const lastStep = context.steps[context.steps.length - 1];
  const foundInLast = lastStep.retrievedEntities.length;

  if (foundInLast === 0) {
    return `Previous search yielded no results. Need to try different search terms or broader concepts related to: "${query}".`;
  }

  return `Found ${foundInLast} entities in last search. Total: ${context.allEntities.size} entities and ${context.allRelationships.size} relationships. Analyzing what additional information is needed for: "${query}".`;
}

// Step 2: Generate graph queries using LLM
async function generateGraphQueries(
  thought: string,
  query: string,
  context: ReasoningContext,
  iteration: number = 1
): Promise<string[]> {
  // Prepare context summary for LLM
  const currentKnowledge = context.allEntities.size > 0
    ? `Current knowledge includes ${context.allEntities.size} entities and ${context.allRelationships.size} relationships.`
    : 'No entities discovered yet.';

  const exploredEntities = Array.from(context.allEntities).slice(0, 10).join(', ');

  // Call Azure OpenAI to generate queries
  const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || '';

  const prompt = `You are a knowledge graph query generator. Based on the current reasoning state, generate search queries to find relevant entities and relationships.

Original Question: ${query}
Current Thinking: ${thought}
${currentKnowledge}
${exploredEntities ? `Already explored entities (sample): ${exploredEntities}` : ''}
Iteration: ${iteration}

Generate 3-5 specific search queries that would help answer the original question. These should be:
1. Entity names (people, places, things)
2. Concepts or events
3. Related terms that might exist in a knowledge graph about this topic

Avoid queries for entities you've already explored.

Return ONLY a JSON array of query strings, nothing else.
Example: ["Napoleon", "windmill", "expulsion event"]`;

  try {
    const response = await fetch(`${AZURE_ENDPOINT}/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-01-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a query generator for a knowledge graph. Generate only search terms, return them as a JSON array.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 150
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Graph-R1] LLM query generation failed:', response.status);
      console.error('[Graph-R1] Error details:', errorText.substring(0, 200));
      console.error('[Graph-R1] URL:', `${AZURE_ENDPOINT}/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-01-01-preview`);
      console.error('[Graph-R1] API Key present:', !!AZURE_API_KEY);
      // Fallback to basic extraction
      return extractBasicEntities(query, context.allEntities);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    // Parse the JSON response
    try {
      const queries = JSON.parse(content);
      if (Array.isArray(queries)) {
        // Filter out already explored entities
        return queries.filter((q: string) =>
          typeof q === 'string' &&
          q.length > 0 &&
          !Array.from(context.allEntities).some(e =>
            e.toLowerCase().includes(q.toLowerCase()) ||
            q.toLowerCase().includes(e.toLowerCase())
          )
        ).slice(0, 5); // Limit to 5 queries
      }
    } catch (parseError) {
      console.error('[Graph-R1] Failed to parse LLM response:', content);
    }
  } catch (error) {
    console.error('[Graph-R1] LLM query generation error:', error);
  }

  // Fallback to basic extraction if LLM fails
  return extractBasicEntities(query, context.allEntities);
}

// Fallback function for basic entity extraction
function extractBasicEntities(query: string, existingEntities: Set<string>): string[] {
  const queries: string[] = [];

  // Extract potential entity names from the query
  const words = query.toLowerCase().split(/\s+/);
  const potentialEntities = words.filter(w =>
    w.length > 2 &&
    !['the', 'and', 'or', 'but', 'with', 'from', 'what', 'who', 'where', 'when', 'why', 'how'].includes(w)
  );

  // Also look for capitalized words
  const properNouns = query.match(/[A-Z][a-z]+/g) || [];

  [...potentialEntities, ...properNouns].forEach(entity => {
    const entityLower = entity.toLowerCase();
    if (!existingEntities.has(entityLower) && !queries.includes(entity)) {
      queries.push(entity);
    }
  });

  return queries.slice(0, 3); // Return top 3
}

// Step 3: Retrieve subgraph from Neptune
async function retrieveSubgraph(queries: string[]): Promise<{ entities: any[], relationships: any[] }> {
  const entities: any[] = [];
  const relationships: any[] = [];
  
  for (const searchTerm of queries) {
    try {
      // Search for entities by name
      const searchResult = await invokeLambda({
        operation: 'searchEntitiesByName',
        searchTerm,
        limit: 10
      });
      
      if (searchResult.body) {
        const body = JSON.parse(searchResult.body);
        if (body.result?.entities) {
          entities.push(...body.result.entities);
          
          // For each entity found, get its relationships
          for (const entity of body.result.entities) {
            const entityId = entity.entityId?.[0] || entity.entityId;
            if (entityId) {
              const relResult = await invokeLambda({
                operation: 'getEntityRelationships',
                entityId
              });
              
              if (relResult.body) {
                const relBody = JSON.parse(relResult.body);
                if (relBody.result) {
                  relationships.push({
                    entityId,
                    entityName: entity.name?.[0] || entity.name,
                    outgoing: relBody.result.outgoing || [],
                    incoming: relBody.result.incoming || []
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error retrieving subgraph for "${searchTerm}":`, error);
    }
  }
  
  return { entities, relationships };
}

// Step 4: Evaluate if we have enough information using LLM
async function evaluateCompleteness(
  userQuery: string,
  context: ReasoningContext,
  minConfidence: number = 0.8
): Promise<{
  confidence: number,
  needsMoreInfo: boolean,
  missingInfo: string[]
}> {
  // First do a basic check
  const hasEntities = context.allEntities.size > 0;
  const hasRelationships = context.allRelationships.size > 0;
  const iterations = context.steps.length;

  // If we have very little data, continue searching
  if (!hasEntities || context.allEntities.size < 3) {
    return {
      confidence: 0.2,
      needsMoreInfo: true,
      missingInfo: ['Need to find relevant entities']
    };
  }

  // Prepare context summary for LLM evaluation
  const entitySummary = Array.from(context.allEntities).slice(0, 20).join(', ');
  const relationshipCount = context.allRelationships.size;

  const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || '';

  const prompt = `Evaluate if we have sufficient information to answer this question comprehensively.

Question: ${userQuery}
Iterations completed: ${iterations}
Entities found: ${context.allEntities.size} (sample: ${entitySummary})
Relationships found: ${relationshipCount}

Based on the entities and relationships discovered, assess:
1. Can the question be answered with current information? (yes/no)
2. What critical information is still missing? (list key gaps)
3. Confidence level (0.0-1.0)

Return ONLY a JSON object with this structure:
{
  "canAnswer": true/false,
  "confidence": 0.0-1.0,
  "missingInfo": ["gap1", "gap2"]
}`;

  try {
    const response = await fetch(`${AZURE_ENDPOINT}/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-01-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You evaluate if a knowledge graph query has gathered sufficient information. Return only JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 200
      })
    });

    if (response.ok) {
      const data: any = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';

      try {
        const evaluation = JSON.parse(content);
        return {
          confidence: evaluation.confidence || 0.5,
          needsMoreInfo: !evaluation.canAnswer && iterations < 10,
          missingInfo: evaluation.missingInfo || []
        };
      } catch (parseError) {
        console.error('[Graph-R1] Failed to parse evaluation response:', content);
      }
    } else {
      const errorText = await response.text();
      console.error('[Graph-R1] LLM evaluation failed:', response.status);
      console.error('[Graph-R1] Error details:', errorText.substring(0, 200));
      console.error('[Graph-R1] URL:', `${AZURE_ENDPOINT}/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-01-01-preview`);
      console.error('[Graph-R1] API Key present:', !!AZURE_API_KEY);
    }
  } catch (error) {
    console.error('[Graph-R1] LLM evaluation error:', error);
  }

  // Fallback to simple heuristic if LLM fails
  let confidence = 0;
  if (hasEntities) confidence += 0.3;
  if (hasRelationships) confidence += 0.2;
  if (iterations > 2) confidence += 0.1;
  if (context.allEntities.size > 20) confidence += 0.2;
  if (context.allRelationships.size > 30) confidence += 0.2;

  return {
    confidence,
    needsMoreInfo: confidence < minConfidence && iterations < 10,
    missingInfo: []
  };
}

// Main iterative reasoning function
export async function iterativeGraphReasoning(
  userQuery: string,
  maxIterations: number = 3,
  confidenceThreshold: number = 0.8
): Promise<ReasoningContext> {
  console.log('[Graph-R1] === Starting Iterative Graph Reasoning ===');
  console.log(`[Graph-R1] Query: "${userQuery}"`);
  console.log(`[Graph-R1] Max iterations: ${maxIterations}, Confidence threshold: ${confidenceThreshold}`);

  const context: ReasoningContext = {
    originalQuery: userQuery,
    steps: [],
    allEntities: new Set(),
    allRelationships: new Set()
  };

  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n[Graph-R1] 🔄 Iteration ${i + 1}/${maxIterations}`);

    // Step 1: Think
    const thought = think(userQuery, context);
    console.log(`[Graph-R1] 💭 Thought: ${thought}`);
    
    // Step 2: Generate queries using LLM
    const queries = await generateGraphQueries(thought, userQuery, context, i + 1);
    console.log(`[Graph-R1] 🔍 Generated ${queries.length} queries: ${queries.join(', ')}`);

    if (queries.length === 0 && i === 0) {
      // If no queries generated, try with the full query
      queries.push(userQuery);
      console.log(`[Graph-R1] No specific entities found, using full query`);
    }

    // Step 3: Retrieve subgraph
    console.log(`[Graph-R1] 🌐 Retrieving subgraph from Neptune...`);
    const { entities, relationships } = await retrieveSubgraph(queries);
    console.log(`[Graph-R1] ✅ Retrieved ${entities.length} entities and ${relationships.length} relationship sets`);
    
    // Update context
    entities.forEach(e => {
      const entityId = e.entityId?.[0] || e.entityId;
      if (entityId) context.allEntities.add(entityId);
    });
    
    relationships.forEach(r => {
      const relKey = `${r.entityId}-${JSON.stringify(r.outgoing)}-${JSON.stringify(r.incoming)}`;
      context.allRelationships.add(relKey);
    });
    
    // Step 4: Evaluate completeness using LLM
    const evaluation = await evaluateCompleteness(userQuery, context, confidenceThreshold);
    console.log(`[Graph-R1] 📊 Confidence: ${(evaluation.confidence * 100).toFixed(0)}%`);
    if (evaluation.missingInfo.length > 0) {
      console.log(`[Graph-R1] ⚠️ Missing: ${evaluation.missingInfo.join(', ')}`);
    }

    // Record this step
    context.steps.push({
      iteration: i + 1,
      thought,
      queries,
      retrievedEntities: entities,
      retrievedRelationships: relationships,
      confidence: evaluation.confidence,
      needsMoreInfo: evaluation.needsMoreInfo
    });

    // Check if we should continue (with minimum 2 iterations)
    const minIterations = 2;  // Force at least 2 iterations
    if ((!evaluation.needsMoreInfo || queries.length === 0) && i >= minIterations - 1) {
      console.log(`[Graph-R1] ✅ Stopping: ${!evaluation.needsMoreInfo ? 'Sufficient confidence reached' : 'No more queries to explore'}`);
      break;
    } else if (i < minIterations - 1) {
      console.log(`[Graph-R1] ⏩ Continuing: Minimum iterations not reached (${i + 1}/${minIterations})`);
    } else {
      console.log(`[Graph-R1] ⏩ Continuing: Need more information (confidence below ${(confidenceThreshold * 100).toFixed(0)}%)`);
    }
  }

  console.log(`\n[Graph-R1] === Completed Iterative Reasoning ===`);
  console.log(`[Graph-R1] Total entities discovered: ${context.allEntities.size}`);
  console.log(`[Graph-R1] Total relationships: ${context.allRelationships.size}`);
  console.log(`[Graph-R1] Iterations completed: ${context.steps.length}`);

  return context;
}

// Format the reasoning context for inclusion in the prompt
export function formatReasoningContext(context: ReasoningContext): string {
  if (context.allEntities.size === 0) {
    return '';
  }
  
  let formatted = '\n🧠 GRAPH KNOWLEDGE CONTEXT (Iterative Reasoning):\n';
  formatted += `Query: "${context.originalQuery}"\n`;
  formatted += `Reasoning iterations: ${context.steps.length}\n\n`;
  
  context.steps.forEach(step => {
    formatted += `Iteration ${step.iteration}:\n`;
    formatted += `  • Searched for: ${step.queries.join(', ')}\n`;
    formatted += `  • Found ${step.retrievedEntities.length} entities\n`;
    formatted += `  • Found ${step.retrievedRelationships.length} relationship sets\n`;
    formatted += `  • Confidence: ${(step.confidence * 100).toFixed(0)}%\n`;
    
    if (step.retrievedEntities.length > 0) {
      formatted += '  • Key entities:\n';
      step.retrievedEntities.slice(0, 5).forEach(e => {
        const name = e.name?.[0] || e.name || 'Unknown';
        const type = e.entityType?.[0] || e.entityType || 'Unknown';
        formatted += `    - ${name} (${type})\n`;
      });
    }
    
    if (step.retrievedRelationships.length > 0) {
      formatted += '  • Key relationships:\n';
      step.retrievedRelationships.slice(0, 3).forEach(r => {
        if (r.outgoing?.length > 0) {
          formatted += `    - ${r.entityName} → ${r.outgoing.slice(0, 2).join(', ')}\n`;
        }
        if (r.incoming?.length > 0) {
          formatted += `    - ${r.incoming.slice(0, 2).join(', ')} → ${r.entityName}\n`;
        }
      });
    }
    formatted += '\n';
  });
  
  formatted += `Total unique entities discovered: ${context.allEntities.size}\n`;
  formatted += `Total unique relationships: ${context.allRelationships.size}\n`;
  formatted += '\n---\n';
  
  return formatted;
}