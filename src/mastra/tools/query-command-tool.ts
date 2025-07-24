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
    console.log('[Query Command Tool] No API key for embeddings, using mock embeddings...');
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
    console.error('[Query Command Tool] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

export const queryCommandTool = createTool({
  id: 'query-command',
  description: 'Process Query: command to vectorize and store user questions. Use when user message starts with "Query:"',
  inputSchema: z.object({
    fullMessage: z.string().describe('The full user message starting with Query:'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    question: z.string().optional(),
    vectorKey: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    try {
      console.log(`[Query Command Tool] Processing message: "${context.fullMessage}"`);
      
      // Extract question from Query: "question" format
      const match = context.fullMessage.match(/Query:\s*"([^"]+)"/i);
      if (!match) {
        return {
          success: false,
          message: 'Invalid format. Please use: Query: "your question here"',
        };
      }
      
      const question = match[1];
      console.log(`[Query Command Tool] Extracted question: "${question}"`);
      
      // Ensure queries index exists
      console.log(`[Query Command Tool] Ensuring 'queries' index exists...`);
      try {
        await createIndexWithNewman('queries', 1536);
        console.log(`[Query Command Tool] 'queries' index ready`);
      } catch (indexError) {
        console.log(`[Query Command Tool] Index may already exist, continuing...`);
      }
      
      // Generate embedding for the question
      console.log(`[Query Command Tool] Generating embedding for question...`);
      const embedding = await generateEmbedding(question);
      console.log(`[Query Command Tool] Generated embedding with ${embedding.length} dimensions`);
      
      // Create vector with metadata
      const timestamp = new Date().toISOString();
      const vectorKey = `query-cmd-${Date.now()}`;
      const vectors = [{
        key: vectorKey,
        embedding: embedding,
        metadata: {
          question: question,
          timestamp: timestamp,
          source: 'query-command',
          type: 'user-question',
          command: 'Query:',
        }
      }];
      
      // Upload to queries index
      console.log(`[Query Command Tool] Uploading vector to 'queries' index...`);
      const uploadedCount = await uploadVectorsWithNewman('queries', vectors);
      
      if (uploadedCount > 0) {
        console.log(`[Query Command Tool] Successfully uploaded vector ${vectorKey}`);
        return {
          success: true,
          question: question,
          vectorKey: vectorKey,
          message: `Successfully vectorized the question "${question}" and stored it in the 'queries' index with key ${vectorKey}.`,
        };
      } else {
        return {
          success: false,
          question: question,
          message: 'Failed to upload vector to queries index',
        };
      }
      
    } catch (error) {
      console.error('[Query Command Tool] Error:', error);
      return {
        success: false,
        message: `Error processing Query command: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});