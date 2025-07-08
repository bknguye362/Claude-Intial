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
      // Get the specified agent
      const agent = mastra.getAgent(context.agentId);
      
      if (!agent) {
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

      // Get response from the agent
      const stream = await agent.stream(messages);
      
      // Collect the streamed response
      let fullResponse = '';
      for await (const chunk of stream.textStream) {
        fullResponse += chunk;
      }

      return {
        response: fullResponse,
        agentId: context.agentId,
      };
    } catch (error) {
      return {
        response: '',
        agentId: context.agentId,
        error: `Failed to coordinate with agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});