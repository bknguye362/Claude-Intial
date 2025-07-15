import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mastra } from '../index.js';

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

      // Prepare the message for the agent
      const messages = [
        {
          role: 'user' as const,
          content: context.context ? `${context.context}\n\n${context.task}` : context.task,
        },
      ];

      console.log(`[Agent Coordination] Sending message to ${context.agentId}: "${context.task}"`);
      console.log(`[Agent Coordination] Full message content:`, messages[0].content);
      console.log(`[Agent Coordination] Has [Uploaded files:]:`, messages[0].content.includes('[Uploaded files:'));
      console.log(`[Agent Coordination] Agent has tools:`, agent.tools ? Object.keys(agent.tools) : 'none');
      
      // Get response from the agent
      // Pass options to help identify the agent
      const streamOptions = {
        toolChoice: 'auto',
        // Add metadata to help with agent identification
        metadata: {
          targetAgent: context.agentId,
          hasFile: messages[0].content.includes('[Uploaded files:') || messages[0].content.includes('.pdf')
        }
      };
      
      console.log(`[Agent Coordination] Stream options:`, streamOptions);
      const stream = await agent.stream(messages, streamOptions);
      
      // Collect the streamed response
      let fullResponse = '';
      let chunkCount = 0;
      console.log(`[Agent Coordination] Starting to collect response from ${context.agentId}...`);
      
      for await (const chunk of stream.textStream) {
        fullResponse += chunk;
        chunkCount++;
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