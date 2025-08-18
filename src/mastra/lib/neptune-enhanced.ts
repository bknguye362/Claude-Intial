import { createDocumentNode, createChunkNode, createChunkRelationships } from './neptune-lambda-client';

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const LLM_DEPLOYMENT = process.env.AZURE_OPENAI_LLM_DEPLOYMENT || 'gpt-4.1-test';

interface ChunkInfo {
  id: string;
  content: string;
  summary: string;
  index: number;
}

interface SemanticRelationship {
  fromChunk: string;
  toChunk: string;
  relationshipType: string;
  strength: number;
  reason: string;
}

// LLM-based relationship discovery
async function discoverSemanticRelationships(chunks: ChunkInfo[]): Promise<SemanticRelationship[]> {
  console.log('[Neptune Enhanced] Discovering semantic relationships between chunks using LLM...');
  
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Neptune Enhanced] No API key, using basic sequential relationships only');
    return [];
  }

  const relationships: SemanticRelationship[] = [];
  
  try {
    // Analyze chunks in batches to find relationships
    const batchSize = 5; // Analyze 5 chunks at a time for relationships
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, Math.min(i + batchSize, chunks.length));
      
      // Create a summary of all chunks for context
      const chunkSummaries = batch.map((c, idx) => 
        `Chunk ${i + idx}: ${c.summary || c.content.substring(0, 100)}`
      ).join('\n');
      
      const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_API_KEY
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `Analyze text chunks and identify semantic relationships between them.
              
Relationship types to identify:
- REFERENCES: One chunk refers to concepts from another
- CONTRADICTS: Chunks contain conflicting information  
- ELABORATES: One chunk provides more detail about another's topic
- DEPENDS_ON: Understanding one chunk requires context from another
- SIMILAR_TOPIC: Chunks discuss the same topic from different angles
- CAUSE_EFFECT: One chunk describes cause, another describes effect
- EXAMPLE_OF: One chunk is an example of concept in another
- SUMMARIZES: One chunk summarizes content from another

Return JSON array of relationships. Each relationship should have:
- fromIndex: source chunk index (from the batch)
- toIndex: target chunk index (from the batch)
- type: relationship type from above list
- strength: 0.1 to 1.0 (how strong the relationship is)
- reason: brief explanation (max 50 chars)

Only include meaningful relationships (strength > 0.3).`
            },
            {
              role: 'user',
              content: `Analyze these chunks for semantic relationships:\n\n${chunkSummaries}\n\nReturn JSON array only.`
            }
          ],
          max_tokens: 500,
          temperature: 0.3
        })
      });
      
      if (response.ok) {
        const data = await response.json() as any;
        const content = data.choices[0].message.content;
        
        try {
          // Parse the JSON response
          const llmRelationships = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || '[]');
          
          // Convert to our format
          for (const rel of llmRelationships) {
            if (rel.fromIndex !== undefined && rel.toIndex !== undefined) {
              const fromIdx = i + rel.fromIndex;
              const toIdx = i + rel.toIndex;
              
              if (fromIdx < chunks.length && toIdx < chunks.length && fromIdx !== toIdx) {
                relationships.push({
                  fromChunk: chunks[fromIdx].id,
                  toChunk: chunks[toIdx].id,
                  relationshipType: rel.type || 'RELATED',
                  strength: Math.min(1, Math.max(0.1, rel.strength || 0.5)),
                  reason: (rel.reason || '').substring(0, 50)
                });
              }
            }
          }
        } catch (e) {
          console.error('[Neptune Enhanced] Error parsing LLM relationships:', e);
        }
      }
      
      // Don't overwhelm the API
      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Also analyze cross-batch relationships for key chunks
    if (chunks.length > batchSize) {
      console.log('[Neptune Enhanced] Analyzing cross-batch relationships...');
      
      // Pick key chunks (first, last, and some middle ones)
      const keyIndices = [
        0, // First chunk
        Math.floor(chunks.length / 3), // 1/3 point
        Math.floor(chunks.length / 2), // Middle
        Math.floor(2 * chunks.length / 3), // 2/3 point  
        chunks.length - 1 // Last chunk
      ].filter((idx, i, arr) => arr.indexOf(idx) === i); // Remove duplicates
      
      const keyChunks = keyIndices.map(idx => ({
        idx,
        summary: chunks[idx].summary || chunks[idx].content.substring(0, 150)
      }));
      
      const crossBatchUrl = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
      
      const crossResponse = await fetch(crossBatchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_API_KEY
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: 'Identify long-range semantic relationships between key document sections. Focus on REFERENCES, ELABORATES, SUMMARIZES, and CAUSE_EFFECT relationships. Return JSON array with fromIdx, toIdx, type, strength, reason.'
            },
            {
              role: 'user',
              content: `Key chunks from document:\n${keyChunks.map(k => `[${k.idx}]: ${k.summary}`).join('\n')}\n\nFind relationships between these chunks (use the indices in brackets).`
            }
          ],
          max_tokens: 300,
          temperature: 0.3
        })
      });
      
      if (crossResponse.ok) {
        const crossData = await crossResponse.json() as any;
        try {
          const crossRels = JSON.parse(crossData.choices[0].message.content.match(/\[[\s\S]*\]/)?.[0] || '[]');
          for (const rel of crossRels) {
            if (rel.fromIdx !== undefined && rel.toIdx !== undefined) {
              relationships.push({
                fromChunk: chunks[rel.fromIdx].id,
                toChunk: chunks[rel.toIdx].id,
                relationshipType: rel.type || 'RELATED',
                strength: Math.min(1, Math.max(0.1, rel.strength || 0.4)),
                reason: (rel.reason || 'Cross-reference').substring(0, 50)
              });
            }
          }
        } catch (e) {
          console.error('[Neptune Enhanced] Error parsing cross-batch relationships:', e);
        }
      }
    }
    
    console.log(`[Neptune Enhanced] Discovered ${relationships.length} semantic relationships`);
    return relationships;
    
  } catch (error) {
    console.error('[Neptune Enhanced] Error discovering relationships:', error);
    return [];
  }
}

