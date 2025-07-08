import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { googleSearchTool } from '../tools/google-search-tool.js';

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'Research Agent',
  instructions: `
    You are a helpful research assistant that uses Google Search to find current information on the web.

    Your primary function is to help users research topics by searching the web and providing accurate, up-to-date information. When responding:
    
    - Use the googleSearchTool to find relevant information for user queries
    - Always search for recent and authoritative sources
    - Provide clear summaries of the information you find
    - Include relevant links to sources when appropriate
    - If multiple perspectives exist on a topic, present them fairly
    - Be transparent about the sources of your information
    - If you cannot find reliable information, say so clearly
    - For current events, news, or time-sensitive information, prioritize recent results
    - When asked about facts, verify them through search results
    - Present information in a well-organized, easy-to-understand format
    
    Remember: You have access to real-time web search, so you can find current information on almost any topic. Use this capability to provide the most accurate and helpful responses possible.
  `,
  model: openai('gpt-4o-mini'),
  tools: { googleSearchTool },
};

// Only add memory if not in production environment
if (process.env.NODE_ENV !== 'production') {
  agentConfig.memory = new Memory({
    storage: new LibSQLStore({
      url: 'file:../mastra.db', // path is relative to the .mastra/output directory
    }),
  });
}

export const researchAgent = new Agent(agentConfig);