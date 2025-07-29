import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mastra } from '../index.js';
import { createIndexWithNewman, uploadVectorsWithNewman } from '../lib/newman-executor.js';
import { processPDF } from '../lib/pdf-processor.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Agent Coordination] No API key for embeddings, using mock embeddings...');
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
    console.error('[Agent Coordination] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Check if input is a question
function isQuestion(input: string): boolean {
  const questionPatterns = [
    /\?/,
    /^what\s/i,
    /^how\s/i,
    /^why\s/i,
    /^when\s/i,
    /^where\s/i,
    /^who\s/i,
    /^which\s/i,
    /^explain\s/i,
    /^can\s/i,
    /^could\s/i,
    /^should\s/i,
    /^would\s/i,
    /^is\s/i,
    /^are\s/i,
    /^do\s/i,
    /^does\s/i,
    /^did\s/i,
  ];
  
  return questionPatterns.some(pattern => pattern.test(input));
}

export const agentCoordinationTool = createTool({
  id: 'coordinate-with-agent',
  description: 'Delegate a task to another specialized agent and get their response',
  inputSchema: z.object({
    agentId: z.enum(['researchAgent', 'fileAgent']).describe('The ID of the agent to delegate to'),
    task: z.string().describe('The task or question to delegate to the agent'),
    context: z.string().optional().describe('Additional context for the agent'),
  }),
  outputSchema: z.object({
    response: z.string(),
    agentId: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[Agent Coordination] ========= TOOL EXECUTED =========`);
    console.log(`[Agent Coordination] Task: "${context.task}"`);
    console.log(`[Agent Coordination] Target Agent: ${context.agentId}`);
    
    try {
      console.log(`[Agent Coordination] >>> ASSISTANT AGENT is delegating to ${context.agentId} with task: ${context.task}`);
      console.log(`[Agent Coordination] Full context object:`, JSON.stringify(context));
      
      // Get the specified agent
      const agent = mastra.getAgent(context.agentId);
      
      if (!agent) {
        console.error(`[Agent Coordination] Agent ${context.agentId} not found`);
        return {
          response: '',
          agentId: context.agentId,
          error: `Agent ${context.agentId} not found`,
        };
      }
      
      // Debug: Verify we got the right agent
      console.log(`[Agent Coordination] Retrieved agent name:`, agent.name);
      console.log(`[Agent Coordination] Agent instructions preview:`, agent.instructions?.substring(0, 100));
      
      // Auto-vectorize any question that passes through coordination
      console.log(`[Agent Coordination] Checking if task is a question: "${context.task}"`);
      if (isQuestion(context.task)) {
        console.log(`[Agent Coordination] AUTO-DETECTED QUESTION: "${context.task}"`);
        console.log(`[Agent Coordination] Auto-vectorizing question...`);
        
        try {
          // Generate embedding for the question
          console.log(`[Agent Coordination] Generating embedding...`);
          const embedding = await generateEmbedding(context.task);
          console.log(`[Agent Coordination] Generated embedding with length: ${embedding.length}`);
          
          const timestamp = Date.now();
          
          // Create vector
          const vectors = [{
            key: `question-auto-coord-${timestamp}`,
            embedding: embedding,
            metadata: {
              question: context.task,
              timestamp: new Date().toISOString(),
              source: 'agent-coordination-auto',
              targetAgentId: context.agentId,
              type: 'user-question',
              automatic: true
            }
          }];
          
          // Upload to queries index
          console.log(`[Agent Coordination] Uploading question vector to 'queries' index...`);
          console.log(`[Agent Coordination] Vector details:`, {
            key: vectors[0].key,
            embeddingLength: embedding.length,
            metadataKeys: Object.keys(vectors[0].metadata)
          });
          
          const uploadedCount = await uploadVectorsWithNewman('queries', vectors);
          console.log(`[Agent Coordination] Upload result: ${uploadedCount} vectors uploaded`);
          
          if (uploadedCount > 0) {
            console.log(`[Agent Coordination] Successfully auto-vectorized question`);
          } else {
            console.log(`[Agent Coordination] Failed to upload - uploadedCount is 0`);
          }
          
        } catch (error) {
          console.error(`[Agent Coordination] Error auto-vectorizing:`, error);
          console.error(`[Agent Coordination] Error stack:`, error instanceof Error ? error.stack : 'No stack');
          // Continue with delegation even if vectorization fails
        }
      } else {
        console.log(`[Agent Coordination] Not a question, skipping vectorization`);
      }

      // Prepare the message for the agent
      // For file agent, add a marker to help with identification
      let messageContent = context.context ? `${context.context}\n\n${context.task}` : context.task;
      
      if (context.agentId === 'fileAgent') {
        messageContent = `[FILE_AGENT_TASK] ${messageContent}`;
      }
      
      const messages = [
        {
          role: 'user' as const,
          content: messageContent,
        },
      ];

      console.log(`[Agent Coordination] Sending message to ${context.agentId}: "${context.task}"`);
      console.log(`[Agent Coordination] Full message content:`, messages[0].content);
      console.log(`[Agent Coordination] Has [Uploaded files:]:`, messages[0].content.includes('[Uploaded files:'));
      console.log(`[Agent Coordination] Agent has tools:`, agent.tools ? Object.keys(agent.tools) : 'none');
      
      // Get response from the agent or workflow
      let fullResponse = '';
      
      // Check if this is a file agent task with a PDF upload
      if (context.agentId === 'fileAgent') {
        console.log(`[Agent Coordination] Checking for PDF uploads in file agent task...`);
        
        // Check if there's a PDF file in the message
        const uploadedFileMatch = messageContent.match(/\[Uploaded files: ([^\]]+)\]/);
        const fileTaskMatch = messageContent.match(/\[FILE_AGENT_TASK\]\s*([^(]+)\s*\(([^)]+)\)/);
        
        let pdfPath: string | null = null;
        let fileName: string | null = null;
        
        if (fileTaskMatch) {
          pdfPath = fileTaskMatch[2];
          fileName = pdfPath.split('/').pop() || 'unknown';
        } else if (uploadedFileMatch) {
          const fileInfo = uploadedFileMatch[1];
          const pathMatch = fileInfo.match(/([^(]+)\s*\(([^)]+)\)/);
          if (pathMatch) {
            fileName = pathMatch[1].trim();
            pdfPath = pathMatch[2];
          }
        }
        
        // If we found a PDF, process it automatically
        if (pdfPath && pdfPath.toLowerCase().endsWith('.pdf')) {
          console.log(`[Agent Coordination] PDF detected: ${pdfPath}`);
          console.log(`[Agent Coordination] Processing PDF automatically...`);
          
          try {
            const result = await processPDF(pdfPath);
            if (result.success) {
              console.log(`[Agent Coordination] PDF processed successfully. Index: ${result.indexName}`);
              // Update the message to inform the agent that PDF was processed
              messages[0].content = `PDF file '${fileName}' has been automatically processed and indexed as: ${result.indexName}. ` + messages[0].content;
            } else {
              console.error(`[Agent Coordination] PDF processing failed:`, result.error);
            }
          } catch (error) {
            console.error(`[Agent Coordination] Error processing PDF:`, error);
          }
        }
      }
      
      // Get response from the agent
      const stream = await agent.stream(messages);
      
      // Collect the streamed response
      let chunkCount = 0;
      console.log(`[Agent Coordination] Starting to collect response from ${context.agentId}...`);
      
      for await (const chunk of stream.textStream) {
        fullResponse += chunk;
        chunkCount++;
        // Log first few chunks to see what the agent is saying
        if (chunkCount <= 3) {
          console.log(`[Agent Coordination] Chunk ${chunkCount}: ${chunk}`);
        }
        if (chunkCount % 10 === 0) {
          console.log(`[Agent Coordination] Received ${chunkCount} chunks so far...`);
        }
      }
        
      console.log(`[Agent Coordination] Completed! Received ${chunkCount} chunks from ${context.agentId}`);
      
      console.log(`[Agent Coordination] Full response length: ${fullResponse.length} characters`);
      console.log(`[Agent Coordination] Response preview: ${fullResponse.substring(0, 200)}...`);
      
      return {
        response: fullResponse,
        agentId: context.agentId,
      };
    } catch (error) {
      console.error(`[Agent Coordination] Error delegating to ${context.agentId}:`, error);
      
      // Provide more specific error messages for common issues
      let errorMessage = 'Unknown error';
      
      if (error instanceof Error) {
        errorMessage = error.message;
        
        // Add context-specific error handling
        if (error.message.includes('fetch')) {
          errorMessage = `Network error: Unable to connect to the ${context.agentId} service. Please check your internet connection.`;
        }
      }
      
      // Return an error message as the response instead of empty string
      // This ensures the assistant agent can still provide a helpful response
      return {
        response: errorMessage,
        agentId: context.agentId,
        error: errorMessage,
      };
    }
  },
});