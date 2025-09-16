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
  const currentKnowledge = context.steps.length > 0 
    ? `Based on ${context.allEntities.size} entities and ${context.allRelationships.size} relationships found so far`
    : 'Starting fresh analysis';
    
  return `Analyzing: "${query}". ${currentKnowledge}. Identifying what information is needed to answer this query completely.`;
}

// Step 2: Generate graph queries based on the thought
function generateGraphQueries(thought: string, query: string, existingEntities: Set<string>): string[] {
  const queries: string[] = [];
  
  // Extract potential entity names from the query
  const words = query.toLowerCase().split(/\s+/);
  const potentialEntities = words.filter(w => 
    w.length > 2 && 
    !['the', 'and', 'or', 'but', 'with', 'from', 'what', 'who', 'where', 'when', 'why', 'how'].includes(w)
  );
  
  // Generate queries for entities not yet explored
  potentialEntities.forEach(entity => {
    if (!existingEntities.has(entity)) {
      queries.push(entity);
    }
  });
  
  // Also look for capitalized words that might be proper nouns
  const properNouns = query.match(/[A-Z][a-z]+/g) || [];
  properNouns.forEach(noun => {
    if (!existingEntities.has(noun.toLowerCase())) {
      queries.push(noun);
    }
  });
  
  return queries;
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

// Step 4: Evaluate if we have enough information
function evaluateCompleteness(context: ReasoningContext, minConfidence: number = 0.8): { 
  confidence: number, 
  needsMoreInfo: boolean,
  missingInfo: string[]
} {
  const hasEntities = context.allEntities.size > 0;
  const hasRelationships = context.allRelationships.size > 0;
  const iterations = context.steps.length;
  
  // Calculate confidence based on what we've found
  let confidence = 0;
  if (hasEntities) confidence += 0.4;
  if (hasRelationships) confidence += 0.3;
  if (iterations > 1) confidence += 0.2;
  if (context.allEntities.size > 5) confidence += 0.1;
  
  const missingInfo: string[] = [];
  if (!hasEntities) missingInfo.push('No entities found');
  if (!hasRelationships) missingInfo.push('No relationships found');
  
  return {
    confidence,
    needsMoreInfo: confidence < minConfidence && iterations < 3,
    missingInfo
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
    
    // Step 2: Generate queries
    const queries = generateGraphQueries(thought, userQuery, context.allEntities);
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
    
    // Step 4: Evaluate completeness
    const evaluation = evaluateCompleteness(context, confidenceThreshold);
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

    // Check if we should continue
    if (!evaluation.needsMoreInfo || queries.length === 0) {
      console.log(`[Graph-R1] ✅ Stopping: ${!evaluation.needsMoreInfo ? 'Sufficient confidence reached' : 'No more queries to explore'}`);
      break;
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