// Enhanced Neptune graph creation with deferred relationships
export async function createNeptuneGraphEnhanced(
  documentId: string,
  documentMetadata: Record<string, any>,
  chunks: Array<{
    id: string;
    content: string;
    summary?: string;
    metadata?: Record<string, any>;
  }>
): Promise<boolean> {
  console.log('[Neptune Enhanced] Creating enhanced Neptune graph...');
  
  try {
    // Step 1: Create document node
    console.log('[Neptune Enhanced] Step 1: Creating document node...');
    const docCreated = await createDocumentNode(documentId, documentMetadata);
    if (!docCreated) {
      console.error('[Neptune Enhanced] Failed to create document node');
      return false;
    }
    
    // Step 2: Create all chunk nodes (without relationships)
    console.log('[Neptune Enhanced] Step 2: Creating all chunk nodes...');
    const chunkInfos: ChunkInfo[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[Neptune Enhanced] Creating chunk ${i + 1}/${chunks.length}: ${chunk.id}`);
      
      const chunkCreated = await createChunkNode(
        chunk.id,
        documentId,
        i,
        chunk.content,
        chunk.summary,
        chunk.metadata
      );
      
      if (chunkCreated) {
        chunkInfos.push({
          id: chunk.id,
          content: chunk.content,
          summary: chunk.summary || '',
          index: i
        });
      }
    }
    
    console.log(`[Neptune Enhanced] Created ${chunkInfos.length} chunk nodes`);
    
    // Step 3: Wait for nodes to be fully committed
    console.log('[Neptune Enhanced] Step 3: Waiting for nodes to be committed...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 4: Create sequential relationships
    console.log('[Neptune Enhanced] Step 4: Creating sequential relationships...');
    const sequentialRelationships: Array<{from: string, to: string, type: string}> = [];
    
    for (let i = 0; i < chunkInfos.length - 1; i++) {
      sequentialRelationships.push({
        from: chunkInfos[i].id,
        to: chunkInfos[i + 1].id,
        type: 'FOLLOWS'
      });
    }
    
    // Step 5: Discover semantic relationships using LLM
    console.log('[Neptune Enhanced] Step 5: Discovering semantic relationships...');
    const semanticRelationships = await discoverSemanticRelationships(chunkInfos);
    
    // Step 6: Create all relationships
    console.log('[Neptune Enhanced] Step 6: Creating all relationships...');
    let successCount = 0;
    let failCount = 0;
    
    // Create sequential relationships
    for (const rel of sequentialRelationships) {
      const success = await createChunkRelationships(rel.from, [{
        id: rel.to,
        relationship: rel.type,
        strength: 1.0
      }]);
      
      if (success) successCount++;
      else failCount++;
    }
    
    // Create semantic relationships
    for (const rel of semanticRelationships) {
      const success = await createChunkRelationships(rel.fromChunk, [{
        id: rel.toChunk,
        relationship: rel.relationshipType,
        strength: rel.strength
      }]);
      
      if (success) {
        console.log(`[Neptune Enhanced] Created ${rel.relationshipType} relationship: ${rel.reason}`);
        successCount++;
      } else {
        failCount++;
      }
    }
    
    console.log(`[Neptune Enhanced] Relationships created: ${successCount} success, ${failCount} failed`);
    console.log('[Neptune Enhanced] Graph creation complete!');
    
    return true;
    
  } catch (error) {
    console.error('[Neptune Enhanced] Error creating graph:', error);
    return false;
  }
}

// Export for use in PDF processor
export { discoverSemanticRelationships };