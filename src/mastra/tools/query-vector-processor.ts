import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createIndexWithNewman, uploadVectorsWithNewman } from '../lib/newman-executor.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings using Azure OpenAI
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Query Vector Processor] No API key for embeddings, using mock embeddings...');
    // Return mock embeddings for testing
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

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

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[Query Vector Processor] Error generating embedding:', error);
    // Return mock embeddings as fallback
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

export const queryVectorProcessorTool = createTool({
  id: 'query-vector-processor',
  description: 'Convert user query to vector, store it in S3 bucket with its own index, and prepare for similarity search',
  inputSchema: z.object({
    query: z.string().describe('The user query to process'),
    userId: z.string().optional().describe('Optional user ID for tracking queries'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    indexName: z.string().optional().describe('The name of the created index'),
    vectorKey: z.string().optional().describe('The key of the stored vector'),
    embedding: z.array(z.number()).optional().describe('The generated embedding vector'),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[Query Vector Processor] Processing query: "${context.query}"`);
      
      // Generate embedding for the query
      const embedding = await generateEmbedding(context.query);
      console.log(`[Query Vector Processor] Generated embedding with ${embedding.length} dimensions`);
      
      // Create a unique index name for this query
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const userId = context.userId || 'anonymous';
      const queryPreview = context.query
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .slice(0, 30);
      
      const indexName = `query-${userId}-${queryPreview}-${timestamp}`;
      console.log(`[Query Vector Processor] Creating index: ${indexName}`);
      
      // Create the index using Newman
      const indexCreated = await createIndexWithNewman(indexName, embedding.length);
      
      if (!indexCreated) {
        throw new Error(`Failed to create index '${indexName}'`);
      }
      
      // Prepare the vector with metadata
      const vectorKey = `query-${timestamp}`;
      const vectors = [{
        key: vectorKey,
        embedding: embedding,
        metadata: {
          query: context.query,
          userId: userId,
          timestamp: new Date().toISOString(),
          type: 'user-query',
          length: context.query.length,
        }
      }];
      
      // Upload the vector to the index
      console.log(`[Query Vector Processor] Uploading query vector to index...`);
      const uploadedCount = await uploadVectorsWithNewman(indexName, vectors);
      
      if (uploadedCount === 0) {
        throw new Error('Failed to upload query vector');
      }
      
      console.log(`[Query Vector Processor] Successfully stored query vector in index '${indexName}'`);
      
      return {
        success: true,
        indexName: indexName,
        vectorKey: vectorKey,
        embedding: embedding,
        message: `Query vector successfully stored in index '${indexName}' with key '${vectorKey}'`,
      };
      
    } catch (error) {
      console.error('[Query Vector Processor] Error:', error);
      return {
        success: false,
        message: `Failed to process query: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});