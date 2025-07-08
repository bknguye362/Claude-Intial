import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mastra } from '../index.js';

export const agentCoordinationTool = createTool({
  id: 'coordinate-with-agent',
  description: 'Delegate a task to another specialized agent and get their response',
  inputSchema: z.object({
    agentId: z.enum(['weatherAgent', 'researchAgent']).describe('The ID of the agent to delegate to'),
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
      console.log(`[Agent Coordination] Delegating to ${context.agentId} with task: ${context.task}`);
      
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

      // Prepare the message for the agent
      const messages = [
        {
          role: 'user' as const,
          content: context.context ? `${context.context}\n\n${context.task}` : context.task,
        },
      ];

      console.log(`[Agent Coordination] Sending message to ${context.agentId}`);
      
      // Get response from the agent
      const stream = await agent.stream(messages);
      
      // Collect the streamed response
      let fullResponse = '';
      for await (const chunk of stream.textStream) {
        fullResponse += chunk;
      }

      console.log(`[Agent Coordination] Received response from ${context.agentId}: ${fullResponse.substring(0, 100)}...`);
      
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
        if (context.agentId === 'weatherAgent' && error.message.includes('Location')) {
          errorMessage = `Weather service error: ${error.message}. Please try a different location or check the spelling.`;
        } else if (error.message.includes('fetch')) {
          errorMessage = `Network error: Unable to connect to the ${context.agentId} service. Please check your internet connection.`;
        }
      }
      
      return {
        response: '',
        agentId: context.agentId,
        error: `Failed to coordinate with agent: ${errorMessage}`,
      };
    }
  },
